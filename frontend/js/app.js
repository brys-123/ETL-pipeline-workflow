import { loadDashboard, refreshDashboard } from './dashboard.js'
import { initFiles, loadFiles } from './files.js'
import { initWorkflow, loadWorkflows, newWorkflow } from './workflow.js'
import { initOperations } from './operations.js'
import { initDashboardDesigner } from './dashboard-designer.js'
import { initStorageSettings, loadStorageSettings } from './storage-settings.js'

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const protectedConnectionRequest = path.startsWith('/api/connections')
  let connectionToken = protectedConnectionRequest ? sessionStorage.getItem('simple-etl-connection-token') : null
  if (connectionToken) headers.set('Authorization', `Bearer ${connectionToken}`)
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  let response = await fetch(path, { ...options, headers })
  if (protectedConnectionRequest && response.status === 401) {
    const enteredToken = window.prompt('Enter the connection access token configured for this installation.')
    if (enteredToken) {
      sessionStorage.setItem('simple-etl-connection-token', enteredToken)
      headers.set('Authorization', `Bearer ${enteredToken}`)
      response = await fetch(path, { ...options, headers })
      if (response.status === 401) sessionStorage.removeItem('simple-etl-connection-token')
    }
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`)
    error.payload = payload
    throw error
  }
  return payload
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

export function showToast(message, type = 'success') {
  const stack = document.getElementById('toast-stack')
  const toast = document.createElement('div')
  toast.className = `studio-toast ${type}`
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status')
  toast.textContent = message
  stack.append(toast)
  window.setTimeout(() => toast.remove(), 3900)
}

export function confirmPermanentDelete(itemType, count, dependencies = null) {
  const dialog = document.getElementById('delete-confirm-dialog')
  const dependencyPanel = document.getElementById('delete-confirm-dependencies')
  const dependencyList = document.getElementById('delete-confirm-dependency-list')
  const noun = count === 1
    ? itemType.replace(/s$/, '')
    : itemType.endsWith('y') ? `${itemType.slice(0, -1)}ies` : `${itemType}s`
  document.getElementById('delete-confirm-summary').textContent = `Permanently delete ${count} ${noun}? This action cannot be undone.`
  dependencyList.replaceChildren()
  const labels = new Set()
  for (const reference of Object.values(dependencies || {})) {
    for (const workflow of reference.workflows || []) labels.add(`Workflow: ${workflow.name}`)
    for (const dashboard of reference.dashboards || []) labels.add(`Dashboard: ${dashboard.name}`)
  }
  for (const label of labels) {
    const item = document.createElement('li')
    item.textContent = label
    dependencyList.append(item)
  }
  dependencyPanel.hidden = labels.size === 0
  return new Promise((resolve) => {
    const confirmButton = document.getElementById('delete-confirm-accept')
    const cancelButton = document.getElementById('delete-confirm-cancel')
    const confirm = () => dialog.close('delete')
    const cancel = () => dialog.close('cancel')
    const handleCancel = (event) => {
      event.preventDefault()
      dialog.close('cancel')
    }
    const finish = () => {
      confirmButton.removeEventListener('click', confirm)
      cancelButton.removeEventListener('click', cancel)
      dialog.removeEventListener('cancel', handleCancel)
      resolve(dialog.returnValue === 'delete')
    }
    dialog.addEventListener('close', finish, { once: true })
    confirmButton.addEventListener('click', confirm)
    cancelButton.addEventListener('click', cancel)
    dialog.addEventListener('cancel', handleCancel)
    dialog.showModal()
  })
}

export async function deleteWithConfirmation({ url, options, itemType, count, confirmedUrl = url, confirmedOptions = options }) {
  if (!await confirmPermanentDelete(itemType, count)) return null
  try {
    return await api(url, options)
  } catch (error) {
    if (!error.payload?.dependencies) throw error
    if (!await confirmPermanentDelete(itemType, count, error.payload.dependencies)) return null
    return api(confirmedUrl, confirmedOptions)
  }
}

export function switchPage(page) {
  const target = document.getElementById(`page-${page}`)
  if (!target) return
  document.querySelectorAll('.page-view').forEach((view) => {
    const active = view === target
    view.classList.toggle('active', active)
    view.hidden = !active
  })
  document.querySelectorAll('.nav-link[data-page]').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === page)
  })
  const currentLabel = document.querySelector(`.nav-link[data-page="${page}"] span:not(.nav-counter)`)?.textContent
  document.getElementById('breadcrumb-current').textContent = currentLabel || (page === 'dashboard' ? 'Dashboard' : page)
  document.getElementById('sidebar').classList.remove('mobile-open')
  window.dispatchEvent(new CustomEvent('app:pagechange', { detail: { page } }))
  if (page === 'settings') {
    loadStorageSettings().catch((error) => showToast(error.message || 'Could not load storage settings.', 'error'))
  }
}

function filterVisibleRows(value) {
  const query = value.trim().toLowerCase()
  document.querySelectorAll('[data-searchable]').forEach((row) => {
    row.hidden = query.length > 0 && !row.dataset.searchable.toLowerCase().includes(query)
  })
}

function initializeShell() {
  document.addEventListener('click', (event) => {
    const pageButton = event.target.closest('[data-page]')
    if (pageButton) switchPage(pageButton.dataset.page)

    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'new-workflow') {
      switchPage('workflow')
      newWorkflow()
    }
    if (action === 'upload') {
      switchPage('files')
      window.dispatchEvent(new CustomEvent('app:upload'))
    }
  })

  document.getElementById('global-search').addEventListener('input', (event) => {
    filterVisibleRows(event.target.value)
    window.dispatchEvent(new CustomEvent('app:search', { detail: { query: event.target.value } }))
  })
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      document.getElementById('global-search').focus()
    }
  })
  document.getElementById('notification-button').addEventListener('click', () => showToast('You are all caught up.'))
  document.getElementById('profile-button').addEventListener('click', () => switchPage('settings'))
  document.getElementById('mobile-menu').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open')
  })
  window.addEventListener('app:refresh', async () => {
    await Promise.all([loadDashboard(), loadFiles(), loadWorkflows()])
  })
}

function loadVendorScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = source
    script.onload = resolve
    script.onerror = () => reject(new Error(`Could not load visualization library: ${source}`))
    document.head.append(script)
  })
}

initializeShell()
initFiles()
initWorkflow()
initOperations()
initStorageSettings()
Promise.all([loadVendorScript('/vendor/echarts.js'), loadVendorScript('/vendor/html-to-image.js')])
  .then(() => initDashboardDesigner())
  .catch((error) => {
    showToast(error.message || 'Dashboard visualization libraries could not be loaded.', 'error')
    initDashboardDesigner()
  })
loadDashboard()
switchPage('dashboard')
loadFiles()