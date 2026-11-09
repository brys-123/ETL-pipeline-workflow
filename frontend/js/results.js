import { api, escapeHTML, showToast } from './app.js'

let executions = []

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export async function loadProcessed() {
  const body = document.getElementById('processed-table-body')
  if (!body) return
  try {
    const files = await api('/api/files?status=processed')
    body.innerHTML = files.length ? files.map((file) => `<tr><td><strong>${escapeHTML(file.filename)}</strong></td><td>${escapeHTML(file.file_type.toUpperCase())}</td><td>${Number(file.file_size).toLocaleString()} B</td><td>${escapeHTML(formatDate(file.uploaded_at))}</td><td>${file.workflow_id ? 'Workflow run' : 'Cleaning operation'}</td><td><a class="table-action" href="/api/files/${encodeURIComponent(file.file_id)}/download" title="Download ${escapeHTML(file.filename)}" aria-label="Download ${escapeHTML(file.filename)}"><i class="bi bi-download"></i></a></td></tr>`).join('') : '<tr><td class="table-empty" colspan="6">No processed datasets yet. Clean a dataset or run a workflow to create one.</td></tr>'
  } catch (error) {
    showToast(error.message || 'Could not load processed datasets.', 'error')
  }
}

function renderExecutions() {
  const query = document.getElementById('history-search').value.trim().toLowerCase()
  const status = document.getElementById('history-status').value
  const rows = executions.filter((item) => (!status || item.status === status) && String(item.workflow_name || '').toLowerCase().includes(query))
  const body = document.getElementById('history-table-body')
  body.innerHTML = rows.length ? rows.map((item) => {
    const outputs = (item.output_file_ids || []).map((id) => `<a href="/api/files/${encodeURIComponent(id)}/download" aria-label="Download output"><i class="bi bi-download"></i></a>`).join(' ')
    const summary = item.summary || {}
    const details = item.status === 'failed' ? item.error_message || 'Execution failed.' : `${Number(summary.final_rows || 0).toLocaleString()} rows × ${Number(summary.final_columns || 0).toLocaleString()} columns`
    return `<tr><td><strong>${escapeHTML(item.workflow_name)}</strong><small class="history-id">${escapeHTML(item.execution_id)}</small></td><td><span class="file-status ${escapeHTML(item.status)}">${escapeHTML(item.status)}</span></td><td>${escapeHTML(formatDate(item.started_at))}</td><td>${item.summary?.duration_ms === undefined ? '—' : `${Number(item.summary.duration_ms).toLocaleString()} ms`}</td><td>${outputs || '—'}</td><td>${escapeHTML(details)}</td></tr>`
  }).join('') : `<tr><td class="table-empty" colspan="6">${executions.length ? 'No executions match your filters.' : 'No executions recorded yet.'}</td></tr>`
}

export async function loadExecutions() {
  try {
    executions = await api('/api/executions')
    renderExecutions()
  } catch (error) {
    showToast(error.message || 'Could not load execution history.', 'error')
  }
}

export function initResults() {
  document.getElementById('history-search').addEventListener('input', renderExecutions)
  document.getElementById('history-status').addEventListener('change', renderExecutions)
  window.addEventListener('app:pagechange', (event) => {
    if (event.detail.page === 'processed') loadProcessed()
    if (event.detail.page === 'history') loadExecutions()
  })
  window.addEventListener('app:refresh', loadProcessed)
  window.addEventListener('app:executions-refresh', loadExecutions)
}
