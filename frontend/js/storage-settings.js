import { api, showToast } from './app.js'

const form = () => document.getElementById('postgres-config-form')
let connectionTested = false
let configSaved = false

function configFromForm(includePassword = false) {
  const values = new FormData(form())
  const config = {
    host: values.get('host')?.toString().trim(),
    port: Number(values.get('port')),
    database: values.get('database')?.toString().trim(),
    username: values.get('username')?.toString().trim(),
    maintenance_database: values.get('maintenance_database')?.toString().trim(),
  }
  const password = values.get('password')?.toString()
  if (includePassword && password) config.password = password
  return config
}

function showResult(message, isError = false) {
  const result = document.getElementById('postgres-result')
  result.textContent = message || ''
  result.classList.toggle('error', isError)
}

function formatTime(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function setCount(elementId, value) {
  document.getElementById(elementId).textContent = Number.isFinite(value) ? String(value) : '—'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unavailable'
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB free`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB free`
}

function renderStatus(status, config) {
  const isFilesystem = status.active_backend === 'filesystem'
  const counts = status.counts
  document.getElementById('storage-active-mode').textContent = isFilesystem ? 'File System' : 'PostgreSQL'
  document.getElementById('storage-active-health').textContent = status.storage_available
    ? 'Active backend is available'
    : status.error || 'Active backend is unavailable'
  document.getElementById('storage-db-connection').textContent = status.postgresql.connection_status
  document.getElementById('storage-db-name').textContent = status.postgresql.database || config.database
  document.getElementById('storage-schema-status').textContent = status.postgresql.schema_initialized === true
    ? 'Initialized'
    : status.postgresql.schema_initialized === false ? 'Not initialized' : 'Unknown'
  document.getElementById('storage-schema-version').textContent = status.postgresql.schema_version
    ? `Version ${status.postgresql.schema_version}`
    : 'No schema version'
  document.getElementById('storage-switch-warning').textContent = status.switch_warning

  document.getElementById('filesystem-state').textContent = isFilesystem ? 'Active' : 'Inactive'
  document.getElementById('filesystem-state').classList.toggle('active', isFilesystem)
  document.getElementById('filesystem-availability').textContent = status.filesystem.available ? 'Available' : 'Unavailable'
  document.getElementById('filesystem-location').textContent = status.filesystem.location
  document.getElementById('filesystem-free-space').textContent = formatBytes(status.filesystem.available_bytes)
  setCount('filesystem-total-count', counts ? counts.uploaded_files + counts.processed_datasets : NaN)
  setCount('filesystem-files-count', counts?.uploaded_files)
  setCount('filesystem-processed-count', counts?.processed_datasets)
  document.getElementById('storage-dataset-count').textContent = counts
    ? String(counts.uploaded_files + counts.processed_datasets) : 'Unavailable'
  document.getElementById('storage-upload-count').textContent = counts
    ? `${counts.uploaded_files} uploaded · ${counts.processed_datasets} processed` : 'Record counts unavailable'
  setCount(
    'storage-application-record-count',
    counts ? counts.workflows + counts.executions + counts.dashboards : NaN,
  )

  document.getElementById('postgres-state').textContent = status.postgresql.active ? 'Active' : 'Inactive'
  document.getElementById('postgres-state').classList.toggle('active', status.postgresql.active)
  document.getElementById('postgres-last-connection').textContent = formatTime(
    status.postgresql.last_successful_connection || config.last_successful_connection,
  )
  const initialization = status.postgresql.last_initialization || config.last_initialization
  document.getElementById('postgres-last-initialization').textContent = initialization
    ? `${initialization.message || 'Completed'}${initialization.completed_at ? ` · ${formatTime(initialization.completed_at)}` : ''}`
    : 'Never'
  document.getElementById('setting-upload-limit').textContent = `${status.max_upload_size_mb} MB`
  const initializationButton = document.getElementById('initialize-postgres')
  initializationButton.disabled = !connectionTested
  document.getElementById('activate-postgres').disabled = status.postgresql.schema_initialized !== true
}

async function loadStorageSettings() {
  try {
    const [config, status] = await Promise.all([
      api('/api/storage/config'),
      api('/api/storage/status'),
    ])
    for (const field of ['host', 'port', 'database', 'username', 'maintenance_database']) {
      form().elements.namedItem(field).value = config[field]
    }
    configSaved = true
    form().elements.namedItem('password').value = ''
    document.getElementById('postgres-secret-status').textContent = config.password_source === 'environment'
      ? 'POSTGRES_PASSWORD is configured in the server environment. It is never returned to the browser.'
      : config.password_saved
        ? 'A password is saved in the operating system credential store. It is never returned to the browser.'
        : config.credential_store_available
          ? 'No password is saved. Enter one here or set POSTGRES_PASSWORD in the server environment.'
          : 'No OS credential store is available. Set POSTGRES_PASSWORD in the server environment to use PostgreSQL.'
    renderStatus(status, config)
  } catch (error) {
    showToast(error.message || 'Could not load storage settings.', 'error')
    showResult(error.message || 'Storage settings could not be loaded.', true)
  }
}

async function saveConfiguration(event) {
  event?.preventDefault()
  try {
    const saved = await api('/api/storage/config', {
      method: 'POST',
      body: JSON.stringify(configFromForm(true)),
    })
    form().elements.namedItem('password').value = ''
    connectionTested = false
    configSaved = true
    showResult('PostgreSQL configuration saved securely.')
    await loadStorageSettings()
    document.getElementById('initialize-postgres').disabled = true
    return saved
  } catch (error) {
    showResult(error.message || 'Configuration could not be saved.', true)
    showToast(error.message || 'Configuration could not be saved.', 'error')
    return null
  }
}

async function testConnection() {
  const button = document.getElementById('test-postgres-connection')
  button.disabled = true
  showResult('Testing the PostgreSQL connection…')
  try {
    const result = await api('/api/storage/postgresql/test-connection', {
      method: 'POST',
      body: JSON.stringify(configFromForm(true)),
    })
    connectionTested = configSaved
    const databaseStatus = result.database_exists ? 'Application database exists.' : 'Application database does not exist yet.'
    const permissionStatus = result.database_exists || result.can_create_database
      ? '' : ' The user cannot create databases; create it manually before initializing.'
    const saveStatus = configSaved ? '' : ' Save this configuration and test it again before initialization.'
    showResult(`${result.message} ${databaseStatus}${permissionStatus}${saveStatus}`)
    if (configSaved) {
      await loadStorageSettings()
      document.getElementById('initialize-postgres').disabled = false
    } else {
      document.getElementById('storage-db-connection').textContent = 'Connected (unsaved)'
      document.getElementById('storage-db-name').textContent = configFromForm().database
      document.getElementById('initialize-postgres').disabled = true
    }
  } catch (error) {
    connectionTested = false
    showResult(error.message || 'PostgreSQL connection failed.', true)
    await loadStorageSettings()
  } finally {
    button.disabled = false
  }
}

async function initializeDatabase() {
  const button = document.getElementById('initialize-postgres')
  button.disabled = true
  showResult('Initializing PostgreSQL schema. Existing database records will be preserved.')
  try {
    const result = await api('/api/storage/postgresql/initialize', { method: 'POST', body: '{}' })
    showResult(result.message)
    await loadStorageSettings()
    document.getElementById('initialize-postgres').disabled = false
  } catch (error) {
    showResult(error.message || 'Database initialization failed.', true)
    await loadStorageSettings()
    document.getElementById('initialize-postgres').disabled = false
  }
}

async function activatePostgreSQL() {
  if (!window.confirm(document.getElementById('storage-switch-warning').textContent)) return
  try {
    const result = await api('/api/storage/postgresql/activate', { method: 'POST', body: '{}' })
    showResult(result.message)
    showToast(result.message)
    await loadStorageSettings()
  } catch (error) {
    showResult(error.message || 'PostgreSQL could not be activated.', true)
    showToast(error.message || 'PostgreSQL could not be activated.', 'error')
  }
}

async function activateFileSystem() {
  if (!window.confirm(document.getElementById('storage-switch-warning').textContent)) return
  try {
    const result = await api('/api/storage/filesystem/activate', { method: 'POST', body: '{}' })
    showResult(result.message)
    showToast(result.message)
    await loadStorageSettings()
  } catch (error) {
    showResult(error.message || 'File System could not be activated.', true)
    showToast(error.message || 'File System could not be activated.', 'error')
  }
}

async function removeSavedPassword() {
  if (!window.confirm('Remove the saved PostgreSQL password from the operating system credential store?')) return
  try {
    await api('/api/storage/config', {
      method: 'POST',
      body: JSON.stringify({ ...configFromForm(), clear_password: true }),
    })
    connectionTested = false
    showResult('Saved PostgreSQL password removed.')
    await loadStorageSettings()
  } catch (error) {
    showResult(error.message || 'Saved password could not be removed.', true)
  }
}

export function initStorageSettings() {
  form().addEventListener('submit', saveConfiguration)
  document.getElementById('test-postgres-connection').addEventListener('click', testConnection)
  document.getElementById('initialize-postgres').addEventListener('click', initializeDatabase)
  document.getElementById('activate-postgres').addEventListener('click', activatePostgreSQL)
  document.getElementById('activate-filesystem').addEventListener('click', activateFileSystem)
  document.getElementById('remove-postgres-password').addEventListener('click', removeSavedPassword)
  form().addEventListener('input', () => {
    configSaved = false
    connectionTested = false
    document.getElementById('initialize-postgres').disabled = true
  })
}

export { loadStorageSettings }
