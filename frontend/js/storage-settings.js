import { api, showToast } from './app.js'

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
  if (includePassword && password) config.password = password
  return config
}

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
