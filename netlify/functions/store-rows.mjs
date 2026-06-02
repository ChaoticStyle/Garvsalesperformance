// /api/store/:storeId/rows  (routed via netlify.toml redirect)
// GET → returns the PII-stripped row cache used by the dashboard's
//       date-range filtering. Shape:
//         { rows: [[...sanitized cells...], ...],
//           H: { headerName: colIdx, allHeaders: [...] },
//           fileName: string,
//           uploadedAt: ISO timestamp }
//
// v4.4.0 (May 2026): Introduced so date-range filtering works on any
// browser that views the dashboard, not just the one that uploaded.
// Before this, the cache lived only in the uploading browser's
// localStorage; other browsers saw cached score totals fine but
// couldn't re-score for custom date ranges because they had no rows
// to feed back into recompute().
//
// PRIVACY: The cache is already PII-stripped client-side via
// sanitizeRow() before upload (Customer, Email, all Phone columns are
// nulled). upload.mjs also re-strips defensively before write. So
// this endpoint never serves customer-identifying data — only the
// operational columns (dates, statuses, rep names, response times)
// that recompute() actually reads. The raw CSV with PII still lives
// only in `raw_<storeId>`, which no public endpoint returns.

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Same list as upload.mjs and the client. Kept duplicated rather than
// importable because Netlify Functions ship as independently-bundled
// units; cross-function imports of shared modules require a build
// step we don't currently have.
const PII_COLUMN_HEADERS = [
  'Customer',
  'Email',
  'Daytime Phone', 'Day Phone',
  'Cell Phone',
  'Evening Phone',
];

function defensiveStripPII(payload) {
  if (!payload || !Array.isArray(payload.rows) || !payload.H) return payload;
  const headers = Array.isArray(payload.H.allHeaders) ? payload.H.allHeaders : [];
  const piiIdx = new Set();
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    if (PII_COLUMN_HEADERS.indexOf(h) !== -1) piiIdx.add(i);
  }
  for (const name of PII_COLUMN_HEADERS) {
    if (typeof payload.H[name] === 'number') piiIdx.add(payload.H[name]);
  }
  if (piiIdx.size === 0) return { ...payload };
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

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Path is either the original /api/store/:id/rows or the rewritten
  // /.netlify/functions/store-rows?storeId=... — handle both.
  const url = new URL(request.url);
  let storeId = url.searchParams.get('storeId');
  if (!storeId) {
    const m = url.pathname.match(/\/api\/store\/([^\/]+?)\/rows(?:\/|$)/);
    if (m) storeId = m[1];
  }
  if (!storeId) {
    return Response.json({ error: 'Missing storeId' }, { status: 400, headers: CORS });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const store = getStore('garv');
  try {
    const data = await store.get('rows_' + storeId, { type: 'json' });
    if (!data) return new Response('', { status: 404, headers: CORS });
    // Defense in depth: re-strip PII on read regardless of whether
    // upload.mjs already did. Cheap, and protects against a stored
    // blob from before sanitizeFilterRows existed (or from a future
    // direct-write that bypassed upload.mjs).
    return Response.json(defensiveStripPII(data), { status: 200, headers: CORS });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
};
