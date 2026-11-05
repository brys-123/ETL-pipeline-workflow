import { api, escapeHTML, showToast } from './app.js'

let uploadedFiles = []
let selectedFile = null
let schema = []
let previewTimer

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
    document.getElementById('processed-count').textContent = String(processed.length)
    document.getElementById('processed-table-body').innerHTML = processed.length
      ? processed.map((file) => `<tr><td>${escapeHTML(file.filename)}</td><td>${escapeHTML(file.file_type.toUpperCase())}</td><td>${formatSize(file.file_size)}</td><td>${Number.isInteger(file.row_count) ? file.row_count : '—'}</td><td>${escapeHTML(formatDate(file.uploaded_at))}</td><td><a class="button-secondary button-sm" href="/api/files/${encodeURIComponent(file.file_id)}/download" download><i class="bi bi-download"></i> Download</a></td></tr>`).join('')
      : '<tr><td class="table-empty" colspan="6">No processed datasets yet.</td></tr>'
  } catch (error) {
    showToast(error.message || 'Could not load processed datasets.', 'error')
  }
}

async function loadHistory() {
  try {
    const params = new URLSearchParams()
    const query = document.getElementById('execution-search').value.trim()
    const status = document.getElementById('execution-status').value
    if (query) params.set('q', query)
    if (status) params.set('status', status)
    const runs = await api(`/api/executions${params.size ? `?${params}` : ''}`)
    const body = document.getElementById('execution-table-body')
    body.innerHTML = runs.length
      ? runs.map((run) => {
        const duration = run.summary?.duration_seconds
        return `<tr><td>${escapeHTML(run.workflow_name)}</td><td><span class="file-status ${escapeHTML(run.status)}">${escapeHTML(run.status)}</span></td><td>${escapeHTML(formatDate(run.started_at))}</td><td>${Number.isFinite(duration) ? `${duration}s` : '—'}</td><td><button class="table-action" data-execution-details="${escapeHTML(run.execution_id)}" aria-label="View ${escapeHTML(run.workflow_name)} execution details"><i class="bi bi-arrow-up-right"></i></button></td></tr>`
      }).join('')
      : '<tr><td class="table-empty" colspan="5">No workflow executions match this view.</td></tr>'
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
    uploadedFiles = await api('/api/files?status=uploaded')
    const select = document.getElementById('cleaning-dataset')
    const selected = select.value
    select.innerHTML = `<option value="">Choose an uploaded dataset</option>${uploadedFiles.map((file) => `<option value="${escapeHTML(file.file_id)}">${escapeHTML(file.filename)}</option>`).join('')}`
    if (uploadedFiles.some((file) => file.file_id === selected)) select.value = selected
  } catch (error) {
    showToast(error.message || 'Could not load datasets for cleaning.', 'error')
  }
}

function columnChoices(multiple = false, allowEmpty = false, name = 'columns') {
  const options = schema.map((column) => `<option value="${escapeHTML(column.name)}">${escapeHTML(column.name)} · ${escapeHTML(column.dtype)}</option>`).join('')
  const emptyOption = multiple && allowEmpty ? '<option value="" selected>No specific columns</option>' : ''
  return `<select name="${escapeHTML(name)}"${multiple ? ' multiple size="4"' : ''}>${emptyOption}${options}</select>`
}

function renderCleaningOptions() {
  const operation = document.getElementById('cleaning-operation').value
  const target = document.getElementById('cleaning-options')
  const singleColumn = `<label class="config-field"><span>Column</span>${columnChoices(false, false, 'column')}</label>`
  const multiColumn = `<label class="config-field"><span>Columns</span>${columnChoices(true)}</label>`
  const numberOfColumns = schema.length
  if (!numberOfColumns || operation === 'inspect') {
    target.innerHTML = operation === 'inspect' ? '<p>Select a dataset to inspect its current data quality.</p>' : ''
    return
  }
  if (['remove_missing_rows', 'remove_missing_columns'].includes(operation)) {
    target.innerHTML = '<p>This operation applies to the whole dataset.</p>'
  } else if (operation === 'fill_missing') {
    target.innerHTML = `${multiColumn}<label class="config-field"><span>Fill method</span><select name="method"><option value="constant">Constant value</option><option value="mean">Mean (numeric)</option><option value="median">Median (numeric)</option><option value="mode">Most common value</option></select></label><label class="config-field"><span>Constant value</span><input name="value" value="" /></label>`
  } else if (operation === 'remove_duplicates') {
    target.innerHTML = `<label class="config-field"><span>Columns (optional)</span>${columnChoices(true, true)}</label><p>Leave columns unselected to compare complete rows.</p>`
  } else if (['trim_text', 'uppercase', 'lowercase', 'titlecase', 'remove_unwanted_characters', 'inspect_outliers', 'remove_outliers'].includes(operation)) {
    target.innerHTML = singleColumn
  } else if (operation === 'replace_text') {
    target.innerHTML = `${singleColumn}<label class="config-field"><span>Find</span><input name="find" required /></label><label class="config-field"><span>Replace with</span><input name="replace" /></label>`
  } else if (operation === 'convert_type') {
    target.innerHTML = `${singleColumn}<label class="config-field"><span>Convert to</span><select name="target_type"><option value="integer">Integer</option><option value="float">Number</option><option value="string">Text</option><option value="datetime">Date/time</option></select></label>`
  } else if (operation === 'remove_columns' || operation === 'select_columns' || operation === 'reorder_columns') {
    target.innerHTML = multiColumn
  } else if (operation === 'rename_column') {
    target.innerHTML = `<label class="config-field"><span>Current column</span>${columnChoices(false, false, 'from')}</label><label class="config-field"><span>New name</span><input name="to" required /></label>`
  }
}

function renderCleaningPreview(preview, inspection) {
  const metrics = document.getElementById('cleaning-metrics')
  const caption = document.getElementById('cleaning-preview-caption')
  const table = document.getElementById('cleaning-preview-table')
  caption.textContent = `${preview.filename} · ${inspection.rows} rows · ${inspection.columns} columns`
  metrics.innerHTML = [
    ['Rows', inspection.rows],
    ['Columns', inspection.columns],
    ['Missing cells', inspection.missing_cells],
    ['Duplicate rows', inspection.duplicate_rows],
  ].map(([label, value]) => `<article><small>${escapeHTML(label)}</small><strong>${Number(value).toLocaleString()}</strong></article>`).join('')
  const header = preview.columns.map((name) => `<th>${escapeHTML(name)}</th>`).join('')
  const rows = preview.rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHTML(value ?? '')}</td>`).join('')}</tr>`).join('')
  table.innerHTML = `<table class="studio-table"><thead><tr>${header}</tr></thead><tbody>${rows || `<tr><td class="table-empty" colspan="${preview.columns.length || 1}">No preview rows.</td></tr>`}</tbody></table>`
}

async function loadCleaningDataset() {
  const fileId = document.getElementById('cleaning-dataset').value
  selectedFile = uploadedFiles.find((file) => file.file_id === fileId) || null
  document.getElementById('cleaning-summary').textContent = ''
  if (!selectedFile) {
    schema = []
    renderCleaningOptions()
    document.getElementById('cleaning-metrics').innerHTML = ''
    document.getElementById('cleaning-preview-table').innerHTML = ''
    document.getElementById('cleaning-preview-caption').textContent = 'Choose a dataset to inspect a sample.'
    return
  }
  try {
    const [preview, inspection] = await Promise.all([
      api(`/api/files/${encodeURIComponent(fileId)}/preview?page_size=10`),
      api(`/api/files/${encodeURIComponent(fileId)}/summary`),
    ])
    schema = inspection.schema
    renderCleaningOptions()
    renderCleaningPreview(preview, inspection)
  } catch (error) {
    showToast(error.message || 'Could not inspect this dataset.', 'error')
  }
}

function cleaningPayload() {
  const operation = document.getElementById('cleaning-operation').value
  if (operation === 'inspect') return { operation: 'inspect_outliers' }
  const form = document.getElementById('cleaning-options')
  const payload = Object.fromEntries(new FormData(form).entries())
  const multiple = form.querySelector('select[multiple]')
  if (multiple) payload.columns = Array.from(multiple.selectedOptions, (option) => option.value).filter(Boolean)
  if (['remove_missing_rows', 'remove_missing_columns', 'remove_duplicates'].includes(operation) && operation !== 'remove_duplicates') {
    return { operation }
  }
  if (operation === 'remove_duplicates' && (!payload.columns || !payload.columns.length)) delete payload.columns
  return { ...payload, operation }
}

async function applyCleaning() {
  if (!selectedFile) {
    showToast('Choose an uploaded dataset first.', 'error')
    return
  }
  const button = document.getElementById('apply-cleaning')
  const summary = document.getElementById('cleaning-summary')
  const form = document.getElementById('cleaning-options')
  const operation = document.getElementById('cleaning-operation').value
  if (operation !== 'inspect' && !form.reportValidity()) return
  button.disabled = true
  summary.textContent = 'Processing dataset…'
  try {
    if (operation === 'inspect') {
      const inspection = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/summary`)
      summary.innerHTML = `<strong>Dataset quality</strong><p>${inspection.rows.toLocaleString()} rows · ${inspection.columns} columns · ${inspection.missing_cells.toLocaleString()} missing cells · ${inspection.duplicate_rows.toLocaleString()} duplicate rows</p><p>Numeric: ${escapeHTML(inspection.numeric_columns.join(', ') || 'none')} · Text: ${escapeHTML(inspection.text_columns.join(', ') || 'none')} · Dates: ${escapeHTML(inspection.date_columns.join(', ') || 'none')}</p>`
      return
    }
    const response = await api(`/api/files/${encodeURIComponent(selectedFile.file_id)}/clean`, {
      method: 'POST',
      body: JSON.stringify(cleaningPayload()),
    })
    if (response.inspection) {
      summary.innerHTML = `<strong>Outlier inspection</strong><p>${response.inspection.affected_records} values outside ${response.inspection.lower_bound}–${response.inspection.upper_bound}. No data was changed.</p>`
      return
    }
    const { before, after } = response.summary
    summary.innerHTML = `<strong>Processed copy created</strong><p>${response.summary.affected_records} affected · rows ${before.rows} → ${after.rows} · columns ${before.columns} → ${after.columns} · missing ${before.missing_cells} → ${after.missing_cells} · duplicates ${before.duplicate_rows} → ${after.duplicate_rows}</p><a href="/api/files/${encodeURIComponent(response.dataset.file_id)}/download" download>${escapeHTML(response.dataset.filename)} · Download</a>`
    showToast('Cleaning operation completed. The original dataset is unchanged.')
    await loadProcessed()
    window.dispatchEvent(new CustomEvent('app:refresh'))
  } catch (error) {
    summary.textContent = ''
    showToast(error.message || 'The cleaning operation failed.', 'error')
  } finally {
    button.disabled = false
  }
}

export function initOperations() {
  document.getElementById('cleaning-dataset').addEventListener('change', loadCleaningDataset)
  document.getElementById('cleaning-operation').addEventListener('change', renderCleaningOptions)
  document.getElementById('apply-cleaning').addEventListener('click', applyCleaning)
  document.getElementById('cleaning-options').addEventListener('submit', (event) => {
    event.preventDefault()
    applyCleaning()
  })
  document.getElementById('reset-cleaning').addEventListener('click', async () => {
    document.getElementById('cleaning-operation').value = 'inspect'
    await loadCleaningDataset()
  })
  document.getElementById('execution-search').addEventListener('input', () => {
    window.clearTimeout(previewTimer)
    previewTimer = window.setTimeout(loadHistory, 180)
  })
  document.getElementById('execution-status').addEventListener('change', loadHistory)
  document.getElementById('execution-table-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-execution-details]')
    if (!button) return
    try {
      const run = await api(`/api/executions/${encodeURIComponent(button.dataset.executionDetails)}`)
      renderExecutionDetails(run)
    } catch (error) {
      showToast(error.message || 'Could not load execution details.', 'error')
    }
  })
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
      await loadCleaningDatasets()
      await loadCleaningDataset()
      if (selectedFile) document.getElementById('cleaning-summary').innerHTML = currentSummary
    }
  })
  window.addEventListener('app:operations-refresh', async () => {
    await Promise.all([loadProcessed(), loadHistory()])
  })
}
