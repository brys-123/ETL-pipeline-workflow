import { api, showToast } from './app.js'

<<<<<<< HEAD
let connectionTestSucceeded = false
let configDirty = false

function storageConfigFromForm(includePassword = false) {
  const config = {
    host: document.getElementById('postgres-host').value.trim(),
    port: Number(document.getElementById('postgres-port').value),
    database: document.getElementById('postgres-database').value.trim(),
    username: document.getElementById('postgres-username').value.trim(),
    maintenance_database: document.getElementById('postgres-maintenance-database').value.trim(),
  }
  const password = document.getElementById('postgres-password').value
=======
const form = () => document.getElementById('postgres-config-form')
let connectionTested = false
let configSaved = false
let testedPassword = ''
let schemaInitialized = false

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
>>>>>>> cabfcff74dd1bdc17781142a1c5b05739a95b821
  if (includePassword && password) config.password = password
  return config
}

<<<<<<< HEAD
function showStorageMessage(message, type = 'success') {
  const output = document.getElementById('storage-action-status')
  output.textContent = message
  output.className = `storage-action-status ${type}`
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value ?? 'Not available')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Not available'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

export async function loadStorageSettings() {
  const [statusResult, configResult] = await Promise.allSettled([
    api('/api/storage/status'),
    api('/api/storage/config'),
  ])
  if (configResult.status === 'fulfilled') {
    const config = configResult.value
    for (const [field, key] of [
      ['postgres-host', 'host'],
      ['postgres-port', 'port'],
      ['postgres-database', 'database'],
      ['postgres-username', 'username'],
      ['postgres-maintenance-database', 'maintenance_database'],
    ]) {
      const input = document.getElementById(field)
      if (!configDirty && document.activeElement !== input) input.value = String(config[key] ?? '')
    }
    const password = document.getElementById('postgres-password')
    password.placeholder = config.password_configured ? 'Saved in system credential vault' : 'Not saved'
  }
  const status = statusResult.status === 'fulfilled' ? statusResult.value : statusResult.reason?.payload
  if (!status) {
    setText('storage-active-backend', 'Unavailable')
    setText('storage-health', statusResult.reason?.message || 'Storage status unavailable')
    setText('storage-database-status', 'Unknown')
    setText('storage-schema-status', 'Unknown')
    return
  }

  const postgres = status.postgresql || {}
  const schema = postgres.schema || {}
  const counts = status.record_counts || {}
  setText('storage-active-backend', status.active_backend === 'postgresql' ? 'PostgreSQL' : 'File System')
  setText('storage-filesystem-active', status.active_backend === 'filesystem' ? 'Active' : 'Inactive')
  setText('storage-filesystem-location', status.filesystem_location)
  setText('storage-filesystem-health', status.filesystem_available ? 'Available' : 'Unavailable')
  setText('storage-free-space', formatBytes(status.filesystem_free_bytes))
  setText('storage-total-files', counts.total_files ?? 'Unavailable')
  setText('storage-uploaded-count', counts.uploaded_datasets ?? 'Unavailable')
  setText('storage-processed-count', counts.processed_datasets ?? 'Unavailable')
  setText('storage-postgresql-active', status.active_backend === 'postgresql' ? 'Active' : 'Inactive')
  setText('storage-postgresql-connection', postgres.connection_error ? 'Disconnected' : postgres.password_configured ? 'Ready to test' : 'Not configured')
  setText('storage-database-status', postgres.database_exists === true ? 'Exists' : postgres.database_exists === false ? 'Does not exist' : 'Unknown')
  setText('storage-schema-status', schema.initialized ? 'Initialized' : 'Not initialized')
  setText('storage-schema-version', schema.schema_version || 'Not initialized')
  setText('storage-last-connection', status.last_successful_connection || 'Never')
  setText('storage-last-initialization', status.last_initialization_result?.success
    ? `${status.last_initialization_result.schema_version} · ${status.last_initialization_result.initialized_at}`
    : 'Never')
  setText('storage-health', status.storage_health === 'available' ? 'Available' : status.error || postgres.connection_error || 'Unavailable')
  document.getElementById('initialize-postgresql').disabled = !connectionTestSucceeded
  document.getElementById('activate-postgresql').disabled = !schema.initialized
  document.getElementById('activate-filesystem').disabled = status.active_backend === 'filesystem'
  document.getElementById('clear-postgres-password').disabled = !postgres.password_configured || status.active_backend === 'postgresql'
}

export function initStorageSettings() {
  document.getElementById('postgres-storage-form').addEventListener('input', () => {
    configDirty = true
    connectionTestSucceeded = false
    document.getElementById('initialize-postgresql').disabled = true
  })

  document.getElementById('test-postgresql-connection').addEventListener('click', async () => {
    connectionTestSucceeded = false
    const button = document.getElementById('test-postgresql-connection')
    button.disabled = true
    showStorageMessage('Testing PostgreSQL connection…', 'pending')
    try {
      const result = await api('/api/storage/postgresql/test-connection', {
        method: 'POST',
        body: JSON.stringify(storageConfigFromForm(true)),
      })
      connectionTestSucceeded = true
      showStorageMessage(`${result.message} ${result.database_exists ? 'Database exists.' : 'Database can be created.'}`, 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'PostgreSQL connection failed.', 'error')
    } finally {
      button.disabled = false
      document.getElementById('initialize-postgresql').disabled = !connectionTestSucceeded
    }
  })

  document.getElementById('save-postgresql-config').addEventListener('click', async () => {
    try {
      await api('/api/storage/config', {
        method: 'POST',
        body: JSON.stringify(storageConfigFromForm(true)),
      })
      document.getElementById('postgres-password').value = ''
      configDirty = false
      connectionTestSucceeded = false
      showStorageMessage('PostgreSQL configuration saved securely.', 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'PostgreSQL configuration could not be saved.', 'error')
    }
  })

  document.getElementById('clear-postgres-password').addEventListener('click', async () => {
    if (!window.confirm('Remove the saved PostgreSQL password from the system credential vault?')) return
    try {
      await api('/api/storage/config', {
        method: 'POST',
        body: JSON.stringify({ ...storageConfigFromForm(), clear_password: true }),
      })
      configDirty = false
      connectionTestSucceeded = false
      showStorageMessage('Saved PostgreSQL password removed.', 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'The saved password could not be removed.', 'error')
    }
  })

  document.getElementById('initialize-postgresql').addEventListener('click', async () => {
    if (!connectionTestSucceeded) return
    const button = document.getElementById('initialize-postgresql')
    button.disabled = true
    showStorageMessage('Initializing database schema without importing existing File System records…', 'pending')
    try {
      const result = await api('/api/storage/postgresql/initialize', {
        method: 'POST',
        body: JSON.stringify(storageConfigFromForm(true)),
      })
      document.getElementById('postgres-password').value = ''
      configDirty = false
      connectionTestSucceeded = false
      showStorageMessage(`${result.message} Schema ${result.schema_version}; ${result.tables.length} tables verified.`, 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'Database initialization failed.', 'error')
    } finally {
      await loadStorageSettings()
    }
  })

  document.getElementById('activate-postgresql').addEventListener('click', async () => {
    if (!window.confirm('Activate PostgreSQL? Existing File System records will remain in File System and will not be transferred.')) return
    try {
      const result = await api('/api/storage/postgresql/activate', { method: 'POST', body: '{}' })
      connectionTestSucceeded = false
      showStorageMessage(result.message, 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'PostgreSQL could not be activated.', 'error')
      await loadStorageSettings()
    }
  })

  document.getElementById('activate-filesystem').addEventListener('click', async () => {
    if (!window.confirm('Return to File System? PostgreSQL records will remain in PostgreSQL and will not be transferred.')) return
    try {
      const result = await api('/api/storage/filesystem/activate', { method: 'POST', body: '{}' })
      connectionTestSucceeded = false
      showStorageMessage(result.message, 'success')
      await loadStorageSettings()
    } catch (error) {
      showStorageMessage(error.message || 'File System could not be activated.', 'error')
    }
  })

  document.getElementById('refresh-storage-status').addEventListener('click', () => {
    loadStorageSettings().catch((error) => showStorageMessage(error.message || 'Storage status could not be refreshed.', 'error'))
  })
}
=======
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
  document.getElementById('storage-schema-status').textContent =
    status.postgresql.schema_initialized === true || schemaInitialized
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
  const initialized = status.postgresql.schema_initialized === true || schemaInitialized
  const canActivate = initialized && status.postgresql.password_saved
  document.getElementById('activate-postgres').disabled = !canActivate
  document.getElementById('postgres-action-note').textContent = !connectionTested
    ? 'Test the PostgreSQL connection before initializing the database.'
    : initialized && !status.postgresql.password_saved
      ? 'Database initialized. Save the PostgreSQL password before activation.'
      : initialized
        ? 'PostgreSQL is ready to activate.'
        : 'Initialize the database before activation.'
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
    testedPassword = form().elements.namedItem('password').value
    schemaInitialized = result.schema_initialized === true
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
    testedPassword = ''
    schemaInitialized = false
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
    const result = await api('/api/storage/postgresql/initialize', {
      method: 'POST',
      body: JSON.stringify(testedPassword ? { password: testedPassword } : {}),
    })
    schemaInitialized = result.initialized === true
    showResult(`${result.message} Active storage was not changed.`)
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
  form().addEventListener('input', (event) => {
    if (event.target.name !== 'password') configSaved = false
    connectionTested = false
    testedPassword = ''
    schemaInitialized = false
    document.getElementById('initialize-postgres').disabled = true
  })
}

export { loadStorageSettings }
>>>>>>> cabfcff74dd1bdc17781142a1c5b05739a95b821
