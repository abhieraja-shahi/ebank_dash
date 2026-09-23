import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceDot,
} from 'recharts'
import Login from './Login'
import './App.css'

const API = import.meta.env.VITE_API_URL ?? ''

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtNum = n => (n == null ? '—' : Number(n).toLocaleString('en-IN'))
function fmtCr(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`
  return `₹${v.toLocaleString('en-IN')}`
}
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function Icon({ d, d2, size = 15, circle, rect, line, poly }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {d   && <path d={d} />}
      {d2  && <path d={d2} />}
      {circle && <circle cx={circle[0]} cy={circle[1]} r={circle[2]} />}
      {rect   && <rect x={rect[0]} y={rect[1]} width={rect[2]} height={rect[3]} rx={rect[4] || 0} />}
      {line   && line.map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} />)}
      {poly   && <polyline points={poly} />}
    </svg>
  )
}

const ICONS = {
  overview: <Icon d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" d2="M9 22V12h6v10" />,
  accounts: <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" d2="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" circle={[9, 7, 4]} />,
  deposits: <Icon rect={[1, 4, 22, 16, 2]} line={[[1, 10, 23, 10]]} />,
  advances: <Icon d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />,
  alerts:   <Icon d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />,
  profitability: <Icon d="M12 20V10M18 20V4M6 20v-4" />,
  investments: <Icon line={[[18,20,18,10],[12,20,12,4],[6,20,6,14]]} />,
  borrowings: <Icon d="M23 6l-9.5 9.5-5-5L1 18" d2="M17 6h6v6" />,
  lc: <Icon d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />,
  gl: <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" d2="M14 2v6h6M16 13H8M16 17H8M10 9H8" />,
  reports: <Icon d="M9 11l3 3L22 4" d2="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  settings: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
  branch: <Icon d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  calendar: <Icon rect={[3, 4, 18, 18, 2]} d="M16 2v4M8 2v4M3 10h18" />,
  user: <Icon d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" circle={[12, 7, 4]} />,
  bell: <Icon d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />,
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const NAV_MAIN = [
  { id: 'overview', label: 'Dashboard',           icon: ICONS.overview,     active: true  },
  { id: 'accounts', label: 'Accounts',            icon: ICONS.accounts,     active: true  },
  { id: 'advances', label: 'Loans & Advances',    icon: ICONS.advances,     active: true  },
  { id: 'deposits', label: 'Deposits',            icon: ICONS.deposits,     active: true  },
  { id: 'profitability', label: 'Profitability',  icon: ICONS.profitability, active: true },
  { id: 'investments', label: 'Investments',      icon: ICONS.investments,  active: true  },
  { id: 'alerts',   label: 'Alerts',              icon: ICONS.alerts,       active: true  },
  { id: null,       label: 'Borrowings',          icon: ICONS.borrowings,   active: false },
  { id: null,       label: 'Letter of Credit',    icon: ICONS.lc,           active: false },
  { id: null,       label: 'General Ledger',      icon: ICONS.gl,           active: false },
  { id: null,       label: 'Reports',             icon: ICONS.reports,      active: false },
]

const NAV_BOTTOM = [
  { id: null, label: 'Settings', icon: ICONS.settings, active: false },
]

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ section, setSection, branches, filters, setFilters, onApply, bankInfo, alertCount }) {
  const [draft, setDraft] = useState(filters)

  useEffect(() => { setDraft(filters) }, [filters])

  function apply() {
    setFilters(draft)
    onApply(draft)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-mark">{bankInfo?.initial || '…'}</div>
        <div>
          <div className="logo-name">{bankInfo?.bankName || '…'}</div>
          <div className="logo-sub">Core Banking</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_MAIN.map((item, i) => (
          <button
            key={i}
            className={`nav-item ${section === item.id ? 'nav-active' : ''} ${!item.active ? 'nav-dim' : ''}`}
            onClick={() => item.active && item.id && setSection(item.id)}
            title={!item.active ? 'Coming soon' : ''}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.id === 'alerts' && alertCount > 0 && (
              <span className="nav-badge">{alertCount}</span>
            )}
          </button>
        ))}
      </nav>

      <nav className="sidebar-nav-bottom">
        {NAV_BOTTOM.map((item, i) => (
          <button key={i} className="nav-item nav-dim" title="Coming soon">
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-filters">
        <div className="sf-heading">Filters</div>

        <div className="sf-field">
          <label>Branch</label>
          <select value={draft.branch} onChange={e => {
            const newBranch = e.target.value
            setDraft(d => ({ ...d, branch: newBranch }))
            onApply({ ...filters, branch: newBranch })
          }}>
            <option value="">All Branches</option>
            {branches.filter(b => b.code !== '90').map(b => (
              <option key={b.code} value={b.code}>{b.name}</option>
            ))}
          </select>
        </div>

        <div className="sf-row">
          <div className="sf-field">
            <label>From Date</label>
            <input type="date" value={draft.fromDate}
                   onChange={e => setDraft(d => ({ ...d, fromDate: e.target.value }))} />
          </div>
          <div className="sf-field">
            <label>To Date</label>
            <input type="date" value={draft.toDate}
                   onChange={e => setDraft(d => ({ ...d, toDate: e.target.value }))} />
          </div>
        </div>

        <button className="sf-apply" onClick={apply}>Apply Filters</button>
      </div>
    </aside>
  )
}

// ─── Top Header ───────────────────────────────────────────────────────────────

const SECTION_TITLES = {
  overview: 'CBS Dashboard',
  accounts: 'Accounts',
  deposits: 'Deposits',
  advances: 'Loans & Advances',
  profitability: 'Profitability',
  alerts:   'Alerts & Exceptions',
  investments: 'Investments',
}

function TopHeader({ section, filters, branches, fetching, onRefresh, updatedAt, user, onLogout }) {
  const branchLabel = filters.branch
    ? (branches.find(b => b.code === filters.branch)?.name || filters.branch)
    : 'All Branches'

  const initials = user?.userName
    ? user.userName.split(' ').slice(0, 2).map(w => w[0]).join('')
    : 'U'

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1 className="page-title">{SECTION_TITLES[section] || 'Dashboard'}</h1>
      </div>
      <div className="top-bar-right">
        {filters.toDate && (
          <div className="top-meta">
            <span className="top-meta-icon">{ICONS.calendar}</span>
            <span>As on: <strong>{fmtDate(filters.toDate)}</strong></span>
          </div>
        )}
        <div className="top-meta">
          <span className="top-meta-icon">{ICONS.branch}</span>
          <span>{branchLabel}</span>
        </div>
        <button className="top-refresh" onClick={onRefresh} disabled={fetching}>
          <span style={{ display: 'inline-block', transform: fetching ? 'rotate(360deg)' : 'none', transition: 'transform 0.5s' }}>↻</span>
          {updatedAt && (
            <span className="refresh-time">{updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </button>
        <div className="top-user">
          <div className="user-avatar">{initials}</div>
          <span className="user-name">{user?.userName || 'User'}</span>
          <button className="logout-btn" onClick={onLogout} title="Sign out">
            <Icon d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  blue: '#1d4ed8', green: '#15803d', amber: '#b45309',
  red:  '#dc2626', cyan:  '#0891b2', purple: '#7c3aed', orange: '#c2410c',
}

const ACCT_COLORS = ['#1d4ed8', '#7c3aed', '#15803d', '#b45309', '#dc2626', '#0891b2']

const NPA_COLOR = {
  Standard: '#15803d', NPA: '#dc2626', Decreed: '#991b1b',
  'Sub-Standard': '#b45309', Doubtful: '#c2410c', Loss: '#7f1d1d',
}

const KPI_ACCENT = {
  blue:   { color: '#1d4ed8', lt: '#eff6ff' },
  cyan:   { color: '#0891b2', lt: '#ecfeff' },
  green:  { color: '#15803d', lt: '#f0fdf4' },
  amber:  { color: '#b45309', lt: '#fffbeb' },
  red:    { color: '#dc2626', lt: '#fef2f2' },
  purple: { color: '#7c3aed', lt: '#f5f3ff' },
}

const SEV_STYLE = {
  critical: { bg: '#fef2f2', border: '#fca5a5', color: '#dc2626', dot: '#dc2626' },
  warning:  { bg: '#fffbeb', border: '#fcd34d', color: '#b45309', dot: '#f59e0b' },
  info:     { bg: '#eff6ff', border: '#93c5fd', color: '#1d4ed8', dot: '#3b82f6' },
  ok:       { bg: '#f0fdf4', border: '#86efac', color: '#15803d', dot: '#22c55e' },
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Spinner() {
  return <div className="spinner-wrap"><div className="spinner" /></div>
}

function KpiCard({ icon, label, value, sub, accent = 'blue' }) {
  const a = KPI_ACCENT[accent] || KPI_ACCENT.blue
  return (
    <div className="kpi-card" style={{ '--kpi-color': a.color, '--kpi-lt': a.lt }}>
      <div className="kpi-icon-wrap">{icon}</div>
      <div className="kpi-body">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value ?? '—'}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
      </div>
    </div>
  )
}

function Panel({ title, badge, badgeVariant = 'blue', children, className = '', collapsible = false, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed)
  return (
    <div className={`panel ${className}`}>
      <div className={`panel-header ${collapsible ? 'panel-header-collapsible' : ''}`}
           onClick={collapsible ? () => setCollapsed(c => !c) : undefined}>
        <span className="panel-title">
          {collapsible && <span className={`panel-collapse-chevron ${collapsed ? 'is-collapsed' : ''}`}>▾</span>}
          {title}
        </span>
        {badge && <span className={`badge badge-${badgeVariant}`}>{badge}</span>}
      </div>
      {!collapsed && <div className="panel-body">{children}</div>}
    </div>
  )
}

function ChartTip({ active, payload, label, formatter = fmtNum }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      {label && <div className="tooltip-label">{label}</div>}
      {payload.filter(p => p.value != null).map((p, i) => (
        <div key={i} className="tooltip-row">
          <span>{p.name}</span>
          <strong style={{ color: p.color }}>{formatter(p.value)}</strong>
        </div>
      ))}
    </div>
  )
}

function BranchTable({ rows, columns, sortable = false }) {
  const [sort, setSort] = useState(null) // { key, dir: 1 | -1 }

  function toggleSort(key) {
    if (!sortable) return
    setSort(s => s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 })
  }

  const sortedRows = sort
    ? [...rows].sort((a, b) => {
        const av = a[sort.key], bv = b[sort.key]
        if (av == null) return bv == null ? 0 : 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir
        return String(av).localeCompare(String(bv)) * sort.dir
      })
    : rows

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={c.numeric ? { textAlign: 'right' } : {}}
                  className={sortable ? 'sortable-th' : ''}
                  onClick={() => toggleSort(c.key)}>
                {c.label}{sortable && sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c.key} className={c.numeric ? 'num' : ''} style={c.style?.(row)}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({ options, value, onChange }) {
  return (
    <div className="toggle-group">
      {options.map(o => (
        <button
          key={o.value}
          className={`toggle-btn ${value === o.value ? 'toggle-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ─── Section: Overview ────────────────────────────────────────────────────────

function OverviewSection({ accounts, kyc, loans, alertsSummary, loading }) {
  const kycColor  = kyc?.compliance_rate >= 95 ? 'green' : kyc?.compliance_rate >= 85 ? 'amber' : 'red'
  const npaAccent = loans?.npa_ratio <= 5 ? 'green' : loans?.npa_ratio <= 10 ? 'amber' : 'red'
  const kycPie = kyc
    ? [{ name: 'Verified', value: kyc.verified }, { name: 'Pending', value: kyc.pending }]
    : []
  const acctTrend = splitOngoingTrend(accounts?.trend, 'year')

  return (
    <>
      {/* Alert banner */}
      {alertsSummary && alertsSummary.critical > 0 && (
        <div className="alert-banner critical">
          <span className="alert-banner-dot" />
          <strong>{alertsSummary.critical} critical alert{alertsSummary.critical > 1 ? 's' : ''}</strong>
          {alertsSummary.warning > 0 && <span> · {alertsSummary.warning} warning{alertsSummary.warning > 1 ? 's' : ''}</span>}
          <span className="alert-banner-hint"> — check Alerts section for details</span>
        </div>
      )}

      <div className="kpi-bar">
        <KpiCard icon="👥" label="Total Customers"     value={fmtNum(accounts?.total_customers)} sub="Registered profiles" accent="blue" />
        <KpiCard icon="📋" label="Total Accounts"      value={fmtNum(accounts?.total)} sub={`${fmtNum(accounts?.sb_total)} SB · ${fmtNum(accounts?.ca_total)} CA`} accent="blue" />
        <KpiCard icon="📈" label="New in Period"       value={fmtNum(accounts?.new_in_period)} sub={accounts?.period_label || 'All time'} accent="cyan" />
        <KpiCard icon="✅" label="KYC Compliance"      value={kyc ? `${kyc.compliance_rate}%` : null} sub={`${fmtNum(kyc?.pending)} pending`} accent={kycColor} />
        <KpiCard icon="⚠️" label="NPA Ratio"           value={loans ? `${loans.npa_ratio}%` : null} sub={`${fmtNum(loans?.npa_count)} stressed (by count)`} accent={npaAccent} />
      </div>

      <div className="main-grid">
        <Panel title="Account Portfolio — New Accounts"
               badge={accounts ? `${fmtNum(accounts.total)} Total` : undefined}
               className="panel-accounts">
          {loading || !accounts ? <Spinner /> : (
            <>
              <div style={{ height: 210 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={acctTrend.data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1d4ed8" stopOpacity={0.12} />
                        <stop offset="100%" stopColor="#1d4ed8" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                    <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                           tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                    <Tooltip content={<ProjectionTip freq="year" noun="year" projected={acctTrend.projected} lastPeriod={acctTrend.lastPeriod} />}
                             cursor={{ stroke: '#dce3ed', strokeWidth: 1.5 }} />
                    <Area type="monotone" dataKey="count" name="New Accounts" stroke="#1d4ed8" strokeWidth={2}
                          fill="url(#areaGrad)"
                          dot={{ fill: '#1d4ed8', r: 4, strokeWidth: 2, stroke: '#fff' }}
                          activeDot={{ r: 5, fill: '#1d4ed8', stroke: '#fff', strokeWidth: 2 }} />
                    {acctTrend.ongoing && (
                      <>
                        <ReferenceLine segment={[{ x: acctTrend.lastPeriod, y: acctTrend.actual }, { x: acctTrend.lastPeriod, y: acctTrend.projected }]}
                                       stroke="#d97706" strokeWidth={2} strokeDasharray="5 3" ifOverflow="extendDomain" />
                        <ReferenceDot x={acctTrend.lastPeriod} y={acctTrend.projected} r={5}
                                      fill="#fff" stroke="#d97706" strokeWidth={2} ifOverflow="extendDomain" />
                      </>
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              {acctTrend.ongoing && (
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  ⏳ Solid = actual so far ({fmtTrendTick(acctTrend.lastPeriod, 'year')}, ~{acctTrend.pct}% through the year) · Dashed = projected full-year total (~{fmtNum(acctTrend.projected)}).
                </div>
              )}
              <div className="type-chip-grid">
                {accounts.type_distribution.map((t, i) => (
                  <div className="type-chip" key={i}>
                    <span className="type-dot" style={{ background: ACCT_COLORS[i % 6] }} />
                    <span className="type-name">{t.name}</span>
                    <span className="type-count">{fmtNum(t.count)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel title="KYC Compliance"
               badge={kyc ? `${kyc.compliance_rate}%` : undefined}
               badgeVariant={kyc?.compliance_rate >= 90 ? 'green' : 'amber'}
               className="panel-kyc">
          {loading || !kyc ? <Spinner /> : (
            <>
              <div className="kyc-rate-block">
                <div className="kyc-rate-value" style={{ color: C[kycColor] || C.green }}>{kyc.compliance_rate}%</div>
                <div className="kyc-rate-label">Verification Rate</div>
              </div>
              <div style={{ height: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={kycPie} cx="50%" cy="50%" innerRadius={48} outerRadius={72}
                         paddingAngle={3} dataKey="value" startAngle={90} endAngle={-270}>
                      <Cell fill="#15803d" /><Cell fill="#dc2626" />
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtNum(v), n]}
                             contentStyle={{ background: '#fff', border: '1px solid #dce3ed', borderRadius: 8, fontSize: 12 }}
                             itemStyle={{ color: '#334155' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="kyc-stats">
                <div className="kyc-stat-box">
                  <div className="kyc-stat-val" style={{ color: C.green }}>{fmtNum(kyc.verified)}</div>
                  <div className="kyc-stat-lbl">Verified</div>
                </div>
                <div className="kyc-stat-box">
                  <div className="kyc-stat-val" style={{ color: C.red }}>{fmtNum(kyc.pending)}</div>
                  <div className="kyc-stat-lbl">Pending</div>
                </div>
              </div>
            </>
          )}
        </Panel>

        <Panel title="Loan Portfolio — NPA Classification"
               badge={loans ? `NPA ${loans.npa_ratio}%` : undefined}
               badgeVariant={loans?.npa_ratio <= 5 ? 'green' : loans?.npa_ratio <= 10 ? 'amber' : 'red'}
               className="panel-loans">
          {loading || !loans ? <Spinner /> : (
            <>
              <div className="loan-summary">
                <div className="loan-kpi"><span className="lkpi-val">{fmtNum(loans.total)}</span><span className="lkpi-lbl">Total Loans</span></div>
                <div className="loan-kpi"><span className="lkpi-val" style={{ color: C.green }}>{fmtNum(loans.standard)}</span><span className="lkpi-lbl">Standard</span></div>
                <div className="loan-kpi"><span className="lkpi-val" style={{ color: C.red }}>{fmtNum(loans.npa_count)}</span><span className="lkpi-lbl">Stressed</span></div>
                <div className="loan-kpi"><span className="lkpi-val">{fmtCr(loans.total_sanction)}</span><span className="lkpi-lbl">Total Sanction</span></div>
                <div className="loan-kpi"><span className="lkpi-val" style={{ color: C.red }}>{fmtCr(loans.npa_sanction)}</span><span className="lkpi-lbl">NPA Exposure</span></div>
              </div>
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={loans.classification} layout="vertical"
                            margin={{ top: 0, right: 100, left: 96, bottom: 0 }} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="label" type="category" tick={{ fill: '#334155', fontSize: 12, fontWeight: 500 }}
                           axisLine={false} tickLine={false} width={90} />
                    <Tooltip cursor={{ fill: 'rgba(29,78,216,0.04)' }}
                             content={({ active, payload, label }) => {
                               if (!active || !payload?.length) return null
                               const d = payload[0]?.payload
                               return (
                                 <div className="chart-tooltip">
                                   <div className="tooltip-label">{label}</div>
                                   <div className="tooltip-row"><span>Accounts</span><strong>{fmtNum(d?.count)}</strong></div>
                                   <div className="tooltip-row"><span>Amount</span><strong>{fmtCr(d?.amount)}</strong></div>
                                 </div>
                               )
                             }} />
                    <Bar dataKey="count" name="Accounts" radius={[0, 4, 4, 0]}>
                      {loans.classification.map((e, i) => <Cell key={i} fill={NPA_COLOR[e.label] || C.blue} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  )
}

// ─── Section: Accounts ────────────────────────────────────────────────────────

const STATUS_META = {
  1:  { label: 'Active',             color: '#16a34a', bg: '#f0fdf4' },
  2:  { label: 'Inoperative',        color: '#d97706', bg: '#fffbeb' },
  4:  { label: 'Frozen',             color: '#2563eb', bg: '#eff6ff' },
  10: { label: 'Lien',               color: '#7c3aed', bg: '#f5f3ff' },
  15: { label: 'DEAF',               color: '#dc2626', bg: '#fef2f2' },
}
const KEY_STATUSES = [1, 2, 4, 10, 15]

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function fmtTrendTick(val, freq) {
  if (!val) return val
  if (freq === 'month') return `${MONTHS[parseInt(val.slice(4,6))-1]} '${val.slice(2,4)}`
  if (freq === 'day')   return `${val.slice(6,8)} ${MONTHS[parseInt(val.slice(4,6))-1]}`
  return val
}

// True if `periodStr` (in the given trend granularity) is the bucket "today" falls in —
// i.e. the trend's last point is still accumulating and not a finished year/month/day.
function isPeriodOngoing(periodStr, freq) {
  if (!periodStr) return false
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  if (freq === 'day')   return periodStr === `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  if (freq === 'month') return periodStr === `${now.getFullYear()}${pad(now.getMonth() + 1)}`
  return periodStr === String(now.getFullYear())
}

// % through the current day/month/year "today" falls, for the in-progress trend point.
function elapsedPct(freq) {
  const now = new Date()
  if (freq === 'day')   return Math.round(((now.getHours() * 60 + now.getMinutes()) / 1440) * 100)
  if (freq === 'month') return Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100)
  const start = new Date(now.getFullYear(), 0, 1), end = new Date(now.getFullYear() + 1, 0, 1)
  return Math.round(((now - start) / (end - start)) * 100)
}

// Extrapolates the still-running bucket's partial figure out to a full-period estimate.
// Both the real point and the projection sit at the SAME x (the trend's last category) —
// the projection is drawn as a marker + dashed connector above the real point, not a
// separate x-axis tick.
function splitOngoingTrend(trend, freq, key = 'count') {
  const empty = { data: trend, ongoing: false, pct: null, projected: null, lastPeriod: null, actual: null }
  if (!trend?.length) return empty
  const last = trend[trend.length - 1]
  if (!isPeriodOngoing(last.period, freq)) return empty
  const pct = Math.max(elapsedPct(freq), 1)
  const actual = last[key] || 0
  const projected = Math.round(actual / (pct / 100))
  return { data: trend, ongoing: true, pct, projected, lastPeriod: last.period, actual }
}

// Tooltip for a split trend chart: at the in-progress point (last x), shows both the
// real figure so far and the projected full-period estimate alongside it.
function ProjectionTip({ active, payload, label, freq, noun, projected, lastPeriod }) {
  if (!active || !payload?.length) return null
  const real = payload.find(x => x.dataKey === 'count')
  if (real?.value == null) return null
  const isLast = label === lastPeriod
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{fmtTrendTick(label, freq)}</div>
      <div className="tooltip-row"><span>New Accounts{isLast ? ' (so far)' : ''}</span><strong>{fmtNum(real.value)}</strong></div>
      {isLast && (
        <div className="tooltip-row"><span>Projected full {noun}</span><strong style={{ color: '#d97706' }}>{fmtNum(projected)}</strong></div>
      )}
    </div>
  )
}

function AccountsSection({ data, loading, filters }) {
  if (loading || !data) return <Spinner />
  const [showStatusPanel, setShowStatusPanel] = useState(false)
  const [trendFreq, setTrendFreq]   = useState('year')
  const [localTrend, setLocalTrend] = useState(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [branchView, setBranchView] = useState('count')

  useEffect(() => {
    if (trendFreq !== 'year' && !filters?.fromDate && !filters?.toDate) {
      setTrendFreq('year'); setLocalTrend(null); return
    }
    if (trendFreq === 'year') { setLocalTrend(null); return }
    setTrendLoading(true)
    const p = new URLSearchParams({ freq: trendFreq })
    if (filters?.branch)   p.set('branch',    filters.branch)
    if (filters?.fromDate) p.set('from_date', filters.fromDate)
    if (filters?.toDate)   p.set('to_date',   filters.toDate)
    fetch(`${API}/api/metrics/accounts?${p}`)
      .then(r => r.json())
      .then(d => setLocalTrend(d.trend))
      .catch(() => {})
      .finally(() => setTrendLoading(false))
  }, [trendFreq, filters])

  const trend = localTrend ?? data.trend ?? []
  const trendTitle = trendFreq === 'year' ? 'New Accounts Trend (by Year)'
                   : trendFreq === 'month' ? 'New Accounts by Month'
                   : 'New Accounts by Day'
  const trendNoun = trendFreq === 'year' ? 'year' : trendFreq === 'month' ? 'month' : 'day'
  const trendSplit = splitOngoingTrend(trend, trendFreq)
  const statusMap = Object.fromEntries((data.status_breakdown || []).map(s => [s.status, s.count]))

  const branchChartData = data.branch_breakdown.map(b => ({ name: b.branch, sb: b.sb, ca: b.ca }))
  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="🏦" label="Saving Bank Accounts" value={fmtNum(data.sb_total)}        sub="All branches"    accent="blue"   />
        <KpiCard icon="💼" label="Current Accounts"     value={fmtNum(data.ca_total)}        sub="All branches"    accent="cyan"   />
        <KpiCard icon="📈" label="New in Period"        value={fmtNum(data.new_in_period)}   sub={data.period_label || 'All time'} accent="green"  />
        <KpiCard icon="👥" label="Total Customers"      value={fmtNum(data.total_customers)} sub="Registered"      accent="purple" />
      </div>

      {/* Total Accounts status breakdown */}
      <div className="acct-status-bar">
        <div className="acct-status-total">
          <span className="acct-status-total-num">{fmtNum(data.total)}</span>
          <span className="acct-status-total-lbl">Total Accounts</span>
        </div>
        <div className="acct-status-pills">
          {KEY_STATUSES.map(s => {
            const meta = STATUS_META[s]
            return (
              <div key={s} className="acct-status-pill" style={{ borderColor: meta.color + '40', background: meta.bg }}>
                <span className="acct-status-pill-count" style={{ color: meta.color }}>{fmtNum(statusMap[s] ?? 0)}</span>
                <span className="acct-status-pill-lbl">{meta.label}</span>
              </div>
            )
          })}
        </div>
        <button className="acct-status-toggle" onClick={() => setShowStatusPanel(v => !v)}>
          {showStatusPanel ? 'Hide breakdown' : 'View breakdown'}
        </button>
      </div>

      {showStatusPanel && (
        <div className="acct-status-breakdown">
          {(data.status_breakdown || []).map(s => {
            const meta = STATUS_META[s.status]
            const pct  = data.total > 0 ? (s.count / data.total * 100).toFixed(1) : '0.0'
            return (
              <div key={s.status} className="acct-status-row">
                <span className="acct-status-row-dot" style={{ background: meta ? meta.color : '#94a3b8' }} />
                <span className="acct-status-row-lbl">{s.label}</span>
                <div className="acct-status-row-bar-wrap">
                  <div className="acct-status-row-bar" style={{ width: `${Math.max(pct, 0.5)}%`, background: meta ? meta.color + '99' : '#94a3b8' }} />
                </div>
                <span className="acct-status-row-pct">{pct}%</span>
                <span className="acct-status-row-num">{fmtNum(s.count)}</span>
              </div>
            )
          })}
        </div>
      )}
      <div className="two-col-grid">
        <Panel title="SB & CA by Branch" badge={`${fmtNum(data.sb_total + data.ca_total)} Total`}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={branchChartData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
                <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
                <Bar dataKey="sb" name="Saving Bank" fill="#1d4ed8" radius={[3, 3, 0, 0]} />
                <Bar dataKey="ca" name="Current A/c" fill="#0891b2" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title={trendTitle}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 8 }}>
            {['year','month','day'].map(f => {
              const needsRange = f !== 'year'
              const disabled   = needsRange && !filters?.fromDate && !filters?.toDate
              return (
                <button key={f}
                  onClick={() => !disabled && setTrendFreq(f)}
                  title={disabled ? 'Set a date range to use this view' : undefined}
                  style={{
                    padding: '2px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    border: '1px solid', transition: 'all .15s',
                    opacity: disabled ? 0.4 : 1,
                    background: trendFreq === f ? 'var(--blue)' : 'transparent',
                    color:      trendFreq === f ? '#fff'        : 'var(--muted)',
                    borderColor: trendFreq === f ? 'var(--blue)' : '#dce3ed',
                  }}>
                  {f === 'year' ? 'Y' : f === 'month' ? 'M' : 'D'}
                </button>
              )
            })}
          </div>
          <div style={{ height: 220, position: 'relative' }}>
            {trendLoading && <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,.6)', zIndex:1 }}><Spinner /></div>}
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendSplit.data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="areaGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#1d4ed8" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#1d4ed8" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false}
                       tickFormatter={v => fmtTrendTick(v, trendFreq)}
                       interval={trendFreq === 'year' ? 0
                                : trendFreq === 'month' ? Math.max(0, Math.ceil(trend.length / 8) - 1)
                                : Math.max(0, Math.ceil(trend.length / 10) - 1)} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                <Tooltip content={<ProjectionTip freq={trendFreq} noun={trendNoun} projected={trendSplit.projected} lastPeriod={trendSplit.lastPeriod} />}
                         cursor={{ stroke: '#dce3ed', strokeWidth: 1.5 }} />
                <Area type="monotone" dataKey="count" name="New Accounts" stroke="#1d4ed8" strokeWidth={2}
                      fill="url(#areaGrad2)" dot={trendFreq === 'day' ? false : { fill: '#1d4ed8', r: 4, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} />
                {trendSplit.ongoing && (
                  <>
                    <ReferenceLine segment={[{ x: trendSplit.lastPeriod, y: trendSplit.actual }, { x: trendSplit.lastPeriod, y: trendSplit.projected }]}
                                   stroke="#d97706" strokeWidth={2} strokeDasharray="5 3" ifOverflow="extendDomain" />
                    <ReferenceDot x={trendSplit.lastPeriod} y={trendSplit.projected} r={5}
                                  fill="#fff" stroke="#d97706" strokeWidth={2} ifOverflow="extendDomain" />
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {trendSplit.ongoing && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              ⏳ Solid = actual so far (~{trendSplit.pct}% through the {trendNoun}) · Dashed = projected full-{trendNoun} total (~{fmtNum(trendSplit.projected)}).
            </div>
          )}
        </Panel>
      </div>
      <Panel title="Branch-wise Account Summary" className="mt-panel" collapsible defaultCollapsed>
        <div className="panel-toolbar">
          <span className="panel-toolbar-label">View:</span>
          <Toggle
            options={[{ value: 'count', label: 'By Count' }, { value: 'amount', label: 'By Amount' }]}
            value={branchView}
            onChange={setBranchView}
          />
        </div>
        {branchView === 'count' ? (
          <BranchTable rows={data.branch_breakdown} columns={[
            { key: 'branch', label: 'Branch' },
            { key: 'sb',     label: 'Saving Bank', numeric: true, render: r => fmtNum(r.sb) },
            { key: 'ca',     label: 'Current A/c', numeric: true, render: r => fmtNum(r.ca) },
            { key: 'total',  label: 'SB + CA',     numeric: true, render: r => fmtNum(r.total), style: () => ({ fontWeight: 600 }) },
          ]} />
        ) : (
          <BranchTable rows={data.branch_breakdown} columns={[
            { key: 'branch',    label: 'Branch' },
            { key: 'sb_amt',    label: 'Saving Bank', numeric: true, render: r => fmtCr(r.sb_amt) },
            { key: 'ca_amt',    label: 'Current A/c', numeric: true, render: r => fmtCr(r.ca_amt) },
            { key: 'total_amt', label: 'SB + CA',     numeric: true, render: r => fmtCr(r.total_amt), style: () => ({ fontWeight: 600 }) },
          ]} />
        )}
      </Panel>
    </>
  )
}

// ─── Section: Deposits ────────────────────────────────────────────────────────

const DEPOSIT_TYPE_ACCENTS = ['cyan', 'purple', 'green', 'amber', 'red', 'cyan', 'purple']
const DEPOSIT_TYPE_ICONS   = { RD: '🔄', FD: '📋' }
const NATURE_LABELS = { RD: 'Recurring Deposits', SB: 'Savings Deposits', CA: 'Current A/c Deposits' }
const NATURE_COLORS = { RD: '#7c3aed', SB: '#0891b2', CA: '#059669' }

function DepositsSection({ data, loading }) {
  const [viewMode, setViewMode] = useState('count')
  const [typeFilter, setTypeFilter] = useState('all') // 'all' | 'FD' | 'RD' | 'SB' | 'CA'
  const [subtypeFilter, setSubtypeFilter] = useState('all') // code within typeFilter's nature, or 'all'
  if (loading || !data) return <Spinner />
  const types = data.deposit_types || []
  // Individual KPI cards stay scoped to FD/RD (as before) so Savings/Current
  // don't explode into one card per account sub-type; they're summarised below.
  const kpiTypes = types.filter(t => t.nature === 'FD' || t.nature === 'RD')
  const savings  = types.filter(t => t.nature === 'SB')
  const other    = types.filter(t => t.nature === 'CA')
  const savingsTotal = { count: savings.reduce((s, t) => s + t.count, 0), amount: savings.reduce((s, t) => s + t.amount, 0) }
  const otherTotal   = { count: other.reduce((s, t) => s + t.count, 0),   amount: other.reduce((s, t) => s + t.amount, 0) }

  const isAmt = viewMode === 'amount'

  // Group the (often dozens of) raw account sub-types into their nature — RD/SB/CA
  // — so the branch chart/table show a handful of meaningful series instead of one
  // bar per sub-type. FD stays on the existing td_count/td_principal fields (the
  // trusted source; see BALANCES), not this grouping.
  const byNature = {}
  for (const t of types) {
    if (t.nature === 'FD') continue
    byNature[t.nature] = byNature[t.nature] || { codes: [] }
    byNature[t.nature].codes.push({ code: t.code, label: t.label })
  }
  const natureOptions = Object.keys(byNature)
  const typeDropdownOptions = [
    { value: 'all', label: 'All Types (Grouped)' },
    { value: 'FD',  label: 'Term Deposits (FD)' },
    ...natureOptions.map(n => ({ value: n, label: NATURE_LABELS[n] || n })),
  ]
  // Subtype dropdown only makes sense once a single nature (RD/SB/CA) is selected —
  // it lets the user drill from the grouped nature into one raw account sub-type.
  const subtypeOptions = natureOptions.includes(typeFilter)
    ? [{ value: 'all', label: `All ${NATURE_LABELS[typeFilter] || typeFilter} Subtypes` },
       ...byNature[typeFilter].codes.map(c => ({ value: c.code, label: c.label }))]
    : null
  const codesForNature = n => (typeFilter === n && subtypeFilter !== 'all')
    ? byNature[n].codes.filter(c => c.code === subtypeFilter)
    : byNature[n].codes
  const natureValue  = (b, n, wantAmt) => codesForNature(n).reduce((s, c) => s + (wantAmt ? (b[`${c.code}_amt`] || 0) : (b[c.code] || 0)), 0)
  const natureAmount = (b, n) => natureValue(b, n, isAmt)
  const natureLabel = n => (typeFilter === n && subtypeFilter !== 'all')
    ? (byNature[n].codes.find(c => c.code === subtypeFilter)?.label || NATURE_LABELS[n] || n)
    : (NATURE_LABELS[n] || n)

  const showFD = typeFilter === 'all' || typeFilter === 'FD'
  const shownNatures = typeFilter === 'all' ? natureOptions : natureOptions.filter(n => n === typeFilter)

  const branchChartData = data.branch_breakdown.map(b => {
    const obj = { name: b.branch }
    if (showFD) obj.td = isAmt ? b.td_principal : b.td_count
    shownNatures.forEach(n => { obj[n] = natureAmount(b, n) })
    return obj
  })
  const dynamicBranchCols = shownNatures.flatMap(n => [
    { key: `${n}_count`, label: `${natureLabel(n)} (Count)`,  numeric: true, render: r => fmtNum(natureValue(r, n, false)) },
    { key: `${n}_amt`,   label: `${natureLabel(n)} (Amount)`, numeric: true, render: r => fmtCr(natureValue(r, n, true)) },
  ])
  // Badge total tracks the current Type/Show selection instead of always the
  // whole-book figure, so it reads correctly once the chart is filtered down.
  const selectedTotal = branchChartData.reduce(
    (sum, b) => sum + (b.td || 0) + shownNatures.reduce((s, n) => s + (b[n] || 0), 0), 0
  )
  const selectedTotalLabel = isAmt ? fmtCr(selectedTotal) : fmtNum(selectedTotal)
  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="📄" label="Term Deposits (FD)"  value={fmtNum(data.td_count)}    sub={fmtCr(data.td_principal) + ' principal'} accent="blue"   />
        {kpiTypes.map((t, i) => (
          <KpiCard key={t.code}
            icon={DEPOSIT_TYPE_ICONS[t.nature] || '📋'}
            label={t.label}
            value={fmtNum(t.count)}
            sub={`${fmtCr(t.amount)} balance`}
            accent={DEPOSIT_TYPE_ACCENTS[i % DEPOSIT_TYPE_ACCENTS.length]}
          />
        ))}
        <KpiCard icon="🏦" label="Savings Deposits"    value={fmtNum(savingsTotal.count)} sub={`${fmtCr(savingsTotal.amount)} balance`} accent="cyan"   />
        <KpiCard icon="💳" label="Current A/c Deposits" value={fmtNum(otherTotal.count)}   sub={`${fmtCr(otherTotal.amount)} balance`}   accent="purple" />
        <KpiCard icon="💰" label="Total Deposit Book"  value={fmtCr(data.total_deposit_amount)} sub={`${fmtNum(data.total_deposit_accounts)} accounts`} accent="green" />
        <KpiCard icon="📅" label="Maturity Value (FD)" value={fmtCr(data.td_maturity)}  sub="Accumulated at maturity"                 accent="amber"  />
      </div>

      <Panel title="Deposit Accounts by Branch & Type" badge={`${selectedTotalLabel} Total`}>
          <div className="panel-toolbar">
            <span className="panel-toolbar-label">Show:</span>
            <Toggle
              options={[{ value: 'count', label: 'By Count' }, { value: 'amount', label: 'By Amount' }]}
              value={viewMode}
              onChange={setViewMode}
            />
            <span className="panel-toolbar-group">
              <span className="panel-toolbar-label" style={{ marginLeft: 8 }}>Type:</span>
              <select className="panel-select" value={typeFilter}
                      onChange={e => { setTypeFilter(e.target.value); setSubtypeFilter('all') }}>
                {typeDropdownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </span>
            {subtypeOptions && (
              <span className="panel-toolbar-group">
                <span className="panel-toolbar-label" style={{ marginLeft: 8 }}>Subtype:</span>
                <select className="panel-select" value={subtypeFilter} onChange={e => setSubtypeFilter(e.target.value)}>
                  {subtypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </span>
            )}
          </div>
          <div style={{ height: 250 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={branchChartData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => isAmt
                         ? (v >= 1e7 ? `${(v/1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v/1e5).toFixed(0)}L` : v)
                         : (v >= 1000 ? `${(v/1000).toFixed(0)}k` : v)} />
                <Tooltip content={isAmt ? <ChartTip formatter={fmtCr} /> : <ChartTip />} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
                {showFD && <Bar dataKey="td" name="Term Deposit" fill="#1d4ed8" radius={[3, 3, 0, 0]} />}
                {shownNatures.map(n => (
                  <Bar key={n} dataKey={n} name={natureLabel(n)}
                       fill={NATURE_COLORS[n] || '#64748b'} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

      <Panel title="Branch-wise Deposit Summary" className="mt-panel" collapsible defaultCollapsed>
        <div className="panel-toolbar">
          <span className="panel-toolbar-group">
            <span className="panel-toolbar-label">Type:</span>
            <select className="panel-select" value={typeFilter}
                    onChange={e => { setTypeFilter(e.target.value); setSubtypeFilter('all') }}>
              {typeDropdownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </span>
          {subtypeOptions && (
            <span className="panel-toolbar-group">
              <span className="panel-toolbar-label" style={{ marginLeft: 8 }}>Subtype:</span>
              <select className="panel-select" value={subtypeFilter} onChange={e => setSubtypeFilter(e.target.value)}>
                {subtypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </span>
          )}
        </div>
        <BranchTable rows={data.branch_breakdown} columns={[
          { key: 'branch', label: 'Branch' },
          ...(showFD ? [
            { key: 'td_count',     label: 'Term Deposits', numeric: true, render: r => fmtNum(r.td_count) },
            { key: 'td_principal', label: 'FD Principal',  numeric: true, render: r => fmtCr(r.td_principal) },
          ] : []),
          ...dynamicBranchCols,
          { key: 'total_accounts', label: 'Total (Count)',  numeric: true,
            render: r => fmtNum(r.total_accounts), style: () => ({ fontWeight: 600 }) },
          { key: 'total_amount',   label: 'Total (Amount)', numeric: true,
            render: r => fmtCr(r.total_amount), style: () => ({ fontWeight: 600 }) },
        ]} />
      </Panel>

      <Panel title={`TD Maturity Ladder — ${data.maturity_window || 'Next 6 Months'}`}
             className="mt-panel" collapsible defaultCollapsed>
        {(data.fd_maturing_7d > 0 || data.fd_maturing_30d > 0) && (
          <div className="maturity-strip">
            {data.fd_maturing_7d > 0 && (
              <div className="maturity-chip maturity-urgent">
                <span className="maturity-chip-label">Next 7 days</span>
                <span className="maturity-chip-count">{fmtNum(data.fd_maturing_7d)} FDs</span>
                <span className="maturity-chip-amt">{fmtCr(data.fd_maturing_7d_amt)}</span>
              </div>
            )}
            {data.fd_maturing_30d > 0 && (
              <div className="maturity-chip maturity-warn">
                <span className="maturity-chip-label">Next 30 days</span>
                <span className="maturity-chip-count">{fmtNum(data.fd_maturing_30d)} FDs</span>
                <span className="maturity-chip-amt">{fmtCr(data.fd_maturing_30d_amt)}</span>
              </div>
            )}
          </div>
        )}
        {data.maturity_trend.length === 0
          ? <div className="empty-state">No maturity data for selected period</div>
          : (
            <div style={{ height: 250 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.maturity_trend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(29,78,216,0.04)' }}
                           content={({ active, payload, label }) => {
                             if (!active || !payload?.length) return null
                             const d = payload[0]?.payload
                             return (
                               <div className="chart-tooltip">
                                 <div className="tooltip-label">{label} — Maturities</div>
                                 <div className="tooltip-row"><span>Count</span><strong>{fmtNum(d?.count)}</strong></div>
                                 <div className="tooltip-row"><span>Amount</span><strong>{fmtCr(d?.amount)}</strong></div>
                               </div>
                             )
                           }} />
                  <Bar dataKey="count" name="Maturing FDs" fill="#1d4ed8" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
      </Panel>
    </>
  )
}

// ─── Section: Advances ────────────────────────────────────────────────────────

function AdvancesSection({ data, loading }) {
  const [npaView, setNpaView] = useState('count')

  if (loading || !data) return <Spinner />

  const npaRatio  = npaView === 'count' ? data.npa_ratio : data.npa_ratio_amount
  const npaAccent = npaRatio <= 5 ? 'green' : npaRatio <= 10 ? 'amber' : 'red'
  const npaSubLabel = npaView === 'count' ? 'by account count' : 'by sanction amount'
  const branchChartData = data.branch_breakdown.map(b => ({ name: b.branch, standard: b.standard, npa: b.npa_count }))

  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="📑" label="Total Loan Accounts"   value={fmtNum(data.total)}      sub="All types"                              accent="blue"   />
        <KpiCard icon="✅" label="Standard (Performing)" value={fmtNum(data.standard)}   sub={`of ${fmtNum(data.total)} accounts`}    accent="green"  />
        <KpiCard icon="⚠️" label="Gross NPA"             value={data.npa_ready === false ? '—' : fmtNum(data.npa_count)}
                 sub={data.npa_ready === false ? 'Loading NPA data — refresh shortly' : fmtCr(data.npa_sanction) + ' outstanding'} accent="red"  />
        <KpiCard icon="🕐" label="Dormant (No Txn >90d)" value={fmtNum(data.dormant)}    sub="Loan accounts"                          accent={data.dormant > 0 ? 'amber' : 'green'} />
        <KpiCard icon="💹" label="Total Sanction"        value={fmtCr(data.total_sanction)} sub="Portfolio value"                     accent="purple" />
      </div>

      {data.new_in_period != null && (
        <div className="period-strip">
          <span className="period-strip-label">New loans in period:</span>
          <span className="period-strip-val">{fmtNum(data.new_in_period)} accounts</span>
          <span className="period-strip-amt">{fmtCr(data.new_sanction)} sanctioned</span>
        </div>
      )}

      <div className="two-col-grid">
        <Panel title="Standard vs NPA by Branch"
               badge={`NPA ${npaRatio}%`}
               badgeVariant={npaAccent}>
          <div style={{ height: 250 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={branchChartData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
                <Bar dataKey="standard" name="Standard"     fill="#15803d" radius={[3, 3, 0, 0]} />
                <Bar dataKey="npa"      name="NPA/Stressed" fill="#dc2626" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="NPA Classification Breakdown">
          <div style={{ height: 250 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.classification} layout="vertical"
                        margin={{ top: 0, right: 100, left: 90, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis dataKey="label" type="category" tick={{ fill: '#334155', fontSize: 12, fontWeight: 500 }}
                       axisLine={false} tickLine={false} width={86} />
                <Tooltip cursor={{ fill: 'rgba(29,78,216,0.04)' }}
                         content={({ active, payload, label }) => {
                           if (!active || !payload?.length) return null
                           const d = payload[0]?.payload
                           return (
                             <div className="chart-tooltip">
                               <div className="tooltip-label">{label}</div>
                               <div className="tooltip-row"><span>Accounts</span><strong>{fmtNum(d?.count)}</strong></div>
                               <div className="tooltip-row"><span>Amount</span><strong>{fmtCr(d?.amount)}</strong></div>
                             </div>
                           )
                         }} />
                <Bar dataKey="count" name="Accounts" radius={[0, 4, 4, 0]}>
                  {data.classification.map((e, i) => <Cell key={i} fill={NPA_COLOR[e.label] || C.blue} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Branch-wise Advances Summary" className="mt-panel" collapsible defaultCollapsed>
        <div className="panel-toolbar">
          <span className="panel-toolbar-label">NPA ratio view:</span>
          <Toggle
            options={[{ value: 'count', label: 'By Count' }, { value: 'amount', label: 'By Amount' }]}
            value={npaView}
            onChange={setNpaView}
          />
        </div>
        <BranchTable rows={data.branch_breakdown} columns={[
          { key: 'branch',      label: 'Branch' },
          { key: 'total',       label: 'Total Loans',    numeric: true, render: r => fmtNum(r.total) },
          { key: 'standard',    label: 'Standard',       numeric: true, render: r => fmtNum(r.standard),  style: () => ({ color: '#15803d' }) },
          { key: 'npa_count',   label: 'NPA / Stressed', numeric: true, render: r => fmtNum(r.npa_count), style: () => ({ color: '#dc2626' }) },
          {
            key: 'npa_ratio',
            label: npaView === 'count' ? 'NPA % (Count)' : 'NPA % (Amount)',
            numeric: true,
            render: r => {
              const v = npaView === 'count' ? r.npa_ratio : r.npa_ratio_amount
              return `${v}% (${fmtCr(r.npa_sanction)})`
            },
            style: r => {
              const v = npaView === 'count' ? r.npa_ratio : r.npa_ratio_amount
              return { color: v <= 5 ? '#15803d' : v <= 10 ? '#b45309' : '#dc2626', fontWeight: 600 }
            },
          },
          { key: 'sanction_amt', label: 'Sanction Amt',  numeric: true, render: r => fmtCr(r.sanction_amt) },
        ]} />
      </Panel>

      <Panel title="Loan Type Breakdown" className="mt-panel" collapsible defaultCollapsed>
        <BranchTable rows={data.type_breakdown} columns={[
          { key: 'name',   label: 'Loan Type' },
          { key: 'count',  label: 'Accounts',       numeric: true, render: r => fmtNum(r.count) },
          { key: 'amount', label: 'Sanction Amount', numeric: true, render: r => fmtCr(r.amount) },
        ]} />
      </Panel>
    </>
  )
}

// ─── Section: Profitability ───────────────────────────────────────────────────

function pctDelta(cur, prior) {
  if (cur == null || prior == null || prior === 0) return null
  return ((cur - prior) / Math.abs(prior)) * 100
}

function DeltaTag({ cur, prior }) {
  const d = pctDelta(cur, prior)
  if (d == null) return null
  const up = d >= 0
  return (
    <span style={{ color: up ? '#15803d' : '#dc2626', fontWeight: 600 }}>
      {up ? '▲' : '▼'} {Math.abs(d).toFixed(1)}% vs prior period
    </span>
  )
}

function PeriodBadge({ complete, elapsedPct, size = 'md' }) {
  if (complete) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: size === 'sm' ? 11 : 12,
                     fontWeight: 600, color: '#15803d' }}>
        ✓ Closed period
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: size === 'sm' ? 11 : 12,
                   fontWeight: 600, color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d',
                   borderRadius: 999, padding: '2px 8px' }}>
        ⏳ In progress{elapsedPct != null ? ` · ${elapsedPct}% elapsed` : ''}
    </span>
  )
}

function fyLabel(f_year, isCurrent) {
  return `FY ${f_year}-${String((f_year + 1) % 100).padStart(2, '0')}${isCurrent ? ' (YTD)' : ''}`
}

// Groups the quarterly trend series (labelled "F_YEAR-Qn") into one bar per FY.
// Only the most recent quarter can be incomplete (§_period_progress), so a group's
// elapsed_pct is the completed quarters plus that one quarter's own progress, out of 4.
function annualizeTrend(quarterly) {
  const groups = {}
  for (const q of quarterly) {
    const fYear = Number(q.period.split('-Q')[0])
    const g = groups[fYear] || (groups[fYear] = {
      f_year: fYear, nii: 0, net_profit: 0, complete: true, quarterCount: 0, runningElapsed: 0,
    })
    g.nii += q.nii
    g.net_profit += q.net_profit
    g.quarterCount += 1
    if (q.complete === false) { g.complete = false; g.runningElapsed = q.elapsed_pct || 0 }
  }
  return Object.values(groups)
    .sort((a, b) => a.f_year - b.f_year)
    .map(g => ({
      period: fyLabel(g.f_year, false),
      nii: g.nii,
      net_profit: g.net_profit,
      complete: g.complete,
      elapsed_pct: g.complete ? null : Math.round(((g.quarterCount - 1) * 100 + g.runningElapsed) / 4),
    }))
}

function ProfitabilitySection({ data, warmingUp, loading, fys, selectedFy, onFyChange }) {
  const [trendView, setTrendView] = useState('quarterly')
  if (loading && !data) return <Spinner />

  if (warmingUp || !data) {
    return (
      <Panel title="Profitability">
        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#64748b' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Profitability metrics are warming up</div>
          <div>The P&amp;L, balance and NPA jobs run once at startup — this can take up to a minute on a large bank. Try refreshing shortly.</div>
        </div>
      </Panel>
    )
  }

  const { pl, pl_prior, trend, balances, npa, ratios, warnings } = data
  const displayTrend = trendView === 'annual' ? annualizeTrend(trend) : trend
  const npaAccent = npa.gross_pct == null ? 'blue' : npa.gross_pct <= 5 ? 'green' : npa.gross_pct <= 10 ? 'amber' : 'red'
  const cdAccent  = ratios.cd_ratio_pct == null ? 'blue' : (ratios.cd_ratio_pct >= 60 && ratios.cd_ratio_pct <= 75) ? 'green' : 'amber'
  const npaAccounts = Object.values(npa.by_class).reduce((s, c) => s + (c.accounts || 0), 0)

  const plRows = [
    { label: 'Total Income',       cur: pl.total_income,      prior: pl_prior.total_income },
    { label: '　Interest Income',  cur: pl.interest_income,   prior: pl_prior.interest_income },
    { label: '　Other Income',     cur: pl.other_income,      prior: pl_prior.other_income },
    { label: 'Total Expenditure',  cur: pl.total_expenditure, prior: pl_prior.total_expenditure },
    { label: '　Interest Expense', cur: pl.interest_expense,  prior: pl_prior.interest_expense },
    { label: '　Other Expenditure (incl. provisions & tax)', cur: pl.other_expenditure, prior: pl_prior.other_expenditure },
    { label: 'Net Interest Income', cur: pl.nii,              prior: pl_prior.nii,  strong: true },
    { label: 'Net Profit',          cur: pl.net_profit,       prior: pl_prior.net_profit, strong: true },
  ]

  return (
    <>
      {warnings?.length > 0 && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      <div className="panel-toolbar" style={{ marginBottom: 12, flexWrap: 'wrap', rowGap: 8 }}>
        <span className="panel-toolbar-label">Financial Year:</span>
        <select className="panel-select" value={selectedFy} onChange={e => onFyChange(e.target.value)}>
          {fys.map(w => (
            <option key={w.f_year} value={w.is_current ? 'ytd' : w.f_year}>
              {fyLabel(w.f_year, w.is_current)}
            </option>
          ))}
        </select>
        <PeriodBadge complete={data.period.complete} elapsedPct={data.period.elapsed_pct} />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>
          {fmtDate(data.period.from)} – {fmtDate(data.period.to)}
        </span>
      </div>

      {!data.period.complete && (
        <div style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d',
                      borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          ⏳ This period is still running — the figures below (and every tile marked "in progress") will keep
          changing until it closes. Interest is posted quarterly, so income/NII/Net Profit can jump sharply
          once the current quarter's postings land.
        </div>
      )}

      <div className="kpi-bar">
        <KpiCard icon="💰" label="Net Profit"
                 value={fmtCr(pl.net_profit)}
                 sub={<>{!data.period.complete && <span style={{ color: '#b45309', fontWeight: 600 }}>⏳ in progress · </span>}<DeltaTag cur={pl.net_profit} prior={pl_prior.net_profit} /></>}
                 accent={pl.net_profit >= 0 ? 'green' : 'red'} />
        <KpiCard icon="📊" label="Net Interest Income"
                 value={fmtCr(pl.nii)}
                 sub={`${fmtCr(pl.interest_income)} / ${fmtCr(pl.interest_expense)}${!data.period.complete ? ' · in progress' : ''}`}
                 accent="blue" />
        <KpiCard icon="💸" label="Cost of Funds"
                 value={ratios.cost_of_funds_pct != null ? `${ratios.cost_of_funds_pct}%` : '—'}
                 sub={ratios.cost_of_funds_window ? `Trailing 4 completed qtrs: ${ratios.cost_of_funds_window}` : 'Needs 4 completed quarters'}
                 accent="purple" />
        <KpiCard icon="⚠️" label="Gross NPA"
                 value={npa.gross_pct != null ? `${npa.gross_pct}%` : '—'}
                 sub={`${fmtCr(npa.gross)} · ${fmtNum(npaAccounts)} accounts · as of today`}
                 accent={npaAccent} />
        <KpiCard icon="🏦" label="CD Ratio"
                 value={ratios.cd_ratio_pct != null ? `${ratios.cd_ratio_pct}%` : '—'}
                 sub={`${fmtCr(balances.deposits.total)} dep / ${fmtCr(balances.advances.total)} adv · as of today`}
                 accent={cdAccent} />
      </div>

      <div className="two-col-grid">
        <Panel title="P&L Summary"
               badge={data.period.type === 'ytd' ? 'YTD' : 'FY'}
               className="mt-panel">
          <BranchTable rows={plRows} columns={[
            { key: 'label', label: 'Line' },
            { key: 'cur',   label: data.period.complete ? 'Current' : 'Current (running)', numeric: true, render: r => fmtCr(r.cur), style: r => r.strong ? { fontWeight: 700 } : {} },
            { key: 'prior', label: 'Prior Period', numeric: true, render: r => fmtCr(r.prior) },
          ]} />
        </Panel>

        <Panel title="P&L Trend" className="mt-panel">
          <div className="panel-toolbar" style={{ marginBottom: 8 }}>
            <Toggle
              options={[{ value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }]}
              value={trendView}
              onChange={setTrendView}
            />
          </div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={displayTrend} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false}
                       tickFormatter={v => displayTrend.find(t => t.period === v)?.complete === false ? `${v} ⏳` : v} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => `${(v / 1e7).toFixed(1)}`} />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0]?.payload
                  return (
                    <div className="chart-tooltip">
                      <div className="tooltip-label">{label}{d?.complete === false ? ' — in progress' : ''}</div>
                      <div className="tooltip-row"><span>NII</span><strong>{fmtCr(d?.nii)}</strong></div>
                      <div className="tooltip-row"><span>Net Profit</span><strong>{fmtCr(d?.net_profit)}</strong></div>
                      {d?.complete === false && (
                        <div className="tooltip-row"><span>{trendView === 'annual' ? 'Year' : 'Quarter'} elapsed</span><strong>{d?.elapsed_pct}%</strong></div>
                      )}
                    </div>
                  )
                }} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
                <Bar dataKey="nii" name="NII" radius={[3, 3, 0, 0]}>
                  {displayTrend.map((t, i) => (
                    <Cell key={i} fill="#1d4ed8" fillOpacity={t.complete === false ? 0.4 : 1}
                          stroke={t.complete === false ? '#1d4ed8' : 'none'} strokeDasharray={t.complete === false ? '3 2' : ''} />
                  ))}
                </Bar>
                <Bar dataKey="net_profit" name="Net Profit" radius={[3, 3, 0, 0]}>
                  {displayTrend.map((t, i) => (
                    <Cell key={i} fill="#15803d" fillOpacity={t.complete === false ? 0.4 : 1}
                          stroke={t.complete === false ? '#15803d' : 'none'} strokeDasharray={t.complete === false ? '3 2' : ''} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {displayTrend.some(t => t.complete === false) && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              ⏳ Hatched bar = {trendView === 'annual' ? 'year' : 'quarter'} still running ({displayTrend.find(t => t.complete === false)?.elapsed_pct}% elapsed) — not comparable to completed {trendView === 'annual' ? 'years' : 'quarters'} yet.
            </div>
          )}
        </Panel>
      </div>

      <Panel title="NPA by Class" className="mt-panel">
        <BranchTable rows={[
          { label: 'Sub-Standard', ...npa.by_class.sub_standard },
          { label: 'Doubtful',     ...npa.by_class.doubtful },
          { label: 'Loss',         ...npa.by_class.loss },
        ]} columns={[
          { key: 'label',    label: 'Class' },
          { key: 'accounts', label: 'Accounts', numeric: true, render: r => fmtNum(r.accounts) },
          { key: 'amount',   label: 'Outstanding', numeric: true, render: r => fmtCr(r.amount) },
        ]} />
      </Panel>
    </>
  )
}

// ─── Section: Investments ─────────────────────────────────────────────────────
// Bank-wide treasury securities book (investment_master) — no branch filter,
// since that table carries no branch column (it's a single HO-level portfolio).

const INVEST_COLORS = ['#1d4ed8', '#7c3aed', '#15803d', '#b45309', '#dc2626', '#0891b2', '#c2410c']

const SLR_STATUS_STYLE = {
  compliant: { accent: 'green', badge: 'green', label: 'Compliant' },
  tight:     { accent: 'amber', badge: 'amber', label: 'Near Minimum' },
  breach:    { accent: 'red',   badge: 'red',   label: 'Below Minimum' },
  unknown:   { accent: 'blue',  badge: 'blue',  label: 'Calculating…' },
}

function SlrComplianceSection({ slr }) {
  if (!slr) return null
  const { slr_eligible_book_value, non_slr_book_value, ndtl, slr_pct,
          minimum_pct, headroom_pct, status, balances_ready } = slr
  const s = SLR_STATUS_STYLE[status] || SLR_STATUS_STYLE.unknown

  return (
    <Panel title="SLR Compliance" className="mt-panel" badge={s.label} badgeVariant={s.badge}>
      <div className="kpi-bar" style={{ paddingTop: 0 }}>
        <KpiCard icon="🛡️" label="SLR Ratio"
                 value={slr_pct != null ? `${slr_pct}%` : '—'}
                 sub={balances_ready ? 'SLR-eligible book ÷ NDTL' : 'Warming up…'}
                 accent={s.accent} />
        <KpiCard icon="📏" label="Minimum Required"
                 value={`${minimum_pct}%`}
                 sub="RBI norm for UCBs"
                 accent="blue" />
        <KpiCard icon={headroom_pct != null && headroom_pct < 0 ? '⛔' : '✅'} label="Headroom"
                 value={headroom_pct != null ? `${headroom_pct > 0 ? '+' : ''}${headroom_pct}%` : '—'}
                 sub="Above / below minimum"
                 accent={s.accent} />
        <KpiCard icon="🏦" label="SLR-Eligible Investments"
                 value={fmtCr(slr_eligible_book_value)}
                 sub="Govt securities & T-Bills"
                 accent="purple" />
        <KpiCard icon="📒" label="NDTL (Deposits Proxy)"
                 value={ndtl != null ? fmtCr(ndtl) : '—'}
                 sub="Bank-wide closing deposits"
                 accent="cyan" />
      </div>

      {non_slr_book_value > 0 && (
        <div className="table-footnote">
          {fmtCr(non_slr_book_value)} held in non-SLR-eligible instruments (term deposits, others) —
          not counted toward the SLR ratio above.
        </div>
      )}
    </Panel>
  )
}

function InvestmentsSection({ data, loading }) {
  if (loading && !data) return <Spinner />
  if (!data) return <Spinner />

  const { total_book_value, total_face_value, mtm_bucket_book_vs_face, htm_book_vs_face,
          weighted_avg_roi, weighted_avg_ytm, holding_count, composition, classification,
          maturity_ladder, holdings, slr } = data

  const mtmAccent = mtm_bucket_book_vs_face > 0 ? 'green' : mtm_bucket_book_vs_face < 0 ? 'red' : 'blue'

  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="🏛️" label="Total Investment Book"
                 value={fmtCr(total_book_value)}
                 sub={`${fmtNum(holding_count)} holdings`}
                 accent="blue" />
        <KpiCard icon="📄" label="Face Value"
                 value={fmtCr(total_face_value)}
                 sub="Aggregate face value"
                 accent="purple" />
        <KpiCard icon={mtm_bucket_book_vs_face >= 0 ? '📈' : '📉'} label="AFS/HFT Book vs. Face"
                 value={fmtCr(mtm_bucket_book_vs_face)}
                 sub="Marked-to-market bucket only"
                 accent={mtmAccent} />
        <KpiCard icon="📦" label="HTM Book vs. Face"
                 value={fmtCr(htm_book_vs_face)}
                 sub="Amortized cost — not P&L"
                 accent="blue" />
        <KpiCard icon="💹" label="Weighted Avg ROI"
                 value={`${weighted_avg_roi}%`}
                 sub="Across live holdings"
                 accent="cyan" />
        <KpiCard icon="🎯" label="Weighted Avg YTM"
                 value={`${weighted_avg_ytm}%`}
                 sub="Yield to maturity"
                 accent="orange" />
      </div>

      <SlrComplianceSection slr={slr} />

      <Panel title="Investment Classification" className="mt-panel">
        <BranchTable rows={classification} columns={[
          { key: 'category',   label: 'Category' },
          { key: 'count',      label: 'Holdings', numeric: true, render: r => fmtNum(r.count) },
          { key: 'face_value', label: 'Face Value', numeric: true, render: r => fmtCr(r.face_value) },
          { key: 'book_value', label: 'Book Value', numeric: true, render: r => fmtCr(r.book_value) },
          { key: 'book_vs_face', label: 'Book vs. Face', numeric: true, render: r => fmtCr(r.book_vs_face) },
        ]} />
      </Panel>

      <div className="two-col-grid">
        <Panel title="Portfolio Composition" className="mt-panel">
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={composition} cx="50%" cy="50%" innerRadius={56} outerRadius={90}
                     paddingAngle={3} dataKey="book_value" nameKey="sectype">
                  {composition.map((c, i) => <Cell key={c.sectype} fill={INVEST_COLORS[i % INVEST_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [fmtCr(v), n]}
                         contentStyle={{ background: '#fff', border: '1px solid #dce3ed', borderRadius: 8, fontSize: 12 }}
                         itemStyle={{ color: '#334155' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Maturity Ladder" className="mt-panel">
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={maturity_ladder} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => `${(v / 1e7).toFixed(1)}`} />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0]?.payload
                  return (
                    <div className="chart-tooltip">
                      <div className="tooltip-label">{label}</div>
                      <div className="tooltip-row"><span>Holdings</span><strong>{fmtNum(d?.count)}</strong></div>
                      <div className="tooltip-row"><span>Book Value</span><strong>{fmtCr(d?.amount)}</strong></div>
                    </div>
                  )
                }} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Bar dataKey="amount" name="Book Value" fill={C.blue} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Holdings" className="mt-panel" badge={`${fmtNum(holding_count)} Total`}
             collapsible defaultCollapsed>
        <BranchTable sortable rows={holdings} columns={[
          { key: 'secdesc',    label: 'Security' },
          { key: 'sectype',    label: 'Type' },
          { key: 'category',   label: 'Category' },
          { key: 'slr_eligible', label: 'SLR', render: r => r.slr_eligible ? 'Y' : 'N' },
          { key: 'purchase_date', label: 'Purchase Date', render: r => fmtDate(r.purchase_date) },
          { key: 'maturity',   label: 'Maturity', render: r => fmtDate(r.maturity) },
          { key: 'roi',        label: 'ROI', numeric: true, render: r => `${r.roi}%` },
          { key: 'ytm',        label: 'YTM', numeric: true,
            render: r => r.ytm_estimated ? `${r.ytm}%*` : `${r.ytm}%` },
          { key: 'face_value', label: 'Face Value', numeric: true, render: r => fmtCr(r.face_value) },
          { key: 'book_value', label: 'Book Value', numeric: true, render: r => fmtCr(r.book_value) },
        ]} />
        {holdings.some(h => h.ytm_estimated) && (
          <div className="table-footnote">* YTM not recorded for this security — approximated from ROI, book value and time to maturity.</div>
        )}
      </Panel>
    </>
  )
}

// ─── Section: Alerts ──────────────────────────────────────────────────────────

function AlertsSection({ data, loading }) {
  if (loading || !data) return <Spinner />
  const { alerts, summary } = data

  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="🚨" label="Critical"      value={summary.critical}  sub="Require immediate action" accent={summary.critical > 0 ? 'red' : 'green'} />
        <KpiCard icon="⚠️" label="Warnings"      value={summary.warning}   sub="Monitor closely"          accent={summary.warning > 0 ? 'amber' : 'green'} />
        <KpiCard icon="📊" label="NPA (Count)"   value={`${summary.npa_pct_count}%`}  sub="By account count"  accent={summary.npa_pct_count > 5 ? 'red' : summary.npa_pct_count > 3 ? 'amber' : 'green'} />
        <KpiCard icon="💰" label="NPA (Amount)"  value={`${summary.npa_pct_amount}%`} sub="By sanction amount" accent={summary.npa_pct_amount > 5 ? 'red' : summary.npa_pct_amount > 3 ? 'amber' : 'green'} />
        {summary.cd_ratio != null && (
          <KpiCard icon="📈" label="CD Ratio" value={`${summary.cd_ratio}%`} sub="Closing balances, as of today"
            accent={summary.cd_ratio > 75 ? 'red' : summary.cd_ratio < 60 ? 'amber' : 'green'} />
        )}
      </div>

      <Panel
        title="Active Alerts"
        badge={`${alerts.length} Total`}
        badgeVariant={summary.critical > 0 ? 'red' : summary.warning > 0 ? 'amber' : 'green'}
      >
        {alerts.length === 0 ? (
          <div className="alerts-empty">
            <span style={{ fontSize: 24 }}>✓</span>
            <span>All metrics within thresholds — no active alerts</span>
          </div>
        ) : (
          <div className="alerts-list">
            {alerts.map(alert => {
              const s = SEV_STYLE[alert.severity] || SEV_STYLE.info
              return (
                <div key={alert.id} className="alert-row" style={{ background: s.bg, borderLeftColor: s.border }}>
                  <div className="alert-dot" style={{ background: s.dot }} />
                  <div className="alert-body">
                    <div className="alert-title" style={{ color: s.color }}>{alert.title}</div>
                    <div className="alert-msg">{alert.message}</div>
                  </div>
                  <div className="alert-meta">
                    <span className="alert-category">{alert.category}</span>
                    {alert.value && <span className="alert-value" style={{ color: s.color }}>{alert.value}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {(summary.fd_maturing_7d > 0 || summary.fd_maturing_30d > 0) && (
        <Panel title="FD Maturity Watch" className="mt-panel" badge="Liquidity Risk" badgeVariant="amber">
          <div className="kpi-bar" style={{ paddingTop: 0, paddingBottom: 0 }}>
            <KpiCard icon="📅" label="Maturing in 7 Days"
              value={fmtNum(summary.fd_maturing_7d)}
              sub={fmtCr(summary.fd_maturing_7d_amt) + ' at risk'}
              accent={summary.fd_maturing_7d > 0 ? 'red' : 'green'} />
            <KpiCard icon="📅" label="Maturing in 30 Days"
              value={fmtNum(summary.fd_maturing_30d)}
              sub={fmtCr(summary.fd_maturing_30d_amt) + ' to manage'}
              accent={summary.fd_maturing_30d > 50 ? 'amber' : 'cyan'} />
          </div>
        </Panel>
      )}
    </>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  branch:   '',
  fromDate: '',
  toDate:   '',
}

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cbs_session')) } catch { return null }
  })
  const [bankInfo, setBankInfo] = useState({ bankName: '', initial: '' })

  useEffect(() => {
    fetch(`${API}/api/bank-info`).then(r => r.json()).then(setBankInfo).catch(() => {})
  }, [])

  function handleLogin(userData) { setUser(userData) }

  function handleLogout() {
    if (user?.token) {
      fetch(`${API}/api/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token }),
      }).catch(() => {})
    }
    localStorage.removeItem('cbs_session')
    setUser(null)
  }

  if (!user) return <Login onLogin={handleLogin} bankInfo={bankInfo} />

  return <Dashboard user={user} onLogout={handleLogout} bankInfo={bankInfo} />
}

function Dashboard({ user, onLogout, bankInfo }) {
  const [section,   setSection]   = useState('overview')
  const [branches,  setBranches]  = useState([])
  const [filters,   setFilters]   = useState(DEFAULT_FILTERS)

  const [accounts,  setAccounts]  = useState(null)
  const [kyc,       setKyc]       = useState(null)
  const [loans,     setLoans]     = useState(null)
  const [deposits,  setDeposits]  = useState(null)
  const [advances,  setAdvances]  = useState(null)
  const [alertsData, setAlertsData] = useState(null)
  const [profitability, setProfitability] = useState(null)
  const [profSelectedFy, setProfSelectedFy] = useState('ytd')  // 'ytd' or a closed FY's f_year
  const [profFys, setProfFys] = useState([])
  const [profWarmingUp, setProfWarmingUp] = useState(false)
  const [investments, setInvestments] = useState(null)

  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [error,     setError]     = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)

  useEffect(() => {
    fetch(`${API}/api/branches`).then(r => r.json()).then(setBranches).catch(() => {})
  }, [])

  const fetchAll = useCallback(async (f = filters) => {
    setFetching(true)
    setError(null)

    const params = new URLSearchParams()
    if (f.branch)   params.set('branch',    f.branch)
    if (f.fromDate) params.set('from_date', f.fromDate)
    if (f.toDate)   params.set('to_date',   f.toDate)
    const q = params.toString() ? `?${params.toString()}` : ''

    // Alerts only needs branch filter
    const alertParams = new URLSearchParams()
    if (f.branch) alertParams.set('branch', f.branch)
    const aq = alertParams.toString() ? `?${alertParams.toString()}` : ''

    try {
      const [aRes, kRes, lRes, dRes, advRes, alRes] = await Promise.all([
        fetch(`${API}/api/metrics/accounts${q}`),
        fetch(`${API}/api/metrics/kyc${q}`),
        fetch(`${API}/api/metrics/advances${q}`),
        fetch(`${API}/api/metrics/deposits${q}`),
        fetch(`${API}/api/metrics/advances${q}`),
        fetch(`${API}/api/alerts${aq}`),
      ])
      if (!aRes.ok) throw new Error('API error')
      const [a, k, l, d, adv, al] = await Promise.all([
        aRes.json(), kRes.json(), lRes.json(), dRes.json(), advRes.json(), alRes.json(),
      ])
      setAccounts(a); setKyc(k); setLoans(l); setDeposits(d); setAdvances(adv); setAlertsData(al)
      setUpdatedAt(new Date())
    } catch {
      setError('Unable to reach the API. Ensure the backend is running on port 8000.')
    } finally {
      setLoading(false)
      setFetching(false)
    }
  }, [filters])

  useEffect(() => {
    setLoading(true)
    fetchAll()
    const id = setInterval(() => fetchAll(), 60_000)
    return () => clearInterval(id)
  }, [])

  const fetchProfFys = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/metrics/profitability/fys`)
      if (!res.ok) return
      const fys = await res.json()
      setProfFys(fys)
    } catch { /* profitability is best-effort; other sections still work */ }
  }, [])

  useEffect(() => {
    fetchProfFys()
    const id = setInterval(fetchProfFys, 60_000)
    return () => clearInterval(id)
  }, [fetchProfFys])

  const fetchProfitability = useCallback(async () => {
    const params = profSelectedFy === 'ytd'
      ? new URLSearchParams({ period: 'ytd' })
      : new URLSearchParams({ period: 'fy', fy: String(profSelectedFy) })
    if (filters.branch) params.set('branch', filters.branch)
    try {
      const res = await fetch(`${API}/api/metrics/profitability?${params.toString()}`)
      if (res.status === 503) { setProfWarmingUp(true); return }
      if (!res.ok) return
      setProfWarmingUp(false)
      setProfitability(await res.json())
    } catch { /* profitability is best-effort; other sections still work */ }
  }, [filters.branch, profSelectedFy])

  useEffect(() => {
    fetchProfitability()
    const id = setInterval(fetchProfitability, 60_000)
    return () => clearInterval(id)
  }, [fetchProfitability])

  const fetchInvestments = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/metrics/investments`)
      if (!res.ok) return
      setInvestments(await res.json())
    } catch { /* investments is best-effort; other sections still work */ }
  }, [])

  useEffect(() => {
    fetchInvestments()
    const id = setInterval(fetchInvestments, 60_000)
    return () => clearInterval(id)
  }, [fetchInvestments])

  function handleApply(newFilters) {
    setFilters(newFilters)
    setLoading(true)
    fetchAll(newFilters)
  }

  const criticalCount = alertsData?.summary?.critical ?? 0

  return (
    <div className="app-shell">
      <Sidebar
        section={section}
        setSection={setSection}
        branches={branches}
        filters={filters}
        setFilters={setFilters}
        onApply={handleApply}
        bankInfo={bankInfo}
        alertCount={criticalCount}
      />

      <div className="main-area">
        <TopHeader
          section={section}
          filters={filters}
          branches={branches}
          fetching={fetching}
          onRefresh={() => { fetchAll(filters); fetchProfitability(); fetchInvestments() }}
          updatedAt={updatedAt}
          user={user}
          onLogout={onLogout}
        />

        <main className="page-content">
          {error && <div className="error-banner">{error}</div>}

          {section === 'overview'  && <OverviewSection  accounts={accounts} kyc={kyc} loans={loans} alertsSummary={alertsData?.summary} loading={loading} />}
          {section === 'accounts'  && <AccountsSection  data={accounts}   loading={loading} filters={filters} />}
          {section === 'deposits'  && <DepositsSection  data={deposits}   loading={loading} />}
          {section === 'advances'  && <AdvancesSection  data={advances}   loading={loading} />}
          {section === 'profitability' && (
            <ProfitabilitySection
              data={profitability}
              warmingUp={profWarmingUp}
              loading={loading}
              fys={profFys}
              selectedFy={profSelectedFy}
              onFyChange={setProfSelectedFy}
            />
          )}
          {section === 'alerts'    && <AlertsSection    data={alertsData} loading={loading} />}
          {section === 'investments' && <InvestmentsSection data={investments} loading={loading} />}
        </main>
      </div>
    </div>
  )
}
