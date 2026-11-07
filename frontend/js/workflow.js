import { api, escapeHTML, showToast, switchPage } from './app.js'

const definitions = {
  csv_input: { title: 'CSV Input', group: 'Input', description: 'Choose a CSV dataset to associate with this workflow.', icon: 'bi-filetype-csv', color: 'input' },
  excel_input: { title: 'Excel Input', group: 'Input', description: 'Choose an XLSX workbook for this workflow.', icon: 'bi-file-earmark-spreadsheet', color: 'input' },
  json_input: { title: 'JSON Input', group: 'Input', description: 'Choose a JSON dataset to associate with this workflow.', icon: 'bi-braces', color: 'input' },
  clean_data: { title: 'Clean Data', group: 'Transformation', description: 'Apply a selected cleaning operation to the incoming dataset.', icon: 'bi-magic', color: 'transform' },
  remove_duplicates: { title: 'Remove Duplicates', group: 'Transformation', description: 'Choose which imported columns to compare for duplicate handling.', icon: 'bi-copy', color: 'transform' },
  filter_rows: { title: 'Filter Rows', group: 'Transformation', description: 'Keep rows that match a configured condition.', icon: 'bi-funnel', color: 'transform' },
  select_columns: { title: 'Select Columns', group: 'Transformation', description: 'Choose the imported columns to retain.', icon: 'bi-view-list', color: 'transform' },
  rename_columns: { title: 'Rename Columns', group: 'Transformation', description: 'Rename a field in the incoming dataset.', icon: 'bi-input-cursor-text', color: 'transform' },
  aggregate_data: { title: 'Aggregate Data', group: 'Transformation', description: 'Summarize selected values by one or more groups.', icon: 'bi-bar-chart-steps', color: 'transform' },
  statistical_summary: { title: 'Statistical Summary', group: 'Transformation', description: 'Calculate numerical and categorical statistics for the incoming dataset.', icon: 'bi-clipboard-data', color: 'transform' },
  merge_data: { title: 'Merge Data', group: 'Transformation', description: 'Join two connected datasets using matching key columns.', icon: 'bi-intersect', color: 'transform' },
  preview_data: { title: 'Preview Data', group: 'Preview', description: 'Inspect the data flowing through this pipeline step.', icon: 'bi-eye', color: 'preview' },
  view_data: { title: 'Preview Data', group: 'Preview', description: 'Inspect data flowing through this legacy preview node.', icon: 'bi-eye', color: 'preview' },
  csv_output: { title: 'CSV Output', group: 'Output', description: 'Export the incoming dataset as a CSV file.', icon: 'bi-filetype-csv', color: 'output' },
  excel_output: { title: 'Excel Output', group: 'Output', description: 'Export the incoming dataset as an Excel workbook.', icon: 'bi-file-earmark-spreadsheet', color: 'output' },
  json_output: { title: 'JSON Output', group: 'Output', description: 'Export the incoming dataset as a JSON file.', icon: 'bi-braces', color: 'output' },
}

let nodes = []
let edges = []
let selectedNodeId = null
let workflowId = null
let uploadedFiles = []
let zoom = 1
let pan = { x: 0, y: 0 }
let draggingNode = null
let panning = null
let pendingSourceId = null
let workflowCache = []
let configRenderVersion = 0
let runNodeStatuses = {}
let validationErrors = {}
let lastExecutionId = null
let previewPage = 1
let previewNodeId = null
let previewSearchTimer
let previewRequestId = 0
let workflowRunMessage = null
let summaryPages = { numerical: 1, categorical: 1 }
const numericStatistics = [
  ['count', 'Count'], ['missing_values', 'Missing values'], ['mean', 'Mean'], ['median', 'Median'],
  ['mode', 'Mode'], ['minimum', 'Minimum'], ['maximum', 'Maximum'], ['range', 'Range'],
  ['standard_deviation', 'Standard deviation'], ['variance', 'Variance'], ['q1', 'First quartile (Q1)'],
  ['q3', 'Third quartile (Q3)'], ['iqr', 'Interquartile range (IQR)'], ['sum', 'Sum'],
  ['skewness', 'Skewness'], ['kurtosis', 'Kurtosis'],
]
const categoricalStatistics = [
  ['count', 'Count'], ['missing_values', 'Missing values'], ['unique_values', 'Unique values'],
  ['distinct_categories', 'Distinct categories'], ['mode', 'Mode'], ['frequency', 'Frequency'],
  ['percentage', 'Percentage'],
]

const viewport = () => document.getElementById('canvas-viewport')
const stage = () => document.getElementById('canvas-stage')
const nodesLayer = () => document.getElementById('nodes-layer')
const edgeLayer = () => document.getElementById('edge-layer')
const edgeControlsLayer = () => document.getElementById('edge-controls-layer')

function nodeDefinition(type) {
  return definitions[type] || { title: 'Workflow node', group: 'Node', description: 'Configure this workflow node.', icon: 'bi-puzzle', color: 'transform' }
}

function snapCoordinate(value) {
  const coordinate = Math.max(0, Math.round(value))
  return document.documentElement.dataset.snapToGrid === 'true'
    ? Math.round(coordinate / 20) * 20
    : coordinate
}

function markUnsaved() {
  document.getElementById('canvas-status').textContent = 'Unsaved changes'
  runNodeStatuses = {}
  validationErrors = {}
  lastExecutionId = null
  workflowRunMessage = null
  nodesLayer().querySelectorAll('.workflow-node').forEach((card) => {
    card.classList.remove('execution-pending', 'execution-running', 'execution-success', 'execution-failed', 'execution-skipped', 'validation-error')
    card.querySelector('.node-execution-status')?.remove()
  })
}

function applyTransform() {
  stage().style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  document.getElementById('zoom-label').textContent = `${Math.round(zoom * 100)}%`
}

function updateWorkflowFocusName() {
  document.getElementById('workflow-focus-name').value = document.getElementById('workflow-name').value
}

async function setWorkflowFocus(enabled) {
  document.body.classList.toggle('workflow-focus-mode', enabled)
  if (enabled) {
    updateWorkflowFocusName()
    requestAnimationFrame(() => {
      fitCanvas()
      drawEdges()
      renderMinimap()
    })
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen()
      } catch {
        showToast('Large Screen Mode is active without browser fullscreen.', 'error')
      }
    }
    return
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    try {
      await document.exitFullscreen()
    } catch {
      showToast('Could not exit browser fullscreen. Large Screen Mode was closed.', 'error')
    }
  }
  requestAnimationFrame(() => {
    drawEdges()
    renderMinimap()
  })
}

function addNode(type, x, y) {
  const definition = nodeDefinition(type)
  const node = {
    id: crypto.randomUUID(),
    type,
    name: definition.title,
    description: definition.description,
    position: { x: Math.max(12, snapCoordinate(x)), y: Math.max(12, snapCoordinate(y)) },
    config: type === 'statistical_summary'
      ? {
          column_selection: 'automatic',
          numeric_statistics: numericStatistics.map(([value]) => value),
          categorical_statistics: categoricalStatistics.map(([value]) => value),
          precision: '3',
          top_categories: '10',
        }
      : {},
  }
  nodes.push(node)
  selectedNodeId = node.id
  markUnsaved()
  renderNodes()
  renderConfig()
}

function canOutput(node) {
  return !node.type.endsWith('_output')
}

function canInput(node) {
  return !node.type.endsWith('_input')
}

function renderNodes() {
  nodesLayer().innerHTML = nodes.map((node) => {
    const definition = nodeDefinition(node.type)
    const status = runNodeStatuses[node.id]?.status
    const selected = node.id === selectedNodeId ? ' selected' : ''
    const validationError = validationErrors[node.id] ? ' validation-error' : ''
    const statusClass = status ? ` execution-${escapeHTML(status)}` : ''
    const statusBadge = status ? `<span class="node-execution-status">${escapeHTML(status)}</span>` : ''
    return `<article class="workflow-node${selected}${validationError}${statusClass}" data-node-type="${escapeHTML(node.type)}" data-node-id="${escapeHTML(node.id)}" style="left:${Number(node.position.x)}px;top:${Number(node.position.y)}px" aria-label="${escapeHTML(node.name)} node${status ? `, ${escapeHTML(status)}` : ''}" title="${escapeHTML(node.description || definition.description)}"><span class="node-type-icon ${definition.color}"><i class="bi ${definition.icon}"></i></span><span class="node-card-copy"><span class="node-card-category">${escapeHTML(definition.group)}</span><strong>${escapeHTML(node.name)}</strong><small>${escapeHTML(definition.description)}</small></span>${statusBadge}<button class="node-delete" data-delete-node="${escapeHTML(node.id)}" title="Remove node" aria-label="Remove ${escapeHTML(node.name)}"><i class="bi bi-x-lg"></i></button>${canInput(node) ? `<button class="node-port input" data-port="input" data-node-id="${escapeHTML(node.id)}" title="Connection input" aria-label="Input connection for ${escapeHTML(node.name)}"></button>` : ''}${canOutput(node) ? `<button class="node-port output" data-port="output" data-node-id="${escapeHTML(node.id)}" title="Drag to connect" aria-label="Output connection for ${escapeHTML(node.name)}"></button>` : ''}</article>`
  }).join('')
  document.getElementById('canvas-empty').hidden = nodes.length > 0
  drawEdges()
  renderMinimap()
}

function portPosition(node, side) {
  return { x: node.position.x + (side === 'output' ? 196 : 0), y: node.position.y + 44 }
}

function drawEdges(previewPoint = null) {
  const paths = edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target) return ''
    const start = portPosition(source, 'output')
    const end = portPosition(target, 'input')
    const bend = Math.max(40, Math.abs(end.x - start.x) * .45)
    const active = ['running', 'success'].includes(runNodeStatuses[edge.source]?.status) && ['running', 'success'].includes(runNodeStatuses[edge.target]?.status)
    const edgeState = Object.keys(runNodeStatuses).length ? (active ? ' active' : ' inactive') : ''
    return `<g class="edge-group${edgeState}"><path class="edge-path" marker-end="url(#edge-arrow)" d="M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}"></path></g>`
  }).join('')
  const controls = edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target) return ''
    const start = portPosition(source, 'output')
    const end = portPosition(target, 'input')
    const middleX = (start.x + end.x) / 2
    const middleY = (start.y + end.y) / 2
    return `<button class="edge-delete-control" type="button" data-delete-edge="${escapeHTML(edge.id)}" style="left:${middleX}px;top:${middleY}px" title="Cancel connection" aria-label="Cancel connection"><span aria-hidden="true">×</span></button>`
  }).join('')
  let preview = ''
  if (pendingSourceId && previewPoint) {
    const source = nodes.find((node) => node.id === pendingSourceId)
    if (source) {
      const start = portPosition(source, 'output')
      const bend = Math.max(40, Math.abs(previewPoint.x - start.x) * .4)
      preview = `<path class="connection-preview" d="M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${previewPoint.x - bend} ${previewPoint.y}, ${previewPoint.x} ${previewPoint.y}"></path>`
    }
  }
  edgeLayer().innerHTML = `<defs><marker id="edge-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M 0 1 L 8 5 L 0 9 z" fill="#269B65"></path></marker></defs>${paths}${preview}`
  edgeControlsLayer().innerHTML = controls
}

function renderMinimap() {
  const minimap = document.getElementById('minimap-content')
  minimap.innerHTML = nodes.map((node) => `<span class="minimap-node" style="left:${12 + node.position.x / 2200 * 78}px;top:${16 + node.position.y / 1600 * 47}px"></span>`).join('')
}

function formField(label, key, value = '', options = {}) {
  if (options.choices) {
    const selectedValues = options.multiple
      ? (Array.isArray(value) ? value.map(String) : String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean))
      : [String(value ?? '')]
    const choices = options.choices.map((choice) => `<option value="${escapeHTML(choice.value)}" ${selectedValues.includes(String(choice.value)) ? 'selected' : ''} ${choice.disabled ? 'disabled' : ''}>${escapeHTML(choice.label)}</option>`).join('')
    const multiple = options.multiple ? ' multiple' : ''
    const disabled = options.disabled ? ' disabled' : ''
    const datasetColumn = options.datasetColumn ? ' data-dataset-column="true"' : ''
    const columnKind = options.columnKind ? ` data-column-kind="${options.columnKind}"` : ''
    const sourceIndex = Number.isInteger(options.sourceIndex) ? ` data-source-index="${options.sourceIndex}"` : ''
    const emptyChoice = options.emptyChoice ? ' data-empty-choice="true"' : ''
    const initialValues = options.datasetColumn ? ` data-initial-values="${escapeHTML(JSON.stringify(selectedValues.filter(Boolean)))}"` : ''
    return `<div class="config-field"><label for="config-${escapeHTML(key)}">${escapeHTML(label)}</label><select id="config-${escapeHTML(key)}" name="${escapeHTML(key)}"${multiple}${disabled}${datasetColumn}${columnKind}${sourceIndex}${emptyChoice}${initialValues}>${choices}</select></div>`
  }
  const input = options.multiline
    ? `<textarea id="config-${escapeHTML(key)}" name="${escapeHTML(key)}" placeholder="${escapeHTML(options.placeholder || '')}">${escapeHTML(value)}</textarea>`
    : `<input id="config-${escapeHTML(key)}" name="${escapeHTML(key)}" value="${escapeHTML(value)}" placeholder="${escapeHTML(options.placeholder || '')}" ${options.type ? `type="${options.type}"` : ''} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} />`
  return `<div class="config-field"><label for="config-${escapeHTML(key)}">${escapeHTML(label)}</label>${input}</div>`
}

function fileChoices(extensions) {
  const eligible = uploadedFiles.filter((file) => extensions.includes(file.file_type))
  return [{ value: '', label: eligible.length ? 'Choose a dataset' : 'Upload a compatible dataset first' }, ...eligible.map((file) => ({ value: file.file_id, label: file.filename }))]
}

const datasetColumns = new Map()

function sourceFilesForNode(node, sourceIndex = null) {
  const fileIds = new Set()
  const visited = new Set()
  function visit(nodeId) {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    const current = nodes.find((item) => item.id === nodeId)
    if (!current) return
    if (current.type.endsWith('_input') && current.config.file_id) {
      fileIds.add(current.config.file_id)
      return
    }
    edges.filter((edge) => edge.target === nodeId).forEach((edge) => visit(edge.source))
  }
  if (sourceIndex === null) {
    visit(node.id)
  } else {
    const parents = edges.filter((edge) => edge.target === node.id)
    if (parents[sourceIndex]) visit(parents[sourceIndex].source)
  }
  return [...fileIds].map((fileId) => uploadedFiles.find((file) => file.file_id === fileId)).filter(Boolean)
}

function connectionDetails(node) {
  const incoming = edges.filter((edge) => edge.target === node.id)
    .map((edge) => nodes.find((item) => item.id === edge.source)?.name)
    .filter(Boolean)
  const outgoing = edges.filter((edge) => edge.source === node.id)
    .map((edge) => nodes.find((item) => item.id === edge.target)?.name)
    .filter(Boolean)
  return `<div class="node-connection-info"><strong>Connections</strong><span>From: ${escapeHTML(incoming.join(', ') || (node.type.endsWith('_input') ? 'Source dataset' : 'None'))}</span><span>To: ${escapeHTML(outgoing.join(', ') || (node.type.endsWith('_output') ? 'Workflow output' : 'None'))}</span></div>`
}

function hasConfiguredUpstream(node) {
  if (node.type.endsWith('_input')) return sourceFilesForNode(node).length > 0
  return sourceFilesForNode(node).length > 0
}

function loadDatasetColumns(file) {
  if (!datasetColumns.has(file.file_id)) {
    const request = api(`/api/files/${encodeURIComponent(file.file_id)}/schema`)
      .then((payload) => payload.schema || [])
      .catch((error) => {
        datasetColumns.delete(file.file_id)
        throw error
      })
    datasetColumns.set(file.file_id, request)
  }
  return datasetColumns.get(file.file_id)
}

async function populateColumnSelectors(node, renderVersion) {
  const selectors = document.querySelectorAll('#config-content [data-dataset-column]')
  if (!selectors.length) return
  try {
    const selectColumns = async (select) => {
      const sourceIndex = select.dataset.sourceIndex === undefined ? null : Number(select.dataset.sourceIndex)
      const sourceFiles = sourceFilesForNode(node, sourceIndex)
      const columnsByFile = await Promise.all(sourceFiles.map((file) => loadDatasetColumns(file)))
      return [...new Map(columnsByFile.flat().map((column) => [column.name, column])).values()]
    }
    const columnsBySelector = await Promise.all(Array.from(selectors, selectColumns))
    if (selectedNodeId !== node.id || renderVersion !== configRenderVersion) return
    Array.from(selectors).forEach((select, index) => {
      const selectedValues = new Set(JSON.parse(select.dataset.initialValues || '[]'))
      const schema = columnsBySelector[index]
      const sourceIndex = select.dataset.sourceIndex === undefined ? null : Number(select.dataset.sourceIndex)
      const sourceFiles = sourceFilesForNode(node, sourceIndex)
      const kind = select.dataset.columnKind
      const columns = schema
        .filter((column) => !kind || (kind === 'numeric'
          ? column.kind === 'numeric'
          : ['text', 'boolean'].includes(column.kind)))
        .map((column) => column.name)
      const choices = columns.length
        ? [...(select.dataset.emptyChoice ? [{ value: '', label: 'No specific columns' }] : []), ...columns.map((column) => ({ value: column, label: column }))]
        : [{ value: '', label: sourceFiles.length ? 'No columns found in dataset' : 'Connect an input dataset first', disabled: true }]
      const hasSelection = selectedValues.size > 0
      select.innerHTML = choices.map((choice) => `<option value="${escapeHTML(choice.value)}" ${selectedValues.has(String(choice.value)) || (choice.value === '' && !hasSelection && Boolean(select.dataset.emptyChoice)) ? 'selected' : ''} ${choice.disabled ? 'disabled' : ''}>${escapeHTML(choice.label)}</option>`).join('')
      select.disabled = !columns.length || (node.type === 'statistical_summary'
        && document.getElementById('config-column_selection')?.value !== 'manual')
    })
  } catch (error) {
    if (selectedNodeId === node.id && renderVersion === configRenderVersion) showToast(error.message || 'Could not load dataset columns.', 'error')
  }
}

function renderConfig() {
  const renderVersion = ++configRenderVersion
  const node = nodes.find((item) => item.id === selectedNodeId)
  const content = document.getElementById('config-content')
  const previewWindow = document.getElementById('node-preview-window')
  const configColumn = document.getElementById('config-column')
  previewWindow.hidden = !node
  configColumn.classList.toggle('has-preview', Boolean(node))
  if (!node) {
    previewRequestId += 1
    previewNodeId = null
    previewPage = 1
    document.getElementById('node-preview-state').innerHTML = ''
    document.getElementById('node-preview-result').innerHTML = ''
    document.getElementById('config-title').textContent = 'Configuration'
    document.getElementById('config-subtitle').textContent = 'Select a node to review its details.'
    content.innerHTML = '<div class="config-empty"><span><i class="bi bi-sliders"></i></span><p>Choose a node on the canvas to configure its saved options.</p></div>'
    return
  }
  if (previewNodeId !== node.id) {
    previewNodeId = node.id
    previewPage = 1
    summaryPages = { numerical: 1, categorical: 1 }
  }
  const definition = nodeDefinition(node.type)
  document.getElementById('config-title').textContent = node.name
  document.getElementById('config-subtitle').textContent = definition.group
  const refreshPreview = document.getElementById('node-preview-refresh')
  refreshPreview.onclick = () => {
    previewPage = 1
    if (runNodeStatuses[node.id]?.status === 'success' && lastExecutionId) {
      loadNodePreview(node, previewPage, '')
    } else if (!hasConfiguredUpstream(node)) {
      document.getElementById('node-preview-state').innerHTML = '<strong>No upstream data available.</strong><p>Connect this node to a valid input and select a dataset for the input node.</p>'
    } else {
      document.getElementById('node-preview-state').innerHTML = '<strong>Run the workflow to generate this node\'s output preview.</strong>'
    }
  }
  const previewState = runNodeStatuses[node.id]?.status
  const previewError = validationErrors[node.id] || runNodeStatuses[node.id]?.error || workflowRunMessage
  const previewReady = previewState === 'success' && lastExecutionId && hasConfiguredUpstream(node)
  const previewStateElement = document.getElementById('node-preview-state')
  const previewResultElement = document.getElementById('node-preview-result')
  previewResultElement.innerHTML = ''
  if (!hasConfiguredUpstream(node)) {
    previewStateElement.innerHTML = '<strong>No upstream data available. Connect this node to a valid input.</strong><p>Select a dataset for the input node, then run the workflow.</p>'
  } else if (previewError) {
    previewStateElement.innerHTML = `<strong>Preview unavailable.</strong><p>${escapeHTML(previewError)}</p>`
  } else if (!lastExecutionId) {
    previewStateElement.innerHTML = '<strong>Run the workflow to generate this node\'s output preview.</strong>'
  } else if (previewState === 'failed' || previewState === 'skipped') {
    previewStateElement.innerHTML = `<strong>Node ${escapeHTML(previewState)}.</strong><p>${escapeHTML(runNodeStatuses[node.id]?.error || 'An upstream node did not complete successfully.')}</p>`
  } else if (previewState === 'running' || previewState === 'pending') {
    previewStateElement.innerHTML = '<strong>Loading node output…</strong><p>Waiting for this node to finish processing its input.</p>'
  } else if (previewReady) {
    previewStateElement.innerHTML = '<strong>Loading node output…</strong><p>Fetching rows captured during this execution.</p>'
  } else {
    previewStateElement.innerHTML = '<strong>Node output is not available.</strong><p>Run the workflow again to capture this node\'s output.</p>'
  }
  if (node.type === 'preview_data' || node.type === 'view_data') {
    content.innerHTML = `<p class="config-description">${escapeHTML(definition.description)}</p><span class="config-type"><i class="bi ${definition.icon}"></i>Pipeline preview</span>${connectionDetails(node)}<button class="config-remove" type="button" id="remove-selected-node"><i class="bi bi-trash3"></i> Remove node</button>`
    if (previewReady) loadNodePreview(node, previewPage, '')
    document.getElementById('remove-selected-node').addEventListener('click', () => removeNode(node.id))
    return
  }
  let fields = ''
  if (node.type === 'csv_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['csv']) })
  if (node.type === 'excel_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['xlsx']) })
  if (node.type === 'json_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['json']) })
  if (node.type === 'clean_data') {
    fields += formField('Operation', 'operation', node.config.operation || 'trim_text', { choices: [{ value: 'trim_text', label: 'Trim spaces' }, { value: 'uppercase', label: 'Uppercase text' }, { value: 'lowercase', label: 'Lowercase text' }, { value: 'titlecase', label: 'Title case' }, { value: 'replace_text', label: 'Replace text' }, { value: 'remove_unwanted_characters', label: 'Remove unwanted characters' }, { value: 'fill_missing', label: 'Fill missing values' }, { value: 'remove_missing_rows', label: 'Remove rows with missing values' }, { value: 'remove_missing_columns', label: 'Remove columns with missing values' }, { value: 'remove_duplicates', label: 'Remove duplicates' }, { value: 'convert_type', label: 'Convert data type' }, { value: 'remove_columns', label: 'Remove columns' }, { value: 'select_columns', label: 'Select columns' }, { value: 'rename_column', label: 'Rename a column' }] })
    fields += formField('Column', 'column', node.config.column, { choices: [{ value: '', label: 'Loading imported columns...' }], datasetColumn: true })
    fields += formField('Source column', 'from', node.config.from, { choices: [{ value: '', label: 'Loading imported columns...' }], datasetColumn: true })
    fields += formField('Columns', 'columns', node.config.columns, { choices: [{ value: '', label: 'Loading imported columns...' }], multiple: true, disabled: true, datasetColumn: true })
    fields += formField('Fill method', 'method', node.config.method || 'constant', { choices: [{ value: 'constant', label: 'Constant value' }, { value: 'mean', label: 'Mean (numeric)' }, { value: 'median', label: 'Median (numeric)' }, { value: 'mode', label: 'Most common value' }] })
    fields += formField('Fill value', 'value', node.config.value, { placeholder: 'Value to fill missing cells' })
    fields += formField('Text to find', 'find', node.config.find, { placeholder: 'Text to replace' })
    fields += formField('Replace with / new name', 'to', node.config.to, { placeholder: 'Replacement text or new column name' })
    fields += formField('Replacement text', 'replace', node.config.replace, { placeholder: 'Replacement text' })
    fields += formField('Target type', 'target_type', node.config.target_type, { choices: [{ value: '', label: 'Choose type' }, { value: 'integer', label: 'Integer' }, { value: 'float', label: 'Number' }, { value: 'string', label: 'Text' }, { value: 'datetime', label: 'Date/time' }] })
  }
  if (node.type === 'remove_duplicates') fields += formField('Compare columns (optional)', 'columns', node.config.columns, { choices: [{ value: '', label: 'Loading imported columns...' }], multiple: true, disabled: true, datasetColumn: true, emptyChoice: true })
  if (node.type === 'filter_rows') {
    fields += formField('Column', 'column', node.config.column, { choices: [{ value: '', label: 'Loading imported columns...' }], disabled: true, datasetColumn: true })
    fields += formField('Operator', 'operator', node.config.operator, { choices: [{ value: '', label: 'Choose operator' }, { value: 'equals', label: 'Equals' }, { value: 'not_equals', label: 'Does not equal' }, { value: 'contains', label: 'Contains' }, { value: 'not_contains', label: 'Does not contain' }, { value: 'greater_than', label: 'Greater than' }, { value: 'less_than', label: 'Less than' }, { value: 'is_null', label: 'Is empty' }, { value: 'not_null', label: 'Is not empty' }] })
    fields += formField('Value', 'value', node.config.value, { placeholder: 'Filter value' })
  }
  if (node.type === 'select_columns') fields += formField('Columns to keep', 'columns', node.config.columns, { choices: [{ value: '', label: 'Loading imported columns...' }], multiple: true, disabled: true, datasetColumn: true })
  if (node.type === 'rename_columns') {
    fields += formField('Current column', 'from', node.config.from, { choices: [{ value: '', label: 'Loading imported columns...' }], disabled: true, datasetColumn: true })
    fields += formField('New column name', 'to', node.config.to, { placeholder: 'new_name' })
  }
  if (node.type === 'aggregate_data') {
    fields += formField('Group by', 'group_by', node.config.group_by, { choices: [{ value: '', label: 'Loading imported columns...' }], disabled: true, datasetColumn: true })
    fields += formField('Value column', 'column', node.config.column, { choices: [{ value: '', label: 'Loading imported columns...' }], disabled: true, datasetColumn: true })
    fields += formField('Operation', 'operation', node.config.operation, { choices: [{ value: '', label: 'Choose operation' }, { value: 'sum', label: 'Sum' }, { value: 'average', label: 'Average' }, { value: 'count', label: 'Count' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }] })
  }
  if (node.type === 'statistical_summary') {
    const choiceList = (items) => items.map(([value, label]) => ({ value, label }))
    fields += '<p class="config-description">Automatic mode detects numeric and categorical columns from the data at this workflow step. Manual selections are checked against the actual input when the workflow runs.</p>'
    fields += formField('Column selection', 'column_selection', node.config.column_selection || 'automatic', {
      choices: [{ value: 'automatic', label: 'Automatic (all supported columns)' }, { value: 'manual', label: 'Manual' }],
    })
    fields += formField('Numerical columns', 'numeric_columns', node.config.numeric_columns || [], {
      choices: [{ value: '', label: 'Loading numeric columns…' }], multiple: true, datasetColumn: true, columnKind: 'numeric',
    })
    fields += formField('Categorical columns', 'categorical_columns', node.config.categorical_columns || [], {
      choices: [{ value: '', label: 'Loading categorical columns…' }], multiple: true, datasetColumn: true, columnKind: 'categorical',
    })
    fields += formField('Numerical statistics', 'numeric_statistics', node.config.numeric_statistics || numericStatistics.map(([value]) => value), {
      choices: choiceList(numericStatistics), multiple: true,
    })
    fields += formField('Categorical statistics', 'categorical_statistics', node.config.categorical_statistics || categoricalStatistics.map(([value]) => value), {
      choices: choiceList(categoricalStatistics), multiple: true,
    })
    fields += formField('Decimal precision', 'precision', node.config.precision ?? 3, { type: 'number', min: 0, max: 10 })
    fields += formField('Top categories per column', 'top_categories', node.config.top_categories ?? 10, { type: 'number', min: 1, max: 100 })
  }
  if (node.type === 'merge_data') {
    fields += formField('Left dataset key', 'left_on', node.config.left_on, { choices: [{ value: '', label: 'Connect the first input' }], disabled: true, datasetColumn: true, sourceIndex: 0 })
    fields += formField('Right dataset key', 'right_on', node.config.right_on, { choices: [{ value: '', label: 'Connect the second input' }], disabled: true, datasetColumn: true, sourceIndex: 1 })
    fields += formField('Join type', 'how', node.config.how || 'inner', { choices: [{ value: 'inner', label: 'Inner' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'outer', label: 'Outer' }] })
  }
  if (node.type.endsWith('_output')) fields += formField('Output filename', 'filename', node.config.filename || 'processed-dataset', { placeholder: 'processed-dataset' })
  if (!fields) fields = '<p class="config-description">This node has no additional configuration fields.</p>'
  const phaseNote = node.type === 'merge_data'
    ? 'Connect two input branches to this node, then choose a matching key from each dataset.'
    : 'Settings are applied when the workflow runs. Output files are stored separately from source datasets.'
  content.innerHTML = `<p class="config-description">${escapeHTML(definition.description)}</p><span class="config-type"><i class="bi ${definition.icon}"></i>${escapeHTML(definition.group)} node</span>${connectionDetails(node)}<form id="node-config-form">${fields}<div class="config-warning"><i class="bi bi-info-circle"></i><span>${escapeHTML(phaseNote)}</span></div><div class="config-actions"><button class="button-secondary" type="button" id="cancel-node-config">Cancel</button><button class="button-primary" type="submit">Save settings</button></div></form><button class="config-remove" type="button" id="remove-selected-node"><i class="bi bi-trash3"></i> Remove node</button>`
  populateColumnSelectors(node, renderVersion)
  document.getElementById('config-column_selection')?.addEventListener('change', (event) => {
    document.querySelectorAll('#config-content [data-column-kind]').forEach((select) => {
    const hasColumns = Array.from(select.options).some((option) => option.value)
    select.disabled = event.target.value !== 'manual' || !hasColumns
  })
  })
  document.getElementById('node-config-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    event.currentTarget.querySelectorAll('select[multiple]').forEach((select) => {
    values[select.name] = Array.from(select.selectedOptions, (option) => option.value).filter(Boolean)
    })
    node.config = values
    markUnsaved()
    showToast('Node settings saved to this workflow design.')
    renderNodes()
    renderConfig()
  })
  document.getElementById('cancel-node-config').addEventListener('click', renderConfig)
  document.getElementById('remove-selected-node').addEventListener('click', () => removeNode(node.id))
  if (previewReady) loadNodePreview(node, previewPage, '')
}

async function loadNodePreview(node, page, query) {
  const state = document.getElementById('node-preview-state')
  const target = document.getElementById('node-preview-result')
  if (!state || !target || !lastExecutionId) return
  const requestId = ++previewRequestId
  const executionId = lastExecutionId
  state.innerHTML = '<strong>Loading preview data…</strong><p>Fetching rows captured at this workflow step.</p>'
  try {
    const params = new URLSearchParams({ execution_id: executionId, page: String(page), page_size: '50' })
    if (query) params.set('q', query)
    if (node.type === 'statistical_summary') {
      const summaries = await Promise.all(['numerical', 'categorical'].map(async (summaryType) => {
        const summaryParams = new URLSearchParams({
          execution_id: executionId,
          page: String(summaryPages[summaryType]),
          page_size: '50',
          summary_type: summaryType,
        })
        if (query) summaryParams.set('q', query)
        return [summaryType, await api(`/api/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(node.id)}/preview?${summaryParams}`)]
      }))
      if (requestId !== previewRequestId || selectedNodeId !== node.id || lastExecutionId !== executionId) return
      const summaryRowCount = summaries.reduce((total, [, summary]) => total + Number(summary.total_rows), 0)
      state.innerHTML = `<strong>${escapeHTML(node.name)}</strong><p>Execution ${escapeHTML(executionId)} · ${summaryRowCount.toLocaleString()} summary rows · Numerical and categorical results</p>`
      target.innerHTML = `<label class="table-search node-preview-search"><i class="bi bi-search"></i><input id="node-preview-search" type="search" value="${escapeHTML(query)}" placeholder="Search summary results" aria-label="Search summary results" /></label>${summaries.map(([summaryType, summary]) => renderSummaryPreviewGroup(summaryType, summary)).join('')}`
      document.getElementById('node-preview-search').addEventListener('input', () => {
        window.clearTimeout(previewSearchTimer)
        previewSearchTimer = window.setTimeout(() => {
          summaryPages = { numerical: 1, categorical: 1 }
          loadNodePreview(node, 1, document.getElementById('node-preview-search')?.value.trim() || '')
        }, 180)
      })
      target.querySelectorAll('[data-summary-page]').forEach((button) => {
        button.addEventListener('click', () => {
          const summaryType = button.dataset.summaryType
          summaryPages[summaryType] += Number(button.dataset.summaryPage)
          loadNodePreview(node, 1, query)
        })
      })
      return
    }
    const data = await api(`/api/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(node.id)}/preview?${params}`)
    if (requestId !== previewRequestId || selectedNodeId !== node.id || lastExecutionId !== executionId) return
    if (data?.status === 'failed' || data?.status === 'skipped') {
      throw new Error(data.error || `This node ${data.status}.`)
    }
    if (data?.no_output || !data?.preview || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      throw new Error('The preview response did not contain table data.')
    }
    const schemaColumns = Array.isArray(data.preview.columns) ? data.preview.columns : []
    const columns = data.columns.map((name) => {
      const schema = schemaColumns.find((column) => column.name === name)
      return `<th><span>${escapeHTML(name)}</span><small>${escapeHTML(schema?.dtype || 'unknown')} · ${Number(schema?.missing || 0)} empty</small></th>`
    }).join('')
    const rows = data.rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHTML(value ?? '')}</td>`).join('')}</tr>`).join('')
    state.innerHTML = `<strong>${escapeHTML(data.node?.name || node.name)}</strong><p>Execution ${escapeHTML(executionId)} · ${Number(data.total_rows).toLocaleString()} rows · ${Number(data.total_columns).toLocaleString()} columns · ${Number(data.preview.missing_cells).toLocaleString()} empty cells · Success</p>`
    target.innerHTML = `<label class="table-search node-preview-search"><i class="bi bi-search"></i><input id="node-preview-search" type="search" value="${escapeHTML(query)}" placeholder="Search preview rows" aria-label="Search preview data" /></label><div class="node-preview-table-wrap"><table class="studio-table"><thead><tr>${columns}</tr></thead><tbody>${rows || `<tr><td class="table-empty" colspan="${data.columns.length || 1}">No rows on this page.</td></tr>`}</tbody></table></div><div class="node-preview-pagination"><span>Page ${data.page} of ${data.total_pages} · ${Number(data.total_rows).toLocaleString()} matching rows</span><button class="button-secondary button-sm" id="node-preview-previous" type="button" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="button-secondary button-sm" id="node-preview-next" type="button" ${!data.has_more ? 'disabled' : ''}>Next</button></div>`
    document.getElementById('node-preview-search').addEventListener('input', () => {
      window.clearTimeout(previewSearchTimer)
      previewSearchTimer = window.setTimeout(() => {
        previewPage = 1
        loadNodePreview(node, previewPage, document.getElementById('node-preview-search')?.value.trim() || '')
      }, 180)
    })
    document.getElementById('node-preview-previous').addEventListener('click', () => {
      previewPage = page - 1
      loadNodePreview(node, previewPage, query)
    })
    document.getElementById('node-preview-next').addEventListener('click', () => {
      previewPage = page + 1
      loadNodePreview(node, previewPage, query)
    })
  } catch (error) {
    if (requestId === previewRequestId && selectedNodeId === node.id && lastExecutionId === executionId) {
      state.innerHTML = `<strong>Preview unavailable.</strong><p>${escapeHTML(error.payload?.error || error.message)}</p>`
      target.innerHTML = ''
    }
  }
}

function renderSummaryPreviewGroup(summaryType, data) {
  const wantedColumns = summaryType === 'numerical'
    ? ['column', 'statistic', 'value']
    : ['column', 'statistic', 'value', 'category', 'frequency', 'percentage', 'top_rank']
  const columnIndexes = data.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => [
      ...wantedColumns,
    ].includes(column))
    .map(({ index }) => index)
  const title = summaryType === 'numerical' ? 'Numerical summary' : 'Categorical summary'
  const headings = columnIndexes.map((index) => `<th>${escapeHTML(data.columns[index])}</th>`).join('')
  const body = data.rows.map((row) => `<tr>${columnIndexes.map((index) => `<td>${escapeHTML(row[index] ?? '')}</td>`).join('')}</tr>`).join('')
  return `<section class="statistical-preview-group"><h3>${title}</h3><div class="node-preview-table-wrap"><table class="studio-table"><thead><tr>${headings}</tr></thead><tbody>${body || `<tr><td class="table-empty" colspan="${columnIndexes.length}">No ${summaryType} summary rows on this page.</td></tr>`}</tbody></table></div><div class="node-preview-pagination"><span>Page ${data.page} of ${data.total_pages} · ${Number(data.total_rows).toLocaleString()} rows</span><button class="button-secondary button-sm" data-summary-page="-1" data-summary-type="${summaryType}" type="button" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="button-secondary button-sm" data-summary-page="1" data-summary-type="${summaryType}" type="button" ${!data.has_more ? 'disabled' : ''}>Next</button></div></section>`
}

function removeNode(nodeId) {
  nodes = nodes.filter((node) => node.id !== nodeId)
  edges = edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  if (selectedNodeId === nodeId) selectedNodeId = null
  markUnsaved()
  renderNodes()
  renderConfig()
}

function worldPoint(event) {
  const rect = viewport().getBoundingClientRect()
  return { x: (event.clientX - rect.left - pan.x) / zoom, y: (event.clientY - rect.top - pan.y) / zoom }
}

function createEdge(sourceId, targetId) {
  const source = nodes.find((node) => node.id === sourceId)
  const target = nodes.find((node) => node.id === targetId)
  if (!source || !target || sourceId === targetId) return
  if (!canOutput(source) || !canInput(target)) {
    showToast('Connections must flow from an input or transformation to a downstream node.', 'error')
    return
  }
  if (edges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
    showToast('These nodes are already connected.', 'error')
    return
  }
  const incomingCount = edges.filter((edge) => edge.target === targetId).length
  if (target.type === 'merge_data' ? incomingCount >= 2 : incomingCount >= 1) {
    showToast(target.type === 'merge_data' ? 'Merge nodes accept exactly two incoming connections.' : 'This node accepts one incoming connection.', 'error')
    return
  }
  const visited = new Set()
  const pending = [targetId]
  while (pending.length) {
    const current = pending.pop()
    if (current === sourceId) {
      showToast('That connection would create a circular dependency.', 'error')
      return
    }
    if (visited.has(current)) continue
    visited.add(current)
    edges.filter((edge) => edge.source === current).forEach((edge) => pending.push(edge.target))
  }
  edges.push({ id: crypto.randomUUID(), source: sourceId, target: targetId })
  markUnsaved()
  drawEdges()
  if (selectedNodeId) renderConfig()
}

function setCanvasZoom(value) {
  zoom = Math.min(1.6, Math.max(.45, value))
  applyTransform()
}

function fitCanvas() {
  if (!nodes.length) {
    pan = { x: 0, y: 0 }
    setCanvasZoom(1)
    return
  }
  const minX = Math.min(...nodes.map((node) => node.position.x))
  const minY = Math.min(...nodes.map((node) => node.position.y))
  const maxX = Math.max(...nodes.map((node) => node.position.x + 196))
  const maxY = Math.max(...nodes.map((node) => node.position.y + 88))
  const bounds = viewport().getBoundingClientRect()
  const nextZoom = Math.min(1.2, (bounds.width - 80) / Math.max(1, maxX - minX), (bounds.height - 80) / Math.max(1, maxY - minY))
  zoom = Math.max(.45, nextZoom)
  pan = { x: (bounds.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (bounds.height - (maxY - minY) * zoom) / 2 - minY * zoom }
  applyTransform()
}

function resetWorkflow() {
  workflowId = null
  document.documentElement.dataset.openWorkflowId = ''
  nodes = []
  edges = []
  selectedNodeId = null
  runNodeStatuses = {}
  validationErrors = {}
  lastExecutionId = null
  workflowRunMessage = null
  document.getElementById('workflow-name').value = 'Untitled workflow'
  document.getElementById('saved-workflows').value = ''
  document.getElementById('canvas-status').textContent = 'Unsaved workflow'
  document.getElementById('workflow-run-feedback').hidden = true
  pan = { x: 0, y: 0 }
  zoom = 1
  applyTransform()
  renderNodes()
  renderConfig()
}

export function newWorkflow() {
  resetWorkflow()
  switchPage('workflow')
}

export async function loadWorkflows() {
  try {
    workflowCache = await api('/api/workflows')
    const select = document.getElementById('saved-workflows')
    const selected = select.value
    select.innerHTML = `<option value="">Saved workflows</option>${workflowCache.map((workflow) => `<option value="${escapeHTML(workflow.workflow_id)}">${escapeHTML(workflow.name)}</option>`).join('')}`
    if (workflowCache.some((workflow) => workflow.workflow_id === selected)) select.value = selected
  } catch (error) {
    showToast(error.message || 'Could not load workflows.', 'error')
  }
}

async function openWorkflow() {
  const id = document.getElementById('saved-workflows').value
  if (!id) return showToast('Choose a saved workflow first.', 'error')
  try {
    const workflow = await api(`/api/workflows/${encodeURIComponent(id)}`)
    const executions = await api(`/api/executions?workflow_id=${encodeURIComponent(id)}`)
    const latestExecution = executions[0]
    workflowId = workflow.workflow_id
    document.documentElement.dataset.openWorkflowId = workflowId
    nodes = workflow.nodes
    edges = workflow.edges
    selectedNodeId = null
    runNodeStatuses = latestExecution?.node_statuses || {}
    validationErrors = Object.fromEntries(Object.entries(runNodeStatuses)
      .filter(([, status]) => ['failed', 'skipped'].includes(status.status))
      .map(([nodeId, status]) => [nodeId, status.error || `Node ${status.status}.`]))
    lastExecutionId = latestExecution?.execution_id || null
    workflowRunMessage = null
    document.getElementById('workflow-name').value = workflow.name
    updateWorkflowFocusName()
    document.getElementById('canvas-status').textContent = `Saved · ${new Date(workflow.updated_at).toLocaleString()}`
    document.getElementById('workflow-run-feedback').hidden = true
    pan = { x: 0, y: 0 }
    zoom = 1
    renderNodes()
    renderConfig()
    window.requestAnimationFrame(fitCanvas)
    showToast('Workflow design opened.')
  } catch (error) {
    showToast(error.message || 'Could not open workflow.', 'error')
  }
}

async function saveWorkflow() {
  const name = document.getElementById('workflow-name').value.trim()
  if (!name) {
    showToast('Enter a workflow name before saving.', 'error')
    return null
  }
  if (pendingSourceId) {
    pendingSourceId = null
    drawEdges()
  }
  try {
    const workflow = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: workflowId, name, nodes, edges }),
    })
    workflowId = workflow.workflow_id
    document.documentElement.dataset.openWorkflowId = workflowId
    document.getElementById('canvas-status').textContent = `Saved · ${new Date(workflow.updated_at).toLocaleString()}`
    await loadWorkflows()
    document.getElementById('saved-workflows').value = workflowId
    showToast('Workflow saved to local storage.')
    window.dispatchEvent(new CustomEvent('app:refresh'))
    return workflow
  } catch (error) {
    showToast(error.message || 'Could not save this workflow.', 'error')
    return null
  }
}

function showRunFeedback(kind, title, details = []) {
  const panel = document.getElementById('workflow-run-feedback')
  panel.hidden = false
  panel.className = `workflow-run-feedback ${kind}`
  panel.innerHTML = `<strong>${escapeHTML(title)}</strong>${details.length ? `<ul>${details.map((item) => `<li>${item.html || escapeHTML(item.text || item)}</li>`).join('')}</ul>` : ''}`
}

function updateExecutionView(record, refreshSelectedConfig = false) {
  runNodeStatuses = record.node_statuses || {}
  renderNodes()
  if (selectedNodeId && (refreshSelectedConfig || record.status !== 'running')) renderConfig()
  const states = Object.values(runNodeStatuses)
  const completed = states.filter((item) => ['success', 'failed', 'skipped'].includes(item.status)).length
  document.getElementById('canvas-status').textContent = record.status === 'running'
    ? `Running workflow · ${completed}/${states.length} nodes complete`
    : `${record.status === 'completed' ? 'Completed' : 'Failed'} · ${new Date(record.completed_at || record.started_at).toLocaleString()}`
}

async function runWorkflow() {
  const button = document.getElementById('run-workflow')
  const feedback = document.getElementById('workflow-run-feedback')
  feedback.hidden = true
  button.disabled = true
  try {
    const workflow = await saveWorkflow()
    if (!workflow) return
    lastExecutionId = null
    runNodeStatuses = {}
    validationErrors = {}
    workflowRunMessage = null
    renderNodes()
    if (selectedNodeId) renderConfig()
    try {
      const validation = await api(`/api/workflows/${encodeURIComponent(workflowId)}/validate`, { method: 'POST' })
      validationErrors = validation.node_errors || {}
    } catch (error) {
      validationErrors = error.payload?.node_errors || {}
      workflowRunMessage = Array.isArray(error.payload?.errors)
        ? error.payload.errors.join(' ')
        : error.message
      renderNodes()
      if (selectedNodeId) renderConfig()
      const errors = error.payload?.errors || [error.message]
      showRunFeedback('error', 'Workflow needs attention before it can run.', errors)
      showToast(Array.isArray(errors) && errors.length ? errors.join(' ') : error.message, 'error')
      return
    }
    workflowRunMessage = null
    document.getElementById('page-workflow').classList.add('is-running')
    for (const id of ['new-workflow', 'clear-canvas', 'save-workflow', 'open-workflow', 'saved-workflows', 'workflow-name']) document.getElementById(id).disabled = true
    const started = await api(`/api/workflows/${encodeURIComponent(workflowId)}/run`, { method: 'POST' })
    lastExecutionId = started.execution_id
    updateExecutionView(started, true)
    showRunFeedback('running', 'Workflow is running.', [`Execution ${started.execution_id}`])
    let result = started
    while (result.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      result = await api(`/api/executions/${encodeURIComponent(started.execution_id)}`)
      updateExecutionView(result)
    }
    if (result.status !== 'running') updateExecutionView(result, true)
    if (result.status === 'completed') {
      const summary = result.summary || {}
      const outputLinks = (result.output_file_ids || []).map((fileId, index) => {
        const label = summary.output_datasets?.[index] || `Download output ${index + 1}`
        return { html: `<a href="/api/files/${encodeURIComponent(fileId)}/download" download>${escapeHTML(label)}</a>` }
      })
      showRunFeedback('success', `Workflow completed: ${summary.final_rows ?? 0} output rows.`, outputLinks.length ? outputLinks : ['No output files were generated.'])
      showToast(`Workflow completed. ${summary.final_rows ?? 0} output rows · ${result.output_file_ids?.length ?? 0} file(s) created.`)
    } else {
      const message = result.error || 'A node failed. Dependent nodes were skipped.'
      const failingNode = nodes.find((node) => node.id === result.failing_node_id)
      validationErrors = result.failing_node_id ? { [result.failing_node_id]: message } : {}
      renderNodes()
      showRunFeedback('error', `Workflow failed${failingNode ? ` at ${failingNode.name}` : ''}.`, [message])
      showToast(message, 'error')
    }
    window.dispatchEvent(new CustomEvent('app:operations-refresh'))
    window.dispatchEvent(new CustomEvent('app:refresh'))
  } catch (error) {
    document.getElementById('canvas-status').textContent = 'Execution failed'
    workflowRunMessage = error.message || 'An unexpected error occurred.'
    if (error.payload?.failing_node_id) {
      validationErrors = { [error.payload.failing_node_id]: workflowRunMessage }
      renderNodes()
    }
    if (selectedNodeId) renderConfig()
    showRunFeedback('error', 'Workflow execution could not be completed.', [error.message || 'An unexpected error occurred.'])
    showToast(error.message || 'Workflow execution failed.', 'error')
    window.dispatchEvent(new CustomEvent('app:operations-refresh'))
  } finally {
    document.getElementById('page-workflow').classList.remove('is-running')
    for (const id of ['new-workflow', 'clear-canvas', 'save-workflow', 'open-workflow', 'saved-workflows', 'workflow-name']) document.getElementById(id).disabled = false
    button.disabled = false
  }
}

async function loadFilesForNodes() {
  try {
    uploadedFiles = await api('/api/files?status=uploaded')
  } catch (error) {
    showToast(error.message || 'Could not load datasets for workflow nodes.', 'error')
  }
}

function initCanvas() {
  const palette = document.querySelector('.node-panel')
  if (!edgeControlsLayer()) {
    const controls = document.createElement('div')
    controls.id = 'edge-controls-layer'
    controls.className = 'edge-controls-layer'
    stage().insertBefore(controls, nodesLayer())
  }
  document.getElementById('node-search').addEventListener('input', (event) => {
    const query = event.currentTarget.value.trim().toLowerCase()
    let visibleCount = 0
    palette.querySelectorAll('.node-group').forEach((group) => {
      let groupVisibleCount = 0
      group.querySelectorAll('.palette-node').forEach((button) => {
        const visible = `${button.textContent} ${button.dataset.nodeType}`.toLowerCase().includes(query)
        button.hidden = !visible
        if (visible) groupVisibleCount += 1
      })
      group.hidden = groupVisibleCount === 0
      visibleCount += groupVisibleCount
    })
    document.getElementById('node-search-empty').hidden = visibleCount > 0
  })
  palette.addEventListener('dragstart', (event) => {
    const button = event.target.closest('[data-node-type]')
    if (!button) return
    event.dataTransfer.setData('application/x-simple-etl-node', button.dataset.nodeType)
    event.dataTransfer.effectAllowed = 'copy'
  })
  viewport().addEventListener('dragover', (event) => event.preventDefault())
  viewport().addEventListener('drop', (event) => {
    event.preventDefault()
    const type = event.dataTransfer.getData('application/x-simple-etl-node')
    if (!definitions[type]) return
    const point = worldPoint(event)
    addNode(type, point.x - 98, point.y - 40)
  })
  palette.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-type]')
    if (!button) return
    const index = nodes.length
    const columns = Math.max(1, Math.floor((viewport().clientWidth - 50) / 225))
    addNode(button.dataset.nodeType, 30 + (index % columns) * 225, 75 + Math.floor(index / columns) * 145)
  })

  nodesLayer().addEventListener('pointerdown', (event) => {
    const port = event.target.closest('.node-port')
    if (port?.dataset.port === 'output') {
      event.preventDefault()
      event.stopPropagation()
      pendingSourceId = port.dataset.nodeId
      return
    }
    if (port) return
    const card = event.target.closest('.workflow-node')
    if (!card || event.target.closest('button')) return
    selectedNodeId = card.dataset.nodeId
    const node = nodes.find((item) => item.id === selectedNodeId)
    draggingNode = { id: selectedNodeId, pointerX: event.clientX, pointerY: event.clientY, x: node.position.x, y: node.position.y }
    card.classList.add('dragging')
    renderNodes()
    renderConfig()
  })
  nodesLayer().addEventListener('pointerup', (event) => {
    const input = event.target.closest('.node-port.input')
    if (input && pendingSourceId) {
      createEdge(pendingSourceId, input.dataset.nodeId)
      pendingSourceId = null
      drawEdges()
    }
  })
  nodesLayer().addEventListener('click', (event) => {
    const remove = event.target.closest('[data-delete-node]')
    if (remove) {
      removeNode(remove.dataset.deleteNode)
      return
    }
    const card = event.target.closest('.workflow-node')
    if (card && !event.target.closest('.node-port')) {
      selectedNodeId = card.dataset.nodeId
      renderNodes()
      renderConfig()
    }
  })
  function removeEdge(edgeId) {
    if (!edges.some((edge) => edge.id === edgeId)) return
    edges = edges.filter((edge) => edge.id !== edgeId)
    markUnsaved()
    drawEdges()
    if (selectedNodeId) renderConfig()
  }
  edgeControlsLayer().addEventListener('click', (event) => {
    const control = event.target.closest('[data-delete-edge]')
    if (control) removeEdge(control.dataset.deleteEdge)
  })
  edgeControlsLayer().addEventListener('pointerdown', (event) => {
    if (event.target.closest('[data-delete-edge]')) event.stopPropagation()
  })
  edgeControlsLayer().addEventListener('keydown', (event) => {
    const control = event.target.closest('[data-delete-edge]')
    if (!control || !['Enter', ' '].includes(event.key)) return
    event.preventDefault()
    removeEdge(control.dataset.deleteEdge)
  })

  document.addEventListener('pointermove', (event) => {
    if (draggingNode) {
      const node = nodes.find((item) => item.id === draggingNode.id)
      if (!node) return
      node.position.x = Math.max(0, Math.round(draggingNode.x + (event.clientX - draggingNode.pointerX) / zoom))
      node.position.y = Math.max(0, Math.round(draggingNode.y + (event.clientY - draggingNode.pointerY) / zoom))
      node.position.x = snapCoordinate(node.position.x)
      node.position.y = snapCoordinate(node.position.y)
      const card = nodesLayer().querySelector(`[data-node-id="${CSS.escape(node.id)}"]`)
      if (card) { card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px` }
      drawEdges()
      renderMinimap()
    }
    if (panning) {
      pan.x = panning.x + event.clientX - panning.pointerX
      pan.y = panning.y + event.clientY - panning.pointerY
      applyTransform()
    }
    if (pendingSourceId) {
      const rect = viewport().getBoundingClientRect()
      drawEdges({ x: (event.clientX - rect.left - pan.x) / zoom, y: (event.clientY - rect.top - pan.y) / zoom })
    }
  })
  document.addEventListener('pointerup', (event) => {
    if (draggingNode) {
      draggingNode = null
      nodesLayer().querySelectorAll('.workflow-node.dragging').forEach((card) => card.classList.remove('dragging'))
      markUnsaved()
    }
    if (panning) {
      panning = null
      viewport().classList.remove('panning')
    }
    if (!event.target.closest('.node-port.input') && pendingSourceId) {
      pendingSourceId = null
      drawEdges()
    }
  })
  viewport().addEventListener('pointerdown', (event) => {
    if (event.target.closest('.workflow-node') || event.target.closest('.canvas-controls')) return
    panning = { pointerX: event.clientX, pointerY: event.clientY, x: pan.x, y: pan.y }
    viewport().classList.add('panning')
  })
  document.addEventListener('keydown', (event) => {
    if (!['Delete', 'Backspace'].includes(event.key) || !selectedNodeId) return
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return
    removeNode(selectedNodeId)
  })
  window.addEventListener('resize', () => {
    if (!document.body.classList.contains('workflow-focus-mode')) return
    requestAnimationFrame(() => { drawEdges(); renderMinimap() })
  })
}

export function initWorkflow() {
  initCanvas()
  const focusNodeSelect = document.getElementById('workflow-focus-node-type')
  Object.entries(definitions).filter(([type]) => type !== 'view_data').forEach(([type, definition]) => {
    focusNodeSelect.add(new Option(definition.title, type))
  })
  document.getElementById('workflow-focus-toggle').addEventListener('click', () => {
    setWorkflowFocus(true).catch((error) => showToast(error.message || 'Large Screen Mode could not be opened.', 'error'))
  })
  document.getElementById('workflow-focus-exit').addEventListener('click', () => {
    setWorkflowFocus(false).catch((error) => showToast(error.message || 'Large Screen Mode could not be closed.', 'error'))
  })
  document.getElementById('workflow-focus-name').addEventListener('input', (event) => {
    document.getElementById('workflow-name').value = event.target.value
    markUnsaved()
  })
  document.getElementById('workflow-focus-add-node').addEventListener('click', () => {
    const index = nodes.length
    const columns = Math.max(1, Math.floor((viewport().clientWidth - 50) / 225))
    addNode(focusNodeSelect.value, 30 + (index % columns) * 225, 75 + Math.floor(index / columns) * 145)
  })
  document.getElementById('workflow-focus-zoom-in').addEventListener('click', () => setCanvasZoom(zoom + .1))
  document.getElementById('workflow-focus-zoom-out').addEventListener('click', () => setCanvasZoom(zoom - .1))
  document.getElementById('workflow-focus-fit').addEventListener('click', fitCanvas)
  document.getElementById('workflow-focus-reset').addEventListener('click', () => {
    zoom = 1
    pan = { x: 0, y: 0 }
    applyTransform()
  })
  document.getElementById('workflow-focus-save').addEventListener('click', saveWorkflow)
  document.getElementById('workflow-focus-run').addEventListener('click', runWorkflow)
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('workflow-focus-mode')) {
      document.body.classList.remove('workflow-focus-mode')
      requestAnimationFrame(() => { drawEdges(); renderMinimap() })
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('workflow-focus-mode') && !document.fullscreenElement) {
      setWorkflowFocus(false).catch((error) => showToast(error.message || 'Large Screen Mode could not be closed.', 'error'))
    }
  })
  document.getElementById('new-workflow').addEventListener('click', () => {
    if (nodes.length && !window.confirm('Start a new workflow? Unsaved changes will be discarded.')) return
    resetWorkflow()
  })
  document.getElementById('save-workflow').addEventListener('click', saveWorkflow)
  document.getElementById('run-workflow').addEventListener('click', runWorkflow)
  document.getElementById('open-workflow').addEventListener('click', openWorkflow)
  document.getElementById('clear-canvas').addEventListener('click', () => {
    if (nodes.length && !window.confirm('Clear every node and connection from this canvas?')) return
    nodes = []
    edges = []
    selectedNodeId = null
    markUnsaved()
    renderNodes()
    renderConfig()
  })
  document.getElementById('zoom-in').addEventListener('click', () => setCanvasZoom(zoom + .1))
  document.getElementById('zoom-out').addEventListener('click', () => setCanvasZoom(zoom - .1))
  document.getElementById('fit-canvas').addEventListener('click', fitCanvas)
  document.getElementById('workflow-name').addEventListener('input', () => {
    updateWorkflowFocusName()
    markUnsaved()
  })
  window.addEventListener('app:pagechange', async (event) => {
    if (event.detail.page !== 'workflow') return
    await Promise.all([loadWorkflows(), loadFilesForNodes()])
    if (selectedNodeId) renderConfig()
  })
  window.addEventListener('app:refresh', loadWorkflows)
  window.addEventListener('app:workflows-deleted', (event) => {
    if (!event.detail.workflowIds.includes(workflowId)) return
    resetWorkflow()
    showToast('The deleted workflow was closed. Its execution history and generated datasets remain available.')
  })
  window.addEventListener('app:open-workflow', async (event) => {
    switchPage('workflow')
    await loadWorkflows()
    document.getElementById('saved-workflows').value = event.detail.workflowId
    await openWorkflow()
  })
  renderNodes()
  renderConfig()
  applyTransform()
}