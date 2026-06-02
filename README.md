# GARV Sales Performance Dashboard

**Version 4.3.7** — May 2026

A zero-build, single-page dashboard that scores sales reps across all nine **Great American RV SuperStores** rooftops (plus a cross-rooftop **Airstream** brand view) from a single weekly VinSolutions master lead CSV export. All scoring runs in the browser; the only server-side components are four lightweight Netlify Functions for cross-device sync and an AI proxy.

---

## Table of Contents

1. [What This Is](#what-this-is)
2. [Architecture at a Glance](#architecture-at-a-glance)
3. [Project Structure](#project-structure)
4. [Data Flow](#data-flow)
5. [Stores & Tabs](#stores--tabs)
6. [Scoring Methodology](#scoring-methodology)
7. [The Split-Date Pipeline (v4.1)](#the-split-date-pipeline-v41)
8. [Customer Dedup](#customer-dedup)
9. [Filters & Exclusions](#filters--exclusions)
10. [The Airstream Brand Tab](#the-airstream-brand-tab)
11. [Lineup Positions](#lineup-positions)
12. [Date-Range Filtering](#date-range-filtering)
13. [Privacy & PII Handling (v4.3.3 / v4.3.4)](#privacy--pii-handling-v433--v434)
14. [Netlify Functions](#netlify-functions)
15. [Storage Model](#storage-model)
16. [AI Coach](#ai-coach)
17. [Local Development](#local-development)
18. [Deployment](#deployment)
19. [Versioning Notes](#versioning-notes)
20. [Known Quirks & Design Rationale](#known-quirks--design-rationale)

---

## What This Is

GARV Performance is the internal weekly scorecard for sales reps at the nine GARV RV rooftops and the GARV-Airstream brand. The workflow is:

1. A manager exports the **master lead report** from VinSolutions (one combined CSV that contains both lead records and showroom visit records merged into a single file with duplicate header names).
2. They drop the CSV onto the dashboard (or the corresponding store tab).
3. The browser parses, dedupes, filters, scores, and renders the scorecard in milliseconds.
4. The CSV is mirrored to a server-side Netlify blob (raw CSV kept private to the server, computed scores returned publicly) so other devices loading the page see the latest results.
5. The dashboard exposes baseball-card lineups, a flat scorecard table, AI coaching, a weekly history log, and a methodology page that doubles as documentation.

Design reference points: Linear's nav, Vercel's dashboard density, Hex's card structure, Retool's data tables. Dark, monochromatic, sharp. Accent only where it earns it.

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (public/index.html — single 2,475-line file)           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ • Custom RFC-ish CSV parser (handles duplicate headers)   │  │
│  │ • Union-find customer dedup (name / email / phone)        │  │
│  │ • Split-date scoring pipeline (recompute)                  │  │
│  │ • Lineup classification (Starter / Lineup / DH / Bench)   │  │
│  │ • Date-range re-scoring from cached PII-stripped rows     │  │
│  │ • Baseball cards, scorecard table, coaching cards         │  │
│  │ • localStorage: computed scores + sanitized row cache     │  │
│  └────────────────┬──────────────────────────────────────────┘  │
└───────────────────┼──────────────────────────────────────────────┘
                    │ /api/upload   (POST: CSV + computed JSON)
                    │ /api/store/:id (GET: scores only / DELETE)
                    │ /api/store/:id/history (GET / DELETE)
                    │ /api/ai       (POST: proxied to Anthropic)
┌───────────────────▼──────────────────────────────────────────────┐
│  Netlify Functions (netlify/functions/*.mjs)                     │
│  ┌──────────────┬──────────────┬───────────────┬────────────┐    │
│  │ upload.mjs   │ store-data   │ store-history │ ai-proxy   │    │
│  │ → Blobs      │ → Blobs(GET) │ → Blobs       │ → Anthropic│    │
│  │              │ (PII stripped│               │  Messages  │    │
│  │              │  on read)    │               │  API       │    │
│  └──────────────┴──────────────┴───────────────┴────────────┘    │
└───────────────────┬──────────────────────────────────────────────┘
                    │
              ┌─────▼──────┐
              │  Netlify   │
              │  Blobs     │
              │  store:    │
              │  "garv"    │
              │  ────────  │
              │  raw_<id>  │  full CSV (PII; server-only)
              │  store_<id>│  computed scores (public)
              │  hist_<id> │  upload history (public)
              └────────────┘
```

**Key principle:** the browser is the source of truth for scoring math. The server just stores artifacts. Anyone who has the CSV can reproduce the scores offline.

---

## Project Structure

```
garvsalesscorecard/
├── public/
│   └── index.html              # Entire dashboard — HTML, CSS, JS in one file
├── netlify/
│   └── functions/
│       ├── upload.mjs          # POST /api/upload  — stores raw CSV + computed scores
│       ├── store-data.mjs      # GET/DELETE /api/store/:id  — returns scores only
│       ├── store-history.mjs   # GET/DELETE /api/store/:id/history
│       └── ai-proxy.mjs        # POST /api/ai  — proxies to Anthropic Messages API
├── netlify.toml                # Build + redirects + CORS
├── package.json                # Single dep: @netlify/blobs
└── deno.lock
```

There is **no build step**. `netlify.toml` declares `command = "echo 'No build step required'"`. `index.html` ships as-is. The Netlify Functions are bundled by esbuild at deploy time.

---

## Data Flow

### Upload Path (Browser → Server)

1. User drops `hammond_master_leads_05_25_26.csv` onto the upload modal.
2. `processUpload()` reads the file as text.
3. `parseMasterCSVv2()` tokenizes into rows of fields. Duplicate-named columns are disambiguated by suffix (`_2`) — the master CSV has two `Customer`, two `Dealer`, two `Lead Source`, two `Lead Type` columns because the report merges leads with showroom visits. The first occurrence wins for canonical aliases (`H.LEAD_SOURCE`, `H.CUSTOMER`, etc.).
4. `looksLikeMasterCSV()` verifies the header has both a `Sales Rep` (leads section) and `Visit Result` + `Write Up` (visits section) — protects against accidentally uploading a leads-only export.
5. `recompute(rows, H, storeId, '', '')` runs the full scoring pipeline (filters → dedup → split-date classification → per-rep stats → lineup assignment).
6. The result is persisted to `localStorage` under `garv7_d_<storeId>` (PII-stripped automatically by `setStoreData`).
7. The previous data (if any) is snapshotted to `garv7_h_<storeId>` (history, max 20 entries).
8. The PII-stripped row cache is written to `garv7_rs_<storeId>` so date-range filtering still works after a page reload (v4.3.4).
9. `syncToBackend()` POSTs both the raw CSV and a `computed.json` sidecar to `/api/upload`. The filename is **always synthesized from the target storeId** (`<storeAlias>_master_leads_<dd>_<mm>_<yy>.csv`), not preserved from the upload, to prevent the v4.3.1 bug where uploading a `hammond_*.csv` to the Airstream tab silently overwrote `store_hammond` on the server.

### Hydration Path (Server → Browser)

On page load, the dashboard `fetch`s `/api/store/<id>` for every store in parallel.

- **v4.3.3+ servers** return precomputed scores only (`reps`, `totals`, `period`, `fileName`, `uploadedAt`). The browser sets them directly via `setStoreData()`.
- **Legacy servers** that still return `_masterText` (the raw CSV) trigger a client-side re-score so the browser always uses the same scoring rules as the current dashboard version. The raw text goes into the in-memory `_masterCache` (session-only, never written to localStorage).
- If localStorage already has fresher data for a store, the server response is ignored for that store.

### Date-Range Re-Score Path

When the user picks a date range (MTD / Last 30 / Last 7 / custom):

1. If the raw CSV is in `_masterCache` (just uploaded this session) → parse + recompute with date bounds.
2. Else, if the sanitized row cache `garv7_rs_<id>` exists → recompute from those rows.
3. Else → date pickers are disabled (no row source available; only cached scores can be shown).

Path 2 is the v4.3.4 fix that lets users re-scope by date after a page reload without re-uploading the CSV, while keeping PII out of localStorage.

---

## Stores & Tabs

The store registry lives at the top of the `<script>` block in `public/index.html`:

```js
const STORES = [
  {id:'hammond',       name:'Hammond',          st:'LA'},
  {id:'grand_bay',     name:'Grand Bay',        st:'AL'},
  {id:'heflin',        name:'Heflin',           st:'AL'},
  {id:'calera',        name:'Calera',           st:'AL'},
  {id:'huntsville',    name:'Huntsville',       st:'AL'},
  {id:'hattiesburg',   name:'Hattiesburg',      st:'MS'},
  {id:'tupelo',        name:'Tupelo',           st:'MS'},
  {id:'breaux_bridge', name:'Breaux Bridge',    st:'LA'},
  {id:'defuniak',      name:'Defuniak Springs', st:'FL'},
  {id:'airstream',     name:'Airstream',        st:'BRAND', isAirstream:true},
];
```

Plus a synthetic **Network** tab (always present, shows rooftop rollup KPIs).

A second registry, `STORE_ALIAS_MAP` in `netlify/functions/upload.mjs`, maps filename prefixes (after stripping non-letters) to canonical store IDs. **Both registries must stay in sync.**

---

## Scoring Methodology

Composite score is out of **100 points**, weighted as follows:

| Weight | Component               | Formula                                                                                                                                       |
| ------:| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
|   30%  | **Conversion Rate**     | `(deliveries-in-period / valid-leads-originated-in-period) × 30`                                                                              |
|   20%  | **Delivery Volume**     | `(rep.delivered / max_delivered_at_this_location) × 20`                                                                                       |
|   15%  | **Speed to Lead**       | Tiered on median Adjusted Response Time for **internet leads only**: <15m=15, <60m=12, <240m=8, else 4. Default 10 when no internet data.     |
|   15%  | **Contact Discipline**  | `((contact_rate + multi_channel_rate) / 2) × 15`                                                                                              |
|   20%  | **Showroom Process**    | `((visits / max_visits) + (write_ups / max_write_ups)) / 2 × 20`                                                                              |

**Not scored:** revenue, gross. VinSolutions gross is pre-adjustment; IDS is authoritative for margin. We deliberately don't display either.

### Conversion = deliveries ÷ valid leads

- **Numerator:** unique customers whose canonical row has `Lead Status Type == 'Sold'` AND `Lead Last Modified Date` in-period (sale-date proxy).
- **Denominator:** unique customers whose canonical row has `Lead Origination Date` in-period AND `Lead Status` is not in the `BAD_STATUSES` set.

`BAD_STATUSES` (excluded from denominator):

```
Bad Credit
Bad or no contact information
Dealer test lead
Duplicate lead
No intent to buy
Out of market
Purchased different brand different dealer
Purchased from private party
Requested no further contact
```

### Speed Tier — Internet Leads Only

Walk-in and phone leads have a response time of zero by definition (the customer is in front of the rep). Scoring them on response time penalizes nothing and makes the metric meaningless. Speed is computed **only on rows where `Lead Type == 'Internet'`**.

Source: VinSolutions' `Adjusted Response Time (Min)` column. This is **already** business-hours-adjusted to store hours (Mon–Sat 8AM–6PM Central). We use it directly. A lead arriving at 10PM has its clock started at next-open inside that column already.

Special case: `ADJ == 0` is treated as an instant response **if** there was a logged contact attempt at or after the lead's origination timestamp. Without this rule, overnight leads answered right at open get penalized.

Minimum 3 internet leads required to compute a median; otherwise speed defaults to N/A and 10 points.

### Contact Discipline

- **Contact rate** — `Contacted Indicator == 'Yes'` divided by valid leads.
- **Multi-channel rate** — at least 2 of `Last Attempted Phone`, `Last Attempted Email`, `Last Attempted Text` populated, divided by valid leads.
- Discipline score = average of the two.

### Showroom Process — The Visit Credit Rule

This is the rule that caused the most pain in v3 → v4:

> **A row counts as a visit for a rep when `Showroom Visit ID` is populated AND the rep's `Sales Rep` value (col L) survived the row-level pre-filter AND the row's `Assigned User - User Group` is NOT in `{Manager, Reception, Admin}`.**

What v3 got wrong: it dropped visits whose `Completed By User - User Group` was Manager / Reception / Admin. But in normal VinSolutions desk workflow, **the manager at the desk closes out every visit** — so `Completed By` is "Manager" on ~96% of visits at every store. The v3 guard silently dropped almost all visit credit. Every rep showed 0 visits across the board.

The fix in v4: only `Assigned User` (the person actually working the floor) is checked against the manager-group guard. `Completed By` and `Created By` are normal desk workflow, not who ran the visit.

Visits with `Visit Result == 'Deleted'` are still excluded (those are CRM cancellations).

Write-ups: `Write Up == 'Y'` on a counted visit row.

### Sold Count is intentionally NOT used

`H.SOLD_COUNT` is **deliberately not mapped** in the parser. VinSolutions' Sold Count includes legacy sale records from previous versions of the same lead — a lead that was sold, then unwound (financing fell through), then reopened as Active will still have `Sold Count > 0` even though it's no longer a delivery.

The dashboard uses `Lead Status Type == 'Sold'` as the sole delivery signal. Audit on the May 2026 Hattiesburg export found 23 of 482 rows (4.8%) where Sold Count > 0 but Lead Status Type != 'Sold'. Trusting Sold Count would have overcounted Hattiesburg deliveries by ~11%.

---

## The Split-Date Pipeline (v4.1)

The dashboard scores by **two different date fields** on the same dataset:

- **Lead count (denominator)** = unique customers whose canonical row has `Lead Origination Date` in-period.
- **Delivery count (numerator)** = unique customers whose cluster contains any row with `Lead Status Type == 'Sold'` AND `Lead Last Modified Date` in-period (proxy for sale date — VinSolutions does not expose a dedicated close-date column).

**Why split:** a lead originated in March that closes in April is an April delivery. Pre-filtering on origination would drop it. Pre-filtering on modification would inflate March's denominator with leads that came in months ago.

A row is kept downstream if it contributes to **lead OR delivery counts** in this period. Out-of-period rows that aren't sold-this-period are dropped entirely so they don't pollute speed and contact medians.

Conversion = `deliveries-in-period / valid-leads-originated-in-period`. Numerator and denominator are intentionally measured on different customer cohorts — this is a **throughput rate for the period**, not a same-customer cohort rate.

### Pending Finance Roll-Off

If a deal is `Pending Finance` in one upload and the financing falls through before the next upload, VinSolutions flips the Lead Status to `Bad Credit` or `No agreement reached`, which both have `Lead Status Type == 'Lost'`. `isDelivered()` returns false on the next scoring run, and the rep automatically loses the delivery credit. No manual cleanup needed — scoring is recomputed fresh from the uploaded CSV every time.

---

## Customer Dedup

The same customer can appear in the CSV many times: assigned to multiple reps over time, multiple visit records, manual re-creation by the desk, leads merged late, etc. We dedupe globally before scoring.

**Algorithm:** union-find. Each row is a node. Two rows are merged if they share any of:

- Normalized customer name (lowercase, collapsed whitespace)
- Normalized email (lowercased, must contain `@`)
- Normalized phone (digits only, drop leading `1`, must be exactly 10 digits)

Phone candidates pulled from `Daytime Phone`, `Evening Phone`, `Cell Phone`.

**Canonical row picker:** for each connected component, the row with `Lead Status Type == 'Sold'` wins. Ties broken by latest `Lead Origination Date`. This ensures a delivered customer never gets demoted to "not delivered" because dedup picked the wrong row.

Dedup runs **before** PII stripping (v4.3.4 fix). If we blanked Customer/Email/Phone first, no dups would merge and the cached row set would over-count leads and deliveries on re-score.

---

## Filters & Exclusions

Applied in `recompute()`'s Step 1:

1. **700 Credit** — credit-app sourced leads, never counted as sales pipeline.
   - Rooftop tabs: exact match `Lead Source == '700credithmd'` OR `Lead Source Group == '700 Credit'`.
   - Airstream tab: substring `'700'` anywhere in either field (mirrors the VinSolutions saved filter).
2. **Airstream identification** — see [The Airstream Brand Tab](#the-airstream-brand-tab).
   - Rooftop tabs: drop Airstream rows.
   - Airstream tab: keep only Airstream rows.
3. **Rep blacklist** — managers, BDC, house accounts:
   ```
   Tony Vitrano, Christian Borrouso, Shane Roberts, Pete Smith,
   Tyler Zimmerman, Ed Savage, Joe Steffen, Joshua Brevick,
   James Duos, Justin Mire, James Murphy, Tommy Sacran,
   Jerry Jones, Chris Seehorn, Matt Kramer, Mike Lindemood,
   Steve Smith, Bradley Smart, Matthew Justice, John Schuster
   ```
   Note: `John Schuster Jr` is a salesperson and normalizes to a different string. Only the manager (no "Jr") is blocked.
4. **System accounts** — name contains `'your friends at great american rv'` or `'yod house agent'`.
5. **Empty Sales Rep** — row dropped.
6. **Manager user groups** — `Assigned User - User Group` in `{Manager, Reception, Admin}` (visit-level filter only).
7. **Minimum 10 valid leads** — rooftop tabs require this floor to be scored. Airstream tab drops it to 1 (most reps see Airstream leads only occasionally; 10-lead minimum would hide ~80% of the pipeline).

**v4.2 change:** per-store whitelists were removed. Anyone listed in the `Sales Rep` column who isn't on the manager blacklist is automatically scored. New hires no longer need a code update.

---

## The Airstream Brand Tab

Added in v4.3 (May 2026). The Airstream tab inverts the standard filter: it keeps **only** Airstream-identified rows from any rooftop (including the never-before-shown "Airstream of GARV" rooftop) and presents them as a single cross-rooftop brand pipeline.

### Identification Rules (`AIRSTREAM_RULES`)

A row counts as Airstream if **any** of:

- `Lead Source` contains `'airstream'` (case-insensitive)
- `Lead Source` contains `'aimbase'` (case-insensitive)
- `Lead Source Group` contains `'airstream'`
- `Make` contains `'airstream'`

**Empirical distribution** (May 2026 export, 363 Airstream rows):

| Source                              | Rows | %    |
| ----------------------------------- | ---: | ----:|
| `Aimbase-Hubspot Lead`              | 285  | 78%  |
| `Make = Airstream`                  |  74  | 20%  |
| `Lead Source = Airstream`           |  11  |  3%  |
| Plus long tail of Aimbase-* and Dtk-* Airstream-tagged sources. |   |   |

The Aimbase rule is non-negotiable — without it we'd miss ~80% of the pipeline.

### Bad-Status Enforcement

The Airstream tab also enforces the VinSolutions saved-filter rules:

- `[Lead Status Custom] Not = 'Bad'` (exact match, case-insensitive)
- `[Lead Status Type] Not = 'Bad'` (exact match, case-insensitive)

Rooftop tabs do **not** enforce these — they keep the existing behavior.

### Per-Rep Per-Dealer Breakdown

Reps who handle Airstream leads at multiple rooftops (e.g. Tara Birkla, who carries them at the GARV-Airstream rooftop and her home store) get a `byDealer` array on their rep object showing each dealer's contribution. The baseball card renders this as an expandable `<details>` block.

Dealer names are cleaned via `cleanDealerName()`:
- `"Great American RV SuperStores, Calera"` → `"Calera"`
- `"Great American RV SuperStores of Huntsville"` → `"Huntsville"`
- `"Airstream of GARV"` → `"Airstream of GARV"` (passes through unchanged)

### Per-Store Rollup

The Airstream tab also computes `byStore` — total leads, valid leads, delivered, and rep count per dealer. Rendered as a top-of-page band so leadership can see at a glance which rooftops carry Airstream volume vs which need attention.

### Network Overview Exclusion

Network KPIs deliberately exclude the Airstream tab to avoid double-counting. Every rooftop already shows its non-Airstream totals; Airstream is a parallel brand view, not a 10th rooftop.

---

## Lineup Positions

After scoring, reps are sorted by composite descending and assigned a lineup slot:

| Position    | Slots | Rule                                                                                                                  |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| **Starter** | 1–4   | Top 4 composite scores. The benchmark for the floor.                                                                  |
| **Lineup**  | 5–9   | Solid contributors, building toward the top.                                                                          |
| **DH**      | 10+   | Outside top 9, but meets **any** of: `conv_rate >= 0.18` OR `contact_disc >= 0.90` OR `writeup_rate >= 0.75`. Standout in one area, gap in another. |
| **Bench**   | 10+   | Outside top 9 and doesn't qualify for DH.                                                                             |

DH reps get a `bench_note` describing their standout dimension and where the gap is.

---

## Date-Range Filtering

Four presets plus custom range:

- **All Data** — no filter
- **MTD** — Month to Date (default after upload)
- **Last 30 Days** — rolling
- **Last 7 Days** — rolling
- **Custom** — `<input type="date">` for `from` and `to`

The custom date inputs are disabled unless either:
1. The raw CSV is in the in-memory `_masterCache` (uploaded this session), or
2. A sanitized row cache (`garv7_rs_<id>`) exists in localStorage (uploaded any session, then persisted PII-stripped).

When a date range is active, `recompute()` is called fresh with `fromStr` / `toStr` arguments and the split-date pipeline classifies each row into `inLeadPeriod` and `inSalePeriod` independently.

---

## Privacy & PII Handling (v4.3.3 / v4.3.4)

The master CSV contains customer PII: names, emails, phone numbers. Two security improvements were made:

### v4.3.3 — Raw CSV out of localStorage and out of the public API

**Before:** The full CSV (`_masterText`) was stored in localStorage and returned by `GET /api/store/:id`. Anyone could open DevTools → Application → Local Storage and read 425 KB of customer data, or just hit the API endpoint with `curl`.

**After:**
- **localStorage** holds only computed scores (`reps`, `totals`, `period`, file metadata, history). The raw CSV exists in browser memory only during the upload's compute-and-sync window (~50ms) and is then dropped. `setStoreData()` automatically strips any `_masterText` field via `stripPII()` before writing.
- **Server-side blobs are split:**
  - `raw_<storeId>` — full CSV with PII; only readable by the server functions, never exposed publicly.
  - `store_<storeId>` — computed scores + metadata only; this is what `/api/store/:id` returns.
- The upload now sends a `computed.json` sidecar alongside the CSV. The server stores both: the raw blob for future server-side rescoring, the computed blob for public reads.
- `store-data.mjs` also runs `stripPII()` defensively on read in case a legacy `_masterText` record still exists from before the migration.

**Trade-off:** scoring rule changes no longer automatically re-score on page load — the user must re-upload each store's CSV for new rules to take effect. This is acceptable because (a) maintenance uploads are infrequent, (b) the security gain is large, and (c) the raw CSV is still recoverable server-side for batch rescore if needed.

### v4.3.4 — Filter-rows cache (PII-stripped)

Removing the raw CSV from localStorage broke date-range filtering across page reloads: the date pickers had nothing to recompute from once the in-memory cache was dropped on reload.

**Fix:** cache the **parsed rows** with all PII columns nulled out, under `garv7_rs_<storeId>`. Cache shape: `{ rows, H, fileName, uploadedAt }` where `H` is the column-index map (without the non-serializable `_piiCols` Set).

PII columns nulled before caching, defined by `PII_COLUMN_HEADERS`:

```
Customer
Email
Daytime Phone, Day Phone
Cell Phone
Evening Phone
```

Note: `Last Attempted Email Contact`, `Last Customer Contact`, `First Customer Contact`, etc. are date columns despite the names — they are NOT stripped because they're needed for filtering and contain no customer-identifying content.

Critically, **customer dedup runs BEFORE PII stripping**, because dedup reads Customer/Email/Phone to merge duplicate-customer rows. If we blanked those first, no dups would merge.

The resulting cache is ~10% smaller than the raw CSV (5 of ~87 columns nulled) and lets `recompute()` re-filter by date across reloads. Recompute on the cached rows produces identical numbers to the original CSV because the dedup output is fed in (idempotent: re-running dedup is a no-op).

---

## Netlify Functions

### `POST /api/upload`

Accepts a `multipart/form-data` body with one or more CSV files and an optional `computed.json` sidecar. For each file:

1. Parses the store ID from the filename prefix (everything before `master_leads`, stripped of non-letters), using `STORE_ALIAS_MAP`.
2. Writes `raw_<storeId>` (full CSV with PII; private).
3. Writes `store_<storeId>` (computed scores + metadata; public, what `/api/store/:id` returns).
4. Updates `hist_<storeId>` (max 20 entries, newest first).

Returns `{ results: [{ file, status, storeId, hasScores }, ...] }`.

### `GET /api/store/:storeId`

Returns the public `store_<storeId>` record: `{ reps, totals, period, fileName, uploadedAt, _rawDates }`. Runs `stripPII()` defensively in case any legacy record still has `_masterText`.

### `DELETE /api/store/:storeId`

Deletes `store_<id>`, `raw_<id>`, and `hist_<id>` together. Used by the "Reset store" button in the History modal.

### `GET /api/store/:storeId/history`

Returns the history array (newest first). Returns `[]` if no history.

### `DELETE /api/store/:storeId/history/:index`

Removes a single entry by index. Without `:index`, clears all history for that store.

### `POST /api/ai`

Proxies to Anthropic's Messages API using `ANTHROPIC_API_KEY` from env. Defaults: `claude-sonnet-4-5-20250929`, `max_tokens: 1024`. Empty `system` field is omitted (not sent as `""`). Empty `messages` array is rejected with 400 before the network round-trip. Outbound fetch has a 25s timeout (Netlify's sync function limit is 26s); on timeout returns 504 with a clean error message. Optional `ANTHROPIC_BASE_URL` env var lets the deployment route through an AI gateway (Vercel, Cloudflare, Requesty) without code changes.

---

## Storage Model

### Browser localStorage (prefix `garv7_`)

| Key                    | Type            | Contents                                                  | PII? |
| ---------------------- | --------------- | --------------------------------------------------------- | ---- |
| `d_<storeId>`          | JSON object     | Computed scores: `{ reps, totals, period, ... }`         | No   |
| `h_<storeId>`          | JSON array      | History snapshots (max 20)                                | No   |
| `rs_<storeId>`         | JSON object     | PII-stripped row cache for date-range re-score (v4.3.4)  | No   |
| `hist_cleared_<id>`    | Boolean         | UI flag — did the user just clear history?                | No   |

### Browser in-memory only (`_masterCache`)

| Key (in JS object)     | Type     | Contents                | Lifetime                |
| ---------------------- | -------- | ----------------------- | ----------------------- |
| `_masterCache[id]`     | String   | Full raw CSV text       | Session only — never written to disk |

### Netlify Blobs (store: `garv`)

| Key                | Contents                                                  | Public? |
| ------------------ | --------------------------------------------------------- | ------- |
| `raw_<storeId>`    | `{ _masterText, fileName, uploadedAt, period }`           | **No** — never returned by any endpoint |
| `store_<storeId>`  | `{ reps, totals, period, fileName, uploadedAt, _rawDates }` | Yes — returned by `GET /api/store/:id` |
| `hist_<storeId>`   | Array of `{ fileName, uploadedAt, period }`               | Yes — returned by history endpoints |

---

## AI Coach

Two entry points:

- **Inline** — the prompt input on the AI Coaching tab inside any store. Auto-includes that store's scorecard as context.
- **Modal** — the gold "✦ AI Coach" button in the topbar. Same context, separate render target.

`aiCtx()` builds the system prompt fresh on every call. It includes:

- Persona: "You are a dealership sales performance coach for Great American RV SuperStores, [store name]." (Airstream variant explains the cross-rooftop denominator.)
- Period and active filters (700 Credit + Airstream removed, etc.).
- Reminder: speed scored on internet leads only.
- Full scorecard: one line per rep with name, composite, conversion %, deliveries, internet leads, median response, contact %, visits, write-up rate, lineup position.
- Instruction: "Give specific, actionable coaching grounded in this data. Reference rep names and numbers. Under 320 words. Clear paragraphs, not bullet walls."

User question + context POSTed to `/api/ai`. Response rendered with `textContent` (not innerHTML) to avoid any chance of script injection from model output.

---

## Local Development

```bash
# 1. Install Netlify CLI (one-time, global)
npm install -g netlify-cli

# 2. Install function deps
npm install

# 3. Run with hot reload + functions emulator
netlify dev
```

By default `netlify dev` serves `public/` at `http://localhost:8888` and emulates the functions at `http://localhost:8888/.netlify/functions/*`. The redirects in `netlify.toml` mean `/api/upload`, `/api/store/:id`, etc. work locally exactly as in production.

To test the AI proxy locally, set `ANTHROPIC_API_KEY` in a `.env` file or via `netlify env:set ANTHROPIC_API_KEY <key>`.

Netlify Blobs in dev mode use a local file-based emulator; data persists between `netlify dev` runs but resets on `netlify dev:clean`.

---

## Deployment

Push to the `main` branch of the linked Netlify site. Netlify auto-deploys.

Required environment variables (Site Settings → Environment):

| Variable               | Required | Notes                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`    | Yes      | For the AI Coach. Without it, `/api/ai` returns 500.               |
| `ANTHROPIC_BASE_URL`   | No       | Override for routing through an AI gateway. Defaults to api.anthropic.com. |

Netlify Blobs is enabled automatically — no configuration needed beyond having the site on Netlify.

---

## Versioning Notes

| Version | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v4**  | Visit credit rule fixed: `Assigned User` group is the manager guard, not `Completed By`. v3 dropped almost all visit credit.                                                                                                                                                                                                                                                                                                                                                                                     |
| **v4.1** | Split-date pipeline introduced. Lead count uses `Lead Origination Date`; delivery count uses `Lead Last Modified Date`. A lead originated last month that closes this month counts as a delivery this month, not a lead this month.                                                                                                                                                                                                                                                                              |
| **v4.2** | Per-store rep whitelists removed. Anyone in `Sales Rep` who is not on the manager blacklist is now auto-scored. No more code updates for new hires.                                                                                                                                                                                                                                                                                                                                                              |
| **v4.3** | Airstream brand tab added. Cross-rooftop view, only Airstream-identified rows kept. Aimbase included as a primary signal (~80% of brand pipeline). 10-lead minimum dropped to 1 on this tab.                                                                                                                                                                                                                                                                                                                     |
| **v4.3.1** | (Skipped — internal patch.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **v4.3.2** | Upload filename always synthesized from target storeId. Fixes silent overwrite when uploading e.g. `hammond_*.csv` to the Airstream tab.                                                                                                                                                                                                                                                                                                                                                                          |
| **v4.3.3** | Privacy hardening. Raw CSV removed from localStorage AND from public API responses. Server stores raw + computed in separate blobs; only computed is publicly readable. Defensive `stripPII()` everywhere.                                                                                                                                                                                                                                                                                                       |
| **v4.3.4** | PII-stripped filter-rows cache added so date-range filtering survives page reloads. AI proxy upgraded to Sonnet 4.5 default with 25s timeout, validation, and optional system field. Airstream per-store rollup band and per-rep `byDealer` breakdown added.                                                                                                                                                                                                                                                     |
| **v4.3.5** | No-flicker boot hydration + server-wins-on-timestamp sync. Page now boots into a gold overlay until all server fetches resolve (or 4s timeout fires), then paints once. Eliminates the "stale localStorage flash" and ends cross-browser drift — every browser converges on whatever `store_<id>` blob the server currently holds. `uploadedAt` now stamped client-side at upload so the comparator has an anchor. |
| **v4.3.6** | Date picker added to the Network Overview tab — same preset buttons (All / MTD / Last 30 / Last 7) and custom date inputs as the per-store views. Each rooftop is re-scored independently via its row source (in-session raw CSV or persisted PII-stripped row cache); rooftops without a row source fall back to all-data and are surfaced explicitly ("X rooftops showing all-data — re-upload to enable date filter"). Network KPIs aggregate the re-scored numbers. Airstream brand card is intentionally NOT scoped by the Network picker — it has its own filtering. Blacklist entry `Matt Kramer` renamed to `Matthew Kramer` to match the corrected VinSolutions data export. |
| **v4.3.7** | (1) Contrast hardening: text token palette lifted globally so `--t2` and `--t3` now hit WCAG AA / AA-large on the card background. Bar labels, KPI sublabels, write-up parentheticals, table headers, position numbers — all roughly 2x more readable, visual hierarchy preserved. (2) Split-date visibility surfaces: calendar pill tooltip, date-range panel info line, Network split-note callout between KPI strip and rooftop grid, per-rooftop card period labels include the actual window, per-store Summary tab Delivered KPI shows the prior-period count. `totals.prior_period_deliveries` exposed on the recompute result. (3) AI Coach now respects the active date filter — `aiCtx()` runs the same re-score pipeline as `buildSec` and hands the AI the same numbers the user sees, plus an explicit period label and the prior-period delivery count so the AI doesn't misread split-date effects as performance changes. |

---

## Known Quirks & Design Rationale

- **One single 2,475-line `index.html`** is intentional. The dashboard has zero npm dependencies in the front-end and zero build step. A manager can save the page, open it offline, drop a CSV on it, and get scores. The maintenance cost of a build pipeline isn't worth it for a tool that gets uploaded weekly.
- **Custom CSV parser** (`parseMasterCSVv2`) instead of `papaparse` etc. Required because the master CSV has duplicate column names — the leads section and the visits section both have columns called `Customer`, `Dealer`, `Lead Source`, `Lead Type`. Library parsers treat duplicate headers as errors or silently overwrite. The custom parser uses positional row arrays and a name → index map where duplicates get a `_2` suffix.
- **Union-find dedup** instead of a single-key dedup. Customers go by name with one rep and by phone-only with another. Three identity signals with transitive merging catches roughly 8–12% more dup clusters per store than name-only.
- **In-memory `_masterCache` for raw CSV** is a deliberate design choice, not laziness. Anything written to localStorage is forever-readable to anyone who can sit at the user's desk. PII in the browser must die when the tab dies.
- **Speed defaults to 10 points (not 0) when no internet data.** A rep with 0 internet leads should not be penalized for speed — they had no opportunity to be slow. Setting to 10 (midpoint) avoids both rewarding and punishing the absence of data.
- **The 10-lead minimum exists** because a rep with 1 lead and 1 delivery has 100% conversion. That's noise, not signal. The minimum is dropped to 1 on the Airstream tab because Airstream lead volume per rep is genuinely low (most reps see them only occasionally) and the goal there is visibility, not statistical purity.
- **Why we don't show revenue** — VinSolutions' gross is pre-adjustment. IDS (the F&I system) is authoritative for actual margin. Showing inflated VS gross creates expectation problems. Until IDS data is exported into this pipeline, gross stays off the dashboard.

---

## License

Proprietary — Great American RV SuperStores internal use.
