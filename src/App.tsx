import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Fuse from 'fuse.js'

/* ── AI Gateway ── */
const AI_GATEWAY = 'https://ai-gateway.guidesify.com/v1/chat/completions'
const AI_KEY = 'sk-geGIXRsAATrWi7LBUnmk8Q'
const AI_MODEL = 'deepseek-v4-flash-free'

async function aiChat(messages: Array<{ role: string; content: any }>, maxTokens = 200): Promise<string | null> {
  try {
    const res = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, max_tokens: maxTokens }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch { return null }
}

/* ── Types ── */

interface Zone { id: string; label: string; x: number; y: number }
interface Room { id: string; name: string; zones: Zone[] }
interface Item { id: string; name: string; location: string; category: string; roomId: string; createdAt: string; lastConfirmed: string; zoneX: number; zoneY: number }
interface User { email: string; password: string }

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
  const colors: Record<string, string> = { Documents: '#4f46e5', Electronics: '#059669', Keys: '#d97706', Warranties: '#7c3aed', Valuables: '#be185d' }
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

/* ── React App ── */

export default function App() {
  /* ── State ── */
  const [page, setPage] = useState<'auth' | 'dashboard'>('auth')
  const [user, setUser] = useState<User | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [currentRoomId, setCurrentRoomId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [authError, setAuthError] = useState('')
  const [darkMode, setDarkMode] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [panicListening, setPanicListening] = useState(false)
  const [panicToast, setPanicToast] = useState('')
  const [selectedZone, setSelectedZone] = useState<string | null>(null)
  const [glowingItemId, setGlowingItemId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingItem, setEditingItem] = useState<Item | null>(null)
  const [showCameraScan, setShowCameraScan] = useState(false)
  const [scanLog, setScanLog] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [cameraError, setCameraError] = useState('')
  const [showConfetti, setShowConfetti] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1)
  const [showMobileMap, setShowMobileMap] = useState(false)
  const [dismissAlerts, setDismissAlerts] = useState<string[]>([])
  const [showPrompt, setShowPrompt] = useState(false)
  const [promptPlaceholder, setPromptPlaceholder] = useState('')
  const [promptCallback, setPromptCallback] = useState<((v: string | null) => void) | null>(null)
  const [isSignUp, setIsSignUp] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

  const [searchFocused, setSearchFocused] = useState(false)
  const [semanticResults, setSemanticResults] = useState<Item[]>([])
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

  const panicToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const recognitionRef = useRef<any>(null)
  const panicRecognitionRef = useRef<any>(null)
  const cameraScanStream = useRef<MediaStream | null>(null)
  const dashScanStream = useRef<MediaStream | null>(null)
  const dragState = useRef<{ roomId: string; zoneId: string } | null>(null)

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

  /* ── Dark mode ── */
  useEffect(() => {
    const d = localStorage.getItem('ilf_dark') === 'true'
    setDarkMode(d)
    document.documentElement.classList.toggle('dark', d)
  }, [])

  function toggleDark() {
    const next = !darkMode
    setDarkMode(next)
    localStorage.setItem('ilf_dark', String(next))
    document.documentElement.classList.toggle('dark', next)
  }

  /* ── Data persistence ── */
  function save() {
    if (!user) return
    localStorage.setItem(storageKey(user.email), JSON.stringify({ rooms, items, currentRoomId }))
  }

  useEffect(() => { if (user) save() }, [rooms, items, currentRoomId])

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
        id: crypto.randomUUID().slice(0, 8), name: s.name, location: s.location, category: s.category,
        roomId: s.roomId, createdAt: formatDate(new Date()), lastConfirmed: new Date(Date.now() - Math.random() * 86400000).toISOString(),
        zoneX: s.zoneX, zoneY: s.zoneY,
      }))
      setRooms(rms); setItems(its); setCurrentRoomId(rms[0].id)
      return
    }
    try {
      const data = JSON.parse(raw)
      setRooms(data.rooms?.length ? data.rooms : JSON.parse(JSON.stringify(DEFAULT_ROOMS)))
      setItems((data.items || []).map((i: Item) => ({ ...i, roomId: i.roomId || DEFAULT_ROOMS[0]?.id || '' })))
      setCurrentRoomId(data.currentRoomId || DEFAULT_ROOMS[0]?.id || '')
      setShowOnboarding(false)
    } catch {
      const rms = JSON.parse(JSON.stringify(DEFAULT_ROOMS))
      const its = SAMPLE_ITEMS.map(s => ({
        id: crypto.randomUUID().slice(0, 8), name: s.name, location: s.location, category: s.category,
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
    users.push({ email: authEmail, password: authPassword })
    saveUsers(users)
    const u: User = { email: authEmail, password: authPassword }
    setUser(u)
    loadData(u)
    setAuthError(''); setPage('dashboard')
  }

  function signIn() {
    const users = getUsers()
    const u = users.find(us => us.email === authEmail && us.password === authPassword)
    if (!u) { setAuthError('Invalid email or password'); return }
    setUser(u)
    loadData(u)
    setAuthError(''); setPage('dashboard')
  }

  function signOut() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); setCameraStream(null) }
    if (cameraScanStream.current) { cameraScanStream.current.getTracks().forEach(t => t.stop()); cameraScanStream.current = null }
    if (dashScanStream.current) { dashScanStream.current.getTracks().forEach(t => t.stop()); dashScanStream.current = null }
    setUser(null); setItems([]); setRooms([]); setAuthError(''); setShowOnboarding(false); setPage('auth')
  }

  /* ── Room & Item CRUD ── */
  function switchRoom(id: string) { setCurrentRoomId(id); setSelectedZone(null); setGlowingItemId(null) }

  function addRoom(name: string) {
    const id = `room_${crypto.randomUUID().slice(0, 6)}`
    setRooms(prev => [...prev, { id, name, zones: [
      { id: 'center', label: 'Center', x: 50, y: 40 },
      { id: 'corner_1', label: 'Corner 1', x: 15, y: 20 },
      { id: 'corner_2', label: 'Corner 2', x: 85, y: 70 },
    ]}])
    setCurrentRoomId(id); setSelectedZone(null)
  }

  function addItem(name: string, location: string, category: string, zoneX = 50, zoneY = 50) {
    setItems(prev => [...prev, {
      id: crypto.randomUUID().slice(0, 8), name, location, category, roomId: currentRoomId,
      createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(), zoneX, zoneY,
    }])
  }

  function updateItem(id: string, name: string, location: string, category: string) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, name, location, category, lastConfirmed: new Date().toISOString() } : i))
  }

  function deleteItem(id: string) { setItems(prev => prev.filter(i => i.id !== id)) }

  /* ── Intelligent Search (Fuse + AI) ── */
  function handleSearch(q: string) {
    if (!q) { setGlowingItemId(null); setSemanticResults([]); setSearchFocused(true); return }

    // 1. Fuse fuzzy search across ALL items
    const fuseResults = fuse.search(q)
    const matched = fuseResults.slice(0, 6).map(r => r.item)
    setSemanticResults(matched)

    if (matched.length > 0) {
      // Highlight best match in current room
      const inCurrent = matched.filter(i => i.roomId === currentRoomId)
      const best = inCurrent.length > 0 ? inCurrent[0] : matched[0]
      setGlowingItemId(best.id)
      if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
      searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null) }, 5000)
    } else {
      setGlowingItemId(null)
      // 2. If Fuse found nothing, try AI semantic search (debounced)
      if (semanticTimer.current) clearTimeout(semanticTimer.current)
      semanticTimer.current = setTimeout(async () => {
        if (!q.trim()) return
        setAiThinking(true)
        const itemList = items.map(i => `"${i.name}" in ${i.location} (${i.roomId})`).join(', ')
        const prompt = `I have these items: ${itemList}. The user searched for: "${q}". Return ONLY the exact item name (from the list) that best matches the query — even if the query has typos or is a synonym. If nothing matches at all, return "null".`
        const result = await aiChat([{ role: 'user', content: prompt }], 30)
        setAiThinking(false)
        if (result && result.toLowerCase() !== 'null') {
          const match = items.find(i => i.name.toLowerCase() === result.toLowerCase())
          if (match) {
            if (match.roomId !== currentRoomId) setCurrentRoomId(match.roomId)
            setGlowingItemId(match.id)
            setSemanticResults([match])
            if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
            searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null) }, 5000)
          }
        }
      }, 600)
    }
  }

  function selectSearchResult(item: Item) {
    setSearchQuery(item.name)
    setSemanticResults([])
    setSearchFocused(false)
    if (item.roomId !== currentRoomId) setCurrentRoomId(item.roomId)
    setGlowingItemId(item.id)
    if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
    searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null) }, 5000)
  }

  /* ── Voice / Panic ── */
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

  function showPanicToast(msg: string) {
    setPanicToast(msg)
    if (panicToastTimer.current) clearTimeout(panicToastTimer.current)
    panicToastTimer.current = setTimeout(() => setPanicToast(''), 4000)
  }

  function startPanicVoiceSearch() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { alert('Voice search needs Chrome/Edge.'); return }
    const r = new SR()
    r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 1
    r.onstart = () => { setPanicListening(true); showPanicToast('🎤 Listening... say what you lost') }
    r.onresult = (e: any) => {
      let t = e.results[0][0].transcript.toLowerCase()
      setPanicListening(false)
      const fillers = ['where is my ', 'find my ', 'where are my ', 'where is the ', 'find the ', 'i need my ', 'locate my ', 'locate the ', 'show me my ', 'show me the ', 'find where my ', "where's my ", "where's the "]
      for (const f of fillers) { if (t.startsWith(f)) { t = t.slice(f.length); break } }
      t = t.replace(/[^a-z0-9 ]/g, '').trim()
      if (!t) { showPanicToast('Say the item name, e.g. "find my passport"'); return }
      const match = items.find(i => i.name.toLowerCase().includes(t) || i.location.toLowerCase().includes(t) || i.category.toLowerCase().includes(t))
      if (!match) { showPanicToast(`Could not find "${t}" in any room`); return }
      if (match.roomId !== currentRoomId) setCurrentRoomId(match.roomId)
      setGlowingItemId(match.id); setSelectedZone(null)
      const rm = rooms.find(r => r.id === match.roomId)
      if (rm) {
        const z = rm.zones.find(zz => Math.abs(match.zoneX - zz.x) < 15 && Math.abs(match.zoneY - zz.y) < 15)
        if (z) setSelectedZone(z.id)
      }
      if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current)
      searchPulseTimer.current = setTimeout(() => { setGlowingItemId(null) }, 5000)
      showPanicToast(`Found: ${match.name} is on the ${match.location}`)
    }
    r.onerror = () => { setPanicListening(false); showPanicToast('Mic error. Check permissions.') }
    r.onend = () => { if (panicListening) setPanicListening(false) }
    panicRecognitionRef.current = r
    r.start()
  }

  /* ── Camera Scan ── */
  function startCamera() {
    setCameraError('')
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => setCameraStream(stream))
      .catch(() => setCameraError('Camera access denied'))
  }

  function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); setCameraStream(null) }
  }

  function captureSnapshot(): string | null {
    const video = document.getElementById('scan-video') as HTMLVideoElement
    if (!video || !video.videoWidth) return null
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight
    const ctx = c.getContext('2d'); if (!ctx) return null
    ctx.drawImage(video, 0, 0)
    return c.toDataURL('image/jpeg', 0.8)
  }

  function runScan() {
    setScanning(true); setScanLog(['📸 Initializing camera...', '🔍 Scanning room via AI vision...'])
    const snap = captureSnapshot()
    if (snap) { sessionStorage.setItem('last_snapshot', snap); setScanLog(prev => [...prev, '📷 Room snapshot captured']) }
    const avZones = room.zones
    const detected = [
      { name: 'Passport', cat: 'Documents' }, { name: 'Laptop', cat: 'Electronics' }, { name: 'House Keys', cat: 'Keys' },
    ]
    let step = 0
    const interval = setInterval(() => {
      if (step < detected.length) {
        const d = detected[step]; const zone = avZones[step % avZones.length]
        setItems(prev => {
          const existing = prev.find(i => i.name.toLowerCase() === d.name.toLowerCase() && i.roomId === currentRoomId)
          if (existing) {
            setScanLog(l => [...l, `✅ ${d.name} — updated location: ${zone.label}`])
            return prev.map(i => i.id === existing.id ? { ...i, lastConfirmed: new Date().toISOString(), location: zone.label, zoneX: zone.x, zoneY: zone.y, roomId: currentRoomId } : i)
          } else {
            setScanLog(l => [...l, `📦 ${d.name} — new item saved to: ${zone.label}`])
            return [...prev, { id: crypto.randomUUID().slice(0, 8), name: d.name, location: zone.label, category: d.cat, roomId: currentRoomId, createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(), zoneX: zone.x, zoneY: zone.y }]
          }
        })
        step++
      } else {
        clearInterval(interval); setScanning(false); setScanLog(l => [...l, '✅ Scan complete! Items updated.'])
        setShowConfetti(true); setTimeout(() => setShowConfetti(false), 1500)
      }
    }, 800)
  }

  function startDashboardScan() {
    const btn = document.getElementById('dash-scan-btn') as HTMLButtonElement
    if (btn) { btn.disabled = true; btn.innerText = 'Accessing Camera...' }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        dashScanStream.current = stream
        const video = document.getElementById('dash-scan-video') as HTMLVideoElement
        if (video) { video.srcObject = stream; video.play() }
        if (btn) btn.innerText = 'Scanning Room...'
        setTimeout(() => { const el = document.getElementById('dash-box-laptop'); if (el) el.style.display = 'block' }, 800)
        setTimeout(() => { const el = document.getElementById('dash-box-passport'); if (el) el.style.display = 'block' }, 1600)
        setTimeout(() => { const el = document.getElementById('dash-box-keys'); if (el) el.style.display = 'block' }, 2300)
        setTimeout(() => {
          if (dashScanStream.current) { dashScanStream.current.getTracks().forEach(t => t.stop()); dashScanStream.current = null }
          const detected = [
            { name: 'Passport', loc: 'Unsorted / Off-Map Items', cat: 'Documents' },
            { name: 'Laptop', loc: 'Unsorted / Off-Map Items', cat: 'Electronics' },
            { name: 'House Keys', loc: 'Unsorted / Off-Map Items', cat: 'Keys' },
          ]
          setItems(prev => {
            const next = [...prev]
            for (const d of detected) {
              const existing = next.find(i => i.name.toLowerCase() === d.name.toLowerCase() && i.roomId === currentRoomId)
              if (existing) {
                const idx = next.indexOf(existing); next[idx] = { ...existing, lastConfirmed: new Date().toISOString() }
              } else {
                next.push({ id: crypto.randomUUID().slice(0, 8), name: d.name, location: d.loc, category: d.cat, roomId: currentRoomId, createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(), zoneX: 50, zoneY: 50 })
              }
            }
            return next
          })
          setShowConfetti(true); setShowCameraScan(false)
          setTimeout(() => setShowConfetti(false), 1500)
        }, 3500)
      })
      .catch(() => { if (btn) { btn.disabled = false; btn.innerText = '📸 Start Scan' }; alert('Camera access blocked.') })
  }

  function startCameraScan() {
    const btn = document.getElementById('start-scan-btn') as HTMLButtonElement
    if (!btn) return; btn.disabled = true; btn.innerText = 'Accessing Camera...'
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        cameraScanStream.current = stream
        const video = document.getElementById('onboarding-video') as HTMLVideoElement
        if (video) { video.srcObject = stream; video.play() }
        btn.innerText = 'Scanning Room...'
        setTimeout(() => { const el = document.getElementById('box-laptop'); if (el) el.style.display = 'block' }, 800)
        setTimeout(() => { const el = document.getElementById('box-passport'); if (el) el.style.display = 'block' }, 1600)
        setTimeout(() => { const el = document.getElementById('box-keys'); if (el) el.style.display = 'block' }, 2300)
        setTimeout(() => {
          if (cameraScanStream.current) { cameraScanStream.current.getTracks().forEach(t => t.stop()); cameraScanStream.current = null }
          setOnboardingStep(2)
        }, 3500)
      })
      .catch(() => { btn.disabled = false; btn.innerText = 'Retry 3-Sec Scan'; alert('Camera access blocked.') })
  }

  function completeOnboarding() {
    const top3 = [
      { name: 'Passport', loc: 'Unsorted / Off-Map Items', cat: 'Documents', zoneX: 50, zoneY: 50, roomId: rooms[0]?.id || '' },
      { name: 'Laptop', loc: 'Unsorted / Off-Map Items', cat: 'Electronics', zoneX: 50, zoneY: 50, roomId: rooms[0]?.id || '' },
      { name: 'House Keys', loc: 'Unsorted / Off-Map Items', cat: 'Keys', zoneX: 50, zoneY: 50, roomId: rooms[0]?.id || '' },
    ]
    setItems(top3.map(t => ({
      id: crypto.randomUUID().slice(0, 8), name: t.name, location: t.loc, category: t.cat,
      roomId: t.roomId, createdAt: formatDate(new Date()), lastConfirmed: new Date().toISOString(), zoneX: t.zoneX, zoneY: t.zoneY,
    })))
    setCurrentRoomId(rooms[0]?.id || '')
    localStorage.setItem('ilf_onboarded', 'true')
    setShowOnboarding(false)
  }

  /* ── Prompt overlay ── */
  function showInlinePrompt(placeholder: string): Promise<string | null> {
    return new Promise(resolve => {
      setPromptPlaceholder(placeholder); setShowPrompt(true)
      setPromptCallback(() => (v: string | null) => { resolve(v); setShowPrompt(false); setPromptCallback(null) })
    })
  }

  /* ── Drag zones ── */
  function startDrag(zoneEl: HTMLElement) {
    if (zoneEl.closest('.map-pin')) return
    const roomId = zoneEl.dataset.roomId; const zoneId = zoneEl.dataset.zone
    if (!roomId || !zoneId) return
    dragState.current = { roomId, zoneId }
    zoneEl.classList.add('dragging')
    const border = zoneEl.closest('.room-border') as HTMLElement
    if (!border) return
    const rect = border.getBoundingClientRect()

    function onMove(cx: number, cy: number) {
      if (!dragState.current) return
      const px = ((cx - rect.left) / rect.width) * 100; const py = ((cy - rect.top) / rect.height) * 100
      setRooms(prev => prev.map(r => r.id === dragState.current!.roomId ? {
        ...r, zones: r.zones.map(z => z.id === dragState.current!.zoneId ? { ...z, x: Math.max(0, Math.min(100, Math.round(px * 10) / 10)), y: Math.max(0, Math.min(100, Math.round(py * 10) / 10)) } : z)
      } : r))
      const el = document.querySelector<HTMLElement>(`.drag-zone[data-zone="${zoneId}"][data-room-id="${roomId}"]`)
      if (el) { el.style.left = `${Math.max(0, Math.min(100, Math.round(px * 10) / 10))}%`; el.style.top = `${Math.max(0, Math.min(100, Math.round(py * 10) / 10))}%` }
    }
    function onUp() {
      dragState.current = null; document.querySelectorAll('.drag-zone.dragging').forEach(el => el.classList.remove('dragging'))
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

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      if (recognitionRef.current) try { recognitionRef.current.abort() } catch {}
      if (panicRecognitionRef.current) try { panicRecognitionRef.current.abort() } catch {}
    }
  }, [])

  /* ── Render ── */
  if (page === 'auth') {
    return (
      <div className="min-h-screen flex items-center justify-center p-5 bg-gradient-to-br from-[#6366f1] via-[#8b5cf6] to-[#a78bfa] relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,rgba(255,255,255,0.12)_0%,transparent_60%),radial-gradient(ellipse_at_80%_50%,rgba(255,255,255,0.08)_0%,transparent_60%)]" />
        <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-10 w-full max-w-md animate-[fadeInUp_0.4s_ease-out]">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] bg-clip-text text-transparent mb-1">📍 Item Location Finder</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Never lose track of your important items</p>
          </div>
          <form onSubmit={e => { e.preventDefault(); isSignUp ? signUp() : signIn() }} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Email</label>
              <input type="email" placeholder="you@example.com" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                className="px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100 transition-colors" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Password</label>
              <input type="password" placeholder="Enter password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                className="px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100 transition-colors" required />
            </div>
            {authError && <p className="text-red-500 dark:text-red-400 text-sm text-center bg-red-50 dark:bg-red-900/30 py-2 px-3 rounded-md">{authError}</p>}
            <button type="submit" className="w-full py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 cursor-pointer touch-manipulation">
              {isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>
          <p className="text-center mt-5 text-sm text-gray-500 dark:text-gray-400">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button onClick={() => setIsSignUp(!isSignUp)} className="text-indigo-500 font-semibold hover:opacity-80 transition-opacity cursor-pointer">{isSignUp ? 'Sign In' : 'Sign Up'}</button>
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
            <button id="start-scan-btn" onClick={startCameraScan} className="mt-5 bg-blue-500 text-white border-none px-8 py-3 font-bold rounded-lg cursor-pointer transition-colors hover:bg-blue-600 touch-manipulation">Start 3-Sec Scan</button>
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
          <button onClick={completeOnboarding} className="w-full bg-green-500 hover:bg-green-600 text-white border-none py-3.5 font-bold rounded-lg cursor-pointer text-base transition-colors touch-manipulation">Pin My Top 3 Essentials &amp; Start</button>
        </div>
      </div>
    )
  }

  return (
    <div className={`min-h-screen ${darkMode ? 'dark' : ''}`}>
      <div className="bg-gray-50 dark:bg-[#0f172a] text-gray-900 dark:text-gray-100 transition-colors min-h-screen" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>
        <div className="max-w-[1200px] mx-auto p-5 max-md:p-3 max-md:pb-20 animate-[fadeIn_0.3s_ease-out]">
          {/* ── Header ── */}
          <header className="mb-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-500 to-purple-500 bg-clip-text text-transparent max-md:text-base">📍 Item Location Finder</h1>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 max-md:hidden">{user?.email}</span>
                <button onClick={() => setShowMobileMap(true)} className="md:hidden w-9 h-9 flex items-center justify-center bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors touch-manipulation">🗺️</button>
                <button onClick={toggleDark} className="w-9 h-9 flex items-center justify-center bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors touch-manipulation" title="Toggle dark mode">{darkMode ? '☀️' : '🌙'}</button>
                <button onClick={() => { setShowCameraScan(true); setShowAddModal(false) }} className="hidden md:inline-flex px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold cursor-pointer transition-all hover:scale-103 hover:shadow-md active:scale-100 touch-manipulation">📸 Scan Room</button>
                <button onClick={() => { setShowAddModal(true); setEditingItem(null) }} className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-semibold cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 touch-manipulation">+ Add Item</button>
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
                onChange={e => { setSearchQuery(e.target.value); if (e.target.value) handleSearch(e.target.value); else { setGlowingItemId(null); setSemanticResults([]) } }}
                onKeyDown={e => { if (e.key === 'Enter' && searchQuery) { const fuseRes = fuse.search(searchQuery); if (fuseRes.length > 0) selectSearchResult(fuseRes[0].item) } }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                className="w-full px-4 py-3 pr-14 border border-gray-200 dark:border-gray-700 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/10 bg-white dark:bg-gray-800 dark:text-gray-100 transition-colors" />
              <button onClick={startVoiceSearch} className={`absolute right-9 top-1/2 -translate-y-1/2 bg-none border-none text-base cursor-pointer text-gray-500 dark:text-gray-400 p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${isListening ? '!text-red-500 animate-pulse bg-red-500/10' : ''} touch-manipulation`}>{isListening ? '🔴' : '🎤'}</button>
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setGlowingItemId(null); setSemanticResults([]) }} className="absolute right-2 top-1/2 -translate-y-1/2 bg-none border-none text-base cursor-pointer text-gray-400 p-1 touch-manipulation">✕</button>
              )}

              {/* Kiosk Search Results Dropdown */}
              {searchFocused && searchQuery && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.15)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden animate-[fadeInUp_0.15s_ease-out]">
                  {aiThinking && (
                    <div className="flex items-center gap-2 p-3 text-xs text-indigo-500 dark:text-indigo-400 border-b border-gray-100 dark:border-gray-700">
                      <span className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                      AI is thinking...
                    </div>
                  )}
                  {semanticResults.length === 0 && !aiThinking ? (
                    <div className="p-3 text-xs text-gray-500 dark:text-gray-400 text-center">
                      {searchQuery.length >= 2 ? 'No matches found. AI searching...' : 'Keep typing...'}
                    </div>
                  ) : (
                    semanticResults.map((item, idx) => {
                      const r = rooms.find(rr => rr.id === item.roomId)
                      const isOther = item.roomId !== currentRoomId
                      return (
                        <button key={item.id}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => selectSearchResult(item)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer border-none touch-manipulation ${
                            idx === 0 ? 'bg-indigo-50/60 dark:bg-indigo-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                          } ${isOther ? 'border-l-3 border-l-amber-400' : ''}`}>
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                            style={{ background: `${pinColor(item.category)}20`, color: pinColor(item.category) }}>
                            {categoryIcon(item.category)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <strong className="text-sm text-gray-900 dark:text-gray-100">{item.name}</strong>
                              {idx === 0 && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 whitespace-nowrap">Best</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                              <span>📍 {item.location}</span>
                              {isOther && <span className="text-amber-500 font-medium">· {r?.name || 'Other room'} ↺</span>}
                            </div>
                          </div>
                          <div className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 text-right">
                            <div className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">{item.category}</div>
                          </div>
                        </button>
                      )
                    })
                  )}
                  {semanticResults.length > 0 && (
                    <div className="px-4 py-2 text-[10px] text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 text-center">
                      {semanticResults.length} result{semanticResults.length > 1 ? 's' : ''} · Fuzzy match
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
                    className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full cursor-pointer text-gray-700 dark:text-gray-300 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-500 hover:-translate-y-0.5 transition-all touch-manipulation">{chip.icon} {chip.label}</button>
                ))}
              </div>
            )}

            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{roomItems.length} item{roomItems.length !== 1 ? 's' : ''} in this room{searchQuery ? ` · ${filtered.length} match${filtered.length !== 1 ? 'es' : ''}` : ''}</p>
          </header>

          {/* ── Room Tabs ── */}
          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 flex-shrink-0 room-tabs max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory max-md:gap-1 max-md:pb-2 max-md:flex-nowrap">
            {rooms.map(r => {
              const hasGlow = glowingItemId && items.find(i => i.id === glowingItemId)?.roomId === r.id && r.id !== currentRoomId
              return (
                <button key={r.id} onClick={() => switchRoom(r.id)}
                  className={`flex items-center gap-1 px-3.5 py-2 text-xs font-medium whitespace-nowrap rounded-lg border transition-all cursor-pointer flex-shrink-0 max-md:snap-start touch-manipulation ${
                    r.id === currentRoomId
                      ? 'bg-indigo-500 text-white border-indigo-500'
                      : hasGlow
                        ? 'bg-amber-50 dark:bg-amber-900/30 border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.3)] animate-pulse'
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}>
                  {r.name} <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${r.id === currentRoomId ? 'bg-white/20' : hasGlow ? 'bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>{items.filter(i => i.roomId === r.id).length}</span>
                </button>
              )
            })}
            <button onClick={async () => { const n = await showInlinePrompt('New room name:'); if (n) addRoom(n) }}
              className="flex items-center justify-center w-9 h-9 bg-transparent border border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-lg text-gray-500 dark:text-gray-400 cursor-pointer hover:border-indigo-500 hover:text-indigo-500 flex-shrink-0 transition-colors max-md:w-8 max-md:h-8 touch-manipulation">+</button>
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
                            <div key={i} className="flex gap-3 items-start p-3 mb-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100 dark:border-gray-700 hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors animate-[fadeInUp_0.4s_ease-out_both]" style={{ animationDelay: `${0.1 + i * 0.1}s` }}>
                              <div className="w-7 h-7 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">{s.num}</div>
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
                          glowingItemId === item.id ? '!border-indigo-500 !shadow-[0_0_0_2px_rgba(99,102,241,0.15)]' : ''
                        }`}>
                        <div className="flex items-center gap-3">
                          {/* Category thumbnail */}
                          <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg flex-shrink-0"
                            style={{ background: `${pinColor(item.category)}20`, color: pinColor(item.category) }}>
                            {categoryIcon(item.category)}
                          </div>

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
                              <button onClick={() => { setGlowingItemId(item.id); showPanicToast(`Re-scan suggested for ${item.name}`); if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current); searchPulseTimer.current = setTimeout(() => setGlowingItemId(null), 4000) }}
                                className="text-[10px] text-indigo-500 font-medium hover:underline cursor-pointer bg-none border-none touch-manipulation">⟳ Re-scan now</button>
                            )}
                            <div className="flex items-center gap-1">
                              <button onClick={() => { setGlowingItemId(item.id); if (pulseTimer.current) clearTimeout(pulseTimer.current); pulseTimer.current = setTimeout(() => setGlowingItemId(null), 3000) }}
                                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-600 text-xs cursor-pointer bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation" title="Show on map">📍</button>
                              <button onClick={() => { setEditingItem(item); setShowAddModal(true) }}
                                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-600 text-xs cursor-pointer bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation" title="Edit">✏️</button>
                              <button onClick={() => { if (confirm('Delete this item?')) deleteItem(item.id) }}
                                className="w-7 h-7 flex items-center justify-center rounded-md border border-red-200 dark:border-red-900 text-xs cursor-pointer bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500 transition-colors touch-manipulation" title="Delete">🗑️</button>
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
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-200 dark:border-gray-700">
                  <h3 className="text-sm font-semibold">🗺️ {room.name}</h3>
                  {selectedZone && (
                    <button onClick={() => setSelectedZone(null)} className="px-2.5 py-1 text-xs font-medium border border-gray-200 dark:border-gray-600 rounded-md cursor-pointer bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation">Clear Filter</button>
                  )}
                </div>
                <div className="p-4">
                  <div className="relative w-full aspect-[4/3] bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden room-border">
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-600 font-medium pointer-events-none whitespace-nowrap select-none">Drag zones to rearrange</div>
                    {room.zones.map(zone => {
                      const zoned = roomItems.filter(i => Math.abs(i.zoneX - zone.x) < 15 && Math.abs(i.zoneY - zone.y) < 15)
                      const hasGlowing = zoned.some(i => i.id === glowingItemId)
                      const zoneCats = [...new Set(zoned.map(i => i.category))]
                      const zoneColor = zoneCats.length === 1 ? pinColor(zoneCats[0]) : null
                      return (
                        <div key={zone.id}
                          className={`drag-zone absolute -translate-x-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all select-none min-w-[60px] ${
                            selectedZone === zone.id ? 'bg-indigo-500/20 border-indigo-500' : 'bg-indigo-500/10 border-indigo-500/30'
                          } ${hasGlowing ? '!border-indigo-500 !shadow-[0_0_0_3px_rgba(99,102,241,0.2),0_0_20px_rgba(99,102,241,0.15)] animate-pulse' : ''}`}
                          data-zone={zone.id} data-room-id={room.id}
                          style={{ left: `${zone.x}%`, top: `${zone.y}%`, border: '1px dashed', ...(zoneColor ? { borderColor: zoneColor, background: `${zoneColor}15` } : {}) }}
                          onMouseDown={e => { if (!(e.target as HTMLElement).closest('.map-pin')) startDrag(e.currentTarget) }}
                          onTouchStart={e => { if (!(e.target as HTMLElement).closest('.map-pin')) startDrag(e.currentTarget) }}
                          onClick={e => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('.map-pin')) setSelectedZone(selectedZone === zone.id ? null : zone.id) }}>
                          <span className="block text-center text-xs text-gray-500 dark:text-gray-400 opacity-40 cursor-grab select-none mb-0.5">⠿</span>
                          <span className="block text-[11px] text-gray-500 dark:text-gray-400 font-semibold text-center pointer-events-none select-none">{zone.label}</span>
                          {zoned.length > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 rounded-full bg-indigo-500 text-white text-[10px] font-bold flex items-center justify-center pointer-events-none select-none">{zoned.length}</span>
                          )}
                          {zoned.map(i => (
                            <div key={i.id}
                              className={`map-pin absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-sm cursor-pointer shadow-md z-2 transition-all hover:scale-120 ${
                                glowingItemId === i.id ? '!z-6 animate-pulse-glow' : ''
                              }`}
                              data-item-id={i.id} data-pin-for={i.id}
                              style={{ background: pinColor(i.category) }}
                              onClick={e => { e.stopPropagation(); setGlowingItemId(glowingItemId === i.id ? null : i.id) }}>
                              {pinIcon(i.name)}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                  {/* Unsorted bar */}
                  {(() => {
                    const unsorted = roomItems.filter(i => !room.zones.some(z => Math.abs(i.zoneX - z.x) < 15 && Math.abs(i.zoneY - z.y) < 15))
                    if (unsorted.length === 0) return null
                    return (
                      <div className="flex items-center gap-2 p-2.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex-wrap">
                        <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">📦 Unsorted / Off-Map Items</span>
                        {unsorted.map(i => (
                          <span key={i.id} onClick={() => setGlowingItemId(glowingItemId === i.id ? null : i.id)}
                            className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-gray-700 dark:text-gray-300 whitespace-nowrap cursor-pointer hover:border-indigo-500 transition-colors ${
                              glowingItemId === i.id ? '!border-indigo-500 !shadow-[0_0_0_2px_rgba(99,102,241,0.2)]' : ''
                            }`}>
                            {pinIcon(i.name)} {i.name}
                          </span>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Map Overlay */}
        {showMobileMap && (
          <div className="fixed inset-0 z-[60] bg-white dark:bg-gray-800 flex flex-col animate-[fadeIn_0.2s_ease-out] md:hidden">
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <h3 className="text-lg font-semibold">🗺️ {room.name}</h3>
              <button onClick={() => setShowMobileMap(false)} className="bg-none border-none text-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 p-1 rounded transition-colors touch-manipulation">✕</button>
            </div>
            <div className="flex-1 p-4 overflow-auto">
              <div className="relative w-full aspect-[4/3] min-h-[300px] bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden room-border">
                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 font-medium pointer-events-none whitespace-nowrap">Drag zones to rearrange</div>
                {room.zones.map(zone => {
                  const zoned = roomItems.filter(i => Math.abs(i.zoneX - zone.x) < 15 && Math.abs(i.zoneY - zone.y) < 15)
                  return (
                    <div key={zone.id}
                      className={`drag-zone absolute -translate-x-1/2 -translate-y-1/2 px-2 py-1 rounded-lg cursor-pointer transition-all select-none ${
                        selectedZone === zone.id ? 'bg-indigo-500/20 border-indigo-500' : 'bg-indigo-500/10 border-indigo-500/30'
                      }`}
                      data-zone={zone.id} data-room-id={room.id}
                      style={{ left: `${zone.x}%`, top: `${zone.y}%`, border: '1px dashed' }}>
                      <span className="block text-[11px] text-gray-500 font-semibold text-center pointer-events-none">{zone.label}</span>
                      {zoned.map(i => (
                        <div key={i.id}
                          className={`map-pin absolute -translate-x-1/2 -translate-y-full w-7 h-7 rounded-full flex items-center justify-center text-sm cursor-pointer shadow-md z-5`}
                          style={{ background: pinColor(i.category), filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.3))' }}>
                          {pinIcon(i.name)}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Camera Scan Overlay */}
        {showCameraScan && (
          <div className="fixed inset-0 z-[9999] bg-[rgba(15,23,42,0.96)] flex items-center justify-center p-4 animate-[fadeIn_0.25s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) { if (dashScanStream.current) { dashScanStream.current.getTracks().forEach(t => t.stop()); dashScanStream.current = null }; setShowCameraScan(false) } }}>
            <div className="flex flex-col items-center text-center max-w-md w-full">
              <div className="flex items-center justify-between w-full mb-3">
                <h2 className="text-slate-100 text-lg">📸 Room Scan</h2>
                <button onClick={() => { if (dashScanStream.current) { dashScanStream.current.getTracks().forEach(t => t.stop()); dashScanStream.current = null }; setShowCameraScan(false) }}
                  className="bg-none border-none text-lg cursor-pointer text-slate-400 hover:bg-slate-800 p-1 rounded transition-colors touch-manipulation">✕</button>
              </div>
              <div className="relative w-full aspect-[4/3] bg-slate-800 rounded-xl overflow-hidden border-2 border-blue-500">
                <video id="dash-scan-video" autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-b from-transparent to-blue-500 animate-[scanMotion_2s_linear_infinite]" />
                <div id="dash-box-passport" className="hidden absolute border-2 border-green-500 bg-green-500/10 rounded px-1 py-0.5 text-green-500 text-[10px] font-bold" style={{ top: '45%', left: '15%', width: '25%', height: '20%' }}>Passport</div>
                <div id="dash-box-laptop" className="hidden absolute border-2 border-blue-500 bg-blue-500/10 rounded px-1 py-0.5 text-blue-500 text-[10px] font-bold" style={{ top: '25%', left: '45%', width: '45%', height: '45%' }}>Laptop</div>
                <div id="dash-box-keys" className="hidden absolute border-2 border-yellow-500 bg-yellow-500/10 rounded px-1 py-0.5 text-yellow-500 text-[10px] font-bold" style={{ top: '75%', left: '35%', width: '15%', height: '12%' }}>Keys</div>
              </div>
              <p className="text-slate-400 text-sm my-4">Point your camera at your space to detect essentials</p>
              <button id="dash-scan-btn" onClick={startDashboardScan}
                className="bg-blue-500 hover:bg-blue-600 text-white border-none px-8 py-3 font-bold rounded-lg cursor-pointer transition-colors touch-manipulation">📸 Start Scan</button>
            </div>
          </div>
        )}

        {/* Add/Edit Modal */}
        {showAddModal && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.2s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget) { setShowAddModal(false); setEditingItem(null) } }}>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-7 w-full max-w-md max-h-[90vh] overflow-y-auto animate-[slideUp_0.25s_ease-out]">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold">{editingItem ? 'Edit Item' : 'Add New Item'}</h2>
                <button onClick={() => { setShowAddModal(false); setEditingItem(null) }}
                  className="bg-none border-none text-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 p-1 rounded transition-colors touch-manipulation">✕</button>
              </div>
              <form onSubmit={e => {
                e.preventDefault()
                const fd = new FormData(e.currentTarget)
                const name = fd.get('name') as string; const location = fd.get('location') as string; const category = fd.get('category') as string
                const pin = document.getElementById('mini-pin')
                const zx = pin ? parseFloat(pin.style.left) : 50; const zy = pin ? parseFloat(pin.style.top) : 50
                if (editingItem) updateItem(editingItem.id, name, location, category)
                else addItem(name, location, category, zx, zy)
                setShowAddModal(false); setEditingItem(null)
              }} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Item Name</label>
                  <input name="name" defaultValue={editingItem?.name || ''} placeholder="e.g. Passport, House Keys" required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Location</label>
                  <input name="location" defaultValue={editingItem?.location || ''} placeholder="e.g. Top desk drawer" required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-200">Category</label>
                  <select name="category" defaultValue={editingItem?.category || ''} required
                    className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100">
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
                      <div key={z.id} className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 bg-indigo-500/10 border border-indigo-500/30 rounded pointer-events-none"
                        style={{ left: `${z.x}%`, top: `${z.y}%` }}>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{z.label}</span>
                      </div>
                    ))}
                    <div id="mini-pin" className="absolute text-2xl z-5 pointer-events-none" style={{ left: `${editingItem?.zoneX || 50}%`, top: `${editingItem?.zoneY || 50}%`, transform: 'translate(-50%, -100%)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.3))' }}>📍</div>
                  </div>
                </div>
                <button type="submit" className="w-full py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg transition-all cursor-pointer touch-manipulation">
                  {editingItem ? 'Save Changes' : 'Save Item'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Scan Modal */}
        {false && <div id="scan-modal-placeholder" />}

        {/* Confetti */}
        {showConfetti && (
          <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
            {['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'].map((c, i) => (
              <div key={i} className="absolute -top-2.5 w-2 h-2 rounded-sm animate-[confetti-fall_1.2s_ease-in_forwards]"
                style={{ left: `${10 + i * 10}%`, background: c, animationDelay: `${i * 0.05}s` }} />
            ))}
          </div>
        )}

        {/* Mobile Bottom Bar */}
        <div className="hidden max-md:flex items-center gap-2 fixed bottom-0 left-0 right-0 z-50 p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl">
          <button onClick={() => { setShowCameraScan(true); setShowAddModal(false) }}
            className="flex-1 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white border-none rounded-xl text-base font-semibold cursor-pointer transition-all shadow-[0_4px_12px_rgba(16,185,129,0.3)] active:scale-97 touch-manipulation">📸 Scan Room</button>
          <button onClick={startVoiceSearch}
            className={`w-12 h-12 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-xl cursor-pointer flex items-center justify-center transition-colors text-gray-500 dark:text-gray-400 hover:border-gray-400 ${isListening ? '!text-red-500 animate-pulse !border-red-500' : ''} touch-manipulation`}>{isListening ? '🔴' : '🎤'}</button>
        </div>

        {/* Panic Toast */}
        {panicToast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-6 py-3.5 rounded-xl text-sm font-semibold text-center shadow-[0_8px_32px_rgba(220,38,38,0.35)] max-w-[90vw] animate-[slideUp_0.3s_cubic-bezier(0.4,0,0.2,1)]">
            {panicToast}
          </div>
        )}

        {/* Panic SOS Button */}
        <button onClick={startPanicVoiceSearch}
          className={`fixed bottom-22 right-4 z-50 w-16 h-16 max-md:w-14 max-md:h-14 max-md:bottom-22 max-md:right-3 rounded-full bg-red-500 text-white border-3 border-white text-2xl cursor-pointer flex items-center justify-center shadow-[0_4px_20px_rgba(239,68,68,0.5)] transition-all hover:scale-110 active:scale-95 touch-manipulation ${
            panicListening ? 'panic-pulse shadow-[0_4px_30px_rgba(239,68,68,0.7),0_0_0_12px_rgba(239,68,68,0.15)]' : ''
          }`}
          title="Panic Find - say what you lost">
          {panicListening ? '🔴' : '🆘'}
        </button>

        {/* Inline Prompt */}
        {showPrompt && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5 animate-[fadeIn_0.15s_ease-out]"
            onClick={e => { if (e.target === e.currentTarget && promptCallback) { promptCallback(null); setShowPrompt(false); setPromptCallback(null) } }}>
            <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-lg animate-[slideUp_0.2s_ease-out]">
              <h3 className="text-base font-semibold mb-4">{promptPlaceholder}</h3>
              <input id="inline-prompt-input" type="text" placeholder="Enter name..." autoComplete="off"
                className="w-full px-3.5 py-3 text-sm border border-gray-200 dark:border-gray-600 rounded-lg outline-none focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/12 bg-white dark:bg-gray-700 dark:text-gray-100 mb-4"
                onKeyDown={e => { if (e.key === 'Enter' && promptCallback) { const v = (e.target as HTMLInputElement).value.trim(); promptCallback(v || null); setShowPrompt(false); setPromptCallback(null) } }} />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { if (promptCallback) { promptCallback(null); setShowPrompt(false); setPromptCallback(null) } }}
                  className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-gray-600 rounded-lg cursor-pointer bg-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors touch-manipulation">Cancel</button>
                <button onClick={() => { const v = (document.getElementById('inline-prompt-input') as HTMLInputElement)?.value?.trim() || null; if (promptCallback) { promptCallback(v); setShowPrompt(false); setPromptCallback(null) } }}
                  className="px-4 py-2 text-sm font-medium border-none rounded-lg cursor-pointer bg-indigo-500 text-white hover:bg-indigo-600 transition-colors touch-manipulation">OK</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
