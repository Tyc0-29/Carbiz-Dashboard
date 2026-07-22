const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt$ = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json();
}

function matchesFilter(card, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (card?.player || '').toLowerCase().includes(q) || (card?.sport || '').toLowerCase().includes(q);
}

// ---------- Tabs ----------
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    $(`#view-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'dashboard') loadDashboard();
  });
});

// ---------- State ----------
let cardsCache = [];
let listingsCache = [];
let salesCache = [];

// ---------- Dashboard ----------
async function loadDashboard() {
  const [d, cards, sales] = await Promise.all([
    api('/api/dashboard'),
    api('/api/cards'),
    api('/api/sales')
  ]);

  const pnlEl = $('#sb-pnl');
  pnlEl.textContent = fmt$(d.pnl.realizedPnL);
  pnlEl.className = 'score-value ' + (d.pnl.realizedPnL >= 0 ? 'positive' : 'negative');
  $('#sb-pnl-sub').textContent = `on ${d.counts.sales} sale${d.counts.sales === 1 ? '' : 's'}`;

  $('#sb-cash').textContent = fmt$(d.cash.cashInHand);
  $('#sb-inv').textContent = fmt$(d.inventory.onHandCostValue);
  $('#sb-inv-sub').textContent = `${d.inventory.onHandCount} cards, at cost`;
  $('#sb-invested').textContent = fmt$(d.totals.totalPurchaseCost + d.totals.totalGradingCost);

  const flagBanner = $('#flag-banner');
  if (d.flags.needsCostReview > 0) {
    flagBanner.classList.remove('hidden');
    flagBanner.textContent = `${d.flags.needsCostReview} imported card${d.flags.needsCostReview === 1 ? '' : 's'} still need${d.flags.needsCostReview === 1 ? 's' : ''} a real cost basis — check Inventory.`;
  } else {
    flagBanner.classList.add('hidden');
  }

  $('#revenue-breakdown').innerHTML = `
    <tr><td>Gross revenue (sale + shipping charged)</td><td>${fmt$(d.totals.totalRevenue)}</td></tr>
    <tr><td>Platform fees</td><td>-${fmt$(d.totals.totalFees)}</td></tr>
    <tr><td>Shipping you paid</td><td>-${fmt$(d.totals.totalShippingPaid)}</td></tr>
    <tr><td><strong>Net proceeds</strong></td><td><strong>${fmt$(d.totals.totalNetProceeds)}</strong></td></tr>
  `;

  $('#snapshot-table').innerHTML = `
    <tr><td>Total purchase cost</td><td>${fmt$(d.totals.totalPurchaseCost)}</td></tr>
    <tr><td>Total grading cost</td><td>${fmt$(d.totals.totalGradingCost)}</td></tr>
    <tr><td>Cost basis of sold cards</td><td>${fmt$(d.pnl.realizedCostBasis)}</td></tr>
    <tr><td>Active listings</td><td>${d.flags.activeListings}</td></tr>
    <tr><td>Cash deposits logged</td><td>${fmt$(d.cash.cashDeposits)}</td></tr>
  `;

  const events = [];
  cards.forEach(c => events.push({ date: c.purchaseDate, label: `Bought ${c.player}`, amount: -c.cost }));
  sales.forEach(s => {
    const c = cards.find(x => x.id === s.cardId);
    events.push({ date: s.saleDate, label: `Sold ${c ? c.player : 'card'}`, amount: s.netProceeds });
  });
  events.sort((a, b) => new Date(b.date) - new Date(a.date));
  $('#activity-feed').innerHTML = events.slice(0, 10).map(e => `
    <div class="activity-row">
      <div class="a-left"><span>${e.date}</span><span>${e.label}</span></div>
      <div class="a-amount ${e.amount >= 0 ? 'positive' : 'negative'}">${fmt$(e.amount)}</div>
    </div>
  `).join('') || '<div class="activity-row"><span>No activity yet — add a purchase to get started.</span></div>';
}

// ---------- Inventory ----------
async function loadCards() {
  cardsCache = await api('/api/cards');
  renderCardsTable();
  populateCardDropdowns();
}

function renderCardsTable() {
  const query = $('#filter-cards')?.value || '';
  const rows = cardsCache.filter(c => matchesFilter(c, query));

  $('#cards-table').innerHTML = `
    <tr><th>Card</th><th>Sport</th><th>Purchased</th><th>Cost</th><th>Status</th><th>Source</th><th></th></tr>
    ${rows.map(c => `
      <tr class="row-edge ${c.status}">
        <td data-label="Card" class="cell-title">${c.player}${c.needsCostReview ? ' ⚠' : ''}${c.alreadyOwned ? ' <span class="owned-tag">OWNED</span>' : ''}${c.lotId ? ' <span class="lot-tag">LOT</span>' : ''}</td>
        <td data-label="Sport">${c.sport || '—'}</td>
        <td data-label="Purchased">${c.purchaseDate}</td>
        <td data-label="Cost">${fmt$(c.cost)}</td>
        <td data-label="Status"><span class="status-chip ${c.status}">${c.status.replace('_',' ')}</span></td>
        <td data-label="Source">${c.source || '—'}</td>
        <td data-label=""><button class="link-btn" data-del-card="${c.id}">Delete</button>${c.needsCostReview ? ` <button class="link-btn" data-clear-flag="${c.id}">Mark already owned</button>` : ''}</td>
      </tr>
    `).join('') || `<tr><td>No matching cards.</td></tr>`}
  `;

  $$('[data-clear-flag]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/cards/${btn.dataset.clearFlag}`, {
      method: 'PUT',
      body: JSON.stringify({ needsCostReview: false, alreadyOwned: true })
    });
    loadCards();
  }));

  $$('[data-del-card]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this card and its related listings/sales?')) return;
    await api(`/api/cards/${btn.dataset.delCard}`, { method: 'DELETE' });
    loadCards();
  }));
}

$('#filter-cards').addEventListener('input', renderCardsTable);

function cardLabel(c) {
  const date = c.purchaseDate || '';
  return `${c.player} — ${fmt$(c.cost)}${date ? ' — ' + date : ''}`;
}

function populateCardDropdowns() {
  // Listing dropdown: cards not already listed/sold, with quick-add as a fallback option at the end
  const listableCards = cardsCache.filter(c => c.status === 'in_hand');
  const listingSelect = $('#listing-card-select');
  const listableOptions = listableCards.map(c => `<option value="${c.id}">${cardLabel(c)}</option>`).join('');
  listingSelect.innerHTML = listableOptions + `<option value="__new__">+ New card (not in inventory yet)</option>`;

  // Sale dropdown: any card not already sold, with quick-add as a fallback option at the end
  const sellableCards = cardsCache.filter(c => c.status !== 'sold');
  const saleSelect = $('#sale-card-select');
  const sellableOptions = sellableCards.map(c => `<option value="${c.id}">${cardLabel(c)}</option>`).join('');
  saleSelect.innerHTML = sellableOptions + `<option value="__new__">+ New card (not in inventory yet)</option>`;

  toggleQuickAdd(saleSelect, $('#quick-add-card'));
  toggleQuickAdd(listingSelect, $('#quick-add-listing-card'));
}

function toggleQuickAdd(select, quickAddEl) {
  if (select.value === '__new__') {
    quickAddEl.classList.remove('hidden');
  } else {
    quickAddEl.classList.add('hidden');
  }
}

$('#sale-card-select').addEventListener('change', (e) => toggleQuickAdd(e.target, $('#quick-add-card')));
$('#listing-card-select').addEventListener('change', (e) => toggleQuickAdd(e.target, $('#quick-add-listing-card')));

// ---------- Already-owned checkbox ----------
const alreadyOwnedCheckbox = $('#already-owned');
const cardCostInput = $('#card-cost');
alreadyOwnedCheckbox.addEventListener('change', () => {
  if (alreadyOwnedCheckbox.checked) {
    cardCostInput.value = 0;
    cardCostInput.disabled = true;
    cardCostInput.required = false;
  } else {
    cardCostInput.disabled = false;
    cardCostInput.required = true;
    cardCostInput.value = '';
  }
});

$('#form-card').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  if (alreadyOwnedCheckbox.checked) {
    body.cost = 0;
    body.alreadyOwned = true;
    if (!body.source) body.source = 'Already owned';
  }
  await api('/api/cards', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  alreadyOwnedCheckbox.checked = false;
  cardCostInput.disabled = false;
  cardCostInput.required = true;
  loadCards();
});

// ---------- Lot purchase ----------
$('#form-lot').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  const cardNames = body.cardNames.split('\n').map(s => s.trim()).filter(Boolean);
  if (cardNames.length < 2) {
    alert('Enter at least 2 card names for a lot — for a single card, use "Add a purchase" instead.');
    return;
  }
  const created = await api('/api/cards/lot', {
    method: 'POST',
    body: JSON.stringify({ ...body, cardNames })
  });
  alert(`Added ${created.length} cards from this lot — ${fmt$(body.totalCost / cardNames.length)} average each.`);
  e.target.reset();
  loadCards();
});

// ---------- Listings ----------
async function loadListings() {
  listingsCache = await api('/api/listings');
  renderListingsTable();
}

function renderListingsTable() {
  const query = $('#filter-listings')?.value || '';
  const rows = listingsCache.filter(l => matchesFilter(cardsCache.find(c => c.id === l.cardId), query));

  $('#listings-table').innerHTML = `
    <tr><th>Card</th><th>Platform</th><th>List price</th><th>Date</th><th>Status</th><th></th></tr>
    ${rows.map(l => {
      const c = cardsCache.find(c => c.id === l.cardId);
      return `<tr>
        <td data-label="Card" class="cell-title">${c ? c.player : l.cardId}</td>
        <td data-label="Platform">${l.platform}</td>
        <td data-label="List price">${fmt$(l.listPrice)}</td>
        <td data-label="Date">${l.listDate}</td>
        <td data-label="Status"><span class="status-chip listed">${l.status}</span></td>
        <td data-label=""><button class="link-btn" data-del-listing="${l.id}">Delete</button></td>
      </tr>`;
    }).join('') || `<tr><td>No matching listings.</td></tr>`}
  `;
  $$('[data-del-listing]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this listing?')) return;
    await api(`/api/listings/${btn.dataset.delListing}`, { method: 'DELETE' });
    loadListings();
  }));
}

$('#filter-listings').addEventListener('input', renderListingsTable);

$('#form-listing').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);

  if (body.cardId === '__new__') {
    const player = $('#new-listing-card-player').value.trim();
    if (!player) {
      alert('Enter a name for the new card before adding the listing.');
      return;
    }
    const costVal = $('#new-listing-card-cost').value;
    const newCard = await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({
        player,
        sport: $('#new-listing-card-sport').value.trim(),
        purchaseDate: body.listDate,
        cost: costVal || 0,
        source: 'Added at time of listing',
        needsCostReview: !costVal
      })
    });
    body.cardId = newCard.id;
  }

  await api('/api/listings', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  $('#quick-add-listing-card').classList.add('hidden');
  loadCards();
  loadListings();
});

// ---------- Sales ----------
async function loadSales() {
  salesCache = await api('/api/sales');
  renderSalesTable();
}

function renderSalesTable() {
  const query = $('#filter-sales')?.value || '';
  const rows = salesCache.filter(s => matchesFilter(cardsCache.find(c => c.id === s.cardId), query));

  $('#sales-table').innerHTML = `
    <tr><th>Card</th><th>Platform</th><th>Sale price</th><th>Fees</th><th>Net</th><th>Date</th><th></th></tr>
    ${rows.map(s => {
      const c = cardsCache.find(c => c.id === s.cardId);
      return `<tr>
        <td data-label="Card" class="cell-title">${c ? c.player : s.cardId}</td>
        <td data-label="Platform">${s.platform}</td>
        <td data-label="Sale price">${fmt$(s.salePrice)}</td>
        <td data-label="Fees">${fmt$(s.fees)}</td>
        <td data-label="Net"><strong>${fmt$(s.netProceeds)}</strong></td>
        <td data-label="Date">${s.saleDate}</td>
        <td data-label=""><button class="link-btn" data-del-sale="${s.id}">Delete</button></td>
      </tr>`;
    }).join('') || `<tr><td>No matching sales.</td></tr>`}
  `;
  $$('[data-del-sale]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this sale? The card will go back to "in hand".')) return;
    await api(`/api/sales/${btn.dataset.delSale}`, { method: 'DELETE' });
    loadCards();
    loadSales();
  }));
}

$('#filter-sales').addEventListener('input', renderSalesTable);

$('#form-sale').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);

  if (body.cardId === '__new__') {
    const player = $('#new-card-player').value.trim();
    if (!player) {
      alert('Enter a name for the new card before recording the sale.');
      return;
    }
    const costVal = $('#new-card-cost').value;
    const newCard = await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({
        player,
        sport: $('#new-card-sport').value.trim(),
        purchaseDate: body.saleDate,
        cost: costVal || 0,
        source: 'Added at time of sale',
        needsCostReview: !costVal
      })
    });
    body.cardId = newCard.id;
  }

  await api('/api/sales', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  $('#quick-add-card').classList.add('hidden');
  loadCards();
  loadSales();
});

// ---------- Cash ----------
async function loadCash() {
  const rows = await api('/api/cash-adjustments');
  $('#cash-table').innerHTML = `
    <tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td data-label="Date">${r.date}</td>
      <td data-label="Amount">${fmt$(r.amount)}</td>
      <td data-label="Note">${r.note || '—'}</td>
      <td data-label=""><button class="link-btn" data-del-cash="${r.id}">Delete</button></td>
    </tr>`).join('')}
  `;
  $$('[data-del-cash]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this cash adjustment?')) return;
    await api(`/api/cash-adjustments/${btn.dataset.delCash}`, { method: 'DELETE' });
    loadCash();
  }));
}

async function loadBackups() {
  const files = await api('/api/backups');
  $('#backups-list').innerHTML = files.length
    ? files.map(f => `
        <div class="activity-row">
          <span>${f.replace('db-', '').replace('.json', '')}</span>
          <a href="/api/backups/${f}" download class="link-btn">Download</a>
        </div>
      `).join('')
    : '<div class="activity-row"><span>No backups yet — the first one is created shortly after the site starts running.</span></div>';
}

$('#form-cash').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/cash-adjustments', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
  e.target.reset();
  loadCash();
});

// ---------- CSV Import ----------
const FIELD_GUESSES = {
  title: ['item title', 'title', 'listing title', 'item name'],
  salePrice: ['sold for', 'sale price', 'item price', 'total price', 'price'],
  shippingCharged: ['shipping and handling', 'shipping', 'shipping charged'],
  fees: ['final value fee', 'fees', 'ebay fee', 'total fees'],
  shippingPaid: ['shipping cost', 'postage', 'shipping paid'],
  saleDate: ['sale date', 'date', 'order date', 'paid on date'],
  purchaseDate: ['date', 'purchase date', 'order date'],
  cost: ['sold for', 'price', 'total price', 'item price'],
  buyer: ['buyer username', 'buyer name', 'buyer'],
  orderId: ['order number', 'sales record number', 'order id']
};

function guessColumn(headers, keys) {
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const key of keys) {
    const idx = lower.indexOf(key);
    if (idx !== -1) return headers[idx];
  }
  for (const key of keys) {
    const idx = lower.findIndex(h => h.includes(key));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

let parsedRows = [];
let csvHeaders = [];

$('#csv-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      parsedRows = results.data;
      csvHeaders = results.meta.fields || [];
      renderMappingUI();
    }
  });
});

$('#import-mode').addEventListener('change', renderMappingUI);

function renderMappingUI() {
  if (!csvHeaders.length) return;
  const mode = $('#import-mode').value;
  const fields = mode === 'sales'
    ? ['title', 'salePrice', 'shippingCharged', 'fees', 'shippingPaid', 'saleDate', 'buyer', 'orderId']
    : ['title', 'cost', 'purchaseDate'];

  const area = $('#mapping-area');
  area.innerHTML = `
    <h4 style="font-family:var(--font-display);font-size:18px;margin:16px 0 8px;">Map columns</h4>
    <div id="mapping-fields"></div>
    <button id="run-import" class="btn-primary" style="margin-top:12px;">Import ${parsedRows.length} rows</button>
    <div class="preview-table"></div>
  `;

  const fieldsDiv = $('#mapping-fields');
  fields.forEach(f => {
    const guess = guessColumn(csvHeaders, FIELD_GUESSES[f] || []);
    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
      <label>${f}</label>
      <select data-field="${f}">
        <option value="">— skip —</option>
        ${csvHeaders.map(h => `<option value="${h}" ${h === guess ? 'selected' : ''}>${h}</option>`).join('')}
      </select>
    `;
    fieldsDiv.appendChild(row);
  });

  $('#run-import').addEventListener('click', async () => {
    const mapping = {};
    $$('#mapping-fields select').forEach(sel => { mapping[sel.dataset.field] = sel.value; });

    const rows = parsedRows.map(row => {
      const out = {};
      Object.entries(mapping).forEach(([field, col]) => {
        if (!col) return;
        let val = row[col];
        if (['salePrice', 'shippingCharged', 'fees', 'shippingPaid', 'cost'].includes(field)) {
          val = parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
        }
        out[field] = val;
      });
      return out;
    });

    const res = await api('/api/import', { method: 'POST', body: JSON.stringify({ mode, rows }) });
    alert(`Imported ${res.created.cards} card(s)${res.created.sales ? ` and ${res.created.sales} sale(s)` : ''}.`);
    parsedRows = [];
    $('#mapping-area').innerHTML = '';
    $('#csv-file').value = '';
    loadCards();
  });
}

// ---------- Init ----------
(async function init() {
  const today = new Date().toISOString().slice(0, 10);
  $('input[name="purchaseDate"]').value = today;
  $('input[name="listDate"]').value = today;
  $('input[name="saleDate"]').value = today;
  $('input[name="date"]').value = today;

  await loadCards();
  await Promise.all([loadListings(), loadSales(), loadCash(), loadBackups()]);
  await loadDashboard();
})();
