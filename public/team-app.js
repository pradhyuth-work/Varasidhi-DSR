// Team page: sign in, then show unit counts only. Nothing here can change data.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-IN'); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var openBuyers = {};
  var latest = null;   // current month as reported by the server
  var current = null;  // month being shown

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
      .then(function () { latest = null; openBuyers = {}; return load(); })
      .catch(function (e) { showLogin(e.message); })
      .then(function () { btn.disabled = false; lb.textContent = 'Sign in'; });
  });
  $('login-password').addEventListener('input', function () {
    /* any characters allowed */
  });
  $('tp-month').addEventListener('change', function () { load(this.value); });
  $('tp-out').addEventListener('click', function () {
    api('/api/team/logout', { method: 'POST' }).catch(function () {}).then(function () { window.location.reload(); });
  });

  // Already signed in from earlier today? Go straight to the numbers.
  api('/api/team/me').then(function () { load(); }).catch(function () { showLogin(); });
})();
