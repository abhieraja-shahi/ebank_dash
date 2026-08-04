import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import './App.css'

// In Docker, VITE_API_URL is unset → '' (relative) and nginx proxies /api/*.
// In local dev, VITE_API_URL is also unset → '' and Vite proxies /api/* to :8000.
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
  investments: <Icon line={[[18,20,18,10],[12,20,12,4],[6,20,6,14]]} />,
  borrowings: <Icon d="M23 6l-9.5 9.5-5-5L1 18" d2="M17 6h6v6" />,
  lc: <Icon d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />,
  gl: <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" d2="M14 2v6h6M16 13H8M16 17H8M10 9H8" />,
  reports: <Icon d="M9 11l3 3L22 4" d2="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  alerts: <Icon d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />,
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
  { id: null,       label: 'Investments',         icon: ICONS.investments,  active: false },
  { id: null,       label: 'Borrowings',          icon: ICONS.borrowings,   active: false },
  { id: null,       label: 'Letter of Credit',    icon: ICONS.lc,           active: false },
  { id: null,       label: 'General Ledger',      icon: ICONS.gl,           active: false },
  { id: null,       label: 'Reports',             icon: ICONS.reports,      active: false },
]

const NAV_BOTTOM = [
  { id: null, label: 'Alerts & Notifications', icon: ICONS.alerts,   active: false },
  { id: null, label: 'Settings',               icon: ICONS.settings, active: false },
]

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ section, setSection, branches, filters, setFilters, onApply }) {
  const [draft, setDraft] = useState(filters)

  // Sync when external filters change
  useEffect(() => { setDraft(filters) }, [filters])

  function apply() {
    setFilters(draft)
    onApply(draft)
  }

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-mark">B</div>
        <div>
          <div className="logo-name">BUCB</div>
          <div className="logo-sub">Core Banking</div>
        </div>
      </div>

      {/* Main nav */}
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
          </button>
        ))}
      </nav>

      {/* Bottom nav */}
      <nav className="sidebar-nav-bottom">
        {NAV_BOTTOM.map((item, i) => (
          <button key={i} className="nav-item nav-dim" title="Coming soon">
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Filters */}
      <div className="sidebar-filters">
        <div className="sf-heading">Filters</div>

        <div className="sf-field">
          <label>Branch</label>
          <select value={draft.branch} onChange={e => setDraft(d => ({ ...d, branch: e.target.value }))}>
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
}

function TopHeader({ section, filters, branches, fetching, onRefresh, updatedAt }) {
  const branchLabel = filters.branch
    ? (branches.find(b => b.code === filters.branch)?.name || filters.branch)
    : 'All Branches'

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1 className="page-title">{SECTION_TITLES[section] || 'Dashboard'}</h1>
      </div>
      <div className="top-bar-right">
        {filters.toDate && (
          <div className="top-meta">
            <span className="top-meta-icon">{ICONS.calendar}</span>
            <span>As on Date: <strong>{fmtDate(filters.toDate)}</strong></span>
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
          <div className="user-avatar">A</div>
          <span className="user-name">Admin User</span>
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

function Panel({ title, badge, badgeVariant = 'blue', children, className = '' }) {
  return (
    <div className={`panel ${className}`}>
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {badge && <span className={`badge badge-${badgeVariant}`}>{badge}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  )
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      {label && <div className="tooltip-label">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="tooltip-row">
          <span>{p.name}</span>
          <strong style={{ color: p.color }}>{fmtNum(p.value)}</strong>
        </div>
      ))}
    </div>
  )
}

function BranchTable({ rows, columns }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={c.numeric ? { textAlign: 'right' } : {}}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
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

// ─── Section: Overview ────────────────────────────────────────────────────────

function OverviewSection({ accounts, kyc, loans, loading }) {
  const kycColor  = kyc?.compliance_rate >= 95 ? 'green' : kyc?.compliance_rate >= 85 ? 'amber' : 'red'
  const npaAccent = loans?.npa_ratio <= 5 ? 'green' : loans?.npa_ratio <= 10 ? 'amber' : 'red'
  const kycPie = kyc
    ? [{ name: 'Verified', value: kyc.verified }, { name: 'Pending', value: kyc.pending }]
    : []

  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="👥" label="Total Customers"    value={fmtNum(accounts?.total_customers)} sub="Registered profiles" accent="blue" />
        <KpiCard icon="📋" label="Total Accounts"     value={fmtNum(accounts?.total)} sub={`${fmtNum(accounts?.sb_total)} SB · ${fmtNum(accounts?.ca_total)} CA`} accent="blue" />
        <KpiCard icon="📈" label="New Accounts (2026)" value={fmtNum(accounts?.new_this_year)} sub="Year to date" accent="cyan" />
        <KpiCard icon="✅" label="KYC Compliance"     value={kyc ? `${kyc.compliance_rate}%` : null} sub={`${fmtNum(kyc?.pending)} pending`} accent={kycColor} />
        <KpiCard icon="⚠️" label="NPA Ratio"          value={loans ? `${loans.npa_ratio}%` : null} sub={`${fmtNum(loans?.npa_count)} stressed`} accent={npaAccent} />
      </div>
      <div className="main-grid">
        <Panel title="Account Portfolio — New Accounts (2020–2026)"
               badge={accounts ? `${fmtNum(accounts.total)} Total` : undefined}
               className="panel-accounts">
          {loading || !accounts ? <Spinner /> : (
            <>
              <div style={{ height: 210 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={accounts.trend} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1d4ed8" stopOpacity={0.12} />
                        <stop offset="100%" stopColor="#1d4ed8" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                           tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                    <Tooltip content={<ChartTip />} cursor={{ stroke: '#dce3ed', strokeWidth: 1.5 }} />
                    <Area type="monotone" dataKey="count" name="New Accounts" stroke="#1d4ed8" strokeWidth={2}
                          fill="url(#areaGrad)"
                          dot={{ fill: '#1d4ed8', r: 4, strokeWidth: 2, stroke: '#fff' }}
                          activeDot={{ r: 5, fill: '#1d4ed8', stroke: '#fff', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
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

function AccountsSection({ data, loading }) {
  if (loading || !data) return <Spinner />
  const branchChartData = data.branch_breakdown.map(b => ({ name: b.branch, sb: b.sb, ca: b.ca }))
  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="🏦" label="Saving Bank Accounts" value={fmtNum(data.sb_total)}        sub="All branches"    accent="blue"   />
        <KpiCard icon="💼" label="Current Accounts"     value={fmtNum(data.ca_total)}        sub="All branches"    accent="cyan"   />
        <KpiCard icon="📈" label="New Accounts (2026)"  value={fmtNum(data.new_this_year)}   sub="Year to date"    accent="green"  />
        <KpiCard icon="👥" label="Total Customers"      value={fmtNum(data.total_customers)} sub="Registered"      accent="purple" />
      </div>
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
        <Panel title="New Accounts Trend (2020–2026)">
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="areaGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#1d4ed8" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#1d4ed8" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                <Tooltip content={<ChartTip />} cursor={{ stroke: '#dce3ed', strokeWidth: 1.5 }} />
                <Area type="monotone" dataKey="count" name="New Accounts" stroke="#1d4ed8" strokeWidth={2}
                      fill="url(#areaGrad2)" dot={{ fill: '#1d4ed8', r: 4, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <Panel title="Branch-wise Account Summary" className="mt-panel">
        <BranchTable rows={data.branch_breakdown} columns={[
          { key: 'branch', label: 'Branch' },
          { key: 'sb',     label: 'Saving Bank', numeric: true, render: r => fmtNum(r.sb) },
          { key: 'ca',     label: 'Current A/c', numeric: true, render: r => fmtNum(r.ca) },
          { key: 'total',  label: 'SB + CA',     numeric: true, render: r => fmtNum(r.total), style: () => ({ fontWeight: 600 }) },
        ]} />
      </Panel>
    </>
  )
}

// ─── Section: Deposits ────────────────────────────────────────────────────────

function DepositsSection({ data, loading }) {
  if (loading || !data) return <Spinner />
  const branchChartData = data.branch_breakdown.map(b => ({ name: b.branch, td: b.td_count, rd: b.rd_count, hd: b.hd_count }))
  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="📄" label="Term Deposits (FD)"  value={fmtNum(data.td_count)}    sub={fmtCr(data.td_principal) + ' principal'} accent="blue"   />
        <KpiCard icon="🔄" label="Recurring Deposits"  value={fmtNum(data.rd_count)}    sub="Active RD accounts"                      accent="cyan"   />
        <KpiCard icon="🏠" label="Home Deposits"       value={fmtNum(data.hd_count)}    sub="Daily deposit scheme"                    accent="purple" />
        <KpiCard icon="💰" label="Total Deposit Book"  value={fmtCr(data.td_principal)} sub={`${fmtNum(data.total_deposit_accounts)} accounts`}      accent="green"  />
        <KpiCard icon="📅" label="Maturity Value (FD)" value={fmtCr(data.td_maturity)}  sub="Accumulated at maturity"                 accent="amber"  />
      </div>
      <div className="two-col-grid">
        <Panel title="Deposit Accounts by Branch & Type" badge={`${fmtNum(data.total_deposit_accounts)} Total`}>
          <div style={{ height: 250 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={branchChartData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                       tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
                <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(29,78,216,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#64748b' }} />
                <Bar dataKey="td" name="Term Deposit"  fill="#1d4ed8" radius={[3, 3, 0, 0]} />
                <Bar dataKey="rd" name="Recurring Dep" fill="#0891b2" radius={[3, 3, 0, 0]} />
                <Bar dataKey="hd" name="Home Deposit"  fill="#7c3aed" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="TD Maturity Schedule — 2026">
          {data.maturity_trend.length === 0
            ? <div className="empty-state">No maturity data for 2026</div>
            : (
              <div style={{ height: 250 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.maturity_trend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8edf3" vertical={false} />
                    <XAxis dataKey="quarter" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
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
      </div>
      <Panel title="Branch-wise Deposit Summary" className="mt-panel">
        <BranchTable rows={data.branch_breakdown} columns={[
          { key: 'branch',         label: 'Branch' },
          { key: 'td_count',       label: 'Term Deposits',   numeric: true, render: r => fmtNum(r.td_count) },
          { key: 'td_principal',   label: 'FD Principal',    numeric: true, render: r => fmtCr(r.td_principal) },
          { key: 'rd_count',       label: 'Recurring Dep.',  numeric: true, render: r => fmtNum(r.rd_count) },
          { key: 'hd_count',       label: 'Home Deposits',   numeric: true, render: r => fmtNum(r.hd_count) },
          { key: 'total_accounts', label: 'Total',           numeric: true, render: r => fmtNum(r.total_accounts), style: () => ({ fontWeight: 600 }) },
        ]} />
      </Panel>
    </>
  )
}

// ─── Section: Advances ────────────────────────────────────────────────────────

function AdvancesSection({ data, loading }) {
  if (loading || !data) return <Spinner />
  const branchChartData = data.branch_breakdown.map(b => ({ name: b.branch, standard: b.standard, npa: b.npa_count }))
  return (
    <>
      <div className="kpi-bar">
        <KpiCard icon="📑" label="Total Loan Accounts"   value={fmtNum(data.total)}    sub="All types"                             accent="blue"   />
        <KpiCard icon="✅" label="Standard (Performing)" value={fmtNum(data.standard)} sub={fmtCr(data.total_sanction - data.npa_sanction)} accent="green" />
        <KpiCard icon="⚠️" label="Stressed / NPA"       value={fmtNum(data.npa_count)} sub={fmtCr(data.npa_sanction) + ' exposure'} accent="red"   />
        <KpiCard icon="💹" label="Total Sanction"        value={fmtCr(data.total_sanction)} sub="Portfolio value"                  accent="purple" />
        <KpiCard icon="📊" label="NPA Ratio"             value={`${data.npa_ratio}%`}  sub="By account count"
                 accent={data.npa_ratio <= 5 ? 'green' : data.npa_ratio <= 10 ? 'amber' : 'red'} />
      </div>
      <div className="two-col-grid">
        <Panel title="Standard vs NPA by Branch"
               badge={`NPA ${data.npa_ratio}%`}
               badgeVariant={data.npa_ratio <= 5 ? 'green' : data.npa_ratio <= 10 ? 'amber' : 'red'}>
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
      <Panel title="Branch-wise Advances Summary" className="mt-panel">
        <BranchTable rows={data.branch_breakdown} columns={[
          { key: 'branch',      label: 'Branch' },
          { key: 'total',       label: 'Total Loans',    numeric: true, render: r => fmtNum(r.total) },
          { key: 'standard',    label: 'Standard',       numeric: true, render: r => fmtNum(r.standard),  style: () => ({ color: '#15803d' }) },
          { key: 'npa_count',   label: 'NPA / Stressed', numeric: true, render: r => fmtNum(r.npa_count), style: () => ({ color: '#dc2626' }) },
          { key: 'npa_ratio',   label: 'NPA %',          numeric: true,
            render: r => `${r.npa_ratio}%`,
            style: r => ({ color: r.npa_ratio <= 5 ? '#15803d' : r.npa_ratio <= 10 ? '#b45309' : '#dc2626', fontWeight: 600 }) },
          { key: 'sanction_amt', label: 'Sanction Amt',  numeric: true, render: r => fmtCr(r.sanction_amt) },
        ]} />
      </Panel>
      <Panel title="Loan Type Breakdown" className="mt-panel">
        <BranchTable rows={data.type_breakdown} columns={[
          { key: 'name',   label: 'Loan Type' },
          { key: 'count',  label: 'Accounts',       numeric: true, render: r => fmtNum(r.count) },
          { key: 'amount', label: 'Sanction Amount', numeric: true, render: r => fmtCr(r.amount) },
        ]} />
      </Panel>
    </>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  branch:   '',
  fromDate: '2026-06-01',
  toDate:   '2026-06-15',
}

export default function App() {
  const [section,   setSection]   = useState('overview')
  const [branches,  setBranches]  = useState([])
  const [filters,   setFilters]   = useState(DEFAULT_FILTERS)

  const [accounts,  setAccounts]  = useState(null)
  const [kyc,       setKyc]       = useState(null)
  const [loans,     setLoans]     = useState(null)
  const [deposits,  setDeposits]  = useState(null)
  const [advances,  setAdvances]  = useState(null)

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
    const q = f.branch ? `?branch=${f.branch}` : ''
    try {
      const [aRes, kRes, lRes, dRes, advRes] = await Promise.all([
        fetch(`${API}/api/metrics/accounts${q}`),
        fetch(`${API}/api/metrics/kyc${q}`),
        fetch(`${API}/api/metrics/advances${q}`),
        fetch(`${API}/api/metrics/deposits${q}`),
        fetch(`${API}/api/metrics/advances${q}`),
      ])
      if (!aRes.ok) throw new Error('API error')
      const [a, k, l, d, adv] = await Promise.all([
        aRes.json(), kRes.json(), lRes.json(), dRes.json(), advRes.json(),
      ])
      setAccounts(a); setKyc(k); setLoans(l); setDeposits(d); setAdvances(adv)
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
  }, [])   // only on mount; manual re-fetch on Apply

  function handleApply(newFilters) {
    setFilters(newFilters)
    setLoading(true)
    fetchAll(newFilters)
  }

  return (
    <div className="app-shell">
      <Sidebar
        section={section}
        setSection={setSection}
        branches={branches}
        filters={filters}
        setFilters={setFilters}
        onApply={handleApply}
      />

      <div className="main-area">
        <TopHeader
          section={section}
          filters={filters}
          branches={branches}
          fetching={fetching}
          onRefresh={() => fetchAll(filters)}
          updatedAt={updatedAt}
        />

        <main className="page-content">
          {error && <div className="error-banner">{error}</div>}

          {section === 'overview'  && <OverviewSection  accounts={accounts} kyc={kyc} loans={loans}  loading={loading} />}
          {section === 'accounts'  && <AccountsSection  data={accounts}  loading={loading} />}
          {section === 'deposits'  && <DepositsSection  data={deposits}  loading={loading} />}
          {section === 'advances'  && <AdvancesSection  data={advances}  loading={loading} />}
        </main>
      </div>
    </div>
  )
}
