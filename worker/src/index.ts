/**
 * Item Location Finder — AI Vision Scan + Vector Search + Chatbot
 *
 * - POST /api/scan   : Vision recognition via @cf/meta/llama-3.2-11b-vision-instruct
 * - POST /api/search : Vector embedding search via @cf/baai/bge-small-en-v1.5
 * - POST /api/match  : Compare new photo against stored scan library
 * - POST /api/chat   : Lost-item assistant chatbot
 *
 * Deploy:
 *   npm create cloudflare -- worker
 *   wrangler deploy
 */

export interface Env {
  AI: { run: (model: string, inputs: any) => Promise<any> }
  BUCKET: R2Bucket             // Bindings → R2 for photo storage
  SCAN_KV: KVNamespace          // Bindings → KV for scan log
  SCAN_DB: D1Database           // Bindings → D1 for persistent storage
}

/* ── CORS ── */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/* ── Helpers ── */
function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:image\/\w+;base64,/, ''))
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/* ── Types ── */
interface ScanResponse {
  itemName: string
  confidence: 'high' | 'medium' | 'low'
  distinctFeatures: string[]
  suggestedCategory: string
  description: string
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

      /* ── Legacy POST-only endpoints ── */
      if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })

      if (path === '/api/scan') return handleVisionScan(request, env)
      if (path === '/api/vision') return handleGatewayVision(request, env)
      if (path === '/api/match') return handleVisionMatch(request, env)
      if (path === '/api/history') return handleHistory(request, env)
      if (path === '/api/search') return handleVectorSearch(request, env)
      if (path === '/api/chat') return handleChat(request, env)
      return new Response(JSON.stringify({ error: 'Unknown route' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  },
}

/* ════════════════════════════════════════════════════
   1.  VISION SCAN  —  /api/scan
   ════════════════════════════════════════════════════ */
async function handleVisionScan(request: Request, env: Env): Promise<Response> {
  const { image, userId = 'anonymous', roomName = 'Unknown', location = 'Scanned' } = await request.json()
  if (!image) return new Response(JSON.stringify({ error: 'Missing image' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  /* 1. Convert base64 → uint8 */
  const imageBytes = base64ToUint8(image)

  /* 2. Run Llama Vision */
  const prompt = `You are an item identification assistant. Analyze this image and identify the single most prominent object. Return ONLY a valid JSON object with these exact keys:
  - "itemName": short descriptive name (e.g. "Singapore Passport", "Car Key", "Black Leather Wallet")
  - "confidence": "high", "medium", or "low"
  - "distinctFeatures": array of 2-4 visible characteristics (e.g. ["Red cover", "Gold coat of arms", "White text"])
  - "suggestedCategory": one of: Documents, Keys, Electronics, Valuables, Warranties, Other
  - "description": one short sentence describing where someone might keep this item

  Do NOT include any text outside the JSON object.`

  const aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: [...imageBytes],
    prompt,
    max_tokens: 300,
  })

  /* 3. Parse JSON from response */
  const raw = typeof aiResult === 'object' ? (aiResult as any).response ?? JSON.stringify(aiResult) : aiResult
  const jsonMatch = String(raw).match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return new Response(JSON.stringify({
      itemName: 'Unknown Item', confidence: 'low',
      distinctFeatures: [], suggestedCategory: 'Other',
      description: 'AI could not identify this item',
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const parsed: ScanResponse = JSON.parse(jsonMatch[0])

  /* 4. Log to KV (recent scans, TTL 7 days) */
  const scanEntry = {
    ...parsed,
    imagePreview: image.slice(0, 100) + '...', // store thumbnail prefix only
    roomName,
    location,
    userId,
    timestamp: new Date().toISOString(),
  }
  const scanId = crypto.randomUUID()
  await env.SCAN_KV.put(`scan:${scanId}`, JSON.stringify(scanEntry), { expirationTtl: 604800 })

  /* 5. Persist to D1 database */
  const stmt = env.SCAN_DB.prepare(`
    INSERT INTO scans (id, user_id, item_name, confidence, distinct_features, suggested_category, description, room_name, location, image_b64, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `)
  await stmt.bind(
    scanId, userId, parsed.itemName, parsed.confidence,
    JSON.stringify(parsed.distinctFeatures), parsed.suggestedCategory,
    parsed.description, roomName, location, image, new Date().toISOString()
  ).run()

  return new Response(JSON.stringify({ scanId, ...parsed }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
    1b. GATEWAY VISION PROXY  —  /api/vision
    Forwards image to company AI Gateway (mimo-v2.5) server-to-server
    to avoid browser CORS. Frontend passes the key as x-ai-key header.
   ════════════════════════════════════════════════════ */
const VISION_GATEWAY_URL = 'https://ai-gateway.guidesify.com/v1/chat/completions'

async function handleGatewayVision(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get('x-ai-key') || ''
  let payload: any
  try { payload = await request.json() } catch { throw new Error('Invalid JSON body') }
  const { image, roomName = 'Scanned', location = 'Scanned', prompt } = payload || {}
  if (!image) return new Response(JSON.stringify({ error: 'Missing image' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (!apiKey) return new Response(JSON.stringify({ error: 'Missing AI key (x-ai-key)' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const systemText = prompt || `You are an item identification assistant. Look at this photo and identify the single most prominent item. Return ONLY valid JSON with keys: "itemName", "confidence" ("high"/"medium"/"low"), "distinctFeatures" (array of 2-4 strings), "suggestedCategory" (one of: Documents, Keys, Electronics, Valuables, Warranties, Other), "description" (one short sentence).`

  const completionBody = JSON.stringify({
    model: 'mimo-v2.5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: systemText },
        { type: 'image_url', image_url: { url: image } },
      ],
    }],
  })

  const upstream = await fetch(VISION_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: completionBody,
  })

  const upstreamText = await upstream.text()
  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: `Gateway error ${upstream.status}`, detail: upstreamText }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  return new Response(upstreamText, { headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/* ════════════════════════════════════════════════════
   2.  VISION MATCH  —  /api/match (compare against library)
   ════════════════════════════════════════════════════ */
async function handleVisionMatch(request: Request, env: Env): Promise<Response> {
  const { image, userId = 'anonymous' } = await request.json()
  if (!image) return new Response(JSON.stringify({ error: 'Missing image' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  /* Fetch user's last 20 scans from D1 */
  const { results } = await env.SCAN_DB.prepare(
    'SELECT id, item_name, image_b64, room_name, location, created_at FROM scans WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20'
  ).bind(userId).all()

  if (!results || results.length === 0) {
    return new Response(JSON.stringify({ match: null, message: 'No previous scans to compare against' }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  /* Send new photo + all previous item names to Llama for matching */
  const imageBytes = base64ToUint8(image)
  const libraryList = (results as any[]).map(r => `- "${r.item_name}" (scanned ${r.created_at} in ${r.room_name})`).join('\n')

  const matchPrompt = `Here is a newly photographed item. The user has previously scanned these items:\n${libraryList}\n\nDoes this new photo match any of the previously scanned items? Return ONLY JSON: {"match": true|false, "matchedItem": "<name or null>", "scanId": "<id or null>", "confidence": "high|medium|low"}`

  const aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: [...imageBytes],
    prompt: matchPrompt,
    max_tokens: 150,
  })

  const raw = typeof aiResult === 'object' ? (aiResult as any).response ?? JSON.stringify(aiResult) : aiResult
  const jsonMatch = String(raw).match(/\{[\s\S]*\}/)

  if (jsonMatch) {
    const matchData = JSON.parse(jsonMatch[0])
    return new Response(JSON.stringify(matchData), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ match: false, matchedItem: null, scanId: null, confidence: 'low' }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
   3.  SCAN HISTORY  —  /api/history
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
   4.  VECTOR SEARCH  —  /api/search (existing)
   ════════════════════════════════════════════════════ */
interface SearchRequest {
  query: string
  items: Array<{ id: string; name: string; location: string; category: string; roomId: string; zoneX: number; zoneY: number }>
  rooms: Array<{ id: string; name: string; zones: Array<{ id: string; label: string; x: number; y: number }> }>
}

interface SearchResult {
  itemId: string; itemName: string; location: string; category: string
  roomId: string; roomName: string
  zone: { id: string; label: string; x: number; y: number } | null
  score: number
}

async function handleVectorSearch(request: Request, env: Env): Promise<Response> {
  const { query, items, rooms }: SearchRequest = await request.json()
  if (!query || !items?.length) {
    return new Response(JSON.stringify({ results: [] }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const passages = items.map(item => `${item.name} ${item.location} ${item.category} ${item.name}`)
  const embRes = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [...passages, query] })
  const itemVectors: number[][] = embRes.data.slice(0, passages.length)
  const queryVector: number[] = embRes.data[passages.length]

  if (!queryVector || itemVectors.length === 0) {
    return new Response(JSON.stringify({ results: [] }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const scored = itemVectors.map((vec, idx) => ({ idx, score: cosineSimilarity(queryVector, vec) }))
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const results: SearchResult[] = scored
    .sort((a, b) => b.score - a.score)
    .filter(s => s.score >= 0.3)
    .slice(0, 5)
    .map(s => {
      const item = items[s.idx]
      const room = roomMap.get(item.roomId)
      let bestZone: SearchResult['zone'] = null
      if (room) {
        let bestDist = Infinity
        for (const z of room.zones) { const d = Math.sqrt((item.zoneX - z.x) ** 2 + (item.zoneY - z.y) ** 2); if (d < bestDist) { bestDist = d; bestZone = { id: z.id, label: z.label, x: z.x, y: z.y } } }
      }
      return { itemId: item.id, itemName: item.name, location: item.location, category: item.category, roomId: item.roomId, roomName: room?.name ?? 'Unknown', zone: bestZone, score: Math.round(s.score * 1000) / 1000 }
    })

  return new Response(JSON.stringify({ results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/* ════════════════════════════════════════════════════
    5.  LOST-ITEM CHATBOT  —  /api/chat
    ════════════════════════════════════════════════════ */
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  message: string
  items: Array<{ id: string; name: string; location: string; category: string; roomId: string; zoneX: number; zoneY: number }>
  rooms: Array<{ id: string; name: string; zones: Array<{ id: string; label: string; x: number; y: number }> }>
  history: ChatMessage[]
}

interface ChatResponse {
  reply: string
  suggestedItemIds: string[]
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const { message, items = [], rooms = [], history = [] }: ChatRequest = await request.json()
  if (!message) {
    return new Response(JSON.stringify({ error: 'Missing message' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* Build inventory context */
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const inventoryLines = items.map(item => {
    const room = roomMap.get(item.roomId)
    return `- ${item.name} (${item.category}) — ${item.location}, in ${room?.name ?? 'Unknown'}`
  })

  const inventoryContext = inventoryLines.length > 0
    ? `\n\nThe user's tracked inventory:\n${inventoryLines.join('\n')}`
    : '\n\nThe user has no tracked items yet.'

  /* Build conversation history */
  const historyBlock = history.map(h =>
    h.role === 'user' ? `User: ${h.content}` : `Assistant: ${h.content}`
  ).join('\n')

  const systemPrompt = `You are a helpful lost-item assistant. Your job is to help the user find items they've misplaced by searching their inventory.

Rules:
1. Always be helpful, concise, and friendly.
2. If the user asks about a specific item and it's in their inventory, tell them exactly where it is (room + location).
3. If the item isn't in their inventory, suggest where they might typically keep it based on its category.
4. If the user asks about items of a certain category (e.g. "Where are my documents?"), list all matching items and their locations.
5. Keep responses short — 2-4 sentences max.
6. When you mention a specific item from the inventory, include its UUID in brackets like [id:uuid-here] so the app can highlight it.${inventoryContext}`

  /* Build full prompt with history */
  const fullPrompt = `${systemPrompt}\n\n${historyBlock}\nUser: ${message}\nAssistant:`

  const aiResult = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    prompt: fullPrompt,
    max_tokens: 500,
  })

  const raw = typeof aiResult === 'object'
    ? (aiResult as any).response ?? JSON.stringify(aiResult)
    : aiResult

  const reply = String(raw).trim()

  /* Extract suggested item IDs from [id:...] brackets in the reply */
  const idRegex = /\[id:([^\]]+)\]/g
  const suggestedItemIds: string[] = []
  let idMatch
  while ((idMatch = idRegex.exec(reply)) !== null) {
    suggestedItemIds.push(idMatch[1])
  }
  /* Clean the brackets from the response text */
  const cleanReply = reply.replace(/\[id:[^\]]+\]/g, '').trim()

  return new Response(JSON.stringify({ reply: cleanReply, suggestedItemIds } satisfies ChatResponse), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* ════════════════════════════════════════════════════
    6.  PHOTO UPLOAD  —  POST /api/photos/upload
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
    7.  LIST PHOTOS  —  GET /api/photos?userId=...
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
    8.  SERVE PHOTO  —  GET /api/photos/<r2_key>
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
