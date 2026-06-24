// POST /api/ingest — server-side CSV ingest for the VinSolutions → Gmail pipeline.
// Accepts a raw CSV + storeId, runs full scoring, and writes Netlify Blobs just
// like the browser upload flow does — without needing a browser.
//
// Security: requests must include the INGEST_API_KEY environment variable value.
// Set it in the Netlify dashboard under Site → Environment Variables.

import { getStore } from '@netlify/blobs';
import {
  VALID_STORE_IDS,
  parseMasterCSVv2,
  looksLikeMasterCSV,
  recompute,
  extractRawDates,
  sanitizeRows,
  dedupCustomers,
} from './lib/scoring.mjs';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  // ── Parse request body ────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });
  }

  const { storeId, csvText, fileName, apiKey } = body || {};

  // ── Authenticate ──────────────────────────────────────────────────
  const expectedKey = process.env.INGEST_API_KEY;
  if (!expectedKey) {
    return Response.json({ error: 'INGEST_API_KEY not configured on server' }, { status: 500, headers: CORS });
  }
  if (!apiKey || apiKey !== expectedKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }

  // ── Validate inputs ───────────────────────────────────────────────
  if (!storeId || !VALID_STORE_IDS.has(storeId)) {
    return Response.json(
      { error: 'Invalid storeId. Must be one of: ' + [...VALID_STORE_IDS].join(', ') },
      { status: 400, headers: CORS }
    );
  }
  if (!csvText || typeof csvText !== 'string' || csvText.length < 100) {
    return Response.json({ error: 'csvText is missing or too short' }, { status: 400, headers: CORS });
  }

  // ── Parse CSV ─────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseMasterCSVv2(csvText);
  } catch (e) {
    return Response.json({ error: 'CSV parse error: ' + e.message }, { status: 400, headers: CORS });
  }
  if (!parsed || !looksLikeMasterCSV(parsed)) {
    return Response.json(
      { error: 'File does not look like a VinSolutions master lead CSV. Expected columns: Sales Rep, Visit Result, Write Up, Contacted Indicator.' },
      { status: 400, headers: CORS }
    );
  }

  // ── Score ─────────────────────────────────────────────────────────
  let scored;
  try {
    scored = recompute(parsed.rows, parsed.H, storeId, '', '');
  } catch (e) {
    return Response.json({ error: 'Scoring error: ' + e.message }, { status: 500, headers: CORS });
  }

  // ── Build metadata ────────────────────────────────────────────────
  const now          = new Date();
  const uploadedAt   = now.toISOString();
  const displayName  = fileName || (storeId + '_ingest_' + now.toISOString().slice(0,10) + '.csv');
  const rawDates     = extractRawDates(parsed.rows, parsed.H);

  scored._sourceFile = displayName;
  scored.uploadedAt  = uploadedAt;
  if (rawDates.length) scored._rawDates = rawDates;

  // ── Write Netlify Blobs ───────────────────────────────────────────
  const blobStore = getStore('garv');

  try {
    // 1. Raw CSV (server-only, never returned by public GET)
    await blobStore.setJSON('raw_' + storeId, {
      _masterText: csvText,
      fileName:    displayName,
      uploadedAt,
      period:      scored.period,
    });

    // 2. Public scores (returned by GET /api/store/:storeId)
    await blobStore.setJSON('store_' + storeId, {
      fileName:    displayName,
      uploadedAt,
      period:      scored.period,
      reps:        scored.reps,
      totals:      scored.totals,
      _rawDates:   scored._rawDates || [],
      ...(scored.byStore ? { byStore: scored.byStore } : {}),
    });

    // 3. PII-stripped row cache (enables cross-browser date-range filtering)
    //    CRITICAL: dedup BEFORE stripping PII. dedupCustomers() keys on
    //    Customer/Email/Phone — the exact columns sanitizeRows() blanks.
    //    Stripping first would leave duplicate customer rows uncollapsed,
    //    and the browser's date-filtered recompute (which re-runs dedup)
    //    could no longer merge them, inflating leads AND deliveries. The
    //    client's setFilterRows() already dedups-then-strips; this mirrors
    //    it so ingest- and browser-fed stores produce identical numbers.
    const { leads: dedupLeads, extraSales: dedupExtraSales } = dedupCustomers(parsed.rows, parsed.H);
    const cleanRows = sanitizeRows([...dedupLeads, ...dedupExtraSales], parsed.H);
    await blobStore.setJSON('rows_' + storeId, {
      rows:       cleanRows,
      H:          parsed.H,
      fileName:   displayName,
      uploadedAt,
    });

    // 4. History entry (newest first, max 20)
    let hist = [];
    try {
      const existing = await blobStore.get('hist_' + storeId, { type: 'json' });
      if (Array.isArray(existing)) hist = existing;
    } catch { /* first upload for this store */ }
    // Match the rich shape the client builds locally on browser upload
    // (see pushHist() in index.html) — the History modal renders date,
    // total_leads, delivered, avg_conv, top_rep, top_score and shows
    // dashes for anything missing. uploadedAt stays ISO (boot hydration
    // compares it for freshness); date is the human-readable display form.
    hist.unshift({
      fileName: displayName, uploadedAt, period: scored.period,
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      total_leads: scored.totals.total_leads,
      delivered:   scored.totals.delivered,
      avg_conv:    scored.totals.avg_conv,
      top_rep:     scored.reps?.[0]?.name,
      top_score:   scored.reps?.[0]?.composite,
      // Full per-rep snapshot, mirroring pushHist() in index.html. Trend
      // arrows on baseball cards read prev.reps to diff composites against
      // the immediately previous upload — without this, hydrating from
      // server history (any fresh page load, another device, or this
      // automated ingest pipeline) leaves prev.reps empty and arrows never
      // render. No PII here — reps are computed aggregates, not raw rows.
      reps: scored.reps,
    });
    if (hist.length > 20) hist = hist.slice(0, 20);
    await blobStore.setJSON('hist_' + storeId, hist);

  } catch (e) {
    return Response.json({ error: 'Blob write failed: ' + e.message }, { status: 500, headers: CORS });
  }

  return Response.json({
    success:    true,
    storeId,
    uploadedAt,
    repCount:   scored.reps.length,
    delivered:  scored.totals.delivered,
    period:     scored.period,
  }, { status: 200, headers: CORS });
};
