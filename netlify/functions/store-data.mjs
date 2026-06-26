// /api/store/:storeId   (routed via netlify.toml redirect)
// GET    → returns { reps, totals, period, fileName, uploadedAt, ... }
//          Customer PII (raw CSV in _masterText) is STRIPPED here so the
//          public endpoint never exposes it, even if a legacy record
//          still has it stored from before v4.3.3.
// DELETE → clears the store record, the separate raw-CSV blob, and history.

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Fields that may contain customer PII and must NEVER be returned by
// the public GET endpoint. Mirrors the client-side PII_FIELDS list.
const PII_FIELDS = ['_masterText'];

function stripPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const k of Object.keys(obj)) {
    if (PII_FIELDS.indexOf(k) !== -1) continue;
    clean[k] = obj[k];
  }
  return clean;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Path is either the original /api/store/:id or the rewritten
  // /.netlify/functions/store-data?storeId=... — handle both.
  const url = new URL(request.url);
  let storeId = url.searchParams.get('storeId');
  if (!storeId) {
    const m = url.pathname.match(/\/api\/store\/([^\/]+?)(?:\/|$)/);
    if (m) storeId = m[1];
  }
  if (!storeId) {
    return Response.json({ error: 'Missing storeId' }, { status: 400, headers: CORS });
  }

  const store = getStore('garv');

  if (request.method === 'GET') {
    try {
      const data = await store.get('store_' + storeId, { type: 'json' });
      if (!data) return new Response('', { status: 404, headers: CORS });
      // Defense in depth: even if a legacy record still has _masterText
      // (from before v4.3.3 when scores+raw lived in the same blob),
      // strip it before returning.
      return Response.json(stripPII(data), { status: 200, headers: CORS });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  if (request.method === 'DELETE') {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const suppliedPassword = url.searchParams.get('password');
    if (expectedPassword && suppliedPassword !== expectedPassword) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
    }
    try {
      // v4.3.3: clear the separate raw-CSV blob.
      // v4.4.0: also clear the row cache blob.
      await store.delete('store_' + storeId);
      await store.delete('raw_' + storeId);
      await store.delete('hist_' + storeId);
      await store.delete('rows_' + storeId);
      return Response.json({ deleted: storeId }, { status: 200, headers: CORS });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
};
