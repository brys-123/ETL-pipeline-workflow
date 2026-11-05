import { api, escapeHTML, showToast } from './app.js'

let files = []
let previewFileRecord = null
let previewPage = 1
const previewPageSize = 50
let previewSearchTimer

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
  body.innerHTML = filtered.map((file) => `<tr data-searchable="${escapeHTML(file.filename)}"><td><span class="file-name-cell"><span class="file-row-icon"><i class="bi ${file.file_type === 'json' ? 'bi-braces' : file.file_type === 'xlsx' ? 'bi-file-earmark-spreadsheet' : 'bi-filetype-csv'}"></i></span><strong>${escapeHTML(file.filename)}</strong></span></td><td><span class="file-type-chip">${escapeHTML(file.file_type)}</span></td><td><span class="file-size">${formatSize(file.file_size)}</span></td><td><span class="file-date">${formatDate(file.uploaded_at)}</span></td><td><span class="file-status ${escapeHTML(file.status)}">${escapeHTML(file.status)}</span></td><td><button class="preview-file" data-preview-file="${escapeHTML(file.file_id)}" aria-label="Preview ${escapeHTML(file.filename)}" title="Preview dataset"><i class="bi bi-eye"></i></button><button class="delete-file" data-delete-file="${escapeHTML(file.file_id)}" aria-label="Delete ${escapeHTML(file.filename)}" title="Delete file"><i class="bi bi-trash3"></i></button></td></tr>`).join('')
}

export async function previewFile(file) {
  const dialog = document.getElementById('data-preview-dialog')
  const tableWrap = document.getElementById('data-preview-table-wrap')
  const note = document.getElementById('data-preview-note')
  previewFileRecord = file
  previewPage = 1
  document.getElementById('data-preview-title').textContent = file.filename
  document.getElementById('data-preview-summary').textContent = 'Loading dataset preview…'
  document.getElementById('preview-search').value = ''
  tableWrap.innerHTML = ''
  document.getElementById('dataset-inspection').innerHTML = ''
  note.textContent = ''
  dialog.showModal()

  try {
    const inspection = await api(`/api/files/${encodeURIComponent(file.file_id)}/summary`)
    const inspectionTarget = document.getElementById('dataset-inspection')
    inspectionTarget.innerHTML = [
      ['Rows', inspection.rows],
      ['Columns', inspection.columns],
      ['Missing cells', inspection.missing_cells],
      ['Duplicate rows', inspection.duplicate_rows],
    ].map(([label, value]) => `<article><small>${escapeHTML(label)}</small><strong>${Number(value).toLocaleString()}</strong></article>`).join('')
    await renderPreviewPage()
  } catch (error) {
    dialog.close()
    showToast(error.message || 'Could not preview the dataset.', 'error')
  }
}

async function renderPreviewPage() {
  if (!previewFileRecord) return
  const query = document.getElementById('preview-search').value.trim()
  const params = new URLSearchParams({ page: String(previewPage), page_size: String(previewPageSize) })
  if (query) params.set('q', query)
  const preview = await api(`/api/files/${encodeURIComponent(previewFileRecord.file_id)}/preview?${params}`)
  const tableWrap = document.getElementById('data-preview-table-wrap')
  document.getElementById('data-preview-summary').textContent = `${preview.columns.length} columns · ${preview.total_rows.toLocaleString()} matching rows`
  document.getElementById('preview-page-label').textContent = `Page ${preview.page} of ${preview.total_pages}`
  document.getElementById('preview-previous').disabled = preview.page <= 1
  document.getElementById('preview-next').disabled = !preview.has_more
  if (!preview.columns.length) {
    tableWrap.innerHTML = '<p class="data-preview-empty">This dataset has no rows to preview.</p>'
    return
  }
  const header = preview.columns.map((column) => `<th scope="col">${escapeHTML(column)}</th>`).join('')
  const rows = preview.rows.map((row) => `<tr>${preview.columns.map((_column, index) => `<td>${escapeHTML(row[index] ?? '')}</td>`).join('')}</tr>`).join('')
  tableWrap.innerHTML = `<table class="data-preview-table"><thead><tr>${header}</tr></thead><tbody>${rows || `<tr><td class="data-preview-empty" colspan="${preview.columns.length}">No matching rows.</td></tr>`}</tbody></table>`
  document.getElementById('data-preview-note').textContent = 'The original imported dataset is unchanged.'
}

export async function loadFiles() {
  try {
    files = (await api('/api/files')).filter((file) => file.status === 'uploaded')
    renderFiles(document.getElementById('file-search').value)
  } catch (error) {
    showToast(error.message || 'Could not load files.', 'error')
  }
}

async function uploadFile(file) {
  const formData = new FormData()
  formData.append('file', file)
  return api('/api/files/upload', { method: 'POST', body: formData })
}

async function uploadFiles(fileList) {
  const selected = Array.from(fileList || [])
  if (!selected.length) return
  const progress = document.getElementById('upload-progress')
  const input = document.getElementById('file-input')
  const records = []
  progress.hidden = false
  try {
    for (const file of selected) {
      try {
        records.push(await uploadFile(file))
      } catch (error) {
        showToast(`${file.name}: ${error.message || 'Upload failed.'}`, 'error')
      }
    }
    if (records.length) {
      showToast(`${records.length} dataset${records.length === 1 ? '' : 's'} uploaded successfully.`)
      await loadFiles()
      await previewFile(records[records.length - 1])
      window.dispatchEvent(new CustomEvent('app:refresh'))
    }
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
  input.addEventListener('change', () => uploadFiles(input.files))
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
    uploadFiles(event.dataTransfer.files)
  })
  document.getElementById('files-table-body').addEventListener('click', async (event) => {
    const previewButton = event.target.closest('[data-preview-file]')
    if (previewButton) {
      const file = files.find((item) => item.file_id === previewButton.dataset.previewFile)
      if (file) await previewFile(file)
      return
    }
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
  document.getElementById('close-data-preview').addEventListener('click', () => {
    document.getElementById('data-preview-dialog').close()
  })
  document.getElementById('preview-search').addEventListener('input', () => {
    window.clearTimeout(previewSearchTimer)
    previewSearchTimer = window.setTimeout(async () => {
      previewPage = 1
      try {
        await renderPreviewPage()
      } catch (error) {
        showToast(error.message || 'Could not search this dataset.', 'error')
      }
    }, 180)
  })
  document.getElementById('preview-previous').addEventListener('click', async () => {
    if (previewPage <= 1) return
    previewPage -= 1
    try { await renderPreviewPage() } catch (error) { showToast(error.message || 'Could not load the previous page.', 'error') }
  })
  document.getElementById('preview-next').addEventListener('click', async () => {
    previewPage += 1
    try { await renderPreviewPage() } catch (error) {
      previewPage -= 1
      showToast(error.message || 'Could not load the next page.', 'error')
    }
  })
}