# TyCo's Cardbiz — Dashboard

A live P&L dashboard for your sports card buying/selling business: purchases, listings, sales,
on-hand inventory value, and cash in hand — with eBay CSV import for the ~90% of activity that
happens there, plus manual entry for everything else.

## What it tracks

- **Inventory** — every card you've bought, its cost basis, and status (in hand / listed / sold)
- **Grading costs** — attachable to any card, rolled into its cost basis
- **Listings** — active/ended listings across eBay or any other platform
- **Sales** — sale price, buyer-paid shipping, platform fees, your shipping cost → net proceeds
- **Cash adjustments** — starting capital, extra deposits, withdrawals
- **Dashboard** — realized P&L, cash in hand, on-hand inventory value (at cost), revenue breakdown,
  and a recent-activity feed

**Realized P&L** = net proceeds from sales − cost basis (purchase price + grading) of those cards.
**Cash in hand** = cash deposits − purchase costs − grading costs + net sale proceeds.
**On-hand inventory value** is valued **at cost**, not live market price (there's no reliable free
market-value feed for raw sports cards — you can manually track estimated value separately if you want).

## Running it locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Your data is stored in `data/db.json`, created automatically.

## Deploying so you have a real, always-on URL

The easiest free option is **Render.com** (a persistent disk keeps `data/db.json` between deploys).

1. Push this folder to a new GitHub repo (private is fine).
2. Go to https://render.com → New → Web Service → connect that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Add a **persistent disk**: Render dashboard → your service → Disks → Add Disk →
   mount path `/opt/render/project/src/data`, size 1GB. This is what keeps your data across restarts/deploys.
5. Deploy. Render gives you a URL like `https://your-app.onrender.com` — that's your live dashboard,
   reachable from any device.

Free-tier Render services sleep after inactivity and take ~30s to wake on the next visit — fine for
a personal tool you check a few times a day. If that's annoying, Railway.app works the same way and
has a similar free tier, or you can pay a few dollars/month on Render for an always-on instance.

## Importing eBay data

eBay → Seller Hub → **Orders** (for sales) or **Payments → Reports** (for fee detail) → Export → CSV.

In the app's **Import eBay CSV** tab: upload the file, tell it whether it's a sales or purchases
export, confirm the auto-detected column mapping (it guesses based on common eBay column names —
double check it), and import. Sales imported this way create a placeholder inventory card with
$0 cost, flagged with a ⚠ in Inventory — go fill in the real price you paid so P&L is accurate.

## Adding true live eBay API sync later

This app is intentionally structured so a live sync can be added without a rewrite: it would mean
registering an eBay developer app, storing the OAuth token server-side (never in the browser), and
adding a scheduled job in `server.js` that calls eBay's Fulfillment/Trading API and writes into the
same `cards`/`sales`/`listings` collections the CSV importer already uses. Worth doing once you're
past the CSV-import stage and want it fully hands-off — happy to help build that layer when you're
ready.

## Project structure

```
server.js       Express API (cards, listings, sales, grading, cash, import, dashboard)
store.js        Tiny JSON-file datastore (no database server needed)
public/         Frontend (vanilla JS, no build step)
data/db.json    Your data (created on first run, not committed to git)
```
