# Cardbiz

A live P&L dashboard for a sports card buying/selling business — inventory, listings, sales,
grading costs, AI card scanning, AI grading pre-review, and a Display Case for long-term holds.
Built to run as your own private instance; nothing here is a hosted service.

## What it tracks

- **Inventory** — every card, its true cost basis (purchase + grading), status (in hand / listed / sold),
  and an estimated market value you set yourself, with a one-tap link to check real eBay sold comps
- **Listings** — active listings across eBay or any platform, sorted by highest asking price
- **Sales** — sale price, fees, net proceeds, sorted most-recent-first
- **Grading costs** — attach to any card, rolls straight into its cost basis
- **Display Case** — a separate space for cards you're holding long-term, photos included, kept out
  of your day-to-day P&L math
- **Performance** — date-range filtered revenue, P&L, and a chart of net proceeds over time
- **AI card scanning** — photograph a card and auto-fill player/sport into the purchase form
- **AI grading pre-review** — a photo-based read on centering, surface, corners, and edges before
  you pay to submit a card for real grading (not a substitute for an actual grade — see in-app disclaimers)
- **True P&L breakdown** — separates profit from cards you actually paid for vs. cards you already
  owned before tracking, since pre-owned cards carry no real cost basis
- **Manual cash on hand** — a number you type in yourself, not a formula
- **Bulk import** — CSV templates for purchases, sales, and listings; paste rows directly, no file needed
- **Backups & restore** — automatic daily snapshots, plus a manual export/restore you control

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000. Data is stored in `data/db.json`, created automatically.

## Deploying your own copy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Tyc0-29/Carbiz-Dashboard)

Click the button above. Render will ask you to connect your GitHub account (creates a free Render
account if you don't have one), then walks you through creating your own separate copy — your own
repo, your own service, your own data. The persistent disk is configured automatically as part of
this, at the correct path, so there's no manual disk setup step to miss.

You'll be prompted for one optional field:

- **ANTHROPIC_API_KEY** — only needed if you want the AI card-scanning and grading-review features.
  Leave it blank to skip those for now; you can add it later in Render → Environment. Get a key at
  console.anthropic.com — new accounts get free trial credit, no card required.

That's it. A few minutes later you'll have a live URL running your own instance.

**Note:** the persistent disk requires a paid Render plan (currently the Starter tier, a few dollars
a month) — Render's free tier doesn't support persistent disks, and without one your data would be
wiped on every deploy. This isn't optional for this app.

<details>
<summary>Manual setup instead (if you'd rather not use the button)</summary>

1. Click **Use this template** on GitHub (or fork this repo) into your own account
2. On Render: New → Web Service → connect your new repo
3. Add a **persistent disk** mounted at `/opt/render/project/src/data` — without this, your data
   will be wiped on every deploy
4. Optional: add an `ANTHROPIC_API_KEY` environment variable
5. Deploy

</details>

## Rebranding to your own name/colors

Everything visual is centralized so this takes a few minutes, not a code rewrite:

- **Colors**: `public/styles.css`, top of the file, inside `:root { }` — change the hex values,
  every color in the app follows from these
- **Business name**: search for `TyCo` across `public/index.html` (page title, header) and
  `public/manifest.json` (app name/description) — replace with your own
- **Logo/icon**: swap `public/brand-fan.png`, `public/favicon-32.png`, `public/favicon-64.png`,
  `public/apple-touch-icon.png`, and `public/icons/icon-192.png` / `icon-512.png` with your own images
  at the same filenames and dimensions

## License — read this before you deploy

MIT License — see `LICENSE`. In plain terms: you're free to use, copy, modify, and deploy this
for your own business, no restrictions. It's provided **as-is, with no warranty and no ongoing
support or updates** from the original author. You are responsible for your own deployment, your
own data backups, and your own hosting costs. If something breaks, you're welcome to fix it
yourself, that's what the source code is for.
