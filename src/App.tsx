import { useState, useEffect, useRef, useMemo } from 'react'
import Fuse from 'fuse.js'

/* ── AI Vector Search — Cloudflare Worker ── */
const AI_SEARCH_URL = import.meta.env.VITE_AI_SEARCH_URL || 'http://localhost:8787'

interface SearchResult {
  itemId: string; itemName: string; location: string; category: string
  roomId: string; roomName: string
  zone: { id: string; label: string; x: number; y: number } | null
  score: number
}

async function aiVectorSearch(
  query: string,
  items: Item[],
  rooms: Room[]
): Promise<SearchResult[]> {
  try {
    const res = await fetch(`${AI_SEARCH_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, items, rooms }),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.results ?? []
  } catch {
    return []
  }
}

/* ── Types ── */

interface Zone { id: string; label: string; x: number; y: number }
interface Room { id: string; name: string; zones: Zone[] }
interface Item { id: string; name: string; location: string; category: string; roomId: string; createdAt: string; lastConfirmed: string; zoneX: number; zoneY: number; imageKey?: string }
interface User { email: string; password: string }
interface ScannedItem {
  id: string; name: string; category: string; location: string
  imageData?: string  // legacy base64 JPEG (fallback if no R2)
  imageUrl?: string   // R2-served URL: {AI_SCAN_URL}/api/photos/{r2_key}
  roomId: string; zoneX: number; zoneY: number
  createdAt: string; lastConfirmed: string
  aiDetected: boolean  // true = AI recognized it, false = manual entry
}

/* ── AI Vision Scan — Cloudflare Worker ── */
const AI_SCAN_URL = import.meta.env.VITE_AI_SCAN_URL || import.meta.env.VITE_AI_SEARCH_URL || ''

interface VisionResult {
  itemName: string
  confidence: 'high' | 'medium' | 'low'
  distinctFeatures: string[]
  suggestedCategory: string
  description: string
}

interface MatchResult {
  match: boolean
  matchedItem: string | null
  scanId: string | null
  confidence: 'high' | 'medium' | 'low'
}

async function visionScan(base64Image: string, userId: string, roomName = 'Unknown', location = 'Scanned'): Promise<VisionResult | null> {
  /* AI Gateway — mimo v2.5 vision scan */
  if (!AI_GATEWAY_KEY) return null
  try {
    const res = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_GATEWAY_KEY}` },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `You are an item identification assistant. Look at this photo and identify the single most prominent item. Return ONLY valid JSON with keys: "itemName", "confidence" ("high"/"medium"/"low"), "distinctFeatures" (array of 2-4 strings), "suggestedCategory" (one of: Documents, Keys, Electronics, Valuables, Warranties, Other), "description" (one short sentence). Example: {"itemName":"Passport","confidence":"high","distinctFeatures":["Red cover","Gold emblem"],"suggestedCategory":"Documents","description":"A travel document kept in a drawer"}` },
            { type: 'image_url', image_url: { url: base64Image } },
          ],
        }],
        max_tokens: 2000,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    /* mimo is a reasoning model — try final answer (content) first, then reasoning */
    const candidate = (msg?.content || msg?.reasoning_content || '').toString()
    /* Strip markdown code fences, then extract first balanced JSON object */
    const cleaned = candidate.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '')
    const open = cleaned.indexOf('{')
    if (open >= 0) {
      let depth = 0
      for (let i = open; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++
        else if (cleaned[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(open, i + 1)) } catch { /* continue */ } } }
      }
    }
    return null
  } catch {
    return null
  }
}

async function visionMatch(base64Image: string, userId: string): Promise<MatchResult | null> {
  try {
    const res = await fetch(`${AI_SCAN_URL}/api/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image, userId }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchScanHistory(userId: string): Promise<any[]> {
  try {
    const res = await fetch(`${AI_SCAN_URL}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.scans ?? []
  } catch {
    return []
  }
}

/* ── R2 Photo Upload / Fetch ── */
async function uploadPhoto(
  base64Image: string,
  userId: string,
  itemName: string,
  category: string,
  roomLocation: string
): Promise<{ id: string; r2Key: string } | null> {
  try {
    /* Convert base64 → Blob → File for FormData */
    const blobResp = await fetch(base64Image)
    const blob = await blobResp.blob()
    const file = new File([blob], `scan_${Date.now()}.jpg`, { type: 'image/jpeg' })

    const form = new FormData()
    form.append('image', file)
    form.append('userId', userId)
    form.append('itemName', itemName)
    form.append('category', category)
    form.append('roomLocation', roomLocation)

    const res = await fetch(`${AI_SCAN_URL}/api/photos/upload`, { method: 'POST', body: form })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchPhotos(userId: string): Promise<{ categories: Record<string, any[]>; total: number }> {
  try {
    const res = await fetch(`${AI_SCAN_URL}/api/photos?userId=${encodeURIComponent(userId)}`)
    if (!res.ok) return { categories: {}, total: 0 }
    return await res.json()
  } catch {
    return { categories: {}, total: 0 }
  }
}

interface ChatAction { type: 'move_room' | 'assign_zone' | 'unassign' | 'move_and_assign'; itemId: string; label: string; roomId?: string; zoneId?: string }
interface ChatResponse { reply: string; reasoning?: string; suggestedItemIds: string[]; actions: ChatAction[] }

/* ── AI Chatbot — AI Gateway (OpenAI-compatible) ── */
const AI_GATEWAY_URL = 'https://ai-gateway.guidesify.com/v1/chat/completions'
const AI_GATEWAY_KEY = import.meta.env.VITE_AI_KEY || ''

async function sendChat(message: string, items: Item[], rooms: Room[], history: Array<{ role: string; content: string }>): Promise<ChatResponse> {
  if (!AI_GATEWAY_KEY) {
    return { reply: 'AI key not configured. Add VITE_AI_KEY to your .env file to enable the assistant.', suggestedItemIds: [], actions: [] }
  }

  /* Build rich inventory context grouped by room with stats */
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const groupedByRoom = new Map<string, Item[]>()
  items.forEach(item => { const list = groupedByRoom.get(item.roomId) || []; list.push(item); groupedByRoom.set(item.roomId, list) })

  const now = Date.now()
  const staleThreshold = 3 * 24 * 60 * 60 * 1000 // 3 days
  const staleCount = items.filter(i => new Date(i.lastConfirmed).getTime() < now - staleThreshold).length
  const unsortedCount = items.filter(i => i.zoneX === -50 && i.zoneY === -50).length

  const inventoryLines: string[] = []
  groupedByRoom.forEach((roomItems, roomId) => {
    const room = roomMap.get(roomId)
    const zones = room?.zones.map(z => `${z.id}="${z.label}"`).join(', ') || 'none'
    inventoryLines.push(`## ${room?.name ?? 'Unknown'} [room:${roomId}] (zones: ${zones})`)
    roomItems.forEach(item => {
      const lastChecked = Math.round((now - new Date(item.lastConfirmed).getTime()) / (24 * 60 * 60 * 1000))
      const stale = lastChecked > 3 ? ` ⚠️ last checked ${lastChecked}d ago` : ''
      const unsorted = item.zoneX === -50 && item.zoneY === -50 ? ' [unsorted]' : ''
      inventoryLines.push(`- ${item.name} (${item.category}) — ${item.location}${unsorted}${stale} [id:${item.id}]`)
    })
  })

  const statsLine = `Stats: ${items.length} total items across ${rooms.length} rooms, ${unsortedCount} unsorted, ${staleCount} unchecked in 3+ days.`

  const inventoryContext = items.length > 0
    ? `\n\nUSER'S INVENTORY (${items.length} items in ${rooms.length} rooms):\n${statsLine}\n\n${inventoryLines.join('\n')}`
    : '\n\nUser has no tracked items yet.'

  const systemPrompt = `You are a home-organizer assistant. Help users manage, find, and organize their belongings.

CAPABILITIES:
- Find items by name, category, room, or partial match.
- Summarize what's in each room or category.
- Identify stale/unchecked items that need attention.
- Suggest where unsorted items should be stored based on their category.
- Answer general organization questions (based on your knowledge).
- When the user asks to move/relocate/assign an item, offer an ACTION.

RULES:
- First, think step-by-step inside <reasoning> tags (what the user wants, which items match, analysis).
- Then provide the answer inside <answer> tags.
- Be concise, warm, and practical (2-5 sentences).
- If an item is in the inventory, tell them EXACTLY where it is (room + location).
- If not found, suggest where they might keep it based on the item category.
- For category/room queries, list ALL matching items with locations.
- Flag stale items (⚠️ unchecked >3 days) proactively.
- Include item tracking IDs as [id:UUID] so the app can highlight them.

ACTIONS (use sparingly, only when the user explicitly asks to move/sort/organize):
- To offer moving an item to a room: <action type="move_room" item="ITEM_UUID" room="ROOM_ID">Move to RoomName</action>
- To offer placing an item in a zone: <action type="assign_zone" item="ITEM_UUID" zone="ZONE_ID">Place on ZoneLabel</action>
- To offer removing from map: <action type="unassign" item="ITEM_UUID">Remove from Map</action>
- When the user asks to move an item to a specific spot in another room (e.g. "move keys to Bedroom, Desk"), use this combined action: <action type="move_and_assign" item="ITEM_UUID" room="ROOM_ID" zone="ZONE_ID">Move to RoomName → ZoneLabel</action>
- Place action tags INSIDE the <answer> tag, after or between sentences.
- Only offer actions for items that the user is currently discussing.
- Never offer delete actions.
- Always use the EXACT room IDs and zone IDs from the inventory context. Rooms: [room:ROOM_ID]. Zones: id="Label" pairs — copy the id directly (e.g. desk, nightstand_l, cabinet).
- The action button commits the move — the item is NOT moved yet when you reply. Never say "has been moved", "successfully moved", or "relocated". Instead invite the user to click the button, e.g. "Click the button below to move your Melon to the Living Room."
- Before offering any action, VERIFY that the target room AND zone actually exist in the inventory context above. Rooms are listed as [room:ROOM_ID], zones as id="Label" pairs.
- If the user asks to move to a room or zone that does NOT exist (e.g. a "Cabinet" when that room has no Cabinet), do NOT emit an action tag. Instead tell them clearly: "There's no Cabinet in the Living Room. Available spots: Desk, Bookshelf, TV Stand, Coffee Table, Drawer." and offer the closest real alternative.
- Distinguish source from destination: "from <Room>" means where the item currently is; "to <Room> <Zone>" means where it should go. If the user's stated source doesn't match the item's actual location, politely point that out instead of guessing.
- If the request is ambiguous, ask a short clarifying question rather than emitting a wrong action.

Example output:
<reasoning>The user is asking about their keys. Inventory shows "House Keys" in Living Room on Coffee Table.</reasoning>
<answer>Your keys are in the **Living Room** on the Coffee Table. I'd check the bowl by the TV remote. 🔑</answer>

Example with move action:
<reasoning>User wants the water bottle moved to Bedroom. "Water Bottle" [id:abc123] is currently in Living Room. Bedroom ID is room-bedroom.</reasoning>
<answer>Got it! Your Water Bottle is in the Living Room. Click the button below to move it to the Bedroom: <action type="move_room" item="abc123" room="room-bedroom">Move to Bedroom</action></answer>

Example with combined move-and-place (when user specifies both room AND spot):
<reasoning>User wants keys moved to Bedroom, Nightstand. "House Keys" [id:xyz789] is in Living Room. Bedroom is [room:room-bedroom] with zones nightstand_l="Nightstand L".</reasoning>
<answer>Sure! Click the button below to move your keys to the Bedroom → Nightstand L: <action type="move_and_assign" item="xyz789" room="room-bedroom" zone="nightstand_l">Move to Bedroom → Nightstand L</action></answer>

Example when the target room/zone does NOT exist (never emit an action tag):
<reasoning>User wants the melon moved to a Cabinet in the Living Room, but the Living Room has no Cabinet — its zones are Desk, Bookshelf, TV Stand, Coffee Table, Drawer.</reasoning>
<answer>There's no Cabinet in the Living Room. Available spots are the Desk, Bookshelf, or Coffee Table — want me to move it to one of those instead?</answer>${inventoryContext}`

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: message },
  ]

  try {
    const res = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_GATEWAY_KEY}` },
      body: JSON.stringify({ model: 'free-last-resort', messages, max_tokens: 1500, temperature: 0.5 }),
    })
    if (!res.ok) {
      return { reply: 'AI assistant unavailable right now. Please try again.', suggestedItemIds: [], actions: [] }
    }
    const data = await res.json()
    const rawContent = data.choices?.[0]?.message?.content?.trim() || ''
    if (!rawContent) return { reply: 'AI returned an empty response. Please try again.', suggestedItemIds: [], actions: [] }

    /* ── Pure helpers (mirrored in test-parser.js) ── */
    /* Tolerant <answer> extraction: inner text if </answer> exists, else everything after <answer>, else raw */
    const extractAnswer = (raw: string): string => {
      const start = raw.indexOf('<answer>')
      const end = raw.indexOf('</answer>')
      if (start === -1) return raw.trim()
      const inner = start + '<answer>'.length
      return (end !== -1 && end > inner ? raw.slice(inner, end) : raw.slice(inner)).trim()
    }

    /* Sanitize: strip ALL leftover markup (complete or truncated/unclosed fragments) so raw XML never shows */
    const sanitizeChatText = (text: string): string =>
      text
        .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/g, '')  /* reasoning blocks (incl. truncated) */
        .replace(/<\/reasoning>/g, '')                           /* stray reasoning close tags */
        .replace(/<\/?answer>/g, '')                             /* stray answer tags */
        .replace(/<action[\s\S]*?(?:<\/action>|$)/g, '')        /* action tags + truncated/unclosed fragments */
        .replace(/<\/action>/g, '')                              /* stray action close tags */
        .replace(/\[id:[^\]]+\]/g, '')                           /* id highlight tags */
        .replace(/\s{2,}/g, ' ')
        .trim()

    /* Only well-formed complete <action ...>...</action> tags produce actions */
    const parseActions = (text: string): ChatAction[] => {
      const actionRegex = /<action\s+type="(\w+)"\s+item="([^"]+)"(?:\s+room="([^"]*)")?(?:\s+zone="([^"]*)")?\s*>([\s\S]*?)<\/action>/g
      const result: ChatAction[] = []
      let am
      while ((am = actionRegex.exec(text)) !== null) {
        result.push({ type: am[1] as ChatAction['type'], itemId: am[2], roomId: am[3] || undefined, zoneId: am[4] || undefined, label: am[5].trim() })
      }
      return result
    }

    /* Parse <reasoning> and <answer> tags */
    const reasoningMatch = rawContent.match(/<reasoning>([\s\S]*?)<\/reasoning>/)
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : undefined
    const answer = extractAnswer(rawContent)

    /* Extract [id:...] tags for item highlighting */
    const idRegex = /\[id:([^\]]+)\]/g
    const suggestedItemIds: string[] = []
    let m
    while ((m = idRegex.exec(answer)) !== null) suggestedItemIds.push(m[1])

    const actions = parseActions(answer)
    const cleanReply = sanitizeChatText(answer)

    const fallback = actions.length > 0
      ? 'Click the button below to complete the move.'
      : 'I found some information for you.'
    return { reply: cleanReply || fallback, reasoning, suggestedItemIds, actions }
  } catch {
    return { reply: 'Sorry, could not reach the AI service. Please try again.', suggestedItemIds: [], actions: [] }
  }
}

const DEFAULT_ROOMS: Room[] = [
  { id: 'room_living', name: 'Living Room', zones: [
    { id: 'desk', label: 'Desk', x: 20, y: 25 }, { id: 'shelf', label: 'Bookshelf', x: 70, y: 18 },
    { id: 'tv_stand', label: 'TV Stand', x: 85, y: 40 }, { id: 'cabinet', label: 'Cabinet', x: 72, y: 68 },
    { id: 'table', label: 'Coffee Table', x: 35, y: 52 }, { id: 'drawer', label: 'Drawer', x: 10, y: 70 },
  ]},
  { id: 'room_bedroom', name: 'Bedroom', zones: [
    { id: 'bed', label: 'Bed', x: 50, y: 22 }, { id: 'nightstand_l', label: 'Nightstand L', x: 18, y: 35 },
    { id: 'nightstand_r', label: 'Nightstand R', x: 82, y: 35 }, { id: 'wardrobe', label: 'Wardrobe', x: 72, y: 68 },
    { id: 'dresser', label: 'Dresser', x: 22, y: 68 }, { id: 'desk', label: 'Desk', x: 10, y: 22 },
  ]},
  { id: 'room_kitchen', name: 'Kitchen', zones: [
    { id: 'fridge', label: 'Fridge', x: 15, y: 22 }, { id: 'cabinet_u', label: 'Upper Cabinet', x: 55, y: 14 },
    { id: 'counter', label: 'Counter', x: 60, y: 40 }, { id: 'cabinet_l', label: 'Lower Cabinet', x: 50, y: 66 },
    { id: 'pantry', label: 'Pantry', x: 86, y: 55 }, { id: 'island', label: 'Island', x: 42, y: 45 },
  ]},
]

const SAMPLE_ITEMS: Array<{ name: string; location: string; category: string; roomId: string; zoneX: number; zoneY: number }> = [
  { name: 'Passport', location: 'Desk Drawer', category: 'Documents', roomId: 'room_living', zoneX: 20, zoneY: 25 },
  { name: 'Laptop', location: 'Desk', category: 'Electronics', roomId: 'room_living', zoneX: 20, zoneY: 23 },
  { name: 'House Keys', location: 'Nightstand', category: 'Keys', roomId: 'room_bedroom', zoneX: 82, zoneY: 35 },
  { name: 'Warranty Card', location: 'Cabinet Shelf', category: 'Warranties', roomId: 'room_living', zoneX: 72, zoneY: 66 },
  { name: 'Spare Phone Charger', location: 'Bedroom Dresser', category: 'Electronics', roomId: 'room_bedroom', zoneX: 22, zoneY: 66 },
]

const QUICK_CHIPS = [
  { label: 'Keys', query: 'keys', icon: '🔑' },
  { label: 'Passport', query: 'passport', icon: '🛂' },
  { label: 'Laptop', query: 'laptop', icon: '💻' },
  { label: 'Wallet', query: 'wallet', icon: '👛' },
]

/* ── Utility Functions ── */

function storageKey(user: string) { return `ilf_data_${user}` }

function hashPass(pw: string): string {
  let h = 0; for (let i = 0; i < pw.length; i++) { const c = pw.charCodeAt(i); h = ((h << 5) - h) + c; h |= 0 }
  return btoa(String(h))
}
function getUsers(): User[] { return JSON.parse(localStorage.getItem('ilf_users') || '[]') }
function saveUsers(users: User[]) { localStorage.setItem('ilf_users', JSON.stringify(users)) }

function isValidDate(value: unknown): value is string {
  if (!value || typeof value !== 'string') return false
  const d = new Date(value)
  return d instanceof Date && !isNaN(d.getTime())
}

function formatDate(d: Date) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
function shortDate(d: Date) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) }

function timeAgo(iso: string): string {
  if (!isValidDate(iso)) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(new Date(iso))
}

function getConfidencePercent(iso: string): number {
  if (!isValidDate(iso)) return 0
  const diff = Date.now() - new Date(iso).getTime()
  const hours = diff / 3600000
  if (hours < 1) return 100
  if (hours > 336) return 5
  return Math.round(100 - (hours / 336) * 95)
}

function pinColor(cat: string) {
  const colors: Record<string, string> = { Documents: '#2563eb', Electronics: '#059669', Keys: '#d97706', Warranties: '#2563eb', Valuables: '#be185d' }
  return colors[cat] || '#6b7280'
}

function pinIcon(name: string) {
  const l = name.toLowerCase()
  if (l.includes('passport') || l.includes('document')) return '🛂'
  if (l.includes('key')) return '🔑'
  if (l.includes('laptop') || l.includes('phone') || l.includes('charger') || l.includes('computer')) return '💻'
  if (l.includes('warranty') || l.includes('receipt')) return '📄'
  if (l.includes('wallet') || l.includes('cash') || l.includes('money')) return '👛'
  return '📦'
}

function categoryIcon(cat: string) {
  switch (cat) {
    case 'Documents': return '📄'
    case 'Electronics': return '💻'
    case 'Keys': return '🔑'
    case 'Warranties': return '📋'
    case 'Valuables': return '💎'
    default: return '📦'
  }
}

/* ── Room Map Panel ── */

function RoomMapPanel({
  room, rooms, currentRoomId, roomItems, selectedZone, glowingItemId, glowingZoneId, isEditingMap, onClose,
  onToggleEdit, onZoneMove, onSelectZone, onPinClick, onAddFurniture, onDeleteZone, onAssignItem, onUnassignItem, onMoveToRoom,
}: {
  room: Room; rooms: Room[]; currentRoomId: string; roomItems: Item[]; selectedZone: string | null; glowingItemId: string | null; glowingZoneId: string | null;
  isEditingMap: boolean; onClose?: () => void;
  onToggleEdit: () => void;
  onZoneMove: (roomId: string, zoneId: string, x: number, y: number) => void;
  onSelectZone: (id: string | null) => void;
  onPinClick: (itemId: string) => void;
  onAddFurniture: (roomId: string) => void;
  onDeleteZone: (roomId: string, zoneId: string) => void;
  onAssignItem: (itemId: string, zoneId: string) => void;
  onUnassignItem: (itemId: string) => void;
  onMoveToRoom: (itemId: string, roomId: string) => void;
}) {
  const dragStateRef = useRef<{ roomId: string; zoneId: string } | null>(null)
  const [dropZoneId, setDropZoneId] = useState<string | null>(null)
  const [assignItemId, setAssignItemId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const itemDragRef = useRef<{ itemId: string; ghost: HTMLElement } | null>(null)

  /* ── Suppress browser no-drop cursor while dragging items ── */
  useEffect(() => {
    const onDragover = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-snap-item')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }
    }
    document.addEventListener('dragover', onDragover)
    return () => document.removeEventListener('dragover', onDragover)
  }, [])

  /* ── Drag zones ── */
  function startDrag(zoneEl: HTMLElement) {
    if (zoneEl.closest('.map-pin, .zone-delete')) return
    const roomId = zoneEl.dataset.roomId; const zoneId = zoneEl.dataset.zone
    if (!roomId || !zoneId) return
    dragStateRef.current = { roomId, zoneId }
    zoneEl.classList.add('dragging')
    const border = zoneEl.closest('.room-border') as HTMLElement
    if (!border) return
    const rect = border.getBoundingClientRect()

    function onMove(cx: number, cy: number) {
      if (!dragStateRef.current) return
      const px = ((cx - rect.left) / rect.width) * 100; const py = ((cy - rect.top) / rect.height) * 100
      const x = Math.max(0, Math.min(100, Math.round(px * 10) / 10)); const y = Math.max(0, Math.min(100, Math.round(py * 10) / 10))
      onZoneMove(dragStateRef.current.roomId, dragStateRef.current.zoneId, x, y)
      const el = document.querySelector<HTMLElement>(`.drag-zone[data-zone="${zoneId}"][data-room-id="${roomId}"]`)
      if (el) { el.style.left = `${x}%`; el.style.top = `${y}%` }
    }
    function onUp() {
      dragStateRef.current = null; document.querySelectorAll('.drag-zone.dragging').forEach(el => el.classList.remove('dragging'))
      document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchmove', onTouchMove); document.removeEventListener('touchend', onTouchEnd)
    }
    function onMouseMove(ev: MouseEvent) { onMove(ev.clientX, ev.clientY) }
    function onMouseUp() { onUp() }
    function onTouchMove(ev: TouchEvent) { if (ev.touches[0]) onMove(ev.touches[0].clientX, ev.touches[0].clientY) }
    function onTouchEnd() { onUp() }
    document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchmove', onTouchMove, { passive: true }); document.addEventListener('touchend', onTouchEnd)
  }

  /* ── Touch-drag pins → unsorted tray (unassign) ── */
  function startPinTouchDrag(ev: React.TouchEvent, itemId: string) {
    const touch = ev.touches[0]; if (!touch) return
    const pinEl = ev.currentTarget as HTMLElement
    const ghost = pinEl.cloneNode(true) as HTMLElement
    ghost.style.cssText = 'position:fixed;z-index:100;pointer-events:none;opacity:0.85;transform:scale(1.15);left:' + touch.clientX + 'px;top:' + touch.clientY + 'px;margin:-14px 0 0 -14px;'
    document.body.appendChild(ghost)
    itemDragRef.current = { itemId, ghost }
    const onMove = (ev2: TouchEvent) => { const t = ev2.touches[0]; if (t && itemDragRef.current) itemDragRef.current.ghost.style.left = t.clientX + 'px'; if (t && itemDragRef.current) itemDragRef.current.ghost.style.top = t.clientY + 'px' }
    const onEnd = () => {
      const tray = document.querySelector('[data-unsorted-tray]')
      if (tray && itemDragRef.current) {
        const r = tray.getBoundingClientRect()
        const ghost = itemDragRef.current.ghost
        const gx = parseFloat(ghost.style.left); const gy = parseFloat(ghost.style.top)
        if (gx >= r.left && gx <= r.right && gy >= r.top && gy <= r.bottom) onUnassignItem(itemDragRef.current.itemId)
      }
      if (itemDragRef.current) { itemDragRef.current.ghost.remove(); itemDragRef.current = null }
      document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); document.removeEventListener('touchcancel', onEnd)
    }
    document.addEventListener('touchmove', onMove, { passive: true }); document.addEventListener('touchend', onEnd); document.addEventListener('touchcancel', onEnd)
  }

  return (
    <>
    {expanded && (
      <div className="fixed inset-0 z-[85] bg-black/40 animate-[fadeIn_0.2s_ease-out]" onClick={() => setExpanded(false)} />
    )}
    <div className={`${expanded
      ? 'fixed right-0 top-0 z-[90] w-1/2 h-full bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-2xl overflow-hidden animate-[slideRight_0.3s_cubic-bezier(0.4,0,0.2,1)]'
      : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden'}`}>
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold">🗺️ {room.name}</h3>
        <div className="flex items-center gap-2">
          {selectedZone && (
            <button type="button" onClick={() => onSelectZone(null)} className="px-2.5 py-1 text-xs font-medium border border-gray-200 dark:border-gray-600 rounded-md cursor-pointer bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation">Clear Filter</button>
          )}
          <button type="button" onClick={onToggleEdit}
            className={`px-2.5 py-1 text-xs font-medium border rounded-md cursor-pointer transition-colors touch-manipulation ${
              isEditingMap ? 'bg-blue-500 text-white border-blue-500 hover:bg-blue-600' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}>
            {isEditingMap ? '✅ Done' : '✏️ Edit Map'}
          </button>
          <button type="button" onClick={() => setExpanded(v => !v)}
            className={`px-2.5 py-1 text-xs font-medium border rounded-md cursor-pointer transition-colors touch-manipulation ${
              expanded ? 'bg-blue-500 text-white border-blue-500 hover:bg-blue-600' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}>
            {expanded ? '➖ Collapse' : '⛶ Expand Map'}
          </button>
          {onClose && (
            expanded
              ? <button aria-label="Collapse map" onClick={() => setExpanded(false)} className="bg-none border-none text-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 p-1 rounded transition-colors touch-manipulation">➖</button>
              : <button aria-label="Close map" onClick={onClose} className="bg-none border-none text-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 p-1 rounded transition-colors touch-manipulation">✕</button>
          )}
        </div>
      </div>
      <div className="p-4">
        <div className={`relative w-full ${expanded ? 'min-h-[calc(100vh-220px)]' : 'aspect-[4/3]'} bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden room-border`}>
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-600 font-medium pointer-events-none whitespace-nowrap select-none">Drag zones to rearrange</div>
          {room.zones.map(zone => {
            const zoned = roomItems.filter(i => Math.abs(i.zoneX - zone.x) < 15 && Math.abs(i.zoneY - zone.y) < 15)
            const hasGlowing = zoned.some(i => i.id === glowingItemId)
            const zoneCats = [...new Set(zoned.map(i => i.category))]
            const zoneColor = zoneCats.length === 1 ? pinColor(zoneCats[0]) : null
            return (
              <div key={zone.id}
                className={`drag-zone absolute -translate-x-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all select-none min-w-[60px] ${
                  selectedZone === zone.id ? 'bg-blue-500/20 border-blue-500' : 'bg-blue-500/10 border-blue-500/30'
                } ${glowingZoneId === zone.id ? '!border-emerald-400 !shadow-[0_0_15px_rgba(16,185,129,0.5),0_0_30px_rgba(16,185,129,0.2)] !bg-emerald-500/20 !z-10' : ''} ${hasGlowing ? '!border-blue-500 !shadow-[0_0_0_3px_rgba(59,130,246,0.2),0_0_20px_rgba(59,130,246,0.15)] animate-pulse' : ''} ${isEditingMap ? 'ring-2 ring-blue-400/60' : ''} ${dropZoneId === zone.id ? 'ring-2 ring-emerald-400 bg-emerald-500/10 !z-10' : ''}`}
                data-zone={zone.id} data-room-id={room.id}
                style={{ left: `${zone.x}%`, top: `${zone.y}%`, border: '1px dashed', touchAction: 'none', ...(zoneColor ? { borderColor: zoneColor, background: `${zoneColor}15` } : {}) }}
                onMouseDown={e => { if (!(e.target as HTMLElement).closest('.map-pin, .zone-delete')) startDrag(e.currentTarget) }}
                onTouchStart={e => { if (!(e.target as HTMLElement).closest('.map-pin, .zone-delete')) startDrag(e.currentTarget) }}
                onClick={e => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('.map-pin, .zone-delete')) onSelectZone(selectedZone === zone.id ? null : zone.id) }}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropZoneId(zone.id) }}
                onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) onAssignItem(id, zone.id); setDropZoneId(null) }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZoneId(null) }}>
                <span className="block text-[11px] text-gray-500 dark:text-gray-400 font-semibold text-center pointer-events-none select-none">{zone.label}</span>
                {zoned.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center pointer-events-none select-none">{zoned.length}</span>
                )}
                {isEditingMap && (
                  <button type="button" aria-label={`Delete zone ${zone.label}`} className="zone-delete absolute -top-2 -right-2 w-11 h-11 flex items-center justify-center rounded-full bg-white dark:bg-gray-700 border border-red-300 dark:border-red-900 text-red-500 text-sm shadow-md cursor-pointer z-10" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${zone.label}"? Items near it will become unsorted.`)) onDeleteZone(room.id, zone.id) }}>🗑️</button>
                )}
                {zoned.map(i => (
                  <div key={i.id}
                    className={`map-pin absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-sm cursor-pointer shadow-md z-2 transition-all hover:scale-120 ${
                      glowingItemId === i.id ? '!z-6 animate-pulse-glow' : ''
                    }`}
                    data-item-id={i.id} data-pin-for={i.id}
                    style={{ background: pinColor(i.category), touchAction: 'none' }}
                    draggable="true"
                    onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.setData('application/x-snap-item', i.id); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging-active') }}
                    onDragEnd={() => document.body.classList.remove('dragging-active') }
                    onTouchStart={e => { e.stopPropagation(); startPinTouchDrag(e, i.id) }}
                    onClick={e => { e.stopPropagation(); onPinClick(i.id) }}>
                    {pinIcon(i.name)}
                  </div>
                ))}
              </div>
            )
          })}
          {isEditingMap && (
            <button type="button" onClick={() => onAddFurniture(room.id)} className="absolute bottom-2 right-2 z-20 px-4 py-2.5 min-h-[44px] bg-blue-500 hover:bg-blue-600 text-white text-xs font-bold rounded-lg shadow-md cursor-pointer touch-manipulation">+ Add Furniture</button>
          )}
        </div>
        {/* Unsorted bar */}
        {(() => {
          const unsorted = roomItems.filter(i => !room.zones.some(z => Math.abs(i.zoneX - z.x) < 15 && Math.abs(i.zoneY - z.y) < 15))
          if (unsorted.length === 0) return null
          return (
            <div data-unsorted-tray className="flex items-center gap-2 p-2.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex-wrap"
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
              onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) onUnassignItem(id) }}>
              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">📦 Unsorted / Off-Map Items</span>
              {unsorted.map(i => (
                <span key={i.id} data-tray-pill={i.id} draggable="true"
                  onDragStart={e => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.setData('application/x-snap-item', i.id); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging-active') }}
                  onDragEnd={() => { document.body.classList.remove('dragging-active'); setDropZoneId(null) }}
                  onClick={() => setAssignItemId(assignItemId === i.id ? null : i.id)}
                  className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-gray-700 dark:text-gray-300 whitespace-nowrap cursor-pointer hover:border-blue-500 transition-colors ${
                    glowingItemId === i.id ? '!border-blue-500 !shadow-[0_0_0_2px_rgba(59,130,246,0.2)]' : ''
                  }`}>
                  {pinIcon(i.name)} {i.name}
                </span>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
    {assignItemId && (() => {
      const rect = document.querySelector(`[data-tray-pill="${assignItemId}"]`)?.getBoundingClientRect()
      return (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setAssignItemId(null)} />
          <div style={{ position: 'fixed', top: (rect?.bottom ?? 0) + 4, left: Math.min(rect?.left ?? 0, window.innerWidth - 160) }} className="z-[80] bg-white dark:bg-gray-800 border rounded-lg shadow-xl p-2 w-40">
            <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 px-3 py-1">Assign to:</div>
            {room.zones.map(z => (
              <button key={z.id} type="button" onClick={() => { onAssignItem(assignItemId, z.id); setAssignItemId(null) }} className="block w-full text-left px-3 py-2 text-xs hover:bg-blue-50 dark:hover:bg-gray-700 rounded-md">{z.label}</button>
            ))}
            <div className="border-t my-1" />
            <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 px-3 py-1">Move to Room:</div>
            {rooms.filter(r => r.id !== currentRoomId).map(r => (
              <button key={r.id} type="button" onClick={() => { onMoveToRoom(assignItemId, r.id); setAssignItemId(null) }} className="block w-full text-left px-3 py-2 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-md">🏠 {r.name}</button>
            ))}
          </div>
        </>
      )
    })()}
    </>
  )
}

/* ── React App ── */

export default function App() {
  /* ── Dark mode (eager: read before first paint to prevent flash) ── */
  const initialDark = typeof window !== 'undefined' ? localStorage.getItem('ilf_dark') === 'true' : false
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('dark', initialDark)

  /* ── State ── */
  const [page, setPage] = useState<'auth' | 'dashboard'>('auth')
  const [user, setUser] = useState<User | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [currentRoomId, setCurrentRoomId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [authError, setAuthError] = useState('')
  const [darkMode, setDarkMode] = useState(initialDark)
  const [isListening, setIsListening] = useState(false)
  const [selectedZone, setSelectedZone] = useState<string | null>(null)
  const [glowingItemId, setGlowingItemId] = useState<string | null>(null)
  const [glowingZoneId, setGlowingZoneId] = useState<string | null>(null)
  const [isEditingMap, setIsEditingMap] = useState(false)
  const [glowingRoomIds, setGlowingRoomIds] = useState<string[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingItem, setEditingItem] = useState<Item | null>(null)
  const [showCameraScan, setShowCameraScan] = useState(false)
  const [scanMode, setScanMode] = useState<'idle' | 'camera' | 'captured' | 'analyzing' | 'result'>('idle')
  const [capturedImage, setCapturedImage] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<{ name: string; category: string; description: string; confidence?: string; features?: string[] } | null>(null)
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([])
  const [showScannedGallery, setShowScannedGallery] = useState(false)
  const [photosFromServer, setPhotosFromServer] = useState<Record<string, any[]> | null>(null)
  const [photosLoading, setPhotosLoading] = useState(false)
  const [assigningPhoto, setAssigningPhoto] = useState<{ id: string; r2Key?: string; imageData?: string } | null>(null)
  const [pickForItem, setPickForItem] = useState<Item | null>(null)
  const [pickSearch, setPickSearch] = useState('')
  const [showConfetti, setShowConfetti] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1)
  const [showMobileMap, setShowMobileMap] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [chatMessages, setChatMessages] = useState<Array<{role:'user'|'assistant';content:string;reasoning?:string;suggestedIds:string[];actions?:ChatAction[]}>>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [doneActions, setDoneActions] = useState<string[]>([])
  const [failedActions, setFailedActions] = useState<string[]>([])
  const [chatInput, setChatInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const [dismissAlerts, setDismissAlerts] = useState<string[]>([])
  const [showPrompt, setShowPrompt] = useState(false)
  const [promptPlaceholder, setPromptPlaceholder] = useState('')
  const [promptCallback, setPromptCallback] = useState<((v: string | null) => void) | null>(null)
  const [isSignUp, setIsSignUp] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

  const [searchFocused, setSearchFocused] = useState(false)
  const [aiResults, setAiResults] = useState<SearchResult[]>([])
  const [aiThinking, setAiThinking] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const semanticTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fuse = useMemo(() => new Fuse(items, {
    keys: [
      { name: 'name', weight: 2 },
      { name: 'location', weight: 1 },
      { name: 'category', weight: 1 },
    ],
    threshold: 0.45,
    includeScore: true,
    minMatchCharLength: 2,
  }), [items])

  const recognitionRef = useRef<any>(null)
  const userRef = useRef<string>('anonymous')
  const searchPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scanVideoRef = useRef<HTMLVideoElement | null>(null)
  const scanStreamRef = useRef<MediaStream | null>(null)

  const room = rooms.find(r => r.id === currentRoomId) || rooms[0]
  const roomItems = items.filter(i => i.roomId === currentRoomId)
  const filtered = searchQuery
    ? roomItems.filter(i => {
        const q = searchQuery.toLowerCase()
        return i.name.toLowerCase().includes(q) || i.location.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
      })
    : roomItems
  const stale = items.filter(i => {
    const cutoff = Date.now() - 3 * 24 * 3600000
    return i.roomId === currentRoomId && isValidDate(i.lastConfirmed) && new Date(i.lastConfirmed).getTime() < cutoff
  })

  /* ── Sync dark class on toggle ── */
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  function toggleDark() {
    const next = !darkMode
    setDarkMode(next)
    localStorage.setItem('ilf_dark', String(next))
    document.documentElement.classList.toggle('dark', next)
  }

  /* ── Data persistence ── */
  function save() {
    if (!user) return
    localStorage.setItem(storageKey(user.email), JSON.stringify({ rooms, items, currentRoomId, scannedItems }))
  }

  useEffect(() => { if (user) save() }, [rooms, items, currentRoomId, scannedItems])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatMessages])
  useEffect(() => {
    if (showScannedGallery) {
      setPhotosLoading(true)
      fetchPhotos(userRef.current).then(data => {
        setPhotosFromServer(data.categories)
        setPhotosLoading(false)
      })
      syncHistory()
    }
  }, [showScannedGallery])

  useEffect(() => {
    if (pickForItem) {
      fetchPhotos(userRef.current).then(data => setPhotosFromServer(data.categories)).catch(() => {})
      syncHistory()
    }
  }, [pickForItem])

  function loadData(u: User) {
    const raw = localStorage.getItem(storageKey(u.email))
    if (!raw) {
      if (!localStorage.getItem('ilf_onboarded')) {
        setRooms(JSON.parse(JSON.stringify(DEFAULT_ROOMS)))
        setItems([])
        setCurrentRoomId(DEFAULT_ROOMS[0].id)
        setShowOnboarding(true)
        setOnboardingStep(1)
        return
      }
      const rms = JSON.parse(JSON.stringify(DEFAULT_ROOMS))
      const its = SAMPLE_ITEMS.map(s => ({
        id: crypto.randomUUID(), name: s.name, location: s.location, category: s.category,
        roomId: s.roomId, createdAt: formatDate(new Date()), lastConfirmed: new Date(Date.now() - Math.random() * 86400000).toISOString(),
        zoneX: s.zoneX, zoneY: s.zoneY,
      }))
      setRooms(rms); setItems(its); setCurrentRoomId(rms[0].id)
      return
    }
    try {
      const data = JSON.parse(raw)
      setRooms(data.rooms?.length ? data.rooms : JSON.parse(JSON.stringify(DEFAULT_ROOMS)))
      setItems((data.items || []).map((i: Item) => ({ ...i, roomId: i.roomId || (DEFAULT_ROOMS[0]?.id ?? 'room_living') })))
      if (data.scannedItems) setScannedItems(data.scannedItems)
      setCurrentRoomId(data.currentRoomId || (DEFAULT_ROOMS[0]?.id ?? 'room_living'))
      setShowOnboarding(false)
    } catch {
      const rms = JSON.parse(JSON.stringify(DEFAULT_ROOMS))
      const its = SAMPLE_ITEMS.map(s => ({
        id: crypto.randomUUID(), name: s.name, location: s.location, category: s.category,
        roomId: s.roomId, createdAt: formatDate(new Date()), lastConfirmed: new Date(Date.now() - Math.random() * 86400000).toISOString(),
        zoneX: s.zoneX, zoneY: s.zoneY,
      }))
      setRooms(rms); setItems(its); setCurrentRoomId(rms[0].id)
    }
  }

  /* ── Auth ── */
  function signUp() {
    const users = getUsers()
    if (users.find(u => u.email === authEmail)) { setAuthError('Email already registered'); return }
    const hp = hashPass(authPassword)
    users.push({ email: authEmail, password: hp })
    saveUsers(users)
    const u: User = { email: authEmail, password: hp }
    setUser(u); userRef.current = u.email
    loadData(u)
    setAuthError(''); setPage('dashboard')
  }

  function signIn() {
    const users = getUsers()
    let u = users.find(us => us.email === authEmail && us.password === hashPass(authPassword))
    // Backward compat: also check plaintext passwords (pre-hash migration)
    if (!u) {
      const legacy = users.find(us => us.email === authEmail && us.password === authPassword)
      if (legacy) {
        legacy.password = hashPass(authPassword) // migrate to hash
        saveUsers(users)
        u = legacy
      }
    }
    if (!u) { setAuthError('Invalid email or password'); return }
    setUser(u); userRef.current = u.email
    loadData(u)
    setAuthError(''); setPage('dashboard')
  }

  function forgotPassword() {
    const email = window.prompt('Enter your account email:', authEmail || '')
    if (email === null || !email.trim()) return
    const users = getUsers()
    const u = users.find(us => us.email === email.trim())
    if (!u) { setAuthError('No account found for that email'); return }
    const newPw = window.prompt('Enter your new password (at least 4 characters):')
    if (newPw === null) return
    if (newPw.length < 4) { setAuthError('Password must be at least 4 characters'); return }
    const confirm = window.prompt('Confirm your new password:')
    if (confirm !== newPw) { setAuthError('Passwords do not match'); return }
    u.password = hashPass(newPw)
    saveUsers(users)
    setAuthError('Password reset! Sign in with your new password.')
    setAuthPassword('')
  }

  function signOut() {
    stopScanCamera()
    setUser(null); setItems([]); setRooms([]); setScannedItems([]); setAuthError(''); setShowOnboarding(false); setPage('auth')
  }

  /* ── Room & Item CRUD ── */
  function switchRoom(id: string) { setCurrentRoomId(id); setSelectedZone(null); setGlowingItemId(null) }

  function addRoom(name: string) {
    const id = `room_${crypto.randomUUID()}`
    setRooms(prev => [...prev, { id, name, zones: [
      { id: 'center', label: 'Center', x: 50, y: 40 },
      { id: 'corner_1', label: 'Corner 1', x: 15, y: 20 },
      { id: 'corner_2', label: 'Corner 2', x: 85, y: 70 },
    ]}])
    setCurrentRoomId(id); setSelectedZone(null)
  }

  function addZone(roomId: string, label: string) {
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, zones: [...r.zones, { id: crypto.randomUUID(), label, x: 50, y: 40 }] } : r))
  }

  function deleteZone(roomId: string, zoneId: string) {
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, zones: r.zones.filter(z => z.id !== zoneId) } : r))
  }

  function assignItemToZone(itemId: string, zoneId: string, roomId?: string) {
    const room = rooms.find(r => r.id === (roomId || currentRoomId))
    const zone = room?.zones.find(z => z.id === zoneId)
    if (!zone) return
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, zoneX: zone.x, zoneY: zone.y, location: zone.label, lastConfirmed: new Date().toISOString() } : i))
  }
  function unassignItem(itemId: string) {
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, zoneX: -50, zoneY: -50, location: 'Unsorted', lastConfirmed: new Date().toISOString() } : i))
  }

  function moveItemToRoom(itemId: string, newRoomId: string) {
    if (!rooms.find(r => r.id === newRoomId)) { console.error('moveItemToRoom: invalid room', newRoomId); return }
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, roomId: newRoomId, zoneX: -50, zoneY: -50, location: 'Unsorted', lastConfirmed: new Date().toISOString() } : i))
  }

  function addItem(name: string, location: string, category: string, zoneX = 50, zoneY = 50, imageKey?: string) {
    setItems(prev => [...prev, {
      id: crypto.randomUUID(), name, location, category, roomId: currentRoomId,
      createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(), zoneX, zoneY, imageKey,
    }])
  }

  function updateItem(id: string, name: string, location: string, category: string, zoneX?: number, zoneY?: number) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, name, location, category, ...(zoneX !== undefined ? { zoneX, zoneY } : {}), lastConfirmed: new Date().toISOString() } : i))
  }

  function deleteItem(id: string) { setItems(prev => prev.filter(i => i.id !== id)) }

  /* ── Kiosk-Style Intelligent Search (Fuse + AI Vector) ── */
  function handleSearch(q: string) {
    if (!q) {
      setGlowingItemId(null); setGlowingZoneId(null); setGlowingRoomIds([]); setAiResults([]); setSearchFocused(true); return
    }

    // 1. Fuse fuzzy search — instant local results
    const fuseResults = fuse.search(q)
    const matched = fuseResults.slice(0, 6).map(r => r.item)
    setAiResults(matched.map(i => ({
      itemId: i.id, itemName: i.name, location: i.location, category: i.category,
      roomId: i.roomId, roomName: rooms.find(r => r.id === i.roomId)?.name ?? 'Unknown',
      zone: null, score: 0.5,
    })))

    // Highlight best Fuse match in current room
    const inCurrent = matched.filter(i => i.roomId === currentRoomId)
    const best = inCurrent.length > 0 ? inCurrent[0] : matched[0]
    if (best) {
      setGlowingItemId(best.id)
      highlightZoneForItem(best)
      glowRoomTab(best.roomId)
    } else {
      setGlowingItemId(null)
    }

    if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
    searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null); setGlowingZoneId(null) }, 6000)

    // 2. AI vector search (debounced) — semantic synonyms & typos
    if (semanticTimer.current) clearTimeout(semanticTimer.current)
    semanticTimer.current = setTimeout(async () => {
      if (!q.trim()) return
      setAiThinking(true)
      const results = await aiVectorSearch(q, items, rooms)
      setAiThinking(false)

      if (results.length > 0) {
        setAiResults(results)
        const top = results[0]
        setGlowingItemId(top.itemId)
        if (top.zone) setGlowingZoneId(top.zone.id)
        glowRoomTab(top.roomId)
        if (top.roomId !== currentRoomId) setCurrentRoomId(top.roomId)
        if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
        searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null); setGlowingZoneId(null) }, 6000)
      }
    }, 400)
  }

  function glowRoomTab(roomId: string) {
    setGlowingRoomIds(prev => {
      if (prev.includes(roomId)) return prev
      return [...prev, roomId]
    })
    setTimeout(() => setGlowingRoomIds(prev => prev.filter(r => r !== roomId)), 6000)
  }

  function highlightZoneForItem(item: Item) {
    const rm = rooms.find(r => r.id === item.roomId)
    if (!rm) return
    let bestDist = 25
    let bestZone: string | null = null
    for (const z of rm.zones) {
      const d = Math.sqrt((item.zoneX - z.x) ** 2 + (item.zoneY - z.y) ** 2)
      if (d < bestDist) { bestDist = d; bestZone = z.id }
    }
    setGlowingZoneId(bestZone)
  }

  function selectAiResult(result: SearchResult) {
    setSearchQuery(result.itemName)
    setAiResults([])
    setSearchFocused(false)
    if (result.roomId !== currentRoomId) setCurrentRoomId(result.roomId)
    setGlowingItemId(result.itemId)
    if (result.zone) setGlowingZoneId(result.zone.id)
    glowRoomTab(result.roomId)
    if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
    searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null); setGlowingZoneId(null) }, 5000)
  }

  /* ── Voice Search ── */
  function startVoiceSearch() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { alert('Voice search needs Chrome/Edge.'); return }
    const r = new SR()
    r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 1
    r.onstart = () => setIsListening(true)
    r.onresult = (e: any) => {
      const t = e.results[0][0].transcript; setSearchQuery(t); setIsListening(false); handleSearch(t)
    }
    r.onerror = () => { setIsListening(false); alert('Mic error. Check permissions.') }
    r.onend = () => setIsListening(false)
    recognitionRef.current = r
    r.start()
  }

  /* ── AI Vision Scanner ── */

  function openScanCamera() {
    setScanMode('camera'); setCapturedImage(null); setScanResult(null)
    /* Try rear camera first, fallback to any camera */
    const tryCam = (constraints?: MediaStreamConstraints) =>
      navigator.mediaDevices.getUserMedia(constraints || { video: true, audio: false })
    tryCam({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        scanStreamRef.current = stream
        if (scanVideoRef.current) { scanVideoRef.current.srcObject = stream; scanVideoRef.current.play() }
      })
      .catch(() => {
        /* Fallback: try any camera without facingMode */
        tryCam().then(stream => {
          scanStreamRef.current = stream
          if (scanVideoRef.current) { scanVideoRef.current.srcObject = stream; scanVideoRef.current.play() }
        }).catch(err => {
          setScanMode('idle')
          alert('Camera unavailable: ' + err.message)
        })
      })
  }

  function stopScanCamera() {
    if (scanStreamRef.current) { scanStreamRef.current.getTracks().forEach(t => t.stop()); scanStreamRef.current = null }
  }

  function capturePhoto() {
    const video = scanVideoRef.current
    if (!video || !video.videoWidth) return
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.drawImage(video, 0, 0)
    const dataUrl = c.toDataURL('image/jpeg', 0.85)
    setCapturedImage(dataUrl)
    setScanMode('captured')
    stopScanCamera()
    // Auto-analyze with AI via Cloudflare Worker
    setScanMode('analyzing')
    visionScan(dataUrl, userRef.current, room.name, 'Scanned').then(result => {
      if (result) {
        setScanResult({
          name: result.itemName,
          category: result.suggestedCategory,
          description: result.description,
          confidence: result.confidence,
          features: result.distinctFeatures,
        })
        setScanMode('result')
        // Check if this matches any previously scanned item
        visionMatch(dataUrl, userRef.current).then(match => {
          if (match?.match && match.matchedItem) {
            setScanResult(prev => prev ? {
              ...prev,
              name: `${prev.name} (matches: ${match.matchedItem})`,
              description: `${prev.description} — 🔄 Previously scanned item detected!`,
            } : prev)
          }
        })
      } else {
        setScanResult({ name: '', category: 'Other', description: '⚠️ Scan failed — AI service unavailable. Enter details below', confidence: 'low', features: [] })
        setScanMode('result')
      }
    })
  }

  function saveScannedItem(name: string, category: string) {
    if (!capturedImage) return
    const newItemId = crypto.randomUUID()
    const mainItemId = crypto.randomUUID()
    /* Fire-and-forget R2 upload — never blocks camera close */
    uploadPhoto(capturedImage, userRef.current, name || 'Unknown Item', category, 'Scanned').then(upload => {
      if (upload) {
        setScannedItems(prev => prev.map(p => p.id === newItemId ? { ...p, imageUrl: `${AI_SCAN_URL}/api/photos/${upload.r2Key}`, imageData: undefined } : p))
        setItems(prev => prev.map(p => p.id === mainItemId ? { ...p, imageKey: upload.r2Key } : p))
      }
    }).catch(() => {})

    const newItem: ScannedItem = {
      id: newItemId, name: name || 'Unknown Item', category, location: 'Unsorted',
      imageData: capturedImage, // base64 fallback until R2 completes
      roomId: currentRoomId, zoneX: -50, zoneY: -50,
      createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(),
      aiDetected: !!scanResult?.name,
    }
    setScannedItems(prev => [newItem, ...prev])
    // Add to main items with known ID (imageKey patched later on R2 completion)
    setItems(prev => [...prev, {
      id: mainItemId, name: name || 'Unknown Item', location: 'Unsorted', category,
      roomId: currentRoomId, createdAt: formatDate(new Date()),
      lastConfirmed: new Date().toISOString(), zoneX: -50, zoneY: -50,
    }])
    setShowConfetti(true); setTimeout(() => setShowConfetti(false), 1500)
    closeScanner()
  }

  function deleteScannedItem(id: string) {
    setScannedItems(prev => prev.filter(s => s.id !== id))
  }

  function addScannedToMain(item: ScannedItem) {
    /* Extract r2Key from imageUrl if present */
    let r2Key: string | undefined
    if (item.imageUrl) {
      const parts = item.imageUrl.split('/api/photos/')
      if (parts.length === 2) r2Key = parts[1]
    }
    addItem(item.name, item.location, item.category, item.zoneX, item.zoneY, r2Key)
    setShowConfetti(true); setTimeout(() => setShowConfetti(false), 1500)
  }

  function assignPhotoToItem(photoId: string, r2Key: string | undefined, imageData: string | undefined, targetItemId: string) {
    if (r2Key) {
      /* Already has R2 key — assign directly */
      setItems(prev => prev.map(i => i.id === targetItemId ? { ...i, imageKey: r2Key } : i))
      setScannedItems(prev => prev.map(s => s.id === photoId ? { ...s, imageUrl: `${AI_SCAN_URL}/api/photos/${r2Key}`, imageData: undefined } : s))
    } else if (imageData) {
      /* Legacy base64 — upload to R2 first, then assign */
      uploadPhoto(imageData, userRef.current, 'Assigned Photo', 'Other', 'Scanned').then(upload => {
        if (upload) {
          setItems(prev => prev.map(i => i.id === targetItemId ? { ...i, imageKey: upload.r2Key } : i))
          setScannedItems(prev => prev.map(s => s.id === photoId ? { ...s, imageUrl: `${AI_SCAN_URL}/api/photos/${upload.r2Key}`, imageData: undefined } : s))
        }
      })
    }
    setAssigningPhoto(null)
  }

  function attachPhotoToItem(itemId: string, r2Key?: string, imageData?: string) {
    if (r2Key) {
      /* Already has R2 key — assign directly */
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, imageKey: r2Key } : i))
    } else if (imageData) {
      /* Legacy base64 — upload to R2 first, then assign */
      uploadPhoto(imageData, userRef.current, 'Assigned Photo', 'Other', 'Scanned').then(upload => {
        if (upload) setItems(prev => prev.map(i => i.id === itemId ? { ...i, imageKey: upload.r2Key } : i))
      })
    }
    setPickForItem(null)
  }

  function removeItemPhoto(itemId: string) {
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, imageKey: undefined } : i))
    setPickForItem(null)
  }

  function closeScanner() {
    stopScanCamera(); setScanMode('idle'); setCapturedImage(null); setScanResult(null); setShowCameraScan(false)
  }

  function retakePhoto() {
    stopScanCamera(); setCapturedImage(null); setScanResult(null); setScanMode('camera')
    openScanCamera()
  }

  async function syncHistory() {
    const scans = await fetchScanHistory(userRef.current)
    if (scans.length === 0) return

    const mapped = await Promise.all(scans.map(async (s: any) => {
      /* Lazy-migrate legacy base64 images to R2 */
      let imageUrl = s.imageUrl as string | undefined
      if (s.image_b64 && !imageUrl) {
        const upload = await uploadPhoto(s.image_b64, userRef.current, s.item_name, s.suggested_category || 'Other', s.location || 'Scanned')
        if (upload) imageUrl = `${AI_SCAN_URL}/api/photos/${upload.r2Key}`
      }
      return {
        id: s.id, name: s.item_name, category: s.suggested_category || 'Other',
        location: s.location || 'Scanned',
        imageUrl,
        imageData: imageUrl ? undefined : (s.image_b64 as string | undefined),
        roomId: currentRoomId, zoneX: 50, zoneY: 50,
        createdAt: s.created_at, lastConfirmed: s.created_at, aiDetected: true,
      } satisfies ScannedItem
    }))

    setScannedItems(prev => {
      const existing = new Set(prev.map(p => p.id))
      const fresh = mapped.filter((m: any) => !existing.has(m.id))
      return [...fresh, ...prev]
    })
  }

  /* ── Chatbot ── */
  function executeAction(action: ChatAction) {
    let item = items.find(i => i.id === action.itemId)
    /* Fallback: match by name when AI can't reliably copy UUIDs */
    if (!item) item = items.find(i => i.name.toLowerCase().trim() === action.itemId.toLowerCase().trim())
    if (!item) {
      console.error('Chat action failed — item not found', { actionId: action.itemId, type: action.type, available: items.map(i => `${i.id}=${i.name}`) })
      return false
    }

    /* Tolerant resolver — AI may emit names, slugs, or combined "Room Zone" strings */
    const norm = (s: string) => s.toLowerCase().trim()
    const findRoom = (ref: string | undefined): Room | null => {
      if (!ref) return null
      const v = norm(ref)
      /* 1. exact id, 2. exact name */
      const exact = [...rooms].sort((a, b) => b.name.length - a.name.length)
        .find(r => r.id === ref || norm(r.name) === v)
      if (exact) return exact
      /* 3. room name contained in the value (e.g. "Living Room Desk" → "Living Room") */
      const contained = [...rooms].sort((a, b) => b.name.length - a.name.length)
        .find(r => v.includes(norm(r.name)))
      if (contained) return contained
      return null
    }
    const findZone = (room: Room | null | undefined, ref: string | undefined): Zone | null => {
      if (!room || !ref) return null
      const v = norm(ref)
      /* 1. exact id, 2. exact label */
      const exact = room.zones.find(z => z.id === ref || norm(z.label) === v)
      if (exact) return exact
      /* 3. label contained in the value */
      return room.zones.find(z => v.includes(norm(z.label))) || null
    }

    const targetRoom = findRoom(action.roomId)
    let targetZone = findZone(targetRoom, action.zoneId)

    switch (action.type) {
      case 'move_room':
        if (!targetRoom) { console.error('Chat action failed — room not found', { roomId: action.roomId, available: rooms.map(r => `${r.id}=${r.name}`) }); return false }
        moveItemToRoom(item.id, targetRoom.id); return true
      case 'assign_zone': {
        /* Zone lives in the current room (or target room if supplied) */
        const zoneRoom = targetRoom || rooms.find(r => r.id === currentRoomId) || null
        const z = findZone(zoneRoom, action.zoneId)
        if (!z) { console.error('Chat action failed — zone not found', { zoneId: action.zoneId, available: zoneRoom?.zones.map(z => `${z.id}=${z.label}`) }); return false }
        assignItemToZone(item.id, z.id, zoneRoom?.id)
        return true
      }
      case 'move_and_assign': {
        if (!targetRoom || !targetZone) { console.error('Chat action failed — move_and_assign missing room or zone', { action, targetRoom: targetRoom?.id, targetZone: targetZone?.id }); return false }
        moveItemToRoom(item.id, targetRoom.id)
        assignItemToZone(item.id, targetZone.id, targetRoom.id)
        return true
      }
      case 'unassign':
        unassignItem(item.id); return true
      default:
        return false
    }
  }

  function handleChatSend(e?: React.FormEvent, preset?: string) {
    e?.preventDefault()
    const msg = (preset ?? chatInput).trim()
    if (!msg || chatLoading) return
    setChatInput('')
    const userMsg = { role: 'user' as const, content: msg, suggestedIds: [] as string[] }
    setChatMessages(prev => [...prev, userMsg])
    setChatLoading(true)
    // Include the new message in history (chatMessages is stale here)
    const history = [...chatMessages.map(m => ({ role: m.role, content: m.content })), { role: 'user' as const, content: msg }]
    sendChat(msg, items, rooms, history)
      .then(res => {
        setChatMessages(prev => [...prev, { role: 'assistant', content: res.reply, reasoning: res.reasoning, suggestedIds: res.suggestedItemIds || [], actions: res.actions || [] }])
        /* If AI suggested items, highlight them */
        if (res.suggestedItemIds?.length > 0) {
          const firstItem = items.find(i => res.suggestedItemIds.includes(i.id))
          if (firstItem) {
            setCurrentRoomId(firstItem.roomId)
            setGlowingItemId(firstItem.id)
            setTimeout(() => setGlowingItemId(null), 5000)
          }
        }
      })
      .catch(() => {
        setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.', suggestedIds: [] }])
      })
      .finally(() => setChatLoading(false))
  }

  /* ── Prompt overlay ── */
  function showInlinePrompt(placeholder: string): Promise<string | null> {
    return new Promise(resolve => {
      setPromptPlaceholder(placeholder); setShowPrompt(true)
      setPromptCallback(() => (v: string | null) => { resolve(v); setShowPrompt(false); setPromptCallback(null) })
    })
  }

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      if (recognitionRef.current) try { recognitionRef.current.abort() } catch {}
      if (semanticTimer.current) clearTimeout(semanticTimer.current)
      if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
    }
  }, [])

  /* ── Render ── */
  if (page === 'auth') {
    return (
      <div className="min-h-screen flex items-center justify-center p-5 bg-gradient-to-br from-[#3b82f6] via-[#2563eb] to-[#60a5fa] relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,rgba(255,255,255,0.12)_0%,transparent_60%),radial-gradient(ellipse_at_80%_50%,rgba(255,255,255,0.08)_0%,transparent_60%)]" />
        <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-10 w-full max-w-md animate-[fadeInUp_0.4s_ease-out]">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-[#3b82f6] to-[#2563eb] bg-clip-text text-transparent mb-1">📍 Item Location Finder</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Never lose track of your important items</p>
          </div>
          <form onSubmit={e => { e.preventDefault(); isSignUp ? signUp() : signIn() }} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Email</label>
              <input type="email" placeholder="you@example.com" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                className="px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100 transition-colors" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Password</label>
              <input type="password" placeholder="Enter password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                className="px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100 transition-colors" required />
            </div>
            {!isSignUp && (
              <div className="flex justify-end -mt-1">
                <button type="button" onClick={() => forgotPassword()} className="text-xs text-blue-500 hover:opacity-80 text-right cursor-pointer">Forgot password?</button>
              </div>
            )}
            {authError && <p role="alert" className="text-red-500 dark:text-red-400 text-sm text-center bg-red-50 dark:bg-red-900/30 py-2 px-3 rounded-md">{authError}</p>}
            <button type="submit" className="w-full py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 cursor-pointer touch-manipulation">
              {isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>
          <p className="text-center mt-5 text-sm text-gray-500 dark:text-gray-400">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button onClick={() => setIsSignUp(!isSignUp)} className="text-blue-500 font-semibold hover:opacity-80 transition-opacity cursor-pointer">{isSignUp ? 'Sign In' : 'Sign Up'}</button>
          </p>
        </div>
      </div>
    )
  }

  if (showOnboarding) {
    if (onboardingStep === 1) {
      return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[rgba(15,23,42,0.95)] text-white p-5 font-sans">
          <div className="flex flex-col items-center text-center max-w-md w-full">
            <h2 className="mb-2 text-2xl">📸 Quick Room Setup</h2>
            <p className="text-slate-400 text-sm mb-5">Point your camera at your space for 3 seconds to find your essentials.</p>
            <div className="relative w-full aspect-[4/3] bg-slate-800 rounded-xl overflow-hidden border-2 border-blue-500">
              <video id="onboarding-video" autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-b from-transparent to-blue-500 animate-[scanMotion_2s_linear_infinite]" />
              <div id="box-passport" className="hidden absolute border-2 border-green-500 bg-green-500/10 rounded px-1.5 py-0.5 text-green-500 text-[10px] font-bold" style={{ top: '45%', left: '15%', width: '25%', height: '20%' }}>Passport</div>
              <div id="box-laptop" className="hidden absolute border-2 border-blue-500 bg-blue-500/10 rounded px-1.5 py-0.5 text-blue-500 text-[10px] font-bold" style={{ top: '25%', left: '45%', width: '45%', height: '45%' }}>Laptop</div>
              <div id="box-keys" className="hidden absolute border-2 border-yellow-500 bg-yellow-500/10 rounded px-1.5 py-0.5 text-yellow-500 text-[10px] font-bold" style={{ top: '75%', left: '35%', width: '15%', height: '12%' }}>Keys</div>
            </div>
            <button id="start-scan-btn" onClick={() => {
              const btn = document.getElementById('start-scan-btn') as HTMLButtonElement
              if (!btn) return; btn.disabled = true; btn.innerText = 'Scanning Room...'
              setTimeout(() => { const el = document.getElementById('box-laptop'); if (el) el.style.display = 'block' }, 800)
              setTimeout(() => { const el = document.getElementById('box-passport'); if (el) el.style.display = 'block' }, 1600)
              setTimeout(() => { const el = document.getElementById('box-keys'); if (el) el.style.display = 'block' }, 2300)
              setTimeout(() => { setOnboardingStep(2) }, 3500)
            }} className="mt-5 bg-blue-500 text-white border-none px-8 py-3 font-bold rounded-lg cursor-pointer transition-colors hover:bg-blue-600 touch-manipulation">Start 3-Sec Scan</button>
          </div>
        </div>
      )
    }
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[rgba(15,23,42,0.95)] text-white p-5 font-sans">
        <div className="flex flex-col items-center text-center max-w-md w-full">
          <h2 className="mb-2 text-2xl">🎉 Essentials Detected!</h2>
          <p className="text-slate-400 text-sm mb-6">We successfully locked down your highest priority items. Secure them now to unlock your dashboard layout.</p>
          <div className="bg-slate-800 rounded-xl w-full p-4 text-left mb-6 border border-slate-700">
            <div className="flex items-center mb-3 text-green-400"><span className="mr-2">✅</span> 🪪 Passport <span className="ml-auto text-xs text-slate-500">Detected</span></div>
            <div className="flex items-center mb-3 text-green-400"><span className="mr-2">✅</span> 💻 Laptop <span className="ml-auto text-xs text-slate-500">Detected</span></div>
              <div className="flex items-center text-green-400"><span className="mr-2">✅</span> 🔑 House Keys <span className="ml-auto text-xs text-slate-500">Detected</span></div>
          </div>
          <button onClick={() => { setShowOnboarding(false); localStorage.setItem('ilf_onboarded', '1'); save() }} className="w-full bg-green-500 hover:bg-green-600 text-white border-none py-3.5 font-bold rounded-lg cursor-pointer text-base transition-colors touch-manipulation">Pin My Top 3 Essentials &amp; Start</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <div className="bg-gray-50 dark:bg-[#0f172a] text-gray-900 dark:text-gray-100 transition-colors min-h-screen" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>
        <div className="max-w-[1200px] mx-auto p-5 max-md:p-3 max-md:pb-20 animate-[fadeIn_0.3s_ease-out]">
          {/* ── Header ── */}
          <header className="mb-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-sky-400 bg-clip-text text-transparent max-md:text-base">📍 Item Location Finder</h1>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 max-md:hidden">{user?.email}</span>
                <button aria-label="Open map" onClick={() => setShowMobileMap(true)} className="md:hidden w-9 h-9 flex items-center justify-center bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors touch-manipulation">🗺️</button>
                <button aria-label="Toggle dark mode" onClick={toggleDark} className="w-9 h-9 flex items-center justify-center bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors touch-manipulation" title="Toggle dark mode">{darkMode ? '☀️' : '🌙'}</button>
                <button onClick={() => { setShowScannedGallery(true); syncHistory() }} className="relative flex items-center gap-1 px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation">
                  🖼️
                  {scannedItems.length > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center">{scannedItems.length}</span>
                  )}
                </button>
                <button onClick={() => { setShowCameraScan(true); openScanCamera() }} className="hidden md:inline-flex px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold cursor-pointer transition-all hover:scale-103 hover:shadow-md active:scale-100 touch-manipulation">📸 Scan Item</button>
                <button onClick={() => { setShowAddModal(true); setEditingItem(null) }} className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-semibold cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 touch-manipulation">+ Add Item</button>
                <button onClick={signOut} className="px-3 py-2 bg-transparent text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors touch-manipulation">Sign Out</button>
              </div>
            </div>

            {/* Stale alerts */}
            {stale.length > 0 && (
              <div className="flex items-start gap-2.5 p-3.5 bg-amber-50 dark:bg-[#451a03] border border-amber-200 dark:border-[#78350f] rounded-xl text-sm text-amber-800 dark:text-amber-200 mb-3 animate-[slideUp_0.3s_ease-out]">
                <span className="text-base mt-0.5">🔔</span>
                <div className="flex-1 flex flex-col gap-2">
                  <span className="font-semibold">{stale.length} item{stale.length > 1 ? 's' : ''} haven't been seen in 3+ days.</span>
                  {stale.filter(i => !dismissAlerts.includes(i.id)).slice(0, 3).map(i => (
                    <div key={i.id} className="flex flex-col gap-1 p-2 bg-white/50 dark:bg-black/20 rounded-md text-xs border-l-3 border-amber-500">
                      <span>{pinIcon(i.name)} <strong>{i.name}</strong> — last seen {timeAgo(i.lastConfirmed)} in {i.location}</span>
                      <div className="flex gap-1.5 mt-0.5">
                        <button onClick={() => { setItems(prev => prev.map(it => it.id === i.id ? { ...it, lastConfirmed: new Date().toISOString() } : it)) }}
                          className="px-2 py-0.5 text-xs font-medium rounded border bg-emerald-500 text-white border-emerald-600 cursor-pointer hover:bg-emerald-600 transition-colors touch-manipulation">✓ Still there</button>
                        <button onClick={() => setDismissAlerts(prev => [...prev, i.id])}
                          className="px-2 py-0.5 text-xs font-medium rounded border border-amber-300 dark:border-amber-700 bg-transparent text-amber-700 dark:text-amber-300 cursor-pointer hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-colors touch-manipulation">✕ Dismiss</button>
                      </div>
                    </div>
                  ))}
                  {stale.length > 3 && <span className="text-xs italic text-amber-600 dark:text-amber-400">+{stale.length - 3} more stale items</span>}
                </div>
                <button onClick={() => {
                  setItems(prev => prev.map(i => ({ ...i, lastConfirmed: new Date().toISOString() })))
                  setDismissAlerts([])
                }} className="ml-auto bg-none border-none text-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 p-1 rounded touch-manipulation">✕</button>
              </div>
            )}

            {/* Search Bar */}
            <div className="relative mb-1" ref={el => { if (el) { /* container ref for dropdown positioning */ } }}>
              <input ref={searchRef} type="text" placeholder={`Search in ${room.name}...`} value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); if (e.target.value) handleSearch(e.target.value); else { setGlowingItemId(null); setGlowingZoneId(null); setGlowingRoomIds([]); setAiResults([]) } }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && searchQuery) {
                    if (e.currentTarget instanceof HTMLElement) e.currentTarget.blur()
                    const fuseRes = fuse.search(searchQuery)
                    if (fuseRes.length > 0) {
                      const item = fuseRes[0].item
                      selectAiResult({
                        itemId: item.id, itemName: item.name, location: item.location, category: item.category,
                        roomId: item.roomId, roomName: rooms.find(r => r.id === item.roomId)?.name ?? '',
                        zone: null, score: 0.5,
                      })
                    }
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const items = document.querySelectorAll<HTMLElement>('[data-search-result]')
                    const idx = Array.from(items).findIndex(el => el === document.activeElement)
                    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)
                    if (items[next]) items[next].focus()
                  }
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                className="w-full px-4 py-3 pr-14 border border-gray-200 dark:border-gray-700 rounded-xl text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-800 dark:text-gray-100 transition-colors" />
              <button aria-label="Voice search" onClick={startVoiceSearch} className={`absolute right-9 top-1/2 -translate-y-1/2 bg-none border-none text-base cursor-pointer text-gray-500 dark:text-gray-400 p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${isListening ? '!text-red-500 animate-pulse bg-red-500/10' : ''} touch-manipulation`}>{isListening ? '🔴' : '🎤'}</button>
              {searchQuery && (
                <button aria-label="Clear search" onClick={() => { setSearchQuery(''); setGlowingItemId(null); setGlowingZoneId(null); setGlowingRoomIds([]); setAiResults([]) }} className="absolute right-2 top-1/2 -translate-y-1/2 bg-none border-none text-base cursor-pointer text-gray-400 p-1 touch-manipulation">✕</button>
              )}

              {/* ── Kiosk-Style Search Results Dropdown ── */}
              {searchFocused && searchQuery && (
                <div aria-live="polite" className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.15)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden animate-[fadeInUp_0.15s_ease-out]">
                  {aiThinking && (
                    <div className="flex items-center gap-2 p-3 text-xs text-blue-500 dark:text-blue-400 border-b border-gray-100 dark:border-gray-700">
                      <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      AI Vector Search thinking...
                    </div>
                  )}
                  {aiResults.length === 0 && !aiThinking ? (
                    <div className="p-3 text-xs text-gray-500 dark:text-gray-400 text-center">
                      {searchQuery.length >= 2 ? 'No matches found. AI searching...' : 'Keep typing...'}
                    </div>
                  ) : (
                    aiResults.map((result, idx) => {
                      const isOther = result.roomId !== currentRoomId
                      const scorePct = Math.round((result.score ?? 0) * 100)
                      return (
                        <button key={result.itemId} data-search-result
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => selectAiResult(result)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all cursor-pointer border-none touch-manipulation ${
                            idx === 0
                              ? 'bg-blue-50/80 dark:bg-blue-900/30 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                          } ${isOther ? 'border-l-3 border-l-amber-400' : ''}`}>
                          <div className="w-9 h-9 rounded-full flex-shrink-0 overflow-hidden bg-gray-100 dark:bg-gray-700">
                            {(() => {
                              const foundItem = items.find(it => it.id === result.itemId)
                              return foundItem?.imageKey ? (
                                <img src={`${AI_SCAN_URL}/api/photos/${foundItem.imageKey}`} alt={foundItem.name}
                                  className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-sm"
                                  style={{ background: `${pinColor(result.category)}20`, color: pinColor(result.category) }}>
                                  {categoryIcon(result.category)}
                                </div>
                              )
                            })()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <strong className="text-sm text-gray-900 dark:text-gray-100">{result.itemName}</strong>
                              {idx === 0 && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 whitespace-nowrap">
                                  {scorePct >= 80 ? '🏆 Best' : 'Best'}
                                </span>
                              )}
                              {result.zone && (
                                <span className="text-[10px] font-mono px-1 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                                  📍 {result.zone.label}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                              <span>📍 {result.location}</span>
                              <span className="text-gray-300 dark:text-gray-600">·</span>
                              <span className="text-blue-500 font-medium">{result.roomName}</span>
                              {isOther && <span className="text-amber-500 font-medium">↺</span>}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            <div className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">{result.category}</div>
                            {scorePct > 0 && (
                              <div className="text-[10px] font-mono text-blue-500 dark:text-blue-400">
                                {scorePct}%
                              </div>
                            )}
                          </div>
                        </button>
                      )
                    })
                  )}
                  {aiResults.length > 0 && (
                    <div className="px-4 py-2 text-[10px] text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 text-center flex items-center justify-center gap-3">
                      <span>{aiResults.length} result{aiResults.length > 1 ? 's' : ''}</span>
                      <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                        AI Vector Search
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Quick chips */}
            {!searchQuery && (
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {QUICK_CHIPS.map(chip => (
                  <button key={chip.query} onClick={() => { setSearchQuery(chip.query); handleSearch(chip.query) }}
                    className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full cursor-pointer text-gray-700 dark:text-gray-300 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-500 hover:-translate-y-0.5 transition-all touch-manipulation">{chip.icon} {chip.label}</button>
                ))}
              </div>
            )}

            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{roomItems.length} item{roomItems.length !== 1 ? 's' : ''} in this room{searchQuery ? ` · ${filtered.length} match${filtered.length !== 1 ? 'es' : ''}` : ''}</p>
          </header>

          {/* ── Room Tabs ── */}
          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 flex-shrink-0 room-tabs max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory max-md:gap-1 max-md:pb-2 max-md:flex-nowrap">
            {rooms.map(r => {
              const hasGlow = glowingRoomIds.includes(r.id) || (glowingItemId && items.find(i => i.id === glowingItemId)?.roomId === r.id && r.id !== currentRoomId)
              return (
                <button key={r.id} onClick={() => switchRoom(r.id)}
                  className={`flex items-center gap-1 px-3.5 py-2 text-xs font-medium whitespace-nowrap rounded-lg border transition-all cursor-pointer flex-shrink-0 max-md:snap-start touch-manipulation ${
                    r.id === currentRoomId
                      ? 'bg-blue-500 text-white border-blue-500'
                      : hasGlow
                        ? 'bg-amber-50 dark:bg-amber-900/30 border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.4),0_0_30px_rgba(251,191,36,0.15)] animate-pulse'
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}>
                  {r.name} <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${r.id === currentRoomId ? 'bg-white/20' : hasGlow ? 'bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>{items.filter(i => i.roomId === r.id).length}</span>
                </button>
              )
            })}
            <button onClick={async () => { const n = await showInlinePrompt('New room name:'); if (n) addRoom(n) }}
              className="flex items-center justify-center w-9 h-9 bg-transparent border border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-lg text-gray-500 dark:text-gray-400 cursor-pointer hover:border-blue-500 hover:text-blue-500 flex-shrink-0 transition-colors max-md:w-8 max-md:h-8 touch-manipulation">+</button>
          </div>

          {/* ── Main Layout ── */}
          <div className="grid grid-cols-[1fr_340px] gap-5 items-start max-md:grid-cols-1">
            {/* Items Panel */}
            <div className="min-w-0 flex flex-col">
              <div className="flex flex-col gap-2.5">
                {filtered.length === 0 ? (
                  <div className="text-center py-12 px-6 bg-white dark:bg-gray-800 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                    {searchQuery ? (
                      <>
                        <div className="text-5xl mb-3">🔍</div>
                        <h2 className="text-lg font-semibold mb-2">No items match your search</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Try a different search term</p>
                      </>
                    ) : (
                      <>
                        <div className="text-5xl mb-3">🏠</div>
                        <h2 className="text-lg font-semibold mb-2">Welcome to your {room.name}</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Start tracking your belongings in 3 simple steps</p>
                        <div className="text-left max-w-xs mx-auto">
                          {[
                            { num: '1', icon: '📸', title: 'Scan your room', desc: 'Point your camera — AI auto-detects items' },
                            { num: '2', icon: '✏️', title: 'Or add items manually', desc: 'Tap "+ Add Item" and type what you stored' },
                            { num: '3', icon: '🔍', title: 'Find in seconds', desc: 'Search any item later — know exactly where it is' },
                          ].map((s, i) => (
                            <div key={i} className="flex gap-3 items-start p-3 mb-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100 dark:border-gray-700 hover:border-blue-200 dark:hover:border-blue-800 transition-colors animate-[fadeInUp_0.4s_ease-out_both]" style={{ animationDelay: `${0.1 + i * 0.1}s` }}>
                              <div className="w-7 h-7 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">{s.num}</div>
                              <div className="flex-1">
                                <strong className="block text-sm mb-0.5">{s.icon} {s.title}</strong>
                                <span className="text-xs text-gray-500 dark:text-gray-400">{s.desc}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  filtered.map(item => {
                    const pct = getConfidencePercent(item.lastConfirmed)
                    const confLabel = pct >= 100 ? 'Verified' : pct >= 86 ? 'Confirmed' : pct >= 50 ? 'Low' : 'Stale'
                    const confColor = pct >= 100 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                      : pct >= 86 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                      : pct >= 50 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400'
                      : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                    return (
                      <div key={item.id}
                        className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 animate-[fadeInUp_0.3s_ease-out_both] ${
                          glowingItemId === item.id ? '!border-blue-500 !shadow-[0_0_0_2px_rgba(59,130,246,0.15)]' : ''
                        }`}>
                        <div className="flex items-center gap-3">
                          {/* Category / Image thumbnail */}
                          <button type="button" aria-label={item.imageKey ? 'Change photo' : 'Add photo'} title={item.imageKey ? 'Change photo' : 'Add photo'}
                            onClick={() => setPickForItem(item)}
                            className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-gray-100 dark:bg-gray-700 cursor-pointer relative group">
                            {item.imageKey ? (
                              <img src={`${AI_SCAN_URL}/api/photos/${item.imageKey}`} alt={item.name}
                                className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-lg"
                                style={{ background: `${pinColor(item.category)}20`, color: pinColor(item.category) }}>
                                {categoryIcon(item.category)}
                              </div>
                            )}
                            <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">📷</span>
                          </button>

                          {/* Main content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 truncate">{item.name}</h3>
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                                style={{ background: `${pinColor(item.category)}18`, color: pinColor(item.category) }}>{item.category}</span>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                              <span>📍 {item.location}</span>
                              <span className="text-gray-300 dark:text-gray-600">·</span>
                              <span>🕒 Last verified: {isValidDate(item.lastConfirmed) ? shortDate(new Date(item.lastConfirmed)) : '—'}</span>
                            </div>
                          </div>

                          {/* Confidence + Actions */}
                          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                            <div className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${confColor}`}>
                              <span>{pct >= 100 ? '🟢' : pct >= 86 ? '🟡' : '🔴'}</span>
                              <span>{timeAgo(item.lastConfirmed)}</span>
                            </div>
                            {pct < 86 && (
                              <button onClick={() => { setGlowingItemId(item.id); if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current); searchPulseTimer.current = setTimeout(() => setGlowingItemId(null), 4000) }}
                                className="text-[10px] text-blue-500 font-medium hover:underline cursor-pointer bg-none border-none touch-manipulation">⟳ Re-scan now</button>
                            )}
                            <div className="flex items-center gap-1">
                              <button aria-label="Show on map" onClick={() => { setGlowingItemId(item.id); if (pulseTimer.current) clearTimeout(pulseTimer.current); pulseTimer.current = setTimeout(() => setGlowingItemId(null), 3000) }}
                                className="w-11 h-11 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-600 text-sm cursor-pointer bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation" title="Show on map">📍</button>
                              <button aria-label="Edit item" onClick={() => { setEditingItem(item); setShowAddModal(true) }}
                                className="w-11 h-11 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-600 text-sm cursor-pointer bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation" title="Edit">✏️</button>
                              <button aria-label="Delete item" onClick={() => { if (confirm('Delete this item?')) deleteItem(item.id) }}
                                className="w-11 h-11 flex items-center justify-center rounded-md border border-red-200 dark:border-red-900 text-sm cursor-pointer bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500 transition-colors touch-manipulation" title="Delete">🗑️</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* Map Panel */}
            <div className="sticky top-5 max-md:hidden">
              <RoomMapPanel room={room} roomItems={roomItems} selectedZone={selectedZone} glowingItemId={glowingItemId} glowingZoneId={glowingZoneId} isEditingMap={isEditingMap} onToggleEdit={() => setIsEditingMap(v => !v)} onZoneMove={(rid, zid, x, y) => setRooms(prev => prev.map(r => r.id === rid ? { ...r, zones: r.zones.map(z => z.id === zid ? { ...z, x, y } : z) } : r))} onSelectZone={setSelectedZone} onPinClick={(id) => setGlowingItemId(glowingItemId === id ? null : id)} onAddFurniture={async (rid) => { const n = await showInlinePrompt('Furniture name (e.g. Nightstand, Pantry):'); if (n && n.trim()) addZone(rid, n.trim()) }} onDeleteZone={deleteZone} onAssignItem={assignItemToZone} onUnassignItem={unassignItem} onMoveToRoom={moveItemToRoom} rooms={rooms} currentRoomId={currentRoomId} />
            </div>
          </div>
        </div>

        {/* Mobile Map Overlay */}
        {showMobileMap && (
          <div className="fixed inset-0 z-[60] bg-white dark:bg-gray-800 flex flex-col animate-[fadeIn_0.2s_ease-out] md:hidden">
            <div className="flex-1 p-4 overflow-auto">
              <RoomMapPanel room={room} roomItems={roomItems} selectedZone={selectedZone} glowingItemId={glowingItemId} glowingZoneId={glowingZoneId} isEditingMap={isEditingMap} onClose={() => setShowMobileMap(false)} onToggleEdit={() => setIsEditingMap(v => !v)} onZoneMove={(rid, zid, x, y) => setRooms(prev => prev.map(r => r.id === rid ? { ...r, zones: r.zones.map(z => z.id === zid ? { ...z, x, y } : z) } : r))} onSelectZone={setSelectedZone} onPinClick={(id) => setGlowingItemId(glowingItemId === id ? null : id)} onAddFurniture={async (rid) => { const n = await showInlinePrompt('Furniture name (e.g. Nightstand, Pantry):'); if (n && n.trim()) addZone(rid, n.trim()) }} onDeleteZone={deleteZone} onAssignItem={assignItemToZone} onUnassignItem={unassignItem} onMoveToRoom={moveItemToRoom} rooms={rooms} currentRoomId={currentRoomId} />
            </div>
          </div>
        )}

        {/* ── AI Vision Scanner Overlay ── */}
        {showCameraScan && (
          <div role="dialog" aria-modal="true" aria-label="AI Item Scanner"
            className="fixed inset-0 z-[9999] bg-[rgba(15,23,42,0.96)] flex items-center justify-center p-4 animate-[fadeIn_0.25s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) closeScanner() }}>
            <div className="flex flex-col items-center text-center max-w-md w-full">

              {/* Header */}
              <div className="flex items-center justify-between w-full mb-3">
                <h2 className="text-slate-100 text-lg">
                  {scanMode === 'camera' ? '📸 Point & Scan' : scanMode === 'analyzing' ? '🤔 AI Analyzing...' : scanMode === 'result' ? '✅ Scan Result' : '📸 Captured'}
                </h2>
                <button aria-label="Close scan" onClick={closeScanner}
                  className="bg-none border-none text-lg cursor-pointer text-slate-400 hover:bg-slate-800 p-1 rounded transition-colors touch-manipulation">✕</button>
              </div>

              {/* ── CAMERA VIEW ── */}
              {scanMode === 'camera' && (
                <>
                  <div className="relative w-full aspect-[4/3] bg-slate-800 rounded-xl overflow-hidden border-2 border-emerald-500">
                    <video ref={scanVideoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]"
                      onLoadedMetadata={e => { const v = e.currentTarget; v.play() }} />
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-b from-transparent to-emerald-500 animate-[scanMotion_2s_linear_infinite]" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-4/5 h-3/5 border-2 border-dashed border-emerald-400/40 rounded-2xl" />
                    </div>
                    <p className="absolute bottom-3 left-0 right-0 text-xs text-slate-400 text-center">Center the item in the frame</p>
                  </div>
                  <button onClick={capturePhoto}
                    className="mt-5 w-16 h-16 rounded-full bg-white border-4 border-emerald-500 flex items-center justify-center cursor-pointer hover:scale-105 transition-transform touch-manipulation">
                    <div className="w-12 h-12 rounded-full bg-emerald-500" />
                  </button>
                  <p className="text-slate-400 text-sm mt-3">Tap to capture</p>
                </>
              )}

              {/* ── CAPTURED / ANALYZING ── */}
              {(scanMode === 'captured' || scanMode === 'analyzing') && capturedImage && (
                <>
                  <div className="relative w-full aspect-[4/3] bg-slate-800 rounded-xl overflow-hidden border-2 border-blue-500">
                    <img src={capturedImage} alt="Captured" className="w-full h-full object-contain" />
                    {scanMode === 'analyzing' && (
                      <div className="absolute inset-0 bg-slate-900/70 flex flex-col items-center justify-center">
                        <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
                        <p className="text-slate-300 text-sm font-medium">AI is identifying your item...</p>
                        <p className="text-slate-500 text-xs mt-1">Analyzing shape, labels, and features</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 mt-4">
                    <button onClick={retakePhoto}
                      className="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm cursor-pointer transition-colors touch-manipulation">⟳ Retake</button>
                  </div>
                </>
              )}

              {/* ── RESULT VIEW ── */}
              {scanMode === 'result' && capturedImage && (
                <div className="flex flex-col gap-4 w-full">
                  <div className="relative w-full aspect-[4/3] bg-slate-800 rounded-xl overflow-hidden border-2 border-emerald-500">
                    <img src={capturedImage} alt="Scanned" className="w-full h-full object-contain" />
                    {scanResult?.name && (
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-slate-900/90 to-transparent p-4 pt-8">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-emerald-400 font-bold text-lg">{scanResult.name}</p>
                          {scanResult.confidence && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                              scanResult.confidence === 'high' ? 'bg-emerald-500/20 text-emerald-400' :
                              scanResult.confidence === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                              'bg-red-500/20 text-red-400'
                            }`}>{scanResult.confidence}</span>
                          )}
                        </div>
                        <p className="text-slate-300 text-xs">{scanResult.description}</p>
                        {scanResult.features && scanResult.features.length > 0 && (
                          <div className="flex gap-1.5 mt-1.5 flex-wrap">
                            {scanResult.features.map((f, i) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700/60 text-slate-300 border border-slate-600">{f}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <form onSubmit={e => {
                    e.preventDefault()
                    const fd = new FormData(e.currentTarget)
                    const name = (fd.get('scan-name') as string) || scanResult?.name || 'Unknown Item'
                    const cat = (fd.get('scan-cat') as string) || scanResult?.category || 'Other'
                    saveScannedItem(name, cat)
                  }} className="flex flex-col gap-3 w-full">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="text-xs text-slate-400 mb-1 block text-left">Item Name</label>
                        <input name="scan-name" defaultValue={scanResult?.name || ''} placeholder="Enter item name"
                          className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg text-slate-100 outline-none focus:border-blue-500" />
                      </div>
                      <div className="w-1/3">
                        <label className="text-xs text-slate-400 mb-1 block text-left">Category</label>
                        <select name="scan-cat" defaultValue={scanResult?.category || 'Other'}
                          className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg text-slate-100 outline-none focus:border-blue-500">
                          {['Documents', 'Keys', 'Electronics', 'Warranties', 'Valuables', 'Other'].map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={retakePhoto}
                        className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm cursor-pointer transition-colors touch-manipulation">⟳ Retake</button>
                      <button type="submit"
                        className="flex-[2] px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold cursor-pointer transition-all touch-manipulation">💾 Save & Add to List</button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Scanned Items Gallery (Categorized) ── */}
        {showScannedGallery && (
          <div role="dialog" aria-modal="true" aria-label="Photo library"
            className="fixed inset-0 z-[9999] bg-[rgba(15,23,42,0.97)] flex flex-col animate-[fadeIn_0.2s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) setShowScannedGallery(false) }}>
            <div className="sticky top-0 z-10 bg-[rgba(15,23,42,0.97)] border-b border-slate-700/50">
              <div className="flex items-center justify-between p-4 max-w-6xl mx-auto w-full">
                <h2 className="text-slate-100 text-lg font-semibold">📸 Photo Library ({photosFromServer ? Object.values(photosFromServer).reduce((sum: number, arr: any[]) => sum + arr.length, 0) + scannedItems.length : scannedItems.length})</h2>
                <div className="flex items-center gap-3">
                  <button onClick={() => syncHistory()}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg cursor-pointer transition-colors touch-manipulation">Sync History</button>
                  <button aria-label="Close gallery" onClick={() => setShowScannedGallery(false)}
                    className="bg-none border-none text-lg cursor-pointer text-slate-400 hover:bg-slate-800 p-1.5 rounded transition-colors touch-manipulation">✕</button>
                </div>
              </div>
            </div>

            {photosLoading && (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm text-slate-400">Loading photos...</p>
              </div>
            )}

            {!photosLoading && (
              <>
                {/* ── Server photos (R2) ── */}
                {photosFromServer && Object.keys(photosFromServer).length > 0 ? (
                  <div className="flex-1 overflow-y-auto max-w-6xl mx-auto w-full p-4 pt-3">
                    {['Documents', 'Keys', 'Electronics', 'Warranties', 'Valuables', 'Other'].map(cat => {
                      const serverGroup = photosFromServer[cat] || []
                      const localGroup = scannedItems.filter(i => i.category === cat && !serverGroup.some((s: any) => s.r2_key && i.imageUrl?.includes(s.r2_key)))
                      const combined = [...serverGroup.map((s: any) => ({
                        id: s.id, name: s.item_name, category: s.category,
                        location: s.room_location, imageUrl: `${AI_SCAN_URL}/api/photos/${s.r2_key}`,
                        imageData: undefined as string | undefined,
                        roomId: currentRoomId, zoneX: 50, zoneY: 50,
                        createdAt: s.created_at, lastConfirmed: s.created_at, aiDetected: true,
                      } satisfies ScannedItem)), ...localGroup]
                      if (combined.length === 0) return null
                      return (
                        <div key={cat} className="mb-6">
                          <div className="flex items-center gap-2 mb-3 sticky top-0 bg-[rgba(15,23,42,0.95)] py-2 z-[1]">
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              cat === 'Documents' ? 'bg-blue-500/20 text-blue-400' :
                              cat === 'Keys' ? 'bg-amber-500/20 text-amber-400' :
                              cat === 'Electronics' ? 'bg-cyan-500/20 text-cyan-400' :
                              cat === 'Warranties' ? 'bg-blue-500/20 text-blue-400' :
                              cat === 'Valuables' ? 'bg-pink-500/20 text-pink-400' :
                              'bg-slate-500/20 text-slate-400'
                            }`}>{cat}</span>
                            <span className="text-slate-500 text-xs">{combined.length}</span>
                            <div className="flex-1 border-t border-slate-700/30" />
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                            {combined.map(item => (
                              <div key={item.id}
                                className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 hover:border-blue-500/60 hover:shadow-[0_0_15px_rgba(59,130,246,0.2)] transition-all group cursor-pointer">
                                <div className="aspect-[4/3] bg-slate-700 relative overflow-hidden">
                                  <img src={item.imageUrl || item.imageData} alt={item.name} className="w-full h-full object-cover" />
                                  {item.aiDetected && (
                                    <span className="absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/80 text-white font-semibold">AI</span>
                                  )}
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/60 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                                    <button onClick={() => addScannedToMain(item)}
                                      className="px-2.5 py-1.5 bg-emerald-500 text-white text-[11px] rounded-lg cursor-pointer hover:bg-emerald-600 transition-colors touch-manipulation font-semibold">+ Add</button>
                                    <button onClick={() => {
                                      const parts = item.imageUrl?.split('/api/photos/')
                                      setAssigningPhoto({ id: item.id, r2Key: parts?.length === 2 ? parts[1] : undefined, imageData: item.imageData })
                                    }}
                                      className="px-2.5 py-1.5 bg-blue-500 text-white text-[11px] rounded-lg cursor-pointer hover:bg-blue-600 transition-colors touch-manipulation font-semibold">🔗 Assign</button>
                                    <button onClick={() => { if (confirm('Delete this scan?')) deleteScannedItem(item.id) }}
                                      className="px-2.5 py-1.5 bg-red-500/80 text-white text-[11px] rounded-lg cursor-pointer hover:bg-red-600 transition-colors touch-manipulation">🗑️</button>
                                  </div>
                                </div>
                                <div className="p-2">
                                  <p className="text-slate-100 text-xs font-semibold truncate">{item.name}</p>
                                  <p className="text-slate-500 text-[10px] mt-0.5">{timeAgo(item.lastConfirmed)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {scannedItems.filter(i => !['Documents','Keys','Electronics','Warranties','Valuables','Other'].includes(i.category)).length > 0 && (
                      <div className="text-center py-6 text-slate-500 text-xs italic">
                        {scannedItems.filter(i => !['Documents','Keys','Electronics','Warranties','Valuables','Other'].includes(i.category)).length} items in uncategorized
                      </div>
                    )}
                  </div>
                ) : scannedItems.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                    <div className="text-6xl mb-4">📸</div>
                    <p className="text-lg font-medium mb-1">No scanned items yet</p>
                    <p className="text-sm">Use the Scan button to take photos of your items</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto max-w-6xl mx-auto w-full p-4 pt-3">
                    {/* Fallback: local-only scanned items */}
                    {['Documents', 'Keys', 'Electronics', 'Warranties', 'Valuables', 'Other'].map(cat => {
                      const group = scannedItems.filter(i => i.category === cat)
                      if (group.length === 0) return null
                      return (
                        <div key={cat} className="mb-6">
                          <div className="flex items-center gap-2 mb-3 sticky top-0 bg-[rgba(15,23,42,0.95)] py-2 z-[1]">
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              cat === 'Documents' ? 'bg-blue-500/20 text-blue-400' :
                              cat === 'Keys' ? 'bg-amber-500/20 text-amber-400' :
                              cat === 'Electronics' ? 'bg-cyan-500/20 text-cyan-400' :
                              cat === 'Warranties' ? 'bg-blue-500/20 text-blue-400' :
                              cat === 'Valuables' ? 'bg-pink-500/20 text-pink-400' :
                              'bg-slate-500/20 text-slate-400'
                            }`}>{cat}</span>
                            <span className="text-slate-500 text-xs">{group.length}</span>
                            <div className="flex-1 border-t border-slate-700/30" />
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                            {group.map(item => (
                              <div key={item.id}
                                className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 hover:border-blue-500/60 hover:shadow-[0_0_15px_rgba(59,130,246,0.2)] transition-all group cursor-pointer">
                                <div className="aspect-[4/3] bg-slate-700 relative overflow-hidden">
                                  <img src={item.imageUrl || item.imageData} alt={item.name} className="w-full h-full object-cover" />
                                  {item.aiDetected && (
                                    <span className="absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/80 text-white font-semibold">AI</span>
                                  )}
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/60 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                                    <button onClick={() => addScannedToMain(item)}
                                      className="px-2.5 py-1.5 bg-emerald-500 text-white text-[11px] rounded-lg cursor-pointer hover:bg-emerald-600 transition-colors touch-manipulation font-semibold">+ Add</button>
                                    <button onClick={() => {
                                      const parts = item.imageUrl?.split('/api/photos/')
                                      setAssigningPhoto({ id: item.id, r2Key: parts?.length === 2 ? parts[1] : undefined, imageData: item.imageData })
                                    }}
                                      className="px-2.5 py-1.5 bg-blue-500 text-white text-[11px] rounded-lg cursor-pointer hover:bg-blue-600 transition-colors touch-manipulation font-semibold">🔗 Assign</button>
                                    <button onClick={() => { if (confirm('Delete this scan?')) deleteScannedItem(item.id) }}
                                      className="px-2.5 py-1.5 bg-red-500/80 text-white text-[11px] rounded-lg cursor-pointer hover:bg-red-600 transition-colors touch-manipulation">🗑️</button>
                                  </div>
                                </div>
                                <div className="p-2">
                                  <p className="text-slate-100 text-xs font-semibold truncate">{item.name}</p>
                                  <p className="text-slate-500 text-[10px] mt-0.5">{timeAgo(item.lastConfirmed)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {scannedItems.filter(i => !['Documents','Keys','Electronics','Warranties','Valuables','Other'].includes(i.category)).length > 0 && (
                      <div className="text-center py-6 text-slate-500 text-xs italic">
                        {scannedItems.filter(i => !['Documents','Keys','Electronics','Warranties','Valuables','Other'].includes(i.category)).length} items in uncategorized
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Assign Photo to Item Picker ── */}
        {assigningPhoto && (
          <div role="dialog" aria-modal="true" aria-label="Assign photo to item"
            className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.15s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) setAssigningPhoto(null) }}>
            <div className="bg-gray-900 rounded-xl shadow-xl p-5 w-full max-w-sm max-h-[70vh] flex flex-col border border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-slate-100 text-sm font-semibold">🔗 Assign photo to item</h3>
                <button onClick={() => setAssigningPhoto(null)}
                  className="bg-none border-none text-slate-400 cursor-pointer hover:text-slate-200 p-1 rounded transition-colors text-lg">✕</button>
              </div>
              <input id="assign-search" type="text" placeholder="Search items..." autoComplete="off"
                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg text-slate-100 outline-none focus:border-blue-500 mb-3"
                onInput={e => (e.currentTarget as HTMLInputElement).focus()} />
              <div className="flex-1 overflow-y-auto space-y-1">
                {items.length === 0 ? (
                  <p className="text-slate-500 text-xs text-center py-6">No items yet. Add items first.</p>
                ) : (
                  items.map(it => (
                    <button key={it.id} onClick={() => assignPhotoToItem(assigningPhoto.id, assigningPhoto.r2Key, assigningPhoto.imageData, it.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-800 hover:bg-blue-900/40 border border-slate-700 hover:border-blue-500/50 rounded-lg text-left transition-all cursor-pointer group">
                      <div className="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden bg-slate-700">
                        {it.imageKey ? (
                          <img src={`${AI_SCAN_URL}/api/photos/${it.imageKey}`} alt={it.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs"
                            style={{ background: `${pinColor(it.category)}20`, color: pinColor(it.category) }}>
                            {categoryIcon(it.category)}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-200 truncate group-hover:text-blue-300 transition-colors">{it.name}</p>
                        <p className="text-xs text-slate-500">{it.location} · {rooms.find(r => r.id === it.roomId)?.name || 'Unknown'}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Add Photo to Item Picker ── */}
        {pickForItem && (
          <div role="dialog" aria-modal="true" aria-label="Add photo to item"
            className="fixed inset-0 z-[10001] bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.15s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) setPickForItem(null) }}>
            <div className="bg-gray-900 rounded-xl shadow-xl p-5 w-full max-w-sm max-h-[70vh] flex flex-col border border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-slate-100 text-sm font-semibold">📷 Add photo to {pickForItem.name}</h3>
                <button onClick={() => setPickForItem(null)}
                  className="bg-none border-none text-slate-400 cursor-pointer hover:text-slate-200 p-1 rounded transition-colors text-lg">✕</button>
              </div>
              {pickForItem.imageKey && (
                <button onClick={() => removeItemPhoto(pickForItem.id)}
                  className="w-full px-3 py-2 mb-3 text-sm bg-transparent border border-red-500/40 text-red-400 hover:bg-red-500/10 rounded-lg transition-all cursor-pointer">🗑️ Remove current photo</button>
              )}
              <input id="pick-photo-search" type="text" placeholder="Search photos..." autoComplete="off"
                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg text-slate-100 outline-none focus:border-blue-500 mb-3"
                value={pickSearch} onInput={e => setPickSearch((e.currentTarget as HTMLInputElement).value)} />
              <div className="flex-1 overflow-y-auto space-y-1">
                {(() => {
                  const q = pickSearch.toLowerCase()
                  const used = new Set<string>()
                  const rows: any[] = []
                  /* a) Local scanned items */
                  scannedItems.filter(s => s.imageUrl || s.imageData).forEach(s => {
                    if (!q || s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.location.toLowerCase().includes(q)) {
                      if (s.imageUrl) used.add(s.imageUrl)
                      rows.push(
                        <div key={`local-${s.id}`} className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-800 hover:bg-blue-900/40 border border-slate-700 hover:border-blue-500/50 rounded-lg text-left transition-all">
                          <img src={s.imageUrl ?? s.imageData} alt={s.name} className="w-8 h-8 rounded-full flex-shrink-0 object-cover bg-slate-700" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-200 truncate">{s.name}</p>
                            <p className="text-xs text-slate-500">{s.category} · {s.location}</p>
                          </div>
                          <button onClick={() => attachPhotoToItem(pickForItem.id, s.imageUrl ? s.imageUrl.split('/api/photos/')[1] : undefined, s.imageData)}
                            className="flex-shrink-0 px-2.5 py-1 text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/40 hover:text-blue-200 rounded-lg transition-all cursor-pointer">Attach</button>
                        </div>
                      )
                    }
                  })
                  /* b) Server photos (dedupe against already-listed URLs) */
                  if (photosFromServer) {
                    Object.values(photosFromServer).flat().forEach((p: any) => {
                      if (!p || !p.r2_key) return
                      if (!q || (p.item_name || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q) || (p.room_location || '').toLowerCase().includes(q)) {
                        const url = `${AI_SCAN_URL}/api/photos/${p.r2_key}`
                        if (used.has(url)) return
                        used.add(url)
                        rows.push(
                          <div key={`server-${p.r2_key}`} className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-800 hover:bg-blue-900/40 border border-slate-700 hover:border-blue-500/50 rounded-lg text-left transition-all">
                            <img src={url} alt={p.item_name || 'Photo'} className="w-8 h-8 rounded-full flex-shrink-0 object-cover bg-slate-700" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-200 truncate">{p.item_name || 'Untitled'}</p>
                              <p className="text-xs text-slate-500">{p.category || 'Other'} · {p.room_location || 'Scanned'}</p>
                            </div>
                            <button onClick={() => attachPhotoToItem(pickForItem.id, p.r2_key, undefined)}
                              className="flex-shrink-0 px-2.5 py-1 text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/40 hover:text-blue-200 rounded-lg transition-all cursor-pointer">Attach</button>
                          </div>
                        )
                      }
                    })
                  }
                  if (rows.length === 0) {
                    return <p className="text-slate-500 text-xs text-center py-6">No photos found.</p>
                  }
                  return rows
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Add/Edit Modal */}
        {showAddModal && (
          <div role="dialog" aria-modal="true" aria-label={editingItem ? 'Edit item' : 'Add new item'}
            className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.2s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) { setShowAddModal(false); setEditingItem(null) } }}>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-7 w-full max-w-md max-h-[90vh] overflow-y-auto animate-[slideUp_0.25s_ease-out]">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold">{editingItem ? 'Edit Item' : 'Add New Item'}</h2>
                <button aria-label="Close modal" onClick={() => { setShowAddModal(false); setEditingItem(null) }}
                  className="bg-none border-none text-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 p-1 rounded transition-colors touch-manipulation">✕</button>
              </div>
              <form onSubmit={e => {
                e.preventDefault()
                const fd = new FormData(e.currentTarget)
                const name = fd.get('name') as string; const location = fd.get('location') as string; const category = fd.get('category') as string
                const roomId = fd.get('roomId') as string
                const pin = document.getElementById('mini-pin')
                const zx = pin && pin.style.left ? parseFloat(pin.style.left) : (editingItem?.zoneX ?? 50)
                const zy = pin && pin.style.top ? parseFloat(pin.style.top) : (editingItem?.zoneY ?? 50)
                if (editingItem) {
                  updateItem(editingItem.id, name, location, category, zx, zy)
                  if (roomId && roomId !== editingItem.roomId) moveItemToRoom(editingItem.id, roomId)
                }
                else addItem(name, location, category, zx, zy)
                setShowAddModal(false); setEditingItem(null)
              }} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Item Name</label>
                  <input name="name" defaultValue={editingItem?.name || ''} placeholder="e.g. Passport, House Keys" required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Location</label>
                  <input name="location" defaultValue={editingItem?.location || ''} placeholder="e.g. Top desk drawer" required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Room</label>
                  <select name="roomId" defaultValue={editingItem?.roomId || currentRoomId}
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100">
                    {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Category</label>
                  <select name="category" defaultValue={editingItem?.category || ''} required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100">
                    <option value="">Select...</option>
                    {['Documents', 'Keys', 'Electronics', 'Warranties', 'Valuables', 'Other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Position on Map — <small className="font-normal text-gray-500">Click on the map to place the pin</small></label>
                  <div id="mini-map" className="relative w-full aspect-[4/3] bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg cursor-crosshair overflow-hidden"
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const x = ((e.clientX - rect.left) / rect.width) * 100; const y = ((e.clientY - rect.top) / rect.height) * 100
                      const pin = document.getElementById('mini-pin')
                      if (pin) { pin.style.left = `${Math.max(0, Math.min(100, x))}%`; pin.style.top = `${Math.max(0, Math.min(100, y))}%` }
                    }}>
                    {room.zones.map(z => (
                      <div key={z.id} className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/30 rounded pointer-events-none"
                        style={{ left: `${z.x}%`, top: `${z.y}%` }}>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{z.label}</span>
                      </div>
                    ))}
                    <div id="mini-pin" className="absolute text-2xl z-5 pointer-events-none" style={{ left: `${editingItem?.zoneX || 50}%`, top: `${editingItem?.zoneY || 50}%`, transform: 'translate(-50%, -100%)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.3))' }}>📍</div>
                  </div>
                </div>
                <button type="submit" className="w-full py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-all cursor-pointer touch-manipulation">
                  {editingItem ? 'Save Changes' : 'Save Item'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Confetti */}
        {showConfetti && (
          <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
            {['#3b82f6','#10b981','#f59e0b','#ef4444','#2563eb','#06b6d4','#ec4899','#84cc16'].map((c, i) => (
              <div key={i} className="absolute -top-2.5 w-2 h-2 rounded-sm animate-[confetti-fall_1.2s_ease-in_forwards]"
                style={{ left: `${10 + i * 10}%`, background: c, animationDelay: `${i * 0.05}s` }} />
            ))}
          </div>
        )}

        {/* Mobile Bottom Bar */}
        <div className="hidden max-md:flex items-center gap-2 fixed bottom-0 left-0 right-0 z-50 p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl">
          <button onClick={() => { setShowCameraScan(true); openScanCamera() }}
            className="flex-1 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white border-none rounded-xl text-base font-semibold cursor-pointer transition-all shadow-[0_4px_12px_rgba(16,185,129,0.3)] active:scale-97 touch-manipulation">📸 Scan Item</button>
          <button onClick={startVoiceSearch}
            className={`w-12 h-12 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-xl cursor-pointer flex items-center justify-center transition-colors text-gray-500 dark:text-gray-400 hover:border-gray-400 ${isListening ? '!text-red-500 animate-pulse !border-red-500' : ''} touch-manipulation`}>{isListening ? '🔴' : '🎤'}</button>
        </div>

        {/* Inline Prompt */}
        {showPrompt && (
          <div role="dialog" aria-modal="true" aria-label="Prompt"
            className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.15s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget && promptCallback) { promptCallback(null); setShowPrompt(false); setPromptCallback(null) } }}>
            <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-lg animate-[slideUp_0.2s_ease-out]">
              <h3 className="text-base font-semibold mb-4">{promptPlaceholder}</h3>
              <input id="inline-prompt-input" type="text" placeholder="Enter name..." autoComplete="off"
                className="w-full px-3.5 py-3 text-sm border border-gray-200 dark:border-gray-600 rounded-lg outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-white dark:bg-gray-700 dark:text-gray-100 mb-4"
                onKeyDown={e => { if (e.key === 'Enter' && promptCallback) { const v = (e.target as HTMLInputElement).value.trim(); promptCallback(v || null); setShowPrompt(false); setPromptCallback(null) } }} />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { if (promptCallback) { promptCallback(null); setShowPrompt(false); setPromptCallback(null) } }}
                  className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-gray-600 rounded-lg cursor-pointer bg-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation">Cancel</button>
                <button onClick={() => { const v = (document.getElementById('inline-prompt-input') as HTMLInputElement)?.value?.trim() || null; if (promptCallback) { promptCallback(v); setShowPrompt(false); setPromptCallback(null) } }}
                  className="px-4 py-2 text-sm font-medium border-none rounded-lg cursor-pointer bg-blue-500 text-white hover:bg-blue-600 transition-colors touch-manipulation">OK</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Chatbot Sidebar ── */}
        {/* Floating toggle button (visible when chat is closed) */}
        {!showChat && (
          <button onClick={() => { setShowChat(true); setTimeout(() => chatInputRef.current?.focus(), 300) }}
            className="fixed right-4 bottom-20 z-[9999] w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white border-none cursor-pointer shadow-[0_4px_20px_rgba(59,130,246,0.5)] hover:shadow-[0_6px_28px_rgba(59,130,246,0.7)] hover:scale-105 active:scale-95 transition-all flex items-center justify-center touch-manipulation animate-[fadeIn_0.3s_ease-out]"
            aria-label="Open AI chat assistant">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-white dark:border-[#0f172a] animate-pulse" />
          </button>
        )}

        {/* Slide-in Panel */}
        {showChat && (
          <div className="fixed inset-0 z-[9999] pointer-events-none flex justify-end">
            {/* Overlay backdrop */}
            <div className="absolute inset-0 bg-black/40 pointer-events-auto" onClick={() => setShowChat(false)} />

            {/* Chat Panel */}
            <div className="relative w-full max-w-[400px] h-full pointer-events-auto bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-[-8px_0_30px_rgba(0,0,0,0.2)] flex flex-col animate-[slideRight_0.3s_cubic-bezier(0.4,0,0.2,1)]">
              {/* Header */}
              <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold">Find My Item</h3>
                    <p className="text-[10px] text-white/70">AI assistant</p>
                  </div>
                </div>
                <button onClick={() => setShowChat(false)} aria-label="Close chat"
                  className="bg-white/10 hover:bg-white/20 border-none text-white w-8 h-8 rounded-lg cursor-pointer flex items-center justify-center text-lg transition-colors touch-manipulation">✕</button>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-gray-50 dark:bg-gray-950">
                {chatMessages.length === 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center text-center px-4 gap-3">
                    <div className="w-16 h-16 rounded-2xl bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-blue-500"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    </div>
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Lost something? 🤔</h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[280px]">
                      Ask me where you put anything — I know your inventory! Try "<i>Where are my keys?</i>" or "<i>Show me all documents</i>"
                    </p>
                    <div className="flex flex-col gap-1.5 w-full max-w-[260px] mt-2">
                      {['Where are my keys?', 'Show my passports', 'What electronics do I have?', 'Find recent items'].map(q => (
                        <button key={q} onClick={() => handleChatSend(undefined, q)}
                          className="text-left px-3 py-2 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500 dark:hover:text-blue-300 transition-colors cursor-pointer touch-manipulation">{q}</button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((m, i) => (
                  <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} animate-[fadeIn_0.25s_ease-out]`}>
                    {/* Reasoning block (assistant only) */}
                    {m.role === 'assistant' && m.reasoning && (
                      <details className="max-w-[90%] mb-1 group">
                        <summary className="text-[11px] text-amber-600 dark:text-amber-400 font-medium cursor-pointer select-none flex items-center gap-1.5 opacity-70 hover:opacity-100 transition-opacity">
                          <span className="inline-block w-3.5 h-3.5 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center text-[9px]">💭</span>
                          <span>Reasoned</span>
                          <span className="text-[9px] opacity-50 group-open:rotate-180 transition-transform">▾</span>
                        </summary>
                        <div className="mt-1.5 p-2.5 rounded-lg bg-amber-50/80 dark:bg-amber-500/5 border border-amber-200/60 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-300 leading-relaxed whitespace-pre-wrap italic">
                          {m.reasoning}
                        </div>
                      </details>
                    )}
                    <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-blue-500 text-white rounded-br-md'
                        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-bl-md shadow-sm'
                    }`}>
                      <p className="whitespace-pre-wrap">{m.content}</p>
                      {m.suggestedIds?.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-1">
                          {m.suggestedIds.map(id => {
                            const item = items.find(it => it.id === id)
                            if (!item) return null
                            return (
                              <button key={id} onClick={() => {
                                setCurrentRoomId(item.roomId)
                                setGlowingItemId(item.id)
                                setTimeout(() => setGlowingItemId(null), 5000)
                              }}
                                className="px-2 py-1 text-[11px] rounded-full bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 font-medium border border-blue-200 dark:border-blue-500/30 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-500/30 transition-colors touch-manipulation">
                                📍 {item.name}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {m.actions?.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-1.5">
                          {m.actions.map((action, ai) => {
                            const key = `${i}_${ai}`
                            if (doneActions.includes(key)) return <span key={key} className="px-2.5 py-1.5 text-[11px] rounded-lg font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/30">✅ {action.label}</span>
                            if (failedActions.includes(key)) return <span key={key} className="px-2.5 py-1.5 text-[11px] rounded-lg font-medium bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-500/30">❌ {action.label}</span>
                            return <button key={key} onClick={() => {
                              const ok = executeAction(action)
                              if (ok) setDoneActions(prev => [...prev, key])
                              else { setFailedActions(prev => [...prev, key]); setTimeout(() => setFailedActions(prev => prev.filter(k => k !== key)), 2500) }
                            }}
                              className="px-2.5 py-1.5 text-[11px] rounded-lg font-medium border cursor-pointer transition-all touch-manipulation bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/20">
                              ⚡ {action.label}
                            </button>
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex flex-col items-start gap-1.5 animate-[fadeIn_0.2s_ease-out]">
                    {/* Thinking reasoning animation */}
                    <div className="max-w-[90%] rounded-lg bg-gradient-to-r from-amber-50/80 to-blue-50/80 dark:from-amber-500/5 dark:to-blue-500/5 border border-amber-200/40 dark:border-amber-500/20 p-3 animate-pulse">
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="flex gap-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-bounce" style={{ animationDelay: '200ms' }} />
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-bounce" style={{ animationDelay: '400ms' }} />
                        </div>
                        <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">AI is thinking...</span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="h-2 bg-amber-200/50 dark:bg-amber-400/10 rounded w-full animate-pulse" />
                        <div className="h-2 bg-amber-200/50 dark:bg-amber-400/10 rounded w-3/4 animate-pulse" style={{ animationDelay: '100ms' }} />
                        <div className="h-2 bg-amber-200/50 dark:bg-amber-400/10 rounded w-1/2 animate-pulse" style={{ animationDelay: '200ms' }} />
                      </div>
                    </div>
                    {/* Bouncing dots bubble */}
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-bl-md shadow-sm px-4 py-3 flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <form onSubmit={handleChatSend} className="shrink-0 p-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="flex items-center gap-2">
                  <input ref={chatInputRef} type="text" value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder={chatLoading ? 'Thinking...' : 'Ask about your items...'}
                    disabled={chatLoading}
                    className="flex-1 px-4 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-2xl outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/40 bg-gray-50 dark:bg-gray-800 dark:text-gray-100 transition-colors disabled:opacity-50" />
                  <button type="submit" disabled={chatLoading || !chatInput.trim()}
                    className="w-10 h-10 rounded-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 border-none cursor-pointer flex items-center justify-center transition-colors touch-manipulation disabled:cursor-not-allowed shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-4 h-4"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
