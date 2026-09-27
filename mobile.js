/* ═══════════════════════════════════════════════════════════════════
   GODX ADMIN — Mobile App Shell 1.0 (Android-style)
   Loaded AFTER admin.js. Purely additive: injects a top app bar,
   a slide-in navigation drawer controller and a Material-3 bottom
   navigation bar, then keeps them in sync with the existing
   sidebar/page logic by OBSERVING it (no changes to admin.js needed).
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  /* ── SVG icon set (matches sidebar iconography) ── */
  const IC = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    requests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    chats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>'
  };

  /* ── 1. Top app bar ── */
  const top = document.createElement('div');
  top.id = 'm-topbar';
  top.innerHTML =
    '<button id="m-burger" aria-label="Open menu">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>' +
    '</button>' +
    '<div class="m-twrap"><b id="m-title">Dashboard</b><span>GodX Admin Panel</span></div>' +
    '<span class="chip m-chip">Admin</span>';

  /* ── 2. Drawer backdrop ── */
  const bd = document.createElement('div');
  bd.id = 'sb-backdrop';

  /* ── 3. Bottom navigation (key destinations + More → drawer) ── */
  const mnBtn = (p, label, badgeId) =>
    '<button class="mn-item" data-p="' + p + '">' +
      '<span class="mn-ic">' + IC[p] +
        (badgeId ? '<i class="mn-badge" data-mirror="' + badgeId + '"></i>' : '') +
      '</span><span>' + label + '</span></button>';

  const bn = document.createElement('nav');
  bn.id = 'm-bottomnav';
  bn.innerHTML =
    mnBtn('dashboard', 'Home') +
    mnBtn('requests', 'Requests', 'badge-req') +
    mnBtn('chats', 'Chats', 'badge-chat') +
    mnBtn('users', 'Users') +
    '<button class="mn-item" id="mn-more"><span class="mn-ic">' + IC.more +
    '</span><span>More</span></button>';

  document.body.append(top, bd, bn);

  /* ── Drawer open / close ── */
  const openDrawer = () => document.body.classList.add('sb-open');
  const closeDrawer = () => document.body.classList.remove('sb-open');
  $('#m-burger').onclick = openDrawer;
  $('#mn-more').onclick = openDrawer;
  bd.onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  /* tapping any sidebar item navigates (existing handler) then closes the drawer */
  const sidebar = $('#sidebar');
  if (sidebar) sidebar.addEventListener('click', e => {
    if (e.target.closest('.sb-item')) closeDrawer();
  });

  /* bottom-nav taps reuse the existing sidebar buttons → all logic untouched */
  bn.addEventListener('click', e => {
    const b = e.target.closest('.mn-item[data-p]');
    if (!b) return;
    const target = document.querySelector('.sb-item[data-p="' + b.dataset.p + '"]');
    if (target) target.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ── Edge-swipe gestures (Android feel) ── */
  let sx = null;
  window.addEventListener('touchstart', e => {
    if (e.touches[0].clientX < 28 && !document.body.classList.contains('sb-open')) sx = e.touches[0].clientX;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (sx !== null && e.touches[0].clientX - sx > 70) { openDrawer(); sx = null; }
  }, { passive: true });
  window.addEventListener('touchend', () => { sx = null; }, { passive: true });

  let dx = null;
  if (sidebar) {
    sidebar.addEventListener('touchstart', e => { dx = e.touches[0].clientX; }, { passive: true });
    sidebar.addEventListener('touchmove', e => {
      if (dx !== null && dx - e.touches[0].clientX > 70) { closeDrawer(); dx = null; }
    }, { passive: true });
    sidebar.addEventListener('touchend', () => { dx = null; }, { passive: true });
  }

  /* ── Sync: active page, title, badges (observe, never patch admin.js) ── */
  function syncNav() {
    const act = document.querySelector('#sb-nav .sb-item.active');
    const p = act && act.dataset.p;
    $$('#m-bottomnav .mn-item[data-p]').forEach(x =>
      x.classList.toggle('active', x.dataset.p === p));
    $('#mn-more').classList.toggle('active', !!(p && !bn.querySelector('.mn-item[data-p="' + p + '"]')));
    const t = $('#page-title');
    if (t) $('#m-title').textContent = t.textContent;
  }
  function syncBadges() {
    $$('#m-bottomnav .mn-badge').forEach(m => {
      const src = document.getElementById(m.dataset.mirror);
      const on = src && src.classList.contains('show') && src.textContent.trim();
      m.textContent = on ? src.textContent : '';
      m.classList.toggle('show', !!on);
    });
  }

  const nav = $('#sb-nav');
  if (nav) new MutationObserver(syncNav).observe(nav,
    { subtree: true, attributes: true, attributeFilter: ['class'] });
  const pt = $('#page-title');
  if (pt) new MutationObserver(syncNav).observe(pt,
    { childList: true, characterData: true, subtree: true });
  ['badge-req', 'badge-chat'].forEach(id => {
    const el = document.getElementById(id);
    if (el) new MutationObserver(syncBadges).observe(el,
      { attributes: true, childList: true, characterData: true, subtree: true });
  });
  setInterval(syncBadges, 5000); // safety net for text-only updates
  syncNav(); syncBadges();
})();
