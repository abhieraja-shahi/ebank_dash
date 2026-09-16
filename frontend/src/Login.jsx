import { useState } from 'react'

const API = import.meta.env.VITE_API_URL ?? ''

export default function Login({ onLogin, bankInfo }) {
  const [userId,   setUserId]   = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [showPw,   setShowPw]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: userId.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || 'Login failed. Please check your credentials.')
        return
      }
      localStorage.setItem('cbs_session', JSON.stringify(data))
      onLogin(data)
    } catch {
      setError('Unable to connect to the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell">
      {/* ── Left branding panel ── */}
      <div className="login-left">
        <div className="login-brand">
          <div className="login-logo-mark">{bankInfo?.initial || '…'}</div>
          <div>
            <div className="login-bank-name">{bankInfo?.bankName || '…'}</div>
            <div className="login-bank-sub">Core Banking System</div>
          </div>
        </div>

        <div className="login-left-body">
          <div className="login-tagline-title">Banking Analytics Dashboard</div>
          <div className="login-tagline-desc">
            Real-time insights for accounts, deposits, advances, and compliance reporting.
          </div>

          <div className="login-stats">
            <div className="login-stat">
              <div className="login-stat-val">Live</div>
              <div className="login-stat-lbl">Data Feed</div>
            </div>
            <div className="login-stat">
              <div className="login-stat-val">{bankInfo?.branchCount ?? '—'}</div>
              <div className="login-stat-lbl">Branches</div>
            </div>
          </div>
        </div>

        {/* decorative circles */}
        <div className="login-decor-a" />
        <div className="login-decor-b" />
      </div>

      {/* ── Right form panel ── */}
      <div className="login-right">
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-form-header">
            <div className="login-form-mark">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h2>Welcome back</h2>
            <p>Sign in to your CBS Dashboard</p>
          </div>

          {error && (
            <div className="login-error" role="alert">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
            </div>
          )}

          <div className="login-field">
            <label htmlFor="userId">User ID</label>
            <div className="login-input-wrap">
              <svg className="login-field-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <input
                id="userId"
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder="Enter your User ID"
                autoFocus
                autoComplete="username"
                disabled={loading}
                spellCheck="false"
              />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <div className="login-input-wrap">
              <svg className="login-field-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <input
                id="password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                disabled={loading}
              />
              <button
                type="button"
                className="login-pw-toggle"
                onClick={() => setShowPw(s => !s)}
                tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !userId.trim() || !password}
          >
            {loading ? (
              <>
                <span className="login-spinner" />
                Signing in…
              </>
            ) : 'Sign In'}
          </button>

        </form>
      </div>
    </div>
  )
}
