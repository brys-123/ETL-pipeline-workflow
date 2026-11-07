function csrfToken() {
  const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith('simple_etl_csrf='))
  return entry ? decodeURIComponent(entry.slice('simple_etl_csrf='.length)) : ''
}

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || 'The request could not be completed.')
  return payload
}

const notice = document.getElementById('auth-notice')
const signup = window.location.pathname === '/signup'
const forgot = window.location.pathname === '/forgot-password'
const loginForm = document.getElementById('login-form')
const signupForm = document.getElementById('signup-form')
document.getElementById('auth-heading').textContent = signup ? 'Create your account' : 'Welcome back'
document.getElementById('auth-eyebrow').textContent = signup ? 'GET STARTED' : 'YOUR WORKSPACE'
document.getElementById('auth-intro').textContent = signup
  ? 'Set up your personal workspace to get started.'
  : 'Sign in to continue to Simple ETL Studio.'
loginForm.hidden = signup
signupForm.hidden = !signup
document.getElementById('auth-switch').innerHTML = signup
  ? 'Already have an account? <a href="/login">Sign in</a>'
  : 'New to Simple ETL Studio? <a href="/signup">Create an account</a>'
if (forgot) {
  notice.hidden = false
  notice.textContent = 'Password recovery is not configured for this installation. Contact your administrator.'
}

document.querySelectorAll('[data-toggle-password]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword)
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.textContent = reveal ? 'Hide' : 'Show'
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password')
  })
})

async function establishCsrf() {
  const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error || 'Authentication service is unavailable.')
  if (payload.authenticated) window.location.replace('/')
}

function showError(error) {
  notice.hidden = false
  notice.classList.remove('success')
  notice.textContent = error.message || 'The request could not be completed.'
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  notice.hidden = true
  const button = loginForm.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    await request('/api/auth/login', {
      identity: loginForm.elements.identity.value.trim(),
      password: loginForm.elements.password.value,
      remember: loginForm.elements.remember.checked,
    })
    window.location.replace('/')
  } catch (error) {
    showError(error)
    button.disabled = false
  }
})

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  notice.hidden = true
  const button = signupForm.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    await request('/api/auth/register', {
      full_name: signupForm.elements.full_name.value.trim(),
      username: signupForm.elements.username.value.trim(),
      email: signupForm.elements.email.value.trim(),
      password: signupForm.elements.password.value,
      confirm_password: signupForm.elements.confirm_password.value,
    })
    window.location.replace('/')
  } catch (error) {
    showError(error)
    button.disabled = false
  }
})

establishCsrf().catch(showError)
