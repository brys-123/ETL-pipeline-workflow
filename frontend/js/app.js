import { loadDashboard } from './dashboard.js'
import { initFiles, loadFiles } from './files.js'
import { initWorkflow, loadWorkflows, newWorkflow } from './workflow.js'
import { initOperations } from './operations.js'
import { initDashboardDesigner } from './dashboard-designer.js'
import { initStorageSettings, loadStorageSettings } from './storage-settings.js'
import { initAppearanceSettings } from './appearance-settings.js'

function csrfToken() {
  const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith('simple_etl_csrf='))
  return entry ? decodeURIComponent(entry.slice('simple_etl_csrf='.length)) : ''
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) {
    headers.set('X-CSRF-Token', csrfToken())
  }
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.replace('/login')
    }
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

export function confirmPermanentDelete(itemType, count, dependencies = null, note = '') {
  const dialog = document.getElementById('delete-confirm-dialog')
  const dependencyPanel = document.getElementById('delete-confirm-dependencies')
  const dependencyList = document.getElementById('delete-confirm-dependency-list')
  const noun = count === 1
    ? itemType.replace(/s$/, '')
    : itemType.endsWith('y') ? `${itemType.slice(0, -1)}ies` : `${itemType}s`
  document.getElementById('delete-confirm-summary').textContent = [
    `Permanently delete ${count} ${noun}? This action cannot be undone.`,
    note,
  ].filter(Boolean).join(' ')
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
  if (page === 'settings') loadStorageSettings()
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
  const openAccount = async () => {
    const dialog = document.getElementById('account-dialog')
    dialog.showModal()
    try {
      const { user } = await api('/api/auth/me')
      renderAccount(user)
    } catch (error) {
      showToast(error.message || 'Account details could not be loaded.', 'error')
    }
  }
  document.getElementById('profile-button').addEventListener('click', openAccount)
  document.getElementById('sidebar-profile-button').addEventListener('click', openAccount)
  document.getElementById('account-close').addEventListener('click', () => document.getElementById('account-dialog').close())
  document.getElementById('account-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      const { user } = await api('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          full_name: document.getElementById('account-name').value.trim(),
          username: document.getElementById('account-username').value,
          email: document.getElementById('account-email').value.trim(),
        }),
      })
      renderAccount(user)
      showToast('Profile updated.')
    } catch (error) {
      showToast(error.message || 'Profile could not be updated.', 'error')
    }
  })
  document.getElementById('account-password-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: document.getElementById('account-current-password').value,
          password: document.getElementById('account-new-password').value,
          confirm_password: document.getElementById('account-confirm-password').value,
        }),
      })
      event.target.reset()
      showToast('Password changed. Other active sessions were signed out.')
    } catch (error) {
      showToast(error.message || 'Password could not be changed.', 'error')
    }
  })
  document.getElementById('account-picture-save').addEventListener('click', async () => {
    const input = document.getElementById('account-picture-input')
    if (!input.files?.[0]) {
      showToast('Choose a PNG, JPEG, or WebP profile picture.', 'error')
      return
    }
    const body = new FormData()
    body.append('picture', input.files[0])
    try {
      const { user } = await api('/api/auth/profile-picture', { method: 'POST', body })
      renderAccount(user)
      input.value = ''
      showToast('Profile picture updated.')
    } catch (error) {
      showToast(error.message || 'Profile picture could not be updated.', 'error')
    }
  })
  document.getElementById('account-logout').addEventListener('click', async () => {
    if (!window.confirm('Log out of Simple ETL Studio?')) return
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' })
      window.location.replace('/login')
    } catch (error) {
      showToast(error.message || 'Logout could not be completed.', 'error')
    }
  })
  document.getElementById('mobile-menu').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open')
  })
  window.addEventListener('app:refresh', async () => {
    await Promise.all([loadDashboard(), loadFiles(), loadWorkflows()])
  })
}

function renderAccount(user) {
  const initials = (user.full_name || user.username || 'U').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  const picture = /^\/api\/auth\/profile-picture\/(png|jpg|webp)$/.test(user.profile_picture || '')
    ? user.profile_picture
    : null
  for (const element of [
    document.getElementById('account-avatar'),
    document.getElementById('sidebar-profile-avatar'),
    document.getElementById('top-profile-avatar'),
  ]) {
    element.replaceChildren()
    if (picture) {
      const image = document.createElement('img')
      image.src = picture
      image.alt = ''
      element.append(image)
    } else element.textContent = initials
  }
  document.getElementById('account-full-name').textContent = user.full_name
  document.getElementById('account-role').textContent = user.role === 'admin' ? 'Administrator' : 'Standard user'
  document.getElementById('account-name').value = user.full_name
  document.getElementById('account-username').value = user.username
  document.getElementById('account-email').value = user.email
  document.getElementById('account-meta').textContent = `Account created ${new Date(user.created_at).toLocaleDateString()} · Last login ${user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Not available'}`
  document.getElementById('sidebar-profile-name').textContent = user.full_name
  document.getElementById('sidebar-profile-role').textContent = user.role === 'admin' ? 'Administrator' : `@${user.username}`
  const adminPanel = document.getElementById('admin-panel')
  adminPanel.hidden = user.role !== 'admin'
  if (!adminPanel.hidden) loadAdminPanel()
}

async function loadAdminPanel() {
  try {
    const [{ users }, { activity }, { sessions }] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/activity?limit=50'),
      api('/api/admin/sessions?limit=50'),
    ])
    const userRoot = document.getElementById('admin-users')
    userRoot.replaceChildren()
    const table = document.createElement('table')
    table.className = 'admin-table'
    const header = document.createElement('tr')
    for (const label of ['Account', 'Role', 'Status', '']) {
      const cell = document.createElement('th')
      cell.textContent = label
      header.append(cell)
    }
    const head = document.createElement('thead')
    head.append(header)
    const body = document.createElement('tbody')
    for (const user of users) {
      const row = document.createElement('tr')
      const identity = document.createElement('td')
      identity.textContent = `${user.full_name} (@${user.username}) · ${user.email}`
      row.append(identity)
      const role = document.createElement('select')
      for (const value of ['user', 'admin']) role.add(new Option(value === 'admin' ? 'Administrator' : 'Standard user', value))
      role.value = user.role
      const roleCell = document.createElement('td')
      roleCell.append(role)
      row.append(roleCell)
      const status = document.createElement('select')
      for (const value of ['active', 'disabled']) status.add(new Option(value === 'active' ? 'Active' : 'Disabled', value))
      status.value = user.status
      const statusCell = document.createElement('td')
      statusCell.append(status)
      row.append(statusCell)
      const actionCell = document.createElement('td')
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'button-secondary button-sm'
      save.textContent = 'Save'
      save.addEventListener('click', async () => {
        save.disabled = true
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ role: role.value, status: status.value }),
          })
          showToast(`Updated ${user.username}.`)
          await loadAdminPanel()
        } catch (error) {
          showToast(error.message || 'Account could not be updated.', 'error')
          save.disabled = false
        }
      })
      actionCell.append(save)
      row.append(actionCell)
      body.append(row)
    }
    table.append(head, body)
    userRoot.append(table)
    renderAdminTable('admin-activity', ['Action', 'Account', 'Details', 'Time', 'IP address'], activity.map((item) => [
      item.action, item.user_id || 'Unknown', item.description || '', item.created_at, item.ip_address || '',
    ]))
    renderAdminTable('admin-sessions', ['Account', 'Created', 'Last activity', 'Expires', 'Status', 'IP address'], sessions.map((item) => [
      item.username || item.user_id, item.created_at, item.last_activity_at, item.expires_at,
      item.revoked_at ? 'Revoked' : 'Active', item.ip_address || '',
    ]))
  } catch (error) {
    showToast(error.message || 'Administration data could not be loaded.', 'error')
  }
}

function renderAdminTable(rootId, headings, rows) {
  const root = document.getElementById(rootId)
  root.replaceChildren()
  const table = document.createElement('table')
  table.className = 'admin-table'
  const headRow = document.createElement('tr')
  for (const label of headings) {
    const cell = document.createElement('th')
    cell.textContent = label
    headRow.append(cell)
  }
  const head = document.createElement('thead')
  head.append(headRow)
  const body = document.createElement('tbody')
  for (const values of rows) {
    const row = document.createElement('tr')
    for (const value of values) {
      const cell = document.createElement('td')
      cell.textContent = value || ''
      row.append(cell)
    }
    body.append(row)
  }
  table.append(head, body)
  root.append(table)
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

async function bootstrapApplication() {
  const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
  const status = await response.json().catch(() => null)
  if (!response.ok) throw new Error(status?.error || 'Authentication service is unavailable.')
  if (!status?.authenticated) {
    window.location.replace('/login')
    return
  }
  renderAccount(status.user)
  initializeShell()
  initAppearanceSettings()
  initStorageSettings()
  initFiles()
  initWorkflow()
  initOperations()
  Promise.all([loadVendorScript('/vendor/echarts.js'), loadVendorScript('/vendor/html-to-image.js')])
    .then(() => initDashboardDesigner())
    .catch((error) => {
      showToast(error.message || 'Dashboard visualization libraries could not be loaded.', 'error')
      initDashboardDesigner()
    })
  loadDashboard()
  switchPage('dashboard')
  loadFiles()
}

bootstrapApplication().catch((error) => {
  if (error.message && !window.location.pathname.startsWith('/login')) {
    showToast(error.message, 'error')
    window.location.replace('/login')
  }
})