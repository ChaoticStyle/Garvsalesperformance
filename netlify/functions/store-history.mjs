// /api/store/:storeId/history[/:index]
// GET    → returns history array (newest first)
// DELETE with index → removes one entry
// DELETE without index → clears all history

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const m = url.pathname.match(/\/api\/store\/([^\/]+)\/history(?:\/(\d+))?/);
  const storeId = m ? m[1] : url.searchParams.get('storeId');
  const indexStr = m && m[2] !== undefined ? m[2] : url.searchParams.get('index');

  if (!storeId) {
    return Response.json({ error: 'Missing storeId' }, { status: 400, headers: CORS });
  }

  const store = getStore('garv');
  const histKey = 'hist_' + storeId;

  if (request.method === 'GET') {
    try {
      const hist = await store.get(histKey, { type: 'json' });
      return Response.json(Array.isArray(hist) ? hist : [], { status: 200, headers: CORS });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  if (request.method === 'DELETE') {
    try {
      if (indexStr !== null && indexStr !== undefined && indexStr !== '') {
        const idx = parseInt(indexStr, 10);
        const existing = await store.get(histKey, { type: 'json' });
        if (!Array.isArray(existing)) {
          return Response.json({ error: 'No history' }, { status: 404, headers: CORS });
        }
        if (idx < 0 || idx >= existing.length) {
          return Response.json({ error: 'Index out of range' }, { status: 400, headers: CORS });
        }
        existing.splice(idx, 1);
        await store.setJSON(histKey, existing);
        return Response.json({ deleted: idx, remaining: existing.length }, { status: 200, headers: CORS });
      } else {
        await store.setJSON(histKey, []);
        return Response.json({ cleared: true }, { status: 200, headers: CORS });
      }
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
};
