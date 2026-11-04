import { api, escapeHTML, showToast, switchPage } from './app.js'

const definitions = {
  csv_input: { title: 'CSV Input', group: 'Input', description: 'Choose a CSV dataset to associate with this workflow.', icon: 'bi-filetype-csv', color: 'input' },
  excel_input: { title: 'Excel Input', group: 'Input', description: 'Choose an XLSX workbook for this workflow.', icon: 'bi-file-earmark-spreadsheet', color: 'input' },
  json_input: { title: 'JSON Input', group: 'Input', description: 'Choose a JSON dataset to associate with this workflow.', icon: 'bi-braces', color: 'input' },
  clean_data: { title: 'Clean Data', group: 'Transformation', description: 'Describe a future cleaning step. This node is saved as workflow design only.', icon: 'bi-magic', color: 'transform' },
  remove_duplicates: { title: 'Remove Duplicates', group: 'Transformation', description: 'Describe duplicate handling for a later execution phase.', icon: 'bi-copy', color: 'transform' },
  filter_rows: { title: 'Filter Rows', group: 'Transformation', description: 'Record a filter rule for future workflow execution.', icon: 'bi-funnel', color: 'transform' },
  select_columns: { title: 'Select Columns', group: 'Transformation', description: 'List the columns to retain when execution is implemented.', icon: 'bi-view-list', color: 'transform' },
  rename_columns: { title: 'Rename Columns', group: 'Transformation', description: 'Describe one column rename for future execution.', icon: 'bi-input-cursor-text', color: 'transform' },
  aggregate_data: { title: 'Aggregate Data', group: 'Transformation', description: 'Describe grouping and aggregation for later execution.', icon: 'bi-bar-chart-steps', color: 'transform' },
  merge_data: { title: 'Merge Data', group: 'Transformation', description: 'Choose a second dataset for a future merge step.', icon: 'bi-intersect', color: 'transform' },
  csv_output: { title: 'CSV Output', group: 'Output', description: 'Name a future CSV output. Export is not available in Phase 1.', icon: 'bi-filetype-csv', color: 'output' },
  excel_output: { title: 'Excel Output', group: 'Output', description: 'Name a future XLSX output. Export is not available in Phase 1.', icon: 'bi-file-earmark-spreadsheet', color: 'output' },
  json_output: { title: 'JSON Output', group: 'Output', description: 'Name a future JSON output. Export is not available in Phase 1.', icon: 'bi-braces', color: 'output' },
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

const viewport = () => document.getElementById('canvas-viewport')
const stage = () => document.getElementById('canvas-stage')
const nodesLayer = () => document.getElementById('nodes-layer')
const edgeLayer = () => document.getElementById('edge-layer')

function nodeDefinition(type) {
  return definitions[type] || { title: 'Workflow node', group: 'Node', description: 'Configure this workflow node.', icon: 'bi-puzzle', color: 'transform' }
}

function markUnsaved() {
  document.getElementById('canvas-status').textContent = 'Unsaved changes'
}

function applyTransform() {
  stage().style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  document.getElementById('zoom-label').textContent = `${Math.round(zoom * 100)}%`
}

function addNode(type, x, y) {
  const definition = nodeDefinition(type)
  const node = {
    id: crypto.randomUUID(),
    type,
    name: definition.title,
    description: definition.description,
    position: { x: Math.max(12, Math.round(x)), y: Math.max(12, Math.round(y)) },
    config: {},
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
    const selected = node.id === selectedNodeId ? ' selected' : ''
    return `<article class="workflow-node${selected}" data-node-id="${escapeHTML(node.id)}" style="left:${Number(node.position.x)}px;top:${Number(node.position.y)}px" aria-label="${escapeHTML(node.name)} node"><span class="node-type-icon ${definition.color}"><i class="bi ${definition.icon}"></i></span><span class="node-card-copy"><span class="node-card-category">${escapeHTML(definition.group)}</span><strong>${escapeHTML(node.name)}</strong><small>${escapeHTML(definition.title)}</small></span><button class="node-delete" data-delete-node="${escapeHTML(node.id)}" title="Remove node" aria-label="Remove ${escapeHTML(node.name)}"><i class="bi bi-x-lg"></i></button>${canInput(node) ? `<button class="node-port input" data-port="input" data-node-id="${escapeHTML(node.id)}" title="Connection input" aria-label="Input connection for ${escapeHTML(node.name)}"></button>` : ''}${canOutput(node) ? `<button class="node-port output" data-port="output" data-node-id="${escapeHTML(node.id)}" title="Drag to connect" aria-label="Output connection for ${escapeHTML(node.name)}"></button>` : ''}</article>`
  }).join('')
  document.getElementById('canvas-empty').hidden = nodes.length > 0
  drawEdges()
  renderMinimap()
}

function portPosition(node, side) {
  return { x: node.position.x + (side === 'output' ? 196 : 0), y: node.position.y + 40 }
}

function drawEdges(previewPoint = null) {
  const paths = edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target) return ''
    const start = portPosition(source, 'output')
    const end = portPosition(target, 'input')
    const bend = Math.max(40, Math.abs(end.x - start.x) * .45)
    const middleX = (start.x + end.x) / 2
    const middleY = (start.y + end.y) / 2
    return `<g class="edge-group" data-delete-edge="${escapeHTML(edge.id)}"><path class="edge-path" d="M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}"></path><circle class="edge-delete" cx="${middleX}" cy="${middleY}" r="7"></circle><text class="edge-delete-mark" x="${middleX}" y="${middleY + 2.5}" text-anchor="middle">×</text></g>`
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
  edgeLayer().innerHTML = `<defs><marker id="edge-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M 0 1 L 8 5 L 0 9 z" fill="#568ba0"></path></marker></defs>${paths}${preview}`
}

function renderMinimap() {
  const minimap = document.getElementById('minimap-content')
  minimap.innerHTML = nodes.map((node) => `<span class="minimap-node" style="left:${12 + node.position.x / 2200 * 78}px;top:${16 + node.position.y / 1600 * 47}px"></span>`).join('')
}

function formField(label, key, value = '', options = {}) {
  if (options.choices) {
    const choices = options.choices.map((choice) => `<option value="${escapeHTML(choice.value)}" ${String(value) === String(choice.value) ? 'selected' : ''}>${escapeHTML(choice.label)}</option>`).join('')
    return `<div class="config-field"><label for="config-${escapeHTML(key)}">${escapeHTML(label)}</label><select id="config-${escapeHTML(key)}" name="${escapeHTML(key)}">${choices}</select></div>`
  }
  const input = options.multiline
    ? `<textarea id="config-${escapeHTML(key)}" name="${escapeHTML(key)}" placeholder="${escapeHTML(options.placeholder || '')}">${escapeHTML(value)}</textarea>`
    : `<input id="config-${escapeHTML(key)}" name="${escapeHTML(key)}" value="${escapeHTML(value)}" placeholder="${escapeHTML(options.placeholder || '')}" ${options.type ? `type="${options.type}"` : ''} />`
  return `<div class="config-field"><label for="config-${escapeHTML(key)}">${escapeHTML(label)}</label>${input}</div>`
}

function fileChoices(extensions) {
  const eligible = uploadedFiles.filter((file) => extensions.includes(file.file_type))
  return [{ value: '', label: eligible.length ? 'Choose a dataset' : 'Upload a compatible dataset first' }, ...eligible.map((file) => ({ value: file.file_id, label: file.filename }))]
}

function renderConfig() {
  const node = nodes.find((item) => item.id === selectedNodeId)
  const content = document.getElementById('config-content')
  if (!node) {
    document.getElementById('config-title').textContent = 'Configuration'
    document.getElementById('config-subtitle').textContent = 'Select a node to review its details.'
    content.innerHTML = '<div class="config-empty"><span><i class="bi bi-sliders"></i></span><p>Choose a node on the canvas to configure its saved options.</p></div>'
    return
  }
  const definition = nodeDefinition(node.type)
  document.getElementById('config-title').textContent = node.name
  document.getElementById('config-subtitle').textContent = definition.group
  let fields = ''
  if (node.type === 'csv_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['csv']) })
  if (node.type === 'excel_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['xlsx']) })
  if (node.type === 'json_input') fields += formField('Dataset', 'file_id', node.config.file_id, { choices: fileChoices(['json']) })
  if (node.type === 'clean_data') fields += formField('Cleaning notes', 'notes', node.config.notes, { multiline: true, placeholder: 'Describe how values should be standardized' })
  if (node.type === 'remove_duplicates') fields += formField('Compare columns', 'columns', node.config.columns, { placeholder: 'Leave blank to compare all columns' })
  if (node.type === 'filter_rows') {
    fields += formField('Column', 'column', node.config.column, { placeholder: 'e.g. status' })
    fields += formField('Operator', 'operator', node.config.operator, { choices: [{ value: '', label: 'Choose operator' }, { value: 'equals', label: 'Equals' }, { value: 'not_equals', label: 'Does not equal' }, { value: 'contains', label: 'Contains' }, { value: 'greater_than', label: 'Greater than' }, { value: 'less_than', label: 'Less than' }] })
    fields += formField('Value', 'value', node.config.value, { placeholder: 'Filter value' })
  }
  if (node.type === 'select_columns') fields += formField('Columns to keep', 'columns', node.config.columns, { placeholder: 'region, sales, date' })
  if (node.type === 'rename_columns') {
    fields += formField('Current column', 'from', node.config.from, { placeholder: 'current_name' })
    fields += formField('New column name', 'to', node.config.to, { placeholder: 'new_name' })
  }
  if (node.type === 'aggregate_data') {
    fields += formField('Group by', 'group_by', node.config.group_by, { placeholder: 'region' })
    fields += formField('Value column', 'column', node.config.column, { placeholder: 'sales' })
    fields += formField('Operation', 'operation', node.config.operation, { choices: [{ value: '', label: 'Choose operation' }, { value: 'sum', label: 'Sum' }, { value: 'average', label: 'Average' }, { value: 'count', label: 'Count' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }] })
  }
  if (node.type === 'merge_data') fields += formField('Second dataset', 'second_file_id', node.config.second_file_id, { choices: [{ value: '', label: 'Choose a dataset' }, ...uploadedFiles.map((file) => ({ value: file.file_id, label: file.filename }))] })
  if (node.type.endsWith('_output')) fields += formField('Output filename', 'filename', node.config.filename || 'processed-dataset', { placeholder: 'processed-dataset' })
  if (!fields) fields = '<p class="config-description">This node has no configuration fields in Phase 1.</p>'
  content.innerHTML = `<p class="config-description">${escapeHTML(definition.description)}</p><span class="config-type"><i class="bi ${definition.icon}"></i>${escapeHTML(definition.group)} node</span><form id="node-config-form">${fields}<div class="config-warning"><i class="bi bi-info-circle"></i><span>Options are saved with the design. Phase 1 does not run transformations or exports.</span></div><div class="config-actions"><button class="button-secondary" type="button" id="cancel-node-config">Cancel</button><button class="button-primary" type="submit">Save settings</button></div></form><button class="config-remove" type="button" id="remove-selected-node"><i class="bi bi-trash3"></i> Remove node</button>`
  document.getElementById('node-config-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    node.config = values
    markUnsaved()
    showToast('Node settings saved to this workflow design.')
    renderNodes()
    renderConfig()
  })
  document.getElementById('cancel-node-config').addEventListener('click', renderConfig)
  document.getElementById('remove-selected-node').addEventListener('click', () => removeNode(node.id))
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
  if (sourceId === targetId || edges.some((edge) => edge.source === sourceId && edge.target === targetId)) return
  edges.push({ id: crypto.randomUUID(), source: sourceId, target: targetId })
  markUnsaved()
  drawEdges()
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
  const maxY = Math.max(...nodes.map((node) => node.position.y + 80))
  const bounds = viewport().getBoundingClientRect()
  const nextZoom = Math.min(1.2, (bounds.width - 80) / Math.max(1, maxX - minX), (bounds.height - 80) / Math.max(1, maxY - minY))
  zoom = Math.max(.45, nextZoom)
  pan = { x: (bounds.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (bounds.height - (maxY - minY) * zoom) / 2 - minY * zoom }
  applyTransform()
}

function resetWorkflow() {
  workflowId = null
  nodes = []
  edges = []
  selectedNodeId = null
  document.getElementById('workflow-name').value = 'Untitled workflow'
  document.getElementById('saved-workflows').value = ''
  document.getElementById('canvas-status').textContent = 'Unsaved workflow'
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
    workflowId = workflow.workflow_id
    nodes = workflow.nodes
    edges = workflow.edges
    selectedNodeId = null
    document.getElementById('workflow-name').value = workflow.name
    document.getElementById('canvas-status').textContent = `Saved · ${new Date(workflow.updated_at).toLocaleString()}`
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
  if (!name) return showToast('Enter a workflow name before saving.', 'error')
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
    document.getElementById('canvas-status').textContent = `Saved · ${new Date(workflow.updated_at).toLocaleString()}`
    await loadWorkflows()
    document.getElementById('saved-workflows').value = workflowId
    showToast('Workflow saved to local storage.')
    window.dispatchEvent(new CustomEvent('app:refresh'))
  } catch (error) {
    showToast(error.message || 'Could not save this workflow.', 'error')
  }
}

async function loadFilesForNodes() {
  try {
    uploadedFiles = await api('/api/files?status=uploaded')
  } catch {
    uploadedFiles = []
  }
}

function initCanvas() {
  const palette = document.querySelector('.node-panel')
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
  edgeLayer().addEventListener('click', (event) => {
    const group = event.target.closest('[data-delete-edge]')
    if (!group) return
    edges = edges.filter((edge) => edge.id !== group.dataset.deleteEdge)
    markUnsaved()
    drawEdges()
  })

  document.addEventListener('pointermove', (event) => {
    if (draggingNode) {
      const node = nodes.find((item) => item.id === draggingNode.id)
      if (!node) return
      node.position.x = Math.max(0, Math.round(draggingNode.x + (event.clientX - draggingNode.pointerX) / zoom))
      node.position.y = Math.max(0, Math.round(draggingNode.y + (event.clientY - draggingNode.pointerY) / zoom))
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
}

export function initWorkflow() {
  initCanvas()
  document.getElementById('new-workflow').addEventListener('click', () => {
    if (nodes.length && !window.confirm('Start a new workflow? Unsaved changes will be discarded.')) return
    resetWorkflow()
  })
  document.getElementById('save-workflow').addEventListener('click', saveWorkflow)
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
  document.getElementById('workflow-name').addEventListener('input', markUnsaved)
  window.addEventListener('app:pagechange', async (event) => {
    if (event.detail.page !== 'workflow') return
    await Promise.all([loadWorkflows(), loadFilesForNodes()])
    if (selectedNodeId) renderConfig()
  })
  window.addEventListener('app:refresh', loadWorkflows)
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