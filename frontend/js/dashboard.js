import { api, escapeHTML, showToast } from './app.js'

const numberFormat = new Intl.NumberFormat()

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
  if (!workflows.length) {
    body.innerHTML = '<tr><td class="table-empty" colspan="4">No workflows saved. Create a workflow to get started.</td></tr>'
    return
  }
  body.innerHTML = workflows.slice(0, 5).map((workflow) => `<tr data-searchable="${escapeHTML(workflow.name)}"><td><span class="workflow-table-name"><span class="workflow-row-icon"><i class="bi bi-bezier2"></i></span><span class="workflow-name-copy"><strong>${escapeHTML(workflow.name)}</strong><small>Saved workflow design</small></span></span></td><td>${numberFormat.format(workflow.nodes.length)} nodes</td><td>${escapeHTML(formatRelativeDate(workflow.updated_at))}</td><td><button class="table-action" data-open-workflow="${escapeHTML(workflow.workflow_id)}" title="Open ${escapeHTML(workflow.name)}" aria-label="Open ${escapeHTML(workflow.name)}"><i class="bi bi-arrow-up-right"></i></button></td></tr>`).join('')
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