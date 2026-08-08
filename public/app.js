(() => {
  'use strict';

  const state = {
    profiles: [],
    selectedBuyerId: null,
    session: null,
    items: [],
    payments: [],
    products: [],
    purchases: [],
    adjustments: [],
    adjustmentsPage: 0,
    role: 'Store Manager',
    view: 'dsr',
    adminTab: 'masters',
    loading: true,
    busy: false,
    loadDrafts: {},
    closingDrafts: {},
    dsrTab: 'dispatch',
    reportData: null,
    reportLoading: false,
    inventoryData: null,
    inventoryLoading: false,
    profileStockData: null,
    profileStockLoading: false,
    performanceData: null,
    performanceLoading: false,
    settlementData: null,
    settlementLoading: false,
    selectedSettlementIdx: 0,
    settlementPage: 0,
    purchasesPage: 0,
    invBillsPage: 0,
    paymentsReportData: null,
    paymentsReportLoading: false,
    paymentsReportPage: 0,
  };

  const $ = (id) => document.getElementById(id);
  const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const firstOfMonth = () => `${todayIso().slice(0, 7)}-01`;
  const currency = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const integer = (value) => Number(value || 0).toLocaleString('en-IN');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  const dateLabel = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const timeLabel = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const initials = (name) => String(name || '—').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '—';
  const setHidden = (id, hidden) => { $(id).hidden = hidden; };

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) {
      // A 401 means the session is missing/expired — surface the login gate.
      if (response.status === 401) {
        const ls = document.getElementById('login-screen');
        if (ls) ls.hidden = false;
      }
      let message = `Request failed (${response.status})`;
      try { const body = await response.json(); message = body.message || body.error || message; } catch (_) { /* non-json error */ }
      throw new Error(message);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : response;
  }

  const adminOptions = (options = {}) => ({
    ...options,
    headers: { 'x-user-role': state.role, ...(options.headers || {}) },
  });

  function toast(message, kind = 'success') {
    const item = document.createElement('div');
    item.className = `toast ${kind === 'error' ? 'error' : ''}`;
    item.innerHTML = `<b>${kind === 'error' ? 'ATTENTION' : 'SAVED'}</b><span>${escapeHtml(message)}</span>`;
    $('toast-region').appendChild(item);
    window.setTimeout(() => item.remove(), 4300);
  }

  function announce(message) {
    $('global-feedback').textContent = message;
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => { $('global-feedback').textContent = ''; }, 4800);
  }

  function setBusy(isBusy, buttonId) {
    state.busy = isBusy;
    const button = buttonId && $(buttonId);
    if (button) {
      button.disabled = isBusy;
      button.dataset.originalText = button.dataset.originalText || button.textContent.trim();
      button.textContent = isBusy ? 'Saving…' : button.dataset.originalText;
    }
  }

  function selectedProfile() {
    return state.profiles.find((profile) => Number(profile.id) === Number(state.selectedBuyerId));
  }

  function hydratePayload(payload) {
    const data = payload || {};
    if (data.session) state.session = data.session;
    if (Array.isArray(data.items)) state.items = data.items;
    if (Array.isArray(data.payments)) state.payments = data.payments;
    state.items.forEach((item) => {
      if (state.loadDrafts[item.product_id] === undefined) state.loadDrafts[item.product_id] = 0;
      if (state.closingDrafts[item.product_id] === undefined) state.closingDrafts[item.product_id] = item.closing_stock ?? 0;
    });
  }

  async function loadProfiles() {
    state.loading = true;
    render();
    try {
      const payload = await request('/api/profiles');
      state.profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
      const remembered = Number(localStorage.getItem('dsr-buyer-id'));
      state.selectedBuyerId = state.profiles.some((profile) => Number(profile.id) === remembered) ? remembered : state.profiles[0]?.id ?? null;
      render();
      if (state.selectedBuyerId !== null) await loadSession(state.selectedBuyerId);
      else { state.loading = false; render(); }
    } catch (error) {
      state.loading = false;
      showError(error.message);
    }
  }

  async function loadAdminData() {
    if (state.role !== 'Admin') return;
    try {
      const [productsPayload, purchasesPayload, adjustmentsPayload] = await Promise.all([
        request('/api/products'),
        request('/api/purchases'),
        request('/api/stock-adjustments'),
      ]);
      state.products = Array.isArray(productsPayload?.products) ? productsPayload.products : [];
      state.purchases = Array.isArray(purchasesPayload?.purchases) ? purchasesPayload.purchases : [];
      state.adjustments = Array.isArray(adjustmentsPayload?.adjustments) ? adjustmentsPayload.adjustments : [];
      state.purchasesPage = 0;
      state.adjustmentsPage = 0;
      renderAdmin();
    } catch (error) {
      adminMessage(error.message, true);
    }
  }

  async function loadSession(buyerId) {
    state.selectedBuyerId = Number(buyerId);
    localStorage.setItem('dsr-buyer-id', String(buyerId));
    state.loading = true;
    state.dsrTab = 'dispatch';
    state.session = null; state.items = []; state.payments = []; state.loadDrafts = {}; state.closingDrafts = {};
    render();
    try {
      const payload = await request(`/api/dsr/active/${encodeURIComponent(buyerId)}`);
      if (!payload || !payload.session) {
        state.loading = false;
        render();
        return;
      }
      hydratePayload(payload);
      state.loading = false;
      $('last-sync').textContent = timeLabel(new Date().toISOString());
      $('sync-label').textContent = 'Warehouse sync is live';
      render();
    } catch (error) {
      state.loading = false;
      showError(error.message);
    }
  }

  function showError(message) {
    state.loading = false;
    setHidden('page-loading', true);
    setHidden('dashboard-content', true);
    setHidden('empty-state', true);
    setHidden('page-error', false);
    $('error-copy').textContent = message || 'Check the connection and try again.';
  }

  function render() {
    const profile = selectedProfile();
    const hasSession = Boolean(state.session);
    document.body.classList.toggle('admin-view', state.view === 'admin');
    $('view-admin').hidden = state.role !== 'Admin';
    $('view-dsr').classList.toggle('active', state.view === 'dsr');
    $('view-admin').classList.toggle('active', state.view === 'admin');
    $('view-settlement').classList.toggle('active', state.view === 'settlement');
    $('admin-content').hidden = state.role !== 'Admin' || state.view !== 'admin';
    $('settlement-content').hidden = state.view !== 'settlement';
    $('profile-panel').hidden = state.view !== 'dsr';
    $('buyer-select').disabled = state.loading || !state.profiles.length;
    $('buyer-select').innerHTML = state.profiles.length
      ? state.profiles.map((item) => `<option value="${escapeHtml(item.id)}" ${Number(item.id) === Number(state.selectedBuyerId) ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')
      : '<option>No buyer profiles found</option>';
    $('today-date').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    $('profile-title').textContent = profile?.name || 'Select a buyer';
    $('profile-initials').textContent = initials(profile?.name);
    $('profile-meta').textContent = profile ? `Buyer ID ${profile.id} · ${dateLabel(state.session?.date || new Date().toISOString())}` : 'Choose a buyer profile to hydrate today’s session.';
    $('profile-previous-balance').textContent = currency(state.session?.prev_balance ?? profile?.current_balance ?? 0);
    const status = state.session?.status;
    const chip = $('status-chip');
    chip.textContent = status || 'NO ROUTE';
    chip.className = `status-chip ${status === 'SETTLED' ? 'status-settled' : status === 'IN_PROGRESS' ? 'status-progress' : 'status-empty'}`;

    setHidden('page-loading', !state.loading || state.view === 'settlement');
    setHidden('page-error', true);
    setHidden('empty-state', state.view !== 'dsr' || state.loading || hasSession);
    setHidden('dashboard-content', state.loading || !hasSession || state.view !== 'dsr');
    setHidden('live-footer', state.loading || !hasSession || state.view !== 'dsr');
    if (!state.loading && !hasSession) $('sync-label').textContent = profile ? 'No active route' : 'Waiting for a buyer';
    if (hasSession) renderDashboard();
    if (state.role === 'Admin') renderAdmin();
  }

  function adminMessage(message, isError = false) {
    const target = $('admin-feedback');
    target.textContent = message || '';
    target.style.color = isError ? 'var(--red)' : '';
    window.clearTimeout(adminMessage.timer);
    adminMessage.timer = window.setTimeout(() => { target.textContent = ''; }, 4800);
  }

  function renderAdmin() {
    if (!$('products-body')) return;
    $('products-body').innerHTML = state.products.length
      ? state.products.map((product) => `<tr>
          <td><div class="product-cell"><span class="product-index">${String(product.id).padStart(2, '0')}</span><span>${escapeHtml(product.name)}</span></div></td>
          <td class="stock-quiet"><div class="stock-cell"><span>${integer(product.warehouse_stock)}</span><button class="button button-quiet compact-button stock-adjust" type="button" data-stock-adjust="${escapeHtml(product.id)}">Adjust</button></div></td>
          <td class="price">${currency(product.unit_price)}</td>
          <td><div class="inline-rate"><span>₹</span><input class="admin-number-input rate-input" data-product-id="${escapeHtml(product.id)}" type="number" min="0.01" step="0.01" value="${Number(product.unit_price).toFixed(2)}" aria-label="New rate for ${escapeHtml(product.name)}" /></div></td>
          <td><button class="button button-quiet compact-button rate-save" type="button" data-product-id="${escapeHtml(product.id)}">Save rate</button></td>
          <td><div class="inline-rate" style="gap:6px"><input class="admin-number-input pid-input" data-product-id="${escapeHtml(product.id)}" type="number" min="1" step="1" value="${escapeHtml(product.id)}" aria-label="Change ID for ${escapeHtml(product.name)}" style="width:64px" /><button class="button button-quiet compact-button pid-save" type="button" data-product-id="${escapeHtml(product.id)}">Save</button></div></td>
          <td><button class="delete-profile" type="button" data-delete-product="${escapeHtml(product.id)}">Delete</button></td>
        </tr>`).join('')
      : '<tr><td colspan="7">No products in the master yet.</td></tr>';
    $('profiles-body').innerHTML = state.profiles.length
      ? state.profiles.map((profile) => `<tr>
          <td><div class="product-cell"><span class="profile-mini">${escapeHtml(initials(profile.name))}</span><span>${escapeHtml(profile.name)}</span></div></td>
          <td class="stock-quiet">#${escapeHtml(profile.id)}</td>
          <td class="price">${currency(profile.current_balance)}</td>
          <td><button class="delete-profile" type="button" data-delete-profile="${escapeHtml(profile.id)}">Delete</button></td>
        </tr>`).join('')
      : '<tr><td colspan="4">No buyer profiles found.</td></tr>';
    $('purchase-product').innerHTML = state.products.length
      ? state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} · ${integer(product.warehouse_stock)} in stock</option>`).join('')
      : '<option value="">Add a product first</option>';
    $('inventory-total-products').textContent = integer(state.products.length);
    const PURCHASE_PAGE_SIZE = 20;
    const purchasesTotalPages = Math.max(1, Math.ceil(state.purchases.length / PURCHASE_PAGE_SIZE));
    state.purchasesPage = Math.min(state.purchasesPage, purchasesTotalPages - 1);
    const purchaseStart = state.purchasesPage * PURCHASE_PAGE_SIZE;
    const purchasePage = state.purchases.slice(purchaseStart, purchaseStart + PURCHASE_PAGE_SIZE);
    $('purchases-body').innerHTML = purchasePage.length
      ? purchasePage.map((purchase) => `<tr>
          <td class="stock-quiet">${dateLabel(purchase.created_at)}</td>
          <td><div class="product-cell"><span>${escapeHtml(purchase.product_name)}</span></div></td>
          <td class="route-stock">+${integer(purchase.qty_added)}</td>
          <td class="stock-quiet">${escapeHtml(purchase.supplier_ref || '—')}</td>
          <td class="price">${integer(purchase.warehouse_stock)}</td>
          <td><button class="delete-profile" type="button" data-delete-purchase="${escapeHtml(purchase.id)}">Delete</button></td>
        </tr>`).join('')
      : '<tr><td colspan="6">No purchases recorded yet.</td></tr>';
    $('purchases-pagination').innerHTML = purchasesTotalPages > 1
      ? `<div class="pagination-controls">
           <button class="page-btn" data-page-target="purchases" data-page-dir="-1" ${state.purchasesPage === 0 ? 'disabled' : ''}>← Prev</button>
           <span class="page-info">Page ${state.purchasesPage + 1} of ${purchasesTotalPages}</span>
           <button class="page-btn" data-page-target="purchases" data-page-dir="1" ${state.purchasesPage >= purchasesTotalPages - 1 ? 'disabled' : ''}>Next →</button>
         </div>`
      : '';
    if ($('adjustments-body')) {
      const ADJ_PAGE_SIZE = 20;
      const adjTotalPages = Math.max(1, Math.ceil(state.adjustments.length / ADJ_PAGE_SIZE));
      state.adjustmentsPage = Math.min(state.adjustmentsPage, adjTotalPages - 1);
      const adjStart = state.adjustmentsPage * ADJ_PAGE_SIZE;
      const adjPage = state.adjustments.slice(adjStart, adjStart + ADJ_PAGE_SIZE);
      $('adjustments-body').innerHTML = adjPage.length
        ? adjPage.map((a) => {
            const delta = Number(a.delta);
            const deltaLabel = delta > 0 ? `+${integer(delta)}` : integer(delta);
            const deltaClass = delta > 0 ? 'route-stock' : delta < 0 ? 'sold' : 'stock-quiet';
            const typeLabel = a.mode === 'set' ? 'Set count' : 'Adjust ±';
            return `<tr>
              <td class="stock-quiet">${dateLabel(a.created_at)} · ${timeLabel(a.created_at)}</td>
              <td><div class="product-cell"><span>${escapeHtml(a.product_name || `Product ${a.product_id}`)}</span></div></td>
              <td class="stock-quiet">${typeLabel}</td>
              <td class="stock-quiet">${integer(a.old_stock)} → <b>${integer(a.new_stock)}</b></td>
              <td class="${deltaClass}">${deltaLabel}</td>
              <td class="stock-quiet">${escapeHtml(a.reason || '—')}</td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="6">No stock corrections recorded yet.</td></tr>';
      $('adjustments-pagination').innerHTML = adjTotalPages > 1
        ? `<div class="pagination-controls">
             <button class="page-btn" data-page-target="adjustments" data-page-dir="-1" ${state.adjustmentsPage === 0 ? 'disabled' : ''}>← Prev</button>
             <span class="page-info">Page ${state.adjustmentsPage + 1} of ${adjTotalPages}</span>
             <button class="page-btn" data-page-target="adjustments" data-page-dir="1" ${state.adjustmentsPage >= adjTotalPages - 1 ? 'disabled' : ''}>Next →</button>
           </div>`
        : '';
    }
    document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== state.adminTab;
    });
    document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.adminTab === state.adminTab);
    });
    if (state.adminTab === 'reports') { renderReport(); renderInventoryReport(); renderProfileStock(); }
    if (state.adminTab === 'payments-report') { renderPaymentsReport(); }
  }

  function renderPaymentsReport() {
    if (!$('pr-days-body')) return;
    // Populate profile select
    const prSel = $('pr-profile-select');
    const prPrev = prSel.value;
    prSel.innerHTML = '<option value="">All profiles</option>' +
      state.profiles.map((p) => `<option value="${escapeHtml(p.id)}"${String(p.id) === prPrev ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

    const loading = state.paymentsReportLoading;
    const data = state.paymentsReportData;
    setHidden('pr-loading', !loading);
    setHidden('pr-empty', loading || !data || (data.days.length > 0));
    setHidden('pr-summary', loading || !data || data.days.length === 0);
    setHidden('pr-days-section', loading || !data || data.days.length === 0);
    setHidden('pr-balances-section', loading || !data);
    if ($('pr-download-csv')) $('pr-download-csv').disabled = !data || data.days.length === 0;
    if (!data || loading) return;

    const { summary, days, balances } = data;

    // Summary strip
    $('pr-total-amount').textContent  = currency(summary.total_payments);
    $('pr-payment-count').textContent = integer(summary.payment_count);
    $('pr-buyer-count').textContent   = integer(summary.buyer_count);

    // Flatten all payment entries newest-first, then paginate 10 per page
    const PR_PAGE_SIZE = 10;
    const allEntries = days.flatMap((day) => day.payments.map((p) => ({ ...p, date: day.date, day_total: day.day_total })));
    const prTotalPages = Math.max(1, Math.ceil(allEntries.length / PR_PAGE_SIZE));
    state.paymentsReportPage = Math.min(state.paymentsReportPage, prTotalPages - 1);
    const prStart = state.paymentsReportPage * PR_PAGE_SIZE;
    const prPage  = allEntries.slice(prStart, prStart + PR_PAGE_SIZE);

    // Render rows, inserting a date-header whenever the date changes
    let lastDate = null;
    const rowsHtml = prPage.length ? prPage.map((p) => {
      let dateRow = '';
      if (p.date !== lastDate) {
        // Compute day total for entries on this date within the full dataset
        const dayTotal = days.find((d) => d.date === p.date)?.day_total ?? 0;
        dateRow = `<tr class="pr-day-header">
          <td colspan="4" class="pr-day-label">${dateLabel(p.date)}</td>
          <td class="price pr-day-total">${currency(dayTotal)}</td>
        </tr>`;
        lastDate = p.date;
      }
      const payRow = `<tr>
        <td class="stock-quiet"></td>
        <td><div class="product-cell"><span class="profile-mini">${escapeHtml(p.buyer_name.slice(0,2).toUpperCase())}</span><span>${escapeHtml(p.buyer_name)}</span></div></td>
        <td class="stock-quiet">${escapeHtml(p.method)}</td>
        <td class="stock-quiet">${escapeHtml(p.label_info || '—')}</td>
        <td class="price">${currency(p.amount)}</td>
      </tr>`;
      return dateRow + payRow;
    }).join('') : '<tr><td colspan="5">No payments in this period.</td></tr>';
    $('pr-days-body').innerHTML = rowsHtml;

    $('pr-days-pagination').innerHTML = prTotalPages > 1
      ? `<div class="pagination-controls">
           <button class="page-btn" data-page-target="pr-days" data-page-dir="-1" ${state.paymentsReportPage === 0 ? 'disabled' : ''}>← Prev</button>
           <span class="page-info">Page ${state.paymentsReportPage + 1} of ${prTotalPages} &nbsp;·&nbsp; ${allEntries.length} entries</span>
           <button class="page-btn" data-page-target="pr-days" data-page-dir="1" ${state.paymentsReportPage >= prTotalPages - 1 ? 'disabled' : ''}>Next →</button>
         </div>`
      : '';

    // Balances table
    $('pr-balances-body').innerHTML = balances.length ? balances.map((b) => {
      const balClass = Number(b.current_balance) > 0 ? 'price' : Number(b.current_balance) < 0 ? 'route-stock' : 'stock-quiet';
      return `<tr>
        <td><div class="product-cell"><span class="profile-mini">${escapeHtml(b.name.slice(0,2).toUpperCase())}</span><span>${escapeHtml(b.name)}</span></div></td>
        <td class="${balClass}">${currency(b.current_balance)}</td>
        <td class="stock-quiet">${b.last_settled ? dateLabel(b.last_settled) : '—'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="3">No buyer profiles found.</td></tr>';
  }

  async function loadPaymentsReport() {
    if (!$('pr-days-body')) return;
    const from = $('pr-from').value || firstOfMonth();
    const to   = $('pr-to').value   || todayIso();
    const profileId = $('pr-profile-select').value;
    const params = new URLSearchParams({ from, to });
    if (profileId) params.set('profileId', profileId);
    state.paymentsReportLoading = true;
    state.paymentsReportData = null;
    state.paymentsReportPage = 0;
    renderPaymentsReport();
    try {
      state.paymentsReportData = await request(`/api/reports/payments?${params}`);
    } catch (error) {
      adminMessage(error.message, true);
      state.paymentsReportData = null;
    } finally {
      state.paymentsReportLoading = false;
      renderPaymentsReport();
    }
  }

  function downloadPaymentsReportCsv() {
    if (!state.paymentsReportData) return;
    const { filters, summary, days, balances } = state.paymentsReportData;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const rows = [
      [q('Payments Received Report')],
      [q('Period'), q(`${filters.from} to ${filters.to}`)],
      [''],
      [q('SUMMARY')],
      [q('Total Received'), q('Payment Entries'), q('Buyers')].join(','),
      [q(summary.total_payments), q(summary.payment_count), q(summary.buyer_count)].join(','),
      [''],
      [q('DAY-WISE PAYMENTS')],
      [q('Date'), q('Buyer'), q('Method'), q('Reference'), q('Amount')].join(','),
    ];
    for (const day of days) {
      for (const p of day.payments) {
        rows.push([q(day.date), q(p.buyer_name), q(p.method), q(p.label_info || ''), q(p.amount)].join(','));
      }
    }
    rows.push([''], [q('CURRENT OUTSTANDING BALANCES')]);
    rows.push([q('Buyer'), q('Current Balance'), q('Last Settled')].join(','));
    for (const b of balances) {
      rows.push([q(b.name), q(b.current_balance), q(b.last_settled || '')].join(','));
    }
    downloadCsvBlob(rows.join('\n'), `payments-report-${filters.from}-to-${filters.to}.csv`);
    toast('Payments report downloaded.');
  }

  function renderReport() {
    if (!$('report-products-body')) return;
    // Populate profile select (preserve current selection)
    const profileSelect = $('report-profile-select');
    const prevVal = profileSelect.value;
    profileSelect.innerHTML = '<option value="">All profiles</option>' +
      state.profiles.map((p) => `<option value="${escapeHtml(p.id)}"${String(p.id) === prevVal ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

    const loading = state.reportLoading;
    const data = state.reportData;

    const hasResults = Boolean(data) && data.summary.session_count > 0;
    setHidden('report-loading', !loading);
    setHidden('report-empty', loading || hasResults || !data);
    setHidden('report-summary', !hasResults);
    setHidden('report-products-section', !hasResults);
    setHidden('report-buyer-section', !hasResults || data.filters.profileId !== null);
    $('report-download-csv').disabled = !hasResults;

    if (!hasResults || loading) return;

    // Summary strip
    $('rep-session-count').textContent = integer(data.summary.session_count);
    $('rep-total-sales').textContent = currency(data.summary.total_sales);
    $('rep-total-payments').textContent = currency(data.summary.total_payments);

    // Product-wise table
    const totalRev = data.summary.total_sales || 1;
    $('report-products-body').innerHTML = data.products.length
      ? data.products.map((p, i) => {
          const pct = totalRev > 0 ? ((p.total_revenue / totalRev) * 100).toFixed(1) : '0.0';
          const barW = Math.max(2, Math.round((p.total_revenue / totalRev) * 100));
          return `<tr>
            <td><div class="product-cell"><span class="product-index">${String(i + 1).padStart(2, '0')}</span><span>${escapeHtml(p.product_name)}</span></div></td>
            <td class="price">${currency(p.current_price)}</td>
            <td class="stock-quiet">${integer(p.session_count)}</td>
            <td class="route-stock">${integer(p.total_qty_sold)}</td>
            <td class="price">${currency(p.total_revenue)}</td>
            <td><div class="pct-bar"><div class="pct-fill" style="width:${barW}%"></div><span>${pct}%</span></div></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6">No product sales in this period.</td></tr>';

    // Buyer breakdown table (all-profiles view only)
    if (data.byBuyer.length) {
      $('report-buyer-body').innerHTML = data.byBuyer.map((b) => {
        const netDue = roundMoney(b.total_sales - b.total_payments);
        return `<tr>
          <td><div class="product-cell"><span class="profile-mini">${escapeHtml(initials(b.buyer_name))}</span><span>${escapeHtml(b.buyer_name)}</span></div></td>
          <td class="stock-quiet">${integer(b.session_count)}</td>
          <td class="price">${currency(b.total_sales)}</td>
          <td class="price">${currency(b.total_payments)}</td>
          <td class="price${netDue > 0 ? ' report-due-positive' : ''}">${currency(netDue)}</td>
        </tr>`;
      }).join('');
    }
  }

  function downloadReportCsv() {
    if (!state.reportData) return;
    const { filters, summary, products, byBuyer } = state.reportData;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const profileLabel = filters.profileId
      ? (state.profiles.find((p) => Number(p.id) === Number(filters.profileId))?.name || `Profile ${filters.profileId}`)
      : 'All Profiles';
    const totalRev = summary.total_sales || 1;
    let csv = [
      `${q('Sales Report')}`,
      `${q('Period')},${q(`${filters.from} to ${filters.to}`)}`,
      `${q('Buyer')},${q(profileLabel)}`,
      '',
      `${q('SUMMARY')}`,
      `${q('Settled Sessions')},${q('Total Sales')},${q('Total Payments')}`,
      `${q(summary.session_count)},${q(summary.total_sales)},${q(summary.total_payments)}`,
      '',
      `${q('PRODUCT-WISE SALES')}`,
      [q('Product'), q('Unit Price'), q('Sessions'), q('Qty Sold'), q('Revenue'), q('% of Total')].join(','),
      ...products.map((p) => {
        const pct = `${((p.total_revenue / totalRev) * 100).toFixed(1)}%`;
        return [q(p.product_name), q(p.current_price), q(p.session_count), q(p.total_qty_sold), q(p.total_revenue), q(pct)].join(',');
      }),
    ];
    if (byBuyer.length) {
      csv = csv.concat([
        '',
        `${q('BUYER BREAKDOWN')}`,
        [q('Buyer'), q('Sessions'), q('Total Sales'), q('Payments Received'), q('Net Due')].join(','),
        ...byBuyer.map((b) => {
          const netDue = roundMoney(b.total_sales - b.total_payments);
          return [q(b.buyer_name), q(b.session_count), q(b.total_sales), q(b.total_payments), q(netDue)].join(',');
        }),
      ]);
    }
    const blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sales-report-${filters.from}-to-${filters.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast('Report downloaded as CSV.');
  }

  function downloadCsvBlob(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    URL.revokeObjectURL(url);
  }

  function renderInventoryReport() {
    if (!$('inv-bills-body')) return;
    const loading = state.inventoryLoading;
    const data = state.inventoryData;

    setHidden('inv-loading', !loading);
    const hasBills = Boolean(data) && data.bills.length > 0;
    setHidden('inv-bills-section', loading || !hasBills);
    setHidden('inv-stock-section', loading || !data);
    $('inv-bills-download-csv').disabled = !hasBills;

    if (!data || loading) return;

    // Movement log table — paginated 5 per page
    const INV_PAGE_SIZE = 5;
    const invTotalPages = hasBills ? Math.max(1, Math.ceil(data.bills.length / INV_PAGE_SIZE)) : 1;
    state.invBillsPage = Math.min(state.invBillsPage, invTotalPages - 1);
    const invStart = state.invBillsPage * INV_PAGE_SIZE;
    const invPage  = hasBills ? data.bills.slice(invStart, invStart + INV_PAGE_SIZE) : [];
    $('inv-bills-body').innerHTML = invPage.length
      ? invPage.map((b) => {
          const isPurchase = b.entry_type === 'purchase';
          const typeBadge = isPurchase
            ? '<span class="inv-entry-badge purchase">PURCHASE</span>'
            : '<span class="inv-entry-badge return">RETURN</span>';
          const ref = isPurchase
            ? escapeHtml(b.ref || `#${b.id}`)
            : `<span class="stock-quiet">From: ${escapeHtml(b.buyer_name)}</span>`;
          const qty = isPurchase
            ? `<span class="route-stock">+${integer(b.qty)}</span>`
            : `<span class="inv-return-qty">+${integer(b.qty)}</span>`;
          return `<tr>
            <td>${typeBadge}</td>
            <td class="stock-quiet">${ref}</td>
            <td class="stock-quiet">${dateLabel(b.created_at)}</td>
            <td><div class="product-cell"><span>${escapeHtml(b.product_name)}</span></div></td>
            <td>${qty}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="5">No inventory movements in this date range.</td></tr>';
    $('inv-bills-pagination').innerHTML = invTotalPages > 1
      ? `<div class="pagination-controls">
           <button class="page-btn" data-page-target="inv-bills" data-page-dir="-1" ${state.invBillsPage === 0 ? 'disabled' : ''}>← Prev</button>
           <span class="page-info">Page ${state.invBillsPage + 1} of ${invTotalPages}</span>
           <button class="page-btn" data-page-target="inv-bills" data-page-dir="1" ${state.invBillsPage >= invTotalPages - 1 ? 'disabled' : ''}>Next →</button>
         </div>`
      : '';

    // Live inventory table
    $('inv-stock-body').innerHTML = data.inventory.length
      ? data.inventory.map((p, i) => {
          const stock = p.warehouse_stock;
          const [badgeClass, badgeLabel] = stock === 0 ? ['empty', 'Out of stock'] : stock < 10 ? ['low', 'Low stock'] : ['ok', 'In stock'];
          return `<tr>
            <td><div class="product-cell"><span class="product-index">${String(i + 1).padStart(2, '0')}</span><span>${escapeHtml(p.name)}</span></div></td>
            <td class="route-stock">${integer(stock)}</td>
            <td class="price">${currency(p.unit_price)}</td>
            <td><span class="inv-stock-badge ${badgeClass}">${badgeLabel}</span></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4">No products in catalogue.</td></tr>';
  }

  async function loadInventoryReport() {
    if (!$('inv-bills-body')) return;
    const from = $('inv-report-from').value || firstOfMonth();
    const to   = $('inv-report-to').value   || todayIso();
    const params = new URLSearchParams({ from, to });
    state.inventoryLoading = true;
    state.invBillsPage = 0;
    renderInventoryReport();
    try {
      state.inventoryData = await request(`/api/reports/inventory?${params}`);
    } catch (error) {
      adminMessage(error.message, true);
      state.inventoryData = null;
    } finally {
      state.inventoryLoading = false;
      renderInventoryReport();
    }
  }

  function downloadBillsCsv() {
    if (!state.inventoryData?.bills?.length) return;
    const { filters, bills } = state.inventoryData;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csv = [
      `${q('Inventory Movement Log')}`,
      `${q('Period')},${q(`${filters.from} to ${filters.to}`)}`,
      '',
      [q('Type'), q('Reference / Buyer'), q('Date'), q('Product'), q('Quantity')].join(','),
      ...bills.map((b) => {
        const isPurchase = b.entry_type === 'purchase';
        return [
          q(isPurchase ? 'Purchase' : 'Return'),
          q(isPurchase ? (b.ref || `#${b.id}`) : b.buyer_name),
          q(dateLabel(b.created_at)),
          q(b.product_name),
          q(b.qty),
        ].join(',');
      }),
    ].join('\n');
    downloadCsvBlob(csv, `inventory-log-${filters.from}-to-${filters.to}.csv`);
    toast('Inventory log downloaded.');
  }

  function downloadInventoryCsv() {
    if (!state.inventoryData?.inventory) return;
    const { inventory } = state.inventoryData;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csv = [
      `${q('Live Inventory Report')}`,
      `${q('As of')},${q(todayIso())}`,
      '',
      [q('Product'), q('Current Stock'), q('Unit Price'), q('Status')].join(','),
      ...inventory.map((p) => {
        const status = p.warehouse_stock === 0 ? 'Out of stock' : p.warehouse_stock < 10 ? 'Low stock' : 'In stock';
        return [q(p.name), q(p.warehouse_stock), q(p.unit_price), q(status)].join(',');
      }),
    ].join('\n');
    downloadCsvBlob(csv, `live-inventory-${todayIso()}.csv`);
    toast('Live inventory report downloaded.');
  }

  function renderProfileStock() {
    if (!$('profile-stock-body')) return;
    const loading = state.profileStockLoading;
    const data = state.profileStockData;
    setHidden('profile-stock-section', loading || !data);
    if (!data || loading) return;

    const { profiles } = data;
    if (!profiles.length) {
      $('profile-stock-body').innerHTML = '<p class="report-status-msg">No buyer profiles found.</p>';
      return;
    }

    // Populate dropdown (preserve current selection)
    const filterEl = $('profile-stock-filter');
    const currentVal = filterEl.value;
    filterEl.innerHTML = '<option value="">All profiles</option>' +
      profiles.map((p) => `<option value="${p.profile_id}"${String(p.profile_id) === currentVal ? ' selected' : ''}>${escapeHtml(p.buyer_name)}</option>`).join('');

    // Filter to selected profile (or show all)
    const selectedId = filterEl.value;
    const visible = selectedId ? profiles.filter((p) => String(p.profile_id) === selectedId) : profiles;

    $('profile-stock-body').innerHTML = visible.map((profile) => {
      const statusBadge = profile.status === 'IN_PROGRESS'
        ? '<span class="workflow-badge in-progress">IN PROGRESS</span>'
        : profile.status === 'SETTLED'
          ? '<span class="workflow-badge settled">SETTLED</span>'
          : '<span class="workflow-badge">NO SESSION</span>';

      const sessionInfo = profile.session_date
        ? `Last route: ${dateLabel(profile.session_date)} ${statusBadge}`
        : 'No route sessions yet';

      const totalOnHand = profile.products.reduce((sum, p) => sum + p.closing_stock, 0);

      const productRows = profile.products.length
        ? profile.products.map((p) => `
            <tr>
              <td><span class="product-cell"><span>${escapeHtml(p.product_name)}</span></span></td>
              <td class="stock-quiet">${integer(p.opening_stock)}</td>
              <td class="stock-quiet">${integer(p.loaded_stock)}</td>
              <td class="sold">${integer(p.qty_sold)}</td>
              <td class="route-stock">${integer(p.closing_stock)}</td>
            </tr>`).join('')
        : '<tr><td colspan="5">No products on this route.</td></tr>';

      return `
        <div class="profile-stock-card">
          <div class="profile-stock-card-header">
            <div class="profile-stock-card-title">
              <span class="buyer-avatar">${escapeHtml(profile.buyer_name.slice(0, 2).toUpperCase())}</span>
              <div>
                <strong>${escapeHtml(profile.buyer_name)}</strong>
                <span class="profile-stock-meta">${sessionInfo}</span>
              </div>
            </div>
            <div class="profile-stock-total">
              <span class="stock-quiet">Total on hand</span>
              <strong class="route-stock">${integer(totalOnHand)} units</strong>
            </div>
          </div>
          <div class="table-shell">
            <table class="route-table admin-table">
              <thead><tr><th>PRODUCT</th><th>OPENING</th><th>LOADED</th><th>SOLD</th><th>ON HAND</th></tr></thead>
              <tbody>${productRows}</tbody>
            </table>
          </div>
        </div>`;
    }).join('');
  }

  async function loadProfileStock() {
    if (!$('profile-stock-body')) return;
    state.profileStockLoading = true;
    renderProfileStock();
    try {
      state.profileStockData = await request('/api/reports/profile-stock');
    } catch (error) {
      adminMessage(error.message, true);
      state.profileStockData = null;
    } finally {
      state.profileStockLoading = false;
      renderProfileStock();
    }
  }

  function downloadProfileStockCsv() {
    if (!state.profileStockData?.profiles) return;
    const { profiles } = state.profileStockData;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const rows = [
      [q('Profile-wise Stock on Hand Report')],
      [q('As of'), q(todayIso())],
      [''],
      [q('Buyer'), q('Last Session Date'), q('Status'), q('Product'), q('Opening'), q('Loaded'), q('Sold'), q('On Hand')].join(','),
    ];
    for (const profile of profiles) {
      for (const p of profile.products) {
        rows.push([
          q(profile.buyer_name),
          q(profile.session_date || '—'),
          q(profile.status || 'NO SESSION'),
          q(p.product_name),
          q(p.opening_stock),
          q(p.loaded_stock),
          q(p.qty_sold),
          q(p.closing_stock),
        ].join(','));
      }
      if (!profile.products.length) {
        rows.push([q(profile.buyer_name), q(profile.session_date || '—'), q(profile.status || 'NO SESSION'), q('—'), q(0), q(0), q(0), q(0)].join(','));
      }
    }
    downloadCsvBlob(rows.join('\n'), `profile-stock-on-hand-${todayIso()}.csv`);
    toast('Profile stock report downloaded.');
  }

  // ── Settlement Report ──────────────────────────────────────────────────
  function renderSettlement() {
    const loading = state.settlementLoading;
    const data    = state.settlementData;

    // Populate profile select
    const profileSelect = $('settle-profile-select');
    const currentVal = profileSelect.value;
    profileSelect.innerHTML = '<option value="">All profiles</option>' +
      state.profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    if (currentVal) profileSelect.value = currentVal;

    setHidden('settle-loading', !loading);
    if (!data || loading) {
      setHidden('settle-empty', true);
      setHidden('settle-main', true);
      $('settle-download-csv').disabled = true;
      return;
    }
    const { sessions } = data;
    if (!sessions.length) {
      setHidden('settle-empty', false);
      setHidden('settle-main', true);
      $('settle-download-csv').disabled = true;
      return;
    }
    setHidden('settle-empty', true);
    setHidden('settle-main', false);
    $('settle-download-csv').disabled = false;

    const PAGE_SIZE = 5;
    const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
    state.settlementPage = Math.min(state.settlementPage, totalPages - 1);
    const pageStart = state.settlementPage * PAGE_SIZE;
    const pageSessions = sessions.slice(pageStart, pageStart + PAGE_SIZE);

    const globalIdx = Math.min(state.selectedSettlementIdx, sessions.length - 1);
    state.selectedSettlementIdx = globalIdx;

    const pageCards = pageSessions.map((s, i) => {
      const globalI = pageStart + i;
      return `<button class="settle-session-card ${globalI === globalIdx ? 'active' : ''}" type="button" data-settle-idx="${globalI}">
        <div class="settle-session-card-body">
          <span class="settle-session-buyer">${escapeHtml(s.buyer_name)}</span>
          <span class="settle-session-date">${dateLabel(s.date)}</span>
        </div>
        <span class="settle-session-sales">${currency(s.total_sales)}</span>
      </button>`;
    }).join('');

    const pagination = totalPages > 1 ? `
      <div class="pagination-controls">
        <button class="page-btn" data-page-target="settlement" data-page-dir="-1" ${state.settlementPage === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="page-info">${state.settlementPage + 1} / ${totalPages}</span>
        <button class="page-btn" data-page-target="settlement" data-page-dir="1" ${state.settlementPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
      </div>` : '';

    $('settle-session-list').innerHTML = pageCards + pagination;

    renderSettlementDetail(sessions[globalIdx]);
  }

  function renderSettlementDetail(session) {
    const products = session.items;
    $('settle-detail-title').textContent = `${session.buyer_name} · ${dateLabel(session.date)}`;
    if (!products.length) {
      $('settle-pivot-head').innerHTML = '';
      $('settle-pivot-body').innerHTML = '<tr><td>No product data found.</td></tr>';
      $('settle-payments-list').innerHTML = '';
      $('settle-balance-strip').innerHTML = '';
      return;
    }

    // Pivot table header: PRODUCT | Total Dispatch | Closing Stock | Qty Sold | Unit Price | Total (₹)
    $('settle-pivot-head').innerHTML = `<tr>
      <th class="pivot-label-col">PRODUCT</th>
      <th>TOTAL DISPATCH</th>
      <th>CLOSING STOCK</th>
      <th>QTY SOLD</th>
      <th>UNIT PRICE</th>
      <th class="pivot-total-col">TOTAL (₹)</th>
    </tr>`;

    const totalDispatch = products.reduce((s, p) => s + Number(p.dispatch), 0);
    const totalClosing  = products.reduce((s, p) => s + Number(p.closing_stock), 0);
    const totalSold     = products.reduce((s, p) => s + Number(p.qty_sold), 0);
    const totalRevenue  = products.reduce((s, p) => s + Number(p.line_total), 0);

    const productRows = products.map((p) => `
      <tr>
        <td class="pivot-label-col">${escapeHtml(p.product_name)}</td>
        <td class="route-stock">${integer(p.dispatch)}</td>
        <td class="route-stock">${integer(p.closing_stock)}</td>
        <td class="route-stock">${integer(p.qty_sold)}</td>
        <td class="price">${currency(p.unit_price)}</td>
        <td class="pivot-total price">${currency(p.line_total)}</td>
      </tr>`).join('');

    const totalRow = `
      <tr class="pivot-highlight">
        <td class="pivot-label-col">TOTAL</td>
        <td class="route-stock">${integer(totalDispatch)}</td>
        <td class="route-stock">${integer(totalClosing)}</td>
        <td class="route-stock">${integer(totalSold)}</td>
        <td class="price">—</td>
        <td class="pivot-total price">${currency(totalRevenue)}</td>
      </tr>`;

    $('settle-pivot-body').innerHTML = productRows + totalRow;

    // Payments
    const payments = session.payments;
    $('settle-payments-list').innerHTML = payments.length
      ? `<div class="table-shell"><table class="route-table admin-table">
           <thead><tr><th>METHOD</th><th>REFERENCE</th><th>AMOUNT</th></tr></thead>
           <tbody>${payments.map((p) => `
             <tr>
               <td>${escapeHtml(p.method)}</td>
               <td class="stock-quiet">${escapeHtml(p.label_info || '—')}</td>
               <td class="price">${currency(p.amount)}</td>
             </tr>`).join('')}
           </tbody>
         </table></div>`
      : '<p class="report-status-msg" style="padding:12px 0">No payments recorded for this session.</p>';

    $('settle-balance-strip').innerHTML = `
      <div class="settle-balance-row">
        <div class="settle-bal-stat"><span>Previous Balance</span><strong>${currency(session.prev_balance)}</strong></div>
        <div class="settle-bal-stat"><span>Total Sales</span><strong>${currency(session.total_sales)}</strong></div>
        <div class="settle-bal-stat"><span>Payments Received</span><strong>${currency(session.total_payments)}</strong></div>
        <div class="settle-bal-stat settle-bal-highlight"><span>Updated Balance</span><strong>${currency(session.updated_balance)}</strong></div>
      </div>`;
  }

  async function loadSettlement() {
    const profileId = $('settle-profile-select').value || '';
    const from = $('settle-from').value || firstOfMonth();
    const to   = $('settle-to').value   || todayIso();
    const params = new URLSearchParams({ from, to });
    if (profileId) params.set('profileId', profileId);
    state.settlementLoading = true;
    state.settlementPage = 0;
    state.selectedSettlementIdx = 0;
    renderSettlement();
    try {
      state.settlementData = await request(`/api/reports/settlement?${params}`);
      state.selectedSettlementIdx = 0;
    } catch {
      state.settlementData = null;
    } finally {
      state.settlementLoading = false;
      renderSettlement();
    }
  }

  function downloadSettlementCsv() {
    if (!state.settlementData?.sessions?.length) return;
    const session  = state.settlementData.sessions[state.selectedSettlementIdx];
    if (!session) return;
    const products = session.items;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const rows = [];
    rows.push([q('Settlement Report'), q(session.buyer_name), q(session.date)].join(','));
    rows.push('');
    rows.push([q('METRIC'), ...products.map((p) => q(p.product_name)), q('TOTAL')].join(','));
    const totalDispatch = products.reduce((s, p) => s + Number(p.dispatch), 0);
    const totalClosing  = products.reduce((s, p) => s + Number(p.closing_stock), 0);
    const totalSold     = products.reduce((s, p) => s + Number(p.qty_sold), 0);
    const totalRevenue  = roundMoney(products.reduce((s, p) => s + Number(p.line_total), 0));
    [
      ['Total Dispatch', products.map((p) => p.dispatch),      totalDispatch],
      ['Closing Stock',  products.map((p) => p.closing_stock), totalClosing],
      ['Qty Sold',       products.map((p) => p.qty_sold),      totalSold],
      ['Unit Price',     products.map((p) => Number(p.unit_price).toFixed(2)), '—'],
      ['Total (₹)',      products.map((p) => Number(p.line_total).toFixed(2)), totalRevenue.toFixed(2)],
    ].forEach(([label, vals, total]) => rows.push([q(label), ...vals.map(q), q(total)].join(',')));
    rows.push('');
    rows.push(q('Payments'));
    rows.push([q('Method'), q('Reference'), q('Amount')].join(','));
    session.payments.forEach((p) => rows.push([q(p.method), q(p.label_info || ''), q(Number(p.amount).toFixed(2))].join(',')));
    rows.push('');
    rows.push([q('Previous Balance'),  q(Number(session.prev_balance).toFixed(2))].join(','));
    rows.push([q('Total Sales'),       q(Number(session.total_sales).toFixed(2))].join(','));
    rows.push([q('Payments Received'), q(Number(session.total_payments).toFixed(2))].join(','));
    rows.push([q('Updated Balance'),   q(Number(session.updated_balance).toFixed(2))].join(','));
    downloadCsvBlob(rows.join('\n'), `settlement-${session.buyer_name.replace(/\s+/g, '-')}-${session.date}.csv`);
    toast('Settlement report downloaded.');
  }
  // ── End Settlement Report ──────────────────────────────────────────────

  function renderPerformance() {
    if (!$('perf-loading')) return;
    const loading  = state.performanceLoading;
    const data     = state.performanceData;
    const hasData  = Boolean(data) && data.summary.session_count > 0;

    setHidden('perf-loading', !loading);
    setHidden('perf-empty',   loading || hasData || !data);
    setHidden('perf-summary', loading || !hasData);
    setHidden('perf-table-section', loading || !hasData);
    $('perf-download-csv').disabled = !hasData;

    // Populate profile dropdown (preserve selection)
    const sel = $('perf-profile-select');
    const curVal = sel.value;
    if (state.profiles?.length) {
      sel.innerHTML = '<option value="">All profiles</option>' +
        state.profiles.map((p) => `<option value="${p.id}"${String(p.id) === curVal ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    }

    if (!data || loading) return;

    const { summary, rows, filters } = data;
    const isSingle = filters.profileId !== null;

    $('perf-stat-sessions').textContent = integer(summary.session_count);
    $('perf-stat-qty').textContent      = integer(summary.total_qty);
    $('perf-stat-revenue').textContent  = currency(summary.total_revenue);
    $('perf-table-title').textContent   = isSingle
      ? (state.profiles?.find((p) => String(p.id) === String(filters.profileId))?.name ?? 'Profile') + ' — product breakdown'
      : 'Profile performance comparison';

    setHidden('perf-profiles-view', isSingle);
    setHidden('perf-single-view',  !isSingle);

    if (isSingle) {
      // Product rows for one profile
      const maxQty = Math.max(1, ...rows.map((r) => r.total_qty));
      $('perf-single-body').innerHTML = rows.length
        ? rows.map((r, i) => {
            const pct = summary.total_qty > 0 ? Math.round((r.total_qty / summary.total_qty) * 100) : 0;
            const rank = r.total_qty > 0 ? `<span class="perf-rank">${String(i + 1).padStart(2, '0')}</span>` : '<span class="perf-rank perf-rank-zero">—</span>';
            return `<tr>
              <td><div class="product-cell">${rank}<span>${escapeHtml(r.product_name)}</span></div></td>
              <td class="stock-quiet">${integer(r.session_count)}</td>
              <td class="route-stock">${integer(r.total_qty)}</td>
              <td class="price">${currency(r.total_revenue)}</td>
              <td><div class="perf-bar-cell"><div class="pct-bar"><div class="pct-fill" style="width:${Math.round((r.total_qty / maxQty) * 100)}%"></div></div><span class="pct-label">${pct}%</span></div></td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="5">No sales data for this profile.</td></tr>';
    } else {
      // All-profile comparison table
      const maxQty = Math.max(1, ...rows.map((r) => r.total_qty));
      const grandQty = summary.total_qty || 1;
      $('perf-profiles-body').innerHTML = rows.length
        ? rows.map((r, i) => {
            const pct = Math.round((r.total_qty / grandQty) * 100);
            const rank = r.total_qty > 0 ? `<span class="perf-rank">${String(i + 1).padStart(2, '0')}</span>` : '<span class="perf-rank perf-rank-zero">—</span>';
            return `<tr>
              <td><div class="product-cell">${rank}<span>${escapeHtml(r.buyer_name)}</span></div></td>
              <td class="stock-quiet">${integer(r.session_count)}</td>
              <td class="route-stock">${integer(r.total_qty)}</td>
              <td class="price">${currency(r.total_revenue)}</td>
              <td><div class="perf-bar-cell"><div class="pct-bar"><div class="pct-fill" style="width:${Math.round((r.total_qty / maxQty) * 100)}%"></div></div><span class="pct-label">${pct}%</span></div></td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="5">No sales data for this period.</td></tr>';

      // Product breakdown cards for each profile below the main table
      $('perf-profiles-products').innerHTML = rows
        .filter((r) => r.products?.length > 0 && r.total_qty > 0)
        .map((r) => `
          <div class="perf-profile-products-card">
            <div class="perf-profile-products-title">
              <span class="buyer-avatar">${escapeHtml(r.buyer_name.slice(0, 2).toUpperCase())}</span>
              <span><strong>${escapeHtml(r.buyer_name)}</strong> — top products</span>
            </div>
            <div class="table-shell">
              <table class="route-table admin-table">
                <thead><tr><th>PRODUCT</th><th>QTY SOLD</th><th>REVENUE</th></tr></thead>
                <tbody>${r.products.slice(0, 5).map((p) => `
                  <tr>
                    <td>${escapeHtml(p.product_name)}</td>
                    <td class="route-stock">${integer(p.total_qty)}</td>
                    <td class="price">${currency(p.total_revenue)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>`).join('');
    }
  }

  async function loadPerformance() {
    if (!$('perf-loading')) return;
    const from      = $('perf-from').value || firstOfMonth();
    const to        = $('perf-to').value   || todayIso();
    const profileId = $('perf-profile-select').value;
    const params    = new URLSearchParams({ from, to });
    if (profileId) params.set('profileId', profileId);
    state.performanceLoading = true;
    renderPerformance();
    try {
      state.performanceData = await request(`/api/reports/performance?${params}`);
    } catch (error) {
      adminMessage(error.message, true);
      state.performanceData = null;
    } finally {
      state.performanceLoading = false;
      renderPerformance();
    }
  }

  function downloadPerformanceCsv() {
    if (!state.performanceData) return;
    const { filters, rows, summary } = state.performanceData;
    const isSingle = filters.profileId !== null;
    const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const profileName = isSingle
      ? state.profiles?.find((p) => String(p.id) === String(filters.profileId))?.name ?? `Profile ${filters.profileId}`
      : 'All profiles';
    const csvRows = [
      [q('Performance Report')],
      [q('Profile'), q(profileName)],
      [q('Period'),  q(`${filters.from} to ${filters.to}`)],
      [q('Total Sessions'), q(summary.session_count), q('Total Qty Sold'), q(summary.total_qty), q('Total Revenue'), q(summary.total_revenue)],
      [''],
    ];
    if (isSingle) {
      csvRows.push([q('Product'), q('Sessions'), q('Qty Sold'), q('Revenue')].join(','));
      for (const r of rows) csvRows.push([q(r.product_name), q(r.session_count), q(r.total_qty), q(r.total_revenue)].join(','));
    } else {
      csvRows.push([q('Buyer'), q('Sessions'), q('Total Qty Sold'), q('Revenue'), q('Top Product'), q('Top Product Qty')].join(','));
      for (const r of rows) {
        const top = r.products?.[0];
        csvRows.push([q(r.buyer_name), q(r.session_count), q(r.total_qty), q(r.total_revenue), q(top?.product_name ?? '—'), q(top?.total_qty ?? 0)].join(','));
      }
    }
    downloadCsvBlob(csvRows.join('\n'), `performance-${filters.from}-to-${filters.to}.csv`);
    toast('Performance report downloaded.');
  }

  async function loadReport() {
    if (!$('report-products-body')) return;
    const from = $('report-from').value || firstOfMonth();
    const to   = $('report-to').value   || todayIso();
    const profileId = $('report-profile-select').value;
    const params = new URLSearchParams({ from, to });
    if (profileId) params.set('profileId', profileId);
    state.reportLoading = true;
    renderReport();
    try {
      state.reportData = await request(`/api/reports/product-sales?${params}`);
    } catch (error) {
      adminMessage(error.message, true);
      state.reportData = null;
    } finally {
      state.reportLoading = false;
      renderReport();
    }
  }

  function renderDashboard() {
    const session = state.session;
    const settled = session.status === 'SETTLED';
    $('previous-balance').textContent = currency(session.prev_balance);
    $('workflow-caption').textContent = session.status || 'IN_PROGRESS';
    $('close-step').classList.toggle('active', settled);
    $('save-closing').disabled = settled;
    $('settle-route').disabled = settled;
    $('save-load').disabled = settled;
    $('add-payment').disabled = settled;
    // Return-stock bar: visible only when settled and at least one product has closing stock > 0
    const hasStockToReturn = settled && state.items.some((i) => Number(i.closing_stock) > 0);
    setHidden('return-stock-bar', !hasStockToReturn);
    // DSR tab active state + section visibility
    document.querySelectorAll('[data-dsr-tab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.dsrTab === state.dsrTab);
      tab.setAttribute('aria-selected', String(tab.dataset.dsrTab === state.dsrTab));
    });
    $('dispatch-section').hidden    = state.dsrTab !== 'dispatch';
    $('closing-section').hidden     = state.dsrTab !== 'closing';
    $('payments-section').hidden    = state.dsrTab === 'performance';
    $('performance-section').hidden = state.dsrTab !== 'performance';
    $('payment-buyer-name').textContent = selectedProfile()?.name || 'this route';
    const itemById = new Map(state.items.map((item) => [Number(item.product_id), item]));
    $('load-body').innerHTML = state.items.length ? state.items.map((item, index) => {
      const draft = Number(state.loadDrafts[item.product_id] || 0);
      const routeStock = Number(item.opening_stock || 0) + Number(item.loaded_stock || 0) + draft;
      return `<tr data-row-product="${escapeHtml(item.product_id)}"><td><div class="product-cell"><span class="product-index">${String(item.product_id).padStart(2, '0')}</span><span>${escapeHtml(item.product_name || `Product ${item.product_id}`)}</span></div></td><td class="stock-quiet">${integer(item.warehouse_stock)}</td><td>${integer(item.opening_stock)}</td><td>${integer(item.loaded_stock)}</td><td><input class="number-input load-input" data-product-id="${escapeHtml(item.product_id)}" type="number" min="0" step="1" value="${draft}" ${settled ? 'disabled' : ''} aria-label="Additional load for ${escapeHtml(item.product_name)}" data-testid="input-load-${escapeHtml(item.product_id)}" /></td><td class="route-stock">${integer(routeStock)}</td><td class="price">${currency(item.unit_price)}</td></tr>`;
    }).join('') : '<tr><td colspan="7">No products are attached to this route.</td></tr>';
    $('closing-body').innerHTML = state.items.length ? state.items.map((item, index) => {
      const routeStock = Number(item.opening_stock || 0) + Number(item.loaded_stock || 0) + Number(state.loadDrafts[item.product_id] || 0);
      const closing = state.closingDrafts[item.product_id] ?? item.closing_stock ?? 0;
      const sold = Math.max(0, routeStock - Number(closing || 0));
      const lineTotal = roundMoney(sold * Number(item.unit_price || 0));
      return `<tr><td><div class="product-cell"><span class="product-index">${String(item.product_id).padStart(2, '0')}</span><span>${escapeHtml(item.product_name || `Product ${item.product_id}`)}</span></div></td><td class="route-stock">${integer(routeStock)}</td><td><input class="number-input closing-input" data-product-id="${escapeHtml(item.product_id)}" type="number" min="0" max="${routeStock}" step="1" value="${closing}" ${settled ? 'disabled' : ''} aria-label="Closing stock for ${escapeHtml(item.product_name)}" data-testid="input-closing-${escapeHtml(item.product_id)}" /></td><td class="sold" data-sold-for="${escapeHtml(item.product_id)}">${integer(sold)}</td><td class="price">${currency(item.unit_price)}</td><td class="price" data-total-for="${escapeHtml(item.product_id)}">${currency(lineTotal)}</td></tr>`;
    }).join('') : '<tr><td colspan="6">No products are attached to this route.</td></tr>';
    renderPayments();
    updateTotals(itemById);
  }

  function updateTotals(itemById = new Map(state.items.map((item) => [Number(item.product_id), item]))) {
    let sales = 0;
    state.items.forEach((item) => {
      const routeStock = Number(item.opening_stock || 0) + Number(item.loaded_stock || 0) + Number(state.loadDrafts[item.product_id] || 0);
      const closing = Number(state.closingDrafts[item.product_id] ?? item.closing_stock ?? 0);
      const sold = Math.max(0, routeStock - closing);
      // Round each line total before accumulating — mirrors server's roundMoney(qty * price) per item.
      const lineTotal = roundMoney(sold * Number(item.unit_price || 0));
      sales += lineTotal;
      const row = document.querySelector(`[data-row-product="${CSS.escape(String(item.product_id))}"]`);
      if (row) row.querySelector('.route-stock').textContent = integer(routeStock);
      const soldCell = document.querySelector(`[data-sold-for="${CSS.escape(String(item.product_id))}"]`);
      const totalCell = document.querySelector(`[data-total-for="${CSS.escape(String(item.product_id))}"]`);
      if (soldCell) soldCell.textContent = integer(sold);
      if (totalCell) totalCell.textContent = currency(lineTotal);
    });
    // Round accumulated total — mirrors server's final roundMoney(totalSales).
    sales = roundMoney(sales);

    const settled = state.session?.status === 'SETTLED';
    // For SETTLED routes use the server-locked values written to the DB; they are authoritative.
    // For IN_PROGRESS, compute live from items/payments so the display updates instantly on input.
    // Note: after saveClosing() drafts are cleared, so `closing` falls back to item.closing_stock
    // (server value), giving the same result as session.total_sales without the "> 0" proxy bug.
    const liveSales    = settled ? roundMoney(Number(state.session.total_sales))    : sales;
    const livePayments = settled
      ? roundMoney(Number(state.session.total_payments))
      : roundMoney(state.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
    const prevBalance  = roundMoney(Number(state.session?.prev_balance || 0));
    const liveBalance  = settled
      ? roundMoney(Number(state.session.updated_balance))
      : roundMoney(prevBalance + liveSales - livePayments);

    $('gross-sales').textContent = currency(liveSales);
    $('payments-received').textContent = currency(livePayments);
    $('payment-count').textContent = integer(state.payments.length);
    $('updated-balance').textContent = currency(liveBalance);
    $('settlement-total').textContent = currency(liveSales);
    $('footer-sales').textContent = currency(liveSales);
    $('footer-previous-balance').textContent = currency(prevBalance);
    $('footer-payments').textContent = currency(livePayments);
    $('footer-balance').textContent = currency(liveBalance);

    // Settle-bar summary (present only in DSR view)
    const sss = $('settle-summary-sales');    if (sss) sss.textContent = currency(liveSales);
    const ssp = $('settle-summary-payments'); if (ssp) ssp.textContent = currency(livePayments);
    const ssb = $('settle-summary-balance');  if (ssb) ssb.textContent = currency(liveBalance);
  }

  function renderPayments() {
    const hasPayments = state.payments.length > 0;
    setHidden('payments-list', !hasPayments);
    setHidden('payments-empty', hasPayments);
    if (!hasPayments) return;
    $('payments-list').innerHTML = state.payments.map((payment) => `<div class="payment-row" data-payment-row="${escapeHtml(payment.id)}"><div class="payment-method">${escapeHtml(payment.method || 'Payment')}<small>${escapeHtml(payment.label_info || 'No reference')}</small></div><div class="payment-label">${escapeHtml(payment.label_info || '—')}</div><div class="payment-date">${dateLabel(payment.created_at)} · ${timeLabel(payment.created_at)}</div><div class="payment-amount">${currency(payment.amount)}</div><button class="delete-payment" type="button" data-delete-payment="${escapeHtml(payment.id)}" title="${state.role === 'Admin' ? 'Delete payment' : 'Admin access required'}" aria-label="Delete payment ${escapeHtml(payment.id)}" ${state.role !== 'Admin' ? 'disabled' : ''} data-testid="button-delete-payment-${escapeHtml(payment.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9 4v6m4-6v6M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button></div>`).join('');
  }

  async function saveLoad() {
    if (!state.session || state.session.status === 'SETTLED') return;
    const items = state.items.map((item) => ({ productId: Number(item.product_id), additionalLoad: Math.max(0, Number(state.loadDrafts[item.product_id] || 0)) }));
    if (items.some((entry) => !Number.isInteger(entry.additionalLoad))) return toast('Load quantities must be whole numbers.', 'error');
    setBusy(true, 'save-load');
    try {
      const payload = await request('/api/dsr/load-in', { method: 'POST', body: JSON.stringify({ buyerId: Number(state.selectedBuyerId), items }) });
      state.loadDrafts = {};
      state.closingDrafts = {};
      hydratePayload(payload);
      toast('Load-in saved. Warehouse counts are updated.');
      announce('Dispatch recorded for this route.');
      render();
    } catch (error) { toast(error.message, 'error'); } finally { setBusy(false, 'save-load'); }
  }

  async function saveClosing() {
    if (!state.session || state.session.status === 'SETTLED') return;
    if (Object.values(state.loadDrafts).some((value) => Number(value) > 0)) {
      return toast('Save the load-in before recording closing stock.', 'error');
    }
    const items = state.items.map((item) => ({
      productId: Number(item.product_id),
      closingStock: Math.max(0, Number(state.closingDrafts[item.product_id] ?? item.closing_stock ?? 0)),
    }));
    const invalid = items.some((entry) => {
      const item = state.items.find((i) => Number(i.product_id) === entry.productId);
      const dispatched = Number(item.opening_stock || 0) + Number(item.loaded_stock || 0);
      return entry.closingStock > dispatched;
    });
    if (invalid) return toast('Closing stock cannot exceed route stock.', 'error');
    setBusy(true, 'save-closing');
    try {
      const payload = await request('/api/dsr/close', { method: 'POST', body: JSON.stringify({ dsrId: Number(state.session.id), items }) });
      hydratePayload(payload);
      state.closingDrafts = {};
      toast('Closing stock saved. Add payments then settle when ready.');
      announce('Closing stock recorded.');
      render();
    } catch (error) { toast(error.message, 'error'); } finally { setBusy(false, 'save-closing'); }
  }

  function openReturnStockModal() {
    if (!state.session || state.session.status !== 'SETTLED') return;
    const stockItems = state.items.filter((i) => Number(i.closing_stock) > 0);
    if (!stockItems.length) return toast('No stock to return for this route.', 'error');
    $('return-stock-buyer-name').textContent = selectedProfile()?.name || 'this route';
    $('return-stock-list').innerHTML = `
      <table class="route-table" style="margin:12px 0">
        <thead><tr><th>PRODUCT</th><th>QTY TO RETURN</th></tr></thead>
        <tbody>${stockItems.map((i) => `
          <tr>
            <td>${escapeHtml(i.product_name)}</td>
            <td class="route-stock">${integer(i.closing_stock)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    setHidden('return-stock-modal', false);
  }

  async function confirmReturnStock() {
    if (!state.session) return;
    setBusy(true, 'confirm-return-stock');
    try {
      const result = await request('/api/dsr/return-stock', {
        method: 'POST',
        body: JSON.stringify({ dsrId: Number(state.session.id) }),
      });
      setHidden('return-stock-modal', true);
      // Reload session so closing stocks update to 0
      const payload = await request(`/api/dsr/session?buyerId=${encodeURIComponent(state.selectedBuyerId)}`);
      hydratePayload(payload);
      render();
      toast(result.message || 'Stock returned to warehouse.');
      // Also refresh profile stock report if it was loaded
      state.profileStockData = null;
      if (state.adminTab === 'reports') loadProfileStock();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false, 'confirm-return-stock');
    }
  }

  async function settleRoute() {
    if (!state.session || state.session.status === 'SETTLED') return;
    if (!window.confirm('Settle this route? This will finalise the ledger balance and cannot be undone.')) return;
    setBusy(true, 'settle-route');
    try {
      const payload = await request('/api/dsr/settle', { method: 'POST', body: JSON.stringify({ dsrId: Number(state.session.id) }) });
      hydratePayload(payload);
      toast('Route settled. Ledger balance updated.');
      announce('Settlement complete.');
      render();
    } catch (error) { toast(error.message, 'error'); } finally { setBusy(false, 'settle-route'); }
  }

  async function submitPayment(event) {
    event.preventDefault();
    if (!state.session || state.session.status === 'SETTLED') return;
    const amount = Number($('payment-amount').value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('Enter a payment amount greater than zero.', 'error');
    setBusy(true);
    try {
      const payment = await request('/api/payments', { method: 'POST', body: JSON.stringify({ dsrId: Number(state.session.id), method: $('payment-method').value, labelInfo: $('payment-label').value.trim(), amount }) });
      state.payments.unshift(payment); // newest first to match DESC query order
      closePayment();
      toast('Payment added to this route.');
      renderPayments();
      updateTotals();
    } catch (error) { toast(error.message, 'error'); } finally { setBusy(false); }
  }

  async function deletePayment(paymentId) {
    if (state.role !== 'Admin') return;
    if (!window.confirm('Delete this payment from the route?')) return;
    try {
      await request(`/api/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', headers: { 'x-user-role': state.role } });
      state.payments = state.payments.filter((p) => String(p.id) !== String(paymentId));
      toast('Payment removed.');
      renderPayments();
      updateTotals();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function submitProduct(event) {
    event.preventDefault();
    const name = $('product-name').value.trim();
    const initialStock = Number($('product-stock').value);
    const unitPrice = Number($('product-price').value);
    if (!name || !Number.isInteger(initialStock) || initialStock < 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      return adminMessage('Enter a product name, whole-number stock, and positive unit price.', true);
    }
    const customIdRaw = $('product-custom-id').value.trim();
    const customId = customIdRaw ? Number(customIdRaw) : null;
    if (customId !== null && (!Number.isInteger(customId) || customId < 1)) {
      return adminMessage('Product ID must be a positive whole number, or leave it blank for auto-assign.', true);
    }
    setBusy(true, 'add-product');
    try {
      const product = await request('/api/products', adminOptions({ method: 'POST', body: JSON.stringify({ name, initialStock, unitPrice, ...(customId !== null && { customId }) }) }));
      state.products.push(product);
      $('product-form').reset();
      renderAdmin();
      adminMessage('Product added to the master.');
      toast('Product master updated.');
      // Refresh the active DSR session so the new product appears in
      // load-in and closing tables without the user switching buyers.
      if (state.selectedBuyerId) await loadSession(state.selectedBuyerId);
    } catch (error) { adminMessage(error.message, true); } finally { setBusy(false, 'add-product'); }
  }

  async function changeProductId(oldId) {
    const input = document.querySelector(`.pid-input[data-product-id="${CSS.escape(String(oldId))}"]`);
    const newId = Number(input?.value);
    if (!Number.isInteger(newId) || newId < 1) return adminMessage('Enter a valid positive whole number for the product ID.', true);
    if (newId === Number(oldId)) return adminMessage('The new ID is the same as the current ID.', true);
    if (!confirm(`Change product ID from ${oldId} → ${newId}?\n\nThis will update all historical records (dispatch, purchases, closing stock). This cannot be undone.`)) return;
    try {
      const product = await request(`/api/products/${encodeURIComponent(oldId)}/product-id`, adminOptions({ method: 'PATCH', body: JSON.stringify({ newId }) }));
      state.products = state.products.map((p) => Number(p.id) === Number(oldId) ? product : p);
      // Also update dsr items in the active session if loaded
      if (state.items) state.items = state.items.map((i) => Number(i.product_id) === Number(oldId) ? { ...i, product_id: product.id } : i);
      renderAdmin();
      if (state.selectedBuyerId) await loadSession(state.selectedBuyerId);
      adminMessage(`Product ID changed to ${newId}.`);
      toast(`Product ID updated to ${newId}.`);
    } catch (error) { adminMessage(error.message, true); }
  }

  async function saveRate(productId) {
    const input = document.querySelector(`.rate-input[data-product-id="${CSS.escape(String(productId))}"]`);
    const unitPrice = Number(input?.value);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return adminMessage('Enter a positive unit price.', true);
    try {
      const product = await request(`/api/products/${encodeURIComponent(productId)}/rate`, adminOptions({ method: 'PATCH', body: JSON.stringify({ unitPrice }) }));
      state.products = state.products.map((item) => Number(item.id) === Number(product.id) ? product : item);
      renderAdmin();
      adminMessage('Rate updated. Future DSR sessions will use the new price.');
      toast('Rate master updated.');
    } catch (error) { adminMessage(error.message, true); }
  }

  async function submitProfile(event) {
    event.preventDefault();
    const name = $('profile-name').value.trim();
    const currentBalance = Number($('profile-balance').value);
    if (!name || !Number.isFinite(currentBalance) || currentBalance < 0) {
      return adminMessage('Enter a buyer name and a non-negative opening balance.', true);
    }
    setBusy(true, 'add-profile');
    try {
      const profile = await request('/api/profiles', adminOptions({ method: 'POST', body: JSON.stringify({ name, currentBalance }) }));
      state.profiles.push(profile);
      $('profile-form').reset();
      $('profile-balance').value = '1250';
      renderAdmin();
      adminMessage('Buyer profile added.');
      toast('Buyer profile created.');
    } catch (error) { adminMessage(error.message, true); } finally { setBusy(false, 'add-profile'); }
  }

  async function deleteProduct(productId) {
    if (!window.confirm('Delete this product?')) return;
    const url = (force) => `/api/products/${encodeURIComponent(productId)}${force ? '?force=true' : ''}`;
    try {
      try {
        await request(url(false), adminOptions({ method: 'DELETE' }));
      } catch (error) {
        if (!/history|dispatch/i.test(error.message)) throw error;
        if (!window.confirm('This product has dispatch history.\n\nFORCE DELETE will permanently remove it AND its purchase, return, and line-item records. This cannot be undone.\n\nContinue?')) {
          adminMessage('Delete cancelled.');
          return;
        }
        await request(url(true), adminOptions({ method: 'DELETE' }));
      }
      state.products = state.products.filter((p) => Number(p.id) !== Number(productId));
      renderAdmin();
      adminMessage('Product deleted.');
      toast('Product removed from master.');
    } catch (error) { adminMessage(error.message, true); }
  }

  async function deletePurchase(purchaseId) {
    if (!window.confirm('Delete this purchase record? The quantity will be reversed from warehouse stock.')) return;
    try {
      await request(`/api/purchases/${encodeURIComponent(purchaseId)}`, adminOptions({ method: 'DELETE' }));
      state.purchases = state.purchases.filter((p) => Number(p.id) !== Number(purchaseId));
      await loadAdminData();
      renderAdmin();
      adminMessage('Purchase record deleted and warehouse stock reversed.');
      toast('Purchase deleted.');
    } catch (error) { adminMessage(error.message, true); }
  }

  async function deleteProfile(profileId) {
    if (!window.confirm('Delete this buyer profile?')) return;
    const url = (force) => `/api/profiles/${encodeURIComponent(profileId)}${force ? '?force=true' : ''}`;
    try {
      try {
        await request(url(false), adminOptions({ method: 'DELETE' }));
      } catch (error) {
        if (!/history/i.test(error.message)) throw error;
        // History-protected: offer a hard force delete with a clear warning.
        if (!window.confirm('This buyer has route history.\n\nFORCE DELETE will permanently remove this buyer AND all of their sessions, payments, and sales history. This cannot be undone.\n\nContinue?')) {
          adminMessage('Delete cancelled.');
          return;
        }
        await request(url(true), adminOptions({ method: 'DELETE' }));
      }
      state.profiles = state.profiles.filter((profile) => Number(profile.id) !== Number(profileId));
      if (Number(state.selectedBuyerId) === Number(profileId)) {
        state.selectedBuyerId = state.profiles[0]?.id ?? null;
        state.session = null;
      }
      renderAdmin();
      render();
      adminMessage('Buyer profile deleted.');
    } catch (error) { adminMessage(error.message, true); }
  }

  async function submitPurchase(event) {
    event.preventDefault();
    const productId = Number($('purchase-product').value);
    const qtyAdded = Number($('purchase-quantity').value);
    const supplierRef = $('purchase-reference').value.trim();
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(qtyAdded) || qtyAdded < 1) {
      return adminMessage('Choose a product and enter a positive whole-number quantity.', true);
    }
    setBusy(true, 'add-purchase');
    try {
      const purchase = await request('/api/inventory/purchase', adminOptions({ method: 'POST', body: JSON.stringify({ productId, qtyAdded, supplierRef }) }));
      state.purchases.unshift(purchase);
      state.products = state.products.map((product) => Number(product.id) === productId ? { ...product, warehouse_stock: purchase.warehouse_stock } : product);
      $('purchase-form').reset();
      renderAdmin();
      adminMessage(`Purchase posted. ${purchase.product_name} stock is now ${integer(purchase.warehouse_stock)}.`);
      toast('Inventory inwarded.');
    } catch (error) { adminMessage(error.message, true); } finally { setBusy(false, 'add-purchase'); }
  }

  function openAdminAuth() {
    $('admin-auth-form').reset();
    setHidden('admin-auth-error', true);
    setHidden('admin-auth-modal', false);
    window.setTimeout(() => $('admin-password-input').focus(), 40);
  }
  function closeAdminAuth() {
    setHidden('admin-auth-modal', true);
    // Ensure dropdown stays on current (non-Admin) role
    $('role-select').value = state.role;
  }
  async function submitAdminAuth(event) {
    event.preventDefault();
    const password = $('admin-password-input').value;
    const btn = $('submit-admin-auth');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    setHidden('admin-auth-error', true);
    try {
      await request('/api/admin/verify', { method: 'POST', body: JSON.stringify({ password }) });
      // Password correct — grant Admin
      state.role = 'Admin';
      $('role-select').value = 'Admin';
      setHidden('admin-auth-modal', true);
      renderPayments();
      render();
      loadAdminData();
      toast('Admin access granted.');
    } catch (_) {
      setHidden('admin-auth-error', false);
      $('admin-password-input').value = '';
      $('admin-password-input').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock admin';
    }
  }

  function openPayment() {
    if (!state.session || state.session.status === 'SETTLED') return;
    $('payment-form').reset();
    setHidden('payment-modal', false);
    window.setTimeout(() => $('payment-amount').focus(), 40);
  }
  function closePayment() { setHidden('payment-modal', true); }

  // ---- Auth / login gate --------------------------------------------------
  function applyRole(role) {
    state.role = role === 'admin' ? 'Admin' : 'Store Manager';
    const chip = $('whoami-role');
    if (chip) chip.textContent = role === 'admin' ? 'Admin' : 'User';
    const sel = $('role-select');
    if (sel) sel.value = state.role;
  }
  function showLogin() {
    setHidden('login-screen', false);
    const pw = $('login-password');
    if (pw) { pw.value = ''; window.setTimeout(() => pw.focus(), 40); }
  }
  async function initAuth() {
    try {
      const me = await request('/api/me');
      applyRole(me.role);
      setHidden('login-screen', true);
      loadProfiles();
    } catch (_) {
      showLogin();
    }
  }
  async function submitLogin(event) {
    event.preventDefault();
    const password = $('login-password').value;
    const btn = $('login-submit');
    btn.disabled = true; btn.textContent = 'Signing in…';
    setHidden('login-error', true);
    try {
      const res = await request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      applyRole(res.role);
      setHidden('login-screen', true);
      loadProfiles();
    } catch (_) {
      setHidden('login-error', false);
      $('login-password').value = '';
      $('login-password').focus();
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }
  async function doLogout() {
    try { await request('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    window.location.reload();
  }

  // ---- Warehouse stock correction ----------------------------------------
  let stockAdjustProductId = null;
  function currentStockMode() {
    const el = document.querySelector('input[name="stock-mode"]:checked');
    return el ? el.value : 'set';
  }
  function updateStockModeUI() {
    const mode = currentStockMode();
    const input = $('stock-adjust-value');
    const product = state.products.find((p) => Number(p.id) === Number(stockAdjustProductId));
    if (mode === 'set') {
      $('stock-value-label').textContent = 'New counted quantity';
      input.min = '0';
      input.placeholder = '';
      if (product) input.value = product.warehouse_stock;
    } else {
      $('stock-value-label').textContent = 'Adjust by (use − to reduce)';
      input.removeAttribute('min');
      input.placeholder = 'e.g. -3';
      input.value = '';
    }
  }
  function openStockAdjust(productId) {
    const product = state.products.find((p) => Number(p.id) === Number(productId));
    if (!product) return;
    stockAdjustProductId = product.id;
    $('stock-adjust-product').textContent = product.name;
    $('stock-adjust-current').textContent = integer(product.warehouse_stock);
    $('stock-adjust-form').reset();
    document.querySelector('input[name="stock-mode"][value="set"]').checked = true;
    $('stock-adjust-reason').value = '';
    updateStockModeUI();
    setHidden('stock-adjust-error', true);
    setHidden('stock-adjust-modal', false);
    window.setTimeout(() => $('stock-adjust-value').focus(), 40);
  }
  function closeStockAdjust() { setHidden('stock-adjust-modal', true); stockAdjustProductId = null; }
  function showStockError(msg) {
    const e = $('stock-adjust-error');
    e.textContent = msg; setHidden('stock-adjust-error', false);
  }
  async function submitStockAdjust(event) {
    event.preventDefault();
    if (stockAdjustProductId == null) return;
    const mode = currentStockMode();
    const value = Number($('stock-adjust-value').value);
    const reason = $('stock-adjust-reason').value.trim();
    if (!Number.isInteger(value)) return showStockError('Enter a whole number.');
    if (mode === 'set' && value < 0) return showStockError('Count cannot be negative.');
    if (mode === 'adjust' && value === 0) return showStockError('Enter a non-zero adjustment.');
    const btn = $('submit-stock-adjust');
    btn.disabled = true; btn.textContent = 'Saving…';
    setHidden('stock-adjust-error', true);
    try {
      const updated = await request(`/api/products/${encodeURIComponent(stockAdjustProductId)}/stock`, adminOptions({
        method: 'PATCH',
        body: JSON.stringify({ mode, value, reason }),
      }));
      closeStockAdjust();
      // Reload so both the product stock and the adjustment history refresh.
      await loadAdminData();
      adminMessage(`Warehouse stock updated to ${integer(updated.warehouse_stock)}.`);
      toast('Warehouse stock corrected.');
    } catch (error) {
      showStockError(error.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  function bindEvents() {
    $('login-form').addEventListener('submit', submitLogin);
    $('logout-btn').addEventListener('click', doLogout);
    $('close-stock-adjust').addEventListener('click', closeStockAdjust);
    $('cancel-stock-adjust').addEventListener('click', closeStockAdjust);
    $('stock-adjust-modal').addEventListener('click', (event) => { if (event.target === $('stock-adjust-modal')) closeStockAdjust(); });
    $('stock-adjust-form').addEventListener('submit', submitStockAdjust);
    document.querySelectorAll('input[name="stock-mode"]').forEach((r) => r.addEventListener('change', updateStockModeUI));
    $('buyer-select').addEventListener('change', (event) => loadSession(event.target.value));
    $('role-select').addEventListener('change', (event) => {
      const chosen = event.target.value;
      if (chosen === 'Admin') {
        // Revert the select immediately; grant access only after password check
        event.target.value = state.role;
        openAdminAuth();
      } else {
        state.role = chosen;
        state.view = 'dsr';
        renderPayments();
        render();
        toast('Switched to Store Manager.');
      }
    });
    $('view-dsr').addEventListener('click', () => { state.view = 'dsr'; render(); });
    $('view-settlement').addEventListener('click', () => {
      state.view = 'settlement';
      render();
      if (!$('settle-from').value) $('settle-from').value = firstOfMonth();
      if (!$('settle-to').value)   $('settle-to').value   = todayIso();
      if (!state.settlementData && !state.settlementLoading) loadSettlement();
    });
    $('view-admin').addEventListener('click', () => {
      if (state.role !== 'Admin') return;
      state.view = 'admin';
      render();
      loadAdminData();
    });
    document.querySelectorAll('[data-admin-tab]').forEach((tab) => tab.addEventListener('click', () => {
      state.adminTab = tab.dataset.adminTab;
      renderAdmin();
      if (tab.dataset.adminTab === 'reports') {
        if (!$('report-from').value)     $('report-from').value     = firstOfMonth();
        if (!$('report-to').value)       $('report-to').value       = todayIso();
        if (!$('inv-report-from').value) $('inv-report-from').value = firstOfMonth();
        if (!$('inv-report-to').value)   $('inv-report-to').value   = todayIso();
        if (!state.reportData && !state.reportLoading) loadReport();
        if (!state.inventoryData && !state.inventoryLoading) loadInventoryReport();
        if (!state.profileStockData && !state.profileStockLoading) loadProfileStock();
      }
      if (tab.dataset.adminTab === 'payments-report') {
        if (!$('pr-from').value) $('pr-from').value = firstOfMonth();
        if (!$('pr-to').value)   $('pr-to').value   = todayIso();
        if (!state.paymentsReportData && !state.paymentsReportLoading) loadPaymentsReport();
      }
    }));
    $('product-form').addEventListener('submit', submitProduct);
    $('profile-form').addEventListener('submit', submitProfile);
    $('purchase-form').addEventListener('submit', submitPurchase);
    $('apply-report-filters').addEventListener('click', loadReport);
    $('report-download-csv').addEventListener('click', downloadReportCsv);
    $('apply-inv-filters').addEventListener('click', loadInventoryReport);
    $('inv-bills-download-csv').addEventListener('click', downloadBillsCsv);
    $('inv-stock-download-csv').addEventListener('click', downloadInventoryCsv);
    $('profile-stock-download-csv').addEventListener('click', downloadProfileStockCsv);
    $('profile-stock-filter').addEventListener('change', renderProfileStock);
    $('perf-profile-select').addEventListener('change', () => { state.performanceData = null; loadPerformance(); });
    $('apply-perf-filters').addEventListener('click', () => { state.performanceData = null; loadPerformance(); });
    $('perf-download-csv').addEventListener('click', downloadPerformanceCsv);
    $('settle-profile-select').addEventListener('change', () => { state.settlementData = null; state.selectedSettlementIdx = 0; loadSettlement(); });
    $('apply-settle-filters').addEventListener('click', () => { state.settlementData = null; state.selectedSettlementIdx = 0; loadSettlement(); });
    $('apply-pr-filters').addEventListener('click', loadPaymentsReport);
    $('pr-download-csv').addEventListener('click', downloadPaymentsReportCsv);
    $('settle-download-csv').addEventListener('click', downloadSettlementCsv);
    $('return-stock-btn').addEventListener('click', openReturnStockModal);
    $('close-return-stock').addEventListener('click', () => setHidden('return-stock-modal', true));
    $('cancel-return-stock').addEventListener('click', () => setHidden('return-stock-modal', true));
    $('confirm-return-stock').addEventListener('click', confirmReturnStock);
    document.querySelectorAll('[data-dsr-tab]').forEach((tab) => tab.addEventListener('click', () => {
      state.dsrTab = tab.dataset.dsrTab;
      renderDashboard();
      if (tab.dataset.dsrTab === 'performance') {
        if (!$('perf-from').value) $('perf-from').value = firstOfMonth();
        if (!$('perf-to').value)   $('perf-to').value   = todayIso();
        if (!state.performanceData && !state.performanceLoading) loadPerformance();
      }
    }));
    $('retry-load').addEventListener('click', () => loadSession(state.selectedBuyerId || state.profiles[0]?.id));
    $('save-load').addEventListener('click', saveLoad);
    $('save-closing').addEventListener('click', saveClosing);
    $('settle-route').addEventListener('click', settleRoute);
    $('add-payment').addEventListener('click', openPayment);
    $('close-payment').addEventListener('click', closePayment);
    $('cancel-payment').addEventListener('click', closePayment);
    $('payment-modal').addEventListener('click', (event) => { if (event.target === $('payment-modal')) closePayment(); });
    $('payment-form').addEventListener('submit', submitPayment);
    $('close-admin-auth').addEventListener('click', closeAdminAuth);
    $('cancel-admin-auth').addEventListener('click', closeAdminAuth);
    $('admin-auth-modal').addEventListener('click', (event) => { if (event.target === $('admin-auth-modal')) closeAdminAuth(); });
    $('admin-auth-form').addEventListener('submit', submitAdminAuth);
    document.addEventListener('input', (event) => {
      if (event.target.matches('.load-input')) {
        state.loadDrafts[event.target.dataset.productId] = Math.max(0, Number(event.target.value || 0));
        updateTotals();
      }
      if (event.target.matches('.closing-input')) {
        state.closingDrafts[event.target.dataset.productId] = Math.max(0, Number(event.target.value || 0));
        updateTotals();
      }
    });
    document.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('[data-delete-payment]');
      if (deleteButton) deletePayment(deleteButton.dataset.deletePayment);
      const rateButton = event.target.closest('[data-product-id].rate-save');
      if (rateButton) saveRate(rateButton.dataset.productId);
      const stockButton = event.target.closest('[data-stock-adjust]');
      if (stockButton) openStockAdjust(stockButton.dataset.stockAdjust);
      const pidButton = event.target.closest('[data-product-id].pid-save');
      if (pidButton) changeProductId(pidButton.dataset.productId);
      const profileDeleteButton = event.target.closest('[data-delete-profile]');
      if (profileDeleteButton) deleteProfile(profileDeleteButton.dataset.deleteProfile);
      const productDeleteButton = event.target.closest('[data-delete-product]');
      if (productDeleteButton) deleteProduct(productDeleteButton.dataset.deleteProduct);
      const purchaseDeleteButton = event.target.closest('[data-delete-purchase]');
      if (purchaseDeleteButton) deletePurchase(purchaseDeleteButton.dataset.deletePurchase);
      const settleCard = event.target.closest('[data-settle-idx]');
      if (settleCard) { state.selectedSettlementIdx = Number(settleCard.dataset.settleIdx); renderSettlement(); }
      const pageBtn = event.target.closest('[data-page-target]');
      if (pageBtn && !pageBtn.disabled) {
        const dir = Number(pageBtn.dataset.pageDir);
        const target = pageBtn.dataset.pageTarget;
        if (target === 'settlement') { state.settlementPage = Math.max(0, state.settlementPage + dir); renderSettlement(); }
        if (target === 'purchases')  { state.purchasesPage  = Math.max(0, state.purchasesPage  + dir); renderAdmin(); }
        if (target === 'adjustments'){ state.adjustmentsPage = Math.max(0, state.adjustmentsPage + dir); renderAdmin(); }
        if (target === 'inv-bills')  { state.invBillsPage   = Math.max(0, state.invBillsPage   + dir); renderInventoryReport(); }
        if (target === 'pr-days')    { state.paymentsReportPage = Math.max(0, state.paymentsReportPage + dir); renderPaymentsReport(); }
      }
    });
  }

  $('role-select').value = state.role;
  bindEvents();
  initAuth();
})();