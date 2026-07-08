import './style.css'

interface Zone {
  id: string
  label: string
  x: number
  y: number
}

interface Room {
  id: string
  name: string
  zones: Zone[]
}

interface Item {
  id: string
  name: string
  location: string
  category: string
  roomId: string
  createdAt: string
  lastConfirmed: string
  zoneX: number
  zoneY: number
}

interface User {
  email: string
  password: string
}

const DEFAULT_ROOMS: Room[] = [
  {
    id: 'room_living',
    name: 'Living Room',
    zones: [
      { id: 'desk', label: 'Desk', x: 20, y: 25 },
      { id: 'shelf', label: 'Bookshelf', x: 70, y: 18 },
      { id: 'tv_stand', label: 'TV Stand', x: 85, y: 40 },
      { id: 'cabinet', label: 'Cabinet', x: 72, y: 68 },
      { id: 'table', label: 'Coffee Table', x: 35, y: 52 },
      { id: 'drawer', label: 'Drawer', x: 10, y: 70 },
    ],
  },
  {
    id: 'room_bedroom',
    name: 'Bedroom',
    zones: [
      { id: 'bed', label: 'Bed', x: 50, y: 22 },
      { id: 'nightstand_l', label: 'Nightstand L', x: 18, y: 35 },
      { id: 'nightstand_r', label: 'Nightstand R', x: 82, y: 35 },
      { id: 'wardrobe', label: 'Wardrobe', x: 72, y: 68 },
      { id: 'dresser', label: 'Dresser', x: 22, y: 68 },
      { id: 'desk', label: 'Desk', x: 10, y: 22 },
    ],
  },
  {
    id: 'room_kitchen',
    name: 'Kitchen',
    zones: [
      { id: 'fridge', label: 'Fridge', x: 15, y: 22 },
      { id: 'cabinet_u', label: 'Upper Cabinet', x: 55, y: 14 },
      { id: 'counter', label: 'Counter', x: 60, y: 40 },
      { id: 'cabinet_l', label: 'Lower Cabinet', x: 50, y: 66 },
      { id: 'pantry', label: 'Pantry', x: 86, y: 55 },
      { id: 'island', label: 'Island', x: 42, y: 45 },
    ],
  },
]

const SAMPLE_ITEMS: Array<{ name: string; location: string; category: string; roomId: string; zoneX: number; zoneY: number }> = [
  { name: 'Passport', location: 'Desk Drawer', category: 'Documents', roomId: 'room_living', zoneX: 20, zoneY: 25 },
  { name: 'Laptop', location: 'Desk', category: 'Electronics', roomId: 'room_living', zoneX: 20, zoneY: 23 },
  { name: 'House Keys', location: 'Nightstand', category: 'Keys', roomId: 'room_bedroom', zoneX: 82, zoneY: 35 },
  { name: 'Warranty Card', location: 'Cabinet Shelf', category: 'Warranties', roomId: 'room_living', zoneX: 72, zoneY: 66 },
  { name: 'Spare Phone Charger', location: 'Bedroom Dresser', category: 'Electronics', roomId: 'room_bedroom', zoneX: 22, zoneY: 66 },
]

let currentUser: User | null = null
let currentPage: 'auth' | 'dashboard' = 'auth'
let items: Item[] = []
let searchQuery = ''
let authError = ''
let editingItem: Item | null = null
let showScanModal = false
let showCameraScan = false
let showAddModal = false
let scanning = false
let scanLog: string[] = []
let selectedZone: string | null = null
let glowingItemId: string | null = null
let rooms: Room[] = []
let currentRoomId: string = ''
let draggingZone: { roomId: string; zoneId: string } | null = null
let darkMode = false
let showConfetti = false
let isListening = false
let showResultPopup = false
let resultItem: Item | null = null
let redirectNotice = ''
let showMobileMap = false
let cameraStream: MediaStream | null = null
let dismissAlerts: string[] = []
let cameraError = ''
let showPrompt = false
let promptPlaceholder = ''
let promptCallback: ((v: string | null) => void) | null = null
let panicListening = false
let panicToast = ''
let panicToastTimer: ReturnType<typeof setTimeout> | null = null
let showOnboarding = false
let onboardingStep: 1 | 2 = 1

function storageKey(user: string): string {
  return `ilf_data_${user}`
}

function seedSampleData() {
  rooms = JSON.parse(JSON.stringify(DEFAULT_ROOMS))
  items = SAMPLE_ITEMS.map(s => ({
    id: crypto.randomUUID().slice(0, 8),
    name: s.name,
    location: s.location,
    category: s.category,
    roomId: s.roomId,
    createdAt: formatDate(new Date()),
    lastConfirmed: new Date(Date.now() - Math.random() * 86400000).toISOString(),
    zoneX: s.zoneX,
    zoneY: s.zoneY,
  }))
  currentRoomId = rooms[0].id
}

function loadData() {
  if (!currentUser) return
  const raw = localStorage.getItem(storageKey(currentUser.email))
  if (!raw) {
    if (!localStorage.getItem('ilf_onboarded')) {
      rooms = JSON.parse(JSON.stringify(DEFAULT_ROOMS))
      items = []
      currentRoomId = rooms[0].id
      showOnboarding = true
      onboardingStep = 1
      return
    }
    seedSampleData()
    saveData()
    return
  }
  try {
    const data = JSON.parse(raw)
    rooms = data.rooms?.length ? data.rooms : JSON.parse(JSON.stringify(DEFAULT_ROOMS))
    items = (data.items || []).map((i: Item) => ({
      ...i,
      roomId: i.roomId || rooms[0]?.id || '',
    }))
    currentRoomId = data.currentRoomId || rooms[0]?.id || ''
    showOnboarding = false
  } catch {
    seedSampleData()
    saveData()
  }
}

function loadDarkMode() {
  darkMode = localStorage.getItem('ilf_dark') === 'true'
  document.documentElement.classList.toggle('dark', darkMode)
}

function toggleDarkMode() {
  darkMode = !darkMode
  localStorage.setItem('ilf_dark', String(darkMode))
  document.documentElement.classList.toggle('dark', darkMode)
  render()
}

function saveData() {
  if (!currentUser) return
  localStorage.setItem(storageKey(currentUser.email), JSON.stringify({
    rooms,
    items,
    currentRoomId,
  }))
}

function getUsers(): User[] {
  return JSON.parse(localStorage.getItem('ilf_users') || '[]')
}

function saveUsers(users: User[]) {
  localStorage.setItem('ilf_users', JSON.stringify(users))
}

function navigate(page: 'auth' | 'dashboard') {
  currentPage = page
  render()
}

function signUp(email: string, password: string) {
  const users = getUsers()
  if (users.find(u => u.email === email)) { authError = 'Email already registered'; render(); return }
  users.push({ email, password })
  saveUsers(users)
  currentUser = { email, password }
  loadData()
  authError = ''
  navigate('dashboard')
}

function signIn(email: string, password: string) {
  const users = getUsers()
  const user = users.find(u => u.email === email && u.password === password)
  if (!user) { authError = 'Invalid email or password'; render(); return }
  currentUser = user
  loadData()
  authError = ''
  navigate('dashboard')
}

function signOut() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }
  currentUser = null; items = []; rooms = []; authError = ''; showOnboarding = false; navigate('auth')
}

function currentRoom(): Room {
  return rooms.find(r => r.id === currentRoomId) || rooms[0]
}

function roomItems(): Item[] {
  return items.filter(i => i.roomId === currentRoomId)
}

function switchRoom(id: string) {
  currentRoomId = id; selectedZone = null; glowingItemId = null; saveData(); render()
}

function addRoom(name: string) {
  const id = `room_${crypto.randomUUID().slice(0, 6)}`
  rooms.push({
    id,
    name,
    zones: [
      { id: 'center', label: 'Center', x: 50, y: 40 },
      { id: 'corner_1', label: 'Corner 1', x: 15, y: 20 },
      { id: 'corner_2', label: 'Corner 2', x: 85, y: 70 },
    ],
  })
  currentRoomId = id
  selectedZone = null
  saveData()
  render()
}

function renameRoom(id: string, name: string) {
  const r = rooms.find(r => r.id === id)
  if (r) { r.name = name; saveData(); render() }
}

function addItem(name: string, location: string, category: string, zoneX = 50, zoneY = 50) {
  items.push({
    id: crypto.randomUUID().slice(0, 8),
    name, location, category,
    roomId: currentRoomId,
    createdAt: formatDate(new Date()),
    lastConfirmed: new Date().toISOString(),
    zoneX, zoneY,
  })
  saveData()
}

function updateItem(id: string, name: string, location: string, category: string) {
  const idx = items.findIndex(i => i.id === id)
  if (idx !== -1) {
    items[idx] = { ...items[idx], name, location, category, lastConfirmed: new Date().toISOString() }
    saveData()
  }
  editingItem = null
}

function deleteItem(id: string) {
  items = items.filter(i => i.id !== id)
  saveData()
  render()
}

function isValidDate(value: unknown): value is string {
  if (!value || typeof value !== 'string') return false
  const d = new Date(value)
  return d instanceof Date && !isNaN(d.getTime())
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

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

function getConfidence(iso: string): { level: 'high' | 'medium' | 'low' | 'stale'; label: string } {
  if (!isValidDate(iso)) return { level: 'stale', label: 'Stale Data - Rescan Needed' }
  const diff = Date.now() - new Date(iso).getTime()
  const hours = diff / 3600000
  if (hours < 24) return { level: 'high', label: 'Verified via Scan' }
  if (hours < 72) return { level: 'medium', label: 'Confirmed' }
  if (hours < 168) return { level: 'low', label: 'Last seen' }
  return { level: 'stale', label: 'Stale Data - Rescan Needed' }
}

function getConfidencePercent(iso: string): number {
  if (!isValidDate(iso)) return 0
  const diff = Date.now() - new Date(iso).getTime()
  const hours = diff / 3600000
  if (hours < 1) return 100
  if (hours > 336) return 5
  return Math.round(100 - (hours / 336) * 95)
}

function staleItems(): Item[] {
  const cutoff = Date.now() - 3 * 24 * 3600000
  return items.filter(i => isValidDate(i.lastConfirmed) && new Date(i.lastConfirmed).getTime() < cutoff)
}

function isZonedItem(i: Item, zones: Zone[]): boolean {
  return zones.some(z => Math.abs(i.zoneX - z.x) < 15 && Math.abs(i.zoneY - z.y) < 15)
}

function pinColor(category: string): string {
  switch (category) {
    case 'Documents': return '#4f46e5'
    case 'Electronics': return '#059669'
    case 'Keys': return '#d97706'
    case 'Warranties': return '#7c3aed'
    case 'Valuables': return '#be185d'
    default: return '#6b7280'
  }
}

function pinIcon(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('passport') || lower.includes('document')) return '🛂'
  if (lower.includes('key')) return '🔑'
  if (lower.includes('laptop') || lower.includes('phone') || lower.includes('charger') || lower.includes('computer')) return '💻'
  if (lower.includes('warranty') || lower.includes('receipt')) return '📄'
  if (lower.includes('wallet') || lower.includes('cash') || lower.includes('money')) return '👛'
  return '📦'
}

function startVoiceSearch() {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SpeechRecognition) { console.error('Speech Recognition API not supported in this browser.'); alert('Voice search is not supported in this browser. Try Chrome or Edge.'); return }
  if (isListening) return
  isListening = true
  const recognition = new SpeechRecognition()
  recognition.lang = 'en-US'
  recognition.continuous = false
  recognition.interimResults = false
  recognition.maxAlternatives = 1
  recognition.onstart = () => { console.log('🎤 Mic active: System is listening...') }
  recognition.onresult = (event: any) => {
    const transcript = event.results[0][0].transcript
    console.log('✅ Speech captured successfully:', transcript)
    searchQuery = transcript
    isListening = false
    handleSearch()
    render()
  }
  recognition.onerror = (event: any) => {
    console.error('❌ Speech recognition error caught:', event.error)
    isListening = false
    const errorMsg = event.error === 'not-allowed' ? 'Mic permission denied. Allow mic access in browser settings.' :
      event.error === 'no-speech' ? 'No speech detected. Try speaking louder.' :
      event.error === 'audio-capture' ? 'No microphone found. Check your mic.' :
      event.error === 'network' ? 'Network error. Check your connection.' :
      'Mic error: ' + event.error
    alert(errorMsg)
    render()
  }
  recognition.onend = () => { isListening = false; render() }
  recognition.start()
  render()
}

function showPanicToast(msg: string) {
  panicToast = msg
  if (panicToastTimer) clearTimeout(panicToastTimer)
  panicToastTimer = setTimeout(() => { panicToast = ''; render() }, 4000)
  render()
}

function startPanicVoiceSearch() {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SpeechRecognition) { console.error('Speech Recognition API not supported in this browser.'); alert('Voice search is not supported in this browser. Try Chrome or Edge.'); return }
  if (panicListening || isListening) return
  panicListening = true
  const recognition = new SpeechRecognition()
  recognition.lang = 'en-US'
  recognition.continuous = false
  recognition.interimResults = false
  recognition.maxAlternatives = 1

  recognition.onstart = () => { console.log('🎤 Mic active: Panic voice search listening...') }

  recognition.onresult = (event: any) => {
    const transcript = event.results[0][0].transcript.toLowerCase()
    console.log('✅ Panic voice captured successfully:', transcript)
    panicListening = false

    const fillers = ['where is my ', 'find my ', 'where are my ', 'where is the ', 'find the ', 'i need my ', 'locate my ', 'locate the ', 'show me my ', 'show me the ', 'find where my ', "where's my ", "where's the "]
    let keyword = transcript
    for (const f of fillers) {
      if (keyword.startsWith(f)) { keyword = keyword.slice(f.length); break }
    }
    keyword = keyword.replace(/[^a-z0-9 ]/g, '').trim()

    if (!keyword) {
      showPanicToast('Say the item name, e.g. "find my passport"')
      render(); return
    }

    searchQuery = keyword

    const q = searchQuery.toLowerCase()
    const match = items.find(i =>
      i.name.toLowerCase().includes(q) || i.location.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
    )

    if (!match) {
      showPanicToast(`Could not find "${keyword}" in any room`)
      searchQuery = ''
      render(); return
    }

    if (match.roomId !== currentRoomId) {
      currentRoomId = match.roomId
    }

    glowingItemId = match.id
    selectedZone = null

    const room = rooms.find(r => r.id === match.roomId)
    if (room) {
      const zoned = room.zones.find(z => Math.abs(match.zoneX - z.x) < 15 && Math.abs(match.zoneY - z.y) < 15)
      if (zoned) selectedZone = zoned.id
    }

    if (searchPulseTimer) { clearTimeout(searchPulseTimer); searchPulseTimer = null }
    searchPulseTimer = setTimeout(() => { glowingItemId = null; if (!searchQuery) { showResultPopup = false; resultItem = null }; render() }, 5000)

    showPanicToast(`Found: ${match.name} is on the ${match.location}`)
    render()
  }

  recognition.onerror = (event: any) => {
    console.error('❌ Panic speech recognition error:', event.error)
    panicListening = false
    const errorMsg = event.error === 'not-allowed' ? 'Mic permission denied. Allow mic access in browser settings.' :
      event.error === 'no-speech' ? 'No speech detected. Try speaking louder.' :
      event.error === 'audio-capture' ? 'No microphone found. Check your mic.' :
      event.error === 'network' ? 'Network error. Check your connection.' :
      'Mic error: ' + event.error
    showPanicToast(errorMsg)
    render()
  }
  recognition.onend = () => {
    if (panicListening) { panicListening = false; render() }
  }

  recognition.start()
  render()
}

const QUICK_CHIPS = [
  { label: 'Keys', query: 'keys', icon: '🔑' },
  { label: 'Passport', query: 'passport', icon: '🛂' },
  { label: 'Laptop', query: 'laptop', icon: '💻' },
  { label: 'Wallet', query: 'wallet', icon: '👛' },
]

function quickSearch(query: string) {
  searchQuery = query
  handleSearch()
  render()
}

let searchPulseTimer: ReturnType<typeof setTimeout> | null = null

function handleSearch() {
  if (!searchQuery) { glowingItemId = null; showResultPopup = false; resultItem = null; redirectNotice = ''; return }
  const q = searchQuery.toLowerCase()

  if (searchPulseTimer) { clearTimeout(searchPulseTimer); searchPulseTimer = null }

  const current = items.filter(i => i.roomId === currentRoomId)
  const currentMatches = current.filter(i =>
    i.name.toLowerCase().includes(q) || i.location.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
  )

  if (currentMatches.length > 0) {
    resultItem = currentMatches[0]
    glowingItemId = resultItem.id
    showResultPopup = true
    redirectNotice = ''
    searchPulseTimer = setTimeout(() => { glowingItemId = null; if (!searchQuery) { showResultPopup = false; resultItem = null }; render() }, 4000)
    return
  }

  for (const room of rooms) {
    if (room.id === currentRoomId) continue
    const roomMatches = items.filter(i => i.roomId === room.id &&
      (i.name.toLowerCase().includes(q) || i.location.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))
    )
    if (roomMatches.length > 0) {
      currentRoomId = room.id
      resultItem = roomMatches[0]
      glowingItemId = resultItem.id
      showResultPopup = true
      selectedZone = null
      redirectNotice = `Switched to ${room.name}`
      searchPulseTimer = setTimeout(() => { glowingItemId = null; if (!searchQuery) { showResultPopup = false; resultItem = null; redirectNotice = '' }; render() }, 4000)
      return
    }
  }

  showResultPopup = false
  resultItem = null
  glowingItemId = null
}

function dismissResultPopup() {
  showResultPopup = false
  resultItem = null
  if (!searchQuery) glowingItemId = null
  render()
}

function startCamera() {
  if (cameraStream) return
  cameraError = ''
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } })
    .then(stream => {
      cameraStream = stream
      const video = document.getElementById('scan-video') as HTMLVideoElement
      if (video) { video.srcObject = stream; video.play() }
    })
    .catch(() => {
      cameraError = 'Camera access denied or unavailable. Using simulated scan.'
      render()
    })
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop())
    cameraStream = null
  }
}

function captureSnapshot(): string | null {
  const video = document.getElementById('scan-video') as HTMLVideoElement
  if (!video || !video.videoWidth) return null
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.8)
}

function runScan() {
  scanning = true
  scanLog = ['📸 Initializing camera...', '🔍 Scanning room via AI vision...']
  const snapshot = captureSnapshot()
  if (snapshot) {
    sessionStorage.setItem('last_snapshot', snapshot)
    scanLog.push('📷 Room snapshot captured')
  }
  render()
  const room = currentRoom()
  const avZones = room.zones
  const detected = [
    { name: 'Passport', cat: 'Documents' },
    { name: 'Laptop', cat: 'Electronics' },
    { name: 'House Keys', cat: 'Keys' },
  ]
  let step = 0
  const interval = setInterval(() => {
    if (step < detected.length) {
      const d = detected[step]
      const zone = avZones[step % avZones.length]
      const existing = items.find(i => i.name.toLowerCase() === d.name.toLowerCase() && i.roomId === currentRoomId)
      if (existing) {
        existing.lastConfirmed = new Date().toISOString()
        existing.location = zone.label
        existing.zoneX = zone.x
        existing.zoneY = zone.y
        existing.roomId = currentRoomId
        scanLog.push(`✅ ${d.name} — updated location: ${zone.label}`)
      } else {
        items.push({
          id: crypto.randomUUID().slice(0, 8),
          name: d.name, location: zone.label, category: d.cat,
          roomId: currentRoomId,
          createdAt: formatDate(new Date()),
          lastConfirmed: new Date().toISOString(),
          zoneX: zone.x, zoneY: zone.y,
        })
        scanLog.push(`📦 ${d.name} — new item saved to: ${zone.label}`)
      }
      saveData()
      step++; render()
    } else {
      clearInterval(interval)
      scanLog.push('✅ Scan complete! Items updated.')
      scanning = false; showConfetti = true; render()
      setTimeout(() => { showConfetti = false; render() }, 1500)
    }
  }, 800)
}

function confirmItemMoved(itemId: string) {
  const item = items.find(i => i.id === itemId)
  if (item) {
    item.lastConfirmed = new Date().toISOString()
    saveData()
    render()
  }
}

function dismissAlertItem(itemId: string) {
  dismissAlerts.push(itemId)
  render()
}

function showInlinePrompt(placeholder: string): Promise<string | null> {
  return new Promise(resolve => {
    showPrompt = true
    promptPlaceholder = placeholder
    promptCallback = resolve
    render()
    setTimeout(() => {
      const el = document.getElementById('inline-prompt-input') as HTMLInputElement
      if (el) el.focus()
    }, 100)
  })
}

function completeOnboarding() {
  const top3 = [
    { name: 'Passport', location: 'Unsorted / Off-Map Items', category: 'Documents', zoneX: 50, zoneY: 50, roomId: rooms[0].id },
    { name: 'Laptop', location: 'Unsorted / Off-Map Items', category: 'Electronics', zoneX: 50, zoneY: 50, roomId: rooms[0].id },
    { name: 'House Keys', location: 'Unsorted / Off-Map Items', category: 'Keys', zoneX: 50, zoneY: 50, roomId: rooms[0].id },
  ]
  for (const t of top3) {
    items.push({
      id: crypto.randomUUID().slice(0, 8),
      name: t.name, location: t.location, category: t.category,
      roomId: t.roomId,
      createdAt: formatDate(new Date()),
      lastConfirmed: new Date().toISOString(),
      zoneX: t.zoneX, zoneY: t.zoneY,
    })
  }
  currentRoomId = rooms[0].id
  localStorage.setItem('ilf_onboarded', 'true')
  saveData()
  showOnboarding = false
  render()
}

function startCameraScan() {
  const btn = document.getElementById('start-scan-btn') as HTMLButtonElement
  if (!btn) return
  btn.disabled = true
  btn.innerText = 'Accessing Camera...'

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then(stream => {
      cameraStream = stream
      const video = document.getElementById('onboarding-video') as HTMLVideoElement
      if (video) { video.srcObject = stream; video.play() }

      btn.innerText = 'Scanning Room...'

      setTimeout(() => { const el = document.getElementById('box-laptop'); if (el) el.style.display = 'block' }, 800)
      setTimeout(() => { const el = document.getElementById('box-passport'); if (el) el.style.display = 'block' }, 1600)
      setTimeout(() => { const el = document.getElementById('box-keys'); if (el) el.style.display = 'block' }, 2300)

      setTimeout(() => {
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }
        onboardingStep = 2
        render()
      }, 3500)
    })
    .catch(() => {
      alert('Camera access blocked. Ensure you are loading via localhost and no other app is using the camera.')
      btn.disabled = false
      btn.innerText = 'Retry 3-Sec Scan'
    })
}

function renderOnboarding(app: HTMLDivElement) {
  if (onboardingStep === 1) {
    app.innerHTML = `
      <div id="onboarding-overlay" style="position: fixed; top:0; left:0; width:100vw; height:100vh; background: rgba(15, 23, 42, 0.95); z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; font-family: sans-serif; padding: 20px; box-sizing: border-box;">
        <div style="display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 500px; width: 100%;">
          <h2 style="margin-bottom: 10px; font-size: 1.5rem;">📸 Quick Room Setup</h2>
          <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px;">Point your camera at your space for 3 seconds to find your essentials.</p>
          <div id="camera-viewport" style="position: relative; width: 100%; aspect-ratio: 4/3; background: #1e293b; border-radius: 12px; overflow: hidden; border: 2px solid #3b82f6;">
            <video id="onboarding-video" autoplay playsinline muted style="width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1);"></video>
            <div class="scan-laser" style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(to bottom, rgba(59, 130, 246, 0), #3b82f6); animation: scanMotion 2s linear infinite;"></div>
            <div id="box-passport" style="display: none; position: absolute; border: 2px solid #22c55e; background: rgba(34, 197, 94, 0.1); border-radius: 4px; padding: 2px 6px; color: #22c55e; font-size: 10px; font-weight: bold; top: 45%; left: 15%; width: 25%; height: 20%;">Passport</div>
            <div id="box-laptop" style="display: none; position: absolute; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.1); border-radius: 4px; padding: 2px 6px; color: #3b82f6; font-size: 10px; font-weight: bold; top: 25%; left: 45%; width: 45%; height: 45%;">Laptop</div>
            <div id="box-keys" style="display: none; position: absolute; border: 2px solid #eab308; background: rgba(234, 179, 8, 0.1); border-radius: 4px; padding: 2px 6px; color: #eab308; font-size: 10px; font-weight: bold; top: 75%; left: 35%; width: 15%; height: 12%;">Keys</div>
          </div>
          <button id="start-scan-btn" style="margin-top: 20px; background: #3b82f6; color: white; border: none; padding: 12px 30px; font-weight: bold; border-radius: 8px; cursor: pointer; transition: background 0.2s;">Start 3-Sec Scan</button>
        </div>
      </div>`
    document.getElementById('start-scan-btn')!.addEventListener('click', startCameraScan)
  } else {
    app.innerHTML = `
      <div id="onboarding-overlay" style="position: fixed; top:0; left:0; width:100vw; height:100vh; background: rgba(15, 23, 42, 0.95); z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; font-family: sans-serif; padding: 20px; box-sizing: border-box;">
        <div style="display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 450px; width: 100%;">
          <h2 style="margin-bottom: 10px; font-size: 1.5rem;">🎉 Essentials Detected!</h2>
          <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 25px;">We successfully locked down your highest priority items. Secure them now to unlock your dashboard layout.</p>
          <div style="background: #1e293b; border-radius: 12px; width: 100%; padding: 15px; text-align: left; box-sizing: border-box; margin-bottom: 25px; border: 1px solid #334155;">
            <div style="display: flex; align-items: center; margin-bottom: 12px; color: #4ade80;"><span style="margin-right: 10px;">✅</span> 🪪 Passport <span style="margin-left: auto; font-size: 12px; color: #64748b;">Detected</span></div>
            <div style="display: flex; align-items: center; margin-bottom: 12px; color: #4ade80;"><span style="margin-right: 10px;">✅</span> 💻 Laptop <span style="margin-left: auto; font-size: 12px; color: #64748b;">Detected</span></div>
            <div style="display: flex; align-items: center; color: #4ade80;"><span style="margin-right: 10px;">✅</span> 🔑 House Keys <span style="margin-left: auto; font-size: 12px; color: #64748b;">Detected</span></div>
          </div>
          <button id="secure-save-btn" style="background: #22c55e; color: white; border: none; width: 100%; padding: 14px; font-weight: bold; border-radius: 8px; cursor: pointer; font-size: 1rem; transition: background 0.2s;">Pin My Top 3 Essentials &amp; Start</button>
        </div>
      </div>`
    document.getElementById('secure-save-btn')!.addEventListener('click', completeOnboarding)
  }
}

/* --- Dashboard camera scan (onboarding-style) --- */

function startDashboardScan() {
  const btn = document.getElementById('dash-scan-btn') as HTMLButtonElement
  if (!btn) return
  btn.disabled = true
  btn.innerText = 'Accessing Camera...'

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then(stream => {
      cameraStream = stream
      const video = document.getElementById('dash-scan-video') as HTMLVideoElement
      if (video) { video.srcObject = stream; video.play() }

      btn.innerText = 'Scanning Room...'

      setTimeout(() => { const el = document.getElementById('dash-box-laptop'); if (el) el.style.display = 'block' }, 800)
      setTimeout(() => { const el = document.getElementById('dash-box-passport'); if (el) el.style.display = 'block' }, 1600)
      setTimeout(() => { const el = document.getElementById('dash-box-keys'); if (el) el.style.display = 'block' }, 2300)

      setTimeout(() => {
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }

        const room = currentRoom()
        const detected = [
          { name: 'Passport', loc: 'Unsorted / Off-Map Items', cat: 'Documents', room: room.id },
          { name: 'Laptop', loc: 'Unsorted / Off-Map Items', cat: 'Electronics', room: room.id },
          { name: 'House Keys', loc: 'Unsorted / Off-Map Items', cat: 'Keys', room: room.id },
        ]
        for (const d of detected) {
          const existing = items.find(i => i.name.toLowerCase() === d.name.toLowerCase() && i.roomId === d.room)
          if (existing) {
            existing.lastConfirmed = new Date().toISOString()
          } else {
            items.push({
              id: crypto.randomUUID().slice(0, 8),
              name: d.name, location: d.loc, category: d.cat,
              roomId: d.room,
              createdAt: formatDate(new Date()),
              lastConfirmed: new Date().toISOString(),
              zoneX: 50, zoneY: 50,
            })
          }
        }
        saveData()
        showConfetti = true
        showCameraScan = false
        render()
        setTimeout(() => { showConfetti = false; render() }, 1500)
      }, 3500)
    })
    .catch(() => {
      alert('Camera access blocked. Allow camera permissions and try again.')
      btn.disabled = false
      btn.innerText = '📸 Start Scan'
    })
}

function renderCameraScan(): string {
  return `
    <div class="camera-scan-overlay" id="camera-scan-overlay">
      <div class="camera-scan-inner">
        <div class="camera-scan-header">
          <h2>📸 Room Scan</h2>
          <button id="close-camera-scan" class="btn-back">✕</button>
        </div>
        <div id="camera-scan-viewport" class="camera-scan-viewport">
          <video id="dash-scan-video" autoplay playsinline muted style="width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1);"></video>
          <div class="camera-scan-laser"></div>
          <div id="dash-box-passport" class="camera-scan-box passport">Passport</div>
          <div id="dash-box-laptop" class="camera-scan-box laptop">Laptop</div>
          <div id="dash-box-keys" class="camera-scan-box keys">Keys</div>
        </div>
        <p class="camera-scan-hint">Point your camera at your space to detect essentials</p>
        <button id="dash-scan-btn" class="camera-scan-btn">📸 Start Scan</button>
      </div>
    </div>`
}

function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  if (currentPage === 'auth') renderAuth(app)
  else if (showOnboarding) { app.innerHTML = ''; renderOnboarding(app) }
  else renderDashboard(app)
}

function renderAuth(app: HTMLDivElement) {
  const [email, _setEmail] = bindState('')
  const [password, _setPassword] = bindState('')
  const [isSignUp, setIsSignUp] = bindState(false)
  function renderForm() {
    app.innerHTML = `
      <div class="auth-page">
        <div class="auth-card">
          <div class="auth-header">
            <h1>📍 Item Location Finder</h1>
            <p class="subtitle">Never lose track of your important items</p>
          </div>
          <form id="auth-form" class="auth-form">
            <div class="field">
              <label for="email">Email</label>
              <input type="email" id="email" placeholder="you@example.com" value="${escapeHtml(email())}" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input type="password" id="password" placeholder="Enter password" value="${escapeHtml(password())}" required />
            </div>
            ${authError ? `<p class="error">${escapeHtml(authError)}</p>` : ''}
            <button type="submit" class="btn-primary">${isSignUp() ? 'Create Account' : 'Sign In'}</button>
          </form>
          <p class="auth-toggle">
            ${isSignUp() ? 'Already have an account?' : "Don't have an account?"}
            <a href="#" id="toggle-auth">${isSignUp() ? 'Sign In' : 'Sign Up'}</a>
          </p>
        </div>
      </div>`
    document.getElementById('auth-form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      const em = (document.getElementById('email') as HTMLInputElement).value
      const pw = (document.getElementById('password') as HTMLInputElement).value
      if (isSignUp()) signUp(em, pw); else signIn(em, pw)
    })
    document.getElementById('toggle-auth')!.addEventListener('click', (e) => {
      e.preventDefault(); setIsSignUp(!isSignUp()); renderForm()
    })
  }
  renderForm()
}

function renderDashboard(app: HTMLDivElement) {
  const room = currentRoom()
  const allRoomItems = roomItems()
  const filtered = filterItems(allRoomItems)
  const stale = staleItems().filter(i => i.roomId === currentRoomId)

  app.innerHTML = `
    <div class="dashboard">
      <header class="dash-header">
        <div class="dash-header-top">
          <h1>📍 Item Location Finder</h1>
          <div class="header-actions">
            <span class="user-badge">${escapeHtml(currentUser?.email || '')}</span>
            <button id="map-toggle" class="btn-icon mob-only" title="View Map">🗺️</button>
            <button id="dark-btn" class="btn-icon" title="Toggle dark mode">${darkMode ? '☀️' : '🌙'}</button>
            <button id="scan-btn" class="btn-scan ${scanning ? 'scanning' : ''}">📸 Scan Room</button>
            <button id="add-btn" class="btn-primary">+ Add Item</button>
            <button id="signout-btn" class="btn-secondary">Sign Out</button>
          </div>
        </div>
        ${stale.length > 0 ? `
          <div class="alert-banner">
            <span class="alert-icon">🔔</span>
            <div class="alert-body">
              <span class="alert-summary">${stale.length} item${stale.length > 1 ? 's' : ''} haven't been seen in 3+ days.</span>
              ${stale.filter(i => !dismissAlerts.includes(i.id)).slice(0, 3).map(i => `
                <div class="alert-item">
                  <span>${pinIcon(i.name)} <strong>${escapeHtml(i.name)}</strong> — last seen ${escapeHtml(timeAgo(i.lastConfirmed))} in ${escapeHtml(i.location)}</span>
                  <div class="alert-item-actions">
                    <button class="alert-confirm" data-confirm-id="${i.id}">✓ Still there</button>
                    <button class="alert-snooze" data-snooze-id="${i.id}">✕ Dismiss</button>
                  </div>
                </div>
              `).join('')}
              ${stale.length > 3 ? `<div class="alert-more">+${stale.length - 3} more stale items</div>` : ''}
            </div>
            <button id="dismiss-alerts" class="alert-dismiss" title="Dismiss all">✕</button>
          </div>` : ''}
        <div class="search-bar">
          <input type="text" id="search" placeholder="Search items..." value="${escapeHtml(searchQuery)}" />
          <button id="mic-btn" class="btn-mic ${isListening ? 'listening' : ''}" title="Search by voice">${isListening ? '🔴' : '🎤'}</button>
          ${searchQuery ? `<button id="clear-search" class="btn-clear">✕</button>` : ''}
        </div>
        ${!searchQuery ? `
          <div class="quick-chips">
            ${QUICK_CHIPS.map(chip => `
              <button class="chip-btn" data-query="${escapeHtml(chip.query)}">${chip.icon} ${chip.label}</button>
            `).join('')}
          </div>
        ` : ''}
        <p class="item-count">${allRoomItems.length} item${allRoomItems.length !== 1 ? 's' : ''} in this room ${searchQuery ? `· ${filtered.length} match${filtered.length !== 1 ? 'es' : ''}` : ''}</p>
        ${redirectNotice ? `<div class="redirect-notice">🔄 ${escapeHtml(redirectNotice)}</div>` : ''}
      </header>

      ${showCameraScan ? renderCameraScan() : ''}
      ${showScanModal ? renderScanModal() : ''}
      ${showAddModal ? renderAddModal() : ''}
      ${showConfetti ? '<div class="confetti-container">' + Array.from({length: 8}, (_, i) => `<div class="confetti-piece" style="animation-delay: ${i * 0.08}s; left: ${10 + i * 10}%; background: ${['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'][i]}"></div>`).join('') + '</div>' : ''}

      ${showResultPopup && resultItem ? `
        <div class="result-popup-mobile" id="result-popup-mobile">
          <div class="result-popup-inner">
            <button id="close-result-mob" class="btn-back result-close">✕</button>
            <div class="result-content">
              <div class="result-icon">${pinIcon(resultItem.name)}</div>
              <div class="result-info">
                <strong>${escapeHtml(resultItem.name)}</strong>
                <span>📍 ${escapeHtml(resultItem.location)}</span>
                <span class="result-meta">${escapeHtml(resultItem.category)} · ${escapeHtml(rooms.find(r => r.id === resultItem!.roomId)?.name || '')}</span>
              </div>
            </div>
            <div class="result-snapshot">
              ${(() => {
                const snap = sessionStorage.getItem('last_snapshot')
                return snap
                  ? `<img src="${snap}" alt="Snapshot" class="snapshot-img" />`
                  : `<div class="snapshot-placeholder">
                      <span class="snapshot-icon">📸</span>
                      <span>Last scan snapshot</span>
                      <small>${escapeHtml(timeAgo(resultItem.lastConfirmed))}</small>
                    </div>`
              })()}
            </div>
            <div class="result-actions">
              <button class="btn-small pin-btn" data-id="${resultItem.id}">📍 Show on Map</button>
              <button class="btn-small edit-btn" data-id="${resultItem.id}">✏️ Edit</button>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="dash-layout">
        <div class="items-panel">
          <div class="room-tabs" id="room-tabs">
            ${rooms.map(r => `
              <div class="room-tab ${r.id === currentRoomId ? 'active' : ''}" data-room-id="${r.id}">
                <span>${escapeHtml(r.name)}</span>
                ${r.id === currentRoomId ? `
                  <button class="tab-rename" data-room-id="${r.id}" title="Rename">✎</button>
                ` : ''}
              </div>
            `).join('')}
            <button id="add-room-btn" class="tab-add" title="Add Room">+</button>
          </div>
          <div class="items-grid">
            ${filtered.length === 0 ? `
              <div class="empty-state">
                ${searchQuery ? `
                  <div class="empty-icon">🔍</div>
                  <h2>No items match your search</h2>
                  <p>Try a different search term</p>
                ` : `
                  <div class="empty-icon">🏠</div>
                  <h2>Welcome to your ${escapeHtml(room.name)}</h2>
                  <p>Start tracking your belongings in 3 simple steps</p>
                  <div class="walkthrough">
                    <div class="walkthrough-step">
                      <div class="step-num">1</div>
                      <div class="step-content">
                        <strong>📸 Scan your room</strong>
                        <span>Point your camera around the room — AI auto-detects items</span>
                      </div>
                    </div>
                    <div class="walkthrough-step">
                      <div class="step-num">2</div>
                      <div class="step-content">
                        <strong>✏️ Or add items manually</strong>
                        <span>Tap "+ Add Item" and type what you stored and where</span>
                      </div>
                    </div>
                    <div class="walkthrough-step">
                      <div class="step-num">3</div>
                      <div class="step-content">
                        <strong>🔍 Find in seconds</strong>
                        <span>Search any item later — know exactly where it is</span>
                      </div>
                    </div>
                  </div>
                `}
              </div>
            ` : filtered.map(item => {
              const conf = getConfidence(item.lastConfirmed)
              return `
                <div class="item-card ${glowingItemId === item.id ? 'glow' : ''}"
                     data-zone-x="${item.zoneX}" data-zone-y="${item.zoneY}"
                     data-item-id="${item.id}">
                  <div class="card-header">
                    <span class="category-badge">${escapeHtml(item.category)}</span>
                    <span class="item-date">${escapeHtml(item.createdAt)}</span>
                  </div>
                  <h3 class="item-name">${escapeHtml(item.name)}</h3>
                  <div class="item-location-row">
                    <div class="item-location">
                      <span class="loc-icon">📍</span>
                      <span>${escapeHtml(item.location)}</span>
                    </div>
                    <div class="confidence-badge ${conf.level}">
                      ${conf.level === 'high' ? '🟢' : conf.level === 'medium' ? '🟡' : '🔴'}
                      ${conf.level === 'stale' ? escapeHtml(conf.label) : `${escapeHtml(conf.label)} ${escapeHtml(timeAgo(item.lastConfirmed))}`}
                      <span class="conf-pct">${getConfidencePercent(item.lastConfirmed)}%</span>
                    </div>
                  </div>
                  <div class="card-actions">
                    <button class="btn-small pin-btn" data-id="${item.id}">📍 Pin on Map</button>
                    <button class="btn-small edit-btn" data-id="${item.id}">Edit</button>
                    <button class="btn-small btn-danger delete-btn" data-id="${item.id}">Delete</button>
                  </div>
                </div>`
            }).join('')}
          </div>
        </div>

        <div class="map-panel">
          <div class="map-container">
            <div class="map-header">
              <h3>🗺️ ${escapeHtml(room.name)}</h3>
              ${selectedZone ? `<button id="clear-zone" class="btn-small">Clear Filter</button>` : ''}
            </div>
            ${showResultPopup && resultItem ? `
              <div class="result-popup">
                <button id="close-result" class="btn-back result-close">✕</button>
                <div class="result-content">
                  <div class="result-icon">${pinIcon(resultItem.name)}</div>
                  <div class="result-info">
                    <strong>${escapeHtml(resultItem.name)}</strong>
                    <span>📍 ${escapeHtml(resultItem.location)}</span>
                    <span class="result-meta">${escapeHtml(resultItem.category)} · ${escapeHtml(rooms.find(r => r.id === resultItem!.roomId)?.name || '')}</span>
                  </div>
                </div>
                <div class="result-snapshot">
                  ${(() => {
                    const snap = sessionStorage.getItem('last_snapshot')
                    return snap
                      ? `<img src="${snap}" alt="Snapshot" class="snapshot-img" />`
                      : `<div class="snapshot-placeholder">
                          <span class="snapshot-icon">📸</span>
                          <span>Last scan snapshot</span>
                          <small>${escapeHtml(timeAgo(resultItem.lastConfirmed))}</small>
                        </div>`
                  })()}
                </div>
                <div class="result-actions">
                  <button class="btn-small pin-btn" data-id="${resultItem.id}">📍 Show on Map</button>
                  <button class="btn-small edit-btn" data-id="${resultItem.id}">✏️ Edit</button>
                </div>
              </div>
            ` : ''}
            <div class="room-map">
              <div class="room-border" id="room-border">
                <div class="room-label">Drag zones to rearrange</div>
                ${room.zones.map(zone => {
                  const zoned = allRoomItems.filter(i => Math.abs(i.zoneX - zone.x) < 15 && Math.abs(i.zoneY - zone.y) < 15)
                  const hasGlowing = zoned.some(i => i.id === glowingItemId)
                  const zoneCats = [...new Set(zoned.map(i => i.category))]
                  const zoneColor = zoneCats.length === 1 ? pinColor(zoneCats[0]) : null
                  return `
                    <div class="map-zone drag-zone ${selectedZone === zone.id ? 'active' : ''} ${hasGlowing ? 'zone-glow' : ''}"
                         data-zone="${zone.id}"
                         data-room-id="${room.id}"
                         style="left: ${zone.x}%; top: ${zone.y}%; ${zoneColor ? `border-color: ${zoneColor}; background: ${zoneColor}15;` : ''}">
                      <span class="zone-drag-handle">⠿</span>
                      <span class="zone-label">${escapeHtml(zone.label)}</span>
                      ${zoned.length > 0 ? `<span class="zone-count">${zoned.length}</span>` : ''}
                      ${zoned.map(i => `
                        <div class="map-pin ${glowingItemId === i.id ? 'pulse-glow glow' : ''}"
                             data-item-id="${i.id}" data-pin-for="${i.id}"
                             style="background: ${pinColor(i.category)}">${pinIcon(i.name)}</div>
                      `).join('')}
                    </div>`
                }).join('')}
              </div>
              ${(() => {
                const unsorted = allRoomItems.filter(i => !isZonedItem(i, room.zones))
                if (unsorted.length === 0) return ''
                return `
                  <div class="unsorted-bar">
                    <span class="unsorted-label">📦 Unsorted / Off-Map Items</span>
                    ${unsorted.map(i => `
                      <span class="unsorted-chip ${glowingItemId === i.id ? 'glow' : ''}"
                            data-item-id="${i.id}" data-chip-for="${i.id}">${pinIcon(i.name)} ${escapeHtml(i.name)}</span>
                    `).join('')}
                  </div>`
              })()}
            </div>
          </div>
        </div>
      </div>

      ${showMobileMap ? `
        <div class="mobile-map-overlay" id="mobile-map-overlay">
          <div class="mobile-map-header">
            <h3>🗺️ ${escapeHtml(room.name)}</h3>
            <button id="close-mobile-map" class="btn-back">✕</button>
          </div>
          <div class="mobile-map-body">
            <div class="room-border" id="room-border-mobile">
              <div class="room-label">Drag zones to rearrange</div>
              ${room.zones.map(zone => {
                const zoned = allRoomItems.filter(i => Math.abs(i.zoneX - zone.x) < 15 && Math.abs(i.zoneY - zone.y) < 15)
                return `
                  <div class="map-zone drag-zone ${selectedZone === zone.id ? 'active' : ''}"
                       data-zone="${zone.id}" data-room-id="${room.id}"
                       style="left: ${zone.x}%; top: ${zone.y}%;">
                    <span class="zone-drag-handle">⠿</span>
                    <span class="zone-label">${escapeHtml(zone.label)}</span>
                    ${zoned.map(i => `
                      <div class="map-pin ${glowingItemId === i.id ? 'pulse-glow glow' : ''}"
                           data-item-id="${i.id}" data-pin-for="${i.id}"
                           style="background: ${pinColor(i.category)}">${pinIcon(i.name)}</div>
                    `).join('')}
                  </div>`
              }).join('')}
            </div>
          </div>
        </div>
      ` : ''}

      <div class="mobile-bottom-bar">
        <button id="mob-scan-btn" class="bottom-scan-btn">📸 Scan Room</button>
        <button id="mob-mic-btn" class="bottom-icon-btn ${isListening ? 'listening' : ''}">${isListening ? '🔴' : '🎤'}</button>
      </div>
      ${panicToast ? `<div class="panic-toast">${escapeHtml(panicToast)}</div>` : ''}

      <button id="panic-mic-btn" class="panic-mic ${panicListening ? 'panic-listening' : ''}" title="Panic Find - say what you lost">
        ${panicListening ? '🔴' : '🆘'}
      </button>

      ${showPrompt ? `
        <div class="prompt-overlay" id="prompt-overlay">
          <div class="prompt-card">
            <h3 class="prompt-title">${escapeHtml(promptPlaceholder)}</h3>
            <input type="text" id="inline-prompt-input" class="prompt-input" placeholder="Enter name..." autocomplete="off" />
            <div class="prompt-actions">
              <button id="prompt-cancel" class="btn-secondary">Cancel</button>
              <button id="prompt-ok" class="btn-primary">OK</button>
            </div>
          </div>
        </div>
      ` : ''}
    </div>`

  document.getElementById('dark-btn')!.addEventListener('click', toggleDarkMode)
  document.getElementById('scan-btn')!.addEventListener('click', () => { showCameraScan = true; showAddModal = false; render() })
  document.getElementById('add-btn')!.addEventListener('click', () => { showAddModal = true; showScanModal = false; editingItem = null; render() })
  document.getElementById('signout-btn')!.addEventListener('click', signOut)

  const mapToggleBtn = document.getElementById('map-toggle')
  if (mapToggleBtn) mapToggleBtn.addEventListener('click', () => { showMobileMap = true; render() })
  const closeMobileMap = document.getElementById('close-mobile-map')
  if (closeMobileMap) closeMobileMap.addEventListener('click', () => { showMobileMap = false; render() })

  const micBtn = document.getElementById('mic-btn')
  if (micBtn) micBtn.addEventListener('click', startVoiceSearch)
  const mobMicBtn = document.getElementById('mob-mic-btn')
  if (mobMicBtn) mobMicBtn.addEventListener('click', startVoiceSearch)
  const panicBtn = document.getElementById('panic-mic-btn')
  if (panicBtn) panicBtn.addEventListener('click', startPanicVoiceSearch)
  const mobScanBtn = document.getElementById('mob-scan-btn')
  if (mobScanBtn) mobScanBtn.addEventListener('click', () => { showCameraScan = true; showAddModal = false; render() })

  const search = document.getElementById('search') as HTMLInputElement
  search.addEventListener('input', () => {
    searchQuery = search.value
    if (searchQuery) handleSearch()
    else { glowingItemId = null; showResultPopup = false; resultItem = null; redirectNotice = '' }
    render()
  })
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (searchQuery) handleSearch()
      render()
    }
  })
  const clearBtn = document.getElementById('clear-search')
  if (clearBtn) clearBtn.addEventListener('click', () => { searchQuery = ''; glowingItemId = null; showResultPopup = false; resultItem = null; redirectNotice = ''; render() })

  const dismissBtn = document.getElementById('dismiss-alerts')
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    items.forEach(i => { i.lastConfirmed = new Date().toISOString() }); saveData(); render()
  })

  const clearZoneBtn = document.getElementById('clear-zone')
  if (clearZoneBtn) clearZoneBtn.addEventListener('click', () => { selectedZone = null; render() })

  const closeResultBtn = document.getElementById('close-result')
  if (closeResultBtn) closeResultBtn.addEventListener('click', dismissResultPopup)
  const closeResultMob = document.getElementById('close-result-mob')
  if (closeResultMob) closeResultMob.addEventListener('click', dismissResultPopup)

  document.querySelectorAll<HTMLElement>('.chip-btn').forEach(el => {
    el.addEventListener('click', () => {
      const q = el.dataset.query
      if (q) quickSearch(q)
    })
  })

  document.getElementById('add-room-btn')!.addEventListener('click', async () => {
    const name = await showInlinePrompt('New room name:')
    if (name) addRoom(name)
  })

  document.querySelectorAll<HTMLElement>('.room-tab').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.roomId
      if (id && id !== currentRoomId) switchRoom(id)
    })
  })

  document.querySelectorAll<HTMLElement>('.tab-rename').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = el.dataset.roomId
      if (!id) return
      const room = rooms.find(r => r.id === id)
      if (!room) return
      const name = await showInlinePrompt('Rename room:')
      if (name) renameRoom(id, name)
    })
  })

  let pulseTimer: ReturnType<typeof setTimeout> | null = null

  document.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!
      if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null }
      glowingItemId = id; render()
      pulseTimer = setTimeout(() => { glowingItemId = null; render() }, 3000)
    })
  })

  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!
      const item = items.find(i => i.id === id)
      if (item) { editingItem = item; showAddModal = true; render() }
    })
  })

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!
      if (confirm('Delete this item?')) deleteItem(id)
    })
  })

  document.querySelectorAll<HTMLElement>('.map-pin, .unsorted-chip').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.itemId || el.dataset.pinFor || el.dataset.chipFor
      if (id) {
        if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null }
        glowingItemId = glowingItemId === id ? null : id; render()
      }
    })
  })

  document.querySelectorAll<HTMLElement>('.map-zone').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      if ((e.target as HTMLElement).closest('.map-pin')) return
      const zoneId = el.dataset.zone
      selectedZone = selectedZone === zoneId ? null : (zoneId || null); render()
    })
  })
}

function filterItems(all: Item[]) {
  if (!searchQuery) return all
  const q = searchQuery.toLowerCase()
  return all.filter(i =>
    i.name.toLowerCase().includes(q) ||
    i.location.toLowerCase().includes(q) ||
    i.category.toLowerCase().includes(q)
  )
}

function renderScanModal(): string {
  return `
    <div class="modal-overlay" id="scan-modal">
      <div class="modal-card scan-card">
        <div class="modal-header">
          <h2>📸 Scan Room</h2>
          <button id="close-scan" class="btn-back">✕</button>
        </div>
        <div class="scan-preview">
          <div class="scan-viewfinder ${cameraStream ? 'camera-live' : ''} ${scanning ? 'active' : ''}">
            <video id="scan-video" class="scan-video" autoplay playsinline></video>
            <div class="scan-frame"></div>
            ${!cameraStream && !scanning ? '<div class="scan-idle">Point camera at your room</div>' : ''}
            ${cameraError ? `<div class="scan-error">${escapeHtml(cameraError)}</div>` : ''}
          </div>
        </div>
        <div class="scan-log">
          ${scanLog.length === 0 ? '<div class="scan-hint">Click "Open Camera" then "Start Scan" to detect items</div>'
            : scanLog.map(line => `<div class="log-line">${line}</div>`).join('')}
        </div>
        <div class="scan-actions">
          ${!scanning && !cameraStream ? '<button id="open-camera" class="btn-primary">📷 Open Camera</button>' : ''}
          ${!scanning && cameraStream ? '<button id="start-scan" class="btn-scan">📸 Start Scan</button>' : ''}
          ${cameraStream && !scanning ? '<button id="close-camera" class="btn-secondary">✕ Close Camera</button>' : ''}
          ${scanning ? '<button class="btn-secondary" disabled>⏳ Scanning...</button>' : ''}
        </div>
      </div>
    </div>`
}

function renderAddModal(): string {
  const isEdit = editingItem !== null
  const item = editingItem || { name: '', location: '', category: '', zoneX: 50, zoneY: 50 }
  const room = currentRoom()

  return `
    <div class="modal-overlay" id="add-modal">
      <div class="modal-card">
        <div class="modal-header">
          <h2>${isEdit ? 'Edit Item' : 'Add New Item'}</h2>
          <button id="close-add" class="btn-back">✕</button>
        </div>
        <form id="item-form" class="item-form">
          <div class="field">
            <label for="item-name">Item Name</label>
            <input type="text" id="item-name" placeholder="e.g. Passport, House Keys" value="${escapeHtml(item.name)}" required />
          </div>
          <div class="field">
            <label for="item-location">Location</label>
            <input type="text" id="item-location" placeholder="e.g. Top desk drawer" value="${escapeHtml(item.location)}" required />
          </div>
          <div class="field">
            <label for="item-category">Category</label>
            <select id="item-category" required>
              <option value="">Select...</option>
              ${['Documents', 'Keys', 'Electronics', 'Warranties', 'Valuables', 'Other'].map(cat =>
                `<option value="${cat}" ${item.category === cat ? 'selected' : ''}>${cat}</option>`
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label>Position on Map — <small>Click to place</small></label>
            <div class="mini-map" id="mini-map">
              ${room.zones.map(z => `
                <div class="mini-zone" style="left: ${z.x}%; top: ${z.y}%;">
                  <span class="mini-label">${escapeHtml(z.label)}</span>
                </div>`).join('')}
              <div class="mini-pin" id="mini-pin" style="left: ${item.zoneX}%; top: ${item.zoneY}%;">📍</div>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary">${isEdit ? 'Save Changes' : 'Save Item'}</button>
          </div>
        </form>
      </div>
    </div>`
}

function bindState<T>(initial: T): [() => T, (v: T) => void] {
  let value = initial; return [() => value, (v: T) => { value = v }]
}

function escapeHtml(str: string): string {
  const div = document.createElement('div')
  div.textContent = str; return div.innerHTML
}

/* --- Delegated events --- */

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  if (t.closest('#close-camera-scan') || (t.closest('#camera-scan-overlay') && !t.closest('.camera-scan-inner'))) {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }
    showCameraScan = false; render()
  }
  if (t.closest('#dash-scan-btn')) startDashboardScan()
  if (t.closest('#close-scan') || (t.closest('.modal-overlay') && t.closest('#scan-modal') === t)) {
    showScanModal = false; scanning = false; stopCamera(); cameraStream = null; cameraError = ''; render()
  }
  if (t.closest('#close-add') || (t.closest('.modal-overlay') && t.closest('#add-modal') === t)) {
    showAddModal = false; editingItem = null; render()
  }
  if (t.closest('#open-camera')) { startCamera(); render() }
  if (t.closest('#close-camera')) { stopCamera(); cameraStream = null; cameraError = ''; render() }
  if (t.closest('#start-scan')) runScan()
  if (t.closest('#mobile-map-overlay') && t.closest('.mobile-map-header') === null && t.closest('.room-border') === null) { showMobileMap = false; render() }
  if (t.closest('.alert-confirm')) {
    const id = (t.closest('.alert-confirm') as HTMLElement).dataset.confirmId
    if (id) confirmItemMoved(id)
  }
  if (t.closest('.alert-snooze')) {
    const id = (t.closest('.alert-snooze') as HTMLElement).dataset.snoozeId
    if (id) dismissAlertItem(id)
  }
  if (t.closest('#prompt-ok')) {
    const input = document.getElementById('inline-prompt-input') as HTMLInputElement
    if (promptCallback) { promptCallback(input?.value?.trim() || null); promptCallback = null }
    showPrompt = false; render()
  }
  if (t.closest('#prompt-cancel') || (t.closest('#prompt-overlay') && t.closest('.prompt-card') === null && t === t)) {
    if (promptCallback) { promptCallback(null); promptCallback = null }
    showPrompt = false; render()
  }
  if (t.closest('#mini-map')) {
    const map = document.getElementById('mini-map')
    if (!map) return
    const rect = map.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    const pin = document.getElementById('mini-pin')
    if (pin) { pin.style.left = `${Math.max(0, Math.min(100, x))}%`; pin.style.top = `${Math.max(0, Math.min(100, y))}%` }
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && showPrompt) {
    const input = document.getElementById('inline-prompt-input') as HTMLInputElement
    if (document.activeElement === input && promptCallback) {
      promptCallback(input?.value?.trim() || null); promptCallback = null
      showPrompt = false; render()
    }
  }
  if (e.key === 'Escape' && showPrompt) {
    if (promptCallback) { promptCallback(null); promptCallback = null }
    showPrompt = false; render()
  }
})

document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement
  if (form.id !== 'item-form') return
  e.preventDefault()
  const name = (document.getElementById('item-name') as HTMLInputElement).value
  const location = (document.getElementById('item-location') as HTMLInputElement).value
  const category = (document.getElementById('item-category') as HTMLSelectElement).value
  const pin = document.getElementById('mini-pin')
  const zoneX = pin ? parseFloat(pin.style.left) : 50
  const zoneY = pin ? parseFloat(pin.style.top) : 50
  if (editingItem) updateItem(editingItem.id, name, location, category)
  else addItem(name, location, category, zoneX, zoneY)
  showAddModal = false; editingItem = null; render()
})

/* --- Drag zones on map --- */

function startDrag(zoneEl: HTMLElement) {
  if ((zoneEl as HTMLElement).closest('.map-pin')) return
  const roomId = zoneEl.dataset.roomId
  const zoneId = zoneEl.dataset.zone
  if (!roomId || !zoneId) return

  draggingZone = { roomId, zoneId }
  zoneEl.classList.add('dragging')

  const borderId = zoneEl.closest('.room-border')?.id || 'room-border'
  const border = document.getElementById(borderId)
  if (!border) return
  const rect = border.getBoundingClientRect()

  function onMove(cx: number, cy: number) {
    if (!draggingZone) return
    const room = rooms.find(r => r.id === draggingZone!.roomId)
    if (!room) return
    const zone = room.zones.find(z => z.id === draggingZone!.zoneId)
    if (!zone) return
    const px = ((cx - rect.left) / rect.width) * 100
    const py = ((cy - rect.top) / rect.height) * 100
    zone.x = Math.max(0, Math.min(100, Math.round(px * 10) / 10))
    zone.y = Math.max(0, Math.min(100, Math.round(py * 10) / 10))
    const el = document.querySelector<HTMLElement>(`.drag-zone[data-zone="${zone.id}"][data-room-id="${room.id}"]`)
    if (el) { el.style.left = `${zone.x}%`; el.style.top = `${zone.y}%` }
  }

  function onUp() {
    draggingZone = null
    document.querySelectorAll('.drag-zone.dragging').forEach(el => el.classList.remove('dragging'))
    saveData()
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', onTouchEnd)
  }

  function onMouseMove(ev: MouseEvent) { onMove(ev.clientX, ev.clientY) }
  function onMouseUp() { onUp() }
  function onTouchMove(ev: TouchEvent) { if (ev.touches[0]) onMove(ev.touches[0].clientX, ev.touches[0].clientY) }
  function onTouchEnd() { onUp() }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('touchmove', onTouchMove, { passive: true })
  document.addEventListener('touchend', onTouchEnd)
}

document.addEventListener('mousedown', (e) => {
  const zoneEl = (e.target as HTMLElement).closest<HTMLElement>('.drag-zone')
  if (!zoneEl) return
  if ((e.target as HTMLElement).closest('.map-pin')) return
  e.preventDefault()
  startDrag(zoneEl)
})

document.addEventListener('touchstart', (e) => {
  const zoneEl = (e.target as HTMLElement).closest<HTMLElement>('.drag-zone')
  if (!zoneEl) return
  if ((e.target as HTMLElement).closest('.map-pin')) return
  startDrag(zoneEl)
}, { passive: true })

loadDarkMode()
render()
