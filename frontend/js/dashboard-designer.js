import { api, escapeHTML, showToast } from './app.js'

const chartTypes = new Set([
  'bar', 'horizontalBar', 'line', 'area', 'pie', 'donut', 'scatter', 'bubble',
  'histogram', 'radar', 'treemap', 'funnel', 'waterfall', 'heatmap',
])
const palette = ['#174D35', '#206B48', '#269B65', '#43B97A', '#80D6A5', '#B4E6C7', '#DDF4E6']
const templates = {
  sales: [['kpi', 'Total sales'], ['bar', 'Sales by category'], ['line', 'Sales trend'], ['table', 'Sales details']],
  finance: [['kpi', 'Total amount'], ['area', 'Financial trend'], ['waterfall', 'Amount changes'], ['table', 'Financial records']],
  inventory: [['kpi', 'Items in dataset'], ['treemap', 'Inventory by category'], ['bar', 'Stock by category'], ['table', 'Inventory details']],
  general: [['kpi', 'Rows in dataset'], ['bar', 'Values by category'], ['line', 'Dataset trend'], ['table', 'Dataset records']],
}
const labels = {
  bar: 'Bar Chart', horizontalBar: 'Horizontal Bar', line: 'Line Chart', area: 'Area Chart',
  pie: 'Pie Chart', donut: 'Donut Chart', scatter: 'Scatter Plot', bubble: 'Bubble Chart',
  histogram: 'Histogram', radar: 'Radar Chart', treemap: 'Treemap', funnel: 'Funnel Chart',
  waterfall: 'Waterfall', heatmap: 'Heatmap', kpi: 'KPI Card', table: 'Data Table',
  text: 'Text / Heading', image: 'Image', divider: 'Divider', filter: 'Filter Control', section: 'Section',
}
const state = {
  dashboard: blankDashboard(), datasets: [], dataset: null, columns: [], schema: [], rows: [],
  charts: new Map(), selectedId: null, saved: [], undo: [], redo: [], rendering: false, filters: {},
}

function blankDashboard() {
  return {
    name: 'Untitled dashboard',
    dataset_id: '',
    subtitle: 'Select a dataset and add visualizations to get started.',
    eyebrow: 'DATA INSIGHTS',
    theme: { accent: '#206B48', surface: '#FFFFFF', text: '#174D35' },
    components: [],
  }
}

function makeComponent(type, schema = []) {
  const dimension = schema.find((column) => column.kind !== 'numeric')?.name || ''
  const measure = schema.find((column) => column.kind === 'numeric')?.name || ''
  return {
    id: crypto.randomUUID(),
    type,
    title: labels[type] || 'Visualization',
    size: 'medium',
    config: {
      dimension,
      measure,
      measure2: schema.find((column) => column.kind === 'numeric' && column.name !== measure)?.name || measure,
      aggregation: measure ? 'sum' : 'count',
      filterMode: 'categorical',
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
  return {
    ...blankDashboard(),
    ...dashboard,
    id: dashboard.id || dashboard.dashboard_id,
    name: dashboard.name || 'Untitled dashboard',
    theme: { ...blankDashboard().theme, ...(dashboard.theme || {}) },
    components: Array.isArray(dashboard.components) ? dashboard.components.map((component) => ({
      ...makeComponent(component.type || 'bar'),
      ...component,
      config: { ...makeComponent(component.type || 'bar').config, ...(component.config || {}) },
    })) : [],
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
  const payload = await api('/api/datasets')
  state.datasets = recordList(payload)
  const select = document.getElementById('designer-dataset')
  select.replaceChildren(new Option('Select a dataset', ''))
  state.datasets.forEach((dataset) => {
    const id = dataset.file_id || dataset.dataset_id || dataset.id
    if (!id) return
    const option = new Option(`${dataset.filename || dataset.name || id}${dataset.status === 'processed' ? ' · processed' : ''}`, id)
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
  state.dashboard.components.forEach((component) => {
    if (!component.config.dimension) component.config.dimension = defaultDimension()
    if (!component.config.measure) {
      component.config.measure = defaultMeasure()
      if (!component.config.measure && (chartTypes.has(component.type) || component.type === 'kpi')) {
        component.config.aggregation = 'count'
      }
    }
  })
  setStatus('Unsaved changes')
  setDatasetInfo()
  renderComponents()
  renderConfig()
}

function defaultDimension() {
  return state.schema.find((column) => column.kind !== 'numeric')?.name || state.columns[0] || ''
}

function defaultMeasure() {
  return state.schema.find((column) => column.kind === 'numeric')?.name || ''
}

function snapshotRows() {
  return state.rows.filter((row) => Object.entries(state.filters).every(([componentId, filter]) => {
    const component = state.dashboard.components.find((item) => item.id === componentId)
    if (!component || !filter) return true
    const value = row[component.config.dimension]
    if (filter.mode === 'categorical' && filter.value) return String(value ?? '') === filter.value
    if (filter.mode === 'numeric') {
      const number = Number(value)
      if (!Number.isFinite(number)) return false
      return (!filter.min || number >= Number(filter.min)) && (!filter.max || number <= Number(filter.max))
    }
    if (filter.mode === 'date') {
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
  const options = available.map((column) => `<option value="${escapeHTML(column.name)}"${column.name === selected ? ' selected' : ''}>${escapeHTML(column.name)}</option>`).join('')
  return `<option value="">${kind === 'numeric' ? 'Select numeric field' : 'Select a field'}</option>${options}`
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
    input = `<input id="${id}" data-config-key="${key}" type="${options.type || 'text'}" value="${escapeHTML(value ?? '')}"${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}>`
  }
  return `<label class="designer-config-field">${escapeHTML(label)}${input}</label>`
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
        ${configField('Text color', 'theme-text', state.dashboard.theme.text, { choices: [['#111111', 'Black'], ['#174D35', 'Forest green']] })}
      </section>
      <section class="designer-config-section"><h3>LAYOUT</h3><p class="designer-config-field">Drag dashboard cards to reorder them. Choose a size in a component's settings.</p><div class="designer-config-actions"><button type="button" data-dashboard-action="clear">Clear components</button></div></section>
    `
  } else {
    const { type, config } = component
    let fields = configField('Title', 'title', component.title)
    if (chartTypes.has(type)) {
      fields += configField('Category / dimension', 'dimension', config.dimension, { field: 'any' })
      if (['scatter', 'bubble', 'heatmap'].includes(type)) {
        fields += configField(type === 'heatmap' ? 'Second dimension' : 'X-axis measure', 'measure2', config.measure2, { field: 'numeric' })
      }
      if (!['pie', 'donut', 'radar', 'treemap', 'funnel'].includes(type)) {
        fields += configField('Value / measure', 'measure', config.measure, { field: 'numeric' })
      }
      if (type === 'bubble') fields += configField('Bubble size', 'sizeMeasure', config.sizeMeasure || config.measure, { field: 'numeric' })
      if (type === 'histogram') fields += configField('Histogram bins', 'bins', config.bins || 8, { type: 'number', min: 2, max: 30 })
      fields += configField('Aggregation', 'aggregation', config.aggregation || 'sum', { choices: [['sum', 'Sum'], ['average', 'Average'], ['count', 'Count'], ['min', 'Minimum'], ['max', 'Maximum']] })
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
      fields += configField('Filter type', 'filterMode', config.filterMode || 'categorical', { choices: [['categorical', 'Category'], ['date', 'Date range'], ['numeric', 'Numeric range']] })
    }
    if (type === 'image') fields += `<label class="designer-config-field">Choose image<input id="config-image" type="file" accept="image/*"></label>`
    content.innerHTML = `
      <section class="designer-config-section"><h3>CONTENT</h3>${fields}</section>
      <section class="designer-config-section"><h3>SIZE</h3>${configField('Card width', 'size', component.size || 'medium', { choices: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Full width']] })}</section>
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
    } else if (dashboardProp === 'subtitle') document.getElementById('dashboard-report-subtitle').textContent = target.value
    else document.getElementById('dashboard-report-eyebrow').textContent = target.value
    return
  }
  if (key.startsWith('theme-')) {
    pushUndo()
    const prop = key.slice(6)
    state.dashboard.theme[prop] = target.value
    applyTheme()
    renderComponents()
    return
  }
  updateComponentConfig(key, target.type === 'number' ? Number(target.value) : target.value)
}

function updateComponentConfig(key, value) {
  const component = state.dashboard.components.find((item) => item.id === state.selectedId)
  if (!component) return
  pushUndo()
  if (key === 'title' || key === 'size') component[key] = value
  else component.config[key] = value
  if (key === 'dimension' || key === 'filterMode' || key === 'aggregation' || key === 'measure' || key === 'measure2' || key === 'size') {
    renderComponents()
    renderConfig()
  } else renderComponents()
}

function handleConfigAction(event) {
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
  state.selectedId = state.dashboard.components[0]?.id || null
  state.dashboard.name = `${name.charAt(0).toUpperCase()}${name.slice(1)} dashboard`
  document.getElementById('designer-name').value = state.dashboard.name
  document.getElementById('dashboard-report-title').textContent = state.dashboard.name
  document.getElementById('designer-template').value = ''
  renderComponents()
  renderConfig()
}

function applyTheme() {
  const canvas = document.getElementById('dashboard-canvas')
  canvas.style.setProperty('--report-accent', state.dashboard.theme.accent)
  canvas.style.setProperty('--report-surface', state.dashboard.theme.surface)
  canvas.style.setProperty('--report-ink', state.dashboard.theme.text)
}

function displayRows() {
  return snapshotRows()
}

function aggregate(values, method = 'sum') {
  const numbers = values.map(Number).filter(Number.isFinite)
  if (method === 'count') return values.filter((value) => value !== null && value !== '').length
  if (method === 'unique') return new Set(values.filter((value) => value !== null && value !== '')).size
  if (!numbers.length) return 0
  if (method === 'average') return numbers.reduce((a, b) => a + b, 0) / numbers.length
  if (method === 'min') return Math.min(...numbers)
  if (method === 'max') return Math.max(...numbers)
  return numbers.reduce((a, b) => a + b, 0)
}

function groupedData(component, rows = displayRows()) {
  const { dimension, measure, aggregation = 'sum' } = component.config
  const groups = new Map()
  rows.forEach((row) => {
    const label = String(row[dimension] ?? '(blank)')
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(row[measure])
  })
  const values = [...groups].map(([name, list]) => [
    name,
    aggregation === 'count' && !measure ? list.length : aggregate(list, aggregation),
  ])
  return values.length > 30 ? values.slice(0, 30) : values
}

function chartOption(component) {
  const rows = displayRows()
  const { type, config } = component
  const axis = {
    axisLine: { lineStyle: { color: '#B4D9C1' } },
    axisLabel: { color: '#486B55', fontSize: 9, hideOverlap: true },
    splitLine: { lineStyle: { color: '#EAF6EE' } },
  }
  const base = { animationDuration: 450, color: palette, textStyle: { color: '#174D35', fontFamily: 'Inter, sans-serif' }, tooltip: { trigger: 'axis' }, grid: { top: 24, left: 44, right: 18, bottom: 42, containLabel: true } }
  const groups = groupedData(component, rows)
  const names = groups.map((item) => item[0])
  const values = groups.map((item) => item[1])
  if (['bar', 'horizontalBar', 'line', 'area', 'waterfall'].includes(type)) {
    const horizontal = type === 'horizontalBar'
    const series = { type: type === 'line' || type === 'area' ? 'line' : 'bar', data: values, smooth: type === 'line' || type === 'area', itemStyle: { borderRadius: type.includes('Bar') || type === 'bar' ? 4 : 0 }, areaStyle: type === 'area' ? { opacity: .2 } : undefined }
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
        xAxis: horizontal ? { type: 'value', ...axis } : { type: 'category', data: names, ...axis },
        yAxis: horizontal ? { type: 'category', data: names, ...axis } : { type: 'value', ...axis },
        series: [
          { type: 'bar', stack: 'total', data: baseValues, itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } } },
          { type: 'bar', stack: 'total', data: positive, itemStyle: { color: '#269B65', borderRadius: 3 } },
          { type: 'bar', stack: 'total', data: negative, itemStyle: { color: '#80D6A5', borderRadius: 3 } },
        ],
      }
    }
    return { ...base, xAxis: horizontal ? { type: 'value', ...axis } : { type: 'category', data: names, ...axis }, yAxis: horizontal ? { type: 'category', data: names, ...axis } : { type: 'value', ...axis }, series: [{ ...series, encode: undefined, ...(horizontal ? { data: values } : {}) }] }
  }
  if (type === 'pie' || type === 'donut') return { ...base, tooltip: { trigger: 'item' }, legend: { bottom: 0, textStyle: { color: '#486B55', fontSize: 9 } }, series: [{ type: 'pie', radius: type === 'donut' ? ['42%', '70%'] : '68%', center: ['50%', '45%'], data: groups.map(([name, value]) => ({ name, value })), label: { color: '#174D35', fontSize: 9 }, itemStyle: { borderColor: '#fff', borderWidth: 2 } }] }
  if (type === 'scatter' || type === 'bubble') return { ...base, xAxis: { type: 'value', name: config.measure2, ...axis }, yAxis: { type: 'value', name: config.measure, ...axis }, series: [{ type: 'scatter', data: rows.slice(0, 500).map((row) => [Number(row[config.measure2]), Number(row[config.measure]), type === 'bubble' ? Number(row[config.sizeMeasure || config.measure]) || 10 : 10]).filter((point) => point.every(Number.isFinite)), symbolSize: (value) => type === 'bubble' ? Math.max(5, Math.min(28, Math.sqrt(Math.abs(value[2])) * 2)) : 8 }] }
  if (type === 'histogram') {
    const valuesNumeric = rows.map((row) => Number(row[config.measure])).filter(Number.isFinite)
    if (!valuesNumeric.length) return { ...base, xAxis: { type: 'category', data: [] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [] }] }
    const min = Math.min(...valuesNumeric)
    const max = Math.max(...valuesNumeric)
    const count = Math.max(2, Math.min(30, Number(config.bins) || 8))
    const width = (max - min) / count || 1
    const bins = Array.from({ length: count }, (_, index) => ({ name: `${(min + index * width).toPrecision(3)}–${(min + (index + 1) * width).toPrecision(3)}`, value: 0 }))
    valuesNumeric.forEach((value) => { bins[Math.min(count - 1, Math.floor((value - min) / width))].value += 1 })
    return { ...base, xAxis: { type: 'category', data: bins.map((bin) => bin.name), ...axis }, yAxis: { type: 'value', ...axis }, series: [{ type: 'bar', data: bins.map((bin) => bin.value), itemStyle: { borderRadius: [4, 4, 0, 0] } }] }
  }
  if (type === 'radar') return { ...base, radar: { indicator: groups.map(([name]) => ({ name, max: Math.max(1, ...values.map(Math.abs)) })), axisName: { color: '#206B48', fontSize: 9 }, splitArea: { areaStyle: { color: ['#FFFFFF', '#F4FBF6'] } } }, series: [{ type: 'radar', data: [{ value: values, name: component.title }], areaStyle: { opacity: .18 } }] }
  if (type === 'treemap' || type === 'funnel') return { ...base, tooltip: { trigger: 'item' }, series: [{ type, data: groups.map(([name, value]) => ({ name, value })), label: { color: '#174D35', fontSize: 9 }, itemStyle: { borderColor: '#fff', borderWidth: 2 } }] }
  if (type === 'heatmap') {
    const xField = config.measure2 || config.dimension
    const xNames = [...new Set(rows.map((row) => String(row[config.dimension] ?? '(blank)')))].slice(0, 18)
    const yNames = [...new Set(rows.map((row) => String(row[xField] ?? '(blank)')))].slice(0, 18)
    const valuesHeat = []
    rows.forEach((row) => {
      const x = xNames.indexOf(String(row[config.dimension] ?? '(blank)'))
      const y = yNames.indexOf(String(row[xField] ?? '(blank)'))
      if (x >= 0 && y >= 0) valuesHeat.push([x, y, Number(row[config.measure]) || 0])
    })
    return { ...base, tooltip: { position: 'top' }, grid: { top: 15, left: 70, right: 15, bottom: 45 }, xAxis: { type: 'category', data: xNames, splitArea: { show: true }, ...axis }, yAxis: { type: 'category', data: yNames, splitArea: { show: true }, ...axis }, visualMap: { min: Math.min(0, ...valuesHeat.map((item) => item[2])), max: Math.max(1, ...valuesHeat.map((item) => item[2])), calculable: true, orient: 'horizontal', left: 'center', bottom: 2, inRange: { color: ['#DDF4E6', '#80D6A5', '#269B65', '#174D35'] } }, series: [{ type: 'heatmap', data: valuesHeat, label: { show: valuesHeat.length < 60, color: '#174D35', fontSize: 8 } }] }
  }
  return { ...base, xAxis: { type: 'category', data: names, ...axis }, yAxis: { type: 'value', ...axis }, series: [{ type: 'bar', data: values }] }
}

function componentCard(component) {
  const card = document.createElement('article')
  card.className = `dashboard-card${component.id === state.selectedId ? ' selected' : ''}`
  card.dataset.componentId = component.id
  card.dataset.size = component.size || 'medium'
  card.draggable = true
  const header = document.createElement('header')
  header.className = 'dashboard-card-header'
  header.innerHTML = `<h3>${escapeHTML(component.title || labels[component.type])}</h3><button type="button" data-card-action="up" title="Move up" aria-label="Move up"><i class="bi bi-arrow-up"></i></button><button type="button" data-card-action="down" title="Move down" aria-label="Move down"><i class="bi bi-arrow-down"></i></button><button type="button" data-card-action="delete" title="Delete component" aria-label="Delete component"><i class="bi bi-trash3"></i></button>`
  const body = document.createElement('div')
  body.className = 'dashboard-card-body'
  card.append(header, body)
  if (chartTypes.has(component.type)) {
    const chart = document.createElement('div')
    chart.className = 'dashboard-chart'
    chart.id = `chart-${component.id}`
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
    const field = component.config.dimension
    const mode = component.config.filterMode || 'categorical'
    body.innerHTML = `<div class="dashboard-filter-preview"><i class="bi bi-funnel"></i> Filters dashboard by ${escapeHTML(field || 'selected field')} (${escapeHTML(mode)}).</div>`
  }
  card.addEventListener('click', (event) => {
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
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', component.id)
    card.classList.add('dragging')
  })
  card.addEventListener('dragend', () => card.classList.remove('dragging'))
  card.addEventListener('dragover', (event) => event.preventDefault())
  card.addEventListener('drop', (event) => {
    event.preventDefault()
    reorderComponent(event.dataTransfer.getData('text/plain'), component.id)
  })
  return card
}

function moveOrDelete(id, action) {
  const index = state.dashboard.components.findIndex((item) => item.id === id)
  if (index < 0) return
  pushUndo()
  if (action === 'delete') {
    state.dashboard.components.splice(index, 1)
    if (state.selectedId === id) state.selectedId = null
  } else {
    const target = action === 'up' ? Math.max(0, index - 1) : Math.min(state.dashboard.components.length - 1, index + 1)
    const [item] = state.dashboard.components.splice(index, 1)
    state.dashboard.components.splice(target, 0, item)
  }
  renderComponents()
  renderConfig()
}

function reorderComponent(fromId, toId) {
  const from = state.dashboard.components.findIndex((item) => item.id === fromId)
  const to = state.dashboard.components.findIndex((item) => item.id === toId)
  if (from < 0 || to < 0 || from === to) return
  pushUndo()
  const [item] = state.dashboard.components.splice(from, 1)
  state.dashboard.components.splice(to, 0, item)
  renderComponents()
}

function renderFilters() {
  const bar = document.getElementById('dashboard-filter-bar')
  bar.replaceChildren()
  state.dashboard.components.filter((component) => component.type === 'filter').forEach((component) => {
    const field = component.config.dimension
    const mode = component.config.filterMode || 'categorical'
    const current = state.filters[component.id] || {}
    const label = document.createElement('label')
    label.className = 'dashboard-filter'
    label.textContent = component.title || field || 'Filter'
    let controls
    if (mode === 'categorical') {
      const values = [...new Set(state.rows.map((row) => String(row[field] ?? '')).filter(Boolean))]
      controls = document.createElement('select')
      controls.innerHTML = `<option value="">All values</option>${values.slice(0, 100).map((value) => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('')}`
      controls.value = current.value || ''
      controls.addEventListener('change', () => { state.filters[component.id] = { ...current, mode, value: controls.value }; renderComponents(false) })
    } else {
      controls = document.createElement('span')
      controls.style.display = 'flex'
      controls.style.gap = '5px'
      const first = document.createElement('input')
      const second = document.createElement('input')
      if (mode === 'date') {
        first.type = 'date'; second.type = 'date'
        first.value = current.from || ''; second.value = current.to || ''
        first.setAttribute('aria-label', `${field} from date`); second.setAttribute('aria-label', `${field} to date`)
        first.addEventListener('change', () => { state.filters[component.id] = { ...current, mode, from: first.value, to: second.value }; renderComponents(false) })
        second.addEventListener('change', () => { state.filters[component.id] = { ...current, mode, from: first.value, to: second.value }; renderComponents(false) })
      } else {
        first.type = 'number'; second.type = 'number'; first.placeholder = 'Min'; second.placeholder = 'Max'
        first.value = current.min || ''; second.value = current.max || ''
        first.setAttribute('aria-label', `${field} minimum`); second.setAttribute('aria-label', `${field} maximum`)
        first.addEventListener('change', () => { state.filters[component.id] = { ...current, mode, min: first.value, max: second.value }; renderComponents(false) })
        second.addEventListener('change', () => { state.filters[component.id] = { ...current, mode, min: first.value, max: second.value }; renderComponents(false) })
      }
      controls.append(first, second)
    }
    label.append(controls)
    bar.append(label)
  })
}

function renderComponents(recreateCharts = true) {
  if (state.rendering) return
  state.rendering = true
  state.charts.forEach((chart) => chart.dispose())
  state.charts.clear()
  const canvas = document.getElementById('dashboard-components')
  canvas.replaceChildren()
  applyTheme()
  renderFilters()
  if (!state.dashboard.components.length) {
    const empty = document.createElement('div')
    empty.className = 'dashboard-empty'
    empty.innerHTML = '<i class="bi bi-bar-chart-line"></i><strong>Start designing your dashboard</strong><p>Choose a dataset, then add a chart, KPI, table, or text block from the library.</p>'
    canvas.append(empty)
  } else {
    state.dashboard.components.forEach((component) => {
      const card = componentCard(component)
      canvas.append(card)
      if (chartTypes.has(component.type) && state.rows.length && state.columns.length) {
        const chartNode = card.querySelector('.dashboard-chart')
        if (!globalThis.echarts?.init) {
          chartNode.textContent = 'Charts could not load. Restart the application and try again.'
          chartNode.classList.add('dashboard-empty')
          return
        }
        try {
          const chart = globalThis.echarts.init(chartNode, null, { renderer: 'canvas' })
          chart.setOption(chartOption(component), true)
          state.charts.set(component.id, chart)
        } catch (error) {
          chartNode.textContent = `Could not render this visualization: ${error.message}`
          chartNode.classList.add('dashboard-empty')
          showToast(`Could not render ${component.title || 'visualization'}.`, 'error')
        }
      } else if (chartTypes.has(component.type)) {
        const chartNode = card.querySelector('.dashboard-chart')
        chartNode.innerHTML = '<div class="dashboard-empty"><p>Select a dataset to render real data.</p></div>'
      }
    })
  }
  state.rendering = false
  if (recreateCharts) renderFilters()
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
  const select = document.getElementById('designer-saved')
  select.replaceChildren(new Option('Saved dashboards', ''))
  state.saved.forEach((dashboard) => select.add(new Option(dashboard.name || 'Untitled dashboard', dashboard.id || dashboard.dashboard_id)))
}

async function saveDashboard() {
  state.dashboard.name = document.getElementById('designer-name').value.trim() || 'Untitled dashboard'
  if (!state.dashboard.dataset_id) {
    showToast('Select a dataset before saving this dashboard.', 'error')
    return
  }
  const isUpdate = Boolean(state.dashboard.id)
  const result = await api(isUpdate ? `/api/dashboards/${encodeURIComponent(state.dashboard.id)}` : '/api/dashboards', {
    method: isUpdate ? 'PUT' : 'POST',
    body: JSON.stringify(state.dashboard),
  })
  const saved = safeDashboard(result)
  if (!saved.id && (result?.id || result?.dashboard_id)) saved.id = result.id || result.dashboard_id
  state.dashboard = saved
  document.getElementById('designer-name').value = saved.name
  document.getElementById('dashboard-report-title').textContent = saved.name
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
  if (!window.confirm(`Delete "${state.dashboard.name}"? This cannot be undone.`)) return
  await api(`/api/dashboards/${encodeURIComponent(state.dashboard.id)}`, { method: 'DELETE' })
  installDashboard(blankDashboard())
  document.getElementById('designer-dataset').value = ''
  await loadDatasets('')
  await loadSavedDashboards()
  showToast('Dashboard deleted.')
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

async function downloadPNG() {
  const canvas = document.getElementById('dashboard-canvas')
  if (!globalThis.htmlToImage?.toPng) throw new Error('PNG export is unavailable. Restart the application to load its export library.')
  if (!state.dashboard.dataset_id || !state.rows.length) {
    showToast('Choose a dataset with preview rows before exporting.', 'error')
    return
  }
  state.charts.forEach((chart) => chart.resize())
  canvas.classList.add('exporting')
  try {
    const dataUrl = await globalThis.htmlToImage.toPng(canvas, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#FFFFFF',
      width: canvas.scrollWidth,
      height: canvas.scrollHeight,
      style: { transform: 'none', margin: '0' },
    })
    const link = document.createElement('a')
    link.download = `${(state.dashboard.name || 'dashboard').replace(/[^\w.-]+/g, '-')}.png`
    link.href = dataUrl
    link.click()
    showToast('PNG dashboard downloaded.')
  } finally {
    canvas.classList.remove('exporting')
  }
}

function togglePreview() {
  const layout = document.querySelector('.designer-layout')
  const button = document.getElementById('designer-preview-toggle')
  const preview = !layout.classList.contains('preview-mode')
  layout.classList.toggle('preview-mode', preview)
  document.body.classList.toggle('dashboard-presentation', preview)
  button.innerHTML = preview ? '<i class="bi bi-pencil"></i> Edit Dashboard' : '<i class="bi bi-easel"></i> Preview Dashboard'
  if (preview) document.getElementById('dashboard-report-date').textContent = new Date().toLocaleDateString()
  requestAnimationFrame(() => state.charts.forEach((chart) => chart.resize()))
}

async function historyAction(direction) {
  const from = direction === 'undo' ? state.undo : state.redo
  const to = direction === 'undo' ? state.redo : state.undo
  if (!from.length) return
  const previousDatasetId = state.dashboard.dataset_id
  to.push(JSON.stringify(state.dashboard))
  const value = from.pop()
  installDashboard(JSON.parse(value))
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
  document.getElementById('designer-dataset').addEventListener('change', async (event) => {
    try { await selectDataset(event.target.value) } catch (error) { showToast(error.message || 'Could not load this dataset.', 'error') }
  })
  document.getElementById('designer-name').addEventListener('input', (event) => {
    state.dashboard.name = event.target.value
    document.getElementById('dashboard-report-title').textContent = event.target.value
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
  window.addEventListener('app:pagechange', async (event) => {
    if (event.detail.page !== 'dashboard-designer') return
    try {
      await Promise.all([loadDatasets(), loadSavedDashboards()])
      if (state.dashboard.dataset_id) await refreshData()
    } catch (error) { showToast(error.message || 'Dashboard Designer could not load its data.', 'error') }
  })
  window.addEventListener('resize', () => state.charts.forEach((chart) => chart.resize()))
  loadDatasets().catch((error) => showToast(error.message || 'Could not load datasets.', 'error'))
  loadSavedDashboards().catch((error) => showToast(error.message || 'Could not load saved dashboards.', 'error'))
  setInterval(() => {
    if (document.getElementById('page-dashboard-designer').hidden || !state.dashboard.dataset_id) return
    refreshData().catch((error) => showToast(error.message || 'Dashboard data refresh failed.', 'error'))
  }, 60_000)
}
