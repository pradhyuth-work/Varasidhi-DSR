// Admin screens for team access: a "Login" column on the buyer table and a "Team access" tab.
// Self-contained. It only talks to /api/portal-accounts (admin only) and never touches
// buyers, balances or any DSR data.
(function () {
  var data = null, loading = false, failed = false, msg = '';
  var salMonths = [], salMsg = '';
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
      .then(function () { return api('/api/portal-accounts/salary').then(function (d) { salMonths = d.months || []; }).catch(function () { salMonths = []; }); })
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
      '</tbody></table></div>' + salaryCard();
  }

  // ---- Salary statements --------------------------------------------------
  var XLSX_SRC = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var parsed = null;
  function monthLabel(m) {
    var p = String(m).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }
  function salaryCard() {
    var list = salMonths.map(function (m) {
      return '<tr><td>' + esc(monthLabel(m.month)) + '</td><td>' + m.people + '</td><td>₹' + Number(m.total_net || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + '</td>' +
        '<td><button class="button button-quiet compact-button" type="button" data-pa="sal-del" data-month="' + esc(m.month) + '">Remove month</button></td></tr>';
    }).join('');
    return '<div class="admin-section-heading"><div><div class="section-kicker"><span class="section-number">03</span><span>SALARY</span></div><h2>Salary statements</h2></div></div>' +
      '<div class="admin-card"><p class="card-copy">Upload the monthly salary workbook (the file with a Master sheet and one sheet per person). Each buyer who has a login then sees only their own salary statement on the team page. Nobody else can see it.</p>' +
      '<input id="pa-sal-file" type="file" accept=".xlsx,.xlsm" hidden />' +
      '<button class="button button-primary" type="button" data-pa="sal-pick"' + (data ? '' : ' disabled') + '>Upload salary file</button>' +
      '<p class="pa-msg" role="status">' + esc(salMsg) + '</p></div>' +
      (salMonths.length ? '<div class="table-shell"><table class="route-table admin-table"><thead><tr><th>MONTH</th><th>PEOPLE</th><th>TOTAL NET PAYABLE</th><th></th></tr></thead><tbody>' + list + '</tbody></table></div>' : '');
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.XLSX) return resolve();
      var sc = document.createElement('script');
      sc.src = src; sc.onload = resolve;
      sc.onerror = function () { reject(new Error('Could not load the spreadsheet reader. Check the internet connection and try again.')); };
      document.head.appendChild(sc);
    });
  }
  // Tiny arithmetic reader for cells like =8026+2000 that have no saved result.
  function arith(str) {
    var t = String(str).replace(/\s+/g, ''), i = 0;
    if (!/^[0-9+\-*\/().]+$/.test(t)) return null;
    function expr() { var v = term(); while (t[i] === '+' || t[i] === '-') { var o = t[i++]; var r = term(); v = o === '+' ? v + r : v - r; } return v; }
    function term() { var v = fac(); while (t[i] === '*' || t[i] === '/') { var o = t[i++]; var r = fac(); v = o === '*' ? v * r : v / r; } return v; }
    function fac() {
      if (t[i] === '-') { i++; return -fac(); }
      if (t[i] === '(') { i++; var v = expr(); if (t[i] !== ')') throw new Error('x'); i++; return v; }
      var m = /^[0-9]*\.?[0-9]+/.exec(t.slice(i)); if (!m) throw new Error('x'); i += m[0].length; return Number(m[0]);
    }
    try { var out = expr(); return i === t.length && isFinite(out) ? out : null; } catch (e) { return null; }
  }
  function cellNum(ws, addr) {
    var c = ws[addr];
    if (!c) return 0;
    if (typeof c.v === 'number') return c.v;
    if (c.f) { var v = arith(c.f); if (v !== null) return v; }
    var n = Number(c.v); return isFinite(n) ? n : 0;
  }
  function cellText(ws, addr) { var c = ws[addr]; return c && c.v != null ? String(c.v).trim() : ''; }
  function norm(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function colName(i) { return String.fromCharCode(65 + i); }
  function compute(r) {
    var sale = 0; r.lines.forEach(function (l) { sale += Math.round(l.qty * l.rate * 100) / 100; });
    var earned = sale + r.gpi + r.other + r.empty, tds = Math.round(earned) / 100;
    return { sale: sale, earned: earned, tds: tds, net: Math.round((earned - tds - r.deductions) * 100) / 100 };
  }
  function parseSalary(buf, fileName) {
    var wb = window.XLSX.read(buf, { type: 'array', cellFormula: true, cellDates: true });
    var master = wb.Sheets['Master'];
    if (!master) throw new Error('This does not look like the salary file: there is no Master sheet.');
    var sheetBy = {};
    wb.SheetNames.forEach(function (n) { sheetBy[norm(n)] = wb.Sheets[n]; });
    var people = [];
    for (var c = 2; c <= 21; c++) {
      var L = colName(c), name = cellText(master, L + '3'), code = cellText(master, L + '2');
      if (!name) continue;
      var sheet = sheetBy[norm(name)];
      if (!sheet) continue;
      var lines = [];
      for (var r = 4; r <= 43; r++) {
        var item = cellText(master, 'B' + r);
        if (!item || item.charAt(0) === '—') continue;
        var qty = cellNum(master, L + r), rate = cellNum(sheet, 'C' + r);
        if (qty > 0) lines.push({ item: item, qty: qty, rate: rate });
      }
      people.push({
        name: name, code: code, lines: lines,
        gpi: cellNum(master, L + '47'), other: cellNum(master, L + '48'), empty: cellNum(master, L + '49'), deductions: cellNum(master, L + '50'),
        paid: cellText(master, L + '51').toUpperCase() === 'YES'
      });
    }
    if (!people.length) throw new Error('No salesman columns were found in the Master sheet.');
    var month = '';
    var mm = /(\d{2})(\d{2})(?!.*\d)/.exec(String(fileName || '').replace(/\.[a-z]+$/i, ''));
    if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) month = '20' + mm[2] + '-' + mm[1];
    if (!month) {
      var b1 = master.B1 && master.B1.v;
      if (b1 instanceof Date && !isNaN(b1)) month = b1.getFullYear() + '-' + ('0' + (b1.getMonth() + 1)).slice(-2);
    }
    return { month: month, people: people };
  }
  // Best guess at which buyer profile a salary column belongs to. The admin can change every guess.
  function guessProfile(person) {
    var buyers = (data && data.buyers) || [];
    var first = norm(person.name.split(/\s+/)[0]);
    var codeNum = String(Number(person.code));
    var byCode = buyers.filter(function (b) {
      var m = /[·•]\s*0*(\d+)\s*$/.exec(b.name);
      return m && m[1] === codeNum;
    });
    if (byCode.length === 1) return byCode[0].profile_id;
    var pool = byCode.length ? byCode : buyers;
    var byName = pool.filter(function (b) { return first.length >= 3 && norm(b.name).indexOf(first) === 0; });
    return byName.length === 1 ? byName[0].profile_id : null;
  }
  function previewModal() {
    var opts = function (sel) {
      return '<option value="">— not uploaded —</option>' + data.buyers.map(function (b) {
        return '<option value="' + b.profile_id + '"' + (b.profile_id === sel ? ' selected' : '') + '>' + esc(b.name) + '</option>';
      }).join('');
    };
    var rows = parsed.people.map(function (p, i) {
      var t = compute(p);
      return '<tr><td>' + esc(p.name) + ' <span class="stock-quiet">' + esc(p.code) + '</span></td><td>₹' + t.net.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + '</td>' +
        '<td><select name="who" data-i="' + i + '">' + opts(p.profile_id) + '</select></td></tr>';
    }).join('');
    openModal(
      '<div class="section-kicker"><span class="section-number">◎</span><span>SALARY FILE</span></div><h2>Check and save</h2>' +
      '<p class="modal-intro">Choose which buyer each salary belongs to. Only the buyers you match will get a statement, and each sees only their own. Totals are worked out again when saved.</p>' +
      '<form id="pa-form" autocomplete="off">' +
      '<label class="form-field"><span>Salary month</span><input name="month" type="month" required value="' + esc(parsed.month) + '" /></label>' +
      '<div class="table-shell"><table class="route-table admin-table"><thead><tr><th>SALARY SHEET</th><th>NET PAYABLE</th><th>BUYER</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="admin-auth-error" id="pa-error" hidden></p>' +
      '<div class="modal-actions"><button class="button button-quiet" type="button" data-pa="close">Cancel</button><button class="button button-primary" type="submit" id="pa-save">Save</button></div></form>',
      function (f) {
        var chosen = [], seen = {}, bad = null;
        Array.prototype.forEach.call(f.querySelectorAll('select[name="who"]'), function (sel) {
          if (!sel.value) return;
          var p = parsed.people[Number(sel.getAttribute('data-i'))];
          if (seen[sel.value]) bad = 'The same buyer is chosen twice. Fix it and try again.';
          seen[sel.value] = true;
          chosen.push({ profile_id: Number(sel.value), code: p.code, name: p.name, lines: p.lines, gpi: p.gpi, other: p.other, empty: p.empty, deductions: p.deductions, paid: p.paid });
        });
        if (bad) return fail(bad);
        if (!f.month.value) return fail('Choose the salary month.');
        if (!chosen.length) return fail('Match at least one salary to a buyer.');
        busy(true);
        api('/api/portal-accounts/salary', { method: 'POST', body: { month: f.month.value, rows: chosen } })
          .then(function (r) { salMsg = 'Saved ' + r.saved + ' salary statements for ' + monthLabel(r.month) + '.'; parsed = null; return done(''); })
          .catch(function (e) { busy(false); fail(e.message); });
      }
    );
  }
  function onSalaryFile(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    salMsg = 'Reading the file…'; renderPanel();
    loadScript(XLSX_SRC).then(function () { return file.arrayBuffer(); }).then(function (buf) {
      parsed = parseSalary(buf, file.name);
      parsed.people.forEach(function (p) { p.profile_id = guessProfile(p); });
      salMsg = '';
      renderPanel();
      previewModal();
    }).catch(function (e) { parsed = null; salMsg = e.message || 'Could not read that file.'; renderPanel(); });
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
      '<p class="modal-intro"><strong>' + esc(b.name) + '</strong> · sees only their own units and settlement report, view only</p>' +
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
    if (act === 'sal-pick') { var fi = $('pa-sal-file'); if (fi) fi.click(); return; }
    if (act === 'sal-del') {
      if (btn.getAttribute('data-sure') !== '1') { btn.setAttribute('data-sure', '1'); btn.textContent = 'Tap again to remove'; return; }
      api('/api/portal-accounts/salary/' + encodeURIComponent(btn.getAttribute('data-month')), { method: 'DELETE' })
        .then(function () { salMsg = 'Month removed.'; return load(); }).catch(function (e) { salMsg = e.message; renderPanel(); });
      return;
    }
    if (act === 'tl-new') return teamModal(null);
    if (act === 'tl-edit') return teamModal(Number(btn.getAttribute('data-aid')));
    if (act === 'toggle') {
      btn.disabled = true;
      api('/api/portal-accounts/' + btn.getAttribute('data-aid') + '/active', { method: 'PATCH', body: { active: btn.getAttribute('data-active') !== '1' } })
        .then(function () { msg = ''; return load(); }).catch(function () { btn.disabled = false; });
    }
  });
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'pa-sal-file') onSalaryFile(e.target); });
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
