/**
 * Item Location Finder — Cloudflare Worker
 *
 * - POST /api/photos/upload : Upload photo to R2 (max 10 MB, images only)
 * - GET  /api/photos/:key   : Serve photo from R2
 *
 * All /api/* routes require a valid Supabase JWT (Bearer token).
 * Scan history and photo metadata are stored in Supabase (D1 removed).
 *
 * Deploy:
 *   npm create cloudflare -- worker
 *   wrangler deploy
 *   wrangler secret put SUPABASE_JWT_SECRET
 */

import { verifySupabaseJwt, extractBearerToken } from './auth'

export interface Env {
  BUCKET?: R2Bucket
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
        const authResult = await authenticate(request, env)
        if (authResult instanceof Response) return authResult
        const userId = authResult

        /* Photo upload */
        if (path === '/api/photos/upload' && request.method === 'POST') return handlePhotoUpload(request, env, userId)

        /* Serve photo from R2 */
        if (path.startsWith('/api/photos/') && request.method === 'GET') {
          const key = path.slice('/api/photos/'.length)
          if (key.includes('..') || key.includes('\\')) {
            return new Response(JSON.stringify({ error: 'Invalid photo key' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
          }
          if (key) return handleServePhoto(key, env)
          return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }

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
   1.  PHOTO UPLOAD  —  POST /api/photos/upload
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

  const ext = (file.name.match(/\.(\w+)$/)?.[1]) || 'jpg'
  const id = crypto.randomUUID()
  const r2Key = `${userId}/${Date.now()}_${id.slice(0, 8)}.${ext}`

  const buffer = await file.arrayBuffer()
  const r2PutResult = await env.BUCKET.put(r2Key, buffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  }).catch(err => {
    console.error('R2 put failed:', err)
    return null
  })

  if (!r2PutResult) {
    return new Response(JSON.stringify({ error: 'Failed to save photo to storage' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* Return r2Key — frontend handles metadata insert into Supabase */
  return new Response(JSON.stringify({ id, r2Key }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   2.  SERVE PHOTO  —  GET /api/photos/<r2_key>
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
