# Profitability Metrics — Implementation Spec (Phase 1)

**Decision (2026-09-16):** build only what works for **every bank with no per-bank configuration**. Anything that needs someone to map GL heads by hand for each bank is deferred (§12).

**Verified on:**
- `ccbl260817` @ 192.168.5.30: 15 branches.
- `dnsb260806` @ 192.168.3.5: 16 branches, ~2.5× ccbl's deposits.

Name rules were also checked against `khattri20260719`'s chart of accounts. Every figure in §10 was produced by the rules below, run on both banks.

---

## 1. Scope

### In phase 1

| Metric | Basis | Accuracy vs a hand-mapped P&L |
|---|---|---|
| **Net Profit** | Period (YTD / FY / quarter / month) | Exact (§9 check) |
| Total income, total expenditure | Period | Exact |
| **Interest income, interest expense, Net Interest Income** | Period | Interest expense exact on both banks. Interest income within 0.8% (ccbl) / 0.1% (dnsb): small contra heads such as premium amortisation stay in other expenditure. |
| Other income, other expenditure | Period | Other expenditure = overheads + provisions + tax, labelled as such |
| **Cost of Funds** | Trailing 4 completed quarters ÷ current deposits | Labelled "on current deposits" |
| Deposits, advances, CD ratio | Closing (today) | Exact |
| **Gross NPA** (amount, %, by class) | Closing (today) | Exact |

### Not in phase 1

Operating Profit, Cost-to-Income, provisions (charged / held / required), Net NPA, PCR, average balances, yield on advances. See §12 for why and what was learned.

---

## 2. How it runs

All CBS reads happen in **background tasks inside the existing FastAPI backend**, next to `_lookup_refresh_task` in `backend/main.py`. Requests read only from memory.

| Item | Decision |
|---|---|
| Where | `asyncio.create_task(...)` in `startup()`, same as the existing tasks. No new service or container. |
| DB connection | A separate small pool (`minsize=1, maxsize=1`) for jobs, so a long query never holds a user request. |
| Storage | Module-level dicts. Safe because supervisord runs one uvicorn process with no `--workers`. If that ever changes, move the job out to a scheduled script writing to a table. |
| Load | Jobs run one query at a time, per branch, so the CBS database never has more than one heavy dashboard query in flight. |
| Before first run completes | Endpoint returns `503 {"warming_up": true}`. Other endpoints are unaffected. |

### Jobs and schedule

| Job | What | At startup | Then |
|---|---|---|---|
| A. P&L by month | §4 | Previous FY + current FY | Hourly: current FY. Daily: previous FY. |
| B. Balances | §5 | Yes | Hourly |
| C. Gross NPA | §6 | Yes | Hourly |
| D. Check | §9 | Yes | Daily |

**Measured query times:**

| Job | ccbl | dnsb (warm) | dnsb (cold server) |
|---|---|---|---|
| A: 15 months, all branches | 0.6 s | ~7 s (3 chunks) | up to ~25 s per chunk |
| B: balances | < 2 s | ~30 s | — |
| C: NPA | < 1 s | ~15 s | — |

---

## 3. Rules used everywhere

| Rule | Why |
|---|---|
| `COALESCE(TranDesc,0) <> 13` on `gl_recon` | Year-end closing entries clear every P&L head to zero. Without this filter every closed year shows 0. |
| `auth = 'Y'` | CBS reports only count authorised rows. |
| `TranDesc = 77` rows go to the month of `ValueDt` | Back-dated year-end adjustments belong to the period they relate to. |
| Exclude closed accounts (`accountmaster.AccStatus <> 9`) from balances | `reconbalan` keeps stale balances on closed accounts (dnsb: 490 closed loans, −₹32.3 L). |
| Branch = `SUBSTR(acno,1,2)` | Same on every table. `90` = head office. |
| **Query GL per branch**: `g.AcNo LIKE CONCAT(%(branch)s, '06%%')`, joining `gltable` → `gl_recon` | Uses the primary key. A whole-bank query timed out at 30 s on dnsb. |
| Signs: sum `CrAmt − DrAmt` | Income positive, expenditure negative; flip for display. |

`%` inside SQL strings must be written `%%` because aiomysql uses `%s` parameters.

---

## 4. Job A — P&L by month

### 4.1 Head names (once per run)

```sql
SELECT SUBSTR(AcNo,3,8) AS gl_code, MIN(TRIM(AcName)) AS head
FROM gltable
WHERE SUBSTR(AcNo,3,3) IN ('063','064')
GROUP BY gl_code;
```

`063*` = income, `064*` = expenditure. This holds in every bank checked.

### 4.2 Monthly totals (one query per branch)

Branch list: `SELECT DISTINCT SUBSTR(AcNo,1,2) FROM gltable`.

```sql
SELECT SUBSTR(g.AcNo,3,8)                                             AS gl_code,
       DATE_FORMAT(IF(r.TranDesc = 77, COALESCE(r.ValueDt, r.Dt), r.Dt),
                   '%%Y%%m')                                           AS ym,
       SUM(r.CrAmt - r.DrAmt)                                         AS net_credit
FROM gltable g
JOIN gl_recon r ON r.ACNo = g.AcNo
               AND r.Dt >= %(from_dt)s
WHERE g.AcNo LIKE CONCAT(%(branch)s, '06%%')
  AND SUBSTR(g.AcNo,3,3) IN ('063','064')
  AND r.auth = 'Y'
  AND COALESCE(r.TranDesc,0) <> 13
GROUP BY gl_code, ym;
```

`from_dt` = start of the FY being loaded (from `cbs_yearend.MINDATE`; the row with `YEARENDFLAG='N'` is the open year). Store the result as `pl_month[branch][gl_code][ym] = net_credit`.

### 4.3 Classifying heads by name (in Python, no config)

```python
import re

INTEREST     = re.compile(r"\b(INT|INTT|INTEREST)\b")
NOT_INTEREST = re.compile(r"\b(PROV|PROVISION|TAX|TDS|PENALTY)\b")
INTER_BRANCH = re.compile(r"\b(BRANCH|BRANCHES|BR|HO|H\.O|HEAD OFFICE)\b")

def classify(gl_code: str, head: str) -> dict:
    name = head.upper()
    is_interest = bool(INTEREST.search(name)) and not NOT_INTEREST.search(name)
    return {
        "side":         "income" if gl_code.startswith("063") else "expense",
        "interest":     is_interest,
        "inter_branch": is_interest and bool(INTER_BRANCH.search(name)),
    }
```

What the patterns catch:

| Pattern | Matches | Deliberately doesn't match |
|---|---|---|
| `INTEREST` | "INT. REC. ON INVEST", "INT PAID ON SB", "INTT RECEIVED - LOAN ADVANCE", "INTT. RECD - FDRS OTHER BANKS", "INTEREST RECEIVED FROM DFHI", "PENAL INTT - OVERDRAFT" | "PRINTING & STATIONERY", "MAINTENANCE", "ENTERTAINMENT", "INTERNET" (the whole-word match rules these out) |
| `NOT_INTEREST` | Excludes "PROVISION FOR OD INTEREST" (dnsb), "INTEREST FROM INCOME-TAX" (ccbl), "INTEREST ON TDS" (khattri), "EMPLOYEES PF/ INTT/PENALTY" (khattri) | Keeps "…STAFF ADVANCE PROVISIONAL" (khattri); whole-word only |
| `INTER_BRANCH` (interest heads only) | ccbl "INTEREST RECEIVED FROM HO", "CO INTEREST RECEIVED FROM BRANCHES", "INTEREST PAID TO BRANCHES", "INTEREST PAID TO HO"; dnsb "INTEREST RECEIVED FROM BRANCHES", "INTEREST PAID TO BR/HO"; khattri "INTT RECEIVED- HEAD OFFICE", "INTT PAID - KARKARDOOMA BRANCH", "INTT. PAID TO H.O." | "…STAFF ADVANCE HOUSING" (whole-word only) |

Inter-branch interest is transfer pricing between HO and branches. At bank level the income and expense sides are equal to the rupee (ccbl ₹8.37 Cr, dnsb ₹22.40 Cr each side for FY25-26), so they cancel.

### 4.4 Aggregating a period

`total`/`interest` must always equal the raw GL sum — **every head is added, regardless of
its inter-branch classification.** Early phase-1 code special-cased matched inter-branch
heads out of `total`/`interest` at bank level; that broke Net Profit the moment one side of
a transfer-pricing pair had a GL head name that didn't fit the BRANCH/BR/HO convention (seen
on a 4th bank whose expense-side head name was truncated to `...FROM B`, so only the income
side matched — Net Profit came out ~₹7.7 Cr short for a closed FY). The name rules in §4.3
are best-effort per bank and must never be load-bearing for a number that has to reconcile
exactly.

```
for (branch, gl_code, ym) in pl_month, where ym is in the period and branch is in scope:
    c = classification[gl_code]
    amount = net_credit            if c.side == "income"
           = −net_credit           if c.side == "expense"

    total[c.side] += amount
    if c.interest: interest[c.side] += amount
    if c.inter_branch and bank level (no branch requested): ib[c.side] += amount   # display-only
```

`ib` is never subtracted from `total`/`interest` directly. For **display** figures only
(Total income/expenditure, Interest income/expense, and the quarterly series Cost of Funds
reads from), subtract `ib_matched = min(ib.income, ib.expense)` from *both* sides:

```
display_income  = total.income  − ib_matched
display_expense = total.expense − ib_matched
```

Subtracting the same amount from both sides of a difference leaves the difference unchanged,
so **Net Profit and NII are computed from the uncapped `total`/`interest` and are exact by
construction, independent of how well the name rules matched this bank's chart of accounts.**
Only the standalone magnitudes (Total income, Total expenditure, Cost of Funds) can be
slightly off when a naming mismatch caps `ib_matched` below the true inter-branch amount —
and the §9 check surfaces exactly that case as a warning.

---

## 5. Job B — Deposits and advances (closing)

Classification uses `accounttypemaster.acctNature`, which every bank has. The CA nature holds both current accounts and CC/OD, so it is split **per account by balance sign**: credit balance = deposit, debit balance = advance.

```sql
-- SB, RD, TL, DL
SELECT SUBSTR(b.acno,1,2) AS branch, t.acctNature AS nature, SUM(b.Balance) AS bal
FROM reconbalan b
JOIN accountmaster     am ON am.ACNo    = b.acno
JOIN accounttypemaster t  ON t.AcctCode = am.Accttype
WHERE am.AccStatus <> 9
GROUP BY branch, nature;

-- CA / CC / OD, split by sign
SELECT SUBSTR(b.acno,1,2) AS branch,
       SUM(GREATEST(b.Balance, 0)) AS credit_bal,
       SUM(LEAST(b.Balance, 0))    AS debit_bal
FROM ca_reconbalan b
JOIN accountmaster am ON am.ACNo = b.acno
WHERE am.AccStatus <> 9
GROUP BY branch;

-- FD: principal plus capitalised interest
SELECT SUBSTR(acno,1,2) AS branch, SUM(cramt - dramt) AS bal
FROM td_recon
WHERE auth = 'Y' AND closeflag IS NULL AND dt < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
GROUP BY branch;
```

```
deposits = SB + RD + FD + CA credit balances
advances = −(TL + DL) + |CA debit balances|
```

| Source | Why |
|---|---|
| `td_recon` with `closeflag IS NULL`, not `td_vouchmst.PrinAmt` | `PrinAmt` misses interest added to cumulative FDs (ccbl ₹37.75 Cr vs ₹39.02 Cr). `closeflag='C'` rows are memo entries written at closure and must be excluded. |
| `acctNature`, not `accounttypemaster.GLHead` | In dnsb, two CC/OD products post to liability GL heads. |
| Unknown natures | If the first query returns any nature other than SB/RD/TL/DL/CA/FD/PO with a non-zero balance, add it to `warnings`. It won't be counted. |

---

## 6. Job C — Gross NPA (closing)

```sql
SELECT SUBSTR(am.ACNo,1,2)                         AS branch,
       am.AccStatus                                AS status,     -- 11 Sub-Standard, 12 Doubtful, 13 Loss
       COUNT(*)                                    AS accounts,
       SUM(-COALESCE(rb.Balance, cb.Balance, 0))   AS outstanding
FROM accountmaster am
LEFT JOIN reconbalan    rb ON rb.acno = am.ACNo
LEFT JOIN ca_reconbalan cb ON cb.acno = am.ACNo
WHERE am.AccStatus IN (11, 12, 13)
GROUP BY branch, status;
```

- The asset class comes from `accountmaster.AccStatus` (`AccStatusEnum` in CBS), **not** `cbs_loan_borrower_details.NPA_CLASSIFICATION`, which holds legal/recovery codes and includes closed loans.
- Includes CC/OD accounts through `ca_reconbalan`. In dnsb these are ₹3.80 Cr of the ₹25.48 Cr.

---

## 7. Metric formulas

| Metric | Formula | Label on screen |
|---|---|---|
| Total income | `total.income` (inter-branch excluded at bank level) | |
| Interest income | `interest.income` | |
| Other income | `total.income − interest.income` | |
| Total expenditure | `total.expense` | |
| Interest expense | `interest.expense` | |
| Other expenditure | `total.expense − interest.expense` | "incl. provisions & tax" |
| **Net Interest Income** | `interest.income − interest.expense` | |
| **Net Profit** | `total.income − total.expense` | Closed years: "per GL, before post-close adjustments" |
| **Cost of Funds %** | `interest.expense over the last 4 completed quarters ÷ current deposits × 100` | "Trailing 12 months to <quarter end>, on current deposits" |
| Deposits, Advances | §5 | "As of <refresh time>" |
| CD Ratio % | `advances ÷ deposits × 100` | |
| **Gross NPA** | `Σ outstanding` by class | |
| **Gross NPA %** | `gross_npa ÷ advances × 100` | |

### Periods

| Period | Months |
|---|---|
| YTD (default) | FY start → current month |
| Prior-year comparison | Same months, one year earlier |
| FY | 12 months of a closed FY |
| Trend | Monthly or quarterly series for the current and previous FY |

**Interest is posted quarterly.** On both banks, deposit interest and investment income are booked only in Jun/Sep/Dec/Mar. ccbl also reverses its March accrual in April. So:
- Monthly charts of interest income, interest expense, NII and Net Profit are step-shaped. Default the trend chart to **quarters**.
- Cost of Funds uses whole quarters only (hence trailing 4 completed quarters).
- YTD vs prior-year YTD is still a fair comparison, because both cover the same months.

---

## 8. API and frontend

### 8.1 Endpoint

`GET /api/metrics/profitability?branch=&period=ytd|fy&fy=2025`

```json
{
  "as_of":        {"pl": "2026-09-16T10:00:00", "balances": "2026-09-16T10:00:00", "npa": "2026-09-16T10:00:00"},
  "period":       {"type": "ytd", "from": "2026-04-01", "to": "2026-09-30"},
  "branch":       null,
  "pl":           {"total_income": 0, "interest_income": 0, "other_income": 0,
                   "total_expenditure": 0, "interest_expense": 0, "other_expenditure": 0,
                   "nii": 0, "net_profit": 0},
  "pl_prior":     {"...": "same keys, same months last year"},
  "trend":        [{"period": "2025-Q1", "interest_income": 0, "interest_expense": 0, "nii": 0, "net_profit": 0}],
  "balances":     {"deposits": {"sb": 0, "rd": 0, "fd": 0, "ca": 0, "total": 0},
                   "advances": {"tl": 0, "dl": 0, "cc_od": 0, "total": 0}},
  "npa":          {"gross": 0, "gross_pct": 0,
                   "by_class": {"sub_standard": {"accounts": 0, "amount": 0},
                                "doubtful":     {"accounts": 0, "amount": 0},
                                "loss":         {"accounts": 0, "amount": 0}}},
  "ratios":       {"cost_of_funds_pct": 0, "cost_of_funds_window": "2025-07-01..2026-06-30", "cd_ratio_pct": 0},
  "inter_branch": {"income": 0, "expense": 0, "heads": ["06302721", "..."], "check": "ok"},
  "interest_heads": [{"gl_code": "06302601", "head": "INT. REC. ON INVEST", "side": "income"}],
  "warnings":     []
}
```

`interest_heads` and `inter_branch.heads` are returned so anyone can see which heads the name rules picked, without a config file.

### 8.2 Tiles

| Tile | Value | Sub-text |
|---|---|---|
| Net Profit | YTD | vs same period last year |
| Net Interest Income | YTD | interest income / interest expense |
| Cost of Funds | % | trailing 12 months to <quarter end> |
| Gross NPA | % | ₹ amount, number of accounts |
| CD Ratio | % | deposits / advances |

Plus a small P&L table (§7 lines) and a quarterly trend chart.

---

## 9. Checks (run at the end of each job)

| Check | Rule | On failure |
|---|---|---|
| Closed-FY Net Profit | Per branch, sum the TranDesc-13 rows for the previous FY (query below). Negated, the total must equal Net Profit from `pl_month` for that FY. | Since §4.4's fix, `total.income − total.expense` always equals the raw GL sum, so this should now only fail for a genuine data/filter bug (e.g. a missing month, a bad `auth`/`TranDesc` filter) — not for an inter-branch naming mismatch. Add a warning; investigate the filter. |
| Inter-branch balance | At bank level for the period, inter-branch income = inter-branch expense (±₹1) | `inter_branch.check = "mismatch"` + warning. Net Profit and NII are always exact (§4.4) regardless of this check. Total income/expenditure and Cost of Funds use `min(ib.income, ib.expense)`, so they're capped to the matched side and may be off by the unmatched remainder — check `interest_heads` in the response to see which GL head didn't get classified on both sides, and fix the head name in the CBS chart of accounts rather than patching the dashboard. |
| Unknown natures | §5 | Warning |

```sql
SELECT -SUM(r.CrAmt - r.DrAmt) AS net_profit_check
FROM gltable g
JOIN gl_recon r ON r.ACNo = g.AcNo
               AND r.Dt >= %(fy_start)s AND r.Dt < DATE_ADD(%(fy_end_excl)s, INTERVAL 7 DAY)
WHERE g.AcNo LIKE CONCAT(%(branch)s, '06%%')
  AND SUBSTR(g.AcNo,3,3) IN ('063','064')
  AND r.TranDesc = 13;
```

---

## 10. Expected results (for testing)

Point the backend at each database; the endpoint must return these figures.

### 10.1 FY 2025-26, bank level

| Line | ccbl ₹ | ccbl ₹ Cr | dnsb ₹ | dnsb ₹ Cr |
|---|---:|---:|---:|---:|
| Total income | 17,63,53,597.87 | 17.64 | 33,77,63,838.32 | 33.78 |
| Interest income | 14,17,58,845.15 | 14.18 | 32,83,56,524.02 | 32.84 |
| Other income | 3,45,94,752.72 | 3.46 | 94,07,314.30 | 0.94 |
| Total expenditure | 15,56,07,659.48 | 15.56 | 33,12,09,657.84 | 33.12 |
| Interest expense | 4,97,56,080.96 | 4.98 | 16,69,91,324.02 | 16.70 |
| Other expenditure | 10,58,51,578.52 | 10.59 | 16,42,18,333.82 | 16.42 |
| **Net Interest Income** | 9,20,02,764.19 | **9.20** | 16,13,65,200.00 | **16.14** |
| **Net Profit** | 2,07,45,938.40 | **2.07** | 65,54,180.48 | **0.66** |
| Inter-branch (each side, excluded) | 8,36,69,868.61 | 8.37 | 22,39,92,760.00 | 22.40 |
| Check: reversed closing entries | 2,07,45,938.40 ✓ | | 65,54,180.48 ✓ | |

### 10.2 Balances, NPA and ratios

| Item | ccbl (snapshot 2026-08-17) | dnsb (snapshot 2026-08-06) |
|---|---:|---:|
| SB | 93.86 | 186.10 |
| RD | 0.54 | 1.57 |
| FD | 39.02 | 175.01 |
| CA credit balances | 12.01 | 9.67 |
| **Deposits** | **145.43** | **372.35** |
| TL | 17.15 | 133.68 |
| DL | 0.72 | 1.51 |
| CA debit balances | 12.33 | 7.94 |
| **Advances** | **30.19** | **143.14** |
| CD Ratio | 20.76% | 38.44% |
| Gross NPA: Sub-Std / Doubtful / Loss | 0 / 4.60 / 0.11 | 4.29 / 5.65 / 15.54 |
| **Gross NPA** (accounts) | **4.71** (21) | **25.48** (1,501) |
| **Gross NPA %** | **15.59%** | **17.80%** |
| Interest expense, Jul-2025 → Jun-2026 | 5.08 | 16.55 |
| **Cost of Funds** | **3.49%** | **4.45%** |

All amounts ₹ Cr.

---

## 11. Changes to existing endpoints (`backend/main.py`)

Do these in the same change, or the dashboard will show two different Gross NPA figures.

| Location | Issue | Fix |
|---|---|---|
| `get_advances`, `get_alerts` | NPA uses `cbs_loan_borrower_details.NPA_CLASSIFICATION`, and `NPA_LABELS` maps `SF`/`PB`/`SFRC` to Sub-Standard/Doubtful/Loss. They are suit-filed/protested-bill/recovery codes, and the loans carrying them are closed. | Use Job C (§6). |
| `get_advances`, `get_alerts` | NPA % on `SANCTION_AMT` | Outstanding balances (§5, §6) |
| `get_alerts` CD ratio | Sanctioned amount ÷ FD principal only | §7 CD ratio |
| `get_deposits`, `get_alerts` | FD amounts from `td_vouchmst.PrinAmt` | `td_recon`, `closeflag IS NULL` (§5) |
| Balance queries | Include closed accounts | `AccStatus <> 9` |
| `get_advances` `overdue_90d` | "No transaction in 90 days" is dormancy, not 90 days overdue | Relabel as dormant |
| `DB_CONFIG` | Falls back to `basti20260603` when `.env` is missing | Fail fast |

---

## 12. Deferred, and what was learned

Each of these was investigated and works, but needs per-bank configuration or a heavier job. Pick them up only if a bank asks.

| Metric | Why deferred | Notes for later |
|---|---|---|
| Operating Profit, Cost-to-Income | Needs provisions and tax separated from overheads. Names aren't reliable: "PROVIDENT FUND", "INCOME TAX CONSULTANT FEE", "OFFICE RENT/TAX CHARGES", "LEAVE ENCASHMENT PROVISION". The same code means different things across banks (`06402901` is an investment provision in ccbl and a loss on non-banking assets in dnsb). Reserve write-backs are also routed through income (ccbl IFR→IDR ₹1.08 Cr). | Needs a per-bank GL head → bucket map. |
| Provisions held, Net NPA, PCR | Reserve heads differ per bank and get renamed (dnsb moved BDDR to a new head "BDDR 2024" on 2026-03-31; ccbl `06103195` is an NPA provision, dnsb `06103195` is General Reserve). | **Never deduct the Overdue Interest Reserve in Net NPA.** It equals the `npa_recon` memo balance exactly (ccbl ₹2.62 Cr, dnsb ₹104 Cr) and is not part of the loan balance. |
| Required provision | Needs NPA age and security value, plus rates confirmed by each bank's auditor. | NPA and Doubtful dates come from `accountstatus` (`SPFLAG` 11/12/13, `EFFDT`). That table has no `acno` index, so read it in one grouped pass (17 s for 1,501 accounts on dnsb). Security: `loansecurity.matvalue` where `Status='ACTIVE'`. |
| Average balances, yield on advances | Needs a ledger rebuild job (~1 min per large bank). | Month-end balances = cumulative `SUM(cramt − dramt)` per month from `recon`, `ca_recon`, `rdrecon`, `loan_recon`, `td_recon` (`closeflag IS NULL`), chunked by branch. Reconciles to the balance tables. |

`backend/scripts/profitability_reference.py` implements the earlier per-bank-config design on ccbl and is kept only as a reference for this section.
