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
    if (tab.dataset.tab === 'performance') loadPerformance();
  });
});

// ---------- State ----------
let cardsCache = [];
let listingsCache = [];
let salesCache = [];
let gradingCache = [];

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

  const cashInput = $('#sb-cash-input');
  if (document.activeElement !== cashInput) cashInput.value = d.cash.cashOnHand || '';

  $('#sb-avail-cost').textContent = fmt$(d.inventory.availableCostValue);
  $('#sb-avail-cost-sub').textContent = `${d.inventory.availableCount} card${d.inventory.availableCount === 1 ? '' : 's'}`;
  $('#sb-avail-est').textContent = fmt$(d.inventory.availableEstimatedValue);
  $('#sb-avail-est-sub').textContent = `${d.inventory.availableWithEstimate} of ${d.inventory.availableCount} priced`;
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
    <tr><td>Listed inventory (at cost)</td><td>${fmt$(d.inventory.listedCostValue)}</td></tr>
    <tr><td>Listed inventory (est. value)</td><td>${fmt$(d.inventory.listedEstimatedValue)} <span style="color:var(--text-dim);font-weight:400;">(${d.inventory.listedWithEstimate} of ${d.inventory.listedCount} priced)</span></td></tr>
    <tr><td>Active listings</td><td>${d.flags.activeListings}</td></tr>
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

$('#sb-cash-input').addEventListener('change', async (e) => {
  await api('/api/cash-on-hand', { method: 'PUT', body: JSON.stringify({ amount: e.target.value }) });
});

// ---------- Inventory ----------
async function loadCards() {
  cardsCache = await api('/api/cards');
  renderCardsTable();
  populateCardDropdowns();
  if (typeof loadDisplayCase === 'function') loadDisplayCase();
}

let editingCardId = null;

function renderCardsTable() {
  const query = $('#filter-cards')?.value || '';
  const checkedStatuses = $$('.status-filter').filter(cb => cb.checked).map(cb => cb.value);
  const rows = cardsCache.filter(c => matchesFilter(c, query) && checkedStatuses.includes(c.status));

  $('#cards-table').innerHTML = `
    <tr><th>Card</th><th>Sport</th><th>Purchased</th><th>Cost</th><th>Est. Value</th><th>Status</th><th>Source</th><th></th></tr>
    ${rows.map(c => {
      if (c.id === editingCardId) {
        return `
      <tr class="row-edge ${c.status}">
        <td data-label="Card"><input type="text" class="card-edit-input" data-edit-field="player" value="${c.player.replace(/"/g, '&quot;')}" /></td>
        <td data-label="Sport"><input type="text" class="card-edit-input" data-edit-field="sport" value="${(c.sport || '').replace(/"/g, '&quot;')}" /></td>
        <td data-label="Purchased"><input type="date" class="card-edit-input" data-edit-field="purchaseDate" value="${c.purchaseDate}" /></td>
        <td data-label="Cost"><input type="number" step="0.01" class="card-edit-input" data-edit-field="cost" value="${c.cost}" /></td>
        <td data-label="Est. Value"><input type="number" step="0.01" class="card-edit-input" data-edit-field="estimatedValue" value="${c.estimatedValue ?? ''}" /></td>
        <td data-label="Status">
          <select class="card-edit-input" data-edit-field="status">
            ${['in_hand', 'listed', 'sold'].map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
          </select>
        </td>
        <td data-label="Source"><input type="text" class="card-edit-input" data-edit-field="source" value="${(c.source || '').replace(/"/g, '&quot;')}" /></td>
        <td data-label="">
          <button class="link-btn" data-save-card="${c.id}">Save</button>
          <button class="link-btn" data-cancel-card>Cancel</button>
        </td>
      </tr>`;
      }
      return `
      <tr class="row-edge ${c.status}">
        <td data-label="Card" class="cell-title">${c.player}${c.needsCostReview ? ' ⚠' : ''}${c.alreadyOwned ? ' <span class="owned-tag">OWNED</span>' : ''}${c.lotId ? ' <span class="lot-tag">LOT</span>' : ''}${gradingTotalForCard(c.id) > 0 ? ` <span class="owned-tag" style="color:var(--navy);background:#DCE6F5;">GRADED +${fmt$(gradingTotalForCard(c.id))}</span>` : ''}</td>
        <td data-label="Sport">${c.sport || '—'}</td>
        <td data-label="Purchased">${c.purchaseDate}</td>
        <td data-label="Cost">${fmt$(c.cost)}</td>
        <td data-label="Est. Value">
          <span class="est-value-wrap">
            <input type="number" step="0.01" class="est-value-input" data-card-id="${c.id}" value="${c.estimatedValue ?? ''}" placeholder="—" />
            <a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(c.player)}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener" class="comps-link" title="Check eBay sold comps">🔍</a>
          </span>
        </td>
        <td data-label="Status"><span class="status-chip ${c.status}">${c.status.replace('_',' ')}</span></td>
        <td data-label="Source">${c.source || '—'}</td>
        <td data-label="">
          <button class="link-btn" data-edit-card="${c.id}">Edit</button>
          <button class="link-btn" data-del-card="${c.id}">Delete</button>
          ${c.needsCostReview ? ` <button class="link-btn" data-clear-flag="${c.id}">Mark already owned</button>` : ''}
        </td>
      </tr>`;
    }).join('') || `<tr><td>No matching cards.</td></tr>`}
  `;

  $$('[data-edit-card]').forEach(btn => btn.addEventListener('click', () => {
    editingCardId = btn.dataset.editCard;
    renderCardsTable();
  }));

  $$('[data-cancel-card]').forEach(btn => btn.addEventListener('click', () => {
    editingCardId = null;
    renderCardsTable();
  }));

  $$('[data-save-card]').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('tr');
    const body = {};
    row.querySelectorAll('[data-edit-field]').forEach(el => { body[el.dataset.editField] = el.value; });
    body.needsCostReview = false; // manually saving through the edit form counts as reviewing it
    await api(`/api/cards/${btn.dataset.saveCard}`, { method: 'PUT', body: JSON.stringify(body) });
    editingCardId = null;
    loadCards();
    loadListings();
    loadSales();
    loadDashboard();
  }));

  $$('.est-value-input').forEach(input => input.addEventListener('change', async () => {
    await api(`/api/cards/${input.dataset.cardId}`, {
      method: 'PUT',
      body: JSON.stringify({ estimatedValue: input.value })
    });
    const card = cardsCache.find(c => c.id === input.dataset.cardId);
    if (card) card.estimatedValue = input.value === '' ? null : Number(input.value);
  }));

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
$$('.status-filter').forEach(cb => cb.addEventListener('change', renderCardsTable));

function cardLabel(c) {
  const date = c.purchaseDate || '';
  return `${c.player} — ${fmt$(c.cost)}${date ? ' — ' + date : ''}`;
}

function gradingTotalForCard(cardId) {
  return gradingCache.filter(g => g.cardId === cardId).reduce((s, g) => s + Number(g.cost || 0), 0);
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

  // Grading dropdown: any non-sold card
  const gradableCards = cardsCache.filter(c => c.status !== 'sold');
  const gradingSelect = $('#grading-card-select');
  if (gradingSelect) {
    gradingSelect.innerHTML = gradableCards.map(c => `<option value="${c.id}">${cardLabel(c)}</option>`).join('');
  }
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

// ---------- Grading costs ----------
async function loadGrading() {
  gradingCache = await api('/api/grading');
  renderGradingTable();
  renderCardsTable(); // refresh so grading tags on inventory rows stay current
}

function renderGradingTable() {
  $('#grading-table').innerHTML = `
    <tr><th>Card</th><th>Company</th><th>Grade</th><th>Cost</th><th>Date</th><th></th></tr>
    ${gradingCache.map(g => {
      const c = cardsCache.find(c => c.id === g.cardId);
      return `<tr>
        <td data-label="Card" class="cell-title">${c ? c.player : g.cardId}</td>
        <td data-label="Company">${g.company}</td>
        <td data-label="Grade">${g.grade || '—'}</td>
        <td data-label="Cost">${fmt$(g.cost)}</td>
        <td data-label="Date">${g.date}</td>
        <td data-label=""><button class="link-btn" data-del-grading="${g.id}">Delete</button></td>
      </tr>`;
    }).join('') || `<tr><td>No grading costs logged yet.</td></tr>`}
  `;
  $$('[data-del-grading]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this grading cost?')) return;
    await api(`/api/grading/${btn.dataset.delGrading}`, { method: 'DELETE' });
    loadGrading();
  }));
}

$('#form-grading').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/grading', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
  e.target.reset();
  loadGrading();
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
        <td data-label="Platform">
          <select class="inline-edit" data-listing-id="${l.id}" data-field="platform">
            ${['eBay','COMC','Whatnot','Facebook','Other'].map(p => `<option value="${p}" ${p === l.platform ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </td>
        <td data-label="List price"><input type="number" step="0.01" class="inline-edit-input" data-listing-id="${l.id}" data-field="listPrice" value="${l.listPrice}" /></td>
        <td data-label="Date"><input type="date" class="inline-edit-input" data-listing-id="${l.id}" data-field="listDate" value="${l.listDate}" /></td>
        <td data-label="Status">
          <select class="inline-edit status-chip listed" data-listing-id="${l.id}" data-field="status">
            ${['active','ended','sold'].map(s => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </td>
        <td data-label=""><button class="link-btn" data-del-listing="${l.id}">Delete</button></td>
      </tr>`;
    }).join('') || `<tr><td>No matching listings.</td></tr>`}
  `;

  $$('.inline-edit, .inline-edit-input').forEach(el => el.addEventListener('change', async () => {
    await api(`/api/listings/${el.dataset.listingId}`, {
      method: 'PUT',
      body: JSON.stringify({ [el.dataset.field]: el.value })
    });
  }));

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

let editingSaleId = null;

function renderSalesTable() {
  const query = $('#filter-sales')?.value || '';
  const rows = salesCache.filter(s => matchesFilter(cardsCache.find(c => c.id === s.cardId), query));

  $('#sales-table').innerHTML = `
    <tr><th>Card</th><th>Platform</th><th>Sale price</th><th>Fees</th><th>Net</th><th>Date</th><th></th></tr>
    ${rows.map(s => {
      const c = cardsCache.find(c => c.id === s.cardId);
      if (s.id === editingSaleId) {
        return `<tr>
        <td data-label="Card" class="cell-title">${c ? c.player : s.cardId}</td>
        <td data-label="Platform">
          <select class="card-edit-input" data-edit-field="platform">
            ${['eBay','COMC','Whatnot','Facebook','Other'].map(p => `<option value="${p}" ${p === s.platform ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </td>
        <td data-label="Sale price"><input type="number" step="0.01" class="card-edit-input" data-edit-field="salePrice" value="${s.salePrice}" /></td>
        <td data-label="Fees"><input type="number" step="0.01" class="card-edit-input" data-edit-field="fees" value="${s.fees}" /></td>
        <td data-label="Net">${fmt$(s.netProceeds)}</td>
        <td data-label="Date"><input type="date" class="card-edit-input" data-edit-field="saleDate" value="${s.saleDate}" /></td>
        <td data-label="">
          <button class="link-btn" data-save-sale="${s.id}">Save</button>
          <button class="link-btn" data-cancel-sale>Cancel</button>
        </td>
      </tr>`;
      }
      return `<tr>
        <td data-label="Card" class="cell-title">${c ? c.player : s.cardId}</td>
        <td data-label="Platform">${s.platform}</td>
        <td data-label="Sale price">${fmt$(s.salePrice)}</td>
        <td data-label="Fees">${fmt$(s.fees)}</td>
        <td data-label="Net"><strong>${fmt$(s.netProceeds)}</strong></td>
        <td data-label="Date">${s.saleDate}</td>
        <td data-label="">
          <button class="link-btn" data-edit-sale="${s.id}">Edit</button>
          <button class="link-btn" data-del-sale="${s.id}">Delete</button>
        </td>
      </tr>`;
    }).join('') || `<tr><td>No matching sales.</td></tr>`}
  `;

  $$('[data-edit-sale]').forEach(btn => btn.addEventListener('click', () => {
    editingSaleId = btn.dataset.editSale;
    renderSalesTable();
  }));

  $$('[data-cancel-sale]').forEach(btn => btn.addEventListener('click', () => {
    editingSaleId = null;
    renderSalesTable();
  }));

  $$('[data-save-sale]').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('tr');
    const body = {};
    row.querySelectorAll('[data-edit-field]').forEach(el => { body[el.dataset.editField] = el.value; });
    await api(`/api/sales/${btn.dataset.saveSale}`, { method: 'PUT', body: JSON.stringify(body) });
    editingSaleId = null;
    loadSales();
  }));

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

// ---------- Backups & Restore ----------
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

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = $('#restore-status');
  const confirmed = confirm(
    `This will REPLACE everything currently in the site with the contents of "${file.name}". ` +
    `Your current data will be snapshotted first, but this cannot be casually undone. Continue?`
  );
  if (!confirmed) {
    e.target.value = '';
    return;
  }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await api('/api/restore', { method: 'POST', body: JSON.stringify(data) });
    statusEl.textContent = `Restored: ${res.counts.cards} cards, ${res.counts.listings} listings, ${res.counts.sales} sales, ${res.counts.gradingCosts} grading entries.`;
    e.target.value = '';
    loadCards();
    loadListings();
    loadSales();
    loadGrading();
    loadBackups();
    loadDashboard();
    loadDisplayCase();
  } catch (err) {
    statusEl.textContent = `Restore failed: ${err.message}. Make sure this is a valid backup file (exported from this site).`;
    e.target.value = '';
  }
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
  cost: ['cost', 'sold for', 'price', 'total price', 'item price'],
  buyer: ['buyer username', 'buyer name', 'buyer'],
  orderId: ['order number', 'sales record number', 'order id'],
  sport: ['sport'],
  source: ['source'],
  listPrice: ['list price', 'listing price', 'asking price', 'price'],
  listDate: ['list date', 'listing date', 'date listed', 'date'],
  platform: ['platform'],
  ebayListingId: ['ebay listing id', 'listing id']
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
      renderMappingUI('#mapping-area', $('#import-mode').value, csvHeaders, parsedRows, () => {
        parsedRows = [];
        $('#mapping-area').innerHTML = '';
        $('#csv-file').value = '';
      });
    }
  });
});

$('#import-mode').addEventListener('change', () => {
  if (csvHeaders.length) {
    renderMappingUI('#mapping-area', $('#import-mode').value, csvHeaders, parsedRows, () => {
      parsedRows = [];
      $('#mapping-area').innerHTML = '';
      $('#csv-file').value = '';
    });
  }
});

let pastedRows = [];
let pastedHeaders = [];

$('#parse-pasted').addEventListener('click', () => {
  const text = $('#paste-rows').value.trim();
  if (!text) {
    alert('Paste some rows first — include the header row from your spreadsheet.');
    return;
  }
  const results = Papa.parse(text, { header: true, skipEmptyLines: true });
  pastedRows = results.data;
  pastedHeaders = results.meta.fields || [];
  renderMappingUI('#paste-mapping-area', $('#bulk-mode').value, pastedHeaders, pastedRows, () => {
    pastedRows = [];
    $('#paste-mapping-area').innerHTML = '';
    $('#paste-rows').value = '';
  });
});

function renderMappingUI(areaSelector, mode, headers, rows, onDone) {
  if (!headers.length) return;
  const fields = mode === 'sales'
    ? ['title', 'salePrice', 'fees', 'saleDate', 'buyer', 'orderId']
    : mode === 'listings'
    ? ['title', 'listPrice', 'listDate', 'platform', 'ebayListingId']
    : ['title', 'cost', 'purchaseDate', 'sport', 'source'];

  const area = $(areaSelector);
  const fieldsId = areaSelector.replace('#', '') + '-fields';
  const runId = areaSelector.replace('#', '') + '-run';
  area.innerHTML = `
    <h4 style="font-family:var(--font-display);font-size:18px;margin:16px 0 8px;">Map columns</h4>
    <div id="${fieldsId}"></div>
    <button id="${runId}" class="btn-primary" style="margin-top:12px;">Import ${rows.length} rows</button>
  `;

  const fieldsDiv = $('#' + fieldsId);
  fields.forEach(f => {
    const guess = guessColumn(headers, FIELD_GUESSES[f] || []);
    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
      <label>${f}</label>
      <select data-field="${f}">
        <option value="">— skip —</option>
        ${headers.map(h => `<option value="${h}" ${h === guess ? 'selected' : ''}>${h}</option>`).join('')}
      </select>
    `;
    fieldsDiv.appendChild(row);
  });

  $('#' + runId).addEventListener('click', async () => {
    const mapping = {};
    $$(`#${fieldsId} select`).forEach(sel => { mapping[sel.dataset.field] = sel.value; });

    const outRows = rows.map(row => {
      const out = {};
      Object.entries(mapping).forEach(([field, col]) => {
        if (!col) return;
        let val = row[col];
        if (['salePrice', 'fees', 'cost', 'listPrice'].includes(field)) {
          val = parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
        }
        out[field] = val;
      });
      return out;
    });

    const res = await api('/api/import', { method: 'POST', body: JSON.stringify({ mode, rows: outRows }) });
    alert(`Imported ${res.created.cards} card(s)${res.created.sales ? ` and ${res.created.sales} sale(s)` : ''}${res.created.listings ? ` and ${res.created.listings} listing(s)` : ''}.`);
    onDone();
    loadCards();
  });
}

// ---------- Performance ----------
let perfChart = null;

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

$$('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    const today = new Date().toISOString().slice(0, 10);
    if (preset === 'all') {
      $('#perf-start').value = '';
      $('#perf-end').value = '';
    } else if (preset === 'ytd') {
      $('#perf-start').value = `${new Date().getFullYear()}-01-01`;
      $('#perf-end').value = today;
    } else {
      $('#perf-start').value = isoDaysAgo(Number(preset));
      $('#perf-end').value = today;
    }
    loadPerformance();
  });
});

$('#perf-apply').addEventListener('click', loadPerformance);

async function loadPerformance() {
  const start = $('#perf-start').value;
  const end = $('#perf-end').value;
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);

  const d = await api(`/api/performance?${params.toString()}`);

  const pnlEl = $('#perf-pnl');
  pnlEl.textContent = fmt$(d.sales.realizedPnL);
  pnlEl.className = 'score-value ' + (d.sales.realizedPnL >= 0 ? 'positive' : 'negative');
  $('#perf-pnl-sub').textContent = `margin ${d.sales.avgMarginPct}%`;

  $('#perf-revenue').textContent = fmt$(d.sales.totalRevenue);
  $('#perf-revenue-sub').textContent = `${d.sales.count} sale${d.sales.count === 1 ? '' : 's'}`;
  $('#perf-avg').textContent = fmt$(d.sales.avgSalePrice);
  $('#perf-spent').textContent = fmt$(d.purchases.totalCost);
  $('#perf-spent-sub').textContent = `${d.purchases.count} card${d.purchases.count === 1 ? '' : 's'} bought`;

  const ctx = $('#perf-chart').getContext('2d');
  const labels = d.daily.map(p => p.date);
  const values = d.daily.map(p => p.netProceeds);

  if (perfChart) perfChart.destroy();
  perfChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net proceeds',
        data: values,
        backgroundColor: '#B01B2E'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: (v) => '$' + v } }
      }
    }
  });
}

// ---------- Display Case ----------
let displayCache = [];

async function loadDisplayCase() {
  displayCache = cardsCache.filter(c => c.displayCase);
  renderDisplayCase();
  populateDisplayDropdown();
}

function populateDisplayDropdown() {
  const select = $('#display-card-select');
  if (!select) return;
  const eligible = cardsCache.filter(c => c.status !== 'sold' && !c.displayCase);
  select.innerHTML = eligible.length
    ? eligible.map(c => `<option value="${c.id}">${cardLabel(c)}</option>`).join('')
    : `<option value="">No eligible cards (already in case, or all sold)</option>`;
}

function renderDisplayCase() {
  const gallery = $('#display-case-gallery');
  if (!gallery) return;
  if (!displayCache.length) {
    gallery.innerHTML = `<div class="panel"><p class="hint" style="margin:0;">Nothing on display yet — add a card above to start your case.</p></div>`;
    return;
  }
  gallery.innerHTML = displayCache.map(c => {
    const value = c.estimatedValue !== null && c.estimatedValue !== undefined ? c.estimatedValue : c.cost;
    const gain = value - c.cost;
    return `
    <div class="display-card">
      <div class="display-card-photo">
        ${c.photoUrl ? `<img src="${c.photoUrl}" alt="${c.player}" />` : `<div class="display-card-noimg">No photo yet</div>`}
      </div>
      <div class="display-card-plaque">
        <div class="display-card-name">${c.player}</div>
        <div class="display-card-sport">${c.sport || ''}</div>
        <div class="display-card-figures">
          <div><span>Cost</span><strong>${fmt$(c.cost)}</strong></div>
          <div><span>Est. Value</span><strong>${fmt$(value)}</strong></div>
          <div><span>Unrealized</span><strong class="${gain >= 0 ? 'positive' : 'negative'}">${fmt$(gain)}</strong></div>
        </div>
        <div class="display-card-actions">
          <label class="link-btn">Change photo<input type="file" accept="image/*" class="display-photo-swap" data-card-id="${c.id}" style="display:none;" /></label>
          <button class="link-btn" data-remove-display="${c.id}">Remove from case</button>
        </div>
      </div>
    </div>`;
  }).join('');

  $$('.display-photo-swap').forEach(input => input.addEventListener('change', (e) => handlePhotoUpload(e, input.dataset.cardId)));
  $$('[data-remove-display]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/cards/${btn.dataset.removeDisplay}`, { method: 'PUT', body: JSON.stringify({ displayCase: false }) });
    loadCards();
  }));
}

// resize/compress client-side so we're not shipping huge phone photos to a JSON-file-backed server
function resizeImageFile(file, maxDim = 1000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height *= maxDim / width; width = maxDim; }
      else if (height > maxDim) { width *= maxDim / height; height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handlePhotoUpload(e, cardId) {
  const file = e.target.files[0];
  if (!file) return;
  const dataUri = await resizeImageFile(file);
  await api(`/api/cards/${cardId}/photo`, { method: 'POST', body: JSON.stringify({ imageBase64: dataUri }) });
  loadCards();
}

$('#form-display').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cardId = $('#display-card-select').value;
  if (!cardId) { alert('No eligible card selected.'); return; }
  await api(`/api/cards/${cardId}`, { method: 'PUT', body: JSON.stringify({ displayCase: true }) });

  const photoFile = $('#display-photo-input').files[0];
  if (photoFile) {
    const dataUri = await resizeImageFile(photoFile);
    await api(`/api/cards/${cardId}/photo`, { method: 'POST', body: JSON.stringify({ imageBase64: dataUri }) });
  }
  e.target.reset();
  loadCards();
});

// ---------- Init ----------
(async function init() {
  const today = new Date().toISOString().slice(0, 10);
  $('input[name="purchaseDate"]').value = today;
  $('input[name="listDate"]').value = today;
  $('input[name="saleDate"]').value = today;
  $('input[name="date"]').value = today;

  await loadCards();
  await Promise.all([loadListings(), loadSales(), loadBackups(), loadGrading(), loadDisplayCase()]);
  await loadDashboard();
})();
