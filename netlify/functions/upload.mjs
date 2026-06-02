// /api/upload — accepts a master CSV and stores raw text in Netlify Blobs.
// Modern Netlify Functions format: default export taking (Request, context),
// returning a Response. Uses native FormData — no busboy dependency.

import { getStore } from '@netlify/blobs';

// Map filename prefix (before "_master_leads_") to canonical store id.
// Keep in sync with STORES registry in /public/index.html.
const STORE_ALIAS_MAP = {
  hammond: 'hammond',
  grandbay: 'grand_bay',
  heflin: 'heflin',
  calera: 'calera',
  huntsville: 'huntsville',
  hattiesburg: 'hattiesburg',
  tupelo: 'tupelo',
  breauxbridge: 'breaux_bridge',
  defuniak: 'defuniak',
  // v4.3 (May 2026): Airstream brand tab — cross-rooftop view.
  // The dashboard uploads with prefix "airstream" (storeId has no
  // underscores, so storeAlias === storeId). Filter inversion lives
  // entirely client-side in recompute(); from the backend's POV this
  // is just another store record under the key "store_airstream".
  airstream: 'airstream',
};

// v4.4.0 — Column-level PII list, mirrors PII_COLUMN_HEADERS in
// /public/index.html. The client already nulls these columns in the
// row cache before posting it via sanitizeRow(), but we defensively
// re-strip on the server in case a future client bug skips the step.
// Keep this list in sync with the client list — if you add a column
// there, add it here too.
const PII_COLUMN_HEADERS = [
  'Customer',
  'Email',
  'Daytime Phone', 'Day Phone',
  'Cell Phone',
  'Evening Phone',
];

function sanitizeFilterRows(payload) {
  // payload: { rows: [[...]], H: { headerName: colIdx, allHeaders: [...] }, fileName, uploadedAt }
  // Returns a new payload with PII columns blanked out across every row.
  if (!payload || !Array.isArray(payload.rows) || !payload.H) return payload;
  const headers = Array.isArray(payload.H.allHeaders) ? payload.H.allHeaders : [];
  // Compute the column indexes that need scrubbing. Use allHeaders to
  // catch duplicate columns (the CSV has two "Customer" columns —
  // leads section + visits section).
  const piiIdx = new Set();
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    if (PII_COLUMN_HEADERS.indexOf(h) !== -1) piiIdx.add(i);
  }
  // Also catch the H-aliased forms (Customer, Email, etc. without a duplicate suffix).
  for (const name of PII_COLUMN_HEADERS) {
    if (typeof payload.H[name] === 'number') piiIdx.add(payload.H[name]);
  }
  if (piiIdx.size === 0) {
    // Nothing matched — payload is either weird or already non-PII. Pass through.
    return { ...payload };
  }
  const cleanRows = payload.rows.map(row => {
    if (!Array.isArray(row)) return row;
    const out = row.slice();
    for (const i of piiIdx) {
      if (i >= 0 && i < out.length) out[i] = '';
    }
    return out;
  });
  return { ...payload, rows: cleanRows };
}

function parseStoreIdFromFilename(fn) {
  const lower = String(fn || '').toLowerCase();
  // Locate the "master leads" marker (allow space, underscore, or no separator).
  const idx = lower.search(/master[_ ]?leads/);
  if (idx < 0) return null;
  // Everything before the marker is the city name; strip non-letters so
  // "Breaux_Bridge", "Breaux Bridge", and "BreauxBridge" all collapse to
  // "breauxbridge".
  const prefix = lower.slice(0, idx).replace(/[^a-z]/g, '');
  if (!prefix) return null;
  if (STORE_ALIAS_MAP[prefix]) return STORE_ALIAS_MAP[prefix];
  // Longest-prefix fallback so e.g. "defuniaksprings" still matches the
  // "defuniak" alias.
  const keys = Object.keys(STORE_ALIAS_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (prefix.startsWith(k)) return STORE_ALIAS_MAP[k];
  }
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return Response.json({ error: 'Bad form: ' + e.message }, { status: 400, headers: CORS });
  }

  // Accept any field name; collect all File/Blob entries.
  // v4.3.3: also collect a sidecar `computed.json` blob with the
  // client-computed reps/totals so the GET endpoint can return scores
  // WITHOUT also having to expose the raw CSV (which contains PII).
  // v4.4.0: ALSO collect a `filterRows.json` sidecar — the PII-stripped
  // parsed row cache that previously lived only in browser localStorage.
  // Putting it on the server (as a 4th blob, `rows_<storeId>`) lets
  // every browser pull it on hydration and have date-range filtering
  // work immediately, not just the browser that uploaded. The cache is
  // already PII-stripped by sanitizeRow() client-side before send — see
  // PII_COLUMN_HEADERS in public/index.html for the column list. We add
  // a defensive server-side check below regardless.
  const files = [];
  let computedJson = null;
  let filterRowsJson = null;
  for (const [name, value] of form.entries()) {
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && value.name) {
      if (name === 'computed' || value.name === 'computed.json') {
        // Parse the precomputed scores. Don't fail upload if this is malformed
        // — fall back to the raw-CSV-only flow.
        try {
          computedJson = JSON.parse(await value.text());
        } catch (e) {
          console.warn('upload.mjs: failed to parse computed.json:', e.message);
        }
        continue;
      }
      if (name === 'filterRows' || value.name === 'filterRows.json') {
        // Parse the row cache. Same fault-tolerance as computed.json —
        // if it's malformed we just skip it; the upload still succeeds
        // and the uploading browser will still have its own localStorage
        // cache, just other browsers won't get the cross-browser benefit.
        try {
          filterRowsJson = JSON.parse(await value.text());
        } catch (e) {
          console.warn('upload.mjs: failed to parse filterRows.json:', e.message);
        }
        continue;
      }
      files.push(value);
    }
  }
  if (!files.length) {
    return Response.json({ error: 'No files received' }, { status: 400, headers: CORS });
  }

  const store = getStore('garv');
  const results = [];
  const now = new Date();

  for (const f of files) {
    const fn = f.name || 'unknown.csv';
    const storeId = parseStoreIdFromFilename(fn);
    if (!storeId) {
      results.push({ file: fn, status: 'error', error: 'Could not parse store id from filename (expected storename_master_leads_*.csv)' });
      continue;
    }

    let masterText;
    try {
      masterText = await f.text();
    } catch (e) {
      results.push({ file: fn, status: 'error', error: 'Failed to read file: ' + e.message });
      continue;
    }
    if (!masterText || masterText.length < 100) {
      results.push({ file: fn, status: 'error', error: 'File appears empty or truncated' });
      continue;
    }

    const record = {
      _masterText: masterText,
      fileName: fn,
      uploadedAt: now.toISOString(),
      period: 'Uploaded ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    };

    try {
      // v4.3.3: Two separate blobs.
      //   raw_<storeId>   \u2014 holds the full CSV (PII). Only readable
      //                       by server functions; never exposed via the
      //                       public GET endpoint.
      //   store_<storeId> \u2014 holds computed scores + metadata only.
      //                       This is what /api/store/:id returns.
      await store.setJSON('raw_' + storeId, record);

      // Build the public-facing scores record. If the client posted
      // computed scores (normal path), use them. If not (legacy
      // clients), the record contains only metadata and the dashboard
      // will show "No data" until the client re-uploads with computed
      // scores. We do NOT fall back to embedding _masterText here.
      const publicRecord = {
        fileName: fn,
        uploadedAt: now.toISOString(),
        period: record.period,
      };
      if (computedJson && computedJson.reps) {
        publicRecord.reps = computedJson.reps;
        publicRecord.totals = computedJson.totals;
        if (computedJson._sourceFile) publicRecord.fileName = computedJson._sourceFile;
        if (computedJson._rawDates)   publicRecord._rawDates = computedJson._rawDates;
      }
      await store.setJSON('store_' + storeId, publicRecord);

      // v4.4.0: Persist the PII-stripped row cache as a 4th blob.
      // Returned by GET /api/store/:id/rows so every browser can re-
      // score by date filter on next page load — not just the one that
      // uploaded. Skipped silently when the client didn't post one
      // (legacy clients before v4.4.0, or upload failures upstream).
      // Defensive sanitization: even though the client already nulled
      // PII columns via sanitizeRow() before send, we re-strip on the
      // server in case a future client bug skips the step. Belt + braces.
      if (filterRowsJson && Array.isArray(filterRowsJson.rows) && filterRowsJson.H) {
        const sanitized = sanitizeFilterRows(filterRowsJson);
        sanitized.uploadedAt = now.toISOString();
        if (!sanitized.fileName) sanitized.fileName = fn;
        try {
          await store.setJSON('rows_' + storeId, sanitized);
        } catch (e) {
          // Non-fatal — log and continue. The scores still saved above.
          console.warn('upload.mjs: failed to write rows_' + storeId + ': ' + e.message);
        }
      }

      const histKey = 'hist_' + storeId;
      let hist = [];
      try {
        const existing = await store.get(histKey, { type: 'json' });
        if (Array.isArray(existing)) hist = existing;
      } catch { /* ignore */ }
      hist.unshift({ fileName: fn, uploadedAt: now.toISOString(), period: record.period });
      if (hist.length > 20) hist = hist.slice(0, 20);
      await store.setJSON(histKey, hist);

      results.push({ file: fn, status: 'success', storeId, hasScores: !!publicRecord.reps });
    } catch (e) {
      results.push({ file: fn, status: 'error', error: 'Blob write failed: ' + e.message });
    }
  }

  return Response.json({ results }, { status: 200, headers: CORS });
};
