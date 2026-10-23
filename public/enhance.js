/* Varasidhi DSR: motion, button feedback and charts.
   Read-only: reads window.__dsrState, never calls the API, never changes the app's own elements except for
   adding temporary classes and (for the count-up) briefly showing in-between numbers before the exact final text. */
(() => {
  'use strict';
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const rs = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
  const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
  const S = () => window.__dsrState || null;

  /* ---------------- 1. entrance after a buyer loads ---------------- */
  let lastBuyer = null;
  function rise() {
    if (reduce()) { /* still fade, handled in CSS */ }
    const sel = ['.profile-panel', '.metric-grid .metric-card', '.workflow-bar', '.dsr-tabs', '#dispatch-section', '#closing-section', '#payments-section'];
    let i = 0;
    sel.forEach((q) => document.querySelectorAll(q).forEach((el) => {
      if (el.offsetParent === null) return;
      el.style.setProperty('--enh-d', (i++ * 45) + 'ms');
      el.classList.remove('enh-rise'); void el.offsetWidth; el.classList.add('enh-rise');
      el.addEventListener('animationend', () => { el.classList.remove('enh-rise'); el.style.removeProperty('--enh-d'); }, { once: true });
    }));
  }
  function watchBuyer() {
    const s = S(); if (!s) return;
    const id = s.selectedBuyerId;
    if (id != null && id !== lastBuyer && s.session) { lastBuyer = id; rise(); }
  }

  /* ---------------- 2. count-up on figures ---------------- */
  const FIG = ['previous-balance', 'gross-sales', 'payments-received', 'updated-balance', 'dash-kpi-stock-value', 'dash-kpi-units', 'dash-kpi-balance', 'dash-kpi-buyers'];
  const parse = (t) => { const m = String(t).match(/-?[\d,]+(?:\.\d+)?/); return m ? Number(m[0].replace(/,/g, '')) : null; };
  const figState = new Map(); // id -> { shown:number|null, busy:boolean, raf }
  function figChanged(el) {
    const st = figState.get(el.id) || { shown: null, busy: false };
    figState.set(el.id, st);
    if (st.busy) return;
    const finalText = el.textContent;
    const to = parse(finalText);
    const from = st.shown;
    st.shown = to;
    if (reduce() || to === null || from === null || from === to || !el.isConnected || el.offsetParent === null) return;
    const dec = (finalText.match(/\.(\d+)/) || [])[1]?.length || 0;
    const fmtMid = (v) => {
      const body = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      return finalText.replace(/-?[\d,]+(?:\.\d+)?/, (v < 0 ? '-' : '') + body);
    };
    st.busy = true;
    const host = el.closest('.metric-card, .footer-stat, .dash-kpi') || el;
    host.classList.remove('enh-flash'); void host.offsetWidth; host.classList.add('enh-flash');
    clearTimeout(host._enhF); host._enhF = setTimeout(() => host.classList.remove('enh-flash'), 1000);
    const t0 = performance.now(), D = 400;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
      if (k < 1) { el.textContent = fmtMid(from + (to - from) * e); st.raf = requestAnimationFrame(step); }
      else { el.textContent = finalText; st.busy = false; }
    };
    st.raf = requestAnimationFrame(step);
  }
  function watchFigures() {
    FIG.forEach((id) => {
      const el = $(id); if (!el || el.dataset.enhWatched) return;
      el.dataset.enhWatched = '1';
      const st = { shown: parse(el.textContent), busy: false }; figState.set(id, st);
      new MutationObserver(() => figChanged(el)).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------------- 3. saving state on save buttons ---------------- */
  const SAVE = '#save-load, #save-closing, #settle-route, #payment-form button[type="submit"], #return-stock-btn';
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest(SAVE);
    if (!b || b.disabled) return;
    b.classList.add('enh-saving');
    const ov = $('busy-overlay');
    const done = () => b.classList.remove('enh-saving');
    // if no write starts within a moment (validation stopped it), clear straight away
    setTimeout(() => {
      if (!ov || ov.hidden) { done(); return; }
      const mo = new MutationObserver(() => { if (ov.hidden) { mo.disconnect(); done(); } });
      mo.observe(ov, { attributes: true, attributeFilter: ['hidden'] });
      setTimeout(done, 20000);
    }, 350);
  }, true);

  /* ---------------- 4. charts ---------------- */
  const METHOD = { CASH: 'Cash', HDFC_SCANNER: 'HDFC scanner', BANK_TRANSFER_HDFC: 'Bank transfer · HDFC', BANK_TRANSFER_UNION: 'Bank transfer · Union', BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', EMPTY_PACKETS: 'Empty packets', VOUCHERS: 'Vouchers' };
  const methodName = (m) => METHOD[m] || String(m || 'Other').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  const kicker = (num, text) => `<div class="section-kicker"><span>${text}</span></div>`;
  const card = (num, kick, title, sub, body) => `<article class="enh-card">${kicker(num, kick)}<h3>${esc(title)}</h3><p class="enh-sub">${esc(sub)}</p>${body}</article>`;

  function hbars(rows, fmt) {
    if (!rows.length) return '<p class="enh-none">Nothing to show for this period.</p>';
    const mx = Math.max(...rows.map((r) => r.v)) || 1;
    return '<div class="enh-bars">' + rows.map((r, i) =>
      `<div class="enh-bar${i === 0 ? ' top' : ''}" data-tip="${esc(r.n)}: ${esc(fmt(r.v))}"><span class="n">${esc(r.n)}</span><span class="t"><i class="f" style="width:${(r.v / mx * 100).toFixed(2)}%;--enh-d:${i * 30}ms"></i></span><span class="v">${esc(fmt(r.v))}</span></div>`).join('') + '</div>';
  }
  function columns(vals, labels, titles) {
    const mx = Math.max(...vals) || 1, pk = vals.indexOf(Math.max(...vals));
    const step = vals.length > 16 ? 3 : vals.length > 9 ? 2 : 1;
    return `<div class="enh-cols" data-max="${rs(mx)}">` + vals.map((v, i) =>
      `<div class="enh-col${i === pk ? ' top' : ''}${v === 0 ? ' zero' : ''}" data-tip="${esc(titles[i])}: ${esc(rs(v))}" aria-label="${esc(titles[i])}: ${esc(rs(v))}"><i style="height:${Math.max(0, v / mx * 100).toFixed(2)}%;--enh-d:${i * 20}ms"></i></div>`).join('') + '</div>' +
      '<div class="enh-xl">' + labels.map((l, i) => `<span>${i % step === 0 ? esc(l) : ''}</span>`).join('') + '</div>';
  }

  /* area chart: smooth line, soft fill, dashed average with a tag, last-value tag, hover crosshair. Plain SVG for the shapes,
     HTML for every label so the page's global svg rules and viewBox scaling can never distort text. */
  function smooth(pts) {
    const n = pts.length; if (n < 2) return '';
    const dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b);
      if (h > 3) { const k = 3 / h; t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[i + 1][0], y1 = pts[i + 1][1], h = dx[i] / 3;
      d += `C${(x0 + h).toFixed(1)},${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }
  function area(vals, labels, titles) {
    const W = 600, H = 200, n = vals.length, mx = (Math.max(...vals) || 1) * 1.12;
    const X = (i) => (n === 1 ? W / 2 : i / (n - 1) * W), Y = (v) => H - v / mx * H;
    const pts = vals.map((v, i) => [X(i), Y(v)]);
    const line = smooth(pts), fill = `${line}L${W},${H}L0,${H}Z`;
    const avg = vals.reduce((a, b) => a + b, 0) / n, lastV = vals[n - 1];
    const top = (v) => (Y(v) / H * 100).toFixed(2);
    const step = n > 16 ? 4 : n > 9 ? 2 : 1;
    const grid = [0.25, 0.5, 0.75].map((f) => `<line class="gl" x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}"/>`).join('');
    const data = esc(JSON.stringify({ v: vals, t: titles, mx }));
    return `<div class="enh-area" data-d="${data}">
      <div class="enh-plot"><svg class="enh-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="enhg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s1"/><stop offset="1" class="s2"/></linearGradient></defs>
        ${grid}<path class="af" d="${fill}"/><line class="avg" x1="0" x2="${W}" y1="${Y(avg).toFixed(1)}" y2="${Y(avg).toFixed(1)}"/><path class="al" pathLength="1" d="${line}"/></svg>
        <span class="enh-ymax">${esc(rs(mx / 1.12))}</span>
        <span class="enh-tag avg" style="top:${top(avg)}%">AVG ${esc(rs(avg))}</span>
        <span class="enh-tag last" style="top:${top(lastV)}%">${esc(rs(lastV))}</span>
        <span class="enh-dot" style="left:${(X(n - 1) / W * 100).toFixed(2)}%;top:${top(lastV)}%"></span>
        <span class="enh-cross" hidden><i></i><b class="enh-pop"></b></span>
      </div>
      <div class="enh-xl">${labels.map((l, i) => `<span>${i % step === 0 ? esc(l) : ''}</span>`).join('')}</div>
    </div>`;
  }
  function strip(cells) {
    return '<div class="enh-strip">' + cells.map((c) => `<div><small>${esc(c[0])}</small><b class="${c[2] || ''}">${esc(c[1])}</b></div>`).join('') + '</div>';
  }
  /* order-book style ladder: depth bars behind the numbers, a middle line with the total */
  function ladder(upper, upperTone, midLabel, midVal, lower, lowerTone, fmt) {
    const mx = Math.max(...upper.concat(lower).map((r) => Math.abs(r.v))) || 1;
    const row = (r, tone) => `<div class="enh-lr ${tone}"><i style="width:${(Math.abs(r.v) / mx * 100).toFixed(1)}%"></i><span class="n">${esc(r.n)}</span><span class="v">${esc(fmt(r.v))}</span></div>`;
    return `<div class="enh-ladder"><div class="enh-lh"><span>Buyer / product</span><span>Value</span></div>${upper.map((r) => row(r, upperTone)).join('')}<div class="enh-lm"><span>${esc(midLabel)}</span><b>${esc(fmt(midVal))}</b></div>${lower.map((r) => row(r, lowerTone)).join('')}</div>`;
  }

  const PAL = ['var(--teal)', 'var(--amber-bright)', 'var(--teal-light)', 'var(--info)', '#8caeb0', 'var(--line-strong)'];
  function share(rows, fmt) {
    const tot = rows.reduce((t, r) => t + r.v, 0);
    if (!tot) return '<p class="enh-none">Nothing to show.</p>';
    return '<div class="enh-share">' + rows.map((r, i) => `<i style="width:${(r.v / tot * 100).toFixed(2)}%;background:${PAL[i % PAL.length]};--enh-d:${i * 40}ms" title="${esc(r.n)}"></i>`).join('') + '</div>' +
      '<div class="enh-legend">' + rows.map((r, i) => `<div><b style="background:${PAL[i % PAL.length]}"></b><span class="n">${esc(r.n)}</span><span class="p">${(r.v / tot * 100).toFixed(0)}%</span><span class="v">${esc(fmt(r.v))}</span></div>`).join('') + '</div>';
  }
  function topN(rows, n) {
    const s = rows.filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    if (s.length <= n) return s;
    const rest = s.slice(n - 1).reduce((t, r) => t + r.v, 0);
    return s.slice(0, n - 1).concat([{ n: 'Everyone else', v: rest }]);
  }

  const charts = {
    /* Payments & balances, All payments */
    payments: {
      anchor: 'pr-summary',
      build(s) {
        const d = s.paymentsReportData; if (!d || !d.days || !d.days.length) return null;
        const byDay = new Map(d.days.map((x) => [x.date, Number(x.day_total) || 0]));
        const dates = [...byDay.keys()].sort();
        const cards = [];
        if (dates.length >= 3) {
          const a = new Date(dates[0] + 'T00:00:00'), b = new Date(dates.at(-1) + 'T00:00:00');
          const vals = [], labels = [], titles = [];
          for (let t = new Date(a); t <= b && vals.length < 62; t.setDate(t.getDate() + 1)) {
            const k = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
            vals.push(byDay.get(k) || 0); labels.push(String(t.getDate())); titles.push(t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
          }
          const tot = vals.reduce((a, b) => a + b, 0), best = Math.max(...vals), lastV = vals.at(-1), avg = tot / vals.length;
          const diff = avg ? (lastV - avg) / avg * 100 : 0;
          cards.push(card('01', 'DAY BY DAY', 'Payments received by day', `${titles[0]} to ${titles.at(-1)}. Hover the line for each day.`,
            strip([['Latest day', rs(lastV), diff >= 0 ? 'up' : 'dn'], ['Average / day', rs(avg)], ['Best day', rs(best)], ['vs average', (diff >= 0 ? '+' : '') + diff.toFixed(0) + '%', diff >= 0 ? 'up' : 'dn']]) + area(vals, labels, titles)));
        }
        const m = new Map();
        d.days.forEach((x) => x.payments.forEach((p) => m.set(p.method, (m.get(p.method) || 0) + Number(p.amount || 0))));
        const rows = [...m].map(([k, v]) => ({ n: methodName(k), v })).sort((x, y) => y.v - x.v);
        cards.push(card(cards.length ? '02' : '01', 'BY METHOD', 'Collections by method', 'Everything in the selected dates, largest first.', hbars(rows, rs)));
        return { html: cards.join(''), sig: JSON.stringify([dates, [...m]]), single: cards.length === 1 };
      },
    },
    /* Route Performance tab */
    performance: {
      anchor: 'perf-summary',
      build(s) {
        const d = s.performanceData; if (!d || !d.rows || !d.rows.length) return null;
        const single = d.filters && d.filters.profileId != null;
        const nameKey = single ? 'product_name' : 'buyer_name';
        const rows = d.rows.map((r) => ({ n: r[nameKey], rev: Number(r.total_revenue) || 0, q: Number(r.total_qty) || 0 }));
        const rev = rows.filter((r) => r.rev > 0).sort((a, b) => b.rev - a.rev).slice(0, 8).map((r) => ({ n: r.n, v: r.rev }));
        const qty = rows.filter((r) => r.q > 0).sort((a, b) => b.q - a.q).slice(0, 8).map((r) => ({ n: r.n, v: r.q }));
        if (rev.length < 2) return null;
        const who = single ? 'product' : 'buyer';
        return { html: card('01', 'REVENUE', `Revenue by ${who}`, 'Settled routes in the selected dates, top eight.', hbars(rev, rs)) +
                       card('02', 'QUANTITY', `Quantity sold by ${who}`, 'Units sold, top eight.', hbars(qty, int)),
                 sig: JSON.stringify([rev, qty]) };
      },
    },
    /* Admin dashboard */
    dashboard: {
      anchor: null, find: () => document.querySelector('.dash-kpis'),
      build(s) {
        const bal = (s.profiles || []).map((p) => ({ n: p.name, v: Number(p.current_balance) || 0 }));
        const stk = (s.products || []).map((p) => ({ n: p.name, v: (Number(p.warehouse_stock) || 0) * (Number(p.unit_price) || 0) }));
        const b = topN(bal, 6), k = topN(stk, 6);
        if (!b.length && !k.length) return null;
        return { html: card('02', 'BALANCES', 'Where the balance sits', 'Share of what buyers owe in total, largest first.', share(b, rs)) +
                       card('03', 'STOCK', 'Where the stock value sits', 'Share of warehouse stock value (units × rate).', share(k, rs)),
                 sig: JSON.stringify([b, k]) };
      },
    },
    /* Admin dashboard: order-book style ladders */
    ladders: {
      anchor: null, find: () => document.querySelector('[data-enh="dashboard"]'),
      build(s) {
        const bal = (s.profiles || []).map((p) => ({ n: p.name, v: Number(p.current_balance) || 0 })).sort((a, b) => b.v - a.v);
        const stk = (s.products || []).map((p) => ({ n: p.name, v: (Number(p.warehouse_stock) || 0) * (Number(p.unit_price) || 0) })).sort((a, b) => b.v - a.v);
        if (bal.length < 6 || stk.length < 6) return null;
        const bu = bal.slice(0, 5), bl = bal.slice(-4), su = stk.slice(0, 5), sl = stk.slice(-4);
        const tb = bal.reduce((t, r) => t + r.v, 0), ts = stk.reduce((t, r) => t + r.v, 0);
        return { html: card('', 'LADDER', 'Balance ladder', 'Largest dues on top, smallest dues and credits at the bottom.', ladder(bu, 'warm', 'Net owed by all buyers', tb, bl, 'cool', rs)) +
                       card('', 'LADDER', 'Stock value ladder', 'Highest value on the shelf on top, running low at the bottom.', ladder(su, 'cool', 'Total stock value', ts, sl, 'warm', rs)),
                 sig: JSON.stringify([bu, bl, su, sl]) };
      },
    },
    /* Payments & balances, Empty packets summary */
    packs: {
      anchor: 'eprep-summary',
      build(s) {
        const d = s.emptyPacksReportData; if (!d || !d.byType || d.byType.length < 2) return null;
        const pk = d.byType.map((r) => ({ n: r.type, v: Number(r.packets) || 0 })).sort((a, b) => b.v - a.v);
        const vl = d.byType.map((r) => ({ n: r.type, v: Number(r.value) || 0 })).sort((a, b) => b.v - a.v);
        return { html: card('01', 'PACKETS', 'Packets collected by product', 'Largest first.', hbars(pk, int)) +
                       card('02', 'VALUE', 'Credited by product', 'Rupee value of those packets.', hbars(vl, rs)),
                 sig: JSON.stringify([pk, vl]) };
      },
    },
  };

  const mounted = {};
  function sync() {
    const s = S(); if (!s) return;
    watchFigures(); watchBuyer();
    Object.entries(charts).forEach(([key, c]) => {
      const anchor = c.anchor ? $(c.anchor) : (c.find && c.find());
      let row = mounted[key];
      if (!anchor) { if (row) row.remove(); delete mounted[key]; return; }
      let out = null;
      try { out = c.build(s); } catch (_) { out = null; }
      if (!out) { if (row && !row.hidden) row.hidden = true; return; }
      const needNew = !row || !row.isConnected || row.previousElementSibling !== anchor;
      if (needNew) {
        if (row) row.remove();
        row = document.createElement('div'); row.dataset.enh = key; mounted[key] = row;
        anchor.insertAdjacentElement('afterend', row); row.dataset.sig = '';
      }
      const cls = 'enh-row' + (out.single ? ' enh-single' : '') + (row.classList.contains('enh-grow') ? ' enh-grow' : '');
      if (row.className !== cls) row.className = cls;
      const want = Boolean(anchor.hidden);
      if (row.hidden !== want) row.hidden = want;
      if (row.dataset.sig !== out.sig) {
        const first = row.dataset.sig === '';
        row.dataset.sig = out.sig; row.innerHTML = out.html;
        if (first && !reduce()) { row.classList.add('enh-grow'); setTimeout(() => row.classList.remove('enh-grow'), 1200); }
      }
    });
  }

  /* ---------------- 5. navigation feel: sliding indicators, panel entrances, scroll reveal, pointer light ---------------- */
  const sliders = [];
  function makeSlider(container, itemSel, kind) {
    if (container.dataset.enhInk) return;
    container.dataset.enhInk = '1';
    const ink = document.createElement('span'); ink.className = 'enh-ink enh-ink-' + kind; ink.setAttribute('aria-hidden', 'true');
    container.appendChild(ink); container.classList.add('enh-ink-on');
    const rec = { container, ink, itemSel, kind, placed: false };
    sliders.push(rec);
    new MutationObserver(() => placeInk(rec)).observe(container, { attributes: true, attributeFilter: ['class'], subtree: true });
    placeInk(rec);
  }
  function placeInk(rec) {
    const { container, ink, itemSel, kind } = rec;
    const a = [...container.querySelectorAll(itemSel)].find((el) => el.classList.contains('active') && el.offsetParent !== null);
    if (!a || container.offsetParent === null) { ink.style.opacity = '0'; return; }
    const x = a.offsetLeft, y = a.offsetTop, w = a.offsetWidth, h = a.offsetHeight;
    if (kind === 'line') { ink.style.transform = `translate(${x}px, 0) scaleX(${w})`; }
    else { ink.style.width = w + 'px'; ink.style.height = h + 'px'; ink.style.transform = `translate(${x}px, ${y}px)`; }
    ink.style.opacity = '1';
    if (!rec.placed) { rec.placed = true; ink.classList.add('first'); requestAnimationFrame(() => requestAnimationFrame(() => ink.classList.remove('first'))); }
  }
  function placeAllInks() { sliders.forEach(placeInk); }
  function setupSliders() {
    document.querySelectorAll('.admin-tabs').forEach((c) => makeSlider(c, '.admin-tab', 'line'));
    document.querySelectorAll('.dsr-tabs').forEach((c) => makeSlider(c, '.dsr-tab', 'line'));
    document.querySelectorAll('.nav-list').forEach((c) => makeSlider(c, '.nav-item', 'pill'));
  }

  const PANEL = 'section, .admin-panel, [data-pr-panel], [id^="view-"]';
  function panelEnter(el) {
    if (reduce() || el.closest('.enh-row') || el.offsetParent === null) return;
    el.classList.remove('enh-in'); void el.offsetWidth; el.classList.add('enh-in');
    [...el.children].slice(0, 8).forEach((c, i) => {
      if (c.offsetParent === null) return;
      c.style.setProperty('--enh-d', (60 + i * 55) + 'ms'); c.classList.remove('enh-in-c'); void c.offsetWidth; c.classList.add('enh-in-c');
      c.addEventListener('animationend', () => { c.classList.remove('enh-in-c'); c.style.removeProperty('--enh-d'); }, { once: true });
    });
    el.addEventListener('animationend', (e) => { if (e.target === el) el.classList.remove('enh-in'); }, { once: true });
    setTimeout(() => { placeAllInks(); scanReveal(); }, 80);
  }
  function watchPanels() {
    new MutationObserver((list) => {
      list.forEach((m) => { const el = m.target; if (m.oldValue !== null && !el.hidden && el.matches && el.matches(PANEL)) panelEnter(el); });
    }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true, subtree: true });
  }

  const SR = '.metric-card, .enh-card, .table-shell, .section-heading, .workflow-bar, .dash-card, .live-footer, .payments-card, .settle-bar';
  let io = null;
  function scanReveal() {
    if (reduce() || !('IntersectionObserver' in window)) return;
    if (!io) io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('enh-sr-in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    document.querySelectorAll(SR).forEach((el) => {
      if (el.dataset.enhSr || el.offsetParent === null) return;
      el.dataset.enhSr = '1';
      if (el.getBoundingClientRect().top > innerHeight * 0.92) { el.classList.add('enh-sr'); io.observe(el); }
    });
  }

  function areaHover() {
    document.addEventListener('pointermove', (e) => {
      const a = e.target.closest && e.target.closest('.enh-area'); if (!a) return;
      const plot = a.querySelector('.enh-plot'), cross = a.querySelector('.enh-cross'); if (!plot || !cross) return;
      let d; try { d = JSON.parse(a.dataset.d); } catch (_) { return; }
      const r = plot.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const i = Math.round(f * (d.v.length - 1)), x = d.v.length === 1 ? .5 : i / (d.v.length - 1);
      cross.hidden = false; cross.style.left = (x * 100) + '%';
      const pop = cross.querySelector('.enh-pop'); pop.textContent = d.t[i] + '  ' + rs(d.v[i]);
      pop.classList.toggle('flip', x > .62);
      cross.style.setProperty('--y', (100 - d.v[i] / d.mx * 100) + '%');
    }, { passive: true });
    document.addEventListener('pointerout', (e) => { const a = e.target.closest && e.target.closest('.enh-area'); if (a && !a.contains(e.relatedTarget)) { const c = a.querySelector('.enh-cross'); if (c) c.hidden = true; } });
  }
  function pointerLight() {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const T = '.metric-card, .enh-card, .dash-kpi, .profile-panel, .button-primary, .button-dark';
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest(T); if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px'); el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      if (!el.classList.contains('enh-spot')) el.classList.add('enh-spot');
    }, { passive: true });
  }

  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; sync(); setupSliders(); scanReveal(); }); };
  function start() {
    const root = $('app') || document.body;
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('click', () => setTimeout(schedule, 60));
    watchPanels(); pointerLight(); areaHover(); window.addEventListener('resize', placeAllInks);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeAllInks);
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
