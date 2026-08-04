# Gap Analysis: UCB Dashboard Spec v1.0 vs Current Implementation

**Date:** 2026-07-06
**Spec Reference:** UCB_Dashboard_Spec_1.docx (May 2026)
**Current Stack:** React 18 + Vite + Recharts (Frontend) | FastAPI + MySQL (Backend)

---

## What Exists Today

- **Frontend**: React 18 + Vite + Recharts with 4 sections (Overview, Accounts, Deposits, Advances)
- **Backend**: FastAPI (Python) with 6 API endpoints, querying CBS MySQL directly
- **Filters**: Branch selector, date range picker
- **Charts**: Area, Bar, Pie charts with color-coded KPI cards
- **DB Tables Used**: ~7 CBS tables (`accountmaster`, `td_vouchmst`, `td_accountmaster`, `cbs_loan_borrower_details`, `cbs_cust_kyc_details`, `cbs_customer_master_detail`)

---

## 1. Authentication & Security (Spec S7 — Completely Missing)

| Requirement | Status |
|---|---|
| JWT token authentication tied to `bank_id` + user role | **Missing** — API is wide open |
| Role-based access (MD, CEO, Chairman, GM-Finance, GM-Credit, GM-Ops) | **Missing** — hardcoded "Admin User" |
| Bank isolation (multi-tenant, bank A can't see bank B) | **Missing** — no `bank_id` concept |
| TLS 1.2+ for data in transit | **Not configured** |
| Audit logging of dashboard access | **Missing** |

---

## 2. Alerts & Exception Engine (Spec S5 — Not Implemented)

| Requirement | Status |
|---|---|
| Gross NPA > 5% alert (per branch + bank-wide) | **Missing** — "Coming Soon" placeholder |
| CD ratio > 75% or < 60% alert | **Missing** |
| SLR % within 0.5% of minimum | **Missing** |
| No new accounts for 3 consecutive days (per branch) | **Missing** |
| Single withdrawal > Rs.10 lakh | **Missing** |
| NIM % drop > 0.3% in 30 days | **Missing** |
| Recovery target > 100% (positive indicator) | **Missing** |
| Configurable thresholds per bank (`dashboard_config` table) | **Missing** — 2 thresholds hardcoded in frontend |
| Severity badges (Critical / Warning / On Track) | **Missing** |
| Drill-down action links from alerts | **Missing** |

---

## 3. Missing KPI Panels (Spec S3)

### 3.1 Deposits & Liability — ~30% Done

| KPI | Status |
|---|---|
| Total deposits (Rs. Cr — today/MTD/YTD) | **Partial** — no MTD/YTD toggle |
| Deposit growth (% change vs last week/month) | **Missing** |
| New accounts opened (by type) | **Partial** — yearly only, not daily |
| FD maturing in 7 days (early warning) | **Missing** |

### 3.2 Advances & Credit — ~25% Done

| KPI | Status |
|---|---|
| Total advances outstanding | **Exists** |
| Disbursements today (Rs. Cr) | **Missing** |
| Loan applications pipeline (Received/Sanctioned/Pending/Rejected) | **Missing** |
| CD ratio (Credit-to-Deposit %) | **Missing** |

### 3.3 NPA & Recovery — ~40% Done

| KPI | Status |
|---|---|
| Gross NPA % | **Exists** (as NPA ratio) |
| Net NPA % | **Missing** |
| NPA breakdown (Sub-standard/Doubtful/Loss) | **Exists** |
| Overdue accounts > 90 days | **Missing** |
| Recovery today vs daily target | **Missing** |

### 3.4 Liquidity & Compliance — 0% Done

| KPI | Status |
|---|---|
| SLR % | **Missing** |
| CRR % | **Missing** |
| Liquidity surplus/deficit | **Missing** |

### 3.5 Income & Profitability — 0% Done

| KPI | Status |
|---|---|
| Interest income (today/MTD/YTD) | **Missing** |
| Interest expense (today/MTD/YTD) | **Missing** |
| Net Interest Margin (NIM %) | **Missing** |
| Operating cost vs budget | **Missing** |

### 3.6 Branch Performance — ~40% Done

| KPI | Status |
|---|---|
| Branch-wise deposits ranked | **Exists** |
| Branch-wise advances ranked | **Exists** |
| Branch-wise NPA % (flag > 5%) | **Missing** |
| Branch new accounts (flag 0 for 3+ days) | **Missing** |

---

## 4. Dashboard Layout (Spec S4 — ~30% Done)

| Requirement | Status |
|---|---|
| Row 1: 6 KPI tiles with delta vs previous period (color-coded) | **Partial** — cards exist but no deltas |
| Toggle: Today / This week / This month | **Missing** |
| Row 2: Deposits vs Advances 30-day line chart | **Missing** |
| Row 2: NPA donut chart (RBI classification) | **Exists** (pie chart) |
| Row 3: Branch-wise deposits horizontal bar (top 8-10) | **Partial** — exists but not ranked/limited |
| Row 3: Loan application pipeline bar chart | **Missing** |
| Row 4: Alerts table sorted by severity | **Missing** |

---

## 5. Filters & Drill-Downs (Spec S6 — ~20% Done)

| Requirement | Status |
|---|---|
| Date range: Today / This week / This month / Custom | **Partial** — custom only, no quick toggles |
| Branch/zone filter | **Partial** — branch exists, no zone grouping |
| Product type filter (SB/FD/RD/Current for deposits) | **Missing** |
| Product type filter (Retail/Gold/Housing/MSME/Agri for advances) | **Missing** |
| Click KPI tile -> side panel with 30-day trend | **Missing** |
| Click branch -> cross-filter all panels | **Missing** |
| Click alert -> open CBS report | **Missing** |

---

## 6. Data Architecture (Spec S7 — ~15% Done)

| Requirement | Status |
|---|---|
| Read-replica (never query primary transactional DB) | **Missing** — queries production DB directly |
| EOD batch job (6 PM, pre-compute derived metrics) | **Missing** — all queries are live |
| `dashboard_metrics` table (pre-computed snapshots) | **Missing** |
| `dashboard_config` table (thresholds per bank) | **Missing** |
| Response caching (1 hour) | **Missing** — 60-second polling |
| REST API: `/metrics/summary`, `/metrics/branch`, `/metrics/trends`, `/alerts` | **Partial** — different endpoint structure |

---

## 7. Additional CBS Tables Required

The current implementation uses ~7 tables. The following additional tables are needed to fulfill the spec:

| Purpose | Tables Needed |
|---|---|
| Transactions / Recovery | `tokentable`, `tokentable_credit`, `tokentable_debit` |
| Income / Expense / NIM | `gltable`, `gl` |
| NPA Detail | `npa_master_type`, `npa_recon` |
| Daily Disbursements | `loandisbursement` |
| Zone Grouping | `branchmaster` |
| SLR / CRR | `parameterinfo`, investment tables |
| Loan Application Pipeline | Loan workflow tables |
| Large Withdrawals (Alerts) | `tokentable` (amount-based filtering) |

---

## Summary Scorecard

| Spec Section | Coverage |
|---|---|
| S3.1 Deposits & Liability | ~30% |
| S3.2 Advances & Credit | ~25% |
| S3.3 NPA & Recovery | ~40% |
| S3.4 Liquidity & Compliance | **0%** |
| S3.5 Income & Profitability | **0%** |
| S3.6 Branch Performance | ~40% |
| S4 Layout & Visualizations | ~30% |
| S5 Alerts & Exceptions | **0%** |
| S6 Filters & Drill-Downs | ~20% |
| S7 Technical Architecture | ~15% |
| Security & Auth | **0%** |

**Overall: ~15-20% of the spec is implemented.**

The current dashboard is an early prototype covering basic account/deposit/advance counts and branch breakdowns, but lacks the core value propositions: alerts engine, liquidity/income panels, security, pre-computed data layer, and interactive drill-downs.
