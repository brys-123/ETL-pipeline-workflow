import { loadDashboard, refreshDashboard } from './dashboard.js'
import { initFiles, loadFiles } from './files.js'
import { initWorkflow, loadWorkflows, newWorkflow } from './workflow.js'
import { initOperations } from './operations.js'

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, { ...options, headers })
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
  if (page === 'settings') loadSettings()
}

async function loadSettings() {
  try {
    const health = await api('/api/health')
    document.getElementById('setting-storage-mode').textContent = health.storage_mode === 'server' ? 'Server' : 'Local'
    document.getElementById('setting-storage-available').textContent = health.storage_available ? 'Available' : 'Unavailable'
    document.getElementById('setting-upload-limit').textContent = `${health.max_upload_size_mb} MB`
    document.getElementById('upload-limit').textContent = String(health.max_upload_size_mb)
  } catch (error) {
    showToast(error.message || 'Could not load storage settings.', 'error')
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

initializeShell()
initFiles()
initWorkflow()
initOperations()
loadDashboard()
switchPage('dashboard')
loadFiles()