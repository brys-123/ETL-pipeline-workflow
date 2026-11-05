import { api, escapeHTML, showToast } from './app.js'

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
const palette = ['#174D35', '#206B48', '#26885B', '#34A36B', '#4EBA7E', '#76C996', '#A5DDB8']
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
      showLegend: true,
      legendPosition: 'bottom',
      legendOrientation: 'horizontal',
      legendTextSize: 9,
      legendAlign: 'center',
      legendItemSpacing: 10,
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
    components: Array.isArray(dashboard.components) ? dashboard.components.map((component) => {
      const defaults = makeComponent(component.type || 'bar')
      return {
        ...defaults,
        ...component,
        config: { ...defaults.config, ...(component.config || {}) },
      }
    }) : [],
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
    input = `<input id="${id}" data-config-key="${key}" type="${options.type || 'text'}" value="${escapeHTML(value ?? '')}"${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}>`
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
      </section>
      <section class="designer-config-section"><h3>LAYOUT</h3><p class="designer-config-field">Drag dashboard cards to reorder them. Choose a size in a component's settings.</p><div class="designer-config-actions"><button type="button" data-dashboard-action="clear">Clear components</button></div></section>
    `
  } else {
    const { type, config } = component
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
          ${configField('Chart background', 'chartBackground', config.chartBackground || 'transparent', { choices: [['transparent', 'Transparent'], ['#FFFFFF', 'White'], ['#F4FBF6', 'Pale mint']] })}
          ${configField('Chart size', 'size', component.size || 'medium', { choices: [['small', 'Compact'], ['medium', 'Standard'], ['large', 'Wide']] })}
        </section>
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
            ${configField('Legend text size', 'legendTextSize', config.legendTextSize ?? 9, { type: 'number', min: 8, max: 18 })}
            ${configField('Legend alignment', 'legendAlign', config.legendAlign || 'center', { choices: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] })}
            ${configField('Legend item spacing', 'legendItemSpacing', config.legendItemSpacing ?? 10, { type: 'number', min: 0, max: 40 })}
          `}
        </section>
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
      fields += configField('Filter type', 'filterMode', config.filterMode || 'categorical', { choices: [['categorical', 'Category'], ['date', 'Date range'], ['numeric', 'Numeric range']] })
    }
    if (type === 'image') fields += `<label class="designer-config-field">Choose image<input id="config-image" type="file" accept="image/*"></label>`
    content.innerHTML = chartTypes.has(type) ? chartSections : `
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
  } else if (key === 'title' || key === 'size') component[key] = value
  else component.config[key] = value
  if (key === 'dimension' || key === 'seriesField' || key === 'filterMode' || key === 'aggregation' || key === 'measure' || key === 'measure2' || key === 'sizeMeasure' || key === 'size' || key === 'type') {
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
  const align = positionAlign === 'center' ? 'auto' : positionAlign
  return {
    show: config.showLegend !== false,
    data: [...new Set(names.filter(Boolean))],
    orient: orientation,
    align,
    itemGap: Math.max(0, Math.min(40, Number(config.legendItemSpacing) || 0)),
    textStyle: {
      color: '#486B55',
      fontSize: Math.max(8, Math.min(18, Number(config.legendTextSize) || 9)),
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
  return {
    show: true,
    trigger: pie || ['scatter', 'bubble'].includes(component.type) ? 'item' : 'axis',
    backgroundColor: '#FFFFFF',
    borderColor: '#CFE5D6',
    borderWidth: 1,
    padding: [9, 12],
    textStyle: { color: '#174D35', fontSize: 11 },
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
  const axis = {
    axisLine: { lineStyle: { color: '#B4D9C1' } },
    axisLabel: { color: '#486B55', fontSize: 10, hideOverlap: true, margin: 10 },
    nameTextStyle: { color: '#174D35', fontSize: 10, fontWeight: 600 },
    splitLine: { show: component.config.showGridLines !== false, lineStyle: { color: '#EAF6EE', type: 'dashed' } },
  }
  const legend = legendOption(component)
  const legendVisible = component.config.showLegend !== false
  const legendPosition = component.config.legendPosition || 'bottom'
  const base = {
    animationDuration: 450,
    color: palette,
    backgroundColor: config.chartBackground || 'transparent',
    textStyle: { color: '#174D35', fontFamily: 'Inter, sans-serif', fontSize: 11 },
    tooltip: chartTooltip(component),
    ...(type === 'heatmap' ? {} : { legend }),
    grid: {
      top: legendVisible && legendPosition === 'top' ? 48 : 24,
      left: legendVisible && legendPosition === 'left' ? 112 : 48,
      right: legendVisible && legendPosition === 'right' ? 112 : 22,
      bottom: legendVisible && legendPosition === 'bottom' ? 62 : 38,
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
          color: '#174D35',
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
      smooth: type === 'line' || type === 'area',
      barMaxWidth: 42,
      barCategoryGap: '35%',
      itemStyle: { borderRadius: type.includes('Bar') || type === 'bar' ? 4 : 0 },
      lineStyle: { width: 2.5 },
      symbol: 'circle',
      symbolSize: type === 'line' || type === 'area' ? 6 : undefined,
      areaStyle: type === 'area' ? { opacity: .2 } : undefined,
      label: {
        show: config.showDataLabels === true,
        color: '#174D35',
        position: horizontal ? 'right' : 'top',
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
    return {
      ...base,
      legend: visibleLegend(names),
      tooltip: chartTooltip(component, true),
      series: [{
        name: aggregationTitle(config),
        type: 'pie',
        radius: type === 'donut' ? ['40%', '67%'] : '64%',
        center: legendVisible && ['left', 'right'].includes(legendPosition) ? ['50%', '50%'] : ['50%', legendVisible ? '44%' : '50%'],
        data: groups.map(([name, value, percentage]) => ({ name, value, percentage })),
        label: {
          show: config.showDataLabels !== false,
          color: '#174D35',
          fontSize: 10,
          minShowLabelAngle: 4,
          labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
          formatter: (params) => {
            const share = Number(params.data?.percentage ?? params.percent) || 0
            if (config.showPercentage || config.aggregation === 'percentage') return `${params.name}: ${numberText(share, config.decimalPrecision)}%`
            return `${params.name}: ${numberText(params.value, config.decimalPrecision, config.numberFormat)}`
          },
        },
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
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
  if (type === 'radar') return { ...base, legend: visibleLegend([component.title]), radar: { indicator: groups.map(([name]) => ({ name, max: Math.max(1, ...values.map(Math.abs)) })), axisName: { color: '#206B48', fontSize: 9 }, splitArea: { areaStyle: { color: ['#FFFFFF', '#F4FBF6'] } } }, series: [{ name: component.title, type: 'radar', data: [{ value: values, name: component.title }], label: { show: config.showDataLabels === true, formatter: (params) => numberText(params.value, config.decimalPrecision) }, areaStyle: { opacity: .18 } }] }
  if (type === 'treemap' || type === 'funnel') return { ...base, legend: visibleLegend(names), tooltip: chartTooltip(component, true), series: [{ name: aggregationTitle(config), type, data: groups.map(([name, value]) => ({ name, value })), label: { show: config.showDataLabels !== false, color: '#174D35', fontSize: 10, formatter: (params) => numberText(params.value, config.decimalPrecision, config.numberFormat) }, itemStyle: { borderColor: '#fff', borderWidth: 2 } }] }
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
        backgroundColor: '#FFFFFF',
        borderColor: '#CFE5D6',
        textStyle: { color: '#174D35', fontSize: 11 },
        formatter: (params) => {
          const [x, y, value] = params.value
          return `${escapeHTML(config.dimension)}: ${escapeHTML(xNames[x])}<br>${escapeHTML(xField)}: ${escapeHTML(yNames[y])}<br>${escapeHTML(aggregationTitle(config))}: ${numberText(value, config.decimalPrecision, config.numberFormat)}`
        },
      },
      grid: { top: 42, left: 80, right: 20, bottom: 52 },
      xAxis: { type: 'category', name: config.dimension, nameLocation: 'middle', nameGap: 28, data: xNames, splitArea: { show: true }, ...axis },
      yAxis: { type: 'category', name: xField, nameLocation: 'middle', nameGap: 48, data: yNames, splitArea: { show: true }, ...axis },
      visualMap: { min: Math.min(0, ...valuesHeat.map((item) => item[2])), max: Math.max(1, ...valuesHeat.map((item) => item[2])), calculable: true, orient: 'horizontal', left: 'center', bottom: 2, inRange: { color: ['#DDF4E6', '#80D6A5', '#269B65', '#174D35'] } },
      series: [{ name: aggregationTitle(config), type: 'heatmap', data: valuesHeat, label: { show: config.showDataLabels === true && valuesHeat.length < 60, color: '#174D35', fontSize: 9 } }],
    }
  }
  return { ...base, xAxis: { type: 'category', data: names, ...axis }, yAxis: { type: 'value', ...axis }, series: [{ name: config.measure || 'Value', type: 'bar', data: categoryData, label: { show: config.showDataLabels === true, formatter: labelFormatter } }] }
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
      skipFonts: true,
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
  document.getElementById('designer-dataset-source').addEventListener('change', async () => {
    const currentId = state.dashboard.dataset_id || ''
    const keepSelection = currentId && state.datasets.some((item) => (item.file_id || item.dataset_id || item.id) === currentId)
    await loadDatasets(keepSelection ? currentId : '').catch((error) => showToast(error.message || 'Could not refresh the dataset list.', 'error'))
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
