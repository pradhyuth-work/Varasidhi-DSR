// Calm motion for the sign-in screen. Decorative only: it never reads or changes the password or the sign-in request.
(function () {
  var screen = document.getElementById('login-screen');
  if (!screen) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var visible = function () { return !screen.hidden && !document.hidden; };

  // live clock
  var clock = document.getElementById('login-clock');
  function tick() {
    if (clock && !screen.hidden) clock.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST';
  }
  tick(); setInterval(tick, 1000);

  // field bars fill as characters are typed
  var pw = document.getElementById('login-password');
  var bars = document.querySelectorAll('#login-bars i');
  function fill() {
    var n = pw ? pw.value.length : 0;
    bars.forEach(function (b, i) { b.classList.toggle('on', i < n); });
  }
  if (pw) { pw.addEventListener('input', fill); fill(); }

  // shake the card and reset the bars when a sign-in fails
  var err = document.getElementById('login-error');
  var card = document.getElementById('login-form');
  if (err && card && window.MutationObserver) {
    new MutationObserver(function () {
      if (!err.hidden) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
      fill();
    }).observe(err, { attributes: true, attributeFilter: ['hidden'] });
  }

  // typewriter subtitle
  var typed = document.getElementById('login-typed');
  var base = 'Sign in to continue';
  if (typed && !reduced) {
    var words = [base, 'Orders · Dispatch · Collections', 'Ledgers · Stock · Reports', base];
    var wi = 0, ci = 0, del = false;
    var step = function () {
      var w = words[wi];
      typed.textContent = w.slice(0, ci);
      var delay;
      if (!del) {
        if (ci < w.length) { ci++; delay = 55; } else { del = true; delay = wi === 0 ? 2600 : 1500; }
      } else if (ci > 0) { ci--; delay = 22; }
      else { del = false; wi = (wi + 1) % words.length; delay = 300; }
      setTimeout(step, delay);
    };
    setTimeout(step, 2600);
  }

  // faint waves leaning toward the pointer
  var cv = document.getElementById('login-cv');
  var cx = cv && cv.getContext && cv.getContext('2d');
  if (!cx) return;
  var w = 0, h = 0, mx = .5, my = .5;
  function size() {
    var d = window.devicePixelRatio || 1;
    w = window.innerWidth; h = window.innerHeight;
    cv.width = w * d; cv.height = h * d;
    cx.setTransform(d, 0, 0, d, 0, 0);
  }
  function draw(t) {
    cx.clearRect(0, 0, w, h);
    for (var k = 0; k < 3; k++) {
      var y0 = h * (.62 + k * .1), amp = 8 + k * 3 + Math.abs(mx - .5) * 10, sp = (t / 3200) * (1 + k * .18);
      cx.beginPath();
      for (var x = 0; x <= w; x += 6) {
        var y = y0 + Math.sin(x / 70 + sp) * amp + Math.sin(x / 190 - sp * .7) * amp * .8 + (my - .5) * 14 * (k / 3);
        if (x) cx.lineTo(x, y); else cx.moveTo(x, y);
      }
      cx.strokeStyle = k === 1 ? 'rgba(70,201,149,.45)' : 'rgba(255,255,255,.08)';
      cx.lineWidth = k === 1 ? 1.5 : 1;
      cx.stroke();
    }
  }
  size();
  window.addEventListener('resize', size);
  if (reduced) { draw(0); return; }
  window.addEventListener('pointermove', function (e) { mx = e.clientX / w; my = e.clientY / h; }, { passive: true });
  (function loop(t) { if (visible()) draw(t); requestAnimationFrame(loop); })(0);
})();
