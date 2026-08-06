const express = require('express');
const path = require('path');
const fs = require('fs');
const { readDb, writeDb, genId, DB_PATH } = require('./store');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const BACKUP_RETENTION_DAYS = 30;
// photos live on the persistent disk (data/), NOT in public/ — public/ is source code
// and gets fully replaced on every deploy, which would silently delete photos
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

console.log('='.repeat(60));
console.log('DATA PATH DIAGNOSTIC — verify this matches your Render disk mount path');
console.log('DB_PATH:', DB_PATH);
console.log('BACKUP_DIR:', BACKUP_DIR);
console.log('UPLOADS_DIR:', UPLOADS_DIR);
console.log('Existing card count at boot:', (() => {
  try { return readDb().cards.length; } catch { return 'unreadable'; }
})());
console.log('='.repeat(60));

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
    estimatedValue: (req.body.estimatedValue !== undefined && req.body.estimatedValue !== '') ? num(req.body.estimatedValue) : null,
    displayCase: !!req.body.displayCase,
    photoUrl: req.body.photoUrl || null,
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
  if ('estimatedValue' in req.body) {
    db.cards[idx].estimatedValue = (req.body.estimatedValue === '' || req.body.estimatedValue === null)
      ? null
      : num(req.body.estimatedValue);
  }
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
app.get('/api/grading', (req, res) => {
  res.json(readDb().gradingCosts);
});

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

// ---------- DISPLAY CASE PHOTOS ----------
// Accepts a base64 data URI, writes the image to the persistent disk, and
// stores just the URL path on the card record.
app.post('/api/cards/:id/photo', async (req, res) => {
  const db = readDb();
  const card = db.cards.find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const dataUri = req.body.imageBase64;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUri || '');
  if (!match) return res.status(400).json({ error: 'Expected a base64 image data URI (png/jpeg/webp)' });

  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${card.id}-${Date.now()}.${ext}`;

  // remove any previous photo for this card so old files don't pile up
  if (card.photoUrl) {
    const oldPath = path.join(UPLOADS_DIR, path.basename(card.photoUrl));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }

  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  card.photoUrl = `/uploads/${filename}`;
  await writeDb(db);
  res.json({ photoUrl: card.photoUrl });
});

// ---------- CARD SCANNING (AI identification) ----------
// Sends a card photo to Claude, gets back player/year/brand/parallel/etc.
// Requires ANTHROPIC_API_KEY to be set in the environment — without it this
// returns a clear "not configured" error rather than failing silently.
app.post('/api/scan-card', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: 'Card scanning isn\'t set up yet. Add an ANTHROPIC_API_KEY environment variable in Render → your service → Environment, then redeploy.'
    });
  }

  const dataUri = req.body.imageBase64;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUri || '');
  if (!match) {
    return res.status(400).json({ error: 'Expected a base64 image data URI (png/jpeg/webp)' });
  }
  const mediaType = `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`;
  const base64Data = match[2];

  const prompt = `You're helping identify a trading card from a photo for a card reseller's inventory tool. Look at the card and respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "player": "player or character name, or null if unreadable",
  "year": "year on the card, or null",
  "brand": "e.g. Panini Prizm, Topps Chrome, or null",
  "parallel": "e.g. Silver, Gold /10, Base, or null if not visible",
  "cardNumber": "e.g. #301, or null",
  "sport": "e.g. Football, Basketball, Pokemon, or null",
  "confidence": "high, medium, or low — your honest confidence in this identification",
  "notes": "one short sentence flagging anything uncertain, or null if none"
}
If you genuinely cannot make out the card, set fields to null and confidence to "low" rather than guessing.`;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: `Card identification service returned an error (${apiRes.status}). Try again in a moment.` });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No identification result returned.' });

    let parsed;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse the identification result.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Card scan failed:', err.message);
    res.status(502).json({ error: 'Could not reach the card identification service. Check your connection and try again.' });
  }
});

// ---------- GRADING PRE-REVIEW (AI visual gut-check, not a real grade) ----------
// Takes front (required) and back (optional) photos and gives a rough read
// on centering/surface/corners/edges — meant to help decide whether a card
// is worth paying to submit, not to predict an actual PSA/BGS/SGC number.
app.post('/api/grade-review', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: 'Card scanning isn\'t set up yet. Add an ANTHROPIC_API_KEY environment variable in Render → your service → Environment, then redeploy.'
    });
  }

  const parseDataUri = (uri) => {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(uri || '');
    if (!m) return null;
    return { mediaType: `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, data: m[2] };
  };

  const front = parseDataUri(req.body.frontImageBase64);
  if (!front) {
    return res.status(400).json({ error: 'A front-of-card photo is required (base64 image data URI).' });
  }
  const back = req.body.backImageBase64 ? parseDataUri(req.body.backImageBase64) : null;

  const prompt = `You're doing a photo-based pre-grading assessment for a card reseller deciding whether a card is worth paying to submit for professional grading. Real AI grading tools (and human graders) evaluate front and back separately, give numeric centering ratios, and predict differently per grading company since PSA, BGS, and SGC weigh factors differently — BGS is known for stricter corner sub-grading and a tougher effective centering bar (roughly 60/40 front, 75/25 back for a top grade), SGC has a reputation for being strict on corners, PSA is comparatively more forgiving on borderline centering. Reflect those real tendencies in your predictions rather than giving identical numbers across companies.

Be honest about the hard limit of this method: a phone photo cannot show what a grader sees under raking light and 10x magnification. Surface micro-scratches, print lines, and true corner fraying are frequently invisible in a photo even when present. If lighting, glare, angle, or resolution limited what you could actually assess, say so directly in "issues" and lower your confidence, don't guess past what the image shows you.

Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{
  "photoQuality": { "front": "good, fair, or poor", "back": "good, fair, poor, or not provided", "issues": "note on glare/tilt/blur/lighting if any, or null" },
  "centering": {
    "front": { "ratio": "e.g. 60/40 left-right, 55/45 top-bottom, or null if not clearly measurable", "note": "one short sentence" },
    "back": { "ratio": "same format, or null if no back photo / not measurable", "note": "one short sentence or null" }
  },
  "surface": { "front": "one short sentence", "back": "one short sentence or null if no back photo" },
  "corners": { "front": "one short sentence", "back": "one short sentence or null if no back photo" },
  "edges": { "front": "one short sentence", "back": "one short sentence or null if no back photo" },
  "predictedGrades": {
    "PSA": { "range": "e.g. 7-9", "note": "one short sentence on what's most likely to hold it back, or null" },
    "BGS": { "range": "e.g. 6.5-8.5", "note": "one short sentence, or null" },
    "SGC": { "range": "e.g. 7-9", "note": "one short sentence, or null" }
  },
  "worthSubmitting": "leaning yes, leaning no, or unclear",
  "overallImpression": "one or two sentence honest summary",
  "confidence": "high, medium, or low — your honest confidence given photo quality and what a photo can even show"
}
Be conservative. Ranges should be genuine ranges (at least 1-2 points wide) reflecting real uncertainty from a photo, not false precision.`;

  const content = [
    { type: 'image', source: { type: 'base64', media_type: front.mediaType, data: front.data } }
  ];
  if (back) {
    content.push({ type: 'image', source: { type: 'base64', media_type: back.mediaType, data: back.data } });
  }
  content.push({ type: 'text', text: prompt + (back ? '\n\n(First image is the front, second is the back.)' : '\n\n(Only the front was provided — note in your notes that the back was not reviewed.)') });

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1100,
        messages: [{ role: 'user', content }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: `Grading review service returned an error (${apiRes.status}). Try again in a moment.` });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No review result returned.' });

    let parsed;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse the review result.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Grading review failed:', err.message);
    res.status(502).json({ error: 'Could not reach the grading review service. Check your connection and try again.' });
  }
});

// ---------- MANUAL CASH ON HAND ----------
// Not formula-derived — the person types in the real number directly.
app.put('/api/cash-on-hand', async (req, res) => {
  const db = readDb();
  db.manualCashOnHand = num(req.body.amount);
  await writeDb(db);
  res.json({ manualCashOnHand: db.manualCashOnHand });
});

// ---------- eBay CSV IMPORT ----------
// Accepts pre-parsed rows + a column mapping decided by the frontend (after PapaParse).
// mode: 'sales' | 'purchases'
app.post('/api/import', async (req, res) => {
  const db = readDb();
  const { mode, rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

  const created = { cards: 0, sales: 0, listings: 0 };

  if (mode === 'sales') {
    for (const row of rows) {
      const card = {
        id: genId('card'),
        player: row.title || 'Imported sale',
        sport: row.sport || '',
        purchaseDate: row.saleDate || new Date().toISOString().slice(0, 10),
        cost: 0,
        source: 'Bulk import',
        status: 'sold',
        notes: 'Auto-created from bulk sales import — set cost basis',
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
        notes: 'Imported from bulk sales file'
      };
      sale.netProceeds = recomputeNetProceeds(sale);
      db.sales.push(sale);
      created.sales++;
    }
  } else if (mode === 'purchases') {
    for (const row of rows) {
      const card = {
        id: genId('card'),
        player: row.title || 'Imported purchase',
        sport: row.sport || '',
        purchaseDate: row.purchaseDate || new Date().toISOString().slice(0, 10),
        cost: num(row.cost),
        source: row.source || 'Bulk import',
        status: 'in_hand',
        notes: 'Imported from bulk purchases file',
        needsCostReview: false,
        createdAt: new Date().toISOString()
      };
      db.cards.push(card);
      created.cards++;
    }
  } else if (mode === 'listings') {
    for (const row of rows) {
      const card = {
        id: genId('card'),
        player: row.title || 'Imported listing',
        sport: row.sport || '',
        purchaseDate: row.listDate || new Date().toISOString().slice(0, 10),
        cost: 0,
        source: 'Bulk import (from listing)',
        status: 'listed',
        notes: 'Auto-created from bulk listings import — set real cost basis',
        needsCostReview: true,
        createdAt: new Date().toISOString()
      };
      db.cards.push(card);
      created.cards++;

      const listing = {
        id: genId('list'),
        cardId: card.id,
        platform: row.platform || 'eBay',
        listPrice: num(row.listPrice),
        listDate: row.listDate || new Date().toISOString().slice(0, 10),
        ebayListingId: row.ebayListingId || '',
        status: 'active',
        notes: 'Imported from bulk listings file'
      };
      db.listings.push(listing);
      created.listings++;
    }
  } else {
    return res.status(400).json({ error: 'mode must be "sales", "purchases", or "listings"' });
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

// Restore overwrites current data with an uploaded export/backup file.
// The current state is snapshotted first (as a safety-of-safety-nets) so a
// bad restore can itself be undone by restoring the pre-restore snapshot.
app.post('/api/restore', async (req, res) => {
  const incoming = req.body;
  const requiredKeys = ['cards', 'listings', 'sales', 'gradingCosts', 'cashAdjustments'];
  const isValid = incoming && requiredKeys.every(k => Array.isArray(incoming[k]));
  if (!isValid) {
    return res.status(400).json({ error: 'File does not look like a valid Cardbiz backup (missing expected fields).' });
  }

  try {
    if (fs.existsSync(DB_PATH)) {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `pre-restore-${stamp}.json`));
    }
  } catch (err) {
    console.error('Pre-restore snapshot failed:', err.message);
  }

  await writeDb(incoming);
  res.json({ ok: true, counts: {
    cards: incoming.cards.length,
    listings: incoming.listings.length,
    sales: incoming.sales.length,
    gradingCosts: incoming.gradingCosts.length,
    cashAdjustments: incoming.cashAdjustments.length
  }});
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

// ---------- PERFORMANCE (date-range filterable) ----------
app.get('/api/performance', (req, res) => {
  const db = readDb();
  const { start, end } = req.query;
  const inRange = (dateStr) => {
    if (!dateStr) return false;
    if (start && dateStr < start) return false;
    if (end && dateStr > end) return false;
    return true;
  };

  const purchasesInRange = db.cards.filter(c => inRange(c.purchaseDate));
  const salesInRange = db.sales.filter(s => inRange(s.saleDate));

  const totalCost = purchasesInRange.reduce((s, c) => s + num(c.cost), 0);
  const totalRevenue = salesInRange.reduce((s, s2) => s + num(s2.salePrice) + num(s2.shippingCharged), 0);
  const totalFees = salesInRange.reduce((s, s2) => s + num(s2.fees), 0);
  const totalNetProceeds = salesInRange.reduce((s, s2) => s + num(s2.netProceeds), 0);
  const costBasisSold = salesInRange.reduce((s, s2) => s + costBasisForCard(db, s2.cardId), 0);
  const realizedPnL = +(totalNetProceeds - costBasisSold).toFixed(2);
  const avgSalePrice = salesInRange.length ? totalRevenue / salesInRange.length : 0;
  const avgMarginPct = totalNetProceeds > 0 ? (realizedPnL / totalNetProceeds) * 100 : 0;

  // per-day net proceeds, for a simple chart — one point per date that had a sale
  const byDate = {};
  salesInRange.forEach(s => {
    byDate[s.saleDate] = (byDate[s.saleDate] || 0) + num(s.netProceeds);
  });
  const daily = Object.entries(byDate)
    .map(([date, netProceeds]) => ({ date, netProceeds: +netProceeds.toFixed(2) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    range: { start: start || null, end: end || null },
    purchases: {
      count: purchasesInRange.length,
      totalCost: +totalCost.toFixed(2)
    },
    sales: {
      count: salesInRange.length,
      totalRevenue: +totalRevenue.toFixed(2),
      totalFees: +totalFees.toFixed(2),
      totalNetProceeds: +totalNetProceeds.toFixed(2),
      costBasisSold: +costBasisSold.toFixed(2),
      realizedPnL,
      avgSalePrice: +avgSalePrice.toFixed(2),
      avgMarginPct: +avgMarginPct.toFixed(1)
    },
    daily
  });
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

  const inHandCards = db.cards.filter(c => c.status === 'in_hand');
  const listedCards = db.cards.filter(c => c.status === 'listed');
  const availableCards = db.cards.filter(c => c.status !== 'sold'); // in_hand + listed combined

  const onHandCostValue = inHandCards.reduce((s, c) => s + costBasisForCard(db, c.id), 0);
  const onHandEstimatedValue = inHandCards.reduce((s, c) => {
    return s + (c.estimatedValue !== null && c.estimatedValue !== undefined ? num(c.estimatedValue) : costBasisForCard(db, c.id));
  }, 0);
  const onHandWithEstimate = inHandCards.filter(c => c.estimatedValue !== null && c.estimatedValue !== undefined).length;

  const listedCostValue = listedCards.reduce((s, c) => s + costBasisForCard(db, c.id), 0);
  const listedEstimatedValue = listedCards.reduce((s, c) => {
    return s + (c.estimatedValue !== null && c.estimatedValue !== undefined ? num(c.estimatedValue) : costBasisForCard(db, c.id));
  }, 0);
  const listedWithEstimate = listedCards.filter(c => c.estimatedValue !== null && c.estimatedValue !== undefined).length;

  // combined "available" figures — this is what shows on the main dashboard now
  const availableCostValue = availableCards.reduce((s, c) => s + costBasisForCard(db, c.id), 0);
  const availableEstimatedValue = availableCards.reduce((s, c) => {
    return s + (c.estimatedValue !== null && c.estimatedValue !== undefined ? num(c.estimatedValue) : costBasisForCard(db, c.id));
  }, 0);
  const availableWithEstimate = availableCards.filter(c => c.estimatedValue !== null && c.estimatedValue !== undefined).length;

  // most recent listing per listed card, to avoid double-counting relisted cards
  const latestListingByCard = {};
  db.listings.forEach(l => {
    const existing = latestListingByCard[l.cardId];
    if (!existing || new Date(l.listDate) >= new Date(existing.listDate)) {
      latestListingByCard[l.cardId] = l;
    }
  });
  const listedAskingTotal = listedCards.reduce((s, c) => {
    const listing = latestListingByCard[c.id];
    return s + (listing ? num(listing.listPrice) : 0);
  }, 0);

  const realizedCostBasis = db.sales.reduce((s, s2) => s + costBasisForCard(db, s2.cardId), 0);
  const realizedPnL = +(totalNetProceeds - realizedCostBasis).toFixed(2);

  // "True" P&L split: pre-owned cards have $0 cost by definition, so a sale of
  // one reads as 100% profit even though no capital was actually deployed.
  // Splitting this out shows what's really coming from invested capital vs.
  // liquidating a pre-existing collection.
  const isPreOwned = (cardId) => {
    const c = db.cards.find(x => x.id === cardId);
    return !!(c && c.alreadyOwned);
  };
  const purchasedSales = db.sales.filter(s2 => !isPreOwned(s2.cardId));
  const preOwnedSales = db.sales.filter(s2 => isPreOwned(s2.cardId));
  const purchasedNetProceeds = purchasedSales.reduce((s, s2) => s + num(s2.netProceeds), 0);
  const purchasedCostBasis = purchasedSales.reduce((s, s2) => s + costBasisForCard(db, s2.cardId), 0);
  const purchasedRealizedPnL = +(purchasedNetProceeds - purchasedCostBasis).toFixed(2);
  const preOwnedNetProceeds = preOwnedSales.reduce((s, s2) => s + num(s2.netProceeds), 0);
  const preOwnedCostBasis = preOwnedSales.reduce((s, s2) => s + costBasisForCard(db, s2.cardId), 0); // usually $0 unless graded
  const preOwnedRealizedPnL = +(preOwnedNetProceeds - preOwnedCostBasis).toFixed(2);

  const purchasedAvailable = availableCards.filter(c => !c.alreadyOwned);
  const preOwnedAvailable = availableCards.filter(c => c.alreadyOwned);
  const purchasedAvailableCostValue = purchasedAvailable.reduce((s, c) => s + costBasisForCard(db, c.id), 0);
  const purchasedAvailableEstValue = purchasedAvailable.reduce((s, c) => {
    return s + (c.estimatedValue !== null && c.estimatedValue !== undefined ? num(c.estimatedValue) : costBasisForCard(db, c.id));
  }, 0);
  const preOwnedAvailableEstValue = preOwnedAvailable.reduce((s, c) => {
    return s + (c.estimatedValue !== null && c.estimatedValue !== undefined ? num(c.estimatedValue) : costBasisForCard(db, c.id));
  }, 0);

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
      availableCount: availableCards.length,
      availableCostValue: +availableCostValue.toFixed(2),
      availableEstimatedValue: +availableEstimatedValue.toFixed(2),
      availableWithEstimate,
      onHandCount: inHandCards.length,
      onHandCostValue: +onHandCostValue.toFixed(2),
      onHandEstimatedValue: +onHandEstimatedValue.toFixed(2),
      onHandWithEstimate,
      listedCount: listedCards.length,
      listedCostValue: +listedCostValue.toFixed(2),
      listedEstimatedValue: +listedEstimatedValue.toFixed(2),
      listedWithEstimate,
      listedAskingTotal: +listedAskingTotal.toFixed(2),
      purchasedAvailableCount: purchasedAvailable.length,
      purchasedAvailableCostValue: +purchasedAvailableCostValue.toFixed(2),
      purchasedAvailableEstValue: +purchasedAvailableEstValue.toFixed(2),
      preOwnedAvailableCount: preOwnedAvailable.length,
      preOwnedAvailableEstValue: +preOwnedAvailableEstValue.toFixed(2)
    },
    pnl: {
      realizedCostBasis: +realizedCostBasis.toFixed(2),
      realizedPnL,
      purchasedSalesCount: purchasedSales.length,
      purchasedRealizedPnL,
      preOwnedSalesCount: preOwnedSales.length,
      preOwnedRealizedPnL
    },
    cash: {
      cashOnHand: +num(db.manualCashOnHand).toFixed(2)
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
