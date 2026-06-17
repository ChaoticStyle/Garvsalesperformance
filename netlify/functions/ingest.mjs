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
    const cleanRows = sanitizeRows(parsed.rows, parsed.H);
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
    hist.unshift({ fileName: displayName, uploadedAt, period: scored.period });
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
