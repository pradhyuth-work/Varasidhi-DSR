// Admin screens for team access: a "Login" column on the buyer table and a "Team access" tab.
// Self-contained. It only talks to /api/portal-accounts (admin only) and never touches
// buyers, balances or any DSR data.
(function () {
  var data = null, loading = false, failed = false, msg = '';
  var modal = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };

  var style = document.createElement('style');
  style.textContent =
    '.pa-chip{display:inline-block;font:600 9px var(--mono);letter-spacing:.12em;padding:3px 7px;border-radius:3px;border:1px solid var(--line-strong);color:var(--ink-muted);margin-right:6px;white-space:nowrap}' +
    '.pa-chip.on{color:var(--teal);border-color:var(--teal)}.pa-chip.off{color:var(--red);border-color:var(--red-soft-border,var(--red))}' +
    '.pa-cell{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.pa-cell .button{white-space:nowrap}' +
    '.pa-checks{display:grid;gap:2px;max-height:210px;overflow-y:auto;border:1px solid var(--line);border-radius:5px;padding:6px 10px;margin-top:6px}' +
    '.pa-checks label{display:flex;gap:10px;align-items:center;padding:6px 0;font-size:13px}.pa-checks label.dis{color:var(--ink-muted)}.pa-checks input{width:auto;margin:0}' +
    '.pa-actions-left{margin-right:auto}.pa-addr{font:12px var(--mono);word-break:break-all}.pa-msg{font-size:13px;color:var(--teal);min-height:18px;margin:6px 0 0}';
  document.head.appendChild(style);

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = res.status; throw e; }
        return d;
      });
    });
  }

  function load() {
    if (loading) return Promise.resolve();
    loading = true;
    return api('/api/portal-accounts').then(function (d) { data = d; failed = false; })
      .catch(function () { failed = true; })
      .then(function () { loading = false; renderCells(); renderPanel(); });
  }
  function buyerName(id) {
    var b = data && data.buyers.filter(function (x) { return x.profile_id === id; })[0];
    return b ? b.name : '#' + id;
  }

  // ---- Login column on the buyer table -----------------------------------
  function renderCells() {
    var cells = document.querySelectorAll('td[data-portal-profile]');
    Array.prototype.forEach.call(cells, function (td) {
      var id = Number(td.getAttribute('data-portal-profile'));
      var b = data && data.buyers.filter(function (x) { return x.profile_id === id; })[0];
      if (!data || !b) { td.innerHTML = '<span class="pa-chip">' + (failed ? 'UNAVAILABLE' : '…') + '</span>'; return; }
      var l = b.login;
      td.innerHTML = '<div class="pa-cell">' + (l
        ? '<span class="pa-chip ' + (l.active ? 'on' : 'off') + '">' + (l.active ? 'ACTIVE' : 'OFF') + '</span>' +
          '<button class="button button-quiet compact-button" type="button" data-pa="buyer-edit" data-pid="' + id + '">Edit</button>' +
          '<button class="button button-quiet compact-button" type="button" data-pa="toggle" data-aid="' + l.id + '" data-active="' + (l.active ? '1' : '0') + '">' + (l.active ? 'Turn off' : 'Turn on') + '</button>'
        : '<span class="pa-chip">NO LOGIN</span>' +
          '<button class="button button-quiet compact-button" type="button" data-pa="buyer-edit" data-pid="' + id + '">Set up</button>') + '</div>';
    });
  }

  // ---- Team access tab ----------------------------------------------------
  function renderPanel() {
    var el = $('team-access-panel');
    if (!el) return;
    var rows = '';
    if (data) rows = data.team_leads.map(function (t) {
      return '<tr><td>' + esc(t.name) + '</td><td class="stock-quiet">' + esc(t.username) + '</td>' +
        '<td>' + (t.profile_ids.length ? esc(t.profile_ids.map(buyerName).join(', ')) : '<span class="stock-quiet">No buyers yet</span>') + '</td>' +
        '<td><span class="pa-chip ' + (t.active ? 'on' : 'off') + '">' + (t.active ? 'ACTIVE' : 'OFF') + '</span></td>' +
        '<td><div class="pa-cell"><button class="button button-quiet compact-button" type="button" data-pa="tl-edit" data-aid="' + t.id + '">Edit</button>' +
        '<button class="button button-quiet compact-button" type="button" data-pa="toggle" data-aid="' + t.id + '" data-active="' + (t.active ? '1' : '0') + '">' + (t.active ? 'Turn off' : 'Turn on') + '</button></div></td></tr>';
    }).join('');
    var buyerLogins = data ? data.buyers.filter(function (b) { return b.login; }).length : 0;
    el.innerHTML =
      '<div class="admin-grid"><div class="admin-card">' +
      '<div class="section-kicker"><span class="section-number">01</span><span>TEAM LEADS</span></div>' +
      '<h2>Team lead logins</h2>' +
      '<p class="card-copy">A team lead signs in to see how many units their buyers sold this month. They cannot see rates, money, balances or settlement, and cannot change anything.</p>' +
      '<button class="button button-primary" type="button" data-pa="tl-new"' + (data ? '' : ' disabled') + '>Add team lead</button>' +
      '<p class="pa-msg" role="status">' + esc(msg) + '</p></div>' +
      '<div class="admin-card notice-card"><span class="notice-icon">◎</span><div><b>Where they sign in</b>' +
      '<p class="pa-addr">' + esc(location.origin) + '/team</p>' +
      '<p>Buyers and team leads both use this page, with their own username and password. Buyer logins are set up in Profile / buyer manager (' + buyerLogins + ' so far).</p></div></div></div>' +
      '<div class="admin-section-heading"><div><div class="section-kicker"><span class="section-number">02</span><span>TEAMS</span></div><h2>Team leads and their buyers</h2></div></div>' +
      '<div class="table-shell"><table class="route-table admin-table"><thead><tr><th>TEAM LEAD</th><th>USERNAME</th><th>BUYERS</th><th>STATUS</th><th></th></tr></thead><tbody>' +
      (data ? (rows || '<tr><td colspan="5">No team leads yet.</td></tr>') : '<tr><td colspan="5">' + (failed ? 'Team access is not available right now.' : 'Loading…') + '</td></tr>') +
      '</tbody></table></div>';
  }

  // ---- Popup --------------------------------------------------------------
  function openModal(html, onSubmit) {
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal-backdrop'; modal.hidden = true;
      modal.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><button class="modal-close" type="button" aria-label="Close" data-pa="close">×</button><div id="pa-body"></div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    }
    $('pa-body').innerHTML = html;
    modal.hidden = false;
    var form = $('pa-form');
    if (form) {
      form.addEventListener('submit', function (e) { e.preventDefault(); onSubmit(form); });
      var first = form.querySelector('input'); if (first) first.focus();
    }
  }
  function closeModal() { if (modal) modal.hidden = true; }
  function fail(text) { var p = $('pa-error'); if (p) { p.textContent = text; p.hidden = false; } }
  function busy(on) { var b = $('pa-save'); if (b) { b.disabled = on; b.textContent = on ? 'Saving…' : 'Save'; } }
  function done(text) { msg = text || ''; closeModal(); return load(); }

  var FIELD_HELP = 'Username: 3 to 30 letters, numbers, dot, dash or underscore. Password: 6 to 30 characters, no spaces, capitals do not matter. Tell the person their password, it cannot be shown again.';

  function buyerModal(pid) {
    var b = data.buyers.filter(function (x) { return x.profile_id === pid; })[0];
    if (!b) return;
    var l = b.login;
    openModal(
      '<div class="section-kicker"><span class="section-number">◎</span><span>BUYER LOGIN</span></div>' +
      '<h2>' + (l ? 'Edit login' : 'Set up login') + '</h2>' +
      '<p class="modal-intro"><strong>' + esc(b.name) + '</strong> · sees only their own units, view only</p>' +
      '<form id="pa-form" autocomplete="off">' +
      '<label class="form-field"><span>Username</span><input name="username" maxlength="30" autocapitalize="none" spellcheck="false" required value="' + esc(l ? l.username : '') + '" /></label>' +
      '<label class="form-field"><span>Password' + (l ? ' <em>Leave blank to keep the current password</em>' : '') + '</span><input name="pin" type="text" maxlength="30" autocapitalize="none" spellcheck="false" ' + (l ? '' : 'required ') + 'placeholder="6 to 30 characters" /></label>' +
      '<p class="card-copy">' + FIELD_HELP + '</p>' +
      '<p class="admin-auth-error" id="pa-error" hidden></p>' +
      '<div class="modal-actions">' + (l ? '<button class="button button-quiet pa-actions-left" type="button" id="pa-remove">Remove login</button>' : '') +
      '<button class="button button-quiet" type="button" data-pa="close">Cancel</button><button class="button button-primary" type="submit" id="pa-save">Save</button></div></form>',
      function (f) {
        busy(true);
        var body = { username: f.username.value.trim() };
        if (f.pin.value) body.pin = f.pin.value;
        api('/api/portal-accounts/buyers/' + pid, { method: 'PUT', body: body })
          .then(function () { return done(''); })
          .catch(function (e) { busy(false); fail(e.message); });
      }
    );
    var rm = $('pa-remove');
    if (rm) rm.addEventListener('click', function () {
      if (rm.getAttribute('data-sure') !== '1') { rm.setAttribute('data-sure', '1'); rm.textContent = 'Tap again to remove'; return; }
      api('/api/portal-accounts/' + l.id, { method: 'DELETE' }).then(function () { return done(''); }).catch(function (e) { fail(e.message); });
    });
  }

  function teamModal(aid) {
    var t = aid ? data.team_leads.filter(function (x) { return x.id === aid; })[0] : null;
    var owner = {};
    data.team_leads.forEach(function (x) { x.profile_ids.forEach(function (p) { owner[p] = x; }); });
    var checks = data.buyers.map(function (b) {
      var o = owner[b.profile_id], mine = t && o && o.id === t.id, other = o && !mine;
      return '<label class="' + (other ? 'dis' : '') + '"><input type="checkbox" name="buyer" value="' + b.profile_id + '"' + (mine ? ' checked' : '') + (other ? ' disabled' : '') + ' />' +
        esc(b.name) + (other ? ' <span class="stock-quiet">in ' + esc(o.name) + '</span>' : '') + '</label>';
    }).join('');
    openModal(
      '<div class="section-kicker"><span class="section-number">◎</span><span>TEAM LEAD</span></div>' +
      '<h2>' + (t ? 'Edit team lead' : 'Add team lead') + '</h2>' +
      '<p class="modal-intro">Sees the units sold by the buyers ticked below, nothing else.</p>' +
      '<form id="pa-form" autocomplete="off">' +
      '<label class="form-field"><span>Name</span><input name="name" maxlength="120" required value="' + esc(t ? t.name : '') + '" /></label>' +
      '<label class="form-field"><span>Username</span><input name="username" maxlength="30" autocapitalize="none" spellcheck="false" required value="' + esc(t ? t.username : '') + '" /></label>' +
      '<label class="form-field"><span>Password' + (t ? ' <em>Leave blank to keep the current password</em>' : '') + '</span><input name="pin" type="text" maxlength="30" autocapitalize="none" spellcheck="false" ' + (t ? '' : 'required ') + 'placeholder="6 to 30 characters" /></label>' +
      '<div class="form-field"><span>Buyers in this team</span><div class="pa-checks">' + (checks || '<span class="stock-quiet">No buyers yet.</span>') + '</div></div>' +
      '<p class="card-copy">' + FIELD_HELP + '</p>' +
      '<p class="admin-auth-error" id="pa-error" hidden></p>' +
      '<div class="modal-actions">' + (t ? '<button class="button button-quiet pa-actions-left" type="button" id="pa-remove">Remove team lead</button>' : '') +
      '<button class="button button-quiet" type="button" data-pa="close">Cancel</button><button class="button button-primary" type="submit" id="pa-save">Save</button></div></form>',
      function (f) {
        busy(true);
        var ids = Array.prototype.map.call(f.querySelectorAll('input[name="buyer"]:checked'), function (c) { return Number(c.value); });
        var body = { name: f.name.value.trim(), username: f.username.value.trim(), profileIds: ids };
        if (f.pin.value) body.pin = f.pin.value;
        var req = t ? api('/api/portal-accounts/team-leads/' + t.id, { method: 'PATCH', body: body })
                    : api('/api/portal-accounts/team-leads', { method: 'POST', body: body });
        req.then(function () { return done(t ? 'Team lead saved.' : 'Team lead added.'); })
           .catch(function (e) { busy(false); fail(e.message); });
      }
    );
    var rm = $('pa-remove');
    if (rm) rm.addEventListener('click', function () {
      if (rm.getAttribute('data-sure') !== '1') { rm.setAttribute('data-sure', '1'); rm.textContent = 'Tap again to remove'; return; }
      api('/api/portal-accounts/' + t.id, { method: 'DELETE' }).then(function () { return done('Team lead removed.'); }).catch(function (e) { fail(e.message); });
    });
  }

  // ---- Wiring -------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('[data-admin-tab="profiles"],[data-admin-tab="team-access"]');
    if (tab) { msg = ''; load(); return; }
    var btn = e.target.closest && e.target.closest('[data-pa]');
    if (!btn) return;
    var act = btn.getAttribute('data-pa');
    if (act === 'close') return closeModal();
    if (!data) return;
    if (act === 'buyer-edit') return buyerModal(Number(btn.getAttribute('data-pid')));
    if (act === 'tl-new') return teamModal(null);
    if (act === 'tl-edit') return teamModal(Number(btn.getAttribute('data-aid')));
    if (act === 'toggle') {
      btn.disabled = true;
      api('/api/portal-accounts/' + btn.getAttribute('data-aid') + '/active', { method: 'PATCH', body: { active: btn.getAttribute('data-active') !== '1' } })
        .then(function () { msg = ''; return load(); }).catch(function () { btn.disabled = false; });
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal && !modal.hidden) closeModal(); });

  // The buyer table is rebuilt by the main app whenever it refreshes; refill our column each time.
  function watch() {
    var body = $('profiles-body');
    if (!body) return;
    new MutationObserver(function () { renderCells(); if (!data && !loading && !failed) load(); }).observe(body, { childList: true });
    renderCells();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();
