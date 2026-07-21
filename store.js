const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

const EMPTY_DB = {
  cards: [],       // { id, player, sport, purchaseDate, cost, source, status, notes, createdAt }
  listings: [],     // { id, cardId, platform, listPrice, listDate, ebayListingId, status, notes }
  sales: [],         // { id, cardId, platform, salePrice, shippingCharged, fees, shippingPaid, netProceeds, saleDate, buyer, orderId, notes }
  gradingCosts: [],  // { id, cardId, company, grade, cost, date }
  cashAdjustments: [] // { id, date, amount, note }  amount positive=deposit, negative=withdrawal
};

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    // backfill any missing collections for forward-compat
    for (const key of Object.keys(EMPTY_DB)) {
      if (!Array.isArray(parsed[key])) parsed[key] = [];
    }
    return parsed;
  } catch (e) {
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
}

let writeQueue = Promise.resolve();
function writeDb(db) {
  // serialize writes so concurrent requests don't clobber each other
  writeQueue = writeQueue.then(() => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  });
  return writeQueue;
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { readDb, writeDb, genId, DB_PATH };
