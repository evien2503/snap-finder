/**
 * Item Location Finder — Cloudflare Worker
 *
 * - POST /api/photos/upload : Upload photo to R2 (max 10 MB, images only)
 * - GET  /api/photos        : List photos by user (paginated: ?limit=&offset=)
 * - GET  /api/photos/:key   : Serve photo from R2
 * - POST /api/history       : Scan history from D1
 *
 * All /api/* routes require a valid Supabase JWT (Bearer token).
 *
 * Deploy:
 *   npm create cloudflare -- worker
 *   wrangler deploy
 *   wrangler secret put SUPABASE_JWT_SECRET
 */

import { verifySupabaseJwt, extractBearerToken } from './auth'

export interface Env {
  BUCKET?: R2Bucket
  SCAN_DB: D1Database
  ASSETS: Fetcher
  SUPABASE_JWT_SECRET: string
}

/* ── CORS ── */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/* ── Auth helper: extract userId from JWT or return 401 ── */
async function authenticate(request: Request, env: Env): Promise<string | Response> {
  const token = extractBearerToken(request)
  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing authorization token' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
  try {
    const user = await verifySupabaseJwt(token, env.SUPABASE_JWT_SECRET)
    return user.sub
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
}

/* ── Router ── */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url = new URL(request.url)
    const path = url.pathname

    try {
      /* ── API routes (require auth) ── */
      if (path.startsWith('/api/')) {
        // Auth check for all API routes except OPTIONS
        const authResult = await authenticate(request, env)
        if (authResult instanceof Response) return authResult
        const userId = authResult

        /* Photo endpoints */
        if (path === '/api/photos/upload' && request.method === 'POST') return handlePhotoUpload(request, env, userId)
        if (path === '/api/photos' && request.method === 'GET') return handleListPhotos(request, env, userId)
        if (path.startsWith('/api/photos/') && request.method === 'GET') {
          const key = path.slice('/api/photos/'.length)
          if (key.includes('..') || key.includes('\\')) {
            return new Response(JSON.stringify({ error: 'Invalid photo key' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
          }
          if (key) return handleServePhoto(key, env)
          return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }

        /* POST endpoints */
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (path === '/api/history') return handleHistory(request, env, userId)
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
   1.  SCAN HISTORY  —  POST /api/history
   ════════════════════════════════════════════════════ */
async function handleHistory(request: Request, env: Env, userId: string): Promise<Response> {
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
async function handlePhotoUpload(request: Request, env: Env, userId: string): Promise<Response> {
  if (!env.BUCKET) {
    return new Response(JSON.stringify({ error: 'Photo storage not configured' }), { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const form = await request.formData()
  const file = form.get('image') as File | null
  if (!file) {
    return new Response(JSON.stringify({ error: 'Missing image file' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const MAX_SIZE = 10 * 1024 * 1024 // 10MB
  if (file.size > MAX_SIZE) {
    return new Response(JSON.stringify({ error: 'File too large (max 10MB)' }), { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (!file.type.startsWith('image/')) {
    return new Response(JSON.stringify({ error: 'Only image files are allowed' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const itemName = (form.get('itemName') as string) || 'Unknown Item'
  const category = (form.get('category') as string) || 'Other'
  const roomLocation = (form.get('roomLocation') as string) || 'Scanned'

  const ext = (file.name.match(/\.(\w+)$/)?.[1]) || 'jpg'
  const id = crypto.randomUUID()
  const r2Key = `${userId}/${Date.now()}_${id.slice(0, 8)}.${ext}`

  const buffer = await file.arrayBuffer()
  const r2PutResult = await env.BUCKET.put(r2Key, buffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
    customMetadata: { itemName, category, roomLocation },
  }).catch(err => {
    console.error('R2 put failed:', err)
    return null
  })

  if (!r2PutResult) {
    return new Response(JSON.stringify({ error: 'Failed to save photo to storage' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* Persist metadata to D1 — if this fails, clean up R2 */
  try {
    await env.SCAN_DB.prepare(
      `INSERT INTO photos (id, user_id, r2_key, item_name, category, room_location, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id, userId, r2Key, itemName, category, roomLocation, new Date().toISOString()).run()
  } catch (err) {
    console.error('D1 insert failed, rolling back R2:', err)
    await env.BUCKET.delete(r2Key).catch(() => {})
    return new Response(JSON.stringify({ error: 'Failed to save photo metadata' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ id, r2Key, itemName, category }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   3.  LIST PHOTOS  —  GET /api/photos
   ════════════════════════════════════════════════════ */
async function handleListPhotos(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100)
  const offset = parseInt(url.searchParams.get('offset') || '0')

  const { results } = await env.SCAN_DB.prepare(
    'SELECT id, r2_key, item_name, category, room_location, created_at FROM photos WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3'
  ).bind(userId, limit, offset).all()

  const { results: countResult } = await env.SCAN_DB.prepare(
    'SELECT COUNT(*) as total FROM photos WHERE user_id = ?1'
  ).bind(userId).all()

  const total = (countResult as any[])?.[0]?.total ?? 0

  /* Group by category */
  const categorized: Record<string, any[]> = {}
  for (const row of (results as any[])) {
    const cat = row.category || 'Other'
    if (!categorized[cat]) categorized[cat] = []
    categorized[cat].push(row)
  }

  return new Response(JSON.stringify({ categories: categorized, total, limit, offset }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   4.  SERVE PHOTO  —  GET /api/photos/<r2_key>
   ════════════════════════════════════════════════════ */
async function handleServePhoto(key: string, env: Env): Promise<Response> {
  if (!env.BUCKET) {
    return new Response(JSON.stringify({ error: 'Photo storage not configured' }), { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

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
