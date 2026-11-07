import { api, deleteWithConfirmation, escapeHTML, showToast } from './app.js'

let uploadedFiles = []
let selectedFile = null
let schema = []
let baseSchema = []
let cleaningSteps = []
let activeStepIndex = null
let previewStageIndex = null
let previewMode = 'after'
let cleaningPreview = null
let cleaningStages = []
let cleaningPreviewRequest = 0
let previewTimer
let historyTimer
const selectedProcessedIds = new Set()
const selectedExecutionIds = new Set()

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

async function loadProcessed() {
  try {
    const files = await api('/api/files')
    const processed = files.filter((file) => file.status === 'processed')
    for (const id of selectedProcessedIds) {
      if (!processed.some((file) => file.file_id === id)) selectedProcessedIds.delete(id)
    }
    document.getElementById('processed-count').textContent = String(processed.length)
    document.getElementById('processed-table-body').innerHTML = processed.length
      ? processed.map((file) => `<tr><td><input type="checkbox" data-select-processed="${escapeHTML(file.file_id)}" aria-label="Select ${escapeHTML(file.filename)}" ${selectedProcessedIds.has(file.file_id) ? 'checked' : ''} /></td><td>${escapeHTML(file.filename)}</td><td>${escapeHTML(file.file_type.toUpperCase())}</td><td>${formatSize(file.file_size)}</td><td>${Number.isInteger(file.row_count) ? file.row_count : '—'}</td><td>${escapeHTML(formatDate(file.uploaded_at))}</td><td><a class="button-secondary button-sm" href="/api/files/${encodeURIComponent(file.file_id)}/download" download><i class="bi bi-download"></i> Download</a><button class="table-action danger-action" data-delete-processed="${escapeHTML(file.file_id)}" aria-label="Delete ${escapeHTML(file.filename)}" title="Delete dataset"><i class="bi bi-trash3"></i></button></td></tr>`).join('')
      : '<tr><td class="table-empty" colspan="7">No processed datasets yet.</td></tr>'
    updateSelectionControls('processed', processed)
  } catch (error) {
    showToast(error.message || 'Could not load processed datasets.', 'error')
  }
}

function updateSelectionControls(type, visibleRecords) {
  const isProcessed = type === 'processed'
  const selected = isProcessed ? selectedProcessedIds : selectedExecutionIds
  const prefix = isProcessed ? 'processed' : 'history'
  const selectAll = document.getElementById(`${prefix}-select-all`)
  const visibleIds = visibleRecords.map((record) => isProcessed ? record.file_id : record.execution_id)
  const selectedVisible = visibleIds.filter((id) => selected.has(id)).length
  selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length
  selectAll.disabled = visibleIds.length === 0
  document.getElementById(`${prefix}-selected-count`).textContent = `${selected.size} selected`
  document.getElementById(`${prefix}-delete-selected`).disabled = selected.size === 0
  document.getElementById(`${prefix}-clear-all`).disabled = visibleRecords.length === 0
}

async function deleteProcessed(ids, mode = 'selected') {
  const clearAll = mode === 'clear'
  if (!clearAll && !ids.length) return
  const records = (await api('/api/files')).filter((file) => file.status === 'processed')
  const selectedIds = clearAll ? records.map((file) => file.file_id) : ids
  if (!selectedIds.length) return
  const url = clearAll ? '/api/processed/clear' : '/api/processed/delete-selected'
  const options = clearAll ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ file_ids: selectedIds }) }
  const result = await deleteWithConfirmation({
    url,
    options,
    itemType: 'processed dataset',
    count: selectedIds.length,
    confirmedUrl: clearAll ? `${url}?confirm_dependencies=true` : url,
    confirmedOptions: clearAll ? options : { method: 'POST', body: JSON.stringify({ file_ids: selectedIds, confirm_dependencies: true }) },
  })
  if (!result) return
  const deleted = Array.isArray(result.deleted) ? result.deleted : result.deleted ? [{ file_id: result.file_id }] : []
  for (const item of deleted) selectedProcessedIds.delete(item.file_id)
  if (deleted.length) showToast(`${deleted.length} processed dataset${deleted.length === 1 ? '' : 's'} permanently deleted.`)
  if (result.failed?.length) showToast(`${result.failed.length} dataset${result.failed.length === 1 ? '' : 's'} could not be deleted.`, 'error')
  await loadProcessed()
  window.dispatchEvent(new CustomEvent('app:refresh'))
}

async function deleteHistory(ids, mode = 'selected') {
  const clearAll = mode === 'clear'
  if (!clearAll && !ids.length) return
  const selectedIds = clearAll
    ? (await api('/api/executions')).map((run) => run.execution_id)
    : ids
  if (!selectedIds.length) return
  const url = clearAll ? '/api/executions/clear' : '/api/executions/delete-selected'
  const options = clearAll ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ execution_ids: selectedIds }) }
  const result = await deleteWithConfirmation({ url, options, itemType: 'execution record', count: selectedIds.length })
  if (!result) return
  const deleted = Array.isArray(result.deleted) ? result.deleted : result.deleted ? [{ execution_id: result.execution_id, artifact_failures: [] }] : []
  for (const item of deleted) selectedExecutionIds.delete(item.execution_id)
  const failedArtifacts = deleted.flatMap((item) => item.artifact_failures || [])
  if (deleted.length) showToast(`${deleted.length} execution record${deleted.length === 1 ? '' : 's'} deleted; processed datasets and workflows were preserved.`)
  if (result.failed?.length || failedArtifacts.length) showToast(`${result.failed?.length || 0} execution record(s) and ${failedArtifacts.length} artifact(s) could not be deleted.`, 'error')
  document.getElementById('execution-detail').hidden = true
  await loadHistory()
  window.dispatchEvent(new CustomEvent('app:refresh'))
}

async function loadHistory() {
  try {
    const params = new URLSearchParams()
    const query = document.getElementById('execution-search').value.trim()
    const status = document.getElementById('execution-status').value
    if (query) params.set('q', query)
    if (status) params.set('status', status)
    const runs = await api(`/api/executions${params.size ? `?${params}` : ''}`)
    for (const id of selectedExecutionIds) {
      if (!runs.some((run) => run.execution_id === id)) selectedExecutionIds.delete(id)
    }
    const body = document.getElementById('execution-table-body')
    body.innerHTML = runs.length
      ? runs.map((run) => {
        const duration = run.summary?.duration_seconds
        return `<tr><td><input type="checkbox" data-select-execution="${escapeHTML(run.execution_id)}" aria-label="Select execution for ${escapeHTML(run.workflow_name)}" ${selectedExecutionIds.has(run.execution_id) ? 'checked' : ''} ${run.status === 'running' ? 'disabled' : ''} /></td><td>${escapeHTML(run.workflow_name)}</td><td><span class="file-status ${escapeHTML(run.status)}">${escapeHTML(run.status)}</span></td><td>${escapeHTML(formatDate(run.started_at))}</td><td>${Number.isFinite(duration) ? `${duration}s` : '—'}</td><td><button class="table-action" data-execution-details="${escapeHTML(run.execution_id)}" aria-label="View ${escapeHTML(run.workflow_name)} execution details"><i class="bi bi-arrow-up-right"></i></button><button class="table-action danger-action" data-delete-execution="${escapeHTML(run.execution_id)}" aria-label="Delete execution for ${escapeHTML(run.workflow_name)}" title="Delete history record" ${run.status === 'running' ? 'disabled' : ''}><i class="bi bi-trash3"></i></button></td></tr>`
      }).join('')
      : '<tr><td class="table-empty" colspan="6">No workflow executions match this view.</td></tr>'
    updateSelectionControls('history', runs.filter((run) => run.status !== 'running'))
  } catch (error) {
    showToast(error.message || 'Could not load execution history.', 'error')
  }
}

function renderExecutionDetails(run) {
  const detail = document.getElementById('execution-detail')
  const summary = run.summary || {}
  const outputs = (run.output_file_ids || []).map((fileId) => `<a href="/api/files/${encodeURIComponent(fileId)}/download" download>Download output</a>`).join('')
  detail.hidden = false
  detail.innerHTML = `<h3>${escapeHTML(run.workflow_name)} · ${escapeHTML(run.status)}</h3><p>Execution ${escapeHTML(run.execution_id)}</p><p>Started ${escapeHTML(formatDate(run.started_at))}${run.completed_at ? ` · completed ${escapeHTML(formatDate(run.completed_at))}` : ''}</p><p>Rows: ${Number(summary.input_rows) || 0} in → ${Number(summary.final_rows) || 0} out · Columns: ${Number(summary.input_columns) || 0} in → ${Number(summary.final_columns) || 0} out · ${Number.isFinite(summary.duration_seconds) ? `${summary.duration_seconds}s` : 'duration unavailable'}</p>${run.error ? `<p class="execution-error">${escapeHTML(run.error)}</p>` : ''}<div>${outputs || 'No output datasets.'}</div>`
}

async function loadCleaningDatasets() {
  try {
    uploadedFiles = (await api('/api/files')).filter((file) => ['uploaded', 'processed'].includes(file.status))
    const select = document.getElementById('cleaning-dataset')
    const selected = select.value
    select.innerHTML = `<option value="">Choose a dataset</option>${uploadedFiles.map((file) => `<option value="${escapeHTML(file.file_id)}">${escapeHTML(file.filename)} · ${file.status === 'processed' ? 'Processed' : 'Uploaded'}</option>`).join('')}`
    if (uploadedFiles.some((file) => file.file_id === selected)) select.value = selected
  } catch (error) {
    showToast(error.message || 'Could not load datasets for cleaning.', 'error')
  }
}

function columnChoices(multiple = false, name = 'columns') {
  const options = schema.map((column) => `<option value="${escapeHTML(column.name)}">${escapeHTML(column.name)} · ${escapeHTML(column.dtype)}</option>`).join('')
  return `<select name="${escapeHTML(name)}"${multiple ? ' multiple size="4"' : ''}>${options}</select>`
}

function operationInputSchema(index = activeStepIndex) {
  if (index !== null && index > 0) return cleaningStages[index - 1]?.schema || baseSchema
  if (index === 0) return baseSchema
  if (cleaningSteps.length) return cleaningStages[cleaningSteps.length - 1]?.schema || baseSchema
  return baseSchema
}

function renderCleaningOptions(config = {}) {
  const operation = document.getElementById('cleaning-operation').value
  const target = document.getElementById('cleaning-options')
  const singleColumn = `<label class="config-field"><span>Column</span>${columnChoices(false, 'column')}</label>`
  const multiColumn = `<label class="config-field"><span>Columns</span>${columnChoices(true, 'columns')}</label>`
  const numberOfColumns = schema.length
  if (!selectedFile || !numberOfColumns || operation === 'inspect') {
    target.innerHTML = operation === 'inspect' ? '<p>Select a dataset to inspect its current data quality.</p>' : ''
    return
  }
  if (['remove_missing_rows', 'remove_missing_columns'].includes(operation)) {
    target.innerHTML = '<p>This operation applies to the whole dataset.</p>'
  } else if (operation === 'fill_missing') {
    target.innerHTML = `${multiColumn}<p>Choose columns to fill, or leave them unselected to use all columns.</p><label class="config-field"><span>Fill method</span><select name="method"><option value="constant">Constant value</option><option value="mean">Mean (numeric)</option><option value="median">Median (numeric)</option><option value="mode">Most common value</option></select></label><label class="config-field"><span>Constant value</span><input name="value" value="" /></label>`
  } else if (operation === 'remove_duplicates') {
    target.innerHTML = `<label class="config-field"><span>Columns (optional)</span>${columnChoices(true, 'columns')}</label><p>Leave columns unselected to compare complete rows.</p>`
  } else if (operation === 'filter_rows') {
    target.innerHTML = `${singleColumn}<label class="config-field"><span>Condition</span><select name="operator"><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="greater_than">Greater than</option><option value="less_than">Less than</option><option value="contains">Contains</option><option value="not_contains">Does not contain</option><option value="is_null">Is missing</option><option value="not_null">Is not missing</option></select></label><label class="config-field"><span>Value</span><input name="value" /></label>`
  } else if (['trim_text', 'uppercase', 'lowercase', 'titlecase', 'remove_unwanted_characters', 'inspect_outliers', 'remove_outliers'].includes(operation)) {
    target.innerHTML = singleColumn
  } else if (operation === 'replace_text') {
    target.innerHTML = `${singleColumn}<label class="config-field"><span>Find</span><input name="find" required /></label><label class="config-field"><span>Replace with</span><input name="replace" /></label>`
  } else if (operation === 'convert_type') {
    target.innerHTML = `${singleColumn}<label class="config-field"><span>Convert to</span><select name="target_type"><option value="integer">Integer</option><option value="float">Number</option><option value="string">Text</option><option value="datetime">Date/time</option></select></label>`
  } else if (operation === 'remove_columns' || operation === 'select_columns' || operation === 'reorder_columns') {
    target.innerHTML = multiColumn
  } else if (operation === 'rename_column') {
    target.innerHTML = `<label class="config-field"><span>Current column</span>${columnChoices(false, 'from')}</label><label class="config-field"><span>New name</span><input name="to" required /></label>`
  }
  for (const [name, value] of Object.entries(config)) {
    if (name === 'operation') continue
    const field = target.elements.namedItem(name)
    if (!field) continue
    if (field instanceof HTMLSelectElement && field.multiple && Array.isArray(value)) {
      Array.from(field.options).forEach((option) => { option.selected = value.includes(option.value) })
    } else {
      field.value = value
    }
  }
  const filterOperator = target.elements.namedItem('operator')
  if (filterOperator) updateFilterValueRequirement()
}

function renderPreviewTable(preview, mode) {
  const table = document.getElementById('cleaning-preview-table')
  const header = preview.columns.map((name) => `<th scope="col">${escapeHTML(name)}</th>`).join('')
  const rows = preview.rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHTML(value ?? '')}</td>`).join('')}</tr>`).join('')
  const emptyMessage = mode === 'after' && preview.total_rows === 0
    ? 'Cleaning produced no rows.'
    : 'No preview rows are available.'
  table.innerHTML = `<table class="studio-table"><thead><tr>${header}</tr></thead><tbody>${rows || `<tr><td class="table-empty" colspan="${preview.columns.length || 1}">${escapeHTML(emptyMessage)}</td></tr>`}</tbody></table>`
}

function renderCleaningPreview() {
  if (!cleaningPreview) return
  const metrics = document.getElementById('cleaning-metrics')
  const caption = document.getElementById('cleaning-preview-caption')
  const preview = previewMode === 'before' ? cleaningPreview.before : cleaningPreview.after
  const stats = previewMode === 'before' ? cleaningPreview.before_stats : cleaningPreview.after_stats
  const step = cleaningPreview.selected_step
  const operationName = step >= 0
    ? document.querySelector(`#cleaning-operation option[value="${CSS.escape(cleaningPreview.step_name)}"]`)?.textContent || cleaningPreview.step_name
    : 'Original dataset'
  caption.textContent = `${cleaningPreview.filename} · ${previewMode === 'before' ? 'Before cleaning' : operationName} · ${stats.rows.toLocaleString()} rows · ${stats.columns} columns`
  metrics.innerHTML = [
    ['Rows', stats.rows, cleaningPreview.before_stats.rows],
    ['Columns', stats.columns, cleaningPreview.before_stats.columns],
    ['Missing cells', stats.missing_cells, cleaningPreview.before_stats.missing_cells],
    ['Duplicate rows', stats.duplicate_rows, cleaningPreview.before_stats.duplicate_rows],
  ].map(([label, value, before]) => {
    const difference = Number(value) - Number(before)
    const change = previewMode === 'after' && difference !== 0
      ? `<small class="cleaning-metric-change">${difference > 0 ? '+' : ''}${difference.toLocaleString()} vs before</small>`
      : ''
    return `<article><small>${escapeHTML(label)}</small><strong>${Number(value).toLocaleString()}</strong>${change}</article>`
  }).join('')
  renderPreviewTable(preview, previewMode)
}

function setCleaningPreviewStatus(message, state = '') {
  const target = document.getElementById('cleaning-preview-status')
  target.dataset.state = state
  target.textContent = message
}

function clearCleaningAfterPreview(message) {
  cleaningPreview = null
  const table = document.getElementById('cleaning-preview-table')
  if (previewMode === 'after') table.innerHTML = ''
  document.getElementById('cleaning-metrics').innerHTML = ''
  document.getElementById('cleaning-preview-caption').textContent = message
}

function setPreviewMode(mode) {
  previewMode = mode
  document.getElementById('cleaning-preview-before').classList.toggle('active', mode === 'before')
  document.getElementById('cleaning-preview-before').setAttribute('aria-pressed', String(mode === 'before'))
  document.getElementById('cleaning-preview-after').classList.toggle('active', mode === 'after')
  document.getElementById('cleaning-preview-after').setAttribute('aria-pressed', String(mode === 'after'))
  if (cleaningPreview) renderCleaningPreview()
  else clearCleaningAfterPreview(mode === 'before' ? 'Before-cleaning data is loading.' : 'Choose an operation to preview its result.')
}

function cleaningPayload() {
  const operation = document.getElementById('cleaning-operation').value
  if (operation === 'inspect') return null
  const form = document.getElementById('cleaning-options')
  const payload = Object.fromEntries(new FormData(form).entries())
  const multiple = form.querySelector('select[multiple]')
  if (multiple) {
    const columns = Array.from(multiple.selectedOptions, (option) => option.value).filter(Boolean)
    if (columns.length) payload.columns = columns
    else delete payload.columns
  }
  if (['remove_missing_rows', 'remove_missing_columns'].includes(operation)) return { operation }
  if (operation === 'remove_duplicates' && !payload.columns) return { operation }
  return { ...payload, operation }
}

function pipelineOperations() {
  const operations = cleaningSteps.map((step) => step.config)
  if (activeStepIndex !== null) {
    operations[activeStepIndex] = cleaningPayload()
  } else {
    const draft = cleaningPayload()
    if (draft) operations.push(draft)
  }
  return operations.filter(Boolean)
}

function renderCleaningSequence() {
  const target = document.getElementById('cleaning-sequence')
  const operationSelect = document.getElementById('cleaning-operation')
  const rows = cleaningSteps.map((step, index) => {
    const label = operationSelect.querySelector(`option[value="${CSS.escape(step.config.operation)}"]`)?.textContent || step.config.operation
    return `<div class="cleaning-sequence-step${activeStepIndex === index ? ' active' : ''}"><button type="button" class="cleaning-sequence-select" data-cleaning-step="${index}"><span>${index + 1}. ${escapeHTML(label)}</span><small>${escapeHTML(step.config.column || step.config.from || step.config.columns?.join(', ') || '')}</small></button><button type="button" class="cleaning-sequence-remove" data-remove-cleaning-step="${index}" aria-label="Remove ${escapeHTML(label)} step"><i class="bi bi-x-lg"></i></button></div>`
  }).join('')
  const draft = activeStepIndex === null && operationSelect.value !== 'inspect'
    ? `<p class="cleaning-sequence-draft">Live preview includes this unadded operation.</p>`
    : ''
  target.innerHTML = `${rows}${draft}` || '<p>No operations in the sequence yet.</p>'
  document.getElementById('add-cleaning-step').disabled = !selectedFile || operationSelect.value === 'inspect'
  document.getElementById('apply-cleaning').disabled = !selectedFile || (!cleaningSteps.length && operationSelect.value === 'inspect')
}

function updateFilterValueRequirement() {
  const operator = document.querySelector('#cleaning-options [name="operator"]')
  const value = document.querySelector('#cleaning-options [name="value"]')
  if (operator && value) value.required = !['is_null', 'not_null'].includes(operator.value)
}

function selectedOperationSchema() {
  return operationInputSchema()
}

function scheduleCleaningPreview() {
  window.clearTimeout(previewTimer)
  const token = ++cleaningPreviewRequest
  if (!selectedFile) {
    setCleaningPreviewStatus('Select a dataset to preview.', 'empty')
    clearCleaningAfterPreview('Choose a dataset to inspect a sample.')
    return
  }
  setCleaningPreviewStatus('Updating preview…', 'loading')
  if (previewMode === 'after') clearCleaningAfterPreview('Updating the expected result…')
  previewTimer = window.setTimeout(() => refreshCleaningPreview(token), 180)
}

async function refreshCleaningPreview(token = ++cleaningPreviewRequest) {
  if (!selectedFile) return
  const operations = pipelineOperations()
  const selectedStep = previewMode === 'before'
    ? -1
    : previewStageIndex === null
      ? operations.length - 1
      : Math.min(previewStageIndex, operations.length - 1)
  try {
    const result = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/clean/preview`, {
      method: 'POST',
      body: JSON.stringify({ operations, step: selectedStep, page_size: 50 }),
    })
    if (token !== cleaningPreviewRequest) return
    cleaningPreview = result
    cleaningStages = result.stages
    setCleaningPreviewStatus(
      operations.length ? `Preview ready · ${operations.length} sequential operation${operations.length === 1 ? '' : 's'}` : 'Current dataset',
      'success',
    )
    renderCleaningSequence()
    if (previewMode === 'after') schema = selectedOperationSchema()
    renderCleaningPreview()
  } catch (error) {
    if (token !== cleaningPreviewRequest) return
    cleaningPreview = null
    const table = document.getElementById('cleaning-preview-table')
    if (previewMode === 'after') table.innerHTML = ''
    document.getElementById('cleaning-metrics').innerHTML = ''
    document.getElementById('cleaning-preview-caption').textContent = 'The latest preview could not be generated.'
    setCleaningPreviewStatus(error.message || 'Preview failed. Check this operation and its settings.', 'error')
    renderCleaningSequence()
  }
}

async function loadCleaningDataset(forceReset = false) {
  const fileId = document.getElementById('cleaning-dataset').value
  const changed = selectedFile?.file_id !== fileId
  selectedFile = uploadedFiles.find((file) => file.file_id === fileId) || null
  window.clearTimeout(previewTimer)
  cleaningPreviewRequest += 1
  if (changed || forceReset) {
    cleaningSteps = []
    activeStepIndex = null
    previewStageIndex = null
    previewMode = 'after'
    cleaningStages = []
    cleaningPreview = null
    document.getElementById('cleaning-operation').value = 'inspect'
    document.getElementById('cleaning-summary').textContent = ''
    document.getElementById('cleaning-preview-table').innerHTML = ''
    document.getElementById('cleaning-metrics').innerHTML = ''
  }
  setPreviewMode(previewMode)
  if (!selectedFile) {
    schema = []
    baseSchema = []
    renderCleaningOptions()
    renderCleaningSequence()
    cleaningPreview = null
    document.getElementById('cleaning-metrics').innerHTML = ''
    document.getElementById('cleaning-preview-table').innerHTML = ''
    document.getElementById('cleaning-preview-caption').textContent = 'Choose a dataset to inspect a sample.'
    setCleaningPreviewStatus('Select a dataset to preview.', 'empty')
    return
  }
  const token = cleaningPreviewRequest
  setCleaningPreviewStatus('Loading dataset preview…', 'loading')
  clearCleaningAfterPreview('Loading the original dataset…')
  try {
    const inspection = await api(`/api/files/${encodeURIComponent(fileId)}/summary`)
    if (token !== cleaningPreviewRequest) return
    baseSchema = inspection.schema
    schema = operationInputSchema()
    if (activeStepIndex !== null) renderCleaningOptions(cleaningSteps[activeStepIndex].config)
    else renderCleaningOptions()
    renderCleaningSequence()
    await refreshCleaningPreview()
  } catch (error) {
    if (token !== cleaningPreviewRequest) return
    schema = []
    cleaningPreview = null
    document.getElementById('cleaning-preview-table').innerHTML = ''
    document.getElementById('cleaning-metrics').innerHTML = ''
    document.getElementById('cleaning-preview-caption').textContent = 'The dataset preview could not be loaded.'
    setCleaningPreviewStatus(error.message || 'Could not inspect this dataset.', 'error')
  }
}

function editCleaningStep(index) {
  if (index < 0 || index >= cleaningSteps.length) return
  activeStepIndex = index
  previewStageIndex = index
  const config = cleaningSteps[index].config
  document.getElementById('cleaning-operation').value = config.operation
  schema = operationInputSchema(index)
  renderCleaningOptions(config)
  renderCleaningSequence()
  scheduleCleaningPreview()
}

function addCleaningStep() {
  if (!selectedFile) {
    showToast('Choose a dataset before adding a cleaning operation.', 'error')
    return
  }
  const form = document.getElementById('cleaning-options')
  if (document.getElementById('cleaning-operation').value === 'inspect' || !form.reportValidity()) return
  const config = cleaningPayload()
  if (activeStepIndex === null) {
    cleaningSteps.push({ config })
  } else {
    cleaningSteps[activeStepIndex] = { config }
  }
  activeStepIndex = null
  previewStageIndex = null
  document.getElementById('cleaning-operation').value = 'inspect'
  renderCleaningOptions()
  renderCleaningSequence()
  scheduleCleaningPreview()
}

async function applyCleaning() {
  if (!selectedFile) {
    showToast('Choose a dataset first.', 'error')
    return
  }
  const button = document.getElementById('apply-cleaning')
  const summary = document.getElementById('cleaning-summary')
  const form = document.getElementById('cleaning-options')
  const operation = document.getElementById('cleaning-operation').value
  if (operation !== 'inspect' && !form.reportValidity()) return
  const operations = pipelineOperations()
  if (operations.length === 1 && operations[0].operation === 'inspect_outliers' && cleaningSteps.length === 0) {
    button.disabled = true
    try {
      const response = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/clean`, {
        method: 'POST',
        body: JSON.stringify(operations[0]),
      })
      summary.innerHTML = `<strong>Outlier inspection</strong><p>${response.inspection.affected_records} values outside ${response.inspection.lower_bound}–${response.inspection.upper_bound}. No data was changed.</p>`
    } catch (error) {
      summary.textContent = error.message || 'The outlier inspection failed.'
    } finally {
      renderCleaningSequence()
    }
    return
  }
  if (!operations.length && operation === 'inspect') {
    try {
      const inspection = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/summary`)
      summary.innerHTML = `<strong>Dataset quality</strong><p>${inspection.rows.toLocaleString()} rows · ${inspection.columns} columns · ${inspection.missing_cells.toLocaleString()} missing cells · ${inspection.duplicate_rows.toLocaleString()} duplicate rows</p><p>Numeric: ${escapeHTML(inspection.numeric_columns.join(', ') || 'none')} · Text: ${escapeHTML(inspection.text_columns.join(', ') || 'none')} · Dates: ${escapeHTML(inspection.date_columns.join(', ') || 'none')}</p>`
    } catch (error) {
      summary.textContent = error.message || 'The dataset could not be inspected.'
    }
    return
  }
  button.disabled = true
  summary.textContent = 'Processing dataset…'
  try {
    const response = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/clean`, {
      method: 'POST',
      body: JSON.stringify({ operations }),
    })
    const { before, after } = response.summary
    const output = response.dataset
    summary.innerHTML = `<strong>Processed copy created</strong><p>${operations.length} sequential operation${operations.length === 1 ? '' : 's'} · rows ${before.rows} → ${after.rows} · columns ${before.columns} → ${after.columns} · missing ${before.missing_cells} → ${after.missing_cells} · duplicates ${before.duplicate_rows} → ${after.duplicate_rows}</p><a href="/api/files/${encodeURIComponent(output.file_id)}/download" download>${escapeHTML(output.filename)} · Download</a><p>The cleaned copy is now selected for the next operation. The source dataset remains unchanged.</p>`
    await loadProcessed()
    await loadCleaningDatasets()
    document.getElementById('cleaning-dataset').value = output.file_id
    await loadCleaningDataset(true)
    summary.innerHTML = `<strong>Processed copy created</strong><p>${operations.length} sequential operation${operations.length === 1 ? '' : 's'} · rows ${before.rows} → ${after.rows} · columns ${before.columns} → ${after.columns} · missing ${before.missing_cells} → ${after.missing_cells} · duplicates ${before.duplicate_rows} → ${after.duplicate_rows}</p><a href="/api/files/${encodeURIComponent(output.file_id)}/download" download>${escapeHTML(output.filename)} · Download</a><p>The cleaned copy is now selected for the next operation. The source dataset remains unchanged.</p>`
    showToast('Cleaning sequence applied to a processed copy.')
    window.dispatchEvent(new CustomEvent('app:refresh'))
  } catch (error) {
    summary.textContent = error.message || 'The cleaning operation failed.'
    showToast(error.message || 'The cleaning operation failed.', 'error')
  } finally {
    renderCleaningSequence()
  }
}

export function initOperations() {
  document.getElementById('cleaning-dataset').addEventListener('change', () => loadCleaningDataset(true))
  document.getElementById('cleaning-operation').addEventListener('change', () => {
    activeStepIndex = null
    previewStageIndex = null
    schema = operationInputSchema()
    renderCleaningOptions()
    renderCleaningSequence()
    scheduleCleaningPreview()
  })
  document.getElementById('cleaning-options').addEventListener('input', () => {
    updateFilterValueRequirement()
    if (activeStepIndex !== null) cleaningSteps[activeStepIndex].config = cleaningPayload()
    scheduleCleaningPreview()
  })
  document.getElementById('cleaning-options').addEventListener('change', () => {
    updateFilterValueRequirement()
    if (activeStepIndex !== null) cleaningSteps[activeStepIndex].config = cleaningPayload()
    scheduleCleaningPreview()
  })
  document.getElementById('cleaning-sequence').addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-cleaning-step]')
    if (removeButton) {
      const index = Number(removeButton.dataset.removeCleaningStep)
      cleaningSteps.splice(index, 1)
      if (activeStepIndex === index) {
        activeStepIndex = null
        document.getElementById('cleaning-operation').value = 'inspect'
        renderCleaningOptions()
      } else if (activeStepIndex > index) {
        activeStepIndex -= 1
      }
      previewStageIndex = null
      schema = operationInputSchema()
      renderCleaningSequence()
      scheduleCleaningPreview()
      return
    }
    const stepButton = event.target.closest('[data-cleaning-step]')
    if (stepButton) editCleaningStep(Number(stepButton.dataset.cleaningStep))
  })
  document.getElementById('add-cleaning-step').addEventListener('click', addCleaningStep)
  document.getElementById('apply-cleaning').addEventListener('click', applyCleaning)
  document.getElementById('cleaning-options').addEventListener('submit', (event) => {
    event.preventDefault()
    if (document.getElementById('cleaning-operation').value === 'inspect') applyCleaning()
    else addCleaningStep()
  })
  document.getElementById('reset-cleaning').addEventListener('click', async () => {
    document.getElementById('cleaning-operation').value = 'inspect'
    await loadCleaningDataset(true)
  })
  document.getElementById('cleaning-preview-before').addEventListener('click', () => setPreviewMode('before'))
  document.getElementById('cleaning-preview-after').addEventListener('click', () => setPreviewMode('after'))
  document.getElementById('execution-search').addEventListener('input', () => {
    window.clearTimeout(historyTimer)
    historyTimer = window.setTimeout(loadHistory, 180)
  })
  document.getElementById('execution-status').addEventListener('change', loadHistory)
  document.getElementById('execution-table-body').addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-delete-execution]')
    if (deleteButton) {
      try { await deleteHistory([deleteButton.dataset.deleteExecution], 'single') } catch (error) { showToast(error.message || 'Execution could not be deleted.', 'error') }
      return
    }
    const button = event.target.closest('[data-execution-details]')
    if (!button) return
    try {
      const run = await api(`/api/executions/${encodeURIComponent(button.dataset.executionDetails)}`)
      renderExecutionDetails(run)
    } catch (error) {
      showToast(error.message || 'Could not load execution details.', 'error')
    }
  })
  document.getElementById('processed-table-body').addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-processed]')
    if (!checkbox) return
    if (checkbox.checked) selectedProcessedIds.add(checkbox.dataset.selectProcessed)
    else selectedProcessedIds.delete(checkbox.dataset.selectProcessed)
    updateSelectionControls('processed', Array.from(document.querySelectorAll('[data-select-processed]')).map((input) => ({ file_id: input.dataset.selectProcessed })))
  })
  document.getElementById('processed-table-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-processed]')
    if (button) deleteProcessed([button.dataset.deleteProcessed], 'single').catch((error) => showToast(error.message || 'Dataset could not be deleted.', 'error'))
  })
  document.getElementById('processed-select-all').addEventListener('change', (event) => {
    document.querySelectorAll('[data-select-processed]').forEach((input) => {
      if (event.target.checked) selectedProcessedIds.add(input.dataset.selectProcessed)
      else selectedProcessedIds.delete(input.dataset.selectProcessed)
      input.checked = event.target.checked
    })
    updateSelectionControls('processed', Array.from(document.querySelectorAll('[data-select-processed]')).map((input) => ({ file_id: input.dataset.selectProcessed })))
  })
  document.getElementById('processed-delete-selected').addEventListener('click', () => deleteProcessed([...selectedProcessedIds]).catch((error) => showToast(error.message || 'Selected datasets could not be deleted.', 'error')))
  document.getElementById('processed-clear-all').addEventListener('click', () => deleteProcessed([], 'clear').catch((error) => showToast(error.message || 'Processed datasets could not be cleared.', 'error')))
  document.getElementById('execution-table-body').addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-execution]')
    if (!checkbox) return
    if (checkbox.checked) selectedExecutionIds.add(checkbox.dataset.selectExecution)
    else selectedExecutionIds.delete(checkbox.dataset.selectExecution)
    updateSelectionControls('history', Array.from(document.querySelectorAll('[data-select-execution]:not(:disabled)')).map((input) => ({ execution_id: input.dataset.selectExecution })))
  })
  document.getElementById('history-select-all').addEventListener('change', (event) => {
    document.querySelectorAll('[data-select-execution]:not(:disabled)').forEach((input) => {
      if (event.target.checked) selectedExecutionIds.add(input.dataset.selectExecution)
      else selectedExecutionIds.delete(input.dataset.selectExecution)
      input.checked = event.target.checked
    })
    updateSelectionControls('history', Array.from(document.querySelectorAll('[data-select-execution]:not(:disabled)')).map((input) => ({ execution_id: input.dataset.selectExecution })))
  })
  document.getElementById('history-delete-selected').addEventListener('click', () => deleteHistory([...selectedExecutionIds]).catch((error) => showToast(error.message || 'Selected history could not be deleted.', 'error')))
  document.getElementById('history-clear-all').addEventListener('click', () => deleteHistory([], 'clear').catch((error) => showToast(error.message || 'Execution history could not be cleared.', 'error')))
  window.addEventListener('app:pagechange', async (event) => {
    if (event.detail.page === 'processed') await loadProcessed()
    if (event.detail.page === 'history') await loadHistory()
    if (event.detail.page === 'cleaning') {
      await loadCleaningDatasets()
      await loadCleaningDataset()
    }
  })
  window.addEventListener('app:refresh', async () => {
    const page = document.querySelector('.page-view.active')?.id
    if (page === 'page-processed') await loadProcessed()
    if (page === 'page-history') await loadHistory()
    if (page === 'page-cleaning') {
      const currentSummary = document.getElementById('cleaning-summary').innerHTML
      const currentFileId = document.getElementById('cleaning-dataset').value
      await loadCleaningDatasets()
      if (document.getElementById('cleaning-dataset').value !== currentFileId) await loadCleaningDataset()
      if (selectedFile) document.getElementById('cleaning-summary').innerHTML = currentSummary
    }
  })
  window.addEventListener('app:operations-refresh', async () => {
    await Promise.all([loadProcessed(), loadHistory()])
  })
}
