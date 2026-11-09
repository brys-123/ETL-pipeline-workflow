import { api, escapeHTML, showToast } from './app.js'

const dialog = () => document.getElementById('connection-manager-dialog')
let connectionRecords = []

function connectionTypeLabel(kind) {
  return ({ mysql: 'MySQL', postgresql: 'PostgreSQL', api: 'REST API' })[kind] || kind
}

function field(label, name, value = '', options = {}) {
  const required = options.required ? ' required' : ''
  const type = options.type || 'text'
  const placeholder = options.placeholder ? ` placeholder="${escapeHTML(options.placeholder)}"` : ''
  const valueAttribute = type === 'password' ? '' : ` value="${escapeHTML(value)}"`
  return `<label class="connection-field"><span>${escapeHTML(label)}</span><input name="${escapeHTML(name)}" type="${type}"${valueAttribute}${placeholder}${required} autocomplete="${type === 'password' ? 'new-password' : 'off'}" /></label>`
}

function selectField(label, name, value, options) {
  return `<label class="connection-field"><span>${escapeHTML(label)}</span><select name="${escapeHTML(name)}">${options.map(([optionValue, optionLabel]) => `<option value="${escapeHTML(optionValue)}" ${value === optionValue ? 'selected' : ''}>${escapeHTML(optionLabel)}</option>`).join('')}</select></label>`
}

function textAreaField(label, name, value, placeholder) {
  return `<label class="connection-field connection-field-wide"><span>${escapeHTML(label)}</span><textarea name="${escapeHTML(name)}" rows="3" placeholder="${escapeHTML(placeholder)}">${escapeHTML(value || '')}</textarea></label>`
}

function renderList() {
  const target = document.getElementById('connection-manager-list')
  target.innerHTML = connectionRecords.length
    ? `<div class="connection-list">${connectionRecords.map((record) => `<article class="connection-row"><div><strong>${escapeHTML(record.name)}</strong><span>${escapeHTML(connectionTypeLabel(record.kind))} · ${escapeHTML(record.host || record.api_url)}</span><small>${record.secret_configured ? 'Credentials saved' : 'No credentials saved'}</small></div><div class="connection-row-actions"><button type="button" class="button-secondary button-sm" data-connection-test="${escapeHTML(record.connection_id)}" title="Test connection"><i class="bi bi-plug"></i></button><button type="button" class="button-secondary button-sm" data-connection-edit="${escapeHTML(record.connection_id)}" title="Edit connection"><i class="bi bi-pencil"></i></button><button type="button" class="button-secondary button-sm danger-action" data-connection-delete="${escapeHTML(record.connection_id)}" title="Delete connection"><i class="bi bi-trash3"></i></button></div></article>`).join('')}</div>`
    : '<p class="connection-empty">No saved external connections.</p>'
}

async function loadRecords() {
  const status = document.getElementById('connection-manager-status')
  status.textContent = 'Loading saved connections…'
  try {
    connectionRecords = await api('/api/connections')
    renderList()
    status.textContent = ''
    window.dispatchEvent(new CustomEvent('connections:changed', { detail: connectionRecords }))
  } catch (error) {
    status.textContent = error.message || 'Could not load saved connections.'
    renderList()
  }
}

function renderForm(record = {}) {
  const form = document.getElementById('connection-manager-form')
  const kind = record.kind || 'mysql'
  let fields = selectField('Connection type', 'kind', kind, [['mysql', 'MySQL'], ['postgresql', 'PostgreSQL'], ['api', 'REST API']])
  fields += field('Connection name', 'name', record.name || '', { required: true, placeholder: 'Sales reporting database' })
  if (kind === 'api') {
    fields += field('API URL', 'api_url', record.api_url || '', { required: true, placeholder: 'https://api.example.com/v1/records' })
    fields += selectField('HTTP method', 'method', 'GET', [['GET', 'GET (read only)']])
    fields += selectField('Authentication', 'auth_type', record.auth_type || 'none', [['none', 'No authentication'], ['api_key', 'API key'], ['bearer', 'Bearer token'], ['basic', 'Basic authentication']])
    fields += field('API key header', 'api_key_name', record.api_key_name || 'X-API-Key')
    fields += field('API key', 'api_key', '', { type: 'password', placeholder: 'Leave blank to keep saved value' })
    fields += field('Bearer token', 'token', '', { type: 'password', placeholder: 'Leave blank to keep saved value' })
    fields += field('Basic username', 'basic_username', '', { placeholder: 'Leave blank to keep saved value' })
    fields += field('Basic password', 'basic_password', '', { type: 'password', placeholder: 'Leave blank to keep saved value' })
    fields += textAreaField('Additional headers (JSON)', 'headers', JSON.stringify(record.headers || {}, null, 2), '{"X-Client": "etl-studio"}')
    fields += textAreaField('Default query parameters (JSON)', 'query_params', JSON.stringify(record.query_params || {}, null, 2), '{"region": "north"}')
  } else {
    fields += field('Host', 'host', record.host || 'localhost', { required: true })
    fields += field('Port', 'port', record.port || (kind === 'mysql' ? 3306 : 5432), { type: 'number', required: true })
    fields += field('Database name', 'database', record.database || '', { required: true })
    fields += field('Username', 'username', record.username || '', { required: true })
    fields += field('Password', 'password', '', { type: 'password', placeholder: 'Leave blank to keep saved value' })
    if (kind === 'postgresql') fields += field('Schema', 'schema', record.schema || 'public')
  }
  fields += field('Timeout (seconds)', 'timeout', record.timeout || 10, { type: 'number', required: true })
  if (kind !== 'api') {
    fields += `<label class="connection-trust"><input name="allow_private_network" type="checkbox" ${record.allow_private_network ? 'checked' : ''} /><span>Trust private/local network for this database</span></label>`
  }
  form.innerHTML = `<input type="hidden" name="connection_id" value="${escapeHTML(record.connection_id || '')}" /><div class="connection-form-grid">${fields}</div><div class="connection-form-actions"><button class="button-secondary button-sm" type="button" id="connection-form-cancel">Cancel</button><button class="button-secondary button-sm" type="button" id="connection-form-test"><i class="bi bi-plug"></i> Test connection</button><button class="button-primary button-sm" type="submit">Save connection</button></div>`
  form.hidden = false
  form.querySelector('[name="kind"]').addEventListener('change', () => renderForm({ kind: form.elements.kind.value, name: form.elements.name.value }))
  form.querySelector('[name="auth_type"]')?.addEventListener('change', () => {
    const formData = new FormData(form)
    const values = Object.fromEntries(formData.entries())
    renderForm({ ...record, ...values, headers: JSON.parse(values.headers || '{}'), query_params: JSON.parse(values.query_params || '{}') })
  })
  document.getElementById('connection-form-cancel').addEventListener('click', () => { form.hidden = true })
  document.getElementById('connection-form-test').addEventListener('click', () => testForm(record.connection_id))
}

function parseJsonField(formData, name, fallback = {}) {
  const value = formData.get(name)
  if (value === null) return fallback
  try {
    return JSON.parse(value || '{}')
  } catch {
    throw new Error(`${name.replaceAll('_', ' ')} must be valid JSON.`)
  }
}

function formPayload() {
  const form = document.getElementById('connection-manager-form')
  const data = new FormData(form)
  const payload = Object.fromEntries(data.entries())
  payload.allow_private_network = Boolean(data.get('allow_private_network'))
  if (payload.kind === 'api') {
    payload.headers = parseJsonField(data, 'headers')
    payload.query_params = parseJsonField(data, 'query_params')
  }
  for (const key of ['port', 'timeout']) if (payload[key]) payload[key] = Number(payload[key])
  if (!payload.connection_id) delete payload.connection_id
  return payload
}

async function testForm(connectionId) {
  const status = document.getElementById('connection-manager-status')
  try {
    const payload = formPayload()
    if (connectionId) payload.connection_id = connectionId
    const result = await api('/api/connections/test', { method: 'POST', body: JSON.stringify(payload) })
    status.textContent = result.http_status ? `Connection successful · HTTP ${result.http_status}` : result.message
    status.dataset.state = 'success'
  } catch (error) {
    status.textContent = error.message || 'Connection test failed.'
    status.dataset.state = 'error'
  }
}

async function submitForm(event) {
  event.preventDefault()
  const status = document.getElementById('connection-manager-status')
  try {
    const payload = formPayload()
    const connectionId = payload.connection_id
    delete payload.connection_id
    await api(connectionId ? `/api/connections/${encodeURIComponent(connectionId)}` : '/api/connections', {
      method: connectionId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    status.textContent = 'Connection saved.'
    status.dataset.state = 'success'
    document.getElementById('connection-manager-form').hidden = true
    await loadRecords()
  } catch (error) {
    status.textContent = error.message || 'Connection could not be saved.'
    status.dataset.state = 'error'
  }
}

async function handleListAction(event) {
  const test = event.target.closest('[data-connection-test]')
  const edit = event.target.closest('[data-connection-edit]')
  const remove = event.target.closest('[data-connection-delete]')
  if (test) return testForm(test.dataset.connectionTest)
  if (edit) {
    const record = connectionRecords.find((item) => item.connection_id === edit.dataset.connectionEdit)
    if (record) renderForm(record)
  }
  if (remove) {
    if (!window.confirm('Delete this saved connection? Workflows that reference it will need a replacement.')) return
    try {
      await api(`/api/connections/${encodeURIComponent(remove.dataset.connectionDelete)}`, { method: 'DELETE' })
      showToast('Connection deleted.')
      await loadRecords()
    } catch (error) {
      document.getElementById('connection-manager-status').textContent = error.message || 'Connection could not be deleted.'
    }
  }
}

export function initConnectionManager() {
  const element = dialog()
  if (!element || element.dataset.initialized) return
  element.dataset.initialized = 'true'
  document.getElementById('connection-manager-close').addEventListener('click', () => element.close())
  document.getElementById('connection-create').addEventListener('click', () => renderForm())
  document.getElementById('connection-manager-list').addEventListener('click', handleListAction)
  document.getElementById('connection-manager-form').addEventListener('submit', submitForm)
  element.addEventListener('click', (event) => {
    if (event.target === element) element.close()
  })
  window.addEventListener('connections:changed', (event) => { connectionRecords = event.detail })
}

export async function openConnectionManager() {
  initConnectionManager()
  if (!dialog().open) dialog().showModal()
  document.getElementById('connection-manager-form').hidden = true
  await loadRecords()
}

export async function loadConnections() {
  connectionRecords = await api('/api/connections')
  return connectionRecords
}

export function connectionRecordsFor(kind) {
  return connectionRecords.filter((record) => record.kind === kind)
}