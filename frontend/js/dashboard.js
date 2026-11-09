import { api, confirmPermanentDelete, escapeHTML, showToast } from './app.js'

const numberFormat = new Intl.NumberFormat()
const selectedWorkflows = new Set()
let savedWorkflows = []

function formatRelativeDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function renderActivity(items) {
  const target = document.getElementById('recent-activity')
  if (!items.length) {
    target.innerHTML = '<div class="empty-inline"><span class="empty-mark"><i class="bi bi-inboxes"></i></span><strong>No activity yet</strong><p>Upload a dataset or save a workflow to see it here.</p></div>'
    return
  }
  target.innerHTML = items.map((item) => {
    const isWorkflow = item.type === 'workflow'
    return `<article class="activity-row" data-searchable="${escapeHTML(`${item.name} ${item.label}`)}"><span class="activity-icon ${isWorkflow ? 'workflow' : ''}"><i class="bi ${isWorkflow ? 'bi-bezier2' : 'bi-file-earmark-arrow-up'}"></i></span><span class="activity-copy"><strong>${escapeHTML(item.label)} · ${escapeHTML(item.name)}</strong><small>${isWorkflow ? 'Saved workflow design' : 'Stored in My Files'}</small></span><time class="activity-time" datetime="${escapeHTML(item.timestamp)}">${escapeHTML(formatRelativeDate(item.timestamp))}</time></article>`
  }).join('')
}

function renderWorkflows(workflows) {
  const body = document.getElementById('recent-workflows-body')
  savedWorkflows = workflows
  for (const id of selectedWorkflows) {
    if (!workflows.some((workflow) => workflow.workflow_id === id)) selectedWorkflows.delete(id)
  }
  if (!workflows.length) {
    body.innerHTML = '<tr><td class="table-empty" colspan="5">No workflows saved. Create a workflow to get started.</td></tr>'
    updateWorkflowSelection()
    return
  }
  body.innerHTML = workflows.map((workflow) => `<tr data-searchable="${escapeHTML(workflow.name)}"><td><input type="checkbox" data-select-workflow="${escapeHTML(workflow.workflow_id)}" aria-label="Select ${escapeHTML(workflow.name)}" ${selectedWorkflows.has(workflow.workflow_id) ? 'checked' : ''} /></td><td><span class="workflow-table-name"><span class="workflow-row-icon"><i class="bi bi-bezier2"></i></span><span class="workflow-name-copy"><strong>${escapeHTML(workflow.name)}</strong><small>Saved workflow design</small></span></span></td><td>${numberFormat.format(workflow.nodes.length)} nodes</td><td>${escapeHTML(formatRelativeDate(workflow.updated_at))}</td><td><span class="workflow-row-actions"><button class="table-action" data-open-workflow="${escapeHTML(workflow.workflow_id)}" title="Open ${escapeHTML(workflow.name)}" aria-label="Open ${escapeHTML(workflow.name)}"><i class="bi bi-arrow-up-right"></i></button><button class="table-action danger-action" data-delete-workflow="${escapeHTML(workflow.workflow_id)}" title="Delete ${escapeHTML(workflow.name)}" aria-label="Delete ${escapeHTML(workflow.name)}"><i class="bi bi-trash3"></i></button></span></td></tr>`).join('')
  updateWorkflowSelection()
}

function updateWorkflowSelection() {
  const selectedCount = selectedWorkflows.size
  const count = document.getElementById('workflow-selected-count')
  const deleteSelected = document.getElementById('workflow-delete-selected')
  const selectAll = document.getElementById('workflow-select-all')
  if (!count || !deleteSelected || !selectAll) return
  count.textContent = `${selectedCount} selected`
  deleteSelected.disabled = selectedCount === 0
  selectAll.checked = savedWorkflows.length > 0 && selectedCount === savedWorkflows.length
  selectAll.indeterminate = selectedCount > 0 && selectedCount < savedWorkflows.length
}

async function deleteWorkflows(ids) {
  const uniqueIds = [...new Set(ids)]
  if (!uniqueIds.length) return
  const params = new URLSearchParams()
  uniqueIds.forEach((id) => params.append('workflow_id', id))
  const { references } = await api(`/api/workflows/references?${params}`)
  const executionCount = Object.values(references).reduce((total, item) => total + item.executions, 0)
  const runningCount = Object.values(references).reduce((total, item) => total + item.running_executions, 0)
  const datasetCount = Object.values(references).reduce((total, item) => total + item.processed_datasets, 0)
  const selectedOpenWorkflow = document.documentElement.dataset.openWorkflowId
  const note = `${executionCount} execution record(s) and ${datasetCount} processed dataset(s) are referenced and will be preserved.${runningCount ? ` ${runningCount} workflow execution(s) are still running and cannot be deleted.` : ''}${uniqueIds.includes(selectedOpenWorkflow) ? ' The workflow builder will close the deleted workflow after confirmation.' : ''}`
  if (runningCount) {
    showToast('Wait for running workflow executions to finish before deleting their definitions.', 'error')
    return
  }
  if (!await confirmPermanentDelete('workflows', uniqueIds.length, null, note)) return
  const response = uniqueIds.length === 1
    ? await api(`/api/workflows/${encodeURIComponent(uniqueIds[0])}`, { method: 'DELETE' })
    : await api('/api/workflows/delete-selected', {
        method: 'POST',
        body: JSON.stringify({ workflow_ids: uniqueIds }),
      })
  const deletedIds = Array.isArray(response.deleted)
    ? response.deleted.map((item) => item.workflow_id)
    : response.deleted ? [response.workflow_id] : []
  for (const id of deletedIds) selectedWorkflows.delete(id)
  if (deletedIds.length) {
    showToast(`${deletedIds.length} workflow definition(s) deleted. Execution history and datasets were kept.`)
    window.dispatchEvent(new CustomEvent('app:workflows-deleted', { detail: { workflowIds: deletedIds } }))
    window.dispatchEvent(new CustomEvent('app:refresh'))
  }
  if (response.failed?.length) {
    showToast(`${response.failed.length} workflow(s) could not be deleted.`, 'error')
  }
}

export async function loadDashboard() {
  try {
    const [stats, workflows] = await Promise.all([api('/api/dashboard/stats'), api('/api/workflows')])
    document.getElementById('stat-files').textContent = numberFormat.format(stats.total_uploaded_files)
    document.getElementById('stat-processed').textContent = numberFormat.format(stats.processed_datasets)
    document.getElementById('stat-workflows').textContent = numberFormat.format(stats.saved_workflows)
    document.getElementById('stat-executions').textContent = numberFormat.format(stats.completed_executions)
    document.getElementById('nav-file-count').textContent = numberFormat.format(stats.total_uploaded_files)
    renderActivity(stats.recent_activity)
    renderWorkflows(workflows)
  } catch (error) {
    showToast(error.message || 'Could not load dashboard data.', 'error')
  }
}

export function refreshDashboard() {
  return loadDashboard()
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-workflow]')
  if (!button) return
  window.dispatchEvent(new CustomEvent('app:open-workflow', { detail: { workflowId: button.dataset.openWorkflow } }))
})

document.getElementById('recent-workflows-body').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-select-workflow]')
  if (!checkbox) return
  if (checkbox.checked) selectedWorkflows.add(checkbox.dataset.selectWorkflow)
  else selectedWorkflows.delete(checkbox.dataset.selectWorkflow)
  updateWorkflowSelection()
})
document.getElementById('workflow-select-all').addEventListener('change', (event) => {
  selectedWorkflows.clear()
  if (event.target.checked) savedWorkflows.forEach((workflow) => selectedWorkflows.add(workflow.workflow_id))
  renderWorkflows(savedWorkflows)
})
document.getElementById('workflow-delete-selected').addEventListener('click', () => {
  deleteWorkflows([...selectedWorkflows]).catch((error) => showToast(error.message || 'Selected workflows could not be deleted.', 'error'))
})
document.getElementById('workflow-clear-all').addEventListener('click', () => {
  deleteWorkflows(savedWorkflows.map((workflow) => workflow.workflow_id))
    .catch((error) => showToast(error.message || 'Workflows could not be deleted.', 'error'))
})
document.getElementById('recent-workflows-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-workflow]')
  if (button) deleteWorkflows([button.dataset.deleteWorkflow])
    .catch((error) => showToast(error.message || 'Workflow could not be deleted.', 'error'))
})