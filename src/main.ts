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
  currentUser = null; items = []; rooms = []; authError = ''; navigate('auth')
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
  if (!SpeechRecognition) { alert('Voice search is not supported in this browser. Try Chrome or Edge.'); return }
  if (isListening) return
  isListening = true
  const recognition = new SpeechRecognition()
  recognition.lang = 'en-US'
  recognition.interimResults = false
  recognition.maxAlternatives = 1
  recognition.onresult = (event: any) => {
    const transcript = event.results[0][0].transcript
    searchQuery = transcript
    isListening = false
    handleSearch()
    render()
  }
  recognition.onerror = () => { isListening = false; render() }
  recognition.onend = () => { isListening = false; render() }
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

function runScan() {
  scanning = true
  scanLog = ['📸 Initializing camera...', '🔍 Scanning room...']
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

function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  if (currentPage === 'auth') renderAuth(app)
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
            <button id="dark-btn" class="btn-icon" title="Toggle dark mode">${darkMode ? '☀️' : '🌙'}</button>
            <button id="scan-btn" class="btn-scan ${scanning ? 'scanning' : ''}">📸 Scan Room</button>
            <button id="add-btn" class="btn-primary">+ Add Item</button>
            <button id="signout-btn" class="btn-secondary">Sign Out</button>
          </div>
        </div>
        ${stale.length > 0 ? `
          <div class="alert-banner">
            <span class="alert-icon">🔔</span>
            <span>${stale.length} item${stale.length > 1 ? 's' : ''} haven't been seen in 3+ days.</span>
            <button id="dismiss-alerts" class="alert-dismiss">✕</button>
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

      ${showScanModal ? renderScanModal() : ''}
      ${showAddModal ? renderAddModal() : ''}
      ${showConfetti ? '<div class="confetti-container">' + Array.from({length: 8}, (_, i) => `<div class="confetti-piece" style="animation-delay: ${i * 0.08}s; left: ${10 + i * 10}%; background: ${['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'][i]}"></div>`).join('') + '</div>' : ''}

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
                  <div class="snapshot-placeholder">
                    <span class="snapshot-icon">📸</span>
                    <span>Last scan snapshot</span>
                    <small>${escapeHtml(timeAgo(resultItem.lastConfirmed))}</small>
                  </div>
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
                  return `
                    <div class="map-zone drag-zone ${selectedZone === zone.id ? 'active' : ''}"
                         data-zone="${zone.id}"
                         data-room-id="${room.id}"
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
    </div>`

  document.getElementById('dark-btn')!.addEventListener('click', toggleDarkMode)
  document.getElementById('scan-btn')!.addEventListener('click', () => { showScanModal = true; showAddModal = false; render() })
  document.getElementById('add-btn')!.addEventListener('click', () => { showAddModal = true; showScanModal = false; editingItem = null; render() })
  document.getElementById('signout-btn')!.addEventListener('click', signOut)

  const micBtn = document.getElementById('mic-btn')
  if (micBtn) micBtn.addEventListener('click', startVoiceSearch)

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

  document.querySelectorAll<HTMLElement>('.chip-btn').forEach(el => {
    el.addEventListener('click', () => {
      const q = el.dataset.query
      if (q) quickSearch(q)
    })
  })

  document.getElementById('add-room-btn')!.addEventListener('click', () => {
    const name = prompt('New room name:')?.trim()
    if (name) addRoom(name)
  })

  document.querySelectorAll<HTMLElement>('.room-tab').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.roomId
      if (id && id !== currentRoomId) switchRoom(id)
    })
  })

  document.querySelectorAll<HTMLElement>('.tab-rename').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = el.dataset.roomId
      if (!id) return
      const room = rooms.find(r => r.id === id)
      if (!room) return
      const name = prompt('Rename room:', room.name)?.trim()
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
          <div class="scan-viewfinder ${scanning ? 'active' : ''}">
            <div class="scan-frame"></div>
            ${!scanning ? '<div class="scan-idle">Point camera at your room</div>' : ''}
          </div>
        </div>
        <div class="scan-log">
          ${scanLog.length === 0 ? '<div class="scan-hint">Click "Start Scan" to detect items</div>'
            : scanLog.map(line => `<div class="log-line">${line}</div>`).join('')}
        </div>
        <div class="scan-actions">
          ${!scanning ? '<button id="start-scan" class="btn-scan">📸 Start Scan</button>' : ''}
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
  if (t.closest('#close-scan') || (t.closest('.modal-overlay') && t.closest('#scan-modal') === t)) {
    showScanModal = false; scanning = false; render()
  }
  if (t.closest('#close-add') || (t.closest('.modal-overlay') && t.closest('#add-modal') === t)) {
    showAddModal = false; editingItem = null; render()
  }
  if (t.closest('#start-scan')) runScan()
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

document.addEventListener('mousedown', (e) => {
  const zoneEl = (e.target as HTMLElement).closest<HTMLElement>('.drag-zone')
  if (!zoneEl) return
  if ((e.target as HTMLElement).closest('.map-pin')) return

  e.preventDefault()
  const roomId = zoneEl.dataset.roomId
  const zoneId = zoneEl.dataset.zone
  if (!roomId || !zoneId) return

  draggingZone = { roomId, zoneId }
  zoneEl.classList.add('dragging')

  const border = document.getElementById('room-border')
  if (!border) return
  const rect = border.getBoundingClientRect()

  function onMove(ev: MouseEvent) {
    if (!draggingZone) return
    const room = rooms.find(r => r.id === draggingZone!.roomId)
    if (!room) return
    const zone = room.zones.find(z => z.id === draggingZone!.zoneId)
    if (!zone) return
    const px = ((ev.clientX - rect.left) / rect.width) * 100
    const py = ((ev.clientY - rect.top) / rect.height) * 100
    zone.x = Math.max(0, Math.min(100, Math.round(px * 10) / 10))
    zone.y = Math.max(0, Math.min(100, Math.round(py * 10) / 10))
    const el = document.querySelector<HTMLElement>(`.drag-zone[data-zone="${zone.id}"][data-room-id="${room.id}"]`)
    if (el) { el.style.left = `${zone.x}%`; el.style.top = `${zone.y}%` }
  }

  function onUp() {
    draggingZone = null
    document.querySelectorAll('.drag-zone.dragging').forEach(el => el.classList.remove('dragging'))
    saveData()
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

loadDarkMode()
render()
