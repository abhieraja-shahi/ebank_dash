# P&L Metrics — Derivation Methodology

**Verified against:** `ccbl260817` @ 192.168.5.30, 2026-09-16
**Purpose:** Source the five UCB profitability metrics — NII, Cost of Funds, NPA Provisions, Operating vs Net Profit, Cost-to-Income — from the CBS general ledger.

---

## 1. Where the data lives

| Table | Role |
|---|---|
| `gl_recon` | **GL transaction ledger.** ~37M rows, 2022-04-01 → present. This is the P&L source. |
| `gltable` | GL account → name map (`AcNo`, `AcName`, `CrDrFlag`). |
| `glbmast` | Grouped chart of accounts (`GroupCode`, `SubGroupCode`, `Description`). |
| `recon` | SB/customer account transactions. **Not** the GL — contains no P&L heads. |
| `reconbalan` | Per-account current balance + monthly buckets `M01`–`M12`. Source for SB deposits. |
| `ca_reconbalan` | Current-account balances. Negative balance = overdraft, not a deposit. |
| `td_vouchmst` | Term deposit vouchers. `PrinAmt` where `Status='A'` = live FD principal. |
| `npa_master_type` | RBI provisioning percentages per asset classification. |

### GL account number shape

GL `ACNo` is `varchar(12)`, composed as:

```
  90      06302601      01
  └┬─┘    └────┬───┘    └┬┘
branch    GL code(8)   suffix
```

- `SUBSTR(AcNo,1,2)` → branch code (`90` = head office)
- `SUBSTR(AcNo,3,8)` → GL code, the thing you bucket on
- `063*` → **income** heads (~59 per branch)
- `064*` → **expenditure** heads (~100 per branch)
- `061*` liabilities, `062*` assets

### Query performance

`gl_recon` PK is `(ACNo, Dt, recno)`. **Always drive the query off `ACNo`** by joining to `gltable`. A bare `WHERE Dt BETWEEN ...` scan times out at 30s; the same query joined through `gltable` returns in under a second.

```sql
-- Good: index-driven
FROM gltable g JOIN gl_recon r ON r.ACNo = g.AcNo
WHERE SUBSTR(g.AcNo,3,3) IN ('063','064') AND r.Dt >= ...

-- Bad: full scan, times out
FROM gl_recon r WHERE SUBSTR(r.ACNo,3,3) IN ('063','064') AND r.Dt >= ...
```

---

## 2. Two traps that silently zero every number

### Trap 1 — the year-end closing entry

At financial year end, every P&L head is zeroed by a single transfer to the P&L control account. A naive `SUM(CrAmt) - SUM(DrAmt)` over a **closed** financial year therefore returns exactly `0.00` for every head.

Example — `06302601` INT. REC. ON INVEST, FY 2025-26: 43 credit postings totalling ₹9.84 Cr, then one closing row:

| Dt | DrAmt | Ty | TranDesc | Details |
|---|---|---|---|---|
| 2026-03-30 | 98,414,934 | 1 | **13** | `Trf On 31/03/2026 For Period 01/04/2025 To 31/03/2026` |

**Filter with `TranDesc <> 13`.** Do not filter on the `Details` text — the wording varies by head and by year (`TRF TO PROFIT`, `Trf On …`, and others), and a text filter silently lets closing entries through, which is indistinguishable from the head having no activity.

```sql
AND COALESCE(r.TranDesc, 0) <> 13
```

### Trap 2 — inter-branch transfer pricing

Four heads are internal transfer-price entries that match each other to the rupee:

| Income head | | Expense head | FY25-26 |
|---|---|---|---|
| `06302721` Interest received from HO | ↔ | `06402051` Interest paid to branches | ₹8.08 Cr |
| `06302722` CO interest received from branches | ↔ | `06402151` Interest paid to HO | ₹0.29 Cr |

At bank level they cancel. **Include them in per-branch views; exclude them from any consolidated total** — otherwise interest income is overstated by more than half (₹22.8 Cr instead of ₹14.2 Cr).

### A third thing to know: deposits are not in the GL

The deposit liability heads (`06100231` SAVING BANK, `06100132` CURRENT ACCOUNT, `06101131` FIXED DEPOSIT …) carry **no balances** — their last postings are from 2022-23 and net to zero. Deposits live in the subsidiary ledgers only. Any Cost of Funds or NIM denominator must come from §4.

---

## 3. GL code buckets

| Bucket | GL codes (`SUBSTR(AcNo,3,8)`) |
|---|---|
| Interest income | `063025*`, `063026*`, plus `06302740` (SIDBI refinance) |
| *— inter-branch, exclude at bank level* | `06302721`, `06302722` |
| Other income | remainder of `063*` |
| Interest expense | `06402001` … `06402153` |
| *— inter-branch, exclude at bank level* | `06402051`, `06402151` |
| Provisions | `06402700` bad debts w/o, `06402850`, `06402900`, `06402901`, `06402950`, `06403001`, `06403002`, `06403003` |
| Tax | `06403100`, `06402364`, `06402365` |
| P&L control — **always exclude** | `06402000`, `06499999` |
| Operating expense | remainder of `064*` |

The `06402000` P&L control account sits inside the interest-expense numeric range, so it must be excluded explicitly — the range starts at `06402001`, not `06402000`.

---

## 4. Queries

### 4.1 Master P&L query

Returns one row per bucket for a financial year. Drop the `NOT IN` clause and add `SUBSTR(g.AcNo,1,2) AS branch` to the GROUP BY for a per-branch view.

```sql
SELECT
  CASE
    WHEN SUBSTR(g.AcNo,3,6) IN ('063025','063026')
      OR SUBSTR(g.AcNo,3,8) = '06302740'              THEN 'interest_income'
    WHEN SUBSTR(g.AcNo,3,3) = '063'                   THEN 'other_income'
    WHEN SUBSTR(g.AcNo,3,8) BETWEEN '06402001' AND '06402153'
                                                      THEN 'interest_expense'
    WHEN SUBSTR(g.AcNo,3,8) IN ('06402700','06402850','06402900',
                                '06402901','06402950','06403001',
                                '06403002','06403003')THEN 'provisions'
    WHEN SUBSTR(g.AcNo,3,8) IN ('06403100','06402364','06402365')
                                                      THEN 'tax'
    ELSE 'operating_expense'
  END                                    AS bucket,
  SUM(r.CrAmt - r.DrAmt)                 AS net_credit,   -- income: positive
  SUM(r.DrAmt - r.CrAmt)                 AS net_debit,    -- expense: positive
  COUNT(*)                               AS txns
FROM gltable g
JOIN gl_recon r ON r.ACNo = g.AcNo
WHERE SUBSTR(g.AcNo,3,3) IN ('063','064')
  AND r.Dt >= %(fy_start)s                          -- '2025-04-01'
  AND r.Dt <  %(fy_end)s                            -- '2026-04-01'
  AND COALESCE(r.TranDesc, 0) <> 13                 -- Trap 1
  AND SUBSTR(g.AcNo,3,8) NOT IN ('06402000','06499999')
  AND SUBSTR(g.AcNo,3,8) NOT IN ('06302721','06302722',
                                 '06402051','06402151')  -- Trap 2
GROUP BY bucket;
```

For a **monthly trend**, add `DATE_FORMAT(r.Dt,'%Y%m') AS period` to the SELECT and GROUP BY. For **MTD/YTD**, move `fy_start`/`fy_end`.

### 4.2 Head-level detail (drill-down)

```sql
SELECT SUBSTR(g.AcNo,3,8)      AS gl_code,
       MIN(TRIM(g.AcName))     AS head,
       SUM(r.CrAmt - r.DrAmt)  AS net_credit
FROM gltable g
JOIN gl_recon r ON r.ACNo = g.AcNo
WHERE SUBSTR(g.AcNo,3,3) = %(prefix)s              -- '063' or '064'
  AND r.Dt >= %(fy_start)s AND r.Dt < %(fy_end)s
  AND COALESCE(r.TranDesc, 0) <> 13
GROUP BY gl_code
HAVING ABS(net_credit) > 100000
ORDER BY net_credit DESC;
```

### 4.3 Deposit base (Cost of Funds denominator)

```sql
-- Savings
SELECT SUM(rb.Balance) AS sb_balance
FROM accountmaster am
JOIN accounttypemaster atm ON am.Accttype = atm.AcctCode
JOIN reconbalan rb        ON rb.acno      = am.ACNo
WHERE atm.acctNature = 'SB';

-- Current (credit balances only — debit balances are overdrafts)
SELECT SUM(CASE WHEN Balance > 0 THEN Balance ELSE 0 END) AS ca_balance,
       SUM(CASE WHEN Balance < 0 THEN -Balance ELSE 0 END) AS ca_overdraft
FROM ca_reconbalan;

-- Term deposits
SELECT SUM(PrinAmt) AS fd_principal
FROM td_vouchmst WHERE Status = 'A';
```

Total deposits = `sb_balance + ca_balance + fd_principal + rd_balance`.

> **Point-in-time vs average.** These give *closing* balances. Cost of Funds is properly `interest_expense / average deposits`. The monthly buckets `M01`–`M12` on `reconbalan` are the intended source for a 12-point average; until that is wired up, closing balance is a usable approximation — label it as such on the dashboard rather than implying it is the RBI-basis figure.

### 4.4 Required vs actual NPA provision

`npa_master_type` holds the RBI provisioning percentages per classification (`PROV_STD`, `PROV_SUBSTD`, `PROV_DBT1/2/3`, `PROV_LOSS`, each with secured `S_` and unsecured `U_` variants) keyed by `ACCTCODE`. Applying these to the outstanding balances in `cbs_loan_borrower_details.NPA_CLASSIFICATION` gives **required** provision, which can be compared against the **actual** ₹1.08 Cr booked in the `provisions` bucket.

The gap between the two is usually the single most useful number on a UCB profitability page, and nothing in the dashboard surfaces it today.

---

## 5. Metric formulas

```
NII                = interest_income − interest_expense
Net Operating Income = NII + other_income
Operating Profit   = Net Operating Income − operating_expense
Net Profit         = Operating Profit − provisions − tax

Cost of Funds  (%) = interest_expense  / average_deposits        × 100
Cost-to-Income (%) = operating_expense / Net Operating Income    × 100
NIM            (%) = NII / average_earning_assets                × 100
```

Operating Profit and Net Profit are reported as **two separate tiles**, never collapsed into one "profit" figure — the whole point is to show how much of the operating result provisions consume.

---

## 6. Worked result — FY 2025-26

| Line | ₹ Cr |
|---|---:|
| Interest income | 14.18 |
| Interest expense | 4.98 |
| **Net Interest Income** | **9.20** |
| Other income | 3.46 |
| *Net Operating Income* | *12.66* |
| Operating expense | 8.90 |
| **Operating Profit** | **3.76** |
| Provisions | 1.08 |
| Tax | 0.60 |
| **Net Profit** | **2.08** |

| Ratio | |
|---|---:|
| Cost of Funds (closing-balance basis, ~₹144 Cr deposits) | ~3.5% |
| Cost-to-Income | 70.3% |

Deposit base: SB ₹93.86 Cr + FD ₹37.75 Cr + CA ₹12.01 Cr + RD.

Two figures inside these totals are worth a caveat before they are published as-is:

- **`06302984` EXCESS IFR TRF TO IDR — ₹1.08 Cr**, sitting in `other_income`. This is a reserve reversal, not operating income. Including it flatters both Net Profit and Cost-to-Income. Consider a separate `non_operating_income` bucket.
- **Provisions of ₹1.08 Cr came from a single transaction**, and tax from four. Year-end manual journals of this kind are normal, but it means the provisions figure is not a smooth accrual and will look like a step function on any monthly trend chart.

---

## 7. Implementation notes

- Backend connects via `Dashboard/backend/.env` (`DB_HOST=192.168.5.30`, `DB_NAME=ccbl260817`). The DBeaver MCP connection named `192.168.5.30` reaches the same server for ad-hoc verification.
- Query 4.1 runs in ~0.5s for a full year across all branches — fast enough to serve live behind the existing `TTLCache`, at the 5-minute `_metrics_cache` TTL used by the other metrics endpoints.
- Financial year runs 1 April → 31 March. `yearend` / `cbs_yearend` hold `MINDATE`/`MAXDATE`/`F_YEAR` per branch and are the authoritative source for FY boundaries rather than hardcoding April.
- Prior-year comparison: run 4.1 twice with shifted dates. Years before the current one are fully closed, so their figures are stable and cacheable indefinitely.
