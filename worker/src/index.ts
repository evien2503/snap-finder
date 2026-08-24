/**
 * Item Location Finder — Cloudflare Worker
 *
 * - POST /api/photos/upload : Upload photo to R2
 * - GET  /api/photos        : List photos by user
 * - GET  /api/photos/:key   : Serve photo from R2
 * - POST /api/history       : Scan history from D1
 *
 * Deploy:
 *   npm create cloudflare -- worker
 *   wrangler deploy
 */

export interface Env {
  BUCKET: R2Bucket             // Bindings → R2 for photo storage
  SCAN_DB: D1Database           // Bindings → D1 for persistent storage
  ASSETS: Fetcher               // Bindings → static frontend assets
}

/* ── CORS ── */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/* ── Router ── */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url = new URL(request.url)
    const path = url.pathname

    try {
      /* ── Photo endpoints (GET + POST) ── */
      if (path === '/api/photos/upload' && request.method === 'POST') return handlePhotoUpload(request, env)
      if (path === '/api/photos' && request.method === 'GET') return handleListPhotos(request, env)
      if (path.startsWith('/api/photos/') && request.method === 'GET') {
        const key = path.slice('/api/photos/'.length)
        if (key) return handleServePhoto(key, env)
        return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      /* ── API POST endpoints ── */
      if (path.startsWith('/api/')) {
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (path === '/api/history') return handleHistory(request, env)
        return new Response(JSON.stringify({ error: 'Unknown route' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      /* ── Serve frontend static assets (SPA) ── */
      return env.ASSETS.fetch(request)
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  },
}

/* ════════════════════════════════════════════════════
   1.  SCAN HISTORY  —  /api/history
   ════════════════════════════════════════════════════ */
async function handleHistory(request: Request, env: Env): Promise<Response> {
  const { userId = 'anonymous' } = await request.json()
  const { results } = await env.SCAN_DB.prepare(
    'SELECT id, item_name, confidence, distinct_features, suggested_category, description, room_name, location, created_at FROM scans WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50'
  ).bind(userId).all()

  return new Response(JSON.stringify({ scans: results ?? [] }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   2.  PHOTO UPLOAD  —  POST /api/photos/upload
   ════════════════════════════════════════════════════ */
async function handlePhotoUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData()
  const file = form.get('image') as File | null
  if (!file) {
    return new Response(JSON.stringify({ error: 'Missing image file' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const userId  = (form.get('userId') as string) || 'anonymous'
  const itemName = (form.get('itemName') as string) || 'Unknown Item'
  const category = (form.get('category') as string) || 'Other'
  const roomLocation = (form.get('roomLocation') as string) || 'Scanned'

  const ext = (file.name.match(/\.(\w+)$/)?.[1]) || 'jpg'
  const id = crypto.randomUUID()
  const r2Key = `${userId}/${Date.now()}_${id.slice(0, 8)}.${ext}`

  const buffer = await file.arrayBuffer()
  await env.BUCKET.put(r2Key, buffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
    customMetadata: { itemName, category, roomLocation },
  })

  /* Persist metadata to D1 */
  await env.SCAN_DB.prepare(
    `INSERT INTO photos (id, user_id, r2_key, item_name, category, room_location, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, userId, r2Key, itemName, category, roomLocation, new Date().toISOString()).run()

  return new Response(JSON.stringify({ id, r2Key, itemName, category }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   3.  LIST PHOTOS  —  GET /api/photos?userId=...
   ════════════════════════════════════════════════════ */
async function handleListPhotos(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const userId = url.searchParams.get('userId') || 'anonymous'

  const { results } = await env.SCAN_DB.prepare(
    'SELECT id, r2_key, item_name, category, room_location, created_at FROM photos WHERE user_id = ?1 ORDER BY created_at DESC'
  ).bind(userId).all()

  /* Group by category */
  const categorized: Record<string, any[]> = {}
  for (const row of (results as any[])) {
    const cat = row.category || 'Other'
    if (!categorized[cat]) categorized[cat] = []
    categorized[cat].push(row)
  }

  return new Response(JSON.stringify({ categories: categorized, total: results?.length ?? 0 }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   4.  SERVE PHOTO  —  GET /api/photos/<r2_key>
   ════════════════════════════════════════════════════ */
async function handleServePhoto(key: string, env: Env): Promise<Response> {
  const object = await env.BUCKET.get(key)
  if (!object) {
    return new Response(JSON.stringify({ error: 'Photo not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const headers: Record<string, string> = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
    'ETag': object.httpEtag || '',
  }

  return new Response(object.body, { headers: { ...CORS, ...headers } })
}
