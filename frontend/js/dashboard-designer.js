import { api, confirmPermanentDelete, escapeHTML, showToast } from './app.js'

const chartTypes = new Set([
  'bar', 'horizontalBar', 'line', 'area', 'pie', 'donut', 'scatter', 'bubble',
  'stackedBar', 'percentStackedBar', 'histogram', 'radar', 'treemap', 'funnel',
  'waterfall', 'heatmap',
])
const percentageChartTypes = new Set([
  'bar', 'horizontalBar', 'line', 'area', 'pie', 'donut', 'stackedBar', 'percentStackedBar',
])
const aggregationChartTypes = new Set([
  ...percentageChartTypes, 'waterfall', 'radar', 'treemap', 'funnel',
])
const gridLineChartTypes = new Set([
  'bar', 'horizontalBar', 'stackedBar', 'percentStackedBar', 'line', 'area',
  'scatter', 'bubble', 'histogram', 'radar', 'waterfall', 'heatmap',
])
const dataLabelChartTypes = new Set([
  'bar', 'horizontalBar', 'stackedBar', 'percentStackedBar', 'line', 'area',
  'pie', 'donut', 'histogram', 'radar', 'treemap', 'funnel', 'waterfall', 'heatmap',
])
const chartPalettes = {
  forest: ['#174D35', '#206B48', '#26885B', '#34A36B', '#4EBA7E', '#76C996', '#A5DDB8'],
  mint: ['#174D35', '#287A55', '#43A978', '#66C795', '#8AD9AD', '#B3E8C8', '#D5F2E0'],
  monochrome: ['#245B3E', '#38734F', '#4B8A61', '#609F74', '#79B68A', '#95CAA3', '#B8DFC1'],
}
const canvasPresets = {
  'clean-white': { label: 'Clean White', background: '#FFFFFF', cardBackground: '#FFFFFF', textColor: '#174D35', secondaryColor: '#486B55', style: 'solid', padding: 28, gap: 14, radius: 8, shadows: true },
  'soft-mint': { label: 'Soft Mint', background: '#F1F8F3', cardBackground: '#FFFFFF', textColor: '#174D35', secondaryColor: '#486B55', style: 'soft-gradient', padding: 28, gap: 14, radius: 10, shadows: true },
  'minimal-light': { label: 'Minimal Light', background: '#F7F9F7', cardBackground: '#FFFFFF', textColor: '#20372A', secondaryColor: '#617568', style: 'solid', padding: 24, gap: 12, radius: 4, shadows: false },
  'professional-green': { label: 'Professional Green', background: '#EAF3ED', cardBackground: '#FFFFFF', textColor: '#174D35', secondaryColor: '#486B55', style: 'soft-gradient', padding: 30, gap: 16, radius: 12, shadows: true },
  'dark-analytics': { label: 'Dark Analytics', background: '#122219', cardBackground: '#1A3023', textColor: '#E4F1E8', secondaryColor: '#B4CABB', style: 'solid', padding: 28, gap: 14, radius: 10, shadows: false },
  'executive-report': { label: 'Executive Report', background: '#F5F8F5', cardBackground: '#FFFFFF', textColor: '#173B2A', secondaryColor: '#52685A', style: 'solid', padding: 36, gap: 18, radius: 6, shadows: false },
  'modern-glass': { label: 'Modern Glass', background: '#E8F3EC', cardBackground: '#F8FCF9', textColor: '#174D35', secondaryColor: '#486B55', style: 'soft-gradient', padding: 30, gap: 16, radius: 16, shadows: true },
  'executive-analytics': { label: 'Executive Analytics', background: '#F4F7F5', cardBackground: '#FFFFFF', textColor: '#183B2B', secondaryColor: '#52685A', style: 'solid', padding: 34, gap: 16, radius: 8, shadows: false },
  'modern-gradient': { label: 'Modern Gradient', background: '#E9F5EF', cardBackground: '#FFFFFF', textColor: '#174D35', secondaryColor: '#486B55', style: 'soft-gradient', padding: 30, gap: 16, radius: 14, shadows: true },
  'soft-gradient': { label: 'Soft Gradient', background: '#EEF7F1', cardBackground: '#FFFFFF', textColor: '#174D35', secondaryColor: '#486B55', style: 'soft-gradient', padding: 28, gap: 14, radius: 12, shadows: true },
  'data-focused': { label: 'Data Focused', background: '#F8FAF8', cardBackground: '#FFFFFF', textColor: '#20372A', secondaryColor: '#617568', style: 'solid', padding: 20, gap: 10, radius: 4, shadows: false },
  'high-contrast': { label: 'High Contrast', background: '#FFFFFF', cardBackground: '#FFFFFF', textColor: '#10251A', secondaryColor: '#385343', style: 'solid', padding: 28, gap: 14, radius: 4, shadows: false },
}
const canvasDimensions = {
  standard: [1440, 900],
  widescreen: [1920, 1080],
  presentation: [1600, 900],
  'a4-landscape': [1123, 794],
  'a4-portrait': [794, 1123],
}
const aggregationLabels = {
  sum: 'Sum',
  average: 'Average',
  count: 'Count',
  min: 'Minimum',
  max: 'Maximum',
  percentage: 'Percentage',
}
const templates = {
  sales: [['kpi', 'Total sales'], ['bar', 'Sales by category'], ['line', 'Sales trend'], ['table', 'Sales details']],
  finance: [['kpi', 'Total amount'], ['area', 'Financial trend'], ['waterfall', 'Amount changes'], ['table', 'Financial records']],
  inventory: [['kpi', 'Items in dataset'], ['treemap', 'Inventory by category'], ['bar', 'Stock by category'], ['table', 'Inventory details']],
  general: [['kpi', 'Rows in dataset'], ['bar', 'Values by category'], ['line', 'Dataset trend'], ['table', 'Dataset records']],
}
const labels = {
  bar: 'Bar Chart', horizontalBar: 'Horizontal Bar', stackedBar: 'Stacked Bar',
  percentStackedBar: '100% Stacked Bar', line: 'Line Chart', area: 'Area Chart',
  pie: 'Pie Chart', donut: 'Donut Chart', scatter: 'Scatter Plot', bubble: 'Bubble Chart',
  histogram: 'Histogram', radar: 'Radar Chart', treemap: 'Treemap', funnel: 'Funnel Chart',
  waterfall: 'Waterfall', heatmap: 'Heatmap', kpi: 'KPI Card', table: 'Data Table',
  text: 'Text / Heading', image: 'Image', divider: 'Divider', filter: 'Filter Control', section: 'Section',
}
const state = {
  dashboard: blankDashboard(), datasets: [], dataset: null, columns: [], schema: [], rows: [],
  charts: new Map(), chartResizeObserver: null,
  selectedId: null, saved: [], undo: [], redo: [], rendering: false, filters: {},
  selectedDashboardIds: new Set(), componentInteraction: null,
}

function blankDashboard() {
  return {
    name: 'Untitled dashboard',
    dataset_id: '',
    subtitle: 'Select a dataset and add visualizations to get started.',
    eyebrow: 'DATA INSIGHTS',
    theme: { accent: '#206B48', surface: '#FFFFFF', text: '#174D35', secondary: '#486B55', palette: 'forest' },
    canvas: {
      preset: 'soft-mint',
      dimensions: 'standard',
      width: 1440,
      height: 900,
      background: '#F1F8F3',
      cardBackground: '#FFFFFF',
      textColor: '#174D35',
      secondaryColor: '#486B55',
      style: 'soft-gradient',
      padding: 28,
      gap: 14,
      radius: 10,
      shadows: true,
      grid: true,
      alignment: 'center',
    },
    components: [],
  }
}

function defaultComponentSize(type) {
  if (type === 'kpi') return { width: 3, height: 125 }
  if (type === 'table') return { width: 12, height: 320 }
  if (type === 'pie' || type === 'donut') return { width: 4, height: 250 }
  if (type === 'filter') return { width: 3, height: 84 }
  if (['text', 'image', 'section'].includes(type)) return { width: 6, height: 180 }
  if (type === 'divider') return { width: 12, height: 80 }
  return { width: 6, height: 255 }
}

function findComponentPosition(width, height, placed = state.dashboard.components) {
  const safeWidth = Math.max(1, Math.min(12, Number(width) || 6))
  const safeHeight = Math.max(90, Number(height) || 255)
  const maxY = placed.reduce((maximum, item) => Math.max(maximum, Number(item.position?.y) + Number(item.height || 255)), 0)
  for (let y = 0; y <= maxY + safeHeight + 20; y += 20) {
    for (let x = 0; x <= 12 - safeWidth; x += 1) {
      const overlap = placed.some((item) => {
        const itemX = Number(item.position?.x) || 0
        const itemY = Number(item.position?.y) || 0
        return x < itemX + Number(item.width || 6)
          && x + safeWidth > itemX
          && y < itemY + Number(item.height || 255)
          && y + safeHeight > itemY
      })
      if (!overlap) return { x, y }
    }
  }
  return { x: 0, y: maxY + 20 }
}

function arrangeComponents(components) {
  const placed = []
  for (const component of components) {
    component.position = findComponentPosition(component.width, component.height, placed)
    component.z_index = placed.length
    component.layout_section ||= 'main'
    placed.push(component)
  }
}

function makeComponent(type, schema = []) {
  const dimension = schema.find((column) => column.kind !== 'numeric')?.name || ''
  const measure = schema.find((column) => column.kind === 'numeric')?.name || ''
  const size = defaultComponentSize(type)
  return {
    id: crypto.randomUUID(),
    type,
    title: labels[type] || 'Visualization',
    width: size.width,
    height: size.height,
    position: { x: 0, y: 0 },
    z_index: state.dashboard.components.length,
    layout_section: 'main',
    visible: true,
    appearance: { background: '', padding: 12, radius: 8, shadow: true, justify: 'stretch', align: 'stretch' },
    config: {
      dimension,
      measure,
      measure2: schema.find((column) => column.kind === 'numeric' && column.name !== measure)?.name || measure,
      sizeMeasure: type === 'bubble' ? measure : '',
      aggregation: measure ? 'sum' : 'count',
      percentageMode: type === 'stackedBar' || type === 'percentStackedBar' ? 'category' : 'total',
      showDataLabels: type === 'pie' || type === 'donut',
      showPercentage: type === 'pie' || type === 'donut',
      showTooltips: true,
      showPercentageInTooltip: type === 'pie' || type === 'donut',
      showGridLines: true,
      decimalPrecision: 1,
      numberFormat: 'standard',
      chartBackground: 'transparent',
      chartPalette: 'forest',
      titleSize: 13,
      axisLabelSize: 9,
      axisLabelColor: '',
      gridLineColor: '',
      barThickness: 28,
      barSpacing: 35,
      barRadius: 4,
      lineThickness: 2.5,
      showMarkers: true,
      smooth: true,
      donutHoleSize: 40,
      sliceSpacing: 2,
      areaOpacity: 20,
      chartPadding: 8,
      chartBorder: false,
      showLegend: true,
      legendPosition: 'bottom',
      legendOrientation: 'horizontal',
      legendTextSize: 9,
      legendAlign: 'center',
      legendItemSpacing: 10,
      filterMode: 'categorical',
      searchable: true,
      text: 'Add a heading or helpful context for your dashboard.',
      headingLevel: 'h2',
      columns: [],
      bins: 8,
    },
  }
}

function safeDashboard(value) {
  const dashboard = value?.dashboard || value
  if (!dashboard || typeof dashboard !== 'object') throw new Error('The saved dashboard response is invalid.')
  const defaults = blankDashboard()
  const savedCanvas = dashboard.canvas && typeof dashboard.canvas === 'object' ? dashboard.canvas : {}
  const savedTheme = dashboard.theme && typeof dashboard.theme === 'object' ? dashboard.theme : {}
  const canvas = {
    ...defaults.canvas,
    ...savedCanvas,
    cardBackground: savedCanvas.cardBackground || savedTheme.surface || defaults.canvas.cardBackground,
    textColor: savedCanvas.textColor || savedTheme.text || defaults.canvas.textColor,
    secondaryColor: savedCanvas.secondaryColor || savedTheme.secondary || defaults.canvas.secondaryColor,
  }
  const savedComponents = Array.isArray(dashboard.components) ? dashboard.components : []
  const legacyGridLayout = savedComponents.every((component, index) => (
    !component.position || typeof component.position !== 'object'
      || (Number(component.position.x) === 0 && Number(component.position.y) === index)
  ))
  const components = savedComponents.map((component, index) => {
    const componentDefaults = makeComponent(component.type || 'bar')
    const size = defaultComponentSize(component.type || 'bar')
    const legacySize = component.size === 'small'
      ? { width: 4, height: 240 }
      : component.size === 'large' ? { width: 12, height: 390 } : size
    const width = Math.max(1, Math.min(12, Number(component.width ?? legacySize.width) || legacySize.width))
    return {
      ...componentDefaults,
      ...component,
      width,
      height: Math.max(component.type === 'filter' ? 42 : 90, Math.min(1200, Number(component.height ?? legacySize.height) || legacySize.height)),
      z_index: Number.isFinite(Number(component.z_index)) ? Number(component.z_index) : index,
      layout_section: typeof component.layout_section === 'string' ? component.layout_section : 'main',
      position: {
        x: Math.max(0, Math.min(12 - width, Math.round(Number(component.position?.x) || 0))),
        y: Math.max(0, Math.min(100_000, Math.round(Number(component.position?.y) || 0))),
      },
      appearance: { ...componentDefaults.appearance, ...(component.appearance || {}) },
      config: { ...componentDefaults.config, ...(component.config || {}) },
    }
  })
  if (legacyGridLayout) arrangeComponents(components)
  return {
    ...defaults,
    ...dashboard,
    id: dashboard.id || dashboard.dashboard_id,
    name: dashboard.name || 'Untitled dashboard',
    theme: { ...defaults.theme, ...savedTheme },
    canvas,
    components,
  }
}

function recordList(payload) {
  if (Array.isArray(payload)) return payload
  return payload?.datasets || payload?.files || payload?.items || []
}

function schemaList(payload) {
  return Array.isArray(payload?.schema) ? payload.schema : (Array.isArray(payload?.columns) ? payload.columns.map((name) => ({ name, kind: 'text' })) : [])
}

function asRows(payload) {
  if (Array.isArray(payload?.rows) && Array.isArray(payload?.columns)) {
    return payload.rows.map((row) => Array.isArray(row)
      ? Object.fromEntries(payload.columns.map((column, index) => [column, row[index]]))
      : row)
  }
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function setStatus(message) {
  document.getElementById('designer-status').textContent = message
}

function pushUndo() {
  state.undo.push(JSON.stringify(state.dashboard))
  if (state.undo.length > 40) state.undo.shift()
  state.redo = []
  updateHistoryButtons()
  setStatus('Unsaved changes')
}

function updateHistoryButtons() {
  document.getElementById('designer-undo').disabled = state.undo.length === 0
  document.getElementById('designer-redo').disabled = state.redo.length === 0
}

function installDashboard(dashboard) {
  state.dashboard = safeDashboard(dashboard)
  state.selectedId = null
  state.undo = []
  state.redo = []
  state.filters = {}
  document.getElementById('designer-name').value = state.dashboard.name
  document.getElementById('dashboard-report-title').textContent = state.dashboard.name
  document.getElementById('dashboard-focus-title').textContent = state.dashboard.name
  document.getElementById('dashboard-report-subtitle').textContent = state.dashboard.subtitle || ''
  renderComponents()
  renderConfig()
  updateHistoryButtons()
}

function setDatasetInfo() {
  const info = state.dataset
    ? `${state.dataset.filename || state.dataset.name || 'Dataset'} · ${state.rows.length.toLocaleString()} preview rows`
    : 'Choose a dataset to begin'
  document.getElementById('designer-dataset-info').textContent = info
}

async function loadDatasets(preselectId = '') {
  const source = document.getElementById('designer-dataset-source')?.value || 'all'
  const payload = await api(`/api/datasets${source === 'all' ? '' : `?source=${encodeURIComponent(source)}`}`)
  state.datasets = recordList(payload)
  const select = document.getElementById('designer-dataset')
  select.replaceChildren(new Option('Select a dataset', ''))
  state.datasets.forEach((dataset) => {
    const id = dataset.file_id || dataset.dataset_id || dataset.id
    if (!id) return
    const option = new Option(`${dataset.filename || dataset.name || id}${dataset.status === 'processed' ? ' · processed' : ' · imported'}`, id)
    select.add(option)
  })
  const selected = preselectId || state.dashboard.dataset_id
  if (selected && state.datasets.some((item) => (item.file_id || item.dataset_id || item.id) === selected)) {
    select.value = selected
    await selectDataset(selected)
  } else {
    select.value = ''
    state.dataset = null
    state.rows = []
    state.schema = []
    state.columns = []
    setDatasetInfo()
  }
}

async function selectDataset(id) {
  if (state.dashboard.dataset_id !== id) pushUndo()
  state.dashboard.dataset_id = id
  state.filters = {}
  state.dataset = state.datasets.find((item) => (item.file_id || item.dataset_id || item.id) === id) || null
  if (!id) {
    state.schema = []
    state.columns = []
    state.rows = []
    renderComponents()
    renderConfig()
    setDatasetInfo()
    return
  }
  setStatus('Loading dataset')
  const [schemaPayload, previewPayload] = await Promise.all([
    api(`/api/datasets/${encodeURIComponent(id)}/schema`),
    api(`/api/datasets/${encodeURIComponent(id)}/preview?page=1&page_size=100`),
  ])
  state.schema = schemaList(schemaPayload)
  state.columns = Array.isArray(previewPayload?.columns)
    ? previewPayload.columns
    : state.schema.map((column) => column.name)
  state.rows = asRows(previewPayload)
  state.dataset = { ...state.dataset, ...schemaPayload }
  setStatus('Unsaved changes')
  setDatasetInfo()
  renderComponents()
  renderConfig()
}

function snapshotRows() {
  return state.rows.filter((row) => Object.entries(state.filters).every(([componentId, filter]) => {
    const component = state.dashboard.components.find((item) => item.id === componentId)
    if (!component || !filter) return true
    const value = row[component.config.dimension]
    if (filter.mode === 'categorical' && filter.value) return filterFieldValue(value) === filter.value
    if (filter.mode === 'multi' && filter.values?.length) return filter.values.includes(filterFieldValue(value))
    if (filter.mode === 'numeric') {
      const number = Number(value)
      if (filter.min === '' && filter.max === '') return true
      if (!Number.isFinite(number)) return false
      return (filter.min === '' || number >= Number(filter.min)) && (filter.max === '' || number <= Number(filter.max))
    }
    if (filter.mode === 'date') {
      if (!filter.from && !filter.to) return true
      const date = new Date(value)
      if (Number.isNaN(date.valueOf())) return false
      return (!filter.from || date >= new Date(filter.from)) && (!filter.to || date <= new Date(`${filter.to}T23:59:59`))
    }
    return true
  }))
}

function fieldOptions(selected, kind = 'any') {
  const columns = state.schema.length ? state.schema : state.columns.map((name) => ({ name, kind: 'text' }))
  const available = kind === 'numeric' ? columns.filter((column) => column.kind === 'numeric') : columns
  const selectedAvailable = available.some((column) => column.name === selected)
  const unavailable = selected && !selectedAvailable
    ? `<option value="${escapeHTML(selected)}" selected>${escapeHTML(state.columns.includes(selected) ? `${selected} (not numeric)` : `Missing field: ${selected}`)}</option>`
    : ''
  const options = available.map((column) => `<option value="${escapeHTML(column.name)}"${column.name === selected ? ' selected' : ''}>${escapeHTML(column.name)}</option>`).join('')
  return `<option value="">${kind === 'numeric' ? 'Select numeric field' : 'Select a field'}</option>${unavailable}${options}`
}

function chartFieldIssues(component) {
  if (!state.columns.length) return []
  const { type, config } = component
  const issues = []
  const check = (key, label, { required = true, numeric = false } = {}) => {
    const value = config[key]
    if (!value) {
      if (required) issues.push(`Select a ${label}.`)
      return
    }
    if (!state.columns.includes(value)) {
      issues.push(`The saved ${label} "${value}" is not in this dataset. Choose an available field.`)
      return
    }
    if (numeric && state.schema.length && !state.schema.some((column) => column.name === value && column.kind === 'numeric')) {
      issues.push(`The selected ${label} "${value}" is not numeric. Choose a numeric field.`)
    }
  }
  if (type !== 'histogram') check('dimension', 'category field')
  if (type === 'scatter' || type === 'bubble') {
    check('measure2', 'X-axis field', { numeric: true })
    check('measure', 'Y-axis field', { numeric: true })
  } else {
    const measureRequired = !aggregationChartTypes.has(type) || config.aggregation !== 'count'
    check('measure', 'value field', {
      required: measureRequired,
      numeric: config.aggregation !== 'count',
    })
  }
  if (type === 'heatmap') check('measure2', 'second category field')
  if (type === 'stackedBar' || type === 'percentStackedBar') check('seriesField', 'series field')
  if (type === 'bubble') check('sizeMeasure', 'bubble size field', { numeric: true })
  return issues
}

function aggregationTitle(config, measure = config.measure) {
  const method = aggregationLabels[config.aggregation] || 'Value'
  return config.aggregation === 'count' && !measure
    ? 'Row count'
    : `${method}${measure ? ` of ${measure}` : ''}`
}

function configField(label, key, value, options = {}) {
  const id = `config-${key}`
  let input
  if (options.choices) {
    input = `<select id="${id}" data-config-key="${key}">${options.choices.map(([choice, title]) => `<option value="${escapeHTML(choice)}"${value === choice ? ' selected' : ''}>${escapeHTML(title)}</option>`).join('')}</select>`
  } else if (options.field) {
    input = `<select id="${id}" data-config-key="${key}">${fieldOptions(value, options.field)}</select>`
  } else if (options.multiline) {
    input = `<textarea id="${id}" data-config-key="${key}" maxlength="3000">${escapeHTML(value || '')}</textarea>`
  } else {
    input = `<input id="${id}" data-config-key="${key}" type="${options.type || 'text'}" value="${escapeHTML(value ?? '')}"${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}${options.step !== undefined ? ` step="${options.step}"` : ''}>`
  }
  return `<label class="designer-config-field">${escapeHTML(label)}${input}</label>`
}

function configToggle(label, key, checked) {
  return `<label class="designer-config-field designer-config-toggle">${escapeHTML(label)}<input id="config-${key}" data-config-key="${key}" type="checkbox"${checked ? ' checked' : ''}></label>`
}

function renderConfig() {
  const content = document.getElementById('designer-config-content')
  const component = state.dashboard.components.find((item) => item.id === state.selectedId)
  document.getElementById('designer-config-title').textContent = component ? labels[component.type] || 'Component settings' : 'Dashboard settings'
  document.getElementById('designer-config-subtitle').textContent = component ? 'Configure this component.' : 'Select a component or customize the canvas.'
  if (!component) {
    content.innerHTML = `
      <section class="designer-config-section"><h3>REPORT</h3>
        ${configField('Dashboard title', 'dashboard-name', state.dashboard.name)}
        ${configField('Subtitle', 'dashboard-subtitle', state.dashboard.subtitle)}
        ${configField('Eyebrow', 'dashboard-eyebrow', document.getElementById('dashboard-report-eyebrow').textContent)}
      </section>
      <section class="designer-config-section"><h3>APPEARANCE</h3>
        ${configField('Accent green', 'theme-accent', state.dashboard.theme.accent, { choices: [['#174D35', 'Forest'], ['#206B48', 'Deep green'], ['#269B65', 'Emerald'], ['#43B97A', 'Fresh green'], ['#80D6A5', 'Light green']] })}
        ${configField('Surface', 'theme-surface', state.dashboard.theme.surface, { choices: [['#FFFFFF', 'White'], ['#FCFFFD', 'Soft white'], ['#F4FBF6', 'Pale green'], ['#EAF6EE', 'Light green']] })}
        ${configField('Text color', 'theme-text', state.dashboard.theme.text, { choices: [['#174D35', 'Forest green'], ['#206B48', 'Deep green']] })}
        ${configField('Secondary text', 'theme-secondary', state.dashboard.theme.secondary || '#486B55', { choices: [['#486B55', 'Muted green'], ['#617568', 'Soft gray-green'], ['#B4CABB', 'Light mint']] })}
        ${configField('Chart palette', 'theme-palette', state.dashboard.theme.palette || 'forest', { choices: [['forest', 'Forest green'], ['mint', 'Soft mint'], ['monochrome', 'Green monochrome']] })}
        <button type="button" class="designer-action-button" data-open-canvas-settings>Canvas &amp; Appearance</button>
      </section>
      <section class="designer-config-section"><h3>LAYOUT</h3><p class="designer-config-field">Arrange components in the 12-column grid or use Auto Arrange for a compact starting point.</p><div class="designer-config-actions">
        <button type="button" data-layout-action="left">Align Left</button><button type="button" data-layout-action="center">Align Center</button><button type="button" data-layout-action="right">Align Right</button>
        <button type="button" data-layout-action="top">Align Top</button><button type="button" data-layout-action="middle">Align Middle</button><button type="button" data-layout-action="bottom">Align Bottom</button>
        <button type="button" data-layout-action="distribute-horizontal">Distribute Horizontally</button><button type="button" data-layout-action="distribute-vertical">Distribute Vertically</button>
        <button type="button" data-layout-action="equal-width">Equalize Width</button><button type="button" data-layout-action="equal-height">Equalize Height</button>
        <button type="button" data-layout-action="front">Bring to Front</button><button type="button" data-layout-action="back">Send to Back</button>
        <button type="button" data-dashboard-action="clear">Clear components</button>
      </div></section>
    `
  } else {
    const { type, config } = component
    const sectionChoices = [
      ['main', 'Main section'],
      ...state.dashboard.components
        .filter((item) => item.type === 'section' && item.id !== component.id)
        .map((item) => [item.id, item.title || 'Untitled section']),
    ]
    const layoutSectionField = configField('Dashboard section', 'layout-section', component.layout_section || 'main', { choices: sectionChoices })
    let fields = configField('Title', 'title', component.title)
    let dataFields = ''
    if (chartTypes.has(type)) {
      const datasetName = state.dataset?.filename || state.dataset?.name || 'No dataset selected'
      dataFields += `<div class="designer-config-dataset"><span>Dataset</span><strong>${escapeHTML(datasetName)}</strong></div>`
      if (type !== 'histogram') {
        const dimensionLabel = type === 'scatter' || type === 'bubble'
          ? 'Series / category'
          : type === 'horizontalBar'
            ? 'Y-axis / category'
            : ['bar', 'line', 'area', 'stackedBar', 'percentStackedBar', 'waterfall'].includes(type)
              ? 'X-axis / category'
              : 'Category field'
        dataFields += configField(dimensionLabel, 'dimension', config.dimension, { field: 'any' })
      }
      if (type === 'stackedBar' || type === 'percentStackedBar') {
        dataFields += configField('Grouping / series field', 'seriesField', config.seriesField, { field: 'any' })
      }
      if (['scatter', 'bubble', 'heatmap'].includes(type)) {
        dataFields += configField(type === 'heatmap' ? 'Y-axis / second category' : 'X-axis value', 'measure2', config.measure2, { field: type === 'heatmap' ? 'any' : 'numeric' })
      }
      const measureLabel = type === 'horizontalBar' || type === 'scatter' || type === 'bubble'
        ? 'Y-axis value'
        : type === 'histogram' ? 'Value field' : type === 'heatmap' ? 'Color / value field' : 'Y-axis / value'
      dataFields += configField(measureLabel, 'measure', config.measure, { field: config.aggregation === 'count' ? 'any' : 'numeric' })
      if (type === 'bubble') dataFields += configField('Bubble size', 'sizeMeasure', config.sizeMeasure, { field: 'numeric' })
      if (type === 'histogram') dataFields += configField('Histogram bins', 'bins', config.bins || 8, { type: 'number', min: 2, max: 30 })
      if (aggregationChartTypes.has(type)) {
        const choices = [['sum', 'Sum'], ['average', 'Average'], ['count', 'Count'], ['min', 'Minimum'], ['max', 'Maximum']]
        if (percentageChartTypes.has(type)) choices.push(['percentage', 'Percentage (%)'])
        dataFields += configField('Aggregation', 'aggregation', config.aggregation || 'sum', { choices })
      }
      if (percentageChartTypes.has(type) && ['line', 'area', 'stackedBar', 'percentStackedBar'].includes(type)) {
        const choices = ['line', 'area'].includes(type)
          ? [['total', 'Share of total'], ['changeFromFirst', 'Change from first value']]
          : type === 'percentStackedBar'
            ? [['category', 'Share within each category']]
            : [['total', 'Share of grand total'], ['category', 'Share within each category']]
        dataFields += configField('Percentage calculation', 'percentageMode', config.percentageMode || (type === 'percentStackedBar' ? 'category' : 'total'), { choices })
      }
    }
    let chartSections = ''
    if (chartTypes.has(type)) {
      const precision = Number.isInteger(config.decimalPrecision) ? config.decimalPrecision : 1
      const issues = chartFieldIssues(component)
      const warning = issues.length
        ? `<p class="designer-config-warning" role="alert">${issues.map(escapeHTML).join(' ')}</p>`
        : ''
      chartSections = `
        <section class="designer-config-section"><h3>DATA CONFIGURATION</h3>${configField('Chart type', 'type', type, { choices: [...chartTypes].map((chartType) => [chartType, labels[chartType]]) })}${fields}${dataFields}${warning}</section>
        <section class="designer-config-section"><h3>CHART APPEARANCE</h3>
          ${dataLabelChartTypes.has(type) ? configToggle('Show data labels', 'showDataLabels', config.showDataLabels) : ''}
          ${gridLineChartTypes.has(type) ? configToggle('Show grid lines', 'showGridLines', config.showGridLines !== false) : ''}
          ${configToggle('Show tooltips', 'showTooltips', config.showTooltips !== false)}
          ${configField('Chart background', 'chartBackground', config.chartBackground === 'transparent' ? '#FFFFFF' : config.chartBackground || '#FFFFFF', { type: 'color' })}
          ${configField('Chart palette', 'chartPalette', config.chartPalette || 'forest', { choices: [['forest', 'Forest green'], ['mint', 'Soft mint'], ['monochrome', 'Green monochrome']] })}
          ${configField('Title size (px)', 'titleSize', config.titleSize ?? 13, { type: 'number', min: 9, max: 24 })}
          ${configField('Axis label size (px)', 'axisLabelSize', config.axisLabelSize ?? 9, { type: 'number', min: 7, max: 16 })}
          ${configField('Axis label color', 'axisLabelColor', config.axisLabelColor || '#486B55', { type: 'color' })}
          ${configField('Gridline color', 'gridLineColor', config.gridLineColor || '#EAF6EE', { type: 'color' })}
          ${configField('Tooltip style', 'tooltipStyle', config.tooltipStyle || 'canvas', { choices: [['canvas', 'Canvas theme'], ['dark', 'Dark green']] })}
          ${configField('Internal padding (px)', 'chartPadding', config.chartPadding ?? 8, { type: 'number', min: 0, max: 40 })}
          ${configToggle('Chart border', 'chartBorder', config.chartBorder === true)}
        </section>
        <section class="designer-config-section"><h3>CHART DIMENSIONS</h3>
          ${layoutSectionField}
          ${configField('Horizontal position (grid columns)', 'layout-x', component.position.x, { type: 'number', min: 0, max: 11 })}
          ${configField('Vertical position (px)', 'layout-y', component.position.y, { type: 'number', min: 0, max: 5000, step: 20 })}
          ${configField('Width (grid columns)', 'width', component.width, { type: 'number', min: minimumComponentWidth(component), max: 12 })}
          ${configField('Height (px)', 'height', component.height, { type: 'number', min: 110, max: 1000 })}
          ${configField('Minimum height (px)', 'minHeight', config.minHeight ?? 170, { type: 'number', min: 110, max: 800 })}
          ${configField('Maximum height (px)', 'maxHeight', config.maxHeight ?? 700, { type: 'number', min: 150, max: 1200 })}
          ${configToggle('Responsive sizing', 'responsive', config.responsive !== false)}
        </section>
        ${['bar', 'horizontalBar', 'stackedBar', 'percentStackedBar', 'histogram'].includes(type) ? `<section class="designer-config-section"><h3>BAR OPTIONS</h3>${configField('Bar thickness (px)', 'barThickness', config.barThickness ?? 28, { type: 'number', min: 8, max: 80 })}${configField('Bar spacing (%)', 'barSpacing', config.barSpacing ?? 35, { type: 'number', min: 0, max: 90 })}${configField('Rounded corners (px)', 'barRadius', config.barRadius ?? 4, { type: 'number', min: 0, max: 24 })}</section>` : ''}
        ${['line', 'area'].includes(type) ? `<section class="designer-config-section"><h3>LINE OPTIONS</h3>${configField('Line thickness (px)', 'lineThickness', config.lineThickness ?? 2.5, { type: 'number', min: 1, max: 8, step: 0.5 })}${configToggle('Show point markers', 'showMarkers', config.showMarkers !== false)}${configToggle('Smooth line', 'smooth', config.smooth !== false)}${type === 'area' ? configField('Fill transparency (%)', 'areaOpacity', config.areaOpacity ?? 20, { type: 'number', min: 0, max: 100 }) : ''}</section>` : ''}
        ${['pie', 'donut'].includes(type) ? `<section class="designer-config-section"><h3>PIE &amp; DONUT OPTIONS</h3>${type === 'donut' ? configField('Donut hole size (%)', 'donutHoleSize', config.donutHoleSize ?? 40, { type: 'number', min: 20, max: 70 }) : ''}${configField('Slice spacing (px)', 'sliceSpacing', config.sliceSpacing ?? 2, { type: 'number', min: 0, max: 12 })}</section>` : ''}
        <section class="designer-config-section"><h3>LAYOUT TOOLS</h3><div class="designer-config-actions">
          <button type="button" data-layout-action="left">Align Left</button><button type="button" data-layout-action="center">Align Center</button><button type="button" data-layout-action="right">Align Right</button>
          <button type="button" data-layout-action="top">Align Top</button><button type="button" data-layout-action="middle">Align Middle</button><button type="button" data-layout-action="bottom">Align Bottom</button>
          <button type="button" data-layout-action="distribute-horizontal">Distribute Horizontally</button><button type="button" data-layout-action="distribute-vertical">Distribute Vertically</button>
          <button type="button" data-layout-action="equal-width">Equalize Width</button><button type="button" data-layout-action="equal-height">Equalize Height</button>
          <button type="button" data-layout-action="front">Bring to Front</button><button type="button" data-layout-action="back">Send to Back</button>
        </div></section>
        <section class="designer-config-section"><h3>DISPLAY OPTIONS</h3>
          ${percentageChartTypes.has(type) ? configToggle('Show percentage labels', 'showPercentage', config.showPercentage) : ''}
          ${percentageChartTypes.has(type) ? configToggle('Show percentage in tooltips', 'showPercentageInTooltip', config.showPercentageInTooltip) : ''}
          ${configField('Decimal precision', 'decimalPrecision', precision, { type: 'number', min: 0, max: 2 })}
          ${configField('Number format', 'numberFormat', config.numberFormat || 'standard', { choices: [['standard', 'Standard'], ['compact', 'Compact (K/M)']] })}
        </section>
        <section class="designer-config-section"><h3>LEGEND CONFIGURATION</h3>
          ${type === 'heatmap' ? '<p class="designer-config-note">Heatmaps use a continuous color scale instead of a categorical legend.</p>' : `
            ${configToggle('Show Legend', 'showLegend', config.showLegend !== false)}
            ${configField('Legend position', 'legendPosition', config.legendPosition || 'bottom', { choices: [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']] })}
            ${configField('Legend orientation', 'legendOrientation', config.legendOrientation || 'horizontal', { choices: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']] })}
            ${configField('Legend text size', 'legendTextSize', config.legendTextSize ?? 9, { type: 'number', min: 8, max: 14 })}
            ${configField('Legend alignment', 'legendAlign', config.legendAlign || 'center', { choices: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] })}
            ${configField('Legend item spacing', 'legendItemSpacing', config.legendItemSpacing ?? 10, { type: 'number', min: 0, max: 40 })}
          `}
        </section>
        <section class="designer-config-section"><h3>COMPONENT SIZE</h3>
          ${configField('Horizontal position (grid columns)', 'layout-x', component.position.x, { type: 'number', min: 0, max: 11 })}
          ${configField('Vertical position (px)', 'layout-y', component.position.y, { type: 'number', min: 0, max: 5000, step: 20 })}
          ${configField('Width (grid columns)', 'width', component.width, { type: 'number', min: minimumComponentWidth(component), max: 12 })}
          ${configField('Height (px)', 'height', component.height, { type: 'number', min: component.type === 'filter' ? 42 : 90, max: 1000 })}
          ${configField('Card background (optional)', 'appearance-background', component.appearance.background || state.dashboard.canvas.cardBackground, { type: 'color' })}
          ${configField('Card padding (px)', 'appearance-padding', component.appearance.padding, { type: 'number', min: 0, max: 48 })}
          ${configField('Corner radius (px)', 'appearance-radius', component.appearance.radius, { type: 'number', min: 0, max: 32 })}
          ${configToggle('Card shadow', 'appearance-shadow', component.appearance.shadow !== false)}
        </section>
        <section class="designer-config-section"><h3>LAYOUT TOOLS</h3><div class="designer-config-actions">
          <button type="button" data-layout-action="left">Align Left</button><button type="button" data-layout-action="center">Align Center</button><button type="button" data-layout-action="right">Align Right</button>
          <button type="button" data-layout-action="top">Align Top</button><button type="button" data-layout-action="middle">Align Middle</button><button type="button" data-layout-action="bottom">Align Bottom</button>
          <button type="button" data-layout-action="distribute-horizontal">Distribute Horizontally</button><button type="button" data-layout-action="distribute-vertical">Distribute Vertically</button>
          <button type="button" data-layout-action="equal-width">Equalize Width</button><button type="button" data-layout-action="equal-height">Equalize Height</button>
          <button type="button" data-layout-action="front">Bring to Front</button><button type="button" data-layout-action="back">Send to Back</button>
        </div></section>
        <section class="designer-config-section"><h3>COMPONENT</h3><div class="designer-config-actions">
          <button type="button" data-component-action="up">Move up</button><button type="button" data-component-action="down">Move down</button>
          <button type="button" data-component-action="duplicate">Duplicate</button><button class="danger" type="button" data-component-action="delete">Delete</button>
        </div></section>
      `
    }
    if (type === 'kpi') {
      fields += configField('Metric field', 'measure', config.measure, { field: 'numeric' })
      fields += configField('Calculation', 'aggregation', config.aggregation || 'sum', { choices: [['sum', 'Sum'], ['average', 'Average'], ['count', 'Row count'], ['min', 'Minimum'], ['max', 'Maximum'], ['unique', 'Unique values']] })
      fields += configField('Prefix', 'prefix', config.prefix || '')
      fields += configField('Suffix', 'suffix', config.suffix || '')
    }
    if (type === 'table') fields += configField('Maximum rows', 'limit', config.limit || 20, { type: 'number', min: 1, max: 100 })
    if (type === 'text') {
      fields += configField('Text', 'text', config.text, { multiline: true })
      fields += configField('Heading level', 'headingLevel', config.headingLevel || 'h2', { choices: [['h1', 'Large heading'], ['h2', 'Medium heading'], ['h3', 'Small heading'], ['p', 'Paragraph']] })
    }
    if (type === 'filter') {
      fields += configField('Filter field', 'dimension', config.dimension, { field: 'any' })
      fields += configField('Filter type', 'filterMode', config.filterMode || 'categorical', { choices: [['categorical', 'Single selection'], ['multi', 'Multiple selections'], ['date', 'Date range'], ['numeric', 'Numeric range']] })
      if (['categorical', 'multi'].includes(config.filterMode || 'categorical')) {
        fields += configToggle('Search filter values', 'searchable', config.searchable !== false)
      }
      if (config.filterMode === 'multi') fields += configToggle('Show select all', 'showSelectAll', config.showSelectAll !== false)
    }
    if (type === 'image') fields += `<label class="designer-config-field">Choose image<input id="config-image" type="file" accept="image/*"></label>`
    content.innerHTML = chartTypes.has(type) ? chartSections : `
      <section class="designer-config-section"><h3>CONTENT</h3>${fields}</section>
      <section class="designer-config-section"><h3>COMPONENT SIZE</h3>
        ${layoutSectionField}
        ${configField('Width (grid columns)', 'width', component.width, { type: 'number', min: minimumComponentWidth(component), max: 12 })}
        ${configField('Height (px)', 'height', component.height, { type: 'number', min: component.type === 'filter' ? 42 : 90, max: 1000 })}
        ${configField('Card background (optional)', 'appearance-background', component.appearance.background || state.dashboard.canvas.cardBackground, { type: 'color' })}
        ${configField('Card padding (px)', 'appearance-padding', component.appearance.padding, { type: 'number', min: 0, max: 48 })}
        ${configField('Corner radius (px)', 'appearance-radius', component.appearance.radius, { type: 'number', min: 0, max: 32 })}
        ${configToggle('Card shadow', 'appearance-shadow', component.appearance.shadow !== false)}
      </section>
      <section class="designer-config-section"><h3>COMPONENT</h3><div class="designer-config-actions">
        <button type="button" data-component-action="up">Move up</button><button type="button" data-component-action="down">Move down</button>
        <button type="button" data-component-action="duplicate">Duplicate</button><button class="danger" type="button" data-component-action="delete">Delete</button>
      </div></section>
    `
  }
  content.onchange = handleConfigChange
  content.onclick = handleConfigAction
}

function handleConfigChange(event) {
  const target = event.target
  if (target.id === 'config-image' && target.files?.[0]) {
    if (target.files[0].size > 2 * 1024 * 1024) {
      showToast('Choose an image smaller than 2 MB.', 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => updateComponentConfig('imageData', reader.result)
    reader.onerror = () => showToast('The image could not be read.', 'error')
    reader.readAsDataURL(target.files[0])
    return
  }
  const key = target.dataset.configKey
  if (!key) return
  if (key.startsWith('dashboard-')) {
    const prop = key === 'dashboard-name' ? 'name' : 'subtitle'
    const dashboardProp = key === 'dashboard-eyebrow' ? 'eyebrow' : prop
    pushUndo()
    state.dashboard[dashboardProp] = target.value
    if (dashboardProp === 'name') {
      document.getElementById('designer-name').value = target.value
      document.getElementById('dashboard-report-title').textContent = target.value
      document.getElementById('dashboard-focus-title').textContent = target.value || 'Untitled dashboard'
    } else if (dashboardProp === 'subtitle') document.getElementById('dashboard-report-subtitle').textContent = target.value
    else document.getElementById('dashboard-report-eyebrow').textContent = target.value
    return
  }
  if (key.startsWith('theme-')) {
    pushUndo()
    const prop = key.slice(6)
    state.dashboard.theme[prop] = target.value
    if (prop === 'surface') state.dashboard.canvas.cardBackground = target.value
    if (prop === 'text') state.dashboard.canvas.textColor = target.value
    if (prop === 'secondary') state.dashboard.canvas.secondaryColor = target.value
    applyTheme()
    renderComponents()
    return
  }
  const value = target.type === 'checkbox'
    ? target.checked
    : target.type === 'number' ? Number(target.value) : target.value
  updateComponentConfig(key, value)
}

function updateComponentConfig(key, value) {
  const component = state.dashboard.components.find((item) => item.id === state.selectedId)
  if (!component) return
  pushUndo()
  if (key === 'type') {
    if (component.title === labels[component.type]) component.title = labels[value]
    component.type = value
    if (!percentageChartTypes.has(value) && component.config.aggregation === 'percentage') {
      component.config.aggregation = 'sum'
    }
  } else if (key === 'width') {
    component.width = Math.max(minimumComponentWidth(component), Math.min(12, Number(value) || 1))
    component.position.x = Math.min(component.position.x, 12 - component.width)
  } else if (key === 'layout-x') component.position.x = Math.max(0, Math.min(12 - component.width, Number(value) || 0))
  else if (key === 'layout-y') component.position.y = Math.max(0, Number(value) || 0)
  else if (key === 'layout-section') component.layout_section = value
  else if (key === 'height') component.height = Math.max(component.type === 'filter' ? 42 : 90, Math.min(1200, Number(value) || 255))
  else if (key === 'title') component.title = value
  else if (key.startsWith('appearance-')) {
    const prop = key.slice('appearance-'.length)
    if (prop === 'background') component.appearance.background = validColor(value, '')
    else component.appearance[prop] = value
  }
  else if (key === 'size') {
    component.size = value
    const legacy = value === 'small' ? { width: 4, height: 240 } : value === 'large' ? { width: 12, height: 390 } : { width: 6, height: 255 }
    Object.assign(component, legacy)
  }
  else component.config[key] = value
  if (component.type === 'filter' && (key === 'dimension' || key === 'filterMode')) delete state.filters[component.id]
  if (key === 'dimension' || key === 'seriesField' || key === 'filterMode' || key === 'aggregation' || key === 'measure' || key === 'measure2' || key === 'sizeMeasure' || key === 'size' || key === 'type' || key === 'chartPalette' || key === 'width' || key === 'layout-x' || key === 'layout-y' || key === 'layout-section' || key.startsWith('appearance-')) {
    renderComponents()
    renderConfig()
  } else renderComponents()
}

function handleConfigAction(event) {
  if (event.target.closest('[data-open-canvas-settings]')) {
    openCanvasSettings()
    return
  }
  const layoutAction = event.target.closest('[data-layout-action]')?.dataset.layoutAction
  if (layoutAction) {
    applyLayoutAction(layoutAction)
    return
  }
  if (event.target.closest('[data-dashboard-action="clear"]')) {
    if (!state.dashboard.components.length || !window.confirm('Remove all components from this dashboard?')) return
    pushUndo()
    state.dashboard.components = []
    state.selectedId = null
    renderComponents()
    renderConfig()
    return
  }
  const action = event.target.closest('[data-component-action]')?.dataset.componentAction
  if (!action) return
  const index = state.dashboard.components.findIndex((component) => component.id === state.selectedId)
  if (index < 0) return
  pushUndo()
  if (action === 'delete') {
    state.dashboard.components.splice(index, 1)
    state.selectedId = null
  } else if (action === 'duplicate') {
    const copy = structuredClone(state.dashboard.components[index])
    copy.id = crypto.randomUUID()
    copy.title = `${copy.title} copy`
    state.dashboard.components.splice(index + 1, 0, copy)
    state.selectedId = copy.id
  } else {
    const target = action === 'up' ? Math.max(0, index - 1) : Math.min(state.dashboard.components.length - 1, index + 1)
    const [item] = state.dashboard.components.splice(index, 1)
    state.dashboard.components.splice(target, 0, item)
  }
  renderComponents()
  renderConfig()
}

function addComponent(type) {
  if (!labels[type]) return
  pushUndo()
  const component = makeComponent(type, state.schema)
  component.position = findComponentPosition(component.width, component.height)
  component.z_index = Math.max(-1, ...state.dashboard.components.map((item) => Number(item.z_index) || 0)) + 1
  state.dashboard.components.push(component)
  state.selectedId = component.id
  renderComponents()
  renderConfig()
}

function addTemplate(name) {
  const template = templates[name]
  if (!template) return
  pushUndo()
  state.dashboard.components = template.map(([type, title]) => {
    const component = makeComponent(type, state.schema)
    component.title = title
    return component
  })
  arrangeComponents(state.dashboard.components)
  state.selectedId = state.dashboard.components[0]?.id || null
  state.dashboard.name = `${name.charAt(0).toUpperCase()}${name.slice(1)} dashboard`
  document.getElementById('designer-name').value = state.dashboard.name
  document.getElementById('dashboard-report-title').textContent = state.dashboard.name
  document.getElementById('designer-template').value = ''
  renderComponents()
  renderConfig()
}

function validColor(value, fallback) {
  return /^#[\da-f]{6}$/i.test(value || '') ? value : fallback
}

function canvasBackground(background, style, dark = false) {
  const end = dark ? '#172920' : '#FFFFFF'
  if (style === 'horizontal-gradient') return `linear-gradient(90deg, ${background}, ${end})`
  if (style === 'radial-gradient') return `radial-gradient(circle at top left, ${background}, ${end} 78%)`
  if (style === 'soft-gradient') return `linear-gradient(145deg, ${background}, ${end})`
  return background
}

function renderCanvasPresets() {
  const container = document.getElementById('canvas-preset-grid')
  const selectedPreset = document.getElementById('canvas-settings-dialog').dataset.selectedPreset || state.dashboard.canvas.preset
  container.replaceChildren()
  Object.entries(canvasPresets).forEach(([id, preset]) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `canvas-preset${selectedPreset === id ? ' active' : ''}`
    button.dataset.canvasPreset = id
    button.setAttribute('aria-pressed', String(selectedPreset === id))
    button.innerHTML = `<span class="canvas-preset-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i></span><strong>${escapeHTML(preset.label)}</strong>`
    button.style.setProperty('--preset-bg', preset.background)
    button.style.setProperty('--preset-card', preset.cardBackground)
    container.append(button)
  })
}

function setCanvasPreset(id) {
  const preset = canvasPresets[id]
  if (!preset) return
  document.getElementById('canvas-settings-dialog').dataset.selectedPreset = id
  for (const [key, value] of Object.entries({
    background: preset.background,
    cardBackground: preset.cardBackground,
    textColor: preset.textColor,
    secondaryColor: preset.secondaryColor,
    style: preset.style,
    padding: preset.padding,
    gap: preset.gap,
    radius: preset.radius,
    shadows: preset.shadows,
  })) {
    const input = document.getElementById({
      background: 'canvas-background',
      cardBackground: 'canvas-card-background',
      textColor: 'canvas-text-color',
      secondaryColor: 'canvas-secondary-color',
      style: 'canvas-background-style',
      padding: 'canvas-padding',
      gap: 'canvas-gap',
      radius: 'canvas-radius',
      shadows: 'canvas-shadows',
    }[key])
    if (input.type === 'checkbox') input.checked = value
    else input.value = value
  }
  renderCanvasPresets()
}

function openCanvasSettings() {
  const canvas = state.dashboard.canvas
  const dialog = document.getElementById('canvas-settings-dialog')
  dialog.dataset.selectedPreset = canvas.preset
  renderCanvasPresets()
  document.getElementById('canvas-dimensions').value = canvas.dimensions || 'custom'
  document.getElementById('canvas-width').value = canvas.width
  document.getElementById('canvas-height').value = canvas.height
  const custom = document.getElementById('canvas-dimensions').value === 'custom'
  document.getElementById('canvas-width').disabled = !custom
  document.getElementById('canvas-height').disabled = !custom
  document.getElementById('canvas-background').value = validColor(canvas.background, '#F1F8F3')
  document.getElementById('canvas-background-style').value = canvas.style
  document.getElementById('canvas-padding').value = canvas.padding
  document.getElementById('canvas-gap').value = canvas.gap
  document.getElementById('canvas-radius').value = canvas.radius
  document.getElementById('canvas-alignment').value = canvas.alignment || 'center'
  document.getElementById('canvas-shadows').checked = canvas.shadows !== false
  document.getElementById('canvas-grid').checked = canvas.grid !== false
  document.getElementById('canvas-card-background').value = validColor(canvas.cardBackground, '#FFFFFF')
  document.getElementById('canvas-text-color').value = validColor(canvas.textColor, '#174D35')
  document.getElementById('canvas-secondary-color').value = validColor(canvas.secondaryColor, '#486B55')
  document.getElementById('canvas-settings-dialog').showModal()
}

function applyCanvasSettings() {
  const canvas = state.dashboard.canvas
  const dialog = document.getElementById('canvas-settings-dialog')
  const dimension = document.getElementById('canvas-dimensions').value
  const custom = dimension === 'custom'
  const [presetWidth, presetHeight] = canvasDimensions[dimension] || [Number(canvas.width) || 1440, Number(canvas.height) || 900]
  const readNumber = (id, fallback, min, max) => Math.min(max, Math.max(min, Number(document.getElementById(id).value) || fallback))
  pushUndo()
  Object.assign(canvas, {
    preset: dialog.dataset.selectedPreset || canvas.preset || 'soft-mint',
    dimensions: dimension,
    width: custom ? readNumber('canvas-width', 1440, 320, 5000) : presetWidth,
    height: custom ? readNumber('canvas-height', 900, 320, 5000) : presetHeight,
    background: validColor(document.getElementById('canvas-background').value, '#F1F8F3'),
    cardBackground: validColor(document.getElementById('canvas-card-background').value, '#FFFFFF'),
    textColor: validColor(document.getElementById('canvas-text-color').value, '#174D35'),
    secondaryColor: validColor(document.getElementById('canvas-secondary-color').value, '#486B55'),
    style: ['soft-gradient', 'horizontal-gradient', 'radial-gradient'].includes(document.getElementById('canvas-background-style').value)
      ? document.getElementById('canvas-background-style').value
      : 'solid',
    padding: readNumber('canvas-padding', 28, 0, 100),
    gap: readNumber('canvas-gap', 14, 0, 60),
    radius: readNumber('canvas-radius', 10, 0, 40),
    shadows: document.getElementById('canvas-shadows').checked,
    grid: document.getElementById('canvas-grid').checked,
    alignment: ['left', 'center', 'right'].includes(document.getElementById('canvas-alignment').value)
      ? document.getElementById('canvas-alignment').value
      : 'center',
  })
  state.dashboard.theme.surface = canvas.cardBackground
  state.dashboard.theme.text = canvas.textColor
  state.dashboard.theme.secondary = canvas.secondaryColor
  applyTheme()
  renderComponents()
  renderConfig()
  document.getElementById('canvas-settings-dialog').close()
}

function applyTheme() {
  const canvas = document.getElementById('dashboard-canvas')
  const settings = state.dashboard.canvas
  const dark = settings.preset === 'dark-analytics'
  const background = validColor(settings.background, '#F1F8F3')
  const surface = validColor(settings.cardBackground, '#FFFFFF')
  const text = validColor(settings.textColor, '#174D35')
  const secondary = validColor(settings.secondaryColor, '#486B55')
  canvas.style.setProperty('--report-accent', state.dashboard.theme.accent || '#206B48')
  canvas.style.setProperty('--report-surface', surface)
  canvas.style.setProperty('--report-ink', text)
  canvas.style.setProperty('--report-muted', secondary)
  canvas.style.setProperty('--report-border', dark ? '#385B43' : '#D5EBDD')
  canvas.style.setProperty('--report-card-radius', `${Math.max(0, Math.min(40, Number(settings.radius) || 0))}px`)
  canvas.style.setProperty('--report-card-gap', `${Math.max(0, Math.min(60, Number(settings.gap) || 0))}px`)
  canvas.style.setProperty('--report-padding', `${Math.max(0, Math.min(100, Number(settings.padding) || 0))}px`)
  canvas.style.setProperty('--report-background', canvasBackground(background, settings.style, dark))
  canvas.style.setProperty('--report-shadow', settings.shadows === false ? 'none' : '0 4px 14px -12px rgba(23,77,53,.4)')
  canvas.dataset.dashboardTheme = dark ? 'dark' : 'light'
  canvas.style.width = `${Math.max(320, Math.min(5000, Number(settings.width) || 1440))}px`
  canvas.style.minHeight = `${Math.max(320, Math.min(5000, Number(settings.height) || 900))}px`
  canvas.style.marginInline = settings.alignment === 'left' ? '0 auto 0 0' : settings.alignment === 'right' ? '0 0 0 auto' : '0 auto'
  canvas.dataset.editorGrid = String(settings.grid !== false)
  const scroll = document.querySelector('.designer-canvas-scroll')
  if (scroll) scroll.dataset.canvasGrid = String(settings.grid !== false)
}

function chartTheme() {
  const dark = state.dashboard.canvas.preset === 'dark-analytics'
  const palette = chartPalettes[state.dashboard.theme.palette] || chartPalettes.forest
  return dark
    ? {
        ink: state.dashboard.canvas.textColor || '#e4f1e8',
        muted: state.dashboard.canvas.secondaryColor || '#b4cabb',
        border: '#456b50',
        grid: '#294533',
        tooltip: state.dashboard.canvas.cardBackground || '#172920',
        palette: palette.map((color, index) => index === 0 ? '#83D6A4' : color),
      }
    : {
        ink: state.dashboard.canvas.textColor || '#174D35',
        muted: state.dashboard.canvas.secondaryColor || '#486B55',
        border: '#B4D9C1',
        grid: '#EAF6EE',
        tooltip: state.dashboard.canvas.cardBackground || '#FFFFFF',
        palette,
      }
}

function displayRows() {
  return snapshotRows()
}

function hasValue(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value !== 'string' || value.trim() === '') return NaN
  return Number(value)
}

function aggregate(values, method = 'sum') {
  const present = values.filter(hasValue)
  const numbers = present.map(numericValue).filter(Number.isFinite)
  if (method === 'count') return present.length
  if (method === 'unique') return new Set(values.filter(hasValue)).size
  if (!numbers.length) return 0
  if (method === 'average') return numbers.reduce((a, b) => a + b, 0) / numbers.length
  if (method === 'min') return Math.min(...numbers)
  if (method === 'max') return Math.max(...numbers)
  return numbers.reduce((a, b) => a + b, 0)
}

function percentOfTotal(values) {
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => total === 0 ? 0 : (value / total) * 100)
}

function percentageChangeFromFirst(values) {
  const first = values.find(Number.isFinite) ?? 0
  return values.map((value) => first === 0 ? 0 : ((value - first) / Math.abs(first)) * 100)
}

function groupedData(component, rows = displayRows()) {
  const { dimension, measure, aggregation = 'sum' } = component.config
  const groups = new Map()
  rows.forEach((row) => {
    const label = String(row[dimension] ?? '(blank)')
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(row[measure])
  })
  const rawValues = [...groups].map(([name, list]) => [
    name,
    aggregation === 'count' && !measure ? list.length : aggregate(list, aggregation),
  ])
  const rawNumbers = rawValues.map((item) => item[1])
  const percentages = aggregation === 'percentage'
    ? component.config.percentageMode === 'changeFromFirst'
      ? percentageChangeFromFirst(rawNumbers)
      : percentOfTotal(rawNumbers)
    : percentOfTotal(rawNumbers)
  return rawValues.slice(0, 30).map(([name, value], index) => [
    name,
    aggregation === 'percentage' ? percentages[index] : value,
    percentages[index],
  ])
}

function groupedSeriesData(component, rows = displayRows()) {
  const { dimension, measure, aggregation = 'sum' } = component.config
  const seriesField = component.config.seriesField
  const categories = []
  const valuesBySeries = new Map()
  rows.forEach((row) => {
    const category = String(row[dimension] ?? '(blank)')
    const seriesName = seriesField ? String(row[seriesField] ?? '(blank)') : (measure || 'Value')
    if (!categories.includes(category) && categories.length < 30) categories.push(category)
    if (!categories.includes(category)) return
    if (!valuesBySeries.has(seriesName) && valuesBySeries.size < 20) valuesBySeries.set(seriesName, new Map())
    const series = valuesBySeries.get(seriesName)
    if (!series) return
    if (!series.has(category)) series.set(category, [])
    series.get(category).push(measure ? row[measure] : 1)
  })
  const series = [...valuesBySeries].map(([name, values]) => ({
    name,
    values: categories.map((category) => aggregate(values.get(category) || [], aggregation)),
  }))
  const mode = component.config.percentageMode || (component.type === 'stackedBar' || component.type === 'percentStackedBar' ? 'category' : 'total')
  const categoryTotals = categories.map((_, index) => series.reduce((sum, item) => sum + item.values[index], 0))
  const total = categoryTotals.reduce((sum, value) => sum + value, 0)
  series.forEach((item) => {
    item.percentages = item.values.map((value, index) => {
      const denominator = mode === 'category' || component.type === 'percentStackedBar' ? categoryTotals[index] : total
      return denominator === 0 ? 0 : (value / denominator) * 100
    })
    if (component.type === 'percentStackedBar' || aggregation === 'percentage') {
      item.values = [...item.percentages]
    }
  })
  return { categories, series }
}

function numberText(value, precision, format = 'standard') {
  const digits = Math.max(0, Math.min(2, Number.isInteger(precision) ? precision : 1))
  const number = numericValue(value)
  if (!Number.isFinite(number)) return '—'
  return number.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    ...(format === 'compact' ? { notation: 'compact' } : {}),
  })
}

function legendOption(component, names = []) {
  const config = component.config
  const position = ['top', 'bottom', 'left', 'right'].includes(config.legendPosition) ? config.legendPosition : 'bottom'
  const orientation = config.legendOrientation === 'vertical' ? 'vertical' : 'horizontal'
  const positionAlign = ['left', 'center', 'right'].includes(config.legendAlign) ? config.legendAlign : 'center'
  const chartNode = document.getElementById(`chart-${component.id}`)
  const compact = chartNode && (chartNode.clientWidth < 360 || chartNode.clientHeight < 220)
  const align = positionAlign === 'center' ? 'auto' : positionAlign
  return {
    show: config.showLegend !== false,
    data: [...new Set(names.filter(Boolean))],
    orient: orientation,
    align,
    itemGap: Math.max(0, Math.min(40, Number(config.legendItemSpacing) || 0) - (compact ? 2 : 0)),
    textStyle: {
      color: chartTheme().muted,
      fontSize: Math.max(7, Math.min(18, (Number(config.legendTextSize) || 9) - (compact ? 1 : 0))),
    },
    ...(position === 'top' ? { top: 4, left: positionAlign } : {}),
    ...(position === 'bottom' ? { bottom: 2, left: positionAlign } : {}),
    ...(position === 'left' ? { left: 4, top: 'middle' } : {}),
    ...(position === 'right' ? { right: 4, top: 'middle' } : {}),
  }
}

function chartTooltip(component, pie = false) {
  const config = component.config
  if (config.showTooltips === false) return { show: false }
  const darkTooltip = config.tooltipStyle === 'dark'
  return {
    show: true,
    trigger: pie || ['scatter', 'bubble'].includes(component.type) ? 'item' : 'axis',
    backgroundColor: darkTooltip ? '#172920' : chartTheme().tooltip,
    borderColor: chartTheme().border,
    borderWidth: 1,
    padding: [9, 12],
    textStyle: { color: chartTheme().ink, fontSize: 11 },
    extraCssText: 'box-shadow: 0 6px 20px rgba(23,77,53,.14); border-radius: 6px;',
    axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(38,155,101,.08)' } },
    formatter: (input) => {
      const params = Array.isArray(input) ? input : [input]
      return params.map((param) => {
        const data = param.data && typeof param.data === 'object' ? param.data : {}
        if (['scatter', 'bubble'].includes(component.type) && Array.isArray(param.value)) {
          const [x, y, size] = param.value
          const sizeLabel = component.type === 'bubble' ? `<br>${escapeHTML(config.sizeMeasure)}: ${numberText(size, config.decimalPrecision, config.numberFormat)}` : ''
          return `${escapeHTML(param.seriesName || '')}<br>${escapeHTML(config.measure2)}: ${numberText(x, config.decimalPrecision, config.numberFormat)}<br>${escapeHTML(config.measure)}: ${numberText(y, config.decimalPrecision, config.numberFormat)}${sizeLabel}`
        }
        const rawValue = Number(data.value ?? param.value)
        const value = Number.isFinite(rawValue) ? rawValue : 0
        const isPercentageValue = config.aggregation === 'percentage' || component.type === 'percentStackedBar'
        const metric = isPercentageValue
          ? `${numberText(value, config.decimalPrecision)}%`
          : numberText(value, config.decimalPrecision, config.numberFormat)
        const percentage = Number.isFinite(Number(data.percentage)) ? Number(data.percentage) : Number(param.percent)
        const share = Number.isFinite(percentage) ? `<br>${numberText(percentage, config.decimalPrecision)}%` : ''
        const showShare = pie
          ? config.showPercentageInTooltip !== false && !isPercentageValue
          : config.showPercentageInTooltip === true && !isPercentageValue
        const title = param.seriesName ? `${param.seriesName} · ` : ''
        return `${escapeHTML(title)}${escapeHTML(param.name ?? '')}: ${metric}${showShare ? share : ''}`
      }).join('<br>')
    },
  }
}

function chartOption(component) {
  const rows = displayRows()
  const { type, config } = component
  const colors = chartTheme()
  const chartNode = document.getElementById(`chart-${component.id}`)
  const compact = chartNode && (chartNode.clientWidth < 360 || chartNode.clientHeight < 220)
  const labelSize = Math.max(7, Math.min(16, (Number(config.axisLabelSize) || 9) - (compact ? 1 : 0)))
  const labelColor = validColor(config.axisLabelColor, colors.muted)
  const gridColor = validColor(config.gridLineColor, colors.grid)
  const barSpacing = Number(config.barSpacing)
  const sliceSpacing = Number(config.sliceSpacing)
  const axis = {
    axisLine: { lineStyle: { color: colors.border } },
    axisLabel: { color: labelColor, fontSize: labelSize, hideOverlap: true, margin: 8 },
    nameTextStyle: { color: colors.ink, fontSize: 10, fontWeight: 600 },
    splitLine: { show: component.config.showGridLines !== false, lineStyle: { color: gridColor, type: 'dashed' } },
  }
  const legend = legendOption(component)
  const legendVisible = component.config.showLegend !== false
  const legendPosition = component.config.legendPosition || 'bottom'
  const base = {
    animationDuration: 300,
    color: chartPalettes[config.chartPalette] || colors.palette,
    backgroundColor: config.chartBackground || 'transparent',
    textStyle: { color: colors.ink, fontFamily: 'Inter, sans-serif', fontSize: Math.min(12, labelSize + 1) },
    tooltip: chartTooltip(component),
    ...(type === 'heatmap' ? {} : { legend }),
    grid: {
      top: (legendVisible && legendPosition === 'top' ? 34 : 6) + (Number(config.chartPadding) || 0),
      left: (legendVisible && legendPosition === 'left' ? (compact ? 58 : 78) : (compact ? 26 : 32)) + (Number(config.chartPadding) || 0),
      right: (legendVisible && legendPosition === 'right' ? (compact ? 58 : 78) : 6) + (Number(config.chartPadding) || 0),
      bottom: (legendVisible && legendPosition === 'bottom' ? (compact ? 34 : 42) : 22) + (Number(config.chartPadding) || 0),
      containLabel: true,
    },
  }
  const groups = groupedData(component, rows)
  const names = groups.map((item) => item[0])
  const values = groups.map((item) => item[1])
  const percentageMetric = config.aggregation === 'percentage' || type === 'percentStackedBar'
  const labelFormatter = (params) => {
    const data = params.data && typeof params.data === 'object' ? params.data : {}
    if (percentageMetric) return `${numberText(params.value, config.decimalPrecision)}%`
    if (config.showPercentage) return `${numberText(data.percentage ?? 0, config.decimalPrecision)}%`
    return numberText(params.value, config.decimalPrecision, config.numberFormat)
  }
  const categoryPercentages = percentageMetric
    ? values
    : (type === 'line' || type === 'area') && config.percentageMode === 'changeFromFirst'
      ? percentageChangeFromFirst(values)
      : groups.map((item) => item[2])
  const categoryData = values.map((value, index) => ({ value, percentage: categoryPercentages[index] }))
  const visibleLegend = (namesArg) => ({ ...legend, data: [...new Set(namesArg.filter(Boolean))] })
  const dimensionAxis = {
    type: 'category',
    name: config.dimension || '',
    nameLocation: 'middle',
    nameGap: 28,
    data: names,
    ...axis,
  }
  const metricAxis = {
    ...axis,
    type: 'value',
    name: type === 'percentStackedBar'
      ? `Percentage contribution${config.measure ? ` of ${config.measure}` : ''}`
      : aggregationTitle(config),
    nameLocation: 'middle',
    nameGap: 42,
    axisLabel: {
      ...axis.axisLabel,
      formatter: (value) => percentageMetric
        ? `${numberText(value, config.decimalPrecision)}%`
        : numberText(value, config.decimalPrecision, config.numberFormat),
    },
  }
  if (type === 'stackedBar' || type === 'percentStackedBar') {
    const grouped = groupedSeriesData(component, rows)
    const seriesNames = grouped.series.map((item) => item.name)
    const stackedSeries = grouped.series.map((item) => {
      return {
        name: item.name,
        type: 'bar',
        stack: 'total',
        label: {
          show: config.showDataLabels === true,
          position: 'inside',
          color: chartTheme().ink,
          formatter: (params) => {
            const value = Number(params.value) || 0
            const percentage = item.percentages[params.dataIndex] ?? 0
            return percentageMetric || config.showPercentage
              ? `${numberText(percentageMetric ? value : percentage, config.decimalPrecision)}%`
              : numberText(value, config.decimalPrecision)
          },
        },
        data: item.values.map((value, index) => ({ value, percentage: item.percentages[index] ?? 0 })),
      }
    })
    return {
      ...base,
      legend: visibleLegend(seriesNames),
      tooltip: chartTooltip(component),
      xAxis: { type: 'category', name: config.dimension || '', nameLocation: 'middle', nameGap: 28, data: grouped.categories, ...axis },
      yAxis: {
        ...metricAxis,
        max: type === 'percentStackedBar' ? 100 : undefined,
        axisLabel: type === 'percentStackedBar'
          ? { ...axis.axisLabel, formatter: (value) => `${numberText(value, config.decimalPrecision)}%` }
          : metricAxis.axisLabel,
      },
      series: stackedSeries,
    }
  }
  if (['bar', 'horizontalBar', 'line', 'area', 'waterfall'].includes(type)) {
    const horizontal = type === 'horizontalBar'
    const seriesName = aggregationTitle(config)
    const series = {
      name: seriesName,
      type: type === 'line' || type === 'area' ? 'line' : 'bar',
      data: categoryData,
      barMaxWidth: Math.max(8, Math.min(80, Number(config.barThickness) || 28)),
      barCategoryGap: `${Math.max(0, Math.min(90, Number.isFinite(barSpacing) ? barSpacing : 35))}%`,
      itemStyle: { borderRadius: Math.max(0, Math.min(24, Number(config.barRadius) || 0)) },
      lineStyle: { width: Math.max(1, Math.min(8, Number(config.lineThickness) || 2.5)) },
      symbol: 'circle',
      showSymbol: config.showMarkers !== false,
      symbolSize: type === 'line' || type === 'area' ? 5 : undefined,
      smooth: ['line', 'area'].includes(type) && config.smooth !== false,
      areaStyle: type === 'area' ? { opacity: Math.max(0, Math.min(100, Number(config.areaOpacity) || 0)) / 100 } : undefined,
      label: {
        show: config.showDataLabels === true,
        color: chartTheme().ink,
        position: horizontal ? 'right' : 'top',
        labelLayout: { hideOverlap: true },
        formatter: labelFormatter,
      },
    }
    if (type === 'waterfall') {
      let total = 0
      const baseValues = []
      const positive = []
      const negative = []
      values.forEach((value) => {
        const start = total
        total += value
        baseValues.push(Math.min(start, total))
        positive.push(value >= 0 ? value : 0)
        negative.push(value < 0 ? -value : 0)
      })
      return {
        ...base,
        legend: visibleLegend(['Positive', 'Negative']),
        xAxis: horizontal ? { ...metricAxis, type: 'value', name: aggregationTitle(config) } : dimensionAxis,
        yAxis: horizontal ? { type: 'category', name: config.dimension || '', data: names, ...axis } : metricAxis,
        series: [
          { name: 'Start', type: 'bar', stack: 'total', data: baseValues, itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } } },
          { name: 'Positive', type: 'bar', stack: 'total', data: positive, itemStyle: { color: '#269B65', borderRadius: 3 }, label: { show: config.showDataLabels === true, position: 'top', formatter: (params) => numberText(params.value, config.decimalPrecision, config.numberFormat) } },
          { name: 'Negative', type: 'bar', stack: 'total', data: negative, itemStyle: { color: '#80D6A5', borderRadius: 3 }, label: { show: config.showDataLabels === true, position: 'bottom', formatter: (params) => numberText(params.value, config.decimalPrecision, config.numberFormat) } },
        ],
      }
    }
    const lineLabelPercentages = config.aggregation === 'percentage'
      ? values
      : config.percentageMode === 'changeFromFirst' && (type === 'line' || type === 'area')
        ? percentageChangeFromFirst(values)
        : percentOfTotal(values)
    series.data = values.map((value, index) => ({ value, percentage: lineLabelPercentages[index] ?? 0 }))
    series.label.formatter = (params) => {
      const value = Number(params.value) || 0
      const percentage = Number(params.data?.percentage) || 0
      if (percentageMetric) return `${numberText(value, config.decimalPrecision)}%`
      if (config.showPercentage) return `${numberText(percentage, config.decimalPrecision)}%`
      return numberText(value, config.decimalPrecision)
    }
    return {
      ...base,
      legend: visibleLegend([seriesName]),
      xAxis: horizontal ? { ...metricAxis, type: 'value', name: aggregationTitle(config) } : dimensionAxis,
      yAxis: horizontal
        ? { type: 'category', name: config.dimension || '', nameLocation: 'middle', nameGap: 34, data: names, ...axis }
        : metricAxis,
      series: [{ ...series, ...(horizontal ? { data: series.data } : {}) }],
    }
  }
  if (type === 'pie' || type === 'donut') {
    const showPieLabels = config.showDataLabels !== false
      && groups.length <= Math.max(6, Math.floor((Number(component.width) || 4) * 1.5))
    const pieLegend = visibleLegend(names)
    if (groups.length > 10) {
      Object.assign(pieLegend, {
        type: 'scroll',
        height: 28,
        itemGap: 4,
        formatter: (name) => name.length > 14 ? `${name.slice(0, 12)}…` : name,
      })
    }
    return {
      ...base,
      legend: pieLegend,
      tooltip: chartTooltip(component, true),
      series: [{
        name: aggregationTitle(config),
        type: 'pie',
        radius: type === 'donut' ? [`${Math.max(20, Math.min(70, Number(config.donutHoleSize) || 40))}%`, '67%'] : '64%',
        center: legendVisible && ['left', 'right'].includes(legendPosition) ? ['50%', '50%'] : ['50%', legendVisible ? '44%' : '50%'],
        data: groups.map(([name, value, percentage]) => ({ name, value, percentage })),
        label: {
          show: showPieLabels,
          color: chartTheme().ink,
          fontSize: 10,
          minShowLabelAngle: 4,
          formatter: (params) => {
            const share = Number(params.data?.percentage ?? params.percent) || 0
            if (config.showPercentage || config.aggregation === 'percentage') return `${params.name}: ${numberText(share, config.decimalPrecision)}%`
            return `${params.name}: ${numberText(params.value, config.decimalPrecision, config.numberFormat)}`
          },
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        itemStyle: { borderColor: colors.tooltip, borderWidth: Math.max(0, Math.min(12, Number.isFinite(sliceSpacing) ? sliceSpacing : 2)) },
      }],
    }
  }
  if (type === 'scatter' || type === 'bubble') {
    const field = config.dimension
    const categoryNames = [...new Set(rows.map((row) => String(row[field] ?? '(blank)')))].slice(0, 20)
    const series = categoryNames.map((name) => ({
      name,
      type: 'scatter',
      data: rows.filter((row) => String(row[field] ?? '(blank)') === name).slice(0, 500).map((row) => [
        numericValue(row[config.measure2]),
        numericValue(row[config.measure]),
        type === 'bubble' ? numericValue(row[config.sizeMeasure]) : 10,
      ]).filter((point) => point.slice(0, type === 'bubble' ? 3 : 2).every(Number.isFinite)),
      symbolSize: (value) => type === 'bubble' ? Math.max(5, Math.min(28, Math.sqrt(Math.abs(value[2])) * 2)) : 8,
    }))
    return {
      ...base,
      legend: visibleLegend(categoryNames),
      xAxis: { ...axis, type: 'value', name: config.measure2, nameLocation: 'middle', nameGap: 28 },
      yAxis: { ...axis, type: 'value', name: config.measure, nameLocation: 'middle', nameGap: 42 },
      series,
    }
  }
  if (type === 'histogram') {
    const valuesNumeric = rows.map((row) => numericValue(row[config.measure])).filter(Number.isFinite)
    if (!valuesNumeric.length)     return { ...base, legend: visibleLegend(['Frequency']), xAxis: { type: 'category', name: config.measure, data: [] }, yAxis: { type: 'value', name: 'Count' }, series: [{ name: 'Frequency', type: 'bar', data: [] }] }
    const min = Math.min(...valuesNumeric)
    const max = Math.max(...valuesNumeric)
    const count = Math.max(2, Math.min(30, Number(config.bins) || 8))
    const width = (max - min) / count || 1
    const bins = Array.from({ length: count }, (_, index) => ({ name: `${(min + index * width).toPrecision(3)}–${(min + (index + 1) * width).toPrecision(3)}`, value: 0 }))
    valuesNumeric.forEach((value) => { bins[Math.min(count - 1, Math.floor((value - min) / width))].value += 1 })
    return {
      ...base,
      legend: visibleLegend(['Frequency']),
      xAxis: { type: 'category', name: config.measure, nameLocation: 'middle', nameGap: 28, data: bins.map((bin) => bin.name), ...axis },
      yAxis: { ...axis, type: 'value', name: 'Count', nameLocation: 'middle', nameGap: 35 },
      series: [{
        name: 'Frequency',
        type: 'bar',
        data: bins.map((bin) => bin.value),
        barMaxWidth: 42,
        label: { show: config.showDataLabels === true, formatter: (params) => numberText(params.value, config.decimalPrecision, config.numberFormat) },
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      }],
    }
  }
  if (type === 'radar') return { ...base, legend: visibleLegend([component.title]), radar: { indicator: groups.map(([name]) => ({ name, max: Math.max(1, ...values.map(Math.abs)) })), axisName: { color: chartTheme().muted, fontSize: 9 }, splitArea: { areaStyle: { color: document.documentElement.dataset.theme === 'dark' ? ['#172920', '#20372a'] : ['#FFFFFF', '#F4FBF6'] } } }, series: [{ name: component.title, type: 'radar', data: [{ value: values, name: component.title }], label: { show: config.showDataLabels === true, formatter: (params) => numberText(params.value, config.decimalPrecision) }, areaStyle: { opacity: .18 } }] }
  if (type === 'treemap' || type === 'funnel') return { ...base, legend: visibleLegend(names), tooltip: chartTooltip(component, true), series: [{ name: aggregationTitle(config), type, data: groups.map(([name, value]) => ({ name, value })), label: { show: config.showDataLabels !== false, color: chartTheme().ink, fontSize: 10, formatter: (params) => numberText(params.value, config.decimalPrecision, config.numberFormat) }, itemStyle: { borderColor: '#fff', borderWidth: 2 } }] }
  if (type === 'heatmap') {
    const xField = config.measure2
    const xNames = [...new Set(rows.map((row) => String(row[config.dimension] ?? '(blank)')))].slice(0, 18)
    const yNames = [...new Set(rows.map((row) => String(row[xField] ?? '(blank)')))].slice(0, 18)
    const valuesHeat = []
    rows.forEach((row) => {
      const x = xNames.indexOf(String(row[config.dimension] ?? '(blank)'))
      const y = yNames.indexOf(String(row[xField] ?? '(blank)'))
      const value = numericValue(row[config.measure])
      if (x >= 0 && y >= 0 && Number.isFinite(value)) valuesHeat.push([x, y, value])
    })
    return {
      ...base,
      tooltip: config.showTooltips === false ? { show: false } : {
        trigger: 'item',
        position: 'top',
        backgroundColor: chartTheme().tooltip,
        borderColor: chartTheme().border,
        textStyle: { color: chartTheme().ink, fontSize: 11 },
        formatter: (params) => {
          const [x, y, value] = params.value
          return `${escapeHTML(config.dimension)}: ${escapeHTML(xNames[x])}<br>${escapeHTML(xField)}: ${escapeHTML(yNames[y])}<br>${escapeHTML(aggregationTitle(config))}: ${numberText(value, config.decimalPrecision, config.numberFormat)}`
        },
      },
      grid: { top: 42, left: 80, right: 20, bottom: 52 },
      xAxis: { type: 'category', name: config.dimension, nameLocation: 'middle', nameGap: 28, data: xNames, splitArea: { show: true }, ...axis },
      yAxis: { type: 'category', name: xField, nameLocation: 'middle', nameGap: 48, data: yNames, splitArea: { show: true }, ...axis },
      visualMap: { min: Math.min(0, ...valuesHeat.map((item) => item[2])), max: Math.max(1, ...valuesHeat.map((item) => item[2])), calculable: true, orient: 'horizontal', left: 'center', bottom: 2, inRange: { color: chartTheme().palette.slice(0, 4) } },
      series: [{ name: aggregationTitle(config), type: 'heatmap', data: valuesHeat, label: { show: config.showDataLabels === true && valuesHeat.length < 60, color: chartTheme().ink, fontSize: 9 } }],
    }
  }
  return { ...base, xAxis: { type: 'category', data: names, ...axis }, yAxis: { type: 'value', ...axis }, series: [{ name: config.measure || 'Value', type: 'bar', data: categoryData, label: { show: config.showDataLabels === true, formatter: labelFormatter } }] }
}

function filterFieldValue(value) {
  return value === null || value === undefined || value === '' ? '(blank)' : String(value)
}

function createFilterControl(component) {
  const { dimension = '', filterMode = 'categorical' } = component.config
  const current = state.filters[component.id] || {}
  const values = [...new Set(state.rows.map((row) => filterFieldValue(row[dimension])))]
  const wrapper = document.createElement('div')
  wrapper.className = 'dashboard-filter-control'
  const setFilter = (filter) => {
    const dropdownWasOpen = wrapper.querySelector('details')?.open || false
    state.filters[component.id] = filter
    renderComponents()
    if (dropdownWasOpen) {
      const dropdown = document.querySelector(`[data-filter-component-id="${CSS.escape(component.id)}"]`)
      if (dropdown) dropdown.open = true
    }
    setStatus('Filters applied')
  }
  const labelled = (element, suffix) => {
    element.setAttribute('aria-label', `${dimension || 'Filter'} ${suffix}`)
    return element
  }
  if (filterMode === 'categorical' || filterMode === 'multi') {
    if (filterMode === 'categorical') {
      let control
      if (component.config.searchable !== false) {
        control = document.createElement('input')
        control.type = 'search'
        control.setAttribute('list', `filter-options-${component.id}`)
        control.placeholder = 'All values'
        control.value = current.value || ''
        const options = document.createElement('datalist')
        options.id = `filter-options-${component.id}`
        values.forEach((value) => options.append(new Option(value, value)))
        wrapper.append(options)
        control.addEventListener('change', () => {
          setFilter({ mode: filterMode, value: values.includes(control.value) ? control.value : '' })
        })
      } else {
        control = document.createElement('select')
        control.append(new Option('All values', ''))
        values.forEach((value) => control.add(new Option(value, value)))
        control.value = current.value || ''
        control.addEventListener('change', () => setFilter({ mode: filterMode, value: control.value }))
      }
      wrapper.append(labelled(control, 'value'))
      return wrapper
    }

    const details = document.createElement('details')
    details.className = 'dashboard-filter-multiselect'
    details.dataset.filterComponentId = component.id
    const summary = document.createElement('summary')
    const selected = new Set(Array.isArray(current.values) ? current.values : [])
    const updateSummary = () => {
      summary.textContent = selected.size ? `${selected.size} selected` : 'All values'
    }
    updateSummary()
    const options = document.createElement('div')
    options.className = 'dashboard-filter-options'
    if (component.config.searchable !== false) {
      const search = document.createElement('input')
      search.type = 'search'
      search.placeholder = 'Search values'
      search.setAttribute('aria-label', `Search ${dimension} values`)
      search.addEventListener('input', () => {
        const query = search.value.trim().toLocaleLowerCase()
        options.querySelectorAll('[data-filter-option]').forEach((option) => {
          option.hidden = !option.dataset.filterOption.toLocaleLowerCase().includes(query)
        })
      })
      options.append(search)
    }
    if (component.config.showSelectAll !== false) {
      const selectAll = document.createElement('button')
      selectAll.type = 'button'
      selectAll.className = 'dashboard-filter-select-all'
      selectAll.textContent = 'Select all'
      selectAll.addEventListener('click', () => {
        values.forEach((value) => selected.add(value))
        updateSummary()
        options.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = true })
        setFilter({ mode: filterMode, values: [...selected] })
      })
      options.append(selectAll)
    }
    const clearSelection = document.createElement('button')
    clearSelection.type = 'button'
    clearSelection.className = 'dashboard-filter-select-all'
    clearSelection.textContent = 'Clear selection'
    clearSelection.addEventListener('click', () => {
      selected.clear()
      updateSummary()
      options.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false })
      setFilter({ mode: filterMode, values: [] })
    })
    options.append(clearSelection)
    values.forEach((value) => {
      const label = document.createElement('label')
      label.dataset.filterOption = value
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selected.has(value)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(value)
        else selected.delete(value)
        updateSummary()
        setFilter({ mode: filterMode, values: [...selected] })
      })
      label.append(checkbox, document.createTextNode(value))
      options.append(label)
    })
    details.append(summary, options)
    wrapper.append(labelled(details, 'values'))
    return wrapper
  }

  const controls = document.createElement('span')
  controls.className = 'dashboard-filter-range'
  const first = document.createElement('input')
  const second = document.createElement('input')
  if (filterMode === 'date') {
    first.type = 'date'
    second.type = 'date'
    first.value = current.from || ''
    second.value = current.to || ''
    labelled(first, 'from date')
    labelled(second, 'to date')
    const update = () => setFilter({ mode: filterMode, from: first.value, to: second.value })
    first.addEventListener('change', update)
    second.addEventListener('change', update)
  } else {
    first.type = 'number'
    second.type = 'number'
    first.placeholder = 'Min'
    second.placeholder = 'Max'
    first.value = current.min ?? ''
    second.value = current.max ?? ''
    labelled(first, 'minimum')
    labelled(second, 'maximum')
    const update = () => setFilter({ mode: filterMode, min: first.value, max: second.value })
    first.addEventListener('change', update)
    second.addEventListener('change', update)
  }
  controls.append(first, second)
  wrapper.append(controls)
  return wrapper
}

function componentCard(component) {
  const card = document.createElement('article')
  card.className = `dashboard-card${component.type === 'filter' ? ' dashboard-filter-card' : ''}${component.id === state.selectedId ? ' selected' : ''}${component.visible === false ? ' component-hidden' : ''}`
  card.dataset.componentId = component.id
  card.dataset.visible = String(component.visible !== false)
  updateComponentCardLayout(card, component)
  card.style.height = `${Math.max(component.type === 'filter' ? 42 : 90, Math.min(1200, Number(component.height) || 255))}px`
  const componentMinHeight = component.type === 'filter' ? 42 : Math.max(90, Math.min(1000, Number(component.config.minHeight) || 120))
  const componentMaxHeight = Math.max(componentMinHeight, Math.max(150, Math.min(1200, Number(component.config.maxHeight) || 1200)))
  card.style.minHeight = `${componentMinHeight}px`
  card.style.maxHeight = `${componentMaxHeight}px`
  card.style.justifySelf = component.appearance.justify || 'stretch'
  card.style.alignSelf = component.appearance.align || 'stretch'
  card.style.setProperty('--component-card-bg', validColor(component.appearance.background, state.dashboard.canvas.cardBackground))
  card.style.setProperty('--component-card-radius', `${Math.max(0, Math.min(32, Number(component.appearance.radius) || 8))}px`)
  card.style.setProperty('--component-card-shadow', component.appearance.shadow === false ? 'none' : 'var(--report-shadow)')
  card.style.setProperty('--component-card-padding', `${Math.max(0, Math.min(48, Number(component.appearance.padding) || 12))}px`)
  card.style.setProperty('--component-title-size', `${Math.max(9, Math.min(24, Number(component.config.titleSize) || 13))}px`)
  card.draggable = false
  const header = document.createElement('header')
  header.className = 'dashboard-card-header'
  header.innerHTML = `<span class="dashboard-card-grab" data-editor-only title="Drag to reorder" aria-hidden="true"><i class="bi bi-grip-vertical"></i></span><h3>${escapeHTML(component.title || labels[component.type])}</h3><button type="button" data-editor-only data-card-action="visibility" title="${component.visible === false ? 'Show' : 'Hide'} in presentation" aria-label="${component.visible === false ? 'Show' : 'Hide'} component"><i class="bi ${component.visible === false ? 'bi-eye-slash' : 'bi-eye'}"></i></button><button type="button" data-editor-only data-card-action="up" title="Move forward" aria-label="Move forward"><i class="bi bi-arrow-up"></i></button><button type="button" data-editor-only data-card-action="down" title="Move backward" aria-label="Move backward"><i class="bi bi-arrow-down"></i></button><button type="button" data-editor-only data-card-action="duplicate" title="Duplicate component" aria-label="Duplicate component"><i class="bi bi-copy"></i></button><button type="button" data-editor-only data-card-action="delete" title="Delete component" aria-label="Delete component"><i class="bi bi-trash3"></i></button>`
  const body = document.createElement('div')
  body.className = 'dashboard-card-body'
  body.style.padding = component.type === 'filter' ? '5px 7px' : 'var(--component-card-padding)'
  card.append(header, body)
  if (chartTypes.has(component.type)) {
    const chart = document.createElement('div')
    chart.className = 'dashboard-chart'
    chart.id = `chart-${component.id}`
    chart.style.border = component.config.chartBorder ? `1px solid ${state.dashboard.canvas.textColor}` : '0'
    chart.style.borderRadius = '6px'
    body.append(chart)
  } else if (component.type === 'kpi') {
    const raw = component.config.aggregation === 'count'
      ? displayRows().length
      : component.config.aggregation === 'unique'
        ? new Set(displayRows().map((row) => row[component.config.measure]).filter((value) => value !== null && value !== '')).size
        : aggregate(displayRows().map((row) => row[component.config.measure]), component.config.aggregation || 'sum')
    const value = Number(raw).toLocaleString(undefined, { maximumFractionDigits: 2 })
    body.innerHTML = `<div class="dashboard-kpi"><strong>${escapeHTML(component.config.prefix || '')}${escapeHTML(value)}${escapeHTML(component.config.suffix || '')}</strong><span>${escapeHTML(component.config.measure || 'Rows in dataset')} · ${escapeHTML(component.config.aggregation || 'sum')}</span></div>`
  } else if (component.type === 'table') {
    const columns = state.columns.slice(0, 8)
    const rows = displayRows().slice(0, Math.min(100, Number(component.config.limit) || 20))
    body.innerHTML = columns.length ? `<div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr>${columns.map((column) => `<th>${escapeHTML(column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td title="${escapeHTML(row[column] ?? '')}">${escapeHTML(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="dashboard-empty"><p>Select a dataset to display table rows.</p></div>'
  } else if (component.type === 'text') {
    const tag = ['h1', 'h2', 'h3', 'p'].includes(component.config.headingLevel) ? component.config.headingLevel : 'p'
    const text = document.createElement(tag)
    text.className = 'dashboard-rich-text'
    text.textContent = component.config.text || ''
    body.replaceChildren(text)
  } else if (component.type === 'image') {
    if (component.config.imageData) {
      const image = document.createElement('img')
      image.className = 'dashboard-image'
      image.src = component.config.imageData
      image.alt = component.title || 'Dashboard image'
      body.append(image)
    } else body.innerHTML = '<div class="dashboard-empty"><i class="bi bi-image"></i><p>Choose an image in component settings.</p></div>'
  } else if (component.type === 'divider' || component.type === 'section') {
    body.innerHTML = component.type === 'divider' ? '<div class="dashboard-divider"></div>' : `<div class="dashboard-rich-text"><h2>${escapeHTML(component.title || 'Section')}</h2><p>Arrange related visualizations in this section.</p></div>`
  } else if (component.type === 'filter') {
    body.replaceChildren(createFilterControl(component))
  }
  card.addEventListener('click', (event) => {
    if (event.target.closest('.dashboard-filter-control')) return
    const action = event.target.closest('[data-card-action]')?.dataset.cardAction
    if (action) {
      event.stopPropagation()
      moveOrDelete(component.id, action)
      return
    }
    state.selectedId = component.id
    document.querySelectorAll('.dashboard-card').forEach((item) => item.classList.toggle('selected', item.dataset.componentId === component.id))
    renderConfig()
  })
  header.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return
    event.preventDefault()
    selectComponent(component.id)
    pushUndo()
    state.componentInteraction = {
      kind: 'move',
      id: component.id,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: component.position.x,
      y: component.position.y,
    }
  })
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const resizeHandle = document.createElement('button')
    resizeHandle.type = 'button'
    resizeHandle.className = `dashboard-card-resize dashboard-card-resize-${edge}`
    resizeHandle.dataset.resizeEdge = edge
    resizeHandle.dataset.editorOnly = ''
    resizeHandle.setAttribute('aria-label', `Resize ${component.title} from ${edge}`)
    resizeHandle.title = 'Drag to resize'
    resizeHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      selectComponent(component.id)
      pushUndo()
      state.componentInteraction = {
        kind: 'resize',
        edge,
        id: component.id,
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: Number(component.position.x) || 0,
        y: Number(component.position.y) || 0,
        width: Number(component.width) || 6,
        height: Number(component.height) || 255,
      }
    })
    card.append(resizeHandle)
  }
  return card
}

function updateComponentCardLayout(card, component) {
  const width = Math.max(1, Math.min(12, Number(component.width) || 6))
  const x = Math.max(0, Math.min(12 - width, Number(component.position?.x) || 0))
  const y = Math.max(0, Number(component.position?.y) || 0)
  const gap = Math.max(0, Math.min(60, Number(state.dashboard.canvas.gap) || 0))
  card.style.left = `calc(${(x / 12) * 100}% + ${gap / 2}px)`
  card.style.top = `${y}px`
  card.style.width = `calc(${(width / 12) * 100}% - ${gap}px)`
  card.style.zIndex = String(Number(component.z_index) || 0)
}

function selectComponent(id) {
  state.selectedId = id
  document.querySelectorAll('.dashboard-card').forEach((item) => {
    item.classList.toggle('selected', item.dataset.componentId === id)
  })
  renderConfig()
}

function minimumComponentWidth(component) {
  if (component.type === 'table') return 4
  if (chartTypes.has(component.type)) return 3
  if (component.type === 'filter') return 2
  return 1
}

function minimumComponentHeight(component) {
  return component.type === 'filter' ? 42 : 90
}

function handleComponentPointerMove(event) {
  const interaction = state.componentInteraction
  if (!interaction || interaction.pointerId !== event.pointerId) return
  const component = state.dashboard.components.find((item) => item.id === interaction.id)
  const card = document.querySelector(`[data-component-id="${CSS.escape(interaction.id)}"]`)
  if (!component || !card) return
  const canvas = document.getElementById('dashboard-components')
  const bounds = canvas.getBoundingClientRect()
  if (interaction.kind === 'move') {
    const deltaX = (event.clientX - interaction.pointerX) / Math.max(1, bounds.width) * 12
    const width = Number(component.width) || 6
    component.position.x = Math.max(0, Math.min(12 - width, Math.round(interaction.x + deltaX)))
    component.position.y = Math.max(0, Math.round((interaction.y + event.clientY - interaction.pointerY) / 20) * 20)
  } else {
    const edge = interaction.edge
    const minWidth = minimumComponentWidth(component)
    const deltaColumns = (event.clientX - interaction.pointerX) / Math.max(1, bounds.width) * 12
    const deltaRows = Math.round((event.clientY - interaction.pointerY) / 20) * 20
    if (edge.includes('w')) {
      const right = interaction.x + interaction.width
      const left = Math.max(0, Math.min(right - minWidth, Math.round(interaction.x + deltaColumns)))
      component.position.x = left
      component.width = right - left
    } else if (edge.includes('e')) {
      component.width = Math.max(minWidth, Math.min(12 - interaction.x, Math.round(interaction.width + deltaColumns)))
    }
    if (edge.includes('n')) {
      const bottom = interaction.y + interaction.height
      const top = Math.max(0, Math.min(bottom - minimumComponentHeight(component), interaction.y + deltaRows))
      component.position.y = top
      component.height = bottom - top
    } else if (edge.includes('s')) {
      component.height = Math.max(minimumComponentHeight(component), Math.min(1200, interaction.height + deltaRows))
    }
    card.style.height = `${component.height}px`
  }
  updateComponentCardLayout(card, component)
  canvas.style.height = `${Math.max(240, ...state.dashboard.components.map((item) => Number(item.position?.y || 0) + Number(item.height || 255))) + 20}px`
  state.charts.get(component.id)?.resize()
}

function handleComponentPointerEnd(event) {
  if (!state.componentInteraction || state.componentInteraction.pointerId !== event.pointerId) return
  state.componentInteraction = null
  setStatus('Unsaved changes')
  state.charts.forEach((chart) => chart.resize())
}

function moveOrDelete(id, action) {
  const index = state.dashboard.components.findIndex((item) => item.id === id)
  if (index < 0) return
  pushUndo()
  if (action === 'delete') {
    state.dashboard.components.splice(index, 1)
    if (state.selectedId === id) state.selectedId = null
  } else if (action === 'visibility') {
    state.dashboard.components[index].visible = state.dashboard.components[index].visible === false
  } else if (action === 'duplicate') {
    const copy = structuredClone(state.dashboard.components[index])
    copy.id = crypto.randomUUID()
    copy.title = `${copy.title} copy`
    copy.position = findComponentPosition(copy.width, copy.height)
    copy.z_index = Math.max(-1, ...state.dashboard.components.map((item) => Number(item.z_index) || 0)) + 1
    state.dashboard.components.splice(index + 1, 0, copy)
    state.selectedId = copy.id
  } else {
    const ordered = [...state.dashboard.components].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0))
    const layerIndex = ordered.findIndex((item) => item.id === id)
    const adjacent = ordered[layerIndex + (action === 'up' ? 1 : -1)]
    const component = ordered[layerIndex]
    if (component && adjacent) [component.z_index, adjacent.z_index] = [adjacent.z_index, component.z_index]
  }
  renderComponents()
  renderConfig()
}

function renderFilters() {
  const bar = document.getElementById('dashboard-filter-bar')
  bar.replaceChildren()
  const filters = state.dashboard.components.filter((component) => component.type === 'filter')
  if (!filters.length) return
  const summary = document.createElement('span')
  summary.className = 'dashboard-filter-summary'
  summary.textContent = `${filters.length} filter${filters.length === 1 ? '' : 's'}`
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'dashboard-filter-reset'
  reset.textContent = 'Reset filters'
  reset.disabled = !filters.some((component) => {
    const filter = state.filters[component.id]
    if (!filter) return false
    if (filter.mode === 'categorical') return Boolean(filter.value)
    if (filter.mode === 'multi') return Boolean(filter.values?.length)
    if (filter.mode === 'date') return Boolean(filter.from || filter.to)
    if (filter.mode === 'numeric') return filter.min !== '' || filter.max !== ''
    return false
  })
  reset.addEventListener('click', () => {
    state.filters = {}
    renderComponents()
    setStatus('Filters reset')
  })
  bar.append(summary, reset)
}

function renderComponents() {
  if (state.rendering) return
  state.rendering = true
  state.charts.forEach((chart) => chart.dispose())
  state.charts.clear()
  state.chartResizeObserver?.disconnect()
  if (!state.chartResizeObserver && globalThis.ResizeObserver) {
    state.chartResizeObserver = new globalThis.ResizeObserver((entries) => {
      for (const entry of entries) {
        const chartNode = entry.target
        const component = state.dashboard.components.find((item) => item.id === chartNode.dataset.componentId)
        const chart = state.charts.get(chartNode.dataset.componentId)
        if (!component || !chart) continue
        const layout = chartNode.clientWidth < 360 || chartNode.clientHeight < 220 ? 'compact' : 'regular'
        if (chartNode.dataset.chartLayout !== layout) {
          chartNode.dataset.chartLayout = layout
          chart.setOption(chartOption(component), true)
        }
        chart.resize()
      }
    })
  }
  const canvas = document.getElementById('dashboard-components')
  canvas.replaceChildren()
  applyTheme()
  renderFilters()
  canvas.dataset.columnCount = '12'
  canvas.style.height = `${Math.max(240, ...state.dashboard.components.map((item) => Number(item.position?.y || 0) + Number(item.height || 255))) + 20}px`
  if (!state.dashboard.components.length) {
    const empty = document.createElement('div')
    empty.className = 'dashboard-empty'
    empty.innerHTML = '<i class="bi bi-bar-chart-line"></i><strong>Start designing your dashboard</strong><p>Choose a dataset, then add a chart, KPI, table, or text block from the library.</p>'
    canvas.append(empty)
  } else {
    state.dashboard.components.forEach((component) => {
      component.position ||= findComponentPosition(component.width, component.height)
      component.position.x = Math.max(0, Math.min(12 - Number(component.width || 6), Number(component.position.x) || 0))
      component.position.y = Math.max(0, Number(component.position.y) || 0)
      component.z_index = Number(component.z_index) || 0
      component.layout_section ||= 'main'
      const card = componentCard(component)
      canvas.append(card)
      if (chartTypes.has(component.type) && state.rows.length && state.columns.length) {
        const chartNode = card.querySelector('.dashboard-chart')
        chartNode.dataset.componentId = component.id
        chartNode.dataset.chartLayout = chartNode.clientWidth < 360 || chartNode.clientHeight < 220 ? 'compact' : 'regular'
        const issues = chartFieldIssues(component)
        if (issues.length) {
          chartNode.classList.add('dashboard-chart-warning')
          chartNode.textContent = `Needs configuration: ${issues.join(' ')}`
          return
        }
        if (!globalThis.echarts?.init) {
          chartNode.textContent = 'Charts could not load. Restart the application and try again.'
          chartNode.classList.add('dashboard-empty')
          return
        }
        try {
          const chart = globalThis.echarts.init(chartNode, null, { renderer: 'canvas' })
          chart.setOption(chartOption(component), true)
          state.charts.set(component.id, chart)
          state.chartResizeObserver?.observe(chartNode)
          requestAnimationFrame(() => chart.resize())
        } catch (error) {
          chartNode.textContent = `Could not render this visualization: ${error.message}`
          chartNode.classList.add('dashboard-empty')
          showToast(`Could not render ${component.title || 'visualization'}.`, 'error')
        }
      } else if (chartTypes.has(component.type)) {
        const chartNode = card.querySelector('.dashboard-chart')
        chartNode.classList.add('dashboard-chart-warning')
        chartNode.textContent = 'Select an imported or processed dataset to render this chart.'
      }
    })
  }
  state.rendering = false
}

function autoArrange() {
  if (!state.dashboard.components.length) {
    showToast('Add components before arranging the dashboard.', 'error')
    return
  }
  if (!window.confirm('Auto Arrange replaces component widths and heights with a compact balanced layout. Continue?')) return
  pushUndo()
  const priority = (type) => type === 'kpi' ? 0 : type === 'table' ? 3 : chartTypes.has(type) ? 1 : 2
  state.dashboard.components = state.dashboard.components
    .map((component, index) => ({ component, index }))
    .sort((a, b) => priority(a.component.type) - priority(b.component.type) || a.index - b.index)
    .map(({ component }) => component)
  state.dashboard.components.forEach((component) => {
    const size = defaultComponentSize(component.type)
    if (component.type === 'kpi') Object.assign(component, { width: 3, height: 125 })
    else if (component.type === 'table') Object.assign(component, { width: 12, height: 320 })
    else if (component.type === 'pie' || component.type === 'donut') Object.assign(component, { width: 4, height: 250 })
    else if (component.type === 'divider') Object.assign(component, { width: 12, height: 80 })
    else if (component.type === 'filter') Object.assign(component, { width: 3, height: 84 })
    else if (component.type === 'text' || component.type === 'section' || component.type === 'image') {
      Object.assign(component, { width: Math.min(12, Math.max(4, size.width)), height: Math.max(160, size.height) })
    } else Object.assign(component, { width: 6, height: 255 })
  })
  arrangeComponents(state.dashboard.components)
  renderComponents()
  renderConfig()
  setStatus('Auto-arranged · unsaved changes')
}

function applyLayoutAction(action) {
  if (!state.dashboard.components.length) return
  pushUndo()
  const components = state.dashboard.components
  if (action === 'left' || action === 'center' || action === 'right') {
    components.forEach((item) => {
      item.position.x = action === 'left' ? 0 : action === 'right' ? 12 - item.width : Math.round((12 - item.width) / 2)
    })
  } else if (action === 'top' || action === 'middle' || action === 'bottom') {
    const minY = Math.min(...components.map((item) => Number(item.position.y) || 0))
    const maxY = Math.max(...components.map((item) => (Number(item.position.y) || 0) + Number(item.height || 255)))
    components.forEach((item) => {
      const height = Number(item.height) || 255
      item.position.y = action === 'top' ? minY : action === 'bottom' ? maxY - height : Math.round((minY + maxY - height) / 2 / 20) * 20
    })
  } else if (action === 'equal-width') {
    const width = Math.max(1, Math.min(12, Math.floor(12 / components.length)))
    components.forEach((item, index) => {
      item.width = width
      item.position.x = Math.min(12 - width, index * width)
    })
  } else if (action === 'distribute-horizontal') {
    const totalWidth = components.reduce((total, item) => total + Number(item.width || 6), 0)
    const gap = components.length > 1 ? Math.max(0, (12 - totalWidth) / (components.length - 1)) : 0
    let cursor = 0
    components.forEach((item) => {
      item.position.x = Math.min(12 - item.width, Math.round(cursor))
      cursor += Number(item.width || 6) + gap
    })
  } else if (action === 'equal-height') {
    const height = Math.round(components.reduce((total, item) => total + Number(item.height || 255), 0) / components.length)
    components.forEach((item) => { item.height = Math.max(90, Math.min(1200, height)) })
  } else if (action === 'distribute-vertical') {
    const totalHeight = components.reduce((total, item) => total + Number(item.height || 255), 0)
    const start = Math.min(...components.map((item) => Number(item.position.y) || 0))
    const end = Math.max(...components.map((item) => (Number(item.position.y) || 0) + Number(item.height || 255)))
    const gap = components.length > 1 ? Math.max(0, (end - start - totalHeight) / (components.length - 1)) : 0
    const verticalOrder = [...components].sort((a, b) => Number(a.position.y) - Number(b.position.y))
    let cursor = start
    verticalOrder.forEach((item) => {
      item.position.y = Math.round(cursor / 20) * 20
      cursor += Number(item.height || 255) + gap
    })
  } else if (action === 'front' || action === 'back') {
    const z = action === 'front'
      ? Math.max(...components.map((item) => Number(item.z_index) || 0)) + 1
      : Math.min(...components.map((item) => Number(item.z_index) || 0)) - 1
    if (state.selectedId) {
      const selected = components.find((item) => item.id === state.selectedId)
      if (selected) selected.z_index = z
    }
  } else if (action === 'up' || action === 'down') {
    const ordered = [...components].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0))
    const index = ordered.findIndex((item) => item.id === state.selectedId)
    const adjacent = ordered[index + (action === 'up' ? 1 : -1)]
    const selected = ordered[index]
    if (selected && adjacent) [selected.z_index, adjacent.z_index] = [adjacent.z_index, selected.z_index]
  }
  renderComponents()
  setStatus('Layout updated · unsaved changes')
}

async function refreshData() {
  const id = state.dashboard.dataset_id
  if (!id) return
  const [schemaPayload, previewPayload] = await Promise.all([
    api(`/api/datasets/${encodeURIComponent(id)}/schema`),
    api(`/api/datasets/${encodeURIComponent(id)}/preview?page=1&page_size=100`),
  ])
  state.schema = schemaList(schemaPayload)
  state.columns = previewPayload.columns || state.schema.map((column) => column.name)
  state.rows = asRows(previewPayload)
  state.dataset = { ...state.dataset, ...schemaPayload }
  setDatasetInfo()
  renderComponents()
}

async function loadSavedDashboards() {
  const response = await api('/api/dashboards')
  state.saved = Array.isArray(response) ? response : (response?.dashboards || response?.items || [])
  for (const id of state.selectedDashboardIds) {
    if (!state.saved.some((dashboard) => (dashboard.id || dashboard.dashboard_id) === id)) state.selectedDashboardIds.delete(id)
  }
  const select = document.getElementById('designer-saved')
  select.replaceChildren(new Option('Saved dashboards', ''))
  state.saved.forEach((dashboard) => select.add(new Option(dashboard.name || 'Untitled dashboard', dashboard.id || dashboard.dashboard_id)))
  renderSavedDashboards()
}

function renderSavedDashboards() {
  const list = document.getElementById('saved-dashboard-list')
  if (!state.saved.length) {
    list.innerHTML = '<p class="empty-inline">No saved dashboards yet. Save a dashboard to manage it here.</p>'
  } else {
    list.innerHTML = state.saved.map((dashboard) => {
      const id = dashboard.id || dashboard.dashboard_id
      return `<article class="saved-dashboard-item"><input type="checkbox" data-select-dashboard="${escapeHTML(id)}" aria-label="Select ${escapeHTML(dashboard.name)}" ${state.selectedDashboardIds.has(id) ? 'checked' : ''} /><span title="${escapeHTML(dashboard.name)}">${escapeHTML(dashboard.name || 'Untitled dashboard')}</span><button type="button" data-open-saved-dashboard="${escapeHTML(id)}" aria-label="Open ${escapeHTML(dashboard.name)}" title="Open dashboard"><i class="bi bi-folder2-open"></i></button><button type="button" data-delete-saved-dashboard="${escapeHTML(id)}" aria-label="Delete ${escapeHTML(dashboard.name)}" title="Delete dashboard"><i class="bi bi-trash3"></i></button></article>`
    }).join('')
  }
  const selectedCount = state.selectedDashboardIds.size
  const selectAll = document.getElementById('dashboard-select-all')
  const count = document.getElementById('dashboard-selected-count')
  const deleteSelected = document.getElementById('dashboard-delete-selected')
  selectAll.checked = state.saved.length > 0 && selectedCount === state.saved.length
  selectAll.indeterminate = selectedCount > 0 && selectedCount < state.saved.length
  count.textContent = `${selectedCount} selected`
  deleteSelected.disabled = selectedCount === 0
}

async function saveDashboard() {
  state.dashboard.name = document.getElementById('designer-name').value.trim() || 'Untitled dashboard'
  if (!state.dashboard.dataset_id) {
    showToast('Select a dataset before saving this dashboard.', 'error')
    return
  }
  const isUpdate = Boolean(state.dashboard.id)
  const payload = { ...state.dashboard }
  delete payload.id
  delete payload.dashboard_id
  delete payload.created_at
  delete payload.updated_at
  const result = await api(isUpdate ? `/api/dashboards/${encodeURIComponent(state.dashboard.id)}` : '/api/dashboards', {
    method: isUpdate ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  })
  const saved = safeDashboard(result)
  if (!saved.id && (result?.id || result?.dashboard_id)) saved.id = result.id || result.dashboard_id
  state.dashboard = saved
  document.getElementById('designer-name').value = saved.name
  document.getElementById('dashboard-report-title').textContent = saved.name
  document.getElementById('dashboard-focus-title').textContent = saved.name
  setStatus('Saved')
  await loadSavedDashboards()
  showToast('Dashboard saved.')
}

async function openSavedDashboard(id) {
  const saved = state.saved.find((item) => (item.id || item.dashboard_id) === id)
  if (!saved) return
  const dashboard = await api(`/api/dashboards/${encodeURIComponent(id)}`)
  installDashboard(safeDashboard(dashboard))
  document.getElementById('designer-dataset').value = state.dashboard.dataset_id || ''
  await loadDatasets(state.dashboard.dataset_id || '')
  applyTheme()
  setStatus('Saved dashboard')
}

async function deleteDashboard() {
  if (!state.dashboard.id) {
    showToast('Open a saved dashboard before deleting it.', 'error')
    return
  }
  return deleteDashboards([state.dashboard.id])
}

async function deleteDashboards(ids) {
  const uniqueIds = [...new Set(ids)]
  if (!uniqueIds.length) return
  const closesOpenDashboard = uniqueIds.includes(state.dashboard.id)
  const note = `Datasets referenced by these dashboards will be kept.${closesOpenDashboard ? ' The currently open dashboard will be closed after confirmation.' : ''}`
  if (!await confirmPermanentDelete('dashboards', uniqueIds.length, null, note)) return
  const response = uniqueIds.length === 1
    ? await api(`/api/dashboards/${encodeURIComponent(uniqueIds[0])}`, { method: 'DELETE' })
    : await api('/api/dashboards/delete-selected', {
        method: 'POST',
        body: JSON.stringify({ dashboard_ids: uniqueIds }),
      })
  const deletedIds = Array.isArray(response.deleted)
    ? response.deleted.map((item) => item.dashboard_id)
    : response.deleted ? [response.dashboard_id] : []
  for (const id of deletedIds) state.selectedDashboardIds.delete(id)
  if (deletedIds.includes(state.dashboard.id)) {
    installDashboard(blankDashboard())
    document.getElementById('designer-dataset').value = ''
    await loadDatasets('')
    setStatus('Deleted dashboard closed')
  }
  await loadSavedDashboards()
  if (deletedIds.length) {
    showToast(`${deletedIds.length} dashboard definition(s) deleted. Their datasets were kept.`)
    window.dispatchEvent(new CustomEvent('app:refresh'))
  }
  if (response.failed?.length) showToast(`${response.failed.length} dashboard(s) could not be deleted.`, 'error')
}

async function duplicateDashboard() {
  if (!state.dashboard.dataset_id) {
    showToast('Select a dataset before duplicating this dashboard.', 'error')
    return
  }
  pushUndo()
  const copy = structuredClone(state.dashboard)
  delete copy.id
  copy.name = `${copy.name} copy`
  installDashboard(copy)
  await saveDashboard()
}

async function uploadDataset(file) {
  const form = new FormData()
  form.append('file', file)
  await api('/api/files/upload', { method: 'POST', body: form })
  await loadDatasets()
  showToast('Dataset uploaded.')
}

function drawWrappedText(context, value, x, y, maxWidth, lineHeight, maxLines = 5) {
  const words = String(value || '').split(/\s+/).filter(Boolean)
  let line = ''
  let lineNumber = 0
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (context.measureText(candidate).width > maxWidth && line) {
      context.fillText(line, x, y + lineNumber * lineHeight, maxWidth)
      line = word
      lineNumber += 1
      if (lineNumber >= maxLines) return
    } else line = candidate
  }
  if (line && lineNumber < maxLines) context.fillText(line, x, y + lineNumber * lineHeight, maxWidth)
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath()
  context.roundRect(x, y, Math.max(0, width), Math.max(0, height), Math.max(0, radius))
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('A dashboard image could not be loaded for PNG export.'))
    image.src = source
  })
}

async function createDashboardPNG() {
  const report = document.getElementById('dashboard-canvas')
  const bounds = report.getBoundingClientRect()
  const width = Math.max(report.scrollWidth, Math.ceil(bounds.width))
  const height = Math.max(report.scrollHeight, Math.ceil(bounds.height))
  const pixelRatio = 2
  const output = document.createElement('canvas')
  output.width = width * pixelRatio
  output.height = height * pixelRatio
  const context = output.getContext('2d')
  if (!context) throw new Error('PNG export could not create a drawing surface.')
  context.scale(pixelRatio, pixelRatio)
  const colors = state.dashboard.canvas
  if (colors.style === 'soft-gradient' || colors.style === 'horizontal-gradient' || colors.style === 'radial-gradient') {
    const endColor = colors.preset === 'dark-analytics' ? '#172920' : '#FFFFFF'
    const gradient = colors.style === 'radial-gradient'
      ? context.createRadialGradient(0, 0, 0, 0, 0, Math.max(width, height))
      : colors.style === 'horizontal-gradient'
        ? context.createLinearGradient(0, 0, width, 0)
        : context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, validColor(colors.background, '#F1F8F3'))
    gradient.addColorStop(1, endColor)
    context.fillStyle = gradient
  } else context.fillStyle = validColor(colors.background, '#F1F8F3')
  context.fillRect(0, 0, width, height)
  const reportRect = report.getBoundingClientRect()
  const relativeRect = (element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left - reportRect.left, y: rect.top - reportRect.top, width: rect.width, height: rect.height }
  }

  const eyebrow = document.getElementById('dashboard-report-eyebrow')
  const title = document.getElementById('dashboard-report-title')
  const subtitle = document.getElementById('dashboard-report-subtitle')
  const date = document.getElementById('dashboard-report-date')
  const header = document.querySelector('.dashboard-report-header')
  const headerRect = relativeRect(header)
  const drawTextElement = (element, rect, fallbackSize, fallbackColor) => {
    const style = getComputedStyle(element)
    context.fillStyle = style.color || fallbackColor
    context.font = `${style.fontWeight || 400} ${style.fontSize || `${fallbackSize}px`} ${style.fontFamily || 'Arial'}`
    context.textBaseline = 'top'
    drawWrappedText(context, element.textContent, rect.x, rect.y, rect.width, Math.ceil(fallbackSize * 1.35), 3)
  }
  drawTextElement(eyebrow, relativeRect(eyebrow), 10, colors.textColor)
  drawTextElement(title, relativeRect(title), 22, colors.textColor)
  drawTextElement(subtitle, relativeRect(subtitle), 12, colors.secondaryColor)
  if (date?.textContent) {
    const dateStyle = getComputedStyle(date)
    const rect = relativeRect(date)
    context.fillStyle = dateStyle.color || colors.secondaryColor
    context.font = `${dateStyle.fontSize || '10px'} ${dateStyle.fontFamily || 'Arial'}`
    context.textBaseline = 'top'
    context.textAlign = 'right'
    context.fillText(date.textContent, rect.x + rect.width, rect.y)
    context.textAlign = 'left'
  }
  context.strokeStyle = colors.preset === 'dark-analytics' ? '#385B43' : '#D5EBDD'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(headerRect.x, headerRect.y + headerRect.height)
  context.lineTo(headerRect.x + headerRect.width, headerRect.y + headerRect.height)
  context.stroke()

  const filterBar = document.getElementById('dashboard-filter-bar')
  for (const label of filterBar.querySelectorAll('label')) {
    const rect = relativeRect(label)
    const style = getComputedStyle(label)
    context.fillStyle = validColor(colors.cardBackground, '#FFFFFF')
    context.strokeStyle = colors.preset === 'dark-analytics' ? '#385B43' : '#D5EBDD'
    roundedRect(context, rect.x, rect.y, rect.width, rect.height, 5)
    context.fill()
    context.stroke()
    context.fillStyle = style.color || colors.textColor
    context.font = `600 10px ${style.fontFamily || 'Arial'}`
    context.textBaseline = 'middle'
    const value = label.querySelector('select, input')?.value || label.textContent
    context.fillText(`${label.childNodes[0]?.textContent?.trim() || 'Filter'}: ${value}`, rect.x + 8, rect.y + rect.height / 2, rect.width - 16)
  }

  for (const component of [...state.dashboard.components].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0))) {
    if (component.visible === false) continue
    const card = report.querySelector(`[data-component-id="${CSS.escape(component.id)}"]`)
    if (!card || getComputedStyle(card).display === 'none') continue
    const cardRect = relativeRect(card)
    const cardStyle = getComputedStyle(card)
    const radius = Math.max(0, Math.min(32, Number(component.appearance.radius) || Number(colors.radius) || 8))
    context.save()
    if (component.appearance.shadow !== false && colors.shadows !== false) {
      context.shadowColor = 'rgba(23,77,53,.12)'
      context.shadowBlur = 12
      context.shadowOffsetY = 3
    }
    context.fillStyle = validColor(component.appearance.background, colors.cardBackground)
    context.strokeStyle = cardStyle.borderColor || '#D5EBDD'
    context.lineWidth = 1
    roundedRect(context, cardRect.x, cardRect.y, cardRect.width, cardRect.height, radius)
    context.fill()
    context.shadowColor = 'transparent'
    context.stroke()
    context.save()
    roundedRect(context, cardRect.x, cardRect.y, cardRect.width, cardRect.height, radius)
    context.clip()

    const cardTitle = card.querySelector('.dashboard-card-header h3')
    const titleStyle = getComputedStyle(cardTitle)
    const cardTitleRect = relativeRect(cardTitle)
    context.fillStyle = titleStyle.color || colors.textColor
    context.font = `${titleStyle.fontWeight || 700} ${titleStyle.fontSize || '13px'} ${titleStyle.fontFamily || 'Arial'}`
    context.textBaseline = 'middle'
    context.fillText(cardTitle.textContent, cardTitleRect.x, cardTitleRect.y + cardTitleRect.height / 2, cardTitleRect.width)
    const cardHeaderRect = relativeRect(card.querySelector('.dashboard-card-header'))
    context.strokeStyle = cardStyle.borderColor || '#D5EBDD'
    context.beginPath()
    context.moveTo(cardHeaderRect.x, cardHeaderRect.y + cardHeaderRect.height)
    context.lineTo(cardHeaderRect.x + cardHeaderRect.width, cardHeaderRect.y + cardHeaderRect.height)
    context.stroke()
    const bodyRect = relativeRect(card.querySelector('.dashboard-card-body'))
    context.save()
    context.beginPath()
    context.rect(bodyRect.x, bodyRect.y, bodyRect.width, bodyRect.height)
    context.clip()

    const chartNode = card.querySelector('.dashboard-chart')
    const chart = chartNode && state.charts.get(component.id)
    if (chart) {
      const chartImage = await loadImage(chart.getDataURL({
        type: 'png',
        pixelRatio,
        backgroundColor: component.config.chartBackground || 'transparent',
      }))
      const chartRect = relativeRect(chartNode)
      context.drawImage(chartImage, chartRect.x, chartRect.y, chartRect.width, chartRect.height)
    } else if (component.type === 'kpi') {
      const value = card.querySelector('.dashboard-kpi strong')
      const caption = card.querySelector('.dashboard-kpi span')
      const valueRect = relativeRect(value)
      const captionRect = relativeRect(caption)
      const valueStyle = getComputedStyle(value)
      context.fillStyle = valueStyle.color || colors.textColor
      context.font = `${valueStyle.fontWeight || 700} ${valueStyle.fontSize || '28px'} ${valueStyle.fontFamily || 'Arial'}`
      context.textBaseline = 'top'
      context.fillText(value.textContent, valueRect.x, valueRect.y, valueRect.width)
      const captionStyle = getComputedStyle(caption)
      context.fillStyle = captionStyle.color || colors.secondaryColor
      context.font = `${captionStyle.fontSize || '10px'} ${captionStyle.fontFamily || 'Arial'}`
      context.fillText(caption.textContent, captionRect.x, captionRect.y, captionRect.width)
    } else if (component.type === 'table') {
      const table = card.querySelector('.dashboard-table')
      if (table) {
        for (const row of table.rows) {
          for (const cell of row.cells) {
            const cellRect = relativeRect(cell)
            const cellStyle = getComputedStyle(cell)
            if (row.parentElement.tagName === 'THEAD') {
              context.fillStyle = colors.preset === 'dark-analytics' ? '#20372A' : '#F4FBF6'
              context.fillRect(cellRect.x, cellRect.y, cellRect.width, cellRect.height)
            }
            context.fillStyle = cellStyle.color || colors.textColor
            context.font = `${cellStyle.fontWeight || 400} ${cellStyle.fontSize || '10px'} ${cellStyle.fontFamily || 'Arial'}`
            context.textBaseline = 'middle'
            context.fillText(cell.textContent, cellRect.x + 7, cellRect.y + cellRect.height / 2, Math.max(0, cellRect.width - 14))
            context.strokeStyle = colors.preset === 'dark-analytics' ? '#385B43' : '#E1EFE5'
            context.beginPath()
            context.moveTo(cellRect.x, cellRect.y + cellRect.height)
            context.lineTo(cellRect.x + cellRect.width, cellRect.y + cellRect.height)
            context.stroke()
          }
        }
      }
    } else if (component.type === 'filter') {
      const filterControl = card.querySelector('.dashboard-filter-control')
      if (filterControl) {
        const controls = filterControl.querySelectorAll('input:not([type="checkbox"]), select, summary')
        controls.forEach((control) => {
          const rect = relativeRect(control)
          const style = getComputedStyle(control)
          context.fillStyle = validColor(colors.cardBackground, '#FFFFFF')
          context.strokeStyle = colors.preset === 'dark-analytics' ? '#385B43' : '#D5EBDD'
          roundedRect(context, rect.x, rect.y, rect.width, rect.height, 4)
          context.fill()
          context.stroke()
          context.fillStyle = style.color || colors.textColor
          context.font = `10px ${style.fontFamily || 'Arial'}`
          context.textBaseline = 'middle'
          const value = control.value || control.placeholder || control.getAttribute('aria-label') || control.textContent || 'All values'
          context.fillText(value, rect.x + 6, rect.y + rect.height / 2, Math.max(0, rect.width - 12))
        })
      }
    } else if (component.type === 'image') {
      const imageElement = card.querySelector('.dashboard-image')
      if (imageElement) {
        const imageRect = relativeRect(imageElement)
        const image = await loadImage(imageElement.currentSrc || imageElement.src)
        context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height)
      }
    } else if (component.type === 'divider') {
      const divider = card.querySelector('.dashboard-divider')
      const rect = relativeRect(divider)
      context.strokeStyle = colors.textColor
      context.beginPath()
      context.moveTo(rect.x, rect.y + rect.height / 2)
      context.lineTo(rect.x + rect.width, rect.y + rect.height / 2)
      context.stroke()
    } else {
      const textElement = card.querySelector('.dashboard-rich-text, .dashboard-filter-preview, .dashboard-empty')
      if (textElement) {
        const rect = relativeRect(textElement)
        const style = getComputedStyle(textElement)
        context.fillStyle = style.color || colors.secondaryColor
        context.font = `${style.fontWeight || 400} ${style.fontSize || '12px'} ${style.fontFamily || 'Arial'}`
        context.textBaseline = 'top'
        drawWrappedText(context, textElement.innerText || textElement.textContent, rect.x, rect.y, rect.width, 18)
      }
    }
    context.restore()
    context.restore()
    context.restore()
  }
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode the dashboard PNG.')), 'image/png')
  })
}

async function downloadPNG() {
  const canvas = document.getElementById('dashboard-canvas')
  if (!state.dashboard.dataset_id || !state.rows.length) {
    showToast('Choose a dataset with preview rows before exporting.', 'error')
    return
  }
  await saveDashboard()
  document.body.classList.add('dashboard-exporting')
  canvas.classList.add('exporting')
  try {
    state.charts.forEach((chart) => chart.resize())
    await document.fonts?.ready
    await Promise.all([...canvas.querySelectorAll('img')].map((image) => image.decode().catch(() => {
      throw new Error(`Dashboard image "${image.alt || 'image'}" could not be decoded for export.`)
    })))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    state.charts.forEach((chart) => chart.resize())
    const blob = await createDashboardPNG()
    const link = document.createElement('a')
    link.download = `${(state.dashboard.name || 'dashboard').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Dashboard'}.png`
    link.href = URL.createObjectURL(blob)
    link.style.position = 'fixed'
    link.style.left = '-10000px'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 5000)
    showToast('PNG dashboard downloaded.')
  } finally {
    canvas.classList.remove('exporting')
    document.body.classList.remove('dashboard-exporting')
    requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
  }
}

function togglePreview() {
  const layout = document.querySelector('.designer-layout')
  const button = document.getElementById('designer-preview-toggle')
  const preview = !layout.classList.contains('preview-mode')
  layout.classList.toggle('preview-mode', preview)
  document.body.classList.toggle('dashboard-preview', preview)
  button.innerHTML = preview ? '<i class="bi bi-pencil"></i> Edit Dashboard' : '<i class="bi bi-easel"></i> Preview Dashboard'
  document.getElementById('dashboard-focus-preview').innerHTML = preview
    ? '<i class="bi bi-pencil"></i><span>Edit Dashboard</span>'
    : '<i class="bi bi-easel"></i><span>Preview Dashboard</span>'
  if (preview) document.getElementById('dashboard-report-date').textContent = new Date().toLocaleDateString()
  requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
}

async function setDashboardFocus(enabled) {
  document.body.classList.toggle('dashboard-focus-mode', enabled)
  if (enabled) {
    document.getElementById('dashboard-focus-title').textContent = state.dashboard.name || 'Untitled dashboard'
    requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen()
      } catch {
        showToast('Dashboard focus mode is active without browser fullscreen.', 'error')
      }
    }
    return
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    try {
      await document.exitFullscreen()
    } catch {
      showToast('Could not exit browser fullscreen. Dashboard focus mode was closed.', 'error')
    }
  }
  requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
}

async function setPresentationMode(enabled) {
  document.body.classList.toggle('dashboard-presentation', enabled)
  document.getElementById('designer-exit-presentation').hidden = !enabled
  document.getElementById('designer-presentation').innerHTML = enabled
    ? '<i class="bi bi-pencil"></i> Edit Mode'
    : '<i class="bi bi-fullscreen"></i> View Dashboard'
  if (enabled && document.fullscreenEnabled && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen()
    } catch (error) {
      showToast(`Presentation mode is active, but fullscreen could not be started: ${error.message}`, 'error')
    }
  } else if (!enabled && document.fullscreenElement) {
    try {
      await document.exitFullscreen()
    } catch (error) {
      showToast(`Fullscreen could not be exited: ${error.message}`, 'error')
    }
  }
  requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
}

async function historyAction(direction) {
  const from = direction === 'undo' ? state.undo : state.redo
  const to = direction === 'undo' ? state.redo : state.undo
  if (!from.length) return
  const undo = state.undo
  const redo = state.redo
  const previousDatasetId = state.dashboard.dataset_id
  to.push(JSON.stringify(state.dashboard))
  const value = from.pop()
  installDashboard(JSON.parse(value))
  state.undo = undo
  state.redo = redo
  document.getElementById('designer-dataset').value = state.dashboard.dataset_id || ''
  state.dataset = state.datasets.find((item) => (item.file_id || item.dataset_id || item.id) === state.dashboard.dataset_id) || null
  updateHistoryButtons()
  setStatus('Unsaved changes')
  if (previousDatasetId !== state.dashboard.dataset_id) {
    if (state.dashboard.dataset_id) await refreshData()
    else {
      state.dataset = null
      state.rows = []
      state.schema = []
      state.columns = []
      setDatasetInfo()
      renderComponents()
    }
  }
}

export function initDashboardDesigner() {
  applyTheme()
  document.getElementById('designer-focus-toggle').addEventListener('click', () => {
    setDashboardFocus(true).catch((error) => showToast(error.message || 'Dashboard focus mode could not be opened.', 'error'))
  })
  document.getElementById('dashboard-focus-exit').addEventListener('click', () => {
    setDashboardFocus(false).catch((error) => showToast(error.message || 'Dashboard focus mode could not be closed.', 'error'))
  })
  document.querySelectorAll('[data-focus-add]').forEach((button) => {
    button.addEventListener('click', () => addComponent(button.dataset.focusAdd))
  })
  document.getElementById('dashboard-focus-undo').addEventListener('click', () => historyAction('undo').catch((error) => showToast(error.message || 'Undo failed.', 'error')))
  document.getElementById('dashboard-focus-redo').addEventListener('click', () => historyAction('redo').catch((error) => showToast(error.message || 'Redo failed.', 'error')))
  document.getElementById('dashboard-focus-save').addEventListener('click', () => saveDashboard().catch((error) => showToast(error.message || 'Dashboard could not be saved.', 'error')))
  document.getElementById('dashboard-focus-preview').addEventListener('click', togglePreview)
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('dashboard-focus-mode')) {
      document.body.classList.remove('dashboard-focus-mode')
      requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('dashboard-focus-mode') && !document.fullscreenElement) {
      setDashboardFocus(false).catch((error) => showToast(error.message || 'Dashboard focus mode could not be closed.', 'error'))
    }
  })
  document.addEventListener('pointermove', handleComponentPointerMove)
  document.addEventListener('pointerup', handleComponentPointerEnd)
  document.addEventListener('pointercancel', handleComponentPointerEnd)
  document.getElementById('designer-canvas-settings').addEventListener('click', openCanvasSettings)
  document.getElementById('designer-auto-arrange').addEventListener('click', autoArrange)
  document.getElementById('designer-presentation').addEventListener('click', () => {
    setPresentationMode(!document.body.classList.contains('dashboard-presentation'))
      .catch((error) => showToast(error.message || 'Presentation mode could not be changed.', 'error'))
  })
  document.getElementById('designer-exit-presentation').addEventListener('click', () => {
    setPresentationMode(false).catch((error) => showToast(error.message || 'Presentation mode could not be closed.', 'error'))
  })
  document.getElementById('canvas-settings-apply').addEventListener('click', applyCanvasSettings)
  document.getElementById('canvas-preset-grid').addEventListener('click', (event) => {
    const preset = event.target.closest('[data-canvas-preset]')?.dataset.canvasPreset
    if (preset) setCanvasPreset(preset)
  })
  document.getElementById('canvas-dimensions').addEventListener('change', (event) => {
    const dimensions = canvasDimensions[event.target.value]
    const custom = event.target.value === 'custom'
    const width = document.getElementById('canvas-width')
    const height = document.getElementById('canvas-height')
    width.disabled = !custom
    height.disabled = !custom
    if (dimensions) {
      width.value = dimensions[0]
      height.value = dimensions[1]
    }
  })
  document.getElementById('designer-dataset').addEventListener('change', async (event) => {
    try { await selectDataset(event.target.value) } catch (error) { showToast(error.message || 'Could not load this dataset.', 'error') }
  })
  document.getElementById('designer-dataset-source').addEventListener('change', async () => {
    const currentId = state.dashboard.dataset_id || ''
    const keepSelection = currentId && state.datasets.some((item) => (item.file_id || item.dataset_id || item.id) === currentId)
    await loadDatasets(keepSelection ? currentId : '').catch((error) => showToast(error.message || 'Could not refresh the dataset list.', 'error'))
  })
  document.getElementById('designer-name').addEventListener('input', (event) => {
    state.dashboard.name = event.target.value
    document.getElementById('dashboard-report-title').textContent = event.target.value
    document.getElementById('dashboard-focus-title').textContent = event.target.value || 'Untitled dashboard'
    setStatus('Unsaved changes')
  })
  document.getElementById('designer-name').addEventListener('change', () => renderConfig())
  document.querySelectorAll('[data-add-component]').forEach((button) => button.addEventListener('click', () => addComponent(button.dataset.addComponent)))
  document.querySelectorAll('[data-use-template]').forEach((button) => button.addEventListener('click', () => addTemplate(button.dataset.useTemplate)))
  document.getElementById('designer-component-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase()
    document.querySelectorAll('[data-add-component]').forEach((button) => { button.hidden = query && !button.textContent.toLowerCase().includes(query) })
  })
  document.getElementById('designer-template').addEventListener('change', (event) => { if (event.target.value) addTemplate(event.target.value) })
  document.getElementById('designer-upload').addEventListener('click', () => document.getElementById('designer-file-input').click())
  document.getElementById('designer-new').addEventListener('click', () => {
    if (state.dashboard.components.length && !window.confirm('Start a new dashboard? Unsaved changes will be lost.')) return
    installDashboard(blankDashboard())
    document.getElementById('designer-dataset').value = ''
    state.dataset = null
    state.schema = []
    state.columns = []
    state.rows = []
    setDatasetInfo()
    setStatus('New dashboard')
  })
  document.getElementById('designer-file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try { await uploadDataset(file) } catch (error) { showToast(error.message || 'Dataset upload failed.', 'error') }
    event.target.value = ''
  })
  document.getElementById('designer-undo').addEventListener('click', () => historyAction('undo').catch((error) => showToast(error.message || 'Undo failed.', 'error')))
  document.getElementById('designer-redo').addEventListener('click', () => historyAction('redo').catch((error) => showToast(error.message || 'Redo failed.', 'error')))
  document.getElementById('designer-save').addEventListener('click', () => saveDashboard().catch((error) => showToast(error.message || 'Dashboard could not be saved.', 'error')))
  document.getElementById('designer-open').addEventListener('click', async () => {
    const id = document.getElementById('designer-saved').value
    if (!id) { showToast('Choose a saved dashboard first.', 'error'); return }
    try { await openSavedDashboard(id) } catch (error) { showToast(error.message || 'Dashboard could not be opened.', 'error') }
  })
  document.getElementById('designer-delete').addEventListener('click', () => deleteDashboard().catch((error) => showToast(error.message || 'Dashboard could not be deleted.', 'error')))
  document.getElementById('designer-duplicate').addEventListener('click', () => duplicateDashboard().catch((error) => showToast(error.message || 'Dashboard could not be duplicated.', 'error')))
  document.getElementById('designer-preview-toggle').addEventListener('click', togglePreview)
  document.getElementById('designer-download').addEventListener('click', () => downloadPNG().catch((error) => showToast(error.message || 'PNG export failed.', 'error')))
  document.getElementById('saved-dashboard-list').addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-dashboard]')
    if (!checkbox) return
    if (checkbox.checked) state.selectedDashboardIds.add(checkbox.dataset.selectDashboard)
    else state.selectedDashboardIds.delete(checkbox.dataset.selectDashboard)
    renderSavedDashboards()
  })
  document.getElementById('dashboard-select-all').addEventListener('change', (event) => {
    state.selectedDashboardIds.clear()
    if (event.target.checked) {
      state.saved.forEach((dashboard) => state.selectedDashboardIds.add(dashboard.id || dashboard.dashboard_id))
    }
    renderSavedDashboards()
  })
  document.getElementById('dashboard-delete-selected').addEventListener('click', () => {
    deleteDashboards([...state.selectedDashboardIds]).catch((error) => showToast(error.message || 'Selected dashboards could not be deleted.', 'error'))
  })
  document.getElementById('dashboard-clear-all').addEventListener('click', () => {
    deleteDashboards(state.saved.map((dashboard) => dashboard.id || dashboard.dashboard_id))
      .catch((error) => showToast(error.message || 'Dashboards could not be deleted.', 'error'))
  })
  document.getElementById('saved-dashboard-list').addEventListener('click', (event) => {
    const openButton = event.target.closest('[data-open-saved-dashboard]')
    if (openButton) {
      openSavedDashboard(openButton.dataset.openSavedDashboard).catch((error) => showToast(error.message || 'Dashboard could not be opened.', 'error'))
      return
    }
    const deleteButton = event.target.closest('[data-delete-saved-dashboard]')
    if (deleteButton) {
      deleteDashboards([deleteButton.dataset.deleteSavedDashboard])
        .catch((error) => showToast(error.message || 'Dashboard could not be deleted.', 'error'))
    }
  })
  window.addEventListener('app:pagechange', async (event) => {
    if (event.detail.page !== 'dashboard-designer') return
    try {
      await Promise.all([loadDatasets(), loadSavedDashboards()])
      if (state.dashboard.dataset_id) await refreshData()
    } catch (error) { showToast(error.message || 'Dashboard Designer could not load its data.', 'error') }
  })
  window.addEventListener('resize', () => state.charts.forEach((chart, id) => {
    const component = state.dashboard.components.find((item) => item.id === id)
    if (component?.config.responsive !== false) chart.resize()
  }))
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('dashboard-focus-mode') && !document.fullscreenElement) {
      setDashboardFocus(false).catch((error) => showToast(error.message || 'Dashboard focus mode could not be closed.', 'error'))
    }
    if (event.key === 'Escape' && document.body.classList.contains('dashboard-presentation')) {
      setPresentationMode(false).catch((error) => showToast(error.message || 'Presentation mode could not be closed.', 'error'))
    }
  })
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('dashboard-focus-mode')) {
      document.body.classList.remove('dashboard-focus-mode')
      requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
    }
    if (!document.fullscreenElement && document.body.classList.contains('dashboard-presentation')) {
      document.body.classList.remove('dashboard-presentation')
      document.getElementById('designer-exit-presentation').hidden = true
      document.getElementById('designer-presentation').innerHTML = '<i class="bi bi-fullscreen"></i> View Dashboard'
      requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
    }
  })
  window.addEventListener('app:appearance-change', () => {
    applyTheme()
    renderComponents()
  })
  loadDatasets().catch((error) => showToast(error.message || 'Could not load datasets.', 'error'))
  loadSavedDashboards().catch((error) => showToast(error.message || 'Could not load saved dashboards.', 'error'))
  setInterval(() => {
    if (document.getElementById('page-dashboard-designer').hidden || !state.dashboard.dataset_id) return
    refreshData().catch((error) => showToast(error.message || 'Dashboard data refresh failed.', 'error'))
  }, 60_000)
}
