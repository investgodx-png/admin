/* ═══════════════════════════════════════════════════════════
   GODX ADMIN — control panel logic 7.0 (daily-interest edition)
   Admin access: users/{uid}.role === 'admin' (see README)

   v7.0 highlights
   ───────────────
   ① ATOMIC, IDEMPOTENT MONEY OPS — approve/reject requests, plan
     payouts, cancel-refunds and balance adjustments now run inside
     Firestore transactions that RE-READ the source doc and verify
     its status before writing. Double-clicks, double tabs and
     retries can no longer double-credit a wallet or release funds
     twice. Every failure surfaces a real error toast (previously
     several admin writes silently failed on permission-denied).
   ② NEW "Daily Interest" page — scans every active investment,
     credits all elapsed-but-unpaid daily periods (anchored to the
     exact activation timestamp, never midnight), with per-period
     ledger entries and duplicate-proof locking. One tap reconciles
     everything — this is the reconciliation pass that keeps
     interest flowing even if users never open the app.
   ③ Plan Payouts now release PRINCIPAL ONLY at maturity (daily
     interest has already been credited) — with a legacy mode that
     still pays principal+interest for pre-v7 investments that
     never got daily credits. Payouts are transaction-guarded.
   ④ Dashboard counts interest correctly (interest + cashback),
     transactions carry userName everywhere, live badges unchanged.
   ═══════════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const inr2 = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fdate = ts => ts && ts.toDate ? ts.toDate().toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const ftimeA = ts => ts && ts.toDate ? ts.toDate().toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) : '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paise = n => Math.round(Number(n || 0) * 100);
const fromPaise = p => p / 100;
const DAY_MS = 86400000;

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

function openModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  $('#modal-root').appendChild(back);
  back.onclick = e => { if (e.target === back) closeModal(); };
  return back.querySelector('.modal');
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ══════════ AUTH ══════════ */
function setLoginStatus(msg) {
  const el = $('#login-status');
  if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
}

/* human-friendly Firebase auth errors (raw err.message is cryptic) */
function authErr(err) {
  const map = {
    'auth/user-not-found': 'No account found with this email',
    'auth/wrong-password': 'Incorrect password',
    'auth/invalid-credential': 'Incorrect email or password',
    'auth/invalid-email': 'Enter a valid email address',
    'auth/user-disabled': 'This account has been disabled',
    'auth/too-many-requests': 'Too many attempts — wait a minute and retry',
    'auth/network-request-failed': 'Network error — check your connection',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase Console → Authentication'
  };
  return map[err && err.code] || (err && err.message) || 'Sign-in failed';
}

$('#admin-login').onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Signing in…';
  setLoginStatus('');
  try {
    await auth.signInWithEmailAndPassword($('#ad-email').value.trim(), $('#ad-pass').value);
    // onAuthStateChanged takes over from here (verifies the admin role)
  } catch (err) {
    toast(authErr(err), 'err');
  }
  btn.disabled = false; btn.textContent = 'Sign In';
};

let badgeWatcherOn = false;
auth.onAuthStateChanged(async user => {
  if (!user) {
    $('#panel').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    setLoginStatus('');
    return;
  }
  setLoginStatus('Verifying admin access…');
  let snap;
  try {
    snap = await db.collection('users').doc(user.uid).get();
  } catch (err) {
    console.error('Admin profile check failed:', err);
    await auth.signOut();
    setLoginStatus('');
    return toast(err && err.code === 'permission-denied'
      ? 'Database access denied — publish firestore.rules (Firestore → Rules → Publish). Test-mode rules expire after 30 days.'
      : 'Could not verify admin access — check connection & retry', 'err');
  }
  if (!snap.exists) {
    await auth.signOut();
    setLoginStatus('');
    return toast('No profile found for this account — sign up in the user app first, then set role: "admin" on its users doc', 'err');
  }
  if (snap.data().role !== 'admin') {
    await auth.signOut();
    setLoginStatus('');
    return toast('This account is not an admin — in Firestore, open users/' + user.uid.slice(0, 6) + '… and set role = "admin"', 'err');
  }
  $('#admin-chip').textContent = snap.data().name || 'Admin';
  $('#login-view').classList.add('hidden');
  $('#panel').classList.remove('hidden');
  renderDashboard();
  if (!badgeWatcherOn) { badgeWatcherOn = true; watchPendingBadge(); }
});

$('#ad-logout').onclick = () => auth.signOut();

/* ══════════ NAV ══════════ */
$$('.sb-item[data-p]').forEach(b => b.onclick = () => goPage(b.dataset.p));
function goPage(p) {
  if (typeof detachChatListeners === 'function') detachChatListeners();
  $$('.sb-item[data-p]').forEach(x => x.classList.toggle('active', x.dataset.p === p));
  $$('.page').forEach(pg => pg.classList.add('hidden'));
  $('#page-' + p).classList.remove('hidden');
  const titles = { dashboard: 'Dashboard', requests: 'Requests', payouts: 'Plan Payouts',
                   interest: 'Daily Interest', history: 'All Transactions', payments: 'Payment Methods',
                   users: 'Users', plans: 'Plans', announce: 'Announcements',
                   chats: 'Support Chats', content: 'App Content',
                   referral: 'Refer & Earn Settings', share: 'Share Settings',
                   limits: 'Wallet Limits' };
  $('#page-title').textContent = titles[p] || p;
  ({ dashboard: renderDashboard, requests: renderRequests, payouts: renderPayouts, interest: renderInterest,
     history: renderHistory, payments: renderPayments, users: renderUsers,
     plans: renderPlans, announce: renderAnnounce, chats: renderChats, content: renderContent,
     referral: renderReferralSettings, share: renderShareSettings,
     limits: renderWalletLimits })[p]();
}

function watchPendingBadge() {
  db.collection('transactions').where('status', '==', 'pending').onSnapshot(s => {
    const b = $('#badge-req');
    b.textContent = s.size;
    b.classList.toggle('show', s.size > 0);
  });
  // live badge: plans that have matured and are ready to pay out
  db.collection('investments').where('status', '==', 'active').onSnapshot(s => {
    const due = s.docs.filter(d => isDue(d.data())).length;
    const b = $('#badge-due');
    b.textContent = due;
    b.classList.toggle('show', due > 0);
  });
  // live badge: support chats with unread user messages
  db.collection('supportChats').where('adminUnread', '>', 0).onSnapshot(s => {
    let n = 0; s.forEach(d => n += d.data().adminUnread || 0);
    const b = $('#badge-chat');
    if (b) { b.textContent = n; b.classList.toggle('show', n > 0); }
  });
}

/* ── Investment timing helpers (shared math with the user engine) ── */
function invStartMs(i) {
  return i.createdAt && i.createdAt.toMillis ? i.createdAt.toMillis()
       : i.createdAt && i.createdAt.seconds ? i.createdAt.seconds * 1000
       : Date.now();
}
function dayPaise(i, day) {
  const amt = paise(i.amount);
  const totalCb = paise(i.cashbackAmount);
  const days = Math.max(1, i.durationDays || 1);
  const base = Math.floor(amt * (i.cashbackPct || 0) / 100 / days);
  if (totalCb > 0) return day === days ? Math.max(0, totalCb - base * (days - 1)) : base;
  return base;
}
function periodsElapsed(i) {
  const days = Math.max(1, i.durationDays || 1);
  return Math.max(0, Math.min(days, Math.floor((Date.now() - invStartMs(i)) / DAY_MS)));
}
function isDue(i) { // fully matured
  return Date.now() >= invStartMs(i) + Math.max(1, i.durationDays || 1) * DAY_MS;
}
function interestDone(i) { return (i.interestPaid || 0) >= Math.max(1, i.durationDays || 1); }
function maturityDate(i) {
  return new Date(invStartMs(i) + Math.max(1, i.durationDays || 1) * DAY_MS);
}

/* ══════════ DAILY-INTEREST RECONCILIATION (admin side) ══════════
   Credits every elapsed-but-unpaid daily period of ONE investment,
   inside a Firestore transaction guarded by locks/int_<invId> so the
   user's own app can never race it. Returns paise credited (0 = none). */
async function reconcileInvestmentAdmin(invId) {
  const invRef = db.collection('investments').doc(invId);
  const lockRef = db.collection('locks').doc('int_' + invId);
  const credited = await db.runTransaction(async tx => {
    const lock = await tx.get(lockRef);
    if (lock.exists) {
      const t = lock.data().t;
      const lockMs = t && t.toMillis ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0);
      if (Date.now() - lockMs < 45000) throw 'locked';
    }
    const snap = await tx.get(invRef);
    if (!snap.exists) throw 'gone';
    const i = snap.data();
    if (i.status !== 'active') throw 'inactive';

    const days = Math.max(1, i.durationDays || 1);
    const paid = i.interestPaid || 0;
    const due = periodsElapsed(i);
    if (due <= paid) return 0;

    let sum = 0;
    for (let d = paid + 1; d <= due; d++) sum += dayPaise(i, d);

    tx.set(lockRef, { t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.update(invRef, {
      interestPaid: due,
      accruedInterest: Math.round(((i.accruedInterest || 0) + fromPaise(sum)) * 100) / 100,
      lastInterestAt: firebase.firestore.FieldValue.serverTimestamp(),
      dailyAmount: fromPaise(dayPaise(i, 1)),
      dailyRate: (i.cashbackPct || 0) / days
    });
    if (sum <= 0) return 0;

    const rupees = fromPaise(sum);
    const uRef = db.collection('users').doc(i.uid);
    const uSnap = await tx.get(uRef);
    const uname = uSnap.exists ? (uSnap.data().name || '') : '';
    tx.update(uRef, {
      balance: firebase.firestore.FieldValue.increment(rupees),
      totalCashback: firebase.firestore.FieldValue.increment(rupees)
    });
    tx.set(db.collection('transactions').doc(), {
      uid: i.uid, type: 'interest', amount: rupees, status: 'completed', invId,
      days: { from: paid + 1, to: due },
      note: (due - paid) === 1
        ? `Daily interest · ${i.planName} (day ${due}/${days})`
        : `Daily interest · ${i.planName} (days ${paid + 1}–${due}/${days})`,
      userName: uname,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return sum;
  });
  return credited;
}

/* ══════════ DAILY INTEREST PAGE ══════════ */
async function renderInterest() {
  const el = $('#page-interest');
  el.innerHTML = '<div class="spinner"></div>';
  let docs = [];
  try {
    const snap = await db.collection('investments').where('status', '==', 'active').get();
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => invStartMs(a) - invStartMs(b));
  } catch (e) {
    el.innerHTML = '<div class="tbl-card"><div class="empty">Could not load investments.</div></div>';
    return;
  }
  const uids = [...new Set(docs.map(x => x.uid))];
  const names = {};
  await Promise.all(uids.map(async u => { const s = await db.collection('users').doc(u).get(); names[u] = s.exists ? s.data().name : u.slice(0, 8); }));

  const dueToday = docs.filter(x => periodsElapsed(x) > (x.interestPaid || 0));
  const totalDuePaise = dueToday.reduce((s, x) => {
    let sum = 0; for (let d = (x.interestPaid || 0) + 1; d <= periodsElapsed(x); d++) sum += dayPaise(x, d);
    return s + sum;
  }, 0);

  const row = x => {
    const days = Math.max(1, x.durationDays || 1);
    const paid = x.interestPaid || 0, due = periodsElapsed(x);
    const pendingPaise = (() => { let s = 0; for (let d = paid + 1; d <= due; d++) s += dayPaise(x, d); return s; })();
    const nextAt = interestDone(x) ? null : new Date(invStartMs(x) + (paid + 1) * DAY_MS);
    return `<tr>
      <td><b>${esc(x.planName)}</b><br><span class="mini">activated ${fdate(x.createdAt)}</span></td>
      <td>${esc(names[x.uid] || '—')}</td>
      <td><b>${inr(x.amount)}</b><br><span class="mini" style="color:var(--green)">${x.cashbackPct}% / ${days}d</span></td>
      <td><b>${paid}/${days}</b> days<br><span class="mini">credited ${inr2(x.accruedInterest || 0)} of ${inr2(x.cashbackAmount)}</span></td>
      <td>${pendingPaise > 0 ? `<b style="color:var(--amber)">+${inr2(fromPaise(pendingPaise))} due</b>` : '<span class="chip chip-green">up to date</span>'}<br>
        <span class="mini">${interestDone(x) ? 'interest complete' : 'next: ' + nextAt.toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span></td>
      <td><div class="tbl-actions">
        ${pendingPaise > 0 ? `<button class="btn btn-green btn-sm" data-rel="${x.id}">Release ${inr2(fromPaise(pendingPaise))}</button>` : ''}
      </div></td></tr>`;
  };

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)"><div class="tbl-head">
      <h3>⚡ Daily Interest Engine</h3>
      <button class="btn btn-primary btn-sm" id="int-run" ${dueToday.length ? '' : 'disabled'}>Release All Due (${dueToday.length}) — ${inr2(fromPaise(totalDuePaise))}</button></div>
      <div style="padding:12px 18px" class="muted">
        Interest accrues every 24h from each plan's <b>exact activation time</b> (never midnight).
        Users' apps self-credit when online; this page is the reconciliation pass that catches up
        everyone else. Every period is tracked (<b>interestPaid</b>) and lock-guarded — a period can
        <b>never be paid twice</b>, no matter how often this runs. Accrual stops automatically at maturity;
        release the principal from <b>Plan Payouts</b>.</div></div>

    <div class="tbl-card"><div class="tbl-head"><h3>Active Investments (${docs.length})</h3></div>
      ${docs.length ? `<div class="tbl-scroll"><table><tr><th>Plan</th><th>User</th><th>Saved</th><th>Interest Progress</th><th>Status</th><th>Actions</th></tr>
      ${docs.map(row).join('')}</table></div>` : '<div class="empty">No active investments right now.</div>'}</div>`;

  let running = false;
  const runOne = async id => {
    try {
      const got = await reconcileInvestmentAdmin(id);
      return got > 0 ? got : 0;
    } catch (e) {
      if (e === 'locked') toast('That plan is being credited by the user\'s app right now — skipped (no double pay)', '');
      else if (e !== 'inactive' && e !== 'gone') toast('Release failed — ' + (e && e.message ? e.message : 'try again'), 'err');
      return -1;
    }
  };
  $$('#page-interest button[data-rel]').forEach(b => b.onclick = async () => {
    if (running) return;
    running = true; b.disabled = true;
    await runOne(b.dataset.rel);
    toast('Interest released ✓', 'ok');
    running = false; renderInterest();
  });
  const runAll = $('#int-run');
  if (runAll) runAll.onclick = async () => {
    if (running || !dueToday.length) return;
    running = true; runAll.disabled = true; runAll.textContent = 'Releasing…';
    let total = 0;
    for (const x of dueToday) { const got = await runOne(x.id); if (got > 0) total += got; }
    toast(`Daily interest released: ${inr2(fromPaise(total))} across ${dueToday.length} plan(s) ✓`, 'ok');
    running = false; renderInterest();
  };
}

/* ══════════ DASHBOARD ══════════ */
async function renderDashboard() {
  const el = $('#page-dashboard');
  el.innerHTML = '<div class="spinner"></div>';
  const [users, tx, inv] = await Promise.all([
    db.collection('users').get(),
    db.collection('transactions').get(),
    db.collection('investments').get()
  ]);
  let deposits = 0, withdrawn = 0, pending = 0, interestPaidOut = 0, balance = 0;
  tx.forEach(d => { const t = d.data();
    if (t.type === 'deposit' && t.status === 'completed') deposits += t.amount || 0;
    if (t.type === 'withdraw' && t.status === 'completed') withdrawn += t.amount || 0;
    if (t.type === 'cashback' || t.type === 'interest') interestPaidOut += t.amount || 0;
    if (t.status === 'pending') pending++;
  });
  let activePlans = 0, locked = 0, accruedLiability = 0;
  inv.forEach(d => { const i = d.data();
    if (i.status === 'active') { activePlans++; locked += i.amount || 0;
      accruedLiability += Math.max(0, (i.cashbackAmount || 0) - (i.accruedInterest || 0)); } });
  users.forEach(d => balance += d.data().balance || 0);

  el.innerHTML = `
    <div class="stat-cards">
      <div class="sc sc-hero"><small>Total Users</small><b>${users.size}</b>
        <div class="sc-sub">Registered savers</div></div>
      <div class="sc"><small>Deposits (verified)</small><b>${inr(deposits)}</b>
        <div class="sc-sub">All time</div></div>
      <div class="sc"><small>Wallet Float</small><b>${inr(balance)}</b>
        <div class="sc-sub">Sum of user balances</div></div>
      <div class="sc"><small>Active Plans</small><b>${activePlans}</b>
        <div class="sc-sub">${inr(locked)} currently saved in plans</div></div>
      <div class="sc"><small>Withdrawn</small><b>${inr(withdrawn)}</b>
        <div class="sc-sub">Paid out to users</div></div>
      <div class="sc"><small>Interest Given</small><b>${inr2(interestPaidOut)}</b>
        <div class="sc-sub">Daily credits + rewards</div></div>
      <div class="sc"><small>Interest Liability</small><b>${inr2(accruedLiability)}</b>
        <div class="sc-sub">Still owed on active plans</div></div>
      <div class="sc"><small>Pending Requests</small><b style="color:${pending ? 'var(--amber)' : 'inherit'}">${pending}</b>
        <div class="sc-sub">Deposits & withdrawals awaiting review</div></div>
    </div>
    <div class="tbl-card">
      <div class="tbl-head"><h3>Quick Actions</h3></div>
      <div style="padding:18px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" id="qa-seed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Seed Demo Plans</button>
        <button class="btn btn-soft" id="qa-pay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg> Add Payment Method</button>
        <button class="btn btn-soft" id="qa-ann"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg> New Announcement</button>
        <button class="btn btn-green" id="qa-req"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg> Review Requests ${pending ? `(${pending})` : ''}</button>
        <button class="btn btn-soft" id="qa-pay2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg> Plan Payouts</button>
        <button class="btn btn-soft" id="qa-int"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg> Daily Interest</button>
      </div>
    </div>
    <div class="tbl-card">
      <div class="tbl-head"><h3>Latest Activity</h3></div>
      <div id="dash-recent"><div class="spinner"></div></div>
    </div>`;

  $('#qa-seed').onclick = seedPlans;
  $('#qa-pay').onclick = () => { goPage('payments'); setTimeout(() => paymentEditor(null), 250); };
  $('#qa-ann').onclick = () => goPage('announce');
  $('#qa-req').onclick = () => goPage('requests');
  $('#qa-pay2').onclick = () => goPage('payouts');
  $('#qa-int').onclick = () => goPage('interest');

  const recent = await db.collection('transactions').orderBy('createdAt', 'desc').limit(8).get();
  $('#dash-recent').innerHTML = recent.empty ? '<div class="empty">No activity yet</div>' : `
    <div class="tbl-scroll"><table><tr><th>Type</th><th>User</th><th>Amount</th><th>Status</th><th>When</th></tr>
    ${recent.docs.map(d => { const t = d.data(); return `
      <tr><td>${esc(t.type)}</td><td>${esc(t.userName || (t.uid || '').slice(0, 8) || '—')}</td>
      <td>${inr2(t.amount)}</td><td><span class="chip ${t.status === 'pending' ? 'chip-amber' : t.status === 'completed' ? 'chip-green' : 'chip-red'}">${t.status}</span></td>
      <td>${fdate(t.createdAt)}</td></tr>`; }).join('')}</table></div>`;
}

/* ══════════ REQUESTS (approve deposits / withdrawals) ══════════ */
async function renderRequests() {
  const el = $('#page-requests');
  el.innerHTML = '<div class="spinner"></div>';
  const snap = await db.collection('transactions').where('status', '==', 'pending').get();
  const docs = snap.docs.sort((a, b) => (a.data().createdAt?.seconds || 0) - (b.data().createdAt?.seconds || 0));
  if (!docs.length) { el.innerHTML = '<div class="tbl-card"><div class="empty">All caught up — no pending requests 🎉</div></div>'; return; }

  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>Pending Requests (${docs.length})</h3></div>
    <div class="tbl-scroll"><table><tr><th>Type</th><th>User</th><th>Amount</th><th>Details</th><th>Requested</th><th>Actions</th></tr>
    ${docs.map(d => { const t = d.data(); return `
      <tr><td><span class="chip ${t.type === 'deposit' ? 'chip-blue' : 'chip-amber'}">${t.type}</span></td>
      <td data-u="${t.uid}">…</td><td><b>${inr(t.amount)}</b></td>
      <td>${t.type === 'deposit' && t.utr
          ? `UTR: <b>${esc(t.utr)}</b>${t.proof ? `<br><button class="proof-btn" data-proof="${d.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> View payment screenshot</button>` : '<br><span class="mini">no screenshot</span>'}`
          : `<span class="mini">${esc(t.note || '')}</span>${t.withdrawTo ? `<span class="mini">${t.withdrawTo.method === 'bank' ? `Bank: ${esc(t.withdrawTo.bankName || '')} A/C ${esc(t.withdrawTo.accountNumber || '')} · IFSC ${esc(t.withdrawTo.ifsc || '')}` : 'UPI: ' + esc(t.withdrawTo.upiId || '')}</span>` : ''}`}</td>
      <td>${fdate(t.createdAt)}</td>
      <td><div class="tbl-actions">
        <button class="btn btn-green btn-sm" data-a="ok" data-id="${d.id}">Approve</button>
        <button class="btn btn-red btn-sm" data-a="no" data-id="${d.id}">Reject</button>
      </div></td></tr>`; }).join('')}</table></div></div>`;

  // resolve user names
  const uids = [...new Set(docs.map(d => d.data().uid))];
  const names = {};
  await Promise.all(uids.map(async u => { const s = await db.collection('users').doc(u).get(); names[u] = s.exists ? s.data().name : u.slice(0, 8); }));
  $$('#page-requests td[data-u]').forEach(td => td.textContent = names[td.dataset.u] || '—');

  $$('#page-requests button[data-a]').forEach(b => b.onclick = () => decideRequest(b.dataset.id, b.dataset.a === 'ok'));
  $$('#page-requests button[data-proof]').forEach(b => b.onclick = async () => {
    const d = await db.collection('transactions').doc(b.dataset.proof).get();
    if (!d.exists || !d.data().proof) return toast('Screenshot not available', 'err');
    const t = d.data();
    const m = openModal(`
      <h3>Payment Proof</h3>
      <p class="msub">${inr(t.amount)} · UTR <b>${esc(t.utr || '—')}</b> · ${fdate(t.createdAt)}${t.payMethod ? '<br>Paid to: ' + esc(t.payMethod.label || t.payMethod.upiId || t.payMethod.accountNumber || '') : ''}</p>
      <img class="proof-img" id="pv-img" src="${t.proof}" alt="Payment screenshot">
      <p class="msub" style="margin-top:10px;text-align:center">Tap image to zoom · verify amount & UTR match the bank/UPI app before approving</p>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-green" id="pv-ok" style="flex:1">Approve & Credit</button>
        <button class="btn btn-red" id="pv-no" style="flex:1">Reject</button>
      </div>`);
    m.querySelector('#pv-img').onclick = e => e.target.classList.toggle('zoom');
    m.querySelector('#pv-ok').onclick = async () => { closeModal(); await decideRequest(d.id, true); };
    m.querySelector('#pv-no').onclick = async () => { closeModal(); await decideRequest(d.id, false); };
  });
}

/* ATOMIC approve/reject — the transaction doc is re-read INSIDE the Firestore
   transaction and must still be 'pending'. Two admins (or a double-click) can
   never both approve: the loser aborts before any wallet write happens.
   v15: on deposit approval, if the trigger is 'deposit' and this is the user's
   FIRST completed deposit AND they were referred, we pay BOTH the referrer
   and the referred user their configured referral bonus. */
let _decideInFlight = {};
async function decideRequest(id, approve) {
  if (_decideInFlight[id]) return;
  _decideInFlight[id] = true;
  let referralPayout = null; // { referrerUid, referredUid, referrerAmt, referredAmt, refName, refereeName }
  try {
    const ref = db.collection('transactions').doc(id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw 'gone';
      const t = snap.data();
      if (t.status !== 'pending') throw 'already';
      const uref = db.collection('users').doc(t.uid);
      if (approve) {
        tx.update(ref, { status: 'completed', decidedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (t.type === 'deposit') tx.update(uref, {
          balance: firebase.firestore.FieldValue.increment(t.amount),
          totalDeposits: firebase.firestore.FieldValue.increment(t.amount) });
        if (t.type === 'withdraw') tx.update(uref, {
          totalWithdrawn: firebase.firestore.FieldValue.increment(t.amount) });
      } else {
        tx.update(ref, { status: 'rejected', decidedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (t.type === 'withdraw') // refund held balance
          tx.update(uref, { balance: firebase.firestore.FieldValue.increment(t.amount) });
      }
    });
    /* Post-transaction: referral payout on FIRST successful deposit if trigger=deposit */
    if (approve) {
      try {
        const tSnap = await db.collection('transactions').doc(id).get();
        const t = tSnap.data();
        if (t.type === 'deposit') {
          referralPayout = await maybePayReferral(t.uid, t.amount, 'deposit');
        }
      } catch (e) { console.warn('referral payout skipped:', e); }
    }
    let msg = approve ? 'Request approved ✓' : 'Request rejected & refunded';
    if (referralPayout && referralPayout.paid)
      msg += ` · Referral bonus paid (₹${referralPayout.referrerAmt} to ${referralPayout.refName || 'referrer'} + ₹${referralPayout.referredAmt} to ${referralPayout.refereeName || 'user'})`;
    toast(msg, approve ? 'ok' : '');
  } catch (e) {
    if (e === 'already') toast('Already processed by another admin — no duplicate credit', '');
    else toast('Action failed — ' + (e && e.message ? e.message : 'try again'), 'err');
  } finally {
    _decideInFlight[id] = false;
  }
  renderRequests();
}

/* ══════════ REFERRAL PAYOUT ENGINE ══════════
   Pays out referral bonuses when the trigger event fires (default:
   the referred user's first-ever completed deposit meeting the minimum).
   Uses a per-user lock doc (referralPaid/{referredUid}) so bonuses are
   NEVER paid twice, even under concurrent admin actions. */
async function loadReferralConfig() {
  try {
    const d = await db.collection('appContent').doc('referral').get();
    const c = d.exists ? d.data() : {};
    return {
      referrerAmount: Number(c.referrerAmount ?? 25),
      referredAmount: Number(c.referredAmount ?? 25),
      trigger: c.trigger || 'deposit',
      minDeposit: Number(c.minDeposit ?? 0),
      enabled: c.enabled !== false
    };
  } catch (e) { return { referrerAmount: 25, referredAmount: 25, trigger: 'deposit', minDeposit: 0, enabled: true }; }
}

async function maybePayReferral(referredUid, eventAmount, eventType) {
  const cfg = await loadReferralConfig();
  if (!cfg.enabled) return { paid: false, reason: 'disabled' };
  if (eventType === 'deposit' && cfg.trigger !== 'deposit') return { paid: false, reason: 'wrong-trigger' };
  if (eventType === 'plan' && cfg.trigger !== 'first_plan') return { paid: false, reason: 'wrong-trigger' };
  if (eventType === 'deposit' && cfg.minDeposit > 0 && Number(eventAmount || 0) < cfg.minDeposit)
    return { paid: false, reason: 'below-min' };

  // 1. Look up the referred user's profile
  const referredSnap = await db.collection('users').doc(referredUid).get();
  if (!referredSnap.exists) return { paid: false, reason: 'no-user' };
  const referred = referredSnap.data();
  const refCode = (referred.referredBy || '').toString().trim().toUpperCase();
  if (!refCode) return { paid: false, reason: 'no-referrer-code' };

  // 2. Find the referrer by referralCode
  const referrerQ = await db.collection('users').where('referralCode', '==', refCode).limit(1).get();
  if (referrerQ.empty) return { paid: false, reason: 'referrer-not-found' };
  const referrerDoc = referrerQ.docs[0];
  if (referrerDoc.id === referredUid) return { paid: false, reason: 'self-refer' };

  // 3. Idempotent lock (referralPaid/{referredUid})
  const lockRef = db.collection('referralPaid').doc(referredUid);
  const referrerRef = db.collection('users').doc(referrerDoc.id);
  const referredRef = db.collection('users').doc(referredUid);
  const now = firebase.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async tx => {
    const lock = await tx.get(lockRef);
    if (lock.exists) return { paid: false, reason: 'already-paid' };
    const referrerSnap = await tx.get(referrerRef);
    const referredSnap2 = await tx.get(referredRef);
    if (!referrerSnap.exists || !referredSnap2.exists) return { paid: false, reason: 'gone' };
    const referrerName = referrerSnap.data().name || '';
    const referredName = referredSnap2.data().name || '';

    tx.set(lockRef, {
      referrerUid: referrerDoc.id, referredUid,
      referrerAmount: cfg.referrerAmount, referredAmount: cfg.referredAmount,
      trigger: cfg.trigger, paidAt: now
    });
    if (cfg.referrerAmount > 0) {
      tx.update(referrerRef, {
        balance: firebase.firestore.FieldValue.increment(cfg.referrerAmount),
        totalCashback: firebase.firestore.FieldValue.increment(cfg.referrerAmount)
      });
      tx.set(db.collection('transactions').doc(), {
        uid: referrerDoc.id, type: 'cashback', amount: cfg.referrerAmount, status: 'completed',
        note: `Referral bonus — ${referredName || 'friend'} joined with your code`,
        userName: referrerName,
        createdAt: now
      });
    }
    if (cfg.referredAmount > 0) {
      tx.update(referredRef, {
        balance: firebase.firestore.FieldValue.increment(cfg.referredAmount),
        totalCashback: firebase.firestore.FieldValue.increment(cfg.referredAmount)
      });
      tx.set(db.collection('transactions').doc(), {
        uid: referredUid, type: 'cashback', amount: cfg.referredAmount, status: 'completed',
        note: `Welcome bonus — you joined with a referral code`,
        userName: referredName,
        createdAt: now
      });
    }
    return { paid: true, referrerUid: referrerDoc.id, referredUid,
             referrerAmt: cfg.referrerAmount, referredAmt: cfg.referredAmount,
             refName: referrerName, refereeName: referredName };
  });
  return result;
}

/* ══════════ PLAN PAYOUTS (release principal at maturity / cancel+refund) ══════════ */
async function renderPayouts() {
  const el = $('#page-payouts');
  el.innerHTML = '<div class="spinner"></div>';
  const snap = await db.collection('investments').where('status', '==', 'active').get();
  const docs = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => invStartMs(a) - invStartMs(b));
  const due = docs.filter(isDue);
  const running = docs.filter(x => !isDue(x));

  // resolve user names
  const uids = [...new Set(docs.map(x => x.uid))];
  const names = {};
  await Promise.all(uids.map(async u => { const s = await db.collection('users').doc(u).get(); names[u] = s.exists ? s.data().name : u.slice(0, 8); }));

  // v7: interest is credited DAILY. At maturity only the principal is released.
  // Legacy plans (created before v7, interestPaid undefined/0 with unpaid interest)
  // fall back to the old principal + remaining-interest payout.
  const payoutFor = x => {
    const remainingInterest = Math.max(0, (x.cashbackAmount || 0) - (x.accruedInterest || 0));
    return { principal: x.amount || 0, remainingInterest, total: (x.amount || 0) + remainingInterest };
  };

  const row = x => {
    const p = payoutFor(x);
    return `<tr>
      <td><b>${esc(x.planName)}</b><br><span class="mini">${x.durationDays} days · started ${fdate(x.createdAt)}</span></td>
      <td>${esc(names[x.uid] || '—')}</td>
      <td><b>${inr(x.amount)}</b><br><span class="mini" style="color:var(--green)">interest paid daily: ${inr2(x.accruedInterest || 0)}/${inr2(x.cashbackAmount || 0)}</span></td>
      <td><b style="color:var(--p1)">${inr2(p.total)}</b>${p.remainingInterest > 0 ? `<br><span class="mini">incl. ${inr2(p.remainingInterest)} remaining interest</span>` : '<br><span class="mini">principal only</span>'}</td>
      <td>${maturityDate(x).toLocaleDateString('en-IN', {day:'numeric',month:'short'})}</td>
      <td><div class="tbl-actions">
        <button class="btn btn-green btn-sm" data-pay="${x.id}">Release ${inr2(p.total)}</button>
        <button class="btn btn-red btn-sm" data-cancel="${x.id}">Cancel & Refund</button>
      </div></td></tr>`;
  };

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--green)"><div class="tbl-head">
      <h3>🎉 Ready to Pay Out (${due.length})</h3></div>
      ${due.length ? `<div style="padding:10px 18px" class="muted">Duration complete — releasing credits the user's wallet with their <b>principal</b> (daily interest was already credited). A <b>maturity</b> receipt is written to their transaction history. Double-safe: a plan can only be settled once, even with concurrent clicks.</div>
      <div class="tbl-scroll"><table><tr><th>Plan</th><th>User</th><th>Saved</th><th>Release Amount</th><th>Matured</th><th>Actions</th></tr>
      ${due.map(row).join('')}</table></div>` : '<div class="empty">No matured plans waiting for payout 🎉</div>'}</div>

    <div class="tbl-card"><div class="tbl-head"><h3>Still Running (${running.length})</h3></div>
      ${running.length ? `<div class="tbl-scroll"><table><tr><th>Plan</th><th>User</th><th>Saved</th><th>Release Amount</th><th>Matures</th><th>Actions</th></tr>
      ${running.map(row).join('')}</table></div>` : '<div class="empty">No active plans right now.</div>'}</div>`;

  $$('#page-payouts button[data-pay]').forEach(b => b.onclick = () => {
    const x = docs.find(v => v.id === b.dataset.pay);
    const p = payoutFor(x);
    confirmSheet(`Release ${inr2(p.total)} to ${names[x.uid] || 'this user'} for "${x.planName}"? (${inr2(p.principal)} principal${p.remainingInterest > 0 ? ' + ' + inr2(p.remainingInterest) + ' remaining interest' : ''} — daily interest already paid: ${inr2(x.accruedInterest || 0)})`,
      () => settlePlan(x, names[x.uid]));
  });
  $$('#page-payouts button[data-cancel]').forEach(b => b.onclick = () => {
    const x = docs.find(v => v.id === b.dataset.cancel);
    confirmSheet(`Cancel "${x.planName}" for ${names[x.uid] || 'this user'}? Their ${inr(x.amount)} principal is refunded to the wallet. Daily interest already credited (${inr2(x.accruedInterest || 0)}) stays theirs.`,
      () => cancelPlan(x, names[x.uid]));
  });
}

/* ATOMIC settlement — investment is re-read inside the transaction and must
   still be 'active'. Concurrent settles (two admins / double-click) collapse
   to exactly one payout. v15: on plan settlement, also pays referral bonus
   if the configured trigger is 'first_plan'. */
let _settleInFlight = {};
async function settlePlan(x, uname) {
  if (_settleInFlight[x.id]) return;
  _settleInFlight[x.id] = true;
  let referralPayout = null;
  try {
    const invRef = db.collection('investments').doc(x.id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(invRef);
      if (!snap.exists) throw 'gone';
      const i = snap.data();
      if (i.status !== 'active') throw 'already';
      const remainingInterest = Math.round(Math.max(0, (i.cashbackAmount || 0) - (i.accruedInterest || 0)) * 100) / 100;
      const total = (i.amount || 0) + remainingInterest;
      tx.update(invRef, { status: 'completed', paidOutAt: firebase.firestore.FieldValue.serverTimestamp(),
        interestPaid: Math.max(1, i.durationDays || 1), accruedInterest: i.cashbackAmount || 0 });
      tx.update(db.collection('users').doc(i.uid), {
        balance: firebase.firestore.FieldValue.increment(total),
        totalCashback: firebase.firestore.FieldValue.increment(remainingInterest) });
      tx.set(db.collection('transactions').doc(), {
        uid: i.uid, type: 'maturity', amount: i.amount, status: 'completed',
        note: `${i.planName} matured — principal released`, userName: uname || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      if (remainingInterest > 0)
        tx.set(db.collection('transactions').doc(), {
          uid: i.uid, type: 'interest', amount: remainingInterest, status: 'completed',
          invId: x.id,
          note: `${i.planName} — remaining interest settled at maturity`, userName: uname || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    /* Post-settle: pay referral bonus if trigger=first_plan */
    try { referralPayout = await maybePayReferral(x.uid, x.amount, 'plan'); }
    catch (e) { console.warn('referral payout skipped:', e); }
    let msg = `Released funds to ${uname || 'user'} ✓`;
    if (referralPayout && referralPayout.paid)
      msg += ` · Referral bonus paid (₹${referralPayout.referrerAmt} + ₹${referralPayout.referredAmt})`;
    toast(msg, 'ok');
  } catch (e) {
    if (e === 'already') toast('Already settled — duplicate payout blocked', '');
    else toast('Payout failed — ' + (e && e.message ? e.message : 'try again'), 'err');
  } finally {
    _settleInFlight[x.id] = false;
  }
  renderPayouts();
}

async function cancelPlan(x, uname) {
  if (_settleInFlight[x.id]) return;
  _settleInFlight[x.id] = true;
  try {
    const invRef = db.collection('investments').doc(x.id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(invRef);
      if (!snap.exists) throw 'gone';
      const i = snap.data();
      if (i.status !== 'active') throw 'already';
      tx.update(invRef, { status: 'cancelled' });
      tx.update(db.collection('users').doc(i.uid), {
        balance: firebase.firestore.FieldValue.increment(i.amount || 0),
        totalSaved: firebase.firestore.FieldValue.increment(-(i.amount || 0)) });
      tx.set(db.collection('transactions').doc(), {
        uid: i.uid, type: 'refund', amount: i.amount, status: 'completed',
        note: `${i.planName} cancelled — principal refunded`, userName: uname || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    toast(`Plan cancelled — ${inr(x.amount)} refunded`, 'ok');
  } catch (e) {
    if (e === 'already') toast('Already processed — duplicate refund blocked', '');
    else toast('Cancel failed — ' + (e && e.message ? e.message : 'try again'), 'err');
  } finally {
    _settleInFlight[x.id] = false;
  }
  renderPayouts();
}

/* ══════════ ALL TRANSACTIONS (full history + filters) ══════════ */
let txCache = null;
async function renderHistory() {
  const el = $('#page-history');
  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>All Transactions</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="search-in" id="h-status" style="width:auto">
        <option value="">All statuses</option><option value="completed">Completed</option>
        <option value="pending">Pending</option><option value="rejected">Rejected</option></select>
      <select class="search-in" id="h-type" style="width:auto">
        <option value="">All types</option><option value="deposit">Deposits</option>
        <option value="withdraw">Withdrawals</option><option value="invest">Investments</option>
        <option value="interest">Daily Interest</option><option value="maturity">Maturity</option>
        <option value="cashback">Cashback</option><option value="refund">Refunds</option></select>
      <input class="search-in" id="h-search" placeholder="Search user / UTR / note…">
    </div></div>
    <div id="h-tbl"><div class="spinner"></div></div></div>`;
  const snap = await db.collection('transactions').get();
  txCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  const uids = [...new Set(txCache.map(t => t.uid))];
  const names = {};
  await Promise.all(uids.map(async u => { const s = await db.collection('users').doc(u).get(); names[u] = s.exists ? s.data().name : u.slice(0, 8); }));
  txCache.forEach(t => t._name = t.userName || names[t.uid] || '—');

  const draw = () => {
    const st = $('#h-status').value, ty = $('#h-type').value, q = ($('#h-search').value || '').toLowerCase();
    const list = txCache.filter(t =>
      (!st || t.status === st) && (!ty || t.type === ty) &&
      (!q || (t._name || '').toLowerCase().includes(q) || (t.utr || '').toLowerCase().includes(q) ||
             (t.note || '').toLowerCase().includes(q) || (t.type || '').includes(q)));
    $('#h-tbl').innerHTML = list.length ? `
      <div class="tbl-scroll"><table><tr><th>Type</th><th>User</th><th>Amount</th><th>Details</th><th>Status</th><th>When</th></tr>
      ${list.slice(0, 200).map(t => `<tr>
        <td><span class="chip ${t.type === 'deposit' ? 'chip-blue' : t.type === 'withdraw' ? 'chip-amber' : t.type === 'invest' ? 'chip-red' : 'chip-green'}">${esc(t.type)}</span></td>
        <td><b>${esc(t._name)}</b></td>
        <td><b>${inr2(t.amount)}</b></td>
        <td><span class="mini">${esc(t.note || '')}${t.utr ? ' · UTR ' + esc(t.utr) : ''}</span></td>
        <td><span class="chip ${t.status === 'pending' ? 'chip-amber' : t.status === 'completed' ? 'chip-green' : 'chip-red'}">${esc(t.status)}</span></td>
        <td>${fdate(t.createdAt)}</td></tr>`).join('')}</table></div>
      ${list.length > 200 ? `<div style="padding:12px 18px" class="muted">Showing first 200 of ${list.length} — refine your search.</div>` : ''}`
      : '<div class="empty">No matching transactions</div>';
  };
  $('#h-status').onchange = draw;
  $('#h-type').onchange = draw;
  $('#h-search').oninput = draw;
  draw();
}

/* ══════════ PAYMENT METHODS (UPI / bank for deposits) ══════════ */
async function renderPayments() {
  const el = $('#page-payments');
  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>Deposit Payment Methods</h3>
    <button class="btn btn-primary btn-sm" id="pm-new">+ Add Method</button></div>
    <div style="padding:12px 18px" class="muted">These UPI IDs / bank accounts are shown to users in the app's deposit flow.
    Users pay here, then submit their UTR + screenshot for verification.</div></div>
    <div class="plan-grid" id="pm-grid"><div class="spinner"></div></div>`;
  $('#pm-new').onclick = () => paymentEditor(null);
  const snap = await db.collection('paymentMethods').get();
  const grid = $('#pm-grid'); grid.innerHTML = '';
  if (snap.empty) { grid.innerHTML = '<div class="tbl-card"><div class="empty">No payment methods yet — add your UPI ID or bank account.</div></div>'; return; }
  snap.docs.forEach(d => {
    const m = d.data();
    const c = document.createElement('div');
    c.className = 'ap-card';
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h4 class="pm-type">${m.type === 'upi'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px;color:var(--p1)"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px;color:var(--green)"><path d="M3 21h18"/><path d="M5 21v-8"/><path d="M9 21v-8"/><path d="M15 21v-8"/><path d="M19 21v-8"/><path d="m12 2 9 5H3z"/></svg>'}
          ${esc(m.label || (m.type === 'upi' ? 'UPI' : 'Bank'))}</h4>
        <span class="chip ${m.active ? 'chip-green' : 'chip-red'}">${m.active ? 'Live' : 'Hidden'}</span></div>
      <div class="pm-detail">${m.type === 'upi'
        ? `UPI ID: <b>${esc(m.upiId || '—')}</b>`
        : `A/C Name: <b>${esc(m.accountName || '—')}</b><br>A/C No: <b>${esc(m.accountNumber || '—')}</b><br>IFSC: <b>${esc(m.ifsc || '—')}</b> · ${esc(m.bankName || '')}`}
        ${m.note ? `<br><span class="muted">${esc(m.note)}</span>` : ''}</div>
      <div class="ap-actions">
        <button class="btn btn-soft btn-sm" style="flex:1" data-e>Edit</button>
        <button class="btn ${m.active ? 'btn-red' : 'btn-green'} btn-sm" style="flex:1" data-t>${m.active ? 'Hide' : 'Go Live'}</button>
        <button class="btn btn-red btn-sm" data-d><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;
    c.querySelector('[data-e]').onclick = () => paymentEditor({ id: d.id, ...m });
    c.querySelector('[data-t]').onclick = async () => {
      try { await db.collection('paymentMethods').doc(d.id).update({ active: !m.active }); toast(m.active ? 'Method hidden from users' : 'Method live for all users', 'ok'); }
      catch (e) { toast('Update failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
      renderPayments();
    };
    c.querySelector('[data-d]').onclick = () => confirmSheet('Delete this payment method? Users won\'t see it in deposits anymore.', async () => {
      try { await db.collection('paymentMethods').doc(d.id).delete(); toast('Payment method deleted'); }
      catch (e) { toast('Delete failed — try again', 'err'); }
      renderPayments();
    });
    grid.appendChild(c);
  });
}

function paymentEditor(m) {
  const isNew = !m;
  m = m || { type: 'upi', label: '', upiId: '', accountName: '', accountNumber: '', ifsc: '', bankName: '', note: '', active: true };
  const mo = openModal(`
    <h3>${isNew ? 'Add Payment Method' : 'Edit Payment Method'}</h3>
    <p class="msub">Users will pay to this account and submit UTR + screenshot for verification.</p>
    <div class="frow"><span>Type</span><select class="field-in" id="pm-type">
      <option value="upi" ${m.type === 'upi' ? 'selected' : ''}>UPI ID</option>
      <option value="bank" ${m.type === 'bank' ? 'selected' : ''}>Bank Account</option></select></div>
    <div class="frow"><span>Label</span><input class="field-in" id="pm-label" value="${esc(m.label)}" placeholder="e.g. Primary UPI / HDFC Current A/C"></div>
    <div id="pm-upi" class="${m.type === 'upi' ? '' : 'hidden'}">
      <div class="frow"><span>UPI ID</span><input class="field-in" id="pm-upiid" value="${esc(m.upiId || '')}" placeholder="yourname@okhdfcbank"></div>
    </div>
    <div id="pm-bank" class="${m.type === 'bank' ? '' : 'hidden'}">
      <div class="frow"><span>Account Holder Name</span><input class="field-in" id="pm-acname" value="${esc(m.accountName || '')}"></div>
      <div class="frow2">
        <div class="frow"><span>Account Number</span><input class="field-in" id="pm-acno" value="${esc(m.accountNumber || '')}"></div>
        <div class="frow"><span>IFSC</span><input class="field-in" id="pm-ifsc" value="${esc(m.ifsc || '')}"></div>
      </div>
      <div class="frow"><span>Bank Name</span><input class="field-in" id="pm-bankname" value="${esc(m.bankName || '')}" placeholder="e.g. HDFC Bank"></div>
    </div>
    <div class="frow"><span>Note for users (optional)</span><input class="field-in" id="pm-note" value="${esc(m.note || '')}" placeholder="e.g. Use only for deposits above ₹1,000"></div>
    <div style="display:flex;gap:10px;margin-top:6px">
      <button class="btn btn-primary" id="pm-save" style="flex:1">${isNew ? 'Add & Go Live' : 'Save'}</button>
      <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  mo.querySelector('#pm-type').onchange = e => {
    mo.querySelector('#pm-upi').classList.toggle('hidden', e.target.value !== 'upi');
    mo.querySelector('#pm-bank').classList.toggle('hidden', e.target.value !== 'bank');
  };
  mo.querySelector('#pm-save').onclick = async () => {
    const type = mo.querySelector('#pm-type').value;
    const data = {
      type, label: mo.querySelector('#pm-label').value.trim(),
      note: mo.querySelector('#pm-note').value.trim(),
      active: isNew ? true : m.active
    };
    if (type === 'upi') {
      data.upiId = mo.querySelector('#pm-upiid').value.trim();
      if (!/^\S+@\S+$/.test(data.upiId)) return toast('Enter a valid UPI ID', 'err');
    } else {
      data.accountName = mo.querySelector('#pm-acname').value.trim();
      data.accountNumber = mo.querySelector('#pm-acno').value.replace(/\s/g, '');
      data.ifsc = mo.querySelector('#pm-ifsc').value.trim().toUpperCase();
      data.bankName = mo.querySelector('#pm-bankname').value.trim();
      if (!data.accountName || !data.accountNumber || !data.ifsc) return toast('Fill all bank fields', 'err');
    }
    try {
      if (isNew) await db.collection('paymentMethods').add(data);
      else await db.collection('paymentMethods').doc(m.id).update(data);
      closeModal(); toast(isNew ? 'Payment method live for all users' : 'Payment method saved — synced to user app', 'ok');
    } catch (e) { toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
    renderPayments();
  };
}

/* ══════════ USERS ══════════ */
async function renderUsers() {
  const el = $('#page-users');
  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>All Users</h3>
    <input class="search-in" id="u-search" placeholder="Search name / email…"></div>
    <div id="u-tbl"><div class="spinner"></div></div></div>`;
  const snap = await db.collection('users').orderBy('createdAt', 'desc').get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const draw = list => {
    $('#u-tbl').innerHTML = list.length ? `
      <div class="tbl-scroll"><table><tr><th>Name</th><th>Contact</th><th>Balance</th><th>Saved</th><th>Interest</th><th>Bank</th><th>Role</th><th>Actions</th></tr>
      ${list.map(u => `<tr>
        <td><b>${esc(u.name)}</b>${u.blocked ? '<br><span class="chip chip-red">blocked</span>' : ''}</td>
        <td>${esc(u.email)}<br><span class="muted">${esc(u.phone || '')}</span></td>
        <td><b>${inr2(u.balance)}</b></td><td>${inr(u.totalSaved)}</td><td>${inr2(u.totalCashback)}</td>
        <td>${u.bankDetails && u.bankDetails.accountNumber
          ? `<span class="mini">${esc(u.bankDetails.bankName)} ·•••• ${esc(String(u.bankDetails.accountNumber).slice(-4))}<br>IFSC ${esc(u.bankDetails.ifsc)}</span>
             <button class="proof-btn" data-bank="${u.id}">View</button>`
          : '<span class="mini">—</span>'}</td>
        <td><span class="chip ${u.role === 'admin' ? 'chip-red' : 'chip-blue'}">${u.role || 'user'}</span></td>
        <td><div class="tbl-actions">
          <button class="btn btn-soft btn-sm" data-adj="${u.id}">Adjust</button>
          <button class="btn btn-soft btn-sm" data-inv="${u.id}">Plans</button>
          ${u.role !== 'admin' ? `<button class="btn btn-red btn-sm" data-block="${u.id}">${u.blocked ? 'Unblock' : 'Block'}</button>` : ''}
        </div></td></tr>`).join('')}</table></div>` : '<div class="empty">No users found</div>';
    $$('#u-tbl button[data-adj]').forEach(b => b.onclick = () => adjustBalance(b.dataset.adj, list.find(x => x.id === b.dataset.adj)));
    $$('#u-tbl button[data-inv]').forEach(b => b.onclick = () => userInvestments(b.dataset.inv, list.find(x => x.id === b.dataset.inv)));
    $$('#u-tbl button[data-bank]').forEach(b => b.onclick = () => {
      const u = list.find(x => x.id === b.dataset.bank);
      const bd = u.bankDetails;
      openModal(`<h3>Bank Details — ${esc(u.name)}</h3><p class="msub">Used for withdrawal payouts</p>
        <div class="kv"><span>Holder</span><b>${esc(bd.holderName)}</b>
        <span>Bank</span><b>${esc(bd.bankName)}</b>
        <span>A/C No</span><b>${esc(bd.accountNumber)}</b>
        <span>IFSC</span><b>${esc(bd.ifsc)}</b>
        ${bd.upiId ? `<span>UPI</span><b>${esc(bd.upiId)}</b>` : ''}</div>
        <button class="btn btn-soft btn-block" onclick="closeModal()">Close</button>`);
    });
    $$('#u-tbl button[data-block]').forEach(b => b.onclick = async () => {
      const u = list.find(x => x.id === b.dataset.block);
      try {
        await db.collection('users').doc(u.id).update({ blocked: !u.blocked });
        toast(u.blocked ? 'User unblocked' : 'User blocked');
      } catch (e) { toast('Update failed — try again', 'err'); }
      renderUsers();
    });
  };
  draw(rows);
  $('#u-search').oninput = e => {
    const q = e.target.value.toLowerCase();
    draw(rows.filter(u => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)));
  };
}

/* per-user investment manager: release due interest, settle, cancel — all atomic */
async function userInvestments(uid, u) {
  const m = openModal(`<h3>Investments — ${esc(u.name)}</h3><p class="msub">Loading…</p>`);
  let docs = [];
  try {
    const snap = await db.collection('investments').where('uid', '==', uid).get();
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => invStartMs(b) - invStartMs(a));
  } catch (e) {}
  m.innerHTML = `<h3>Investments — ${esc(u.name)}</h3>
    <p class="msub">${docs.length ? docs.length + ' plan(s) total' : 'No investments yet'}</p>
    ${docs.map(x => {
      const days = Math.max(1, x.durationDays || 1);
      const paid = x.interestPaid || 0, dueN = x.status === 'active' ? periodsElapsed(x) : paid;
      let pend = 0; for (let d = paid + 1; d <= dueN; d++) pend += dayPaise(x, d);
      return `<div class="uinv">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
          <b>${esc(x.planName)}</b>
          <span class="chip ${x.status === 'active' ? 'chip-green' : x.status === 'completed' ? 'chip-blue' : 'chip-red'}">${x.status}</span></div>
        <div class="mini">Saved ${inr(x.amount)} · ${x.cashbackPct}% over ${days}d · interest paid ${paid}/${days} days (${inr2(x.accruedInterest || 0)})</div>
        ${x.status === 'active' ? `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${pend > 0 ? `<button class="btn btn-green btn-sm" data-rel="${x.id}">Release due interest ${inr2(fromPaise(pend))}</button>` : ''}
          <button class="btn btn-soft btn-sm" data-set="${x.id}">Settle now</button>
          <button class="btn btn-red btn-sm" data-can="${x.id}">Cancel & refund</button>
        </div>` : ''}
      </div>`;
    }).join('')}
    <button class="btn btn-soft btn-block" onclick="closeModal()" style="margin-top:8px">Close</button>`;
  m.querySelectorAll('button[data-rel]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const got = await reconcileInvestmentAdmin(b.dataset.rel);
      toast(got > 0 ? 'Due interest released ✓' : 'Nothing due right now', got > 0 ? 'ok' : '');
    } catch (e) {
      toast(e === 'locked' ? 'User\'s app is crediting right now — skipped (no double pay)' : 'Release failed', e === 'locked' ? '' : 'err');
    }
    closeModal(); userInvestments(uid, u);
  });
  m.querySelectorAll('button[data-set]').forEach(b => b.onclick = () => {
    const x = docs.find(v => v.id === b.dataset.set);
    closeModal();
    confirmSheet(`Settle "${x.planName}" for ${esc(u.name)} now (release principal${(x.cashbackAmount - (x.accruedInterest || 0)) > 0 ? ' + remaining interest' : ''})?`, () => { settlePlan(x, u.name); });
  });
  m.querySelectorAll('button[data-can]').forEach(b => b.onclick = () => {
    const x = docs.find(v => v.id === b.dataset.can);
    closeModal();
    confirmSheet(`Cancel "${x.planName}" for ${esc(u.name)}? Principal ${inr(x.amount)} is refunded.`, () => { cancelPlan(x, u.name); });
  });
}

function adjustBalance(uid, u) {
  const m = openModal(`
    <h3>Adjust Balance — ${esc(u.name)}</h3>
    <p class="msub">Current balance: ${inr2(u.balance)} · use for cashback credits, corrections or bonuses</p>
    <div class="frow"><span>Amount (₹)</span><input class="field-in" id="adj-amt" type="number" placeholder="100"></div>
    <div class="frow"><span>Type</span><select class="field-in" id="adj-type">
      <option value="credit">Credit (add)</option><option value="debit">Debit (remove)</option></select></div>
    <div class="frow"><span>Reason</span><input class="field-in" id="adj-why" placeholder="e.g. Referral bonus"></div>
    <div style="display:flex;gap:10px"><button class="btn btn-primary" id="adj-go" style="flex:1">Apply</button>
    <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  m.querySelector('#adj-go').onclick = async () => {
    const amt = Number(m.querySelector('#adj-amt').value);
    const why = m.querySelector('#adj-why').value.trim() || 'Admin adjustment';
    const credit = m.querySelector('#adj-type').value === 'credit';
    if (!amt || amt <= 0 || !Number.isFinite(amt)) return toast('Enter a valid amount', 'err');
    if (!credit && amt > (u.balance || 0)) return toast('Cannot debit more than the balance', 'err');
    try {
      const uref = db.collection('users').doc(uid);
      await db.runTransaction(async tx => {
        const s = await tx.get(uref);
        if (!s.exists) throw 'gone';
        if (!credit && amt > (s.data().balance || 0)) throw 'insufficient';
        tx.update(uref, { balance: firebase.firestore.FieldValue.increment(credit ? amt : -amt) });
        tx.set(db.collection('transactions').doc(), {
          uid, type: credit ? 'cashback' : 'withdraw', amount: amt, status: 'completed',
          note: why, userName: u.name || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      closeModal(); toast('Balance updated', 'ok'); renderUsers();
    } catch (e) {
      toast(e === 'insufficient' ? 'Balance changed — debit would now exceed it' : 'Adjustment failed — try again', 'err');
    }
  };
}

/* ══════════ PLANS ══════════ */
async function renderPlans() {
  const el = $('#page-plans');
  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>Savings Plans</h3>
    <button class="btn btn-primary btn-sm" id="p-new">+ New Plan</button></div>
    <div style="padding:10px 18px" class="muted">Interest % is the <b>total</b> over the duration — it accrues in equal daily slices (total ÷ days) credited every 24h from activation.</div></div>
    <div class="plan-grid" id="p-grid"><div class="spinner"></div></div>`;
  $('#p-new').onclick = () => planEditor(null);
  const snap = await db.collection('plans').orderBy('minAmount').get();
  const grid = $('#p-grid'); grid.innerHTML = '';
  if (snap.empty) { grid.innerHTML = '<div class="tbl-card"><div class="empty">No plans yet — create one or seed demo plans.</div></div>'; return; }
  snap.forEach(d => {
    const p = d.data();
    const c = document.createElement('div');
    c.className = 'ap-card';
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h4>${esc(p.name)}</h4>
        <span class="chip ${p.active ? 'chip-green' : 'chip-red'}">${p.active ? 'Live' : 'Hidden'}</span></div>
      <p class="muted" style="margin-top:4px">${esc(p.tagline || '')}</p>
      <div class="ap-stats">
        <div class="ap-stat"><small>Min</small><b>${inr(p.minAmount)}</b></div>
        <div class="ap-stat"><small>Total Int.</small><b>${p.cashbackPct}%</b></div>
        <div class="ap-stat"><small>Daily</small><b>${(p.cashbackPct / Math.max(1, p.durationDays)).toFixed(2)}%</b></div>
        <div class="ap-stat"><small>Days</small><b>${p.durationDays}</b></div>
      </div>
      <div class="ap-actions">
        <button class="btn btn-soft btn-sm" style="flex:1" data-e>Edit</button>
        <button class="btn ${p.active ? 'btn-red' : 'btn-green'} btn-sm" style="flex:1" data-t>${p.active ? 'Hide' : 'Go Live'}</button>
        <button class="btn btn-red btn-sm" data-d><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;
    c.querySelector('[data-e]').onclick = () => planEditor({ id: d.id, ...p });
    c.querySelector('[data-t]').onclick = async () => {
      try { await db.collection('plans').doc(d.id).update({ active: !p.active }); toast(p.active ? 'Plan hidden from users' : 'Plan live in the user app', 'ok'); }
      catch (e) { toast('Update failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
      renderPlans();
    };
    c.querySelector('[data-d]').onclick = () => confirmSheet('Delete this plan? Users won\'t see it anymore.', async () => {
      try { await db.collection('plans').doc(d.id).delete(); toast('Plan deleted'); }
      catch (e) { toast('Delete failed — try again', 'err'); }
      renderPlans();
    });
    grid.appendChild(c);
  });
}

function planEditor(p) {
  const isNew = !p;
  p = p || { name: '', tagline: '', minAmount: 300, cashbackPct: 5, durationDays: 30, popular: false, active: true, perks: [] };
  const m = openModal(`
    <h3>${isNew ? 'Create Plan' : 'Edit Plan'}</h3>
    <p class="msub">Interest % is the TOTAL reward across the duration — it accrues daily (total ÷ days) and lands in the user's wallet every 24h from activation. Keep it realistic and sustainable.</p>
    <div class="frow"><span>Plan Name</span><input class="field-in" id="pf-name" value="${esc(p.name)}" placeholder="Starter Saver"></div>
    <div class="frow"><span>Tagline</span><input class="field-in" id="pf-tag" value="${esc(p.tagline)}" placeholder="Perfect for beginners"></div>
    <div class="frow2">
      <div class="frow"><span>Min Amount (₹)</span><input class="field-in" id="pf-min" type="number" value="${p.minAmount}"></div>
      <div class="frow"><span>Total Interest %</span><input class="field-in" id="pf-cb" type="number" step="0.5" value="${p.cashbackPct}"></div>
    </div>
    <div class="frow"><span>Duration (days)</span><input class="field-in" id="pf-days" type="number" value="${p.durationDays}"></div>
    <div class="frow"><span>Perks (one per line)</span><textarea class="field-in" id="pf-perks">${esc((p.perks || []).join('\n'))}</textarea></div>
    <div class="frow" style="flex-direction:row;align-items:center;gap:10px">
      <input type="checkbox" id="pf-pop" ${p.popular ? 'checked' : ''}> <span style="font-size:.82rem">Show "POPULAR" ribbon</span></div>
    <div style="display:flex;gap:10px;margin-top:6px">
      <button class="btn btn-primary" id="pf-save" style="flex:1">${isNew ? 'Create' : 'Save'}</button>
      <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  m.querySelector('#pf-save').onclick = async () => {
    const data = {
      name: m.querySelector('#pf-name').value.trim(),
      tagline: m.querySelector('#pf-tag').value.trim(),
      minAmount: Number(m.querySelector('#pf-min').value),
      cashbackPct: Number(m.querySelector('#pf-cb').value),
      durationDays: Number(m.querySelector('#pf-days').value),
      perks: m.querySelector('#pf-perks').value.split('\n').map(x => x.trim()).filter(Boolean),
      popular: m.querySelector('#pf-pop').checked,
      active: isNew ? true : p.active
    };
    if (!data.name || !data.minAmount || !data.durationDays) return toast('Fill name, amount and duration', 'err');
    if (data.minAmount <= 0 || data.durationDays <= 0 || data.cashbackPct < 0 || !Number.isFinite(data.cashbackPct))
      return toast('Enter valid amount, interest and duration', 'err');
    try {
      if (isNew) await db.collection('plans').add(data);
      else await db.collection('plans').doc(p.id).update(data);
      closeModal(); toast(isNew ? 'Plan created — live in the user app now!' : 'Plan saved — updated in the user app', 'ok');
    } catch (e) { toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
    renderPlans();
  };
}

async function seedPlans() {
  const demo = [
    { name: 'Starter Saver', tagline: 'Begin your savings habit', minAmount: 300, cashbackPct: 3, durationDays: 30, popular: false, active: true,
      perks: ['3% total interest, credited daily', 'Withdraw anytime after 30 days', 'Full transaction receipts'] },
    { name: 'Smart Saver', tagline: 'For consistent savers', minAmount: 1000, cashbackPct: 5, durationDays: 60, popular: true, active: true,
      perks: ['5% total interest, credited daily', 'Priority withdrawal processing', 'Free savings insights report'] },
    { name: 'Champion Saver', tagline: 'Maximum rewards', minAmount: 3000, cashbackPct: 7, durationDays: 90, popular: false, active: true,
      perks: ['7% total interest, credited daily', 'Dedicated support line', 'Early access to new plans'] }
  ];
  try {
    const batch = db.batch();
    demo.forEach(p => batch.set(db.collection('plans').doc(), p));
    await batch.commit();
    toast('3 demo plans created', 'ok');
  } catch (e) { toast('Seed failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
  renderPlans();
}

/* ══════════ ANNOUNCEMENTS ══════════ */
async function renderAnnounce() {
  const el = $('#page-announce');
  el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>Announcements</h3>
    <button class="btn btn-primary btn-sm" id="a-new">+ New Announcement</button></div>
    <div id="a-list"><div class="spinner"></div></div></div>`;
  $('#a-new').onclick = () => annEditor(null);
  const snap = await db.collection('announcements').orderBy('createdAt', 'desc').get();
  $('#a-list').innerHTML = snap.empty ? '<div class="empty">No announcements yet</div>' : `
    <div class="tbl-scroll"><table><tr><th>Title</th><th>Message</th><th>Posted</th><th></th></tr>
    ${snap.docs.map(d => { const a = d.data(); return `<tr><td><b>${esc(a.title)}</b></td>
      <td style="max-width:340px">${esc(a.body)}</td><td>${fdate(a.createdAt)}</td>
      <td><button class="btn btn-red btn-sm" data-del="${d.id}">Delete</button></td></tr>`; }).join('')}</table></div>`;
  $$('#a-list button[data-del]').forEach(b => b.onclick = () => confirmSheet('Delete this announcement?', async () => {
    try { await db.collection('announcements').doc(b.dataset.del).delete(); toast('Announcement deleted'); }
    catch (e) { toast('Delete failed — try again', 'err'); }
    renderAnnounce();
  }));
}

function annEditor() {
  const m = openModal(`
    <h3>New Announcement</h3><p class="msub">Shown on the Home screen and in Notifications — updates go live instantly</p>
    <div class="frow"><span>Title</span><input class="field-in" id="an-t" placeholder="🎉 Weekend interest boost!"></div>
    <div class="frow"><span>Message</span><textarea class="field-in" id="an-b" placeholder="Write a short, clear message…"></textarea></div>
    <div style="display:flex;gap:10px"><button class="btn btn-primary" id="an-go" style="flex:1">Publish</button>
    <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  m.querySelector('#an-go').onclick = async () => {
    const title = m.querySelector('#an-t').value.trim(), body = m.querySelector('#an-b').value.trim();
    if (!title || !body) return toast('Title and message required', 'err');
    try {
      await db.collection('announcements').add({ title, body, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      closeModal(); toast('Announcement published — live in the user app', 'ok');
    } catch (e) { toast('Publish failed — try again', 'err'); }
    renderAnnounce();
  };
}

/* ══════════ APP CONTENT (trust strip, about) ══════════ */
async function renderContent() {
  const el = $('#page-content');
  el.innerHTML = '<div class="spinner"></div>';
  const d = await db.collection('appContent').doc('main').get();
  const c = d.exists ? d.data() : {};
  el.innerHTML = `
    <div class="tbl-card"><div class="tbl-head"><h3>Home Screen Content</h3></div>
      <div style="padding:18px">
        <div class="frow"><span>"Why trust us" section title</span>
          <input class="field-in" id="c-title" value="${esc(c.aboutTitle || 'Why thousands trust GodX')}"></div>
        <div class="frow"><span>Trust strip items (format: Label | sublabel, comma separated)</span>
          <textarea class="field-in" id="c-trust">${esc((c.trustPoints || [
            {t:'Bank-grade Security',d:'AES-256 encrypted'},{t:'Instant Withdrawals',d:'Money in 24 hrs'},
            {t:'RBI-compliant Partners',d:'Regulated rails'},{t:'Zero Hidden Fees',d:'100% transparent'}
          ]).map(x => x.t + ' | ' + x.d).join(', '))}</textarea></div>
        <div class="frow"><span>About points (format: Title | description, one per line)</span>
          <textarea class="field-in" id="c-about" style="min-height:110px">${esc((c.aboutPoints || [
            {t:'Real savings, real rewards',d:'Every rupee earns actual interest, credited daily.'},
            {t:'Your money stays liquid',d:'Withdraw anytime after your plan duration.'},
            {t:'Fully transparent',d:'Every transaction visible with receipts and status.'}
          ]).map(x => x.t + ' | ' + x.d).join('\n'))}</textarea></div>
        <button class="btn btn-primary" id="c-save">Save Content</button>
      </div></div>`;
  $('#c-save').onclick = async () => {
    const trust = $('#c-trust').value.split(',').map(x => { const [t, d] = x.split('|').map(s => (s || '').trim()); return t ? { t, d: d || '' } : null; }).filter(Boolean);
    const about = $('#c-about').value.split('\n').map(x => { const [t, d] = x.split('|').map(s => (s || '').trim()); return t ? { t, d: d || '' } : null; }).filter(Boolean);
    try {
      await db.collection('appContent').doc('main').set({ aboutTitle: $('#c-title').value.trim(), trustPoints: trust, aboutPoints: about }, { merge: true });
      toast('Home screen content updated — instantly live for all users', 'ok');
    } catch (e) { toast('Save failed — try again', 'err'); }
  };
}

/* ══════════ REFERRAL SETTINGS PAGE (admin-editable) ══════════ */
async function renderReferralSettings() {
  const el = $('#page-referral');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try {
    const d = await db.collection('appContent').doc('referral').get();
    cfg = d.exists ? d.data() : {};
  } catch (e) {}
  const c = {
    referrerAmount: cfg.referrerAmount ?? 25,
    referredAmount: cfg.referredAmount ?? 25,
    trigger: cfg.trigger || 'deposit',
    minDeposit: cfg.minDeposit ?? 0,
    title: cfg.title || 'Refer & Earn',
    description: cfg.description || 'Share your code — you both get a reward when a friend joins!',
    enabled: cfg.enabled !== false
  };

  // count paid referrals stat
  let paidCount = 0, totalPaid = 0;
  try {
    const s = await db.collection('referralPaid').get();
    paidCount = s.size;
    s.forEach(d => totalPaid += (d.data().referrerAmount || 0) + (d.data().referredAmount || 0));
  } catch (e) {}

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>🎁 Refer & Earn Settings</h3>
        <span class="chip ${c.enabled ? 'chip-green' : 'chip-red'}">${c.enabled ? 'ENABLED' : 'DISABLED'}</span></div>
      <div style="padding:12px 18px" class="muted">
        Set how much both the <b>referrer</b> and the <b>referred user</b> earn, and choose
        when the bonus is paid. Bonuses are auto-credited once per referred user, guarded
        by a lock doc — no double-payments even under concurrent admin actions.
      </div>
      <div style="padding:0 18px 6px;display:flex;gap:12px;flex-wrap:wrap">
        <div class="sc" style="flex:1;min-width:180px"><small>Paid Referrals</small><b>${paidCount}</b>
          <div class="sc-sub">Total bonuses given: ${inr(totalPaid)}</div></div>
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Configure Reward</h3></div>
      <div style="padding:18px">
        <div class="frow" style="flex-direction:row;align-items:center;gap:10px">
          <input type="checkbox" id="rf-enabled" ${c.enabled ? 'checked' : ''}>
          <span><b>Enable referral bonus program</b> — uncheck to pause all new referral payouts</span>
        </div>
        <div class="frow2">
          <div class="frow"><span>Referrer bonus (₹) — paid to the person who shared the code</span>
            <input class="field-in" id="rf-referrer" type="number" min="0" step="1" value="${c.referrerAmount}"></div>
          <div class="frow"><span>Referred user bonus (₹) — paid to the new user who joined</span>
            <input class="field-in" id="rf-referred" type="number" min="0" step="1" value="${c.referredAmount}"></div>
        </div>
        <div class="frow"><span>When to pay the bonus</span>
          <select class="field-in" id="rf-trigger">
            <option value="deposit" ${c.trigger === 'deposit' ? 'selected' : ''}>When referred user's first deposit is APPROVED (recommended)</option>
            <option value="first_plan" ${c.trigger === 'first_plan' ? 'selected' : ''}>When referred user completes their FIRST plan</option>
          </select>
        </div>
        <div class="frow"><span>Minimum deposit amount (₹) — only if trigger is "first deposit". 0 = no minimum.</span>
          <input class="field-in" id="rf-min" type="number" min="0" step="10" value="${c.minDeposit}"></div>
        <div class="frow"><span>Title (shown in user app)</span>
          <input class="field-in" id="rf-title" value="${esc(c.title)}" placeholder="Refer & Earn"></div>
        <div class="frow"><span>Description (shown in user app)</span>
          <textarea class="field-in" id="rf-desc">${esc(c.description)}</textarea></div>
        <button class="btn btn-primary" id="rf-save">Save Settings</button>
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Recent Referral Payouts</h3></div>
      <div id="rf-history"><div class="spinner"></div></div>
    </div>`;

  $('#rf-save').onclick = async () => {
    const data = {
      referrerAmount: Number($('#rf-referrer').value) || 0,
      referredAmount: Number($('#rf-referred').value) || 0,
      trigger: $('#rf-trigger').value,
      minDeposit: Number($('#rf-min').value) || 0,
      title: $('#rf-title').value.trim() || 'Refer & Earn',
      description: $('#rf-desc').value.trim(),
      enabled: $('#rf-enabled').checked,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (data.referrerAmount < 0 || data.referredAmount < 0) return toast('Amounts must be zero or positive', 'err');
    if (data.referrerAmount > 100000 || data.referredAmount > 100000) return toast('Amounts look unreasonably large', 'err');
    try {
      await db.collection('appContent').doc('referral').set(data, { merge: true });
      toast('Referral settings saved — live in user app instantly', 'ok');
      renderReferralSettings();
    } catch (e) { toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
  };

  try {
    const s = await db.collection('referralPaid').orderBy('paidAt', 'desc').limit(30).get();
    const box = $('#rf-history');
    if (!s.size) { box.innerHTML = '<div class="empty">No referral bonuses paid yet.</div>'; return; }
    const uids = new Set();
    s.docs.forEach(d => { uids.add(d.data().referrerUid); uids.add(d.data().referredUid); });
    const names = {};
    await Promise.all([...uids].map(async u => { try { const x = await db.collection('users').doc(u).get(); names[u] = x.exists ? x.data().name : u.slice(0,8); } catch(e){ names[u] = u.slice(0,8); } }));
    box.innerHTML = `<div class="tbl-scroll"><table><tr><th>When</th><th>Referrer</th><th>Referred User</th><th>Referrer got</th><th>Referred got</th><th>Trigger</th></tr>
      ${s.docs.map(d => { const x = d.data(); return `<tr>
        <td>${fdate(x.paidAt)}</td>
        <td><b>${esc(names[x.referrerUid] || '—')}</b></td>
        <td><b>${esc(names[x.referredUid] || '—')}</b></td>
        <td>${inr(x.referrerAmount)}</td>
        <td>${inr(x.referredAmount)}</td>
        <td><span class="chip chip-blue">${esc(x.trigger || 'deposit')}</span></td></tr>`; }).join('')}</table></div>`;
  } catch (e) {
    $('#rf-history').innerHTML = '<div class="empty">Could not load payout history.</div>';
  }
}

/* ══════════ SHARE SETTINGS PAGE (admin-editable sharing link + message) ══════════ */
async function renderShareSettings() {
  const el = $('#page-share');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try {
    const d = await db.collection('appContent').doc('share').get();
    cfg = d.exists ? d.data() : {};
  } catch (e) {}
  const defaultMsg = `Join me on GodX — save small amounts, earn real interest! 💜\n\n🎁 Use my referral code {code} at signup and we BOTH get ₹{referredAmount}!\n\nDownload now:`;
  const c = {
    shareLink: cfg.shareLink || 'https://godx.app',
    shareMessage: cfg.shareMessage || defaultMsg,
    platforms: cfg.platforms || { whatsapp: true, instagram: true, telegram: true, facebook: true, twitter: true, sms: true, email: true, copy: true }
  };
  const plats = [
    ['whatsapp','WhatsApp','#25D366'], ['instagram','Instagram','#E1306C'],
    ['telegram','Telegram','#0088CC'], ['facebook','Facebook','#1877F2'],
    ['twitter','X / Twitter','#0F172A'], ['sms','SMS','#16A34A'],
    ['email','Email','#2563EB'], ['copy','Copy Link','#64748B']
  ];
  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--green)">
      <div class="tbl-head"><h3>📱 Share Settings</h3></div>
      <div style="padding:12px 18px" class="muted">
        Control the link and message shown when users tap <b>Share</b> in the app.
        Available placeholders you can put anywhere in the message:
        <b>{code}</b>, <b>{link}</b>, <b>{name}</b>,
        <b>{referrerAmount}</b>, <b>{referredAmount}</b>.
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Sharing Link & Message</h3></div>
      <div style="padding:18px">
        <div class="frow"><span>Sharing Link (the URL sent along with the message)</span>
          <input class="field-in" id="sh-link" value="${esc(c.shareLink)}" placeholder="https://godx.app"></div>
        <div class="frow"><span>Sharing Message Template</span>
          <textarea class="field-in" id="sh-msg" style="min-height:150px;white-space:pre-wrap">${esc(c.shareMessage)}</textarea></div>

        <div class="frow"><span>Enabled Sharing Platforms</span>
          <div style="display:flex;flex-wrap:wrap;gap:10px;padding:6px 0">
            ${plats.map(([k,name,color]) => `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #E2E8F0;border-radius:12px;cursor:pointer;background:#fff">
              <input type="checkbox" data-plat="${k}" ${c.platforms[k] !== false ? 'checked' : ''}>
              <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color}"></span>
              <span style="font-weight:600">${name}</span></label>`).join('')}
          </div></div>

        <button class="btn btn-primary" id="sh-save">Save Sharing Settings</button>
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Live Preview</h3></div>
      <div style="padding:18px">
        <div style="padding:14px;border-radius:14px;background:#F8FAFC;border:1px solid #E2E8F0">
          <p id="sh-preview-msg" style="white-space:pre-line;margin:0 0 8px;color:#0F172A;font-weight:500"></p>
          <a id="sh-preview-link" href="#" target="_blank" style="color:var(--p1);word-break:break-all;font-size:.85rem"></a>
        </div>
      </div>
    </div>`;

  const drawPreview = () => {
    const link = $('#sh-link').value.trim();
    const rawMsg = $('#sh-msg').value;
    const preview = rawMsg
      .replace(/\{code\}/g, 'GODXABCDE')
      .replace(/\{link\}/g, link)
      .replace(/\{referrerAmount\}/g, '25')
      .replace(/\{referredAmount\}/g, '25')
      .replace(/\{name\}/g, 'Rahul');
    $('#sh-preview-msg').textContent = preview;
    const a = $('#sh-preview-link');
    a.textContent = link;
    a.href = link;
  };
  $('#sh-link').oninput = drawPreview;
  $('#sh-msg').oninput = drawPreview;
  drawPreview();

  $('#sh-save').onclick = async () => {
    const platforms = {};
    $$('[data-plat]').forEach(cb => platforms[cb.dataset.plat] = cb.checked);
    const data = {
      shareLink: $('#sh-link').value.trim(),
      shareMessage: $('#sh-msg').value,
      platforms,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!data.shareLink) return toast('Sharing link cannot be empty', 'err');
    if (!/^https?:\/\//i.test(data.shareLink)) return toast('Link must start with https:// or http://', 'err');
    if (!data.shareMessage.trim()) return toast('Sharing message cannot be empty', 'err');
    try {
      await db.collection('appContent').doc('share').set(data, { merge: true });
      toast('Sharing settings saved — live in user app instantly', 'ok');
    } catch (e) { toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
  };
}

/* ══════════ WALLET LIMITS PAGE (admin-editable min deposit / withdraw + plan cancel toggle) ══════════
   Lives in appContent/walletLimits — the user app reads it (cached 30s)
   before every deposit / withdrawal / plan-cancel, so changes go live
   for users almost instantly with no redeploy. */
async function loadWalletLimits() {
  try {
    const d = await db.collection('appContent').doc('walletLimits').get();
    const c = d.exists ? d.data() : {};
    return {
      minDeposit: Number(c.minDeposit ?? 50),
      minWithdraw: Number(c.minWithdraw ?? 100),
      allowCancel: c.allowCancel !== false
    };
  } catch (e) { return { minDeposit: 50, minWithdraw: 100, allowCancel: true }; }
}

async function renderWalletLimits() {
  const el = $('#page-limits');
  el.innerHTML = '<div class="spinner"></div>';
  const c = await loadWalletLimits();
  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1);max-width:640px">
      <div class="tbl-head"><h3>💰 Wallet Limits</h3></div>
      <div style="padding:16px 18px">
        <p class="muted" style="margin-bottom:14px">These limits apply <b>live in the user app</b> — every deposit and
        withdrawal sheet validates against them, and the plan-cancel button appears only while enabled.</p>
        <div class="frow"><span>Minimum deposit amount (₹)</span>
          <input class="field-in" id="wl-dep" type="number" min="0" step="10" value="${c.minDeposit}"></div>
        <div class="frow"><span>Minimum withdrawal amount (₹)</span>
          <input class="field-in" id="wl-wd" type="number" min="0" step="10" value="${c.minWithdraw}"></div>
        <div class="frow"><span>Allow users to cancel an active plan (principal refunded to wallet,<br>interest already paid stays theirs)</span>
          <label style="display:flex;align-items:center;gap:8px;font-weight:700">
            <input type="checkbox" id="wl-cancel" ${c.allowCancel ? 'checked' : ''} style="width:18px;height:18px"> Enabled</label></div>
        <div style="height:14px"></div>
        <button class="btn btn-primary" id="wl-save">Save Wallet Limits</button>
      </div>
    </div>`;
  $('#wl-save').onclick = async () => {
    const minDeposit = Math.max(0, Number($('#wl-dep').value) || 0);
    const minWithdraw = Math.max(0, Number($('#wl-wd').value) || 0);
    const allowCancel = $('#wl-cancel').checked;
    if (!Number.isFinite(minDeposit) || !Number.isFinite(minWithdraw))
      return toast('Enter valid amounts', 'err');
    const btn = $('#wl-save');
    btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('appContent').doc('walletLimits').set({
        minDeposit, minWithdraw, allowCancel,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      toast('Wallet limits saved — live in user app instantly', 'ok');
      renderWalletLimits();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Save failed — try again', 'err');
    }
  };
}

/* ══════════ CONFIRM ══════════ */
function confirmSheet(msg, onYes) {
  const m = openModal(`<h3>Are you sure?</h3><p class="msub">${esc(msg)}</p>
    <div style="display:flex;gap:10px"><button class="btn btn-red" id="cf-y" style="flex:1">Yes, do it</button>
    <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  m.querySelector('#cf-y').onclick = async () => { closeModal(); await onYes(); };
}

/* ══════════ SUPPORT CHATS — reply live, end, delete (wipes all data) ══════════ */
let chatMsgUnsub = null, chatDocUnsub = null, chatListUnsub = null;
function detachChatListeners() {
  if (chatMsgUnsub) { chatMsgUnsub(); chatMsgUnsub = null; }
  if (chatDocUnsub) { chatDocUnsub(); chatDocUnsub = null; }
  if (chatListUnsub) { chatListUnsub(); chatListUnsub = null; }
}

async function renderChats() {
  detachChatListeners();
  const el = $('#page-chats');
  el.innerHTML = '<div class="spinner"></div>';
  // LIVE list — new chats & messages appear without refreshing
  chatListUnsub = db.collection('supportChats').onSnapshot(snap => {
    const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.lastAt?.seconds || b.createdAt?.seconds || 0) - (a.lastAt?.seconds || a.createdAt?.seconds || 0));
    if (!chats.length) {
      el.innerHTML = '<div class="tbl-card"><div class="empty">No support chats yet — when a user taps "Contact Support" in the app, it appears here in real time.</div></div>';
      return;
    }
    el.innerHTML = `<div class="tbl-card"><div class="tbl-head"><h3>Support Chats (${chats.length})</h3>
      <span class="muted">Tap a chat to reply · End closes it · Delete wipes every message, image & file</span></div>
      <div class="chat-rows">${chats.map(c => `
        <div class="chat-row" data-open="${c.id}">
          <div class="cr-avatar">${esc((c.userName || 'U')[0].toUpperCase())}</div>
          <div class="cr-mid"><b>${esc(c.userName || 'User')}</b>
            <small>${c.userTyping && c.status === 'open' ? '<span class="cr-typing">typing…</span>' : (c.lastKind === 'image' ? '📷 Photo' : c.lastKind === 'file' ? '📎 ' + esc(c.lastText || 'File') : esc(c.lastText || 'Chat started'))} · ${esc(c.userEmail || '')}</small></div>
          <div class="cr-right"><time>${c.lastAt ? fdate(c.lastAt) : ''}</time>
            <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
              <span class="chip ${c.status === 'open' ? 'chip-green' : 'chip-red'}">${c.status}</span>
              ${c.adminUnread ? `<span class="cr-dot">${c.adminUnread > 9 ? '9+' : c.adminUnread}</span>` : ''}
            </div></div>
        </div>`).join('')}</div></div>`;
    el.querySelectorAll('.chat-row').forEach(r => r.onclick = () => openChatAdmin(r.dataset.open));
  }, () => { el.innerHTML = '<div class="tbl-card"><div class="empty">Could not load chats — check connection.</div></div>'; });
}

async function openChatAdmin(cid) {
  detachChatListeners();
  const el = $('#page-chats');
  const d0 = await db.collection('supportChats').doc(cid).get();
  if (!d0.exists) { toast('Chat not found — it may have been deleted', 'err'); return renderChats(); }
  const c0 = d0.data();
  db.collection('supportChats').doc(cid).update({ adminUnread: 0 }).catch(() => {});

  el.innerHTML = `
    <div class="tbl-card" style="padding:0;overflow:hidden">
      <div class="achat-head">
        <button class="btn btn-soft btn-sm" id="ac-back">‹ Back</button>
        <div class="cr-avatar">${esc((c0.userName || 'U')[0].toUpperCase())}</div>
        <div class="cr-mid"><b>${esc(c0.userName || 'User')}</b>
          <small>${esc(c0.userEmail || '')} · started ${fdate(c0.createdAt)}</small></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto">
          <button class="btn btn-soft btn-sm" id="ac-end">End Chat</button>
          <button class="btn btn-red btn-sm" id="ac-del">Delete Chat</button>
        </div>
      </div>
      <div class="achat-msgs" id="ac-msgs"><div class="spinner"></div></div>
      <div class="achat-closed hidden" id="ac-closed">This chat is ended — the user sees it as closed and can start a new one. Delete the thread to free storage.</div>
      <div class="achat-compose" id="ac-compose" style="flex-direction:column;align-items:stretch">
        <div class="ac-quick" id="ac-quick"></div>
        <div style="display:flex;gap:9px">
          <input type="file" id="ac-file" hidden>
          <button class="btn btn-soft" id="ac-attach" title="Attach an image" style="padding:11px 13px">📎</button>
          <input class="field-in" id="ac-text" placeholder="Reply to ${esc((c0.userName || 'user').split(' ')[0])}…" autocomplete="off" maxlength="800">
          <button class="btn btn-primary" id="ac-send">Send</button>
        </div>
      </div>
    </div>`;

  const chatRef = db.collection('supportChats').doc(cid);
  $('#ac-back').onclick = () => { chatRef.update({ adminTyping: false }).catch(() => {}); detachChatListeners(); renderChats(); };

  /* ── user-typing indicator (live) ── */
  let userTyping = false;
  const syncUserTyping = () => {
    const box = $('#ac-msgs');
    if (!box || box.querySelector('.spinner')) return;
    const existing = box.querySelector('#ac-typing');
    if (userTyping && !existing) {
      box.insertAdjacentHTML('beforeend',
        `<div class="chat-msg theirs typing" id="ac-typing"><i></i><i></i><i></i></div>`);
      box.scrollTop = box.scrollHeight;
    } else if (!userTyping && existing) existing.remove();
  };

  /* live chat doc — closed state + unread reset + user typing */
  chatDocUnsub = chatRef.onSnapshot(s => {
    if (!s.exists) { toast('Chat deleted'); detachChatListeners(); renderChats(); return; }
    const closed = s.data().status !== 'open';
    $('#ac-compose').classList.toggle('hidden', closed);
    $('#ac-closed').classList.toggle('hidden', !closed);
    userTyping = !closed && !!s.data().userTyping;
    syncUserTyping();
    if ((s.data().adminUnread || 0) > 0)
      chatRef.update({ adminUnread: 0 }).catch(() => {});
  });

  /* ── canned quick answers — one tap sends the full reply ── */
  const AC_QUICK = [
    ['Add Money', 'To add money: tap Add Money on Home or Wallet (min ₹50), pay to the official UPI/bank shown, then submit your UTR + payment screenshot. Your wallet is credited after verification — usually under 30 minutes.'],
    ['Interest', 'Your daily interest is credited automatically every 24 hours from the exact time you joined the plan. Missed days catch up in one credit when you open the app.'],
    ['Withdraw', 'Withdrawals need a saved bank account or UPI (Wallet → My Bank Account), min ₹100. Requests are reviewed for security and paid within 24 hours.'],
    ['Deposit status', 'Please share your UTR / reference number here and we will verify your deposit right away.'],
    ['Greeting', 'Hi! Thanks for reaching out to GodX Support. Please describe your issue (screenshots welcome) and we will sort it out for you right away.']
  ];
  const quickBox = $('#ac-quick');
  if (quickBox) {
    quickBox.innerHTML = AC_QUICK.map((q, i) => `<button type="button" data-acq="${i}">${esc(q[0])}</button>`).join('');
    quickBox.querySelectorAll('[data-acq]').forEach(b => b.onclick = () => {
      chatRef.update({ adminTyping: false }).catch(() => {});
      sendPayload({ kind: 'text', text: AC_QUICK[Number(b.dataset.acq)][1] });
    });
  }

  /* ── broadcast adminTyping to the user app (debounced, auto-clears) ── */
  let _aTyping = false, _aTypingClear = null;
  const pingAdminTyping = (on, force) => {
    if (!force && on === _aTyping) return;
    _aTyping = on;
    chatRef.update({ adminTyping: on }).catch(() => {});
    if (_aTypingClear) { clearTimeout(_aTypingClear); _aTypingClear = null; }
    if (on) _aTypingClear = setTimeout(() => pingAdminTyping(false, true), 3500);
  };

  /* messages — live, deduped */
  chatMsgUnsub = db.collection('supportChats').doc(cid).collection('messages').limit(300).onSnapshot(snap => {
    const box = $('#ac-msgs'); if (!box) return;
    const seen = new Set();
    const msgs = snap.docs.filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
      .map(d => d.data())
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0) || (a.createdAt?.nanoseconds || 0) - (b.createdAt?.nanoseconds || 0));
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90 || userTyping;
    box.innerHTML = msgs.length ? msgs.map(m => {
      /* autoReply messages are user-written (security rules require sender:'user')
         but are pre-written SUPPORT bot messages — render them on the admin side */
      const mine = m.sender === 'admin' || m.autoReply;
      let body = '';
      if (m.kind === 'image' && m.fileData)
        body += `<img class="chat-img" src="${m.fileData}" alt="Shared image" onclick="this.classList.toggle('zoom')">`;
      else if (m.kind === 'file' && m.fileData)
        body += `<a class="chat-file" href="${m.fileData}" download="${esc(m.fileName || 'file')}">📎 <span>${esc(m.fileName || 'Attachment')}</span> <small>${Math.round((m.fileSize || 0) / 1024)} KB</small></a>`;
      if (m.text) body += esc(m.text);
      const pending = !m.createdAt;
      return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}${pending ? ' pending' : ''}">${body}
        <span class="chat-time">${m.autoReply ? 'Auto-reply 🤖' : mine ? 'You · Support' : esc(c0.userName || 'User')} · ${pending ? 'sending…' : ftimeA(m.createdAt)}</span></div>`;
    }).join('') : '<div class="empty" style="padding:26px">No messages yet — say hello!</div>';
    syncUserTyping(); // keep the typing bubble pinned to the tail
    if (atBottom) box.scrollTop = box.scrollHeight;
  }, () => {
    const box = $('#ac-msgs');
    if (box) box.innerHTML = '<div class="empty" style="padding:26px">Could not load messages — check connection.</div>';
  });

  const sendPayload = async payload => {
    try {
      const batch = db.batch();
      batch.set(db.collection('supportChats').doc(cid).collection('messages').doc(), {
        sender: 'admin', createdAt: firebase.firestore.FieldValue.serverTimestamp(), ...payload });
      batch.update(db.collection('supportChats').doc(cid), {
        lastText: payload.text || payload.fileName || (payload.kind === 'image' ? '📷 Photo' : '📎 File'),
        lastKind: payload.kind || 'text',
        lastAt: firebase.firestore.FieldValue.serverTimestamp(),
        adminTyping: false,
        userUnread: firebase.firestore.FieldValue.increment(1) });
      await batch.commit();
      return true;
    } catch (e) { toast('Reply failed — try again', 'err'); return false; }
  };
  let _acInFlight = false;
  const sendReply = async () => {
    if (_acInFlight) return; // double-click / Enter-spam guard
    const inp = $('#ac-text');
    const t = inp.value.trim();
    if (!t) return;
    _acInFlight = true;
    pingAdminTyping(false, true);
    const ok = await sendPayload({ kind: 'text', text: t });
    _acInFlight = false;
    if (ok) inp.value = ''; // keep the draft if the write failed
    inp.focus();
  };
  $('#ac-send').onclick = sendReply;
  $('#ac-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } });
  $('#ac-text').addEventListener('input', e => pingAdminTyping(!!e.target.value.trim()));

  /* admin can now attach images too */
  $('#ac-attach').onclick = () => $('#ac-file').click();
  $('#ac-file').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Admins can attach images only', 'err');
    try {
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => {
          const img = new Image();
          img.onload = () => {
            const k = Math.min(1, 800 / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            res(c.toDataURL('image/jpeg', .7));
          };
          img.onerror = rej; img.src = r.result;
        };
        r.onerror = rej; r.readAsDataURL(f);
      });
      if (data.length > 700000) return toast('Image too large — crop it smaller and retry', 'err');
      await sendPayload({ kind: 'image', fileData: data, fileName: f.name, fileSize: f.size, mime: 'image/jpeg' });
    } catch (err) { toast('Could not attach — try again', 'err'); }
  };

  $('#ac-end').onclick = () => confirmSheet('End this chat? The user will instantly see it as closed and can start a new one. Messages stay saved until you delete the chat.', async () => {
    try {
      await db.collection('supportChats').doc(cid).update({
        status: 'closed', endedAt: firebase.firestore.FieldValue.serverTimestamp() });
      toast('Chat ended — user notified in real time', 'ok');
    } catch (e) { toast('Could not end chat — try again', 'err'); }
  });

  $('#ac-del').onclick = () => confirmSheet('DELETE this entire chat? Every message, image and file in it will be permanently wiped to free storage. This cannot be undone.', async () => {
    try {
      const msgs = await db.collection('supportChats').doc(cid).collection('messages').get();
      const CH = 400; // batch limit is 500 ops
      for (let i = 0; i < msgs.docs.length; i += CH) {
        const b = db.batch();
        msgs.docs.slice(i, i + CH).forEach(m => b.delete(m.ref));
        await b.commit();
      }
      await db.collection('supportChats').doc(cid).delete();
      detachChatListeners();
      toast('Chat deleted — all messages, images & files wiped ✓', 'ok');
      renderChats();
    } catch (e) { toast('Delete failed — try again', 'err'); }
  });
}
