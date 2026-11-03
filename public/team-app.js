// Team page: sign in, then show unit counts only. Nothing here can change data.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-IN'); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var openBuyers = {};
  var latest = null;   // current month as reported by the server
  var current = null;  // month being shown
  var kind = null, view = 'perf', settleOpen = {};
  var rupee = function (n) { return '\u20b9' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e; }
        return data;
      });
    });
  }

  function showLogin(message) {
    $('team-app').hidden = true;
    $('login-screen').hidden = false;
    var err = $('login-error');
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    $('login-password').value = '';
    $('login-password').dispatchEvent(new Event('input'));
    window.setTimeout(function () { $('login-username').focus(); }, 40);
  }

  function showApp() {
    $('login-screen').hidden = true;
    $('team-app').hidden = false;
  }

  function monthLabel(m) {
    var p = m.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }

  function fillMonths(newest, selected) {
    var sel = $('tp-month');
    var parts = newest.split('-'), y = Number(parts[0]), m = Number(parts[1]);
    var html = '';
    for (var i = 0; i < 12; i++) {
      var v = y + '-' + (m < 10 ? '0' + m : m);
      html += '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + esc(monthLabel(v)) + '</option>';
      m -= 1; if (m === 0) { m = 12; y -= 1; }
    }
    sel.innerHTML = html;
  }

  function lines(items) {
    if (!items.length) return '<p class="tp-empty">No units recorded this month.</p>';
    return items.map(function (p) { return '<div class="tp-line"><span>' + esc(p.name) + '</span><b>' + fmt(p.units) + '</b></div>'; }).join('');
  }

  function render(d) {
    current = d.month;
    kind = d.kind;
    $('tp-switch').hidden = d.kind !== 'buyer';
    if (!latest) { latest = d.month; fillMonths(latest, d.month); }
    $('tp-month').value = d.month;
    $('tp-name').textContent = d.name || '';
    $('tp-kind').textContent = d.kind === 'team_lead' ? 'Team lead' : 'Buyer';
    $('tp-total').textContent = fmt(d.total_units);
    $('tp-prod-title').textContent = d.kind === 'team_lead' ? 'Team, by product' : 'By product';
    $('tp-products').innerHTML = lines(d.products);
    var isTeam = d.kind === 'team_lead';
    $('tp-buyers-card').hidden = !isTeam;
    if (isTeam) {
      var mx = Math.max.apply(null, [1].concat(d.buyers.map(function (b) { return b.units; })));
      $('tp-buyers').innerHTML = d.buyers.length ? d.buyers.map(function (b, i) {
        var open = openBuyers[b.name];
        return '<button class="tp-row" type="button" data-b="' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<div class="tp-line"><span>' + esc(b.name) + '</span><b>' + fmt(b.units) + '</b></div>' +
          '<div class="tp-bar"><i style="width:' + Math.round(b.units / mx * 100) + '%"></i></div>' +
          (open ? '<div class="tp-sub">' + lines(b.products) + '</div>' : '') + '</button>';
      }).join('') : '<p class="tp-empty">No buyers are in this team yet. Ask the admin.</p>';
      Array.prototype.forEach.call($('tp-buyers').querySelectorAll('.tp-row'), function (row) {
        row.addEventListener('click', function () {
          var name = d.buyers[Number(row.getAttribute('data-b'))].name;
          openBuyers[name] = !openBuyers[name];
          render(d);
        });
      });
    }
    $('tp-msg').textContent = '';
  }

  function load(month) {
    return api('/api/team/performance' + (month ? '?month=' + encodeURIComponent(month) : '')).then(function (d) {
      showApp(); render(d);
    }).catch(function (e) {
      if (e.status === 401) { showLogin('Your session ended. Sign in again.'); return; }
      showApp(); $('tp-msg').textContent = e.message;
    });
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('login-submit'), lb = btn.querySelector('.lb-text');
    btn.disabled = true; lb.textContent = 'Signing in…';
    $('login-error').hidden = true;
    api('/api/team/login', { method: 'POST', body: { username: $('login-username').value.trim(), pin: $('login-password').value } })
      .then(function () { latest = null; openBuyers = {}; settleOpen = {}; settleData = null; view = 'perf'; $('tp-view-perf').hidden = false; $('tp-view-settle').hidden = true; return load(); })
      .catch(function (e) { showLogin(e.message); })
      .then(function () { btn.disabled = false; lb.textContent = 'Sign in'; });
  });
  $('login-password').addEventListener('input', function () {
    /* any characters allowed */
  });
  function dateLabel(d) {
    var p = d.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function settleCard(s, i) {
    var open = !!settleOpen[s.date];
    var body = '';
    if (open) {
      var tot = s.items.reduce(function (a, p) { a.d += p.dispatch; a.c += p.closing_stock; a.q += p.qty_sold; a.t += p.line_total; return a; }, { d: 0, c: 0, q: 0, t: 0 });
      body = '<div class="ts-body"><div class="ts-wrap"><table class="ts-tbl"><thead><tr><th>PRODUCT</th><th>DISPATCH</th><th>CLOSING</th><th>SOLD</th><th>RATE</th><th>TOTAL</th></tr></thead><tbody>' +
        s.items.map(function (p) {
          return '<tr><td>' + esc(p.product_name) + '</td><td>' + fmt(p.dispatch) + '</td><td>' + fmt(p.closing_stock) + '</td><td>' + fmt(p.qty_sold) + '</td><td>' + rupee(p.unit_price) + '</td><td>' + rupee(p.line_total) + '</td></tr>';
        }).join('') +
        '<tr class="tot"><td>TOTAL</td><td>' + fmt(tot.d) + '</td><td>' + fmt(tot.c) + '</td><td>' + fmt(tot.q) + '</td><td>\u2014</td><td>' + rupee(tot.t) + '</td></tr></tbody></table></div>' +
        '<div class="ts-sub">Payments</div>' +
        (s.payments.length ? s.payments.map(function (p) {
          return '<div class="tp-line"><span>' + esc(p.method) + (p.label_info ? ' <small class="tp-empty">' + esc(p.label_info) + '</small>' : '') + '</span><b>' + rupee(p.amount) + '</b></div>';
        }).join('') : '<p class="tp-empty">No payments recorded.</p>') +
        '<div class="ts-bal"><div><span>Previous balance</span><b>' + rupee(s.prev_balance) + '</b></div><div><span>Total sales</span><b>' + rupee(s.total_sales) + '</b></div>' +
        '<div><span>Payments received</span><b>' + rupee(s.total_payments) + '</b></div><div class="hi"><span>Updated balance</span><b>' + rupee(s.updated_balance) + '</b></div></div></div>';
    }
    return '<section class="tp-card"><button class="ts-head" type="button" data-s="' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<div class="tp-line"><span class="ts-date">' + esc(dateLabel(s.date)) + '</span><b>' + rupee(s.total_sales) + '</b></div></button>' + body + '</section>';
  }

  var settleData = null;
  function renderSettle() {
    var d = settleData, box = $('ts-list');
    if (!d) { box.innerHTML = ''; return; }
    box.innerHTML = d.sessions.length ? d.sessions.map(settleCard).join('') : '<p class="tp-empty">No settled days in this period.</p>';
    Array.prototype.forEach.call(box.querySelectorAll('.ts-head'), function (b) {
      b.addEventListener('click', function () {
        var date = d.sessions[Number(b.getAttribute('data-s'))].date;
        settleOpen[date] = !settleOpen[date];
        renderSettle();
      });
    });
  }

  function loadSettle() {
    var q = [];
    if ($('ts-from').value) q.push('from=' + encodeURIComponent($('ts-from').value));
    if ($('ts-to').value) q.push('to=' + encodeURIComponent($('ts-to').value));
    return api('/api/team/settlement' + (q.length ? '?' + q.join('&') : '')).then(function (d) {
      settleData = d;
      $('ts-from').value = d.from; $('ts-to').value = d.to;
      $('tp-msg').textContent = '';
      renderSettle();
    }).catch(function (e) {
      if (e.status === 401) { showLogin('Your session ended. Sign in again.'); return; }
      $('tp-msg').textContent = e.message;
    });
  }

  function setView(v) {
    view = v === 'settle' && kind === 'buyer' ? 'settle' : 'perf';
    $('tp-view-perf').hidden = view !== 'perf';
    $('tp-view-settle').hidden = view !== 'settle';
    Array.prototype.forEach.call($('tp-switch').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === view);
    });
    $('tp-msg').textContent = '';
    if (view === 'settle') loadSettle();
  }
  Array.prototype.forEach.call($('tp-switch').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
  });
  $('ts-from').addEventListener('change', loadSettle);
  $('ts-to').addEventListener('change', loadSettle);
  $('tp-month').addEventListener('change', function () { load(this.value); });
  $('tp-out').addEventListener('click', function () {
    api('/api/team/logout', { method: 'POST' }).catch(function () {}).then(function () { window.location.reload(); });
  });

  // Already signed in from earlier today? Go straight to the numbers.
  api('/api/team/me').then(function () { load(); }).catch(function () { showLogin(); });
})();
