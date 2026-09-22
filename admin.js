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
                   popup: 'Popup Message', chats: 'Support Chats', content: 'App Content',
                   chart: 'Home Chart',
                   referral: 'Refer & Earn Settings', share: 'Share Settings',
                   limits: 'Wallet Limits',
                   register: 'Register Bonus', login: 'Login Bonus' };
  $('#page-title').textContent = titles[p] || p;
  ({ dashboard: renderDashboard, requests: renderRequests, payouts: renderPayouts, interest: renderInterest,
     history: renderHistory, payments: renderPayments, users: renderUsers,
     plans: renderPlans, announce: renderAnnounce, popup: renderPopup, chats: renderChats, content: renderContent,
     chart: renderChartSettings,
     referral: renderReferralSettings, share: renderShareSettings,
     limits: renderWalletLimits,
     register: renderRegisterBonus, login: renderLoginBonus })[p]();
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
    // FIX: include 'bonus' (register + daily-login bonuses) — they were invisible
    // in the dashboard totals even though users received them.
    if (t.type === 'cashback' || t.type === 'interest' || t.type === 'bonus') interestPaidOut += t.amount || 0;
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
        <div class="sc-sub">Daily credits + rewards + bonuses</div></div>
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
          totalDeposits: firebase.firestore.FieldValue.increment(t.amount),
          /* v31: mark that this user has had at least one verified deposit — useful
             for legacy "first deposit" logic and analytics */
          firstDepositAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (t.type === 'withdraw') tx.update(uref, {
          totalWithdrawn: firebase.firestore.FieldValue.increment(t.amount) });
      } else {
        tx.update(ref, { status: 'rejected', decidedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (t.type === 'withdraw') // refund held balance
          tx.update(uref, { balance: firebase.firestore.FieldValue.increment(t.amount) });
      }
    });
    /* v31: post-approval — pay 2-level team commissions on every approved deposit.
       L1 (direct referrer) earns level1Pct% of the deposit; L2 (referrer's referrer)
       earns level2Pct%. Idempotent via referralCommissions/refc_<depositId>_l1/l2. */
    if (approve) {
      try {
        const tSnap = await db.collection('transactions').doc(id).get();
        const t = tSnap.data();
        if (t.type === 'deposit') {
          referralPayout = await payDepositCommissions(id, t.uid, t.amount);
        }
      } catch (e) { console.warn('team commission payout skipped:', e); }
    }
    let msg = approve ? 'Request approved ✓' : 'Request rejected & refunded';
    if (referralPayout && referralPayout.paid) {
      const parts = [];
      if (referralPayout.l1) parts.push(`L1 ₹${referralPayout.l1.amount} → ${referralPayout.l1.name || 'referrer'}`);
      if (referralPayout.l2) parts.push(`L2 ₹${referralPayout.l2.amount} → ${referralPayout.l2.name || 'upline'}`);
      if (parts.length) msg += ' · Team commissions: ' + parts.join(', ');
    }
    toast(msg, approve ? 'ok' : '');
  } catch (e) {
    if (e === 'already') toast('Already processed by another admin — no duplicate credit', '');
    else toast('Action failed — ' + (e && e.message ? e.message : 'try again'), 'err');
  } finally {
    _decideInFlight[id] = false;
  }
  renderRequests();
}

/* ══════════ v31 — 2-LEVEL TEAM COMMISSION ENGINE ══════════
   Runs the moment a deposit is approved. Pays:
     • L1 (the depositor's direct referrer)   — level1Pct% of the deposit
     • L2 (that referrer's own referrer)      — level2Pct% of the deposit
   Each payout is guarded by a deterministic doc id
     referralCommissions/refc_<depositId>_l1   (and _l2)
   so the same deposit can never pay a commission twice — across concurrent
   admins, retries or double-clicks. Legacy one-off referralPaid lock is left
   in place for compatibility but is no longer consulted.

   loadReferralConfig()  —  fetches the admin-configured commission rates. */
async function loadReferralConfig() {
  try {
    const d = await db.collection('appContent').doc('referral').get();
    const c = d.exists ? d.data() : {};
    return {
      level1Pct: Math.min(50, Math.max(0, Number(c.level1Pct ?? 10))),
      level2Pct: Math.min(50, Math.max(0, Number(c.level2Pct ?? 5))),
      minDeposit: Number(c.minDeposit ?? 0),
      enabled: c.enabled !== false
    };
  } catch (e) { return { level1Pct: 10, level2Pct: 5, minDeposit: 0, enabled: true }; }
}

/* Look up a user's DIRECT referrer (the person whose referralCode == referredBy) */
async function findReferrerOf(uid) {
  try {
    const uSnap = await db.collection('users').doc(uid).get();
    if (!uSnap.exists) return null;
    const code = (uSnap.data().referredBy || '').toString().trim().toUpperCase();
    if (!code) return null;
    const q = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (q.empty) return null;
    const doc = q.docs[0];
    if (doc.id === uid) return null; // block self-referral loops
    return { uid: doc.id, name: doc.data().name || '', code };
  } catch (e) { return null; }
}

async function payDepositCommissions(depositId, depositorUid, depositAmount) {
  const cfg = await loadReferralConfig();
  if (!cfg.enabled) return { paid: false, reason: 'disabled' };
  const amt = Number(depositAmount || 0);
  if (amt <= 0) return { paid: false, reason: 'zero' };
  if (cfg.minDeposit > 0 && amt < cfg.minDeposit) return { paid: false, reason: 'below-min' };

  const l1 = await findReferrerOf(depositorUid);
  if (!l1) return { paid: false, reason: 'no-l1' };
  const l2 = await findReferrerOf(l1.uid); // may be null — L2 is optional

  const depositorSnap = await db.collection('users').doc(depositorUid).get();
  const depositorName = depositorSnap.exists ? (depositorSnap.data().name || '') : '';

  const round2 = n => Math.round(Number(n || 0) * 100) / 100;
  const l1Amt = round2(amt * cfg.level1Pct / 100);
  const l2Amt = l2 ? round2(amt * cfg.level2Pct / 100) : 0;
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const out = { paid: false };

  /* ── L1 payout ─────────────────────────────────────────────────────── */
  if (l1Amt > 0) {
    const lockRef = db.collection('referralCommissions').doc('refc_' + depositId + '_l1');
    try {
      await db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        if (lock.exists) throw 'already-l1';
        tx.set(lockRef, {
          referrerUid: l1.uid, sourceUid: depositorUid, level: 1,
          amount: l1Amt, pct: cfg.level1Pct, depositId, depositAmount: amt,
          referrerName: l1.name, sourceName: depositorName, createdAt: now
        });
        tx.update(db.collection('users').doc(l1.uid), {
          balance: firebase.firestore.FieldValue.increment(l1Amt),
          totalCashback: firebase.firestore.FieldValue.increment(l1Amt)
        });
        tx.set(db.collection('transactions').doc(), {
          uid: l1.uid, type: 'bonus', amount: l1Amt, status: 'completed',
          note: `Team 1 commission (${cfg.level1Pct}%) — ${depositorName || 'friend'} deposited ${'₹' + amt.toLocaleString('en-IN')}`,
          userName: l1.name, refDepositId: depositId, refLevel: 1,
          createdAt: now
        });
      });
      out.paid = true; out.l1 = { uid: l1.uid, amount: l1Amt, name: l1.name };
    } catch (e) { if (e !== 'already-l1') console.warn('L1 commission failed:', e); }
  }

  /* ── L2 payout ─────────────────────────────────────────────────────── */
  if (l2 && l2Amt > 0) {
    const lockRef = db.collection('referralCommissions').doc('refc_' + depositId + '_l2');
    try {
      await db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        if (lock.exists) throw 'already-l2';
        tx.set(lockRef, {
          referrerUid: l2.uid, sourceUid: depositorUid, level: 2,
          amount: l2Amt, pct: cfg.level2Pct, depositId, depositAmount: amt,
          referrerName: l2.name, sourceName: depositorName,
          viaUid: l1.uid, viaName: l1.name, createdAt: now
        });
        tx.update(db.collection('users').doc(l2.uid), {
          balance: firebase.firestore.FieldValue.increment(l2Amt),
          totalCashback: firebase.firestore.FieldValue.increment(l2Amt)
        });
        tx.set(db.collection('transactions').doc(), {
          uid: l2.uid, type: 'bonus', amount: l2Amt, status: 'completed',
          note: `Team 2 commission (${cfg.level2Pct}%) — ${depositorName || 'user'} (via ${l1.name || 'friend'}) deposited ${'₹' + amt.toLocaleString('en-IN')}`,
          userName: l2.name, refDepositId: depositId, refLevel: 2,
          createdAt: now
        });
      });
      out.paid = true; out.l2 = { uid: l2.uid, amount: l2Amt, name: l2.name };
    } catch (e) { if (e !== 'already-l2') console.warn('L2 commission failed:', e); }
  }
  return out;
}

/* Legacy stub — first-plan flat-bonus flow is removed in v31; team commissions
   are paid per-deposit only. Kept as a no-op so callsites don't crash. */
async function maybePayReferral(){ return { paid:false, reason:'legacy-disabled' }; }
async function _legacy_maybePayReferral_unused() {
  return { paid: false };
}

async function _legacy_maybePayReferral_body(referredUid, eventAmount, eventType) {
  const cfg = { enabled:false, referrerAmount:0, referredAmount:0, trigger:'deposit', minDeposit:0 };
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
    /* v31: plan settlement pays NO flat referral bonus (system removed).
       Team commissions are paid per-deposit at approval time instead. */
    let msg = `Released funds to ${uname || 'user'} ✓`;
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
        <option value="cashback">Cashback</option><option value="bonus">Bonuses</option><option value="refund">Refunds</option></select>
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
  renderPlanBanner(); // full-width banner slot above the plan list (planBanners/plans)
  const snap = await db.collection('plans').orderBy('minAmount').get();
  const grid = $('#p-grid'); grid.innerHTML = '';
  if (snap.empty) { grid.innerHTML = '<div class="tbl-card"><div class="empty">No plans yet — create one or seed demo plans.</div></div>'; return; }
  snap.forEach(d => {
    const p = d.data();
    const c = document.createElement('div');
    c.className = 'ap-card';
    c.innerHTML = `
      ${p.image ? `<img class="ap-banner" src="${esc(p.image)}" alt="${esc(p.name)} banner" loading="lazy">` : ''}
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

/* Read + downscale an image file to a JPEG data-URL (max 1280px, ~0.78 quality)
   so a plan banner fits comfortably inside a Firestore doc (< 1 MB). */
function readImageDataUrl(file, maxSide = 1280, quality = 0.78) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = rej; img.src = r.result;
    };
    r.onerror = rej; r.readAsDataURL(file);
  });
}

function planEditor(p) {
  const isNew = !p;
  p = p || { name: '', tagline: '', minAmount: 300, cashbackPct: 5, durationDays: 30, popular: false, active: true, perks: [], rewardType: 'interest', image: '' };
  const rt = p.rewardType || 'interest';
  const m = openModal(`
    <h3>${isNew ? 'Create Plan' : 'Edit Plan'}</h3>
    <p class="msub">Reward % is the TOTAL across the duration — it accrues daily (total ÷ days) and lands in the user's wallet every 24h from activation. Choose whether users see this reward labelled as <b>Interest</b> or <b>Returns</b>.</p>
    <div class="frow"><span>Plan Name</span><input class="field-in" id="pf-name" value="${esc(p.name)}" placeholder="Starter Saver"></div>
    <div class="frow"><span>Tagline</span><input class="field-in" id="pf-tag" value="${esc(p.tagline)}" placeholder="Perfect for beginners"></div>
    <div class="frow"><span>Banner image (optional — shown on top of the plan card in the user app)</span>
      <div class="pf-img-wrap" id="pf-img-wrap">
        <img class="pf-img-preview ${p.image ? '' : 'hidden'}" id="pf-img-preview" src="${esc(p.image || '')}" alt="Banner preview">
        <input type="file" id="pf-img-file" accept="image/*" hidden>
        <div class="pf-img-row">
          <button type="button" class="btn btn-soft btn-sm" id="pf-img-pick">📷 Upload image</button>
          <button type="button" class="btn btn-red btn-sm ${p.image ? '' : 'hidden'}" id="pf-img-remove">Remove</button>
        </div>
        <input class="field-in" id="pf-img" value="${esc(p.image || '')}" placeholder="…or paste an https:// image URL">
        <span class="mini">Uploaded images are compressed to JPEG (max 1280px) and stored with the plan — no extra hosting needed.</span>
      </div></div>
    <div class="frow"><span>Reward label shown to users</span>
      <select class="field-in" id="pf-rtype">
        <option value="interest" ${rt === 'interest' ? 'selected' : ''}>Interest (Daily Interest)</option>
        <option value="returns" ${rt === 'returns' ? 'selected' : ''}>Returns (Daily Returns)</option>
      </select></div>
    <div class="frow2">
      <div class="frow"><span>Min Amount (₹)</span><input class="field-in" id="pf-min" type="number" value="${p.minAmount}"></div>
      <div class="frow"><span>Total Reward %</span><input class="field-in" id="pf-cb" type="number" step="0.5" value="${p.cashbackPct}"></div>
    </div>
    <div class="frow"><span>Duration (days)</span><input class="field-in" id="pf-days" type="number" value="${p.durationDays}"></div>
    <div class="frow"><span>Perks (one per line)</span><textarea class="field-in" id="pf-perks">${esc((p.perks || []).join('\n'))}</textarea></div>
    <div class="frow" style="flex-direction:row;align-items:center;gap:10px">
      <input type="checkbox" id="pf-pop" ${p.popular ? 'checked' : ''}> <span style="font-size:.82rem">Show "POPULAR" ribbon</span></div>
    <div style="display:flex;gap:10px;margin-top:6px">
      <button class="btn btn-primary" id="pf-save" style="flex:1">${isNew ? 'Create' : 'Save'}</button>
      <button class="btn btn-soft" onclick="closeModal()" style="flex:1">Cancel</button></div>`);
  /* ── banner image: file upload → data-URL, or a pasted https URL — with live preview ── */
  const imgInp = m.querySelector('#pf-img'), imgPrev = m.querySelector('#pf-img-preview');
  const imgFile = m.querySelector('#pf-img-file');
  const imgRemove = m.querySelector('#pf-img-remove');
  const syncImgPrev = () => {
    const v = imgInp.value.trim();
    imgPrev.src = v; imgPrev.classList.toggle('hidden', !v);
    imgRemove.classList.toggle('hidden', !v);
  };
  m.querySelector('#pf-img-pick').onclick = () => imgFile.click();
  imgFile.onchange = async () => {
    const f = imgFile.files && imgFile.files[0];
    imgFile.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Choose an image file (jpg / png / webp)', 'err');
    try {
      const data = await readImageDataUrl(f, 1280, 0.78);
      if (data.length > 820000) return toast('Image too large even after compression — pick a smaller one', 'err');
      imgInp.value = data; syncImgPrev();
      toast('Banner attached ✓', 'ok');
    } catch (e) { toast('Could not read that image — try another', 'err'); }
  };
  imgInp.oninput = syncImgPrev;
  imgRemove.onclick = () => { imgInp.value = ''; syncImgPrev(); };

  m.querySelector('#pf-save').onclick = async () => {
    const img = imgInp.value.trim();
    if (img && !img.startsWith('data:image/') && !/^https?:\/\//i.test(img))
      return toast('Banner must be an uploaded image or an https:// URL', 'err');
    if (img.length > 900000) return toast('Banner image is too large — upload it instead of pasting', 'err');
    const data = {
      name: m.querySelector('#pf-name').value.trim(),
      tagline: m.querySelector('#pf-tag').value.trim(),
      image: img,
      minAmount: Number(m.querySelector('#pf-min').value),
      cashbackPct: Number(m.querySelector('#pf-cb').value),
      durationDays: Number(m.querySelector('#pf-days').value),
      rewardType: m.querySelector('#pf-rtype').value === 'returns' ? 'returns' : 'interest',
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
    { name: 'Starter Saver', tagline: 'Begin your savings habit', minAmount: 300, cashbackPct: 3, durationDays: 30, popular: false, active: true, image: '',
      perks: ['3% total interest, credited daily', 'Withdraw anytime after 30 days', 'Full transaction receipts'] },
    { name: 'Smart Saver', tagline: 'For consistent savers', minAmount: 1000, cashbackPct: 5, durationDays: 60, popular: true, active: true, image: '',
      perks: ['5% total interest, credited daily', 'Priority withdrawal processing', 'Free savings insights report'] },
    { name: 'Champion Saver', tagline: 'Maximum rewards', minAmount: 3000, cashbackPct: 7, durationDays: 90, popular: false, active: true, image: '',
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

/* ══════════ PLANS BANNER — one full-width image above the plan list ══════════
   Lives in planBanners/plans. Kept in its own collection because a full-width
   banner can be up to ~800 KB — too big to sit inside a plans doc, and the
   user app only reads this one extra doc on the Plans tab. */
async function renderPlanBanner() {
  const el = $('#page-plans');
  const wrap = document.createElement('div');
  wrap.id = 'pb-wrap';
  el.insertBefore(wrap, el.children[1] || null);
  wrap.innerHTML = '<div class="tbl-card"><div class="tbl-head"><h3>🖼️ Plans Page Banner</h3><span class="muted">Loading…</span></div></div>';
  let cfg = {};
  try {
    const d = await db.collection('planBanners').doc('plans').get();
    cfg = d.exists ? d.data() : {};
  } catch (e) {}
  const c = { enabled: cfg.enabled === true, image: cfg.image || '' };
  wrap.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--gold)">
      <div class="tbl-head"><h3>🖼️ Plans Page Banner</h3>
        <span class="chip ${c.enabled && c.image ? 'chip-green' : 'chip-red'}">${c.enabled && c.image ? 'Live in user app' : 'Hidden'}</span></div>
      <div style="padding:16px 18px">
        <p class="muted" style="margin-bottom:12px">One full-width banner shown <b>above the plan list</b> in the user app.
        Upload a wide image (≈1600×500 works best) — it's compressed to JPEG and updates live for every user. Turn it off anytime.</p>
        <img class="pb-preview ${c.image ? '' : 'hidden'}" id="pb-preview" src="${esc(c.image)}" alt="Plans banner preview">
        <input type="file" id="pb-file" accept="image/*" hidden>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
          <button class="btn btn-soft btn-sm" id="pb-pick">📷 Upload banner</button>
          <button class="btn btn-red btn-sm ${c.image ? '' : 'hidden'}" id="pb-remove">Remove image</button>
        </div>
        <div class="frow"><span>…or paste an https:// image URL</span>
          <input class="field-in" id="pb-url" value="${c.image.startsWith('data:') ? '' : esc(c.image)}" placeholder="https://…"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
          <button class="btn btn-primary" id="pb-publish" style="flex:1;min-width:160px" ${c.image ? '' : 'disabled'}>Publish Banner</button>
          <button class="btn btn-red" id="pb-hide" style="flex:1;min-width:120px" ${c.enabled ? '' : 'disabled'}>Hide from users</button>
        </div>
        <div class="muted" style="margin-top:10px" id="pb-status">${cfg.updatedAt ? 'Last updated ' + fdate(cfg.updatedAt) : 'Not set yet — upload an image and publish.'}</div>
      </div>
    </div>`;

  let pending = c.image; // the image waiting to be published
  const prev = $('#pb-preview'), urlInp = $('#pb-url');
  const syncPrev = () => {
    prev.src = pending; prev.classList.toggle('hidden', !pending);
    $('#pb-remove').classList.toggle('hidden', !pending);
    $('#pb-publish').disabled = !pending;
  };
  $('#pb-pick').onclick = () => $('#pb-file').click();
  $('#pb-file').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Choose an image file (jpg / png / webp)', 'err');
    try {
      const data = await readImageDataUrl(f, 1600, 0.78);
      if (data.length > 820000) return toast('Banner too large even after compression — pick a smaller / wider image', 'err');
      pending = data; urlInp.value = ''; syncPrev();
      toast('Banner ready — tap Publish to make it live', 'ok');
    } catch (err) { toast('Could not read that image — try another', 'err'); }
  };
  urlInp.oninput = () => { pending = urlInp.value.trim(); syncPrev(); };
  $('#pb-remove').onclick = () => { pending = ''; urlInp.value = ''; syncPrev(); };

  $('#pb-publish').onclick = async () => {
    const v = (pending || '').trim();
    if (!v) return toast('Add an image first', 'err');
    if (!v.startsWith('data:image/') && !/^https?:\/\//i.test(v))
      return toast('Banner must be an uploaded image or an https:// URL', 'err');
    if (v.length > 900000) return toast('Banner image is too large — upload it instead of pasting', 'err');
    const btn = $('#pb-publish'); btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('planBanners').doc('plans').set({
        image: v, enabled: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      toast('Banner published — live on the Plans tab now! 🖼️', 'ok');
      renderPlans();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Publish failed — ' + (e && e.message ? e.message : 'try again'), 'err');
    }
  };
  $('#pb-hide').onclick = async () => {
    try {
      await db.collection('planBanners').doc('plans').set({ enabled: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
      toast('Banner hidden — users no longer see it', 'ok');
      renderPlans();
    } catch (e) { toast('Hide failed — try again', 'err'); }
  };
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

/* ══════════ POPUP MESSAGE (welcome modal in the user app) ══════════
   Stored in appContent/popup — the user app listens live, so saving here
   instantly shows / hides / edits the popup for every user. */
async function renderPopup() {
  const el = $('#page-popup');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try {
    const d = await db.collection('appContent').doc('popup').get();
    cfg = d.exists ? d.data() : {};
  } catch (e) {}
  const c = {
    enabled: cfg.enabled === true,
    title: cfg.title || '',
    body: cfg.body || '',
    icon: cfg.icon || '',
    showOn: cfg.showOn || 'once',
    pbLabel: (cfg.primaryBtn && cfg.primaryBtn.label) || '',
    pbAction: (cfg.primaryBtn && cfg.primaryBtn.action) || 'close',
    primaryUrl: cfg.primaryUrl || '',
    sbLabel: (cfg.secondaryBtn && cfg.secondaryBtn.label) || ''
  };
  const actions = [
    ['close', 'Just close the popup'],
    ['plans', 'Open Plans tab'],
    ['wallet', 'Open Wallet tab'],
    ['deposit', 'Open Wallet → Add Money'],
    ['support', 'Open Support chat'],
    ['refer', 'Open Refer & Earn share sheet'],
    ['url', 'Open a custom link (URL below)']
  ];
  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>🪟 Welcome Popup — user app</h3>
        <span class="chip ${c.enabled ? 'chip-green' : 'chip-red'}">${c.enabled ? 'Visible to users' : 'Hidden'}</span></div>
      <div style="padding:12px 18px" class="muted">
        This message pops up when users open the user app. Toggle it <b>off</b> to hide it for everyone instantly,
        edit any field and save to update it live — users who dismissed an older version will see the new one.
      </div>
    </div>

    <div class="pop-grid">
      <div class="tbl-card"><div class="tbl-head"><h3>Popup Content</h3></div>
        <div style="padding:18px">
          <div class="frow" style="flex-direction:row;align-items:center;justify-content:space-between;gap:12px">
            <span style="font-size:.85rem;font-weight:700;color:var(--ink)">Show popup in the user app</span>
            <label class="gxswitch"><input type="checkbox" id="pp-enabled" ${c.enabled ? 'checked' : ''}><i></i></label></div>
          <div class="frow2">
            <div class="frow"><span>Icon (one emoji — optional)</span>
              <input class="field-in" id="pp-icon" value="${esc(c.icon)}" maxlength="4" placeholder="🎉"></div>
            <div class="frow"><span>Show popup</span>
              <select class="field-in" id="pp-showon">
                <option value="once" ${c.showOn === 'once' ? 'selected' : ''}>Once per message version</option>
                <option value="every" ${c.showOn === 'every' ? 'selected' : ''}>Every time the app opens</option>
              </select></div>
          </div>
          <div class="frow"><span>Title</span>
            <input class="field-in" id="pp-title" value="${esc(c.title)}" placeholder="🎉 Weekend interest boost!"></div>
          <div class="frow"><span>Message</span>
            <textarea class="field-in" id="pp-body" style="min-height:110px;white-space:pre-wrap" placeholder="Write a short, friendly message…">${esc(c.body)}</textarea></div>

          <div class="tbl-head" style="margin:6px -18px 0;padding:14px 18px;border-top:1px solid #EEF0F7"><h3 style="font-size:.9rem">Primary Button</h3></div>
          <div class="frow2" style="margin-top:14px">
            <div class="frow"><span>Button label (empty = no button)</span>
              <input class="field-in" id="pp-pb-label" value="${esc(c.pbLabel)}" placeholder="Explore Plans"></div>
            <div class="frow"><span>Button action</span>
              <select class="field-in" id="pp-pb-action">
                ${actions.map(([v, t]) => `<option value="${v}" ${c.pbAction === v ? 'selected' : ''}>${t}</option>`).join('')}
              </select></div>
          </div>
          <div class="frow" id="pp-url-row" style="display:${c.pbAction === 'url' ? '' : 'none'}"><span>Button link (https://…)</span>
            <input class="field-in" id="pp-url" value="${esc(c.primaryUrl)}" placeholder="https://godx.app/offer"></div>

          <div class="frow"><span>Secondary button label (optional — always just closes)</span>
            <input class="field-in" id="pp-sb-label" value="${esc(c.sbLabel)}" placeholder="Maybe later"></div>

          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
            <button class="btn btn-primary" id="pp-save" style="flex:1;min-width:150px">Save & Publish</button>
            <button class="btn ${c.enabled ? 'btn-red' : 'btn-green'}" id="pp-toggle" style="flex:1;min-width:150px">${c.enabled ? 'Hide from users now' : 'Show to users now'}</button>
          </div>
        </div>
      </div>

      <div class="tbl-card"><div class="tbl-head"><h3>Live Preview</h3></div>
        <div style="padding:22px 18px;display:flex;justify-content:center;background:radial-gradient(420px 200px at 50% -60px,rgba(124,58,237,.10),transparent 70%)">
          <div class="ppv-card">
            <div class="ppv-ic" id="ppv-ic">✨</div>
            <div class="ppv-title" id="ppv-title">Popup title</div>
            <p class="ppv-body" id="ppv-body">Popup message preview…</p>
            <div class="ppv-btns">
              <span class="ppv-btn ppv-primary" id="ppv-pb" style="display:none"></span>
              <span class="ppv-btn ppv-soft" id="ppv-sb" style="display:none"></span>
            </div>
          </div>
        </div>
        <div style="padding:0 18px 16px" class="muted" id="pp-status-line">${cfg.updatedAt ? 'Last updated ' + fdate(cfg.updatedAt) : 'Not configured yet — saving creates it.'}</div>
      </div>
    </div>`;

  /* live preview */
  const drawPreview = () => {
    $('#ppv-ic').textContent = $('#pp-icon').value.trim() || '✨';
    $('#ppv-title').textContent = $('#pp-title').value.trim() || 'Popup title';
    $('#ppv-body').textContent = $('#pp-body').value.trim() || 'Popup message preview…';
    const pl = $('#pp-pb-label').value.trim(), sl = $('#pp-sb-label').value.trim();
    const pb = $('#ppv-pb'), sb = $('#ppv-sb');
    pb.style.display = pl ? '' : 'none'; pb.textContent = pl;
    sb.style.display = sl ? '' : 'none'; sb.textContent = sl;
  };
  ['pp-icon','pp-title','pp-body','pp-pb-label','pp-sb-label'].forEach(id => { $('#' + id).oninput = drawPreview; });
  $('#pp-pb-action').onchange = () => {
    $('#pp-url-row').style.display = $('#pp-pb-action').value === 'url' ? '' : 'none';
  };
  drawPreview();

  const collect = () => {
    const data = {
      enabled: $('#pp-enabled').checked,
      icon: $('#pp-icon').value.trim(),
      showOn: $('#pp-showon').value,
      title: $('#pp-title').value.trim(),
      body: $('#pp-body').value.trim(),
      primaryBtn: null, secondaryBtn: null, primaryUrl: '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const pl = $('#pp-pb-label').value.trim();
    if (pl) data.primaryBtn = { label: pl, action: $('#pp-pb-action').value };
    if (pl && data.primaryBtn.action === 'url') data.primaryUrl = $('#pp-url').value.trim();
    const sl = $('#pp-sb-label').value.trim();
    if (sl) data.secondaryBtn = { label: sl };
    return data;
  };

  const save = async btn => {
    const data = collect();
    if (data.enabled && !data.title && !data.body)
      return toast('Add a title or message — or turn the popup off', 'err');
    if (data.primaryBtn && data.primaryBtn.action === 'url' && !/^https?:\/\//i.test(data.primaryUrl))
      return toast('Button link must start with https://', 'err');
    btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('appContent').doc('popup').set(data, { merge: true });
      toast(data.enabled ? 'Popup published — showing in the user app now!' : 'Popup hidden — users will no longer see it', 'ok');
      renderPopup();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err');
    }
  };
  $('#pp-save').onclick = () => save($('#pp-save'));
  $('#pp-toggle').onclick = () => {
    $('#pp-enabled').checked = !$('#pp-enabled').checked;
    save($('#pp-toggle'));
  };
}

/* ══════════ HOME CHART (growth graph on the user app Home tab) ══════════
   Stored in appContent/chart — the user app listens live, so saving here
   instantly re-draws the "growth outlook" graph for every user. */
async function renderChartSettings() {
  const el = $('#page-chart');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try {
    const d = await db.collection('appContent').doc('chart').get();
    cfg = d.exists ? d.data() : {};
  } catch (e) {}
  const c = {
    enabled: cfg.enabled !== false,
    title: cfg.title || '1-Year Growth Outlook',
    subtitle: cfg.subtitle || '',
    principal: Number(cfg.principal) || 10000,
    months: Number(cfg.months) || 12,
    godxRate: cfg.godxRate != null ? Number(cfg.godxRate) : 24,
    otherRate: cfg.otherRate != null ? Number(cfg.otherRate) : 6.5,
    legendGodx: cfg.legendGodx || 'GodX · daily interest',
    legendOther: cfg.legendOther || 'Other platforms · FD avg',
    note: cfg.note || ''
  };
  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>📈 Home Chart — growth graph shown to users</h3>
        <span class="chip ${c.enabled ? 'chip-green' : 'chip-red'}">${c.enabled ? 'Visible to users' : 'Hidden'}</span></div>
      <div style="padding:12px 18px" class="muted">
        This is the <b>"outcome of investment"</b> graph on the user app's Home tab — it compares what the same
        deposit becomes with GodX vs other platforms. Edit any number or label and save — every user's
        chart re-draws live. Toggle it <b>off</b> to hide the whole card instantly.
      </div>
    </div>

    <div class="pop-grid">
      <div class="tbl-card"><div class="tbl-head"><h3>Chart Settings</h3></div>
        <div style="padding:18px">
          <div class="frow" style="flex-direction:row;align-items:center;justify-content:space-between;gap:12px">
            <span style="font-size:.85rem;font-weight:700;color:var(--ink)">Show chart on the Home tab</span>
            <label class="gxswitch"><input type="checkbox" id="ch-enabled" ${c.enabled ? 'checked' : ''}><i></i></label></div>
          <div class="frow2">
            <div class="frow"><span>Card title</span>
              <input class="field-in" id="ch-title" value="${esc(c.title)}" placeholder="1-Year Growth Outlook"></div>
            <div class="frow"><span>Subtitle (empty = auto)</span>
              <input class="field-in" id="ch-subtitle" value="${esc(c.subtitle)}" placeholder="Same ₹10,000 — very different outcome"></div>
          </div>
          <div class="frow2">
            <div class="frow"><span>Deposit amount shown (₹)</span>
              <input class="field-in" id="ch-principal" type="number" min="100" step="100" value="${c.principal}"></div>
            <div class="frow"><span>Duration (months)</span>
              <input class="field-in" id="ch-months" type="number" min="1" max="120" step="1" value="${c.months}"></div>
          </div>
          <div class="frow2">
            <div class="frow"><span>GodX return (% per year)</span>
              <input class="field-in" id="ch-godx" type="number" min="0" max="100" step="0.1" value="${c.godxRate}"></div>
            <div class="frow"><span>Other platforms (% per year)</span>
              <input class="field-in" id="ch-other" type="number" min="0" max="100" step="0.1" value="${c.otherRate}"></div>
          </div>
          <div class="frow2">
            <div class="frow"><span>Legend — GodX line</span>
              <input class="field-in" id="ch-lg-godx" value="${esc(c.legendGodx)}"></div>
            <div class="frow"><span>Legend — other line</span>
              <input class="field-in" id="ch-lg-other" value="${esc(c.legendOther)}"></div>
          </div>
          <div class="frow"><span>Footnote (empty = auto)</span>
            <textarea class="field-in" id="ch-note" style="min-height:70px" placeholder="Illustrative projection…">${esc(c.note)}</textarea></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
            <button class="btn btn-primary" id="ch-save" style="flex:1;min-width:150px">Save &amp; Publish</button>
            <button class="btn ${c.enabled ? 'btn-red' : 'btn-green'}" id="ch-toggle" style="flex:1;min-width:150px">${c.enabled ? 'Hide from users now' : 'Show to users now'}</button>
          </div>
        </div>
      </div>

      <div class="tbl-card"><div class="tbl-head"><h3>Live Preview</h3></div>
        <div style="padding:22px 18px">
          <div class="ppv-card" style="text-align:left">
            <div class="ppv-title" id="chv-title" style="font-size:1rem"></div>
            <p class="ppv-body" id="chv-sub" style="min-height:0"></p>
            <div id="chv-win" style="margin-top:10px;border-radius:12px;padding:10px 12px;background:#ECFDF5;border:1px solid #A7F3D0;font-size:.78rem;font-weight:600;color:#065F46;line-height:1.5"></div>
            <p class="ppv-body" id="chv-note" style="margin-top:10px;font-size:.62rem;color:#94A3B8"></p>
          </div>
        </div>
        <div style="padding:0 18px 16px" class="muted">${cfg.updatedAt ? 'Last updated ' + fdate(cfg.updatedAt) : 'Not configured yet — defaults (₹10,000 · 12 months · 24% vs 6.5%) are used until you save.'}</div>
      </div>
    </div>`;

  const inr0 = v => '₹' + Math.round(v).toLocaleString('en-IN');
  const drawPreview = () => {
    const P = Math.max(100, Number($('#ch-principal').value) || 10000);
    const M = Math.min(120, Math.max(1, Math.round(Number($('#ch-months').value) || 12)));
    const g = Math.min(100, Math.max(0, Number($('#ch-godx').value) || 0));
    const o = Math.min(100, Math.max(0, Number($('#ch-other').value) || 0));
    const endG = P * Math.pow(1 + g / 100 / 365, 365);   // daily-compounded over the full duration
    const endO = P * (1 + o / 100);                       // simple accrual over the full duration
    const per = M % 12 === 0 ? (M / 12) + (M === 12 ? ' year' : ' years') : M + ' months';
    $('#chv-title').textContent = $('#ch-title').value.trim() || 'Growth Outlook';
    $('#chv-sub').textContent = $('#ch-subtitle').value.trim() || ('Same ' + inr0(P) + ' — very different outcome');
    $('#chv-win').innerHTML = inr0(P) + ' becomes <b>' + inr0(endG) + '</b> with GodX — <b>+' + inr0(endG - endO) + '</b> more than other platforms in ' + per;
    $('#chv-note').textContent = $('#ch-note').value.trim() ||
      ('Illustrative projection over ' + M + ' months: GodX plan at ' + g + '%/yr, credited & compounded daily, vs ~' + o + '% p.a. typical FD / savings average.');
  };
  ['ch-title', 'ch-subtitle', 'ch-principal', 'ch-months', 'ch-godx', 'ch-other', 'ch-note']
    .forEach(id => { $('#' + id).oninput = drawPreview; });
  drawPreview();

  const collect = () => ({
    enabled: $('#ch-enabled').checked,
    title: $('#ch-title').value.trim(),
    subtitle: $('#ch-subtitle').value.trim(),
    principal: Math.max(100, Number($('#ch-principal').value) || 10000),
    months: Math.min(120, Math.max(1, Math.round(Number($('#ch-months').value) || 12))),
    godxRate: Math.min(100, Math.max(0, Number($('#ch-godx').value) || 0)),
    otherRate: Math.min(100, Math.max(0, Number($('#ch-other').value) || 0)),
    legendGodx: $('#ch-lg-godx').value.trim(),
    legendOther: $('#ch-lg-other').value.trim(),
    note: $('#ch-note').value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  const save = async btn => {
    const data = collect();
    btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('appContent').doc('chart').set(data, { merge: true });
      toast(data.enabled ? 'Chart published — live on every user\'s Home tab!' : 'Chart hidden — users will no longer see it', 'ok');
      renderChartSettings();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err');
    }
  };
  $('#ch-save').onclick = () => save($('#ch-save'));
  $('#ch-toggle').onclick = () => { $('#ch-enabled').checked = !$('#ch-enabled').checked; save($('#ch-toggle')); };
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
    level1Pct: cfg.level1Pct ?? 10,
    level2Pct: cfg.level2Pct ?? 5,
    minDeposit: cfg.minDeposit ?? 0,
    title: cfg.title || 'Refer & Earn',
    description: cfg.description || 'Invite friends — earn a % of every deposit your team makes!',
    enabled: cfg.enabled !== false
  };

  // count paid team commissions
  let commCount = 0, commPaid = 0;
  try {
    const s = await db.collection('referralCommissions').get();
    commCount = s.size;
    s.forEach(d => commPaid += Number(d.data().amount || 0));
  } catch (e) {}

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>🎁 Refer & Earn — Team Commissions</h3>
        <span class="chip ${c.enabled ? 'chip-green' : 'chip-red'}">${c.enabled ? 'ENABLED' : 'DISABLED'}</span></div>
      <div style="padding:12px 18px" class="muted">
        Two-level team commission system. Every time a user's deposit is <b>approved</b>,
        their direct referrer earns <b>Level 1%</b> of the deposit and that referrer's own
        referrer earns <b>Level 2%</b>. Payouts are idempotent (guarded by
        <code>referralCommissions/refc_&lt;depositId&gt;_l1|l2</code>) — the same deposit can
        never pay a commission twice, even under concurrent admin actions.
      </div>
      <div style="padding:0 18px 6px;display:flex;gap:12px;flex-wrap:wrap">
        <div class="sc" style="flex:1;min-width:180px"><small>Total Commissions Paid</small><b>${commCount}</b>
          <div class="sc-sub">Total amount: ${inr(commPaid)}</div></div>
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Configure Commission Rates</h3></div>
      <div style="padding:18px">
        <div class="frow" style="flex-direction:row;align-items:center;gap:10px">
          <input type="checkbox" id="rf-enabled" ${c.enabled ? 'checked' : ''}>
          <span><b>Enable team commission program</b> — uncheck to pause all new commission payouts</span>
        </div>
        <div class="frow2">
          <div class="frow"><span>Level 1 rate (%) — % of a deposit paid to the depositor's DIRECT referrer</span>
            <input class="field-in" id="rf-l1" type="number" min="0" max="50" step="0.5" value="${c.level1Pct}"></div>
          <div class="frow"><span>Level 2 rate (%) — % of a deposit paid to the referrer's own referrer</span>
            <input class="field-in" id="rf-l2" type="number" min="0" max="50" step="0.5" value="${c.level2Pct}"></div>
        </div>
        <div class="frow"><span>Minimum qualifying deposit (₹) — deposits below this pay 0 commission. 0 = no minimum.</span>
          <input class="field-in" id="rf-min" type="number" min="0" step="10" value="${c.minDeposit}"></div>
        <div class="frow"><span>Title (shown in user app)</span>
          <input class="field-in" id="rf-title" value="${esc(c.title)}" placeholder="Refer & Earn"></div>
        <div class="frow"><span>Description (shown in user app)</span>
          <textarea class="field-in" id="rf-desc">${esc(c.description)}</textarea></div>
        <button class="btn btn-primary" id="rf-save">Save Settings</button>
      </div>
    </div>

    <div class="tbl-card"><div class="tbl-head"><h3>Recent Team Commission Payouts</h3></div>
      <div id="rf-history"><div class="spinner"></div></div>
    </div>`;

  $('#rf-save').onclick = async () => {
    const l1 = Number($('#rf-l1').value);
    const l2 = Number($('#rf-l2').value);
    if (!(l1 >= 0) || !(l2 >= 0)) return toast('Rates must be zero or positive', 'err');
    if (l1 > 50 || l2 > 50) return toast('Rates capped at 50% each', 'err');
    const data = {
      level1Pct: l1, level2Pct: l2,
      minDeposit: Number($('#rf-min').value) || 0,
      title: $('#rf-title').value.trim() || 'Refer & Earn',
      description: $('#rf-desc').value.trim(),
      enabled: $('#rf-enabled').checked,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      await db.collection('appContent').doc('referral').set(data, { merge: true });
      toast('Team commission settings saved — live in user app instantly', 'ok');
      renderReferralSettings();
    } catch (e) { toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err'); }
  };

  try {
    const s = await db.collection('referralCommissions').orderBy('createdAt', 'desc').limit(50).get();
    const box = $('#rf-history');
    if (!s.size) { box.innerHTML = '<div class="empty">No team commissions paid yet — they will appear here the moment a deposit from a referred user is approved.</div>'; return; }
    box.innerHTML = `<div class="tbl-scroll"><table><tr><th>When</th><th>Level</th><th>Earner</th><th>From (deposit)</th><th>Deposit</th><th>Rate</th><th>Commission</th></tr>
      ${s.docs.map(d => { const x = d.data(); return `<tr>
        <td>${fdate(x.createdAt)}</td>
        <td><span class="chip ${x.level === 1 ? 'chip-green' : 'chip-blue'}">L${x.level}</span></td>
        <td><b>${esc(x.referrerName || x.referrerUid.slice(0,8))}</b></td>
        <td>${esc(x.sourceName || x.sourceUid.slice(0,8))}${x.viaName ? ' <small class="muted">via ' + esc(x.viaName) + '</small>' : ''}</td>
        <td>${inr(x.depositAmount || 0)}</td>
        <td>${(x.pct || 0)}%</td>
        <td><b style="color:var(--green)">${inr(x.amount)}</b></td></tr>`; }).join('')}</table></div>`;
  } catch (e) {
    $('#rf-history').innerHTML = '<div class="empty">Could not load commission history.</div>';
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
  const defaultMsg = `Join me on GodX — save small amounts, earn real interest! 💜\n\n💸 Sign up with my link — the code fills in automatically — and start earning daily interest today!\n\nMy invite link:`;
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
        <b>{level1Pct}</b>, <b>{level2Pct}</b>.
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
    const previewLink = link ? link.split('?')[0] + '?ref=GODXABCDE' : '';
    const preview = rawMsg
      .replace(/\{code\}/g, 'GODXABCDE')
      .replace(/\{link\}/g, previewLink)
      .replace(/\{level1Pct\}/g, '10')
      .replace(/\{level2Pct\}/g, '5')
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

/* ══════════ REGISTER BONUS (admin-editable) ══════════
   Stored in appContent/registerBonus — { enabled, amount, note }.
   The user app credits it ONCE at signup, guarded by users.registerBonusGiven
   inside a Firestore transaction — retries / double-taps can never pay twice. */
async function renderRegisterBonus() {
  const el = $('#page-register');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try { const d = await db.collection('appContent').doc('registerBonus').get(); cfg = d.exists ? d.data() : {}; } catch (e) {}
  const c = {
    enabled: cfg.enabled === true,
    amount: Number(cfg.amount ?? 0),
    note: cfg.note || 'Registration bonus — welcome to GodX! 🎉'
  };
  let givenCount = 0, givenTotal = 0;
  try {
    const s = await db.collection('users').where('registerBonusGiven', '==', true).get();
    givenCount = s.size;
  } catch (e) {}
  try {
    const s2 = await db.collection('transactions').where('type', '==', 'bonus').get();
    s2.forEach(d => { const t = d.data(); if ((t.note || '').toLowerCase().includes('registration')) givenTotal += t.amount || 0; });
  } catch (e) {}

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>🎁 Register Bonus</h3>
        <span class="chip ${c.enabled && c.amount > 0 ? 'chip-green' : 'chip-red'}">${c.enabled && c.amount > 0 ? 'LIVE — ' + inr(c.amount) + ' on every signup' : 'OFF'}</span></div>
      <div style="padding:12px 18px" class="muted">
        Every new user instantly receives this amount in their wallet the moment they create an account.
        It is credited <b>exactly once per account</b> (transaction-guarded — retries can never pay twice)
        and appears in their transaction history as a <b>bonus</b> receipt. Turn it off anytime — users who
        already received it keep it.</div>
      <div style="padding:0 18px 6px;display:flex;gap:12px;flex-wrap:wrap">
        <div class="sc" style="flex:1;min-width:180px"><small>Bonuses Given</small><b>${givenCount}</b>
          <div class="sc-sub">Total credited: ${inr(givenTotal)}</div></div>
      </div>
    </div>

    <div class="tbl-card" style="max-width:640px"><div class="tbl-head"><h3>Configure Bonus</h3></div>
      <div style="padding:18px">
        <div class="frow" style="flex-direction:row;align-items:center;justify-content:space-between;gap:12px">
          <span style="font-size:.85rem;font-weight:700;color:var(--ink)">Give every new user a register bonus</span>
          <label class="gxswitch"><input type="checkbox" id="rb-enabled" ${c.enabled ? 'checked' : ''}><i></i></label></div>
        <div class="frow"><span>Bonus amount (₹) — credited to the wallet on signup</span>
          <input class="field-in" id="rb-amount" type="number" min="0" step="1" value="${c.amount}" placeholder="e.g. 51"></div>
        <div class="frow"><span>Receipt note (shown in the user's transaction history)</span>
          <input class="field-in" id="rb-note" value="${esc(c.note)}"></div>
        <button class="btn btn-primary" id="rb-save">Save Register Bonus</button>
      </div></div>`;

  $('#rb-save').onclick = async () => {
    const data = {
      enabled: $('#rb-enabled').checked,
      amount: Math.max(0, Number($('#rb-amount').value) || 0),
      note: $('#rb-note').value.trim() || 'Registration bonus — welcome to GodX! 🎉',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (data.enabled && !(data.amount > 0)) return toast('Enter a bonus amount — or turn the bonus off', 'err');
    if (data.amount > 100000) return toast('Amount looks unreasonably large', 'err');
    const btn = $('#rb-save');
    btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('appContent').doc('registerBonus').set(data, { merge: true });
      toast(data.enabled ? 'Register bonus live — every new signup gets ' + inr(data.amount) + ' 🎁' : 'Register bonus turned off', 'ok');
      renderRegisterBonus();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err');
    }
  };
}

/* ══════════ DAILY LOGIN BONUS (admin-editable, e.g. 7-day cycle) ══════════
   Stored in appContent/loginBonus — { enabled, days, amounts[], title, subtitle }.
   The user app claims one reward per day (server-time validated, lock-guarded by
   loginPaid/<uid>_<date>); missing a day restarts the streak at Day 1 and
   completing the cycle starts a fresh one. */
async function renderLoginBonus() {
  const el = $('#page-login');
  el.innerHTML = '<div class="spinner"></div>';
  let cfg = {};
  try { const d = await db.collection('appContent').doc('loginBonus').get(); cfg = d.exists ? d.data() : {}; } catch (e) {}
  const c = {
    enabled: cfg.enabled === true,
    days: Math.min(30, Math.max(1, Number(cfg.days) || 7)),
    amounts: Array.isArray(cfg.amounts) ? cfg.amounts.map(x => Number(x) || 0) : [],
    title: cfg.title || 'Daily Login Bonus 🎁',
    subtitle: cfg.subtitle || 'Open the app every day and collect your reward!'
  };
  while (c.amounts.length < c.days) c.amounts.push(10);
  c.amounts = c.amounts.slice(0, c.days);

  let claimCount = 0, claimTotal = 0;
  try {
    const s = await db.collection('loginPaid').get();
    claimCount = s.size;
    s.forEach(d => claimTotal += d.data().amount || 0);
  } catch (e) {}
  const totalOf = arr => arr.reduce((a, b) => a + (Number(b) || 0), 0);

  el.innerHTML = `
    <div class="tbl-card" style="border-left:4px solid var(--p1)">
      <div class="tbl-head"><h3>🗓️ Daily Login Bonus</h3>
        <span class="chip ${c.enabled ? 'chip-green' : 'chip-red'}">${c.enabled ? 'LIVE — ' + c.days + '-day cycle' : 'OFF'}</span></div>
      <div style="padding:12px 18px" class="muted">
        Users collect a reward for opening the app on consecutive days — a classic <b>7-day login bonus</b>.
        Missing a day restarts their streak at Day 1; finishing the cycle starts a fresh one. Every claim is
        validated against server time and lock-guarded — <b>one reward per user per day, impossible to double-claim</b>.</div>
      <div style="padding:0 18px 6px;display:flex;gap:12px;flex-wrap:wrap">
        <div class="sc" style="flex:1;min-width:180px"><small>Claims So Far</small><b>${claimCount}</b>
          <div class="sc-sub">Total credited: ${inr(claimTotal)}</div></div>
      </div>
    </div>

    <div class="tbl-card" style="max-width:640px"><div class="tbl-head"><h3>Configure Rewards</h3></div>
      <div style="padding:18px">
        <div class="frow" style="flex-direction:row;align-items:center;justify-content:space-between;gap:12px">
          <span style="font-size:.85rem;font-weight:700;color:var(--ink)">Enable daily login bonus</span>
          <label class="gxswitch"><input type="checkbox" id="lb-enabled" ${c.enabled ? 'checked' : ''}><i></i></label></div>
        <div class="frow2">
          <div class="frow"><span>Cycle length (days) — e.g. 7</span>
            <input class="field-in" id="lb-days" type="number" min="1" max="30" step="1" value="${c.days}"></div>
          <div class="frow"><span>Full-cycle total</span>
            <input class="field-in" id="lb-totalview" value="${inr(totalOf(c.amounts))}" disabled></div>
        </div>
        <div class="frow"><span>Popup title (user app)</span>
          <input class="field-in" id="lb-title" value="${esc(c.title)}"></div>
        <div class="frow"><span>Popup subtitle (user app)</span>
          <input class="field-in" id="lb-subtitle" value="${esc(c.subtitle)}"></div>
        <div id="lb-days-grid"></div>
        <button class="btn btn-primary" id="lb-save" style="margin-top:6px">Save Login Bonus</button>
      </div></div>`;

  const syncDaysGrid = () => {
    $('#lb-days-grid').innerHTML = c.amounts.map((a, i) =>
      `<div class="frow"><span>Day ${i + 1} reward (₹)</span>
        <input class="field-in lb-amt" data-d="${i}" type="number" min="0" step="1" value="${a}"></div>`).join('');
    $$('#lb-days-grid .lb-amt').forEach(inp => inp.oninput = () => {
      c.amounts[Number(inp.dataset.d)] = Math.max(0, Number(inp.value) || 0);
      $('#lb-totalview').value = inr(totalOf(c.amounts));
    });
  };
  $('#lb-days').onchange = () => {
    c.days = Math.min(30, Math.max(1, Number($('#lb-days').value) || 7));
    while (c.amounts.length < c.days) c.amounts.push(10);
    c.amounts = c.amounts.slice(0, c.days);
    syncDaysGrid();
  };
  syncDaysGrid();

  $('#lb-save').onclick = async () => {
    const data = {
      enabled: $('#lb-enabled').checked,
      days: c.days,
      amounts: c.amounts.map(x => Math.max(0, Number(x) || 0)),
      title: $('#lb-title').value.trim() || 'Daily Login Bonus 🎁',
      subtitle: $('#lb-subtitle').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (data.enabled && !data.amounts.some(a => a > 0))
      return toast('Set at least one day reward above ₹0 — or turn the bonus off', 'err');
    if (totalOf(data.amounts) > 100000) return toast('Cycle total looks unreasonably large', 'err');
    const btn = $('#lb-save');
    btn.classList.add('loading'); btn.disabled = true;
    try {
      await db.collection('appContent').doc('loginBonus').set(data, { merge: true });
      toast('Login bonus saved — live in the user app instantly', 'ok');
      renderLoginBonus();
    } catch (e) {
      btn.classList.remove('loading'); btn.disabled = false;
      toast('Save failed — ' + (e && e.message ? e.message : 'try again'), 'err');
    }
  };
}
