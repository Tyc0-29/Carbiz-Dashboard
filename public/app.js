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

// ---------- Dashboard ----------
async function loadDashboard() {
  const [d, cards, sales, listings, cash] = await Promise.all([
    api('/api/dashboard'),
    api('/api/cards'),
    api('/api/sales'),
    api('/api/listings'),
    api('/api/cash-adjustments')
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

  // activity feed: merge recent purchases + sales, sort by date desc, take 10
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
  const sales = await api('/api/sales');
  const soldByCard = Object.fromEntries(sales.map(s => [s.cardId, s]));

  $('#cards-table').innerHTML = `
    <tr><th>Card</th><th>Sport</th><th>Purchased</th><th>Cost</th><th>Status</th><th>Source</th><th></th></tr>
    ${cardsCache.map(c => `
      <tr class="row-edge ${c.status}">
        <td>${c.player}${c.needsCostReview ? ' ⚠' : ''}</td>
        <td>${c.sport || '—'}</td>
        <td>${c.purchaseDate}</td>
        <td>${fmt$(c.cost)}</td>
        <td><span class="status-chip ${c.status}">${c.status.replace('_',' ')}</span></td>
        <td>${c.source || '—'}</td>
        <td><button class="link-btn" data-del-card="${c.id}">Delete</button></td>
      </tr>
    `).join('')}
  `;

  $$('[data-del-card]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this card and its related listings/sales?')) return;
    await api(`/api/cards/${btn.dataset.delCard}`, { method: 'DELETE' });
    loadCards();
  }));

  // populate card selects on listings/sales forms
  const options = cardsCache.map(c => `<option value="${c.id}">${c.player} (${c.status})</option>`).join('');
  $('select[name="cardId"]', $('#form-listing')).innerHTML = options;
  $('select[name="cardId"]', $('#form-sale')).innerHTML = options;
}

$('#form-card').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/cards', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
  e.target.reset();
  loadCards();
});

// ---------- Listings ----------
async function loadListings() {
  const listings = await api('/api/listings');
  $('#listings-table').innerHTML = `
    <tr><th>Card</th><th>Platform</th><th>List price</th><th>Date</th><th>Status</th><th></th></tr>
    ${listings.map(l => {
      const c = cardsCache.find(c => c.id === l.cardId);
      return `<tr>
        <td>${c ? c.player : l.cardId}</td>
        <td>${l.platform}</td>
        <td>${fmt$(l.listPrice)}</td>
        <td>${l.listDate}</td>
        <td><span class="status-chip listed">${l.status}</span></td>
        <td><button class="link-btn" data-del-listing="${l.id}">Delete</button></td>
      </tr>`;
    }).join('')}
  `;
  $$('[data-del-listing]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/listings/${btn.dataset.delListing}`, { method: 'DELETE' });
    loadListings();
  }));
}

$('#form-listing').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/listings', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
  e.target.reset();
  loadCards();
  loadListings();
});

// ---------- Sales ----------
async function loadSales() {
  const sales = await api('/api/sales');
  $('#sales-table').innerHTML = `
    <tr><th>Card</th><th>Platform</th><th>Sale price</th><th>Fees</th><th>Ship paid</th><th>Net</th><th>Date</th><th></th></tr>
    ${sales.map(s => {
      const c = cardsCache.find(c => c.id === s.cardId);
      return `<tr>
        <td>${c ? c.player : s.cardId}</td>
        <td>${s.platform}</td>
        <td>${fmt$(s.salePrice)}</td>
        <td>${fmt$(s.fees)}</td>
        <td>${fmt$(s.shippingPaid)}</td>
        <td><strong>${fmt$(s.netProceeds)}</strong></td>
        <td>${s.saleDate}</td>
        <td><button class="link-btn" data-del-sale="${s.id}">Delete</button></td>
      </tr>`;
    }).join('')}
  `;
  $$('[data-del-sale]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/sales/${btn.dataset.delSale}`, { method: 'DELETE' });
    loadCards();
    loadSales();
  }));
}

$('#form-sale').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/sales', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
  e.target.reset();
  loadCards();
  loadSales();
});

// ---------- Cash ----------
async function loadCash() {
  const rows = await api('/api/cash-adjustments');
  $('#cash-table').innerHTML = `
    <tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td>${r.date}</td>
      <td>${fmt$(r.amount)}</td>
      <td>${r.note || '—'}</td>
      <td><button class="link-btn" data-del-cash="${r.id}">Delete</button></td>
    </tr>`).join('')}
  `;
  $$('[data-del-cash]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/cash-adjustments/${btn.dataset.delCash}`, { method: 'DELETE' });
    loadCash();
  }));
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
  // partial match fallback
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
  await Promise.all([loadListings(), loadSales(), loadCash()]);
  await loadDashboard();
})();
