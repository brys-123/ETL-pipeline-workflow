import { showToast } from './app.js'

const STORAGE_KEY = 'simple-etl-appearance-v1'
const DEFAULTS = {
  theme: 'system',
  canvasStyle: 'dots',
  showGrid: true,
  snapToGrid: false,
  nodeStyle: 'comfortable',
  density: 'comfortable',
  contrast: 'normal',
}
const allowed = {
  theme: ['light', 'dark', 'system'],
  canvasStyle: ['dots', 'grid', 'plain'],
  nodeStyle: ['comfortable', 'compact'],
  density: ['comfortable', 'compact'],
  contrast: ['normal', 'high'],
}
let preferences = { ...DEFAULTS }

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved appearance settings are invalid.')
    return {
      ...DEFAULTS,
      ...Object.fromEntries(Object.entries(allowed).map(([key, values]) => [
        key === 'canvasStyle' ? 'canvasStyle' : key,
        values.includes(saved[key]) ? saved[key] : DEFAULTS[key],
      ])),
      showGrid: typeof saved.showGrid === 'boolean' ? saved.showGrid : DEFAULTS.showGrid,
      snapToGrid: typeof saved.snapToGrid === 'boolean' ? saved.snapToGrid : DEFAULTS.snapToGrid,
    }
  } catch (error) {
    showToast(`Saved appearance settings could not be read; defaults are in use. ${error.message}`, 'error')
    return { ...DEFAULTS }
  }
}

function applyPreferences() {
  const root = document.documentElement
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = preferences.theme === 'system'
    ? (systemDark ? 'dark' : 'light')
    : preferences.theme
  root.dataset.theme = theme
  root.dataset.themeMode = preferences.theme
  root.dataset.canvasStyle = preferences.canvasStyle
  root.dataset.showCanvasGrid = String(preferences.showGrid)
  root.dataset.snapToGrid = String(preferences.snapToGrid)
  root.dataset.nodeAppearance = preferences.nodeStyle
  root.dataset.interfaceDensity = preferences.density
  root.dataset.canvasContrast = preferences.contrast
  root.style.colorScheme = theme
  const themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.content = theme === 'dark' ? '#10241a' : '#164E38'
  window.dispatchEvent(new CustomEvent('app:appearance-change', { detail: { theme } }))
}

function persistPreferences() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
    applyPreferences()
    document.getElementById('appearance-status').textContent = 'Appearance preferences saved.'
  } catch (error) {
    showToast(`Appearance preferences could not be saved: ${error.message}`, 'error')
  }
}

function setControlValues() {
  document.getElementById('appearance-theme').value = preferences.theme
  document.getElementById('appearance-canvas-style').value = preferences.canvasStyle
  document.getElementById('appearance-node-style').value = preferences.nodeStyle
  document.getElementById('appearance-density').value = preferences.density
  document.getElementById('appearance-contrast').value = preferences.contrast
  document.getElementById('appearance-show-grid').checked = preferences.showGrid
  document.getElementById('appearance-snap-grid').checked = preferences.snapToGrid
}

export function initAppearanceSettings() {
  preferences = readPreferences()
  applyPreferences()
  setControlValues()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preferences.theme === 'system') applyPreferences()
  })

  const controls = {
    'appearance-theme': ['theme', 'value'],
    'appearance-canvas-style': ['canvasStyle', 'value'],
    'appearance-node-style': ['nodeStyle', 'value'],
    'appearance-density': ['density', 'value'],
    'appearance-contrast': ['contrast', 'value'],
    'appearance-show-grid': ['showGrid', 'checked'],
    'appearance-snap-grid': ['snapToGrid', 'checked'],
  }
  for (const [id, [key, property]] of Object.entries(controls)) {
    document.getElementById(id).addEventListener('change', (event) => {
      preferences[key] = event.currentTarget[property]
      persistPreferences()
    })
  }
  document.getElementById('appearance-reset').addEventListener('click', () => {
    preferences = {
      ...preferences,
      canvasStyle: DEFAULTS.canvasStyle,
      showGrid: DEFAULTS.showGrid,
      snapToGrid: DEFAULTS.snapToGrid,
      nodeStyle: DEFAULTS.nodeStyle,
      contrast: DEFAULTS.contrast,
    }
    setControlValues()
    persistPreferences()
    showToast('Canvas appearance reset to its defaults.')
  })
}
