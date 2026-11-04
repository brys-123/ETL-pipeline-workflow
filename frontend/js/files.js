import { api, escapeHTML, showToast } from './app.js'

let files = []

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function renderFiles(query = '') {
  const body = document.getElementById('files-table-body')
  const filtered = files.filter((file) => file.filename.toLowerCase().includes(query.trim().toLowerCase()))
  document.getElementById('files-count').textContent = String(files.length)
  document.getElementById('nav-file-count').textContent = String(files.length)
  if (!filtered.length) {
    body.innerHTML = `<tr><td class="table-empty" colspan="6">${files.length ? 'No files match your search.' : 'No datasets uploaded yet.'}</td></tr>`
    return
  }
  body.innerHTML = filtered.map((file) => `<tr data-searchable="${escapeHTML(file.filename)}"><td><span class="file-name-cell"><span class="file-row-icon"><i class="bi ${file.file_type === 'json' ? 'bi-braces' : file.file_type === 'xlsx' ? 'bi-file-earmark-spreadsheet' : 'bi-filetype-csv'}"></i></span><strong>${escapeHTML(file.filename)}</strong></span></td><td><span class="file-type-chip">${escapeHTML(file.file_type)}</span></td><td><span class="file-size">${formatSize(file.file_size)}</span></td><td><span class="file-date">${formatDate(file.uploaded_at)}</span></td><td><span class="file-status ${escapeHTML(file.status)}">${escapeHTML(file.status)}</span></td><td><button class="delete-file" data-delete-file="${escapeHTML(file.file_id)}" aria-label="Delete ${escapeHTML(file.filename)}" title="Delete file"><i class="bi bi-trash3"></i></button></td></tr>`).join('')
}

export async function loadFiles() {
  try {
    files = await api('/api/files')
    renderFiles(document.getElementById('file-search').value)
  } catch (error) {
    showToast(error.message || 'Could not load files.', 'error')
  }
}

async function uploadFile(file) {
  if (!file) return
  const progress = document.getElementById('upload-progress')
  const input = document.getElementById('file-input')
  progress.hidden = false
  try {
    const formData = new FormData()
    formData.append('file', file)
    const record = await api('/api/files/upload', { method: 'POST', body: formData })
    showToast(`${record.filename} uploaded successfully.`)
    await loadFiles()
    window.dispatchEvent(new CustomEvent('app:refresh'))
  } catch (error) {
    showToast(error.message || 'Upload failed.', 'error')
  } finally {
    progress.hidden = true
    input.value = ''
  }
}

export function initFiles() {
  const input = document.getElementById('file-input')
  const dropzone = document.getElementById('upload-dropzone')
  const browse = () => input.click()
  document.getElementById('browse-files').addEventListener('click', browse)
  document.getElementById('choose-file').addEventListener('click', browse)
  input.addEventListener('change', () => uploadFile(input.files[0]))
  document.getElementById('file-search').addEventListener('input', (event) => renderFiles(event.target.value))
  window.addEventListener('app:upload', browse)
  window.addEventListener('app:search', (event) => {
    const page = document.getElementById('page-files')
    if (!page.hidden) renderFiles(event.detail.query)
  })

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', (event) => {
    if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('dragover')
  })
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropzone.classList.remove('dragover')
    uploadFile(event.dataTransfer.files[0])
  })
  document.getElementById('files-table-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-file]')
    if (!button) return
    const file = files.find((item) => item.file_id === button.dataset.deleteFile)
    if (!file || !window.confirm(`Delete ${file.filename} from local storage?`)) return
    try {
      await api(`/api/files/${encodeURIComponent(file.file_id)}`, { method: 'DELETE' })
      showToast(`${file.filename} deleted.`)
      await loadFiles()
      window.dispatchEvent(new CustomEvent('app:refresh'))
    } catch (error) {
      showToast(error.message || 'Could not delete the file.', 'error')
    }
  })
}