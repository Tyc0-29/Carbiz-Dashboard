const express = require('express');
const path = require('path');
const fs = require('fs');
const { readDb, writeDb, genId, DB_PATH } = require('./store');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const BACKUP_RETENTION_DAYS = 30;

// ---------- automatic same-disk backups ----------
// Snapshots db.json daily so an in-app mistake or bug can be recovered from,
// independent of the manual Export button. This does NOT protect against the
// whole disk being deleted — keep using Export data periodically for that.
function runBackup() {
  try {
    readDb(); // ensures db.json exists even on a brand-new install
    if (!fs.existsSync(DB_PATH)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `db-${stamp}.json`);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(DB_PATH, dest);
    }
    // prune backups older than retention window
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    fs.readdirSync(BACKUP_DIR).forEach(f => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    });
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}
runBackup();
setInterval(runBackup, 24 * 60 * 60 * 1000);

// ---------- helpers ----------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function costBasisForCard(db, cardId) {
  const card = db.cards.find(c => c.id === cardId);
  if (!card) return 0;
  const grading = db.gradingCosts
    .filter(g => g.cardId === cardId)
    .reduce((s, g) => s + num(g.cost), 0);
  return num(card.cost) + grading;
}

function recomputeNetProceeds(sale) {
  const salePrice = num(sale.salePrice);
  const shippingCharged = num(sale.shippingCharged);
  const fees = num(sale.fees);
  const shippingPaid = num(sale.shippingPaid);
  return +(salePrice + shippingCharged - fees - shippingPaid).toFixed(2);
}

// ---------- CARDS (purchases / inventory) ----------
app.get('/api/cards', (req, res) => {
  const db = readDb();
  res.json(db.cards);
});

app.post('/api/cards', async (req, res) => {
  const db = readDb();
  const card = {
    id: genId('card'),
    player: req.body.player || 'Untitled card',
    sport: req.body.sport || '',
    purchaseDate: req.body.purchaseDate || new Date().toISOString().slice(0, 10),
    cost: num(req.body.cost),
    source: req.body.source || '',
    status: req.body.status || 'in_hand', // in_hand | listed | sold
    notes: req.body.notes || '',
    needsCostReview: !!req.body.needsCostReview,
    alreadyOwned: !!req.body.alreadyOwned,
    createdAt: new Date().toISOString()
  };
  db.cards.push(card);
  await writeDb(db);
  res.json(card);
});

app.put('/api/cards/:id', async (req, res) => {
  const db = readDb();
  const idx = db.cards.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Card not found' });
  db.cards[idx] = { ...db.cards[idx], ...req.body, id: db.cards[idx].id };
  if ('cost' in req.body) db.cards[idx].cost = num(req.body.cost);
  await writeDb(db);
  res.json(db.cards[idx]);
});

// Lot purchase: N cards for one total price, cost split evenly (remainder cents
// distributed to the first few cards so the split always sums exactly to the total)
app.post('/api/cards/lot', async (req, res) => {
  const db = readDb();
  const { purchaseDate, totalCost, sport, source, notes, cardNames } = req.body;
  if (!Array.isArray(cardNames) || cardNames.length === 0) {
    return res.status(400).json({ error: 'cardNames must be a non-empty array' });
  }
  const n = cardNames.length;
  const totalCents = Math.round(num(totalCost) * 100);
  const baseCents = Math.floor(totalCents / n);
  const remainderCents = totalCents - baseCents * n;
  const lotId = genId('lot');
  const date = purchaseDate || new Date().toISOString().slice(0, 10);

  const created = cardNames.map((name, i) => {
    const costCents = baseCents + (i < remainderCents ? 1 : 0);
    const card = {
      id: genId('card'),
      player: String(name).trim() || `Lot item ${i + 1}`,
      sport: sport || '',
      purchaseDate: date,
      cost: +(costCents / 100).toFixed(2),
      source: source ? `Lot: ${source}` : 'Lot purchase',
      status: 'in_hand',
      notes: notes || '',
      lotId,
      needsCostReview: false,
      createdAt: new Date().toISOString()
    };
    db.cards.push(card);
    return card;
  });

  await writeDb(db);
  res.json(created);
});

app.delete('/api/cards/:id', async (req, res) => {
  const db = readDb();
  db.cards = db.cards.filter(c => c.id !== req.params.id);
  db.listings = db.listings.filter(l => l.cardId !== req.params.id);
  db.sales = db.sales.filter(s => s.cardId !== req.params.id);
  db.gradingCosts = db.gradingCosts.filter(g => g.cardId !== req.params.id);
  await writeDb(db);
  res.json({ ok: true });
});

// ---------- GRADING COSTS ----------
app.post('/api/grading', async (req, res) => {
  const db = readDb();
  const entry = {
    id: genId('grade'),
    cardId: req.body.cardId,
    company: req.body.company || 'PSA',
    grade: req.body.grade || '',
    cost: num(req.body.cost),
    date: req.body.date || new Date().toISOString().slice(0, 10)
  };
  db.gradingCosts.push(entry);
  await writeDb(db);
  res.json(entry);
});

app.delete('/api/grading/:id', async (req, res) => {
  const db = readDb();
  db.gradingCosts = db.gradingCosts.filter(g => g.id !== req.params.id);
  await writeDb(db);
  res.json({ ok: true });
});

// ---------- LISTINGS ----------
app.get('/api/listings', (req, res) => {
  res.json(readDb().listings);
});

app.post('/api/listings', async (req, res) => {
  const db = readDb();
  const listing = {
    id: genId('list'),
    cardId: req.body.cardId,
    platform: req.body.platform || 'eBay',
    listPrice: num(req.body.listPrice),
    listDate: req.body.listDate || new Date().toISOString().slice(0, 10),
    ebayListingId: req.body.ebayListingId || '',
    status: req.body.status || 'active', // active | ended | sold
    notes: req.body.notes || ''
  };
  db.listings.push(listing);
  // mark card as listed if currently in_hand
  const card = db.cards.find(c => c.id === listing.cardId);
  if (card && card.status === 'in_hand') card.status = 'listed';
  await writeDb(db);
  res.json(listing);
});

app.put('/api/listings/:id', async (req, res) => {
  const db = readDb();
  const idx = db.listings.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  db.listings[idx] = { ...db.listings[idx], ...req.body, id: db.listings[idx].id };
  await writeDb(db);
  res.json(db.listings[idx]);
});

app.delete('/api/listings/:id', async (req, res) => {
  const db = readDb();
  db.listings = db.listings.filter(l => l.id !== req.params.id);
  await writeDb(db);
  res.json({ ok: true });
});

// ---------- SALES ----------
app.get('/api/sales', (req, res) => {
  res.json(readDb().sales);
});

app.post('/api/sales', async (req, res) => {
  const db = readDb();
  const sale = {
    id: genId('sale'),
    cardId: req.body.cardId,
    platform: req.body.platform || 'eBay',
    salePrice: num(req.body.salePrice),
    shippingCharged: num(req.body.shippingCharged),
    fees: num(req.body.fees),
    shippingPaid: num(req.body.shippingPaid),
    saleDate: req.body.saleDate || new Date().toISOString().slice(0, 10),
    buyer: req.body.buyer || '',
    orderId: req.body.orderId || '',
    notes: req.body.notes || ''
  };
  sale.netProceeds = req.body.netProceeds !== undefined && req.body.netProceeds !== ''
    ? num(req.body.netProceeds)
    : recomputeNetProceeds(sale);
  db.sales.push(sale);
  const card = db.cards.find(c => c.id === sale.cardId);
  if (card) card.status = 'sold';
  await writeDb(db);
  res.json(sale);
});

app.put('/api/sales/:id', async (req, res) => {
  const db = readDb();
  const idx = db.sales.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sale not found' });
  const merged = { ...db.sales[idx], ...req.body, id: db.sales[idx].id };
  ['salePrice', 'shippingCharged', 'fees', 'shippingPaid'].forEach(k => { merged[k] = num(merged[k]); });
  merged.netProceeds = req.body.netProceeds !== undefined && req.body.netProceeds !== ''
    ? num(req.body.netProceeds)
    : recomputeNetProceeds(merged);
  db.sales[idx] = merged;
  await writeDb(db);
  res.json(db.sales[idx]);
});

app.delete('/api/sales/:id', async (req, res) => {
  const db = readDb();
  const sale = db.sales.find(s => s.id === req.params.id);
  db.sales = db.sales.filter(s => s.id !== req.params.id);
  if (sale) {
    const stillSold = db.sales.some(s => s.cardId === sale.cardId);
    if (!stillSold) {
      const card = db.cards.find(c => c.id === sale.cardId);
      if (card) card.status = 'in_hand';
    }
  }
  await writeDb(db);
  res.json({ ok: true });
});

// ---------- CASH ADJUSTMENTS ----------
app.get('/api/cash-adjustments', (req, res) => {
  res.json(readDb().cashAdjustments);
});

app.post('/api/cash-adjustments', async (req, res) => {
  const db = readDb();
  const entry = {
    id: genId('cash'),
    date: req.body.date || new Date().toISOString().slice(0, 10),
    amount: num(req.body.amount),
    note: req.body.note || ''
  };
  db.cashAdjustments.push(entry);
  await writeDb(db);
  res.json(entry);
});

app.delete('/api/cash-adjustments/:id', async (req, res) => {
  const db = readDb();
  db.cashAdjustments = db.cashAdjustments.filter(c => c.id !== req.params.id);
  await writeDb(db);
  res.json({ ok: true });
});

// ---------- eBay CSV IMPORT ----------
// Accepts pre-parsed rows + a column mapping decided by the frontend (after PapaParse).
// mode: 'sales' | 'purchases'
app.post('/api/import', async (req, res) => {
  const db = readDb();
  const { mode, rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

  const created = { cards: 0, sales: 0 };

  if (mode === 'sales') {
    for (const row of rows) {
      const card = {
        id: genId('card'),
        player: row.title || 'Imported eBay sale',
        sport: row.sport || '',
        purchaseDate: row.saleDate || new Date().toISOString().slice(0, 10),
        cost: 0,
        source: 'eBay import',
        status: 'sold',
        notes: 'Auto-created from eBay sales import — set cost basis',
        needsCostReview: true,
        createdAt: new Date().toISOString()
      };
      db.cards.push(card);
      created.cards++;

      const sale = {
        id: genId('sale'),
        cardId: card.id,
        platform: 'eBay',
        salePrice: num(row.salePrice),
        shippingCharged: num(row.shippingCharged),
        fees: num(row.fees),
        shippingPaid: num(row.shippingPaid),
        saleDate: row.saleDate || new Date().toISOString().slice(0, 10),
        buyer: row.buyer || '',
        orderId: row.orderId || '',
        notes: 'Imported from eBay CSV'
      };
      sale.netProceeds = recomputeNetProceeds(sale);
      db.sales.push(sale);
      created.sales++;
    }
  } else if (mode === 'purchases') {
    for (const row of rows) {
      const card = {
        id: genId('card'),
        player: row.title || 'Imported eBay purchase',
        sport: row.sport || '',
        purchaseDate: row.purchaseDate || new Date().toISOString().slice(0, 10),
        cost: num(row.cost),
        source: 'eBay import',
        status: 'in_hand',
        notes: 'Imported from eBay purchases CSV',
        needsCostReview: false,
        createdAt: new Date().toISOString()
      };
      db.cards.push(card);
      created.cards++;
    }
  } else {
    return res.status(400).json({ error: 'mode must be "sales" or "purchases"' });
  }

  await writeDb(db);
  res.json({ ok: true, created });
});

// ---------- EXPORT (backup) ----------
app.get('/api/export', (req, res) => {
  const db = readDb();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="cardbiz-backup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(db, null, 2));
});

app.get('/api/backups', (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
  res.json(files);
});

app.get('/api/backups/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(filePath);
});

// ---------- DASHBOARD ----------
app.get('/api/dashboard', (req, res) => {
  const db = readDb();

  const totalPurchaseCost = db.cards.reduce((s, c) => s + num(c.cost), 0);
  const totalGradingCost = db.gradingCosts.reduce((s, g) => s + num(g.cost), 0);
  const totalRevenue = db.sales.reduce((s, s2) => s + num(s2.salePrice) + num(s2.shippingCharged), 0);
  const totalFees = db.sales.reduce((s, s2) => s + num(s2.fees), 0);
  const totalShippingPaid = db.sales.reduce((s, s2) => s + num(s2.shippingPaid), 0);
  const totalNetProceeds = db.sales.reduce((s, s2) => s + num(s2.netProceeds), 0);

  const soldCardIds = new Set(db.sales.map(s => s.cardId));
  const onHandCards = db.cards.filter(c => !soldCardIds.has(c.id));
  const onHandCostValue = onHandCards.reduce((s, c) => s + costBasisForCard(db, c.id), 0);

  const realizedCostBasis = db.sales.reduce((s, s2) => s + costBasisForCard(db, s2.cardId), 0);
  const realizedPnL = +(totalNetProceeds - realizedCostBasis).toFixed(2);

  const cashDeposits = db.cashAdjustments.reduce((s, c) => s + num(c.amount), 0);
  const cashInHand = +(cashDeposits - totalPurchaseCost - totalGradingCost + totalNetProceeds).toFixed(2);

  const needsCostReview = db.cards.filter(c => c.needsCostReview).length;

  const activeListings = db.listings.filter(l => l.status === 'active').length;

  res.json({
    totals: {
      totalPurchaseCost: +totalPurchaseCost.toFixed(2),
      totalGradingCost: +totalGradingCost.toFixed(2),
      totalRevenue: +totalRevenue.toFixed(2),
      totalFees: +totalFees.toFixed(2),
      totalShippingPaid: +totalShippingPaid.toFixed(2),
      totalNetProceeds: +totalNetProceeds.toFixed(2)
    },
    inventory: {
      onHandCount: onHandCards.length,
      onHandCostValue: +onHandCostValue.toFixed(2)
    },
    pnl: {
      realizedCostBasis: +realizedCostBasis.toFixed(2),
      realizedPnL
    },
    cash: {
      cashDeposits: +cashDeposits.toFixed(2),
      cashInHand
    },
    flags: {
      needsCostReview,
      activeListings
    },
    counts: {
      cards: db.cards.length,
      sales: db.sales.length,
      listings: db.listings.length
    }
  });
});

app.listen(PORT, () => {
  console.log(`Card business dashboard running on port ${PORT}`);
});
