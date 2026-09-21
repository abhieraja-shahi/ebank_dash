import asyncio
import hashlib
import os
import re
import secrets
from datetime import date, datetime, timedelta
from typing import Optional

import aiomysql
from cachetools import TTLCache
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="CBS KPI Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if not os.getenv("DB_NAME"):
    raise RuntimeError(
        "DB_NAME is not set (backend/.env missing or incomplete). "
        "Refusing to start with a fallback database name."
    )

DB_CONFIG = {
    "host":       os.getenv("DB_HOST", "192.168.5.30"),
    "port":       int(os.getenv("DB_PORT", "3306")),
    "user":       os.getenv("DB_USER", "root"),
    "password":   os.getenv("DB_PASSWORD", ""),
    "db":         os.getenv("DB_NAME"),
    "autocommit": True,
    "cursorclass": aiomysql.DictCursor,
    "minsize":    2,
    "maxsize":    10,
}

ACC_STATUS_LABELS = {
    1: "Active",  2: "Inoperative",  3: "Suit Filed",    4: "Frozen",
    5: "Recalled", 6: "Decreed",     7: "Withdrawal Stopped", 8: "Operation Stopped",
    9: "Closed",  10: "Lien",        11: "Sub-Standard", 12: "Doubtful",
    13: "Loss",   14: "Protested Bill", 15: "DEAF",
}

# ── Global state ──────────────────────────────────────────────────────────────

pool: aiomysql.Pool = None

# Preloaded at startup; refreshed every hour by background task
BRANCH_NAMES: dict = {}
ACCT_NAMES:   dict = {}

# In-memory session store: token → {userId, userName, levelId, brncode, expires}
SESSIONS: dict = {}

LEVEL_NAMES = {
    1: "Super User / DBA",
    2: "Manager",
    3: "Asst. Manager",
    4: "Officer",
    5: "Clerk",
}

# ── Caches (TTL in seconds) ───────────────────────────────────────────────────
# keyed by (endpoint, *params)

_static_cache  = TTLCache(maxsize=16,  ttl=3600)   # branches, bank-info  — 1 hr
_metrics_cache = TTLCache(maxsize=128, ttl=300)    # accounts/deposits/advances/kyc — 5 min
_alerts_cache  = TTLCache(maxsize=32,  ttl=120)    # alerts — 2 min


# ── Startup / shutdown ────────────────────────────────────────────────────────

async def _load_lookups():
    """Preload branch and account-type name dicts from DB into memory."""
    global BRANCH_NAMES, ACCT_NAMES
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT BrnCode, BranchName FROM branchmaster")
            rows = await cur.fetchall()
            BRANCH_NAMES = {str(r["BrnCode"]).zfill(2): r["BranchName"] for r in rows}

            await cur.execute("SELECT AcctCode, AcctDesc FROM accounttypemaster")
            rows = await cur.fetchall()
            ACCT_NAMES = {str(r["AcctCode"]): r["AcctDesc"].strip().title() for r in rows}


async def _session_cleanup_task():
    """Sweep expired sessions every 30 minutes."""
    while True:
        await asyncio.sleep(1800)
        now = datetime.utcnow()
        expired = [t for t, s in SESSIONS.items() if s["expires"] < now]
        for t in expired:
            SESSIONS.pop(t, None)


async def _lookup_refresh_task():
    """Reload branch/acct names from DB every hour."""
    while True:
        await asyncio.sleep(3600)
        try:
            await _load_lookups()
        except Exception:
            pass


# ── Profitability metrics (background jobs) ───────────────────────────────────
# See PROFITABILITY_METRICS_METHODOLOGY.md. Jobs read from a dedicated 1-connection
# pool so a long P&L / balance / NPA query never holds up a user request, and write
# into the module-level dicts below. Requests only ever read from memory.

INTEREST_RE     = re.compile(r"\b(INT|INTT|INTEREST)\b")
NOT_INTEREST_RE = re.compile(r"\b(PROV|PROVISION|TAX|TDS|PENALTY)\b")
INTER_BRANCH_RE = re.compile(r"\b(BRANCH|BRANCHES|BR|HO|H\.O|HEAD OFFICE)\b")


def _classify_pl_head(gl_code: str, head: str) -> dict:
    name = (head or "").upper()
    is_interest = bool(INTEREST_RE.search(name)) and not NOT_INTEREST_RE.search(name)
    return {
        "side":         "income" if gl_code.startswith("063") else "expense",
        "interest":     is_interest,
        "inter_branch": is_interest and bool(INTER_BRANCH_RE.search(name)),
    }


profit_pool: aiomysql.Pool = None

PL_HEADS: dict    = {}   # gl_code -> head name
PL_CLASS: dict    = {}   # gl_code -> {side, interest, inter_branch}
PL_MONTH: dict    = {}   # branch -> gl_code -> "YYYYMM" -> net_credit (CrAmt - DrAmt)
PL_BRANCHES: list = []

FY_INFO: dict = {"current": None, "prior": None}  # {"from": "YYYY-MM-DD", "to_excl": "YYYY-MM-DD", "f_year": int}

BALANCES: dict = {}   # branch -> {sb, rd, tl, dl, fd, ca_credit, ca_debit, deposits, advances}
NPA: dict      = {}   # branch -> {11: {accounts, amount}, 12: {...}, 13: {...}}

NPA_CLASS_LABELS = {11: "sub_standard", 12: "doubtful", 13: "loss"}
KNOWN_ACCT_NATURES = {"SB", "RD", "TL", "DL", "CA", "FD", "PO"}

PROFIT_STATUS = {"ready": False, "pl_as_of": None, "balances_as_of": None, "npa_as_of": None}
PROFIT_CHECKS: dict = {}
PROFIT_WARNINGS: list = []


def _fmt_yyyymmdd(d8: str) -> str:
    return f"{d8[:4]}-{d8[4:6]}-{d8[6:8]}"


def _fy_ym_bounds(fy: dict) -> tuple[str, str]:
    """(from_ym, to_ym) both inclusive, 'YYYYMM', for an FY_INFO window."""
    from_ym = fy["from"][:4] + fy["from"][5:7]
    last_day = date.fromisoformat(fy["to_excl"]) - timedelta(days=1)
    to_ym = f"{last_day.year:04d}{last_day.month:02d}"
    return from_ym, to_ym


def _fy_last_day(fy: dict) -> str:
    return (date.fromisoformat(fy["to_excl"]) - timedelta(days=1)).isoformat()


def _ym_quarter(ym: str) -> str:
    """'YYYYMM' -> Indian-FY quarter label, e.g. '202607' -> '2026-Q2' (Apr-Jun = Q1)."""
    year, month = int(ym[:4]), int(ym[4:6])
    if month >= 4:
        f_year, q = year, (month - 4) // 3 + 1
    else:
        f_year, q = year - 1, (month + 8) // 3 + 1
    return f"{f_year}-Q{q}"


def _quarter_sort_key(label: str):
    y, q = label.split("-Q")
    return (int(y), int(q))


def _quarter_bounds(label: str) -> tuple[date, date]:
    """label 'YYYY-Qn' -> (start_date, end_date_exclusive)."""
    f_year, q = _quarter_sort_key(label)
    start_month = 4 + (q - 1) * 3
    start_year = f_year
    if start_month > 12:
        start_month -= 12
        start_year += 1
    start = date(start_year, start_month, 1)
    end_month, end_year = start_month + 3, start_year
    if end_month > 12:
        end_month -= 12
        end_year += 1
    return start, date(end_year, end_month, 1)


def _period_progress(start: date, end_excl: date, today: Optional[date] = None) -> tuple[bool, Optional[float]]:
    """(complete, elapsed_pct). elapsed_pct is None once the period is complete."""
    today = today or datetime.utcnow().date()
    total_days = (end_excl - start).days
    if today >= end_excl:
        return True, None
    elapsed = max((today - start).days, 0)
    return False, round(min(elapsed, total_days) / total_days * 100, 1) if total_days else None


async def _load_fy_info():
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT MINDATE, MAXDATE, YEARENDFLAG, F_YEAR FROM cbs_yearend ORDER BY F_YEAR DESC")
            rows = await cur.fetchall()
    if not rows:
        raise RuntimeError("cbs_yearend is empty")
    current = next((r for r in rows if r["YEARENDFLAG"] == "N"), rows[0])
    prior = next((r for r in rows if r["F_YEAR"] == current["F_YEAR"] - 1), None)
    FY_INFO["current"] = {
        "from": _fmt_yyyymmdd(current["MINDATE"]),
        "to_excl": (date.fromisoformat(_fmt_yyyymmdd(current["MAXDATE"])) + timedelta(days=1)).isoformat(),
        "f_year": current["F_YEAR"],
    }
    FY_INFO["prior"] = None if not prior else {
        "from": _fmt_yyyymmdd(prior["MINDATE"]),
        "to_excl": (date.fromisoformat(_fmt_yyyymmdd(prior["MAXDATE"])) + timedelta(days=1)).isoformat(),
        "f_year": prior["F_YEAR"],
    }


async def _load_pl_branches():
    global PL_BRANCHES
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT DISTINCT SUBSTR(AcNo,1,2) AS branch FROM gltable")
            rows = await cur.fetchall()
    PL_BRANCHES = [r["branch"] for r in rows]


async def _load_pl_heads():
    global PL_HEADS, PL_CLASS
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                SELECT SUBSTR(AcNo,3,8) AS gl_code, MIN(TRIM(AcName)) AS head
                FROM gltable
                WHERE SUBSTR(AcNo,3,3) IN ('063','064')
                GROUP BY gl_code
            """)
            rows = await cur.fetchall()
    PL_HEADS = {r["gl_code"]: r["head"] for r in rows}
    PL_CLASS = {code: _classify_pl_head(code, head) for code, head in PL_HEADS.items()}


PL_MONTH_SQL = """
    SELECT SUBSTR(g.AcNo,3,8) AS gl_code,
           DATE_FORMAT(IF(r.TranDesc = 77, COALESCE(r.ValueDt, r.Dt), r.Dt), '%%Y%%m') AS ym,
           SUM(r.CrAmt - r.DrAmt) AS net_credit
    FROM gltable g
    JOIN gl_recon r ON r.ACNo = g.AcNo
    WHERE g.AcNo LIKE CONCAT(%(branch)s, '06%%')
      AND SUBSTR(g.AcNo,3,3) IN ('063','064')
      AND r.auth = 'Y'
      AND COALESCE(r.TranDesc,0) <> 13
      AND (
            (r.Dt >= %(from_dt)s AND r.Dt < %(to_dt)s
             AND NOT (r.TranDesc = 77 AND r.ValueDt < %(from_dt)s))
         OR (r.Dt >= %(to_dt)s AND r.TranDesc = 77
             AND r.ValueDt >= %(from_dt)s AND r.ValueDt < %(to_dt)s)
          )
    GROUP BY gl_code, ym
"""


async def _job_pl(fy: dict):
    """Job A (§4): reload P&L monthly totals for one FY window, all branches."""
    if not PL_BRANCHES:
        await _load_pl_branches()
    await _load_pl_heads()
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            for branch in PL_BRANCHES:
                await cur.execute(PL_MONTH_SQL, {
                    "branch": branch, "from_dt": fy["from"], "to_dt": fy["to_excl"],
                })
                rows = await cur.fetchall()
                bmap = PL_MONTH.setdefault(branch, {})
                for r in rows:
                    bmap.setdefault(r["gl_code"], {})[r["ym"]] = float(r["net_credit"])
    PROFIT_STATUS["pl_as_of"] = datetime.utcnow().isoformat()


BAL_SB_RD_TL_DL_SQL = """
    SELECT SUBSTR(b.acno,1,2) AS branch, t.acctNature AS nature, SUM(b.Balance) AS bal
    FROM reconbalan b
    JOIN accountmaster     am ON am.ACNo    = b.acno
    JOIN accounttypemaster t  ON t.AcctCode = am.Accttype
    WHERE am.AccStatus <> 9
    GROUP BY branch, nature
"""
BAL_CA_SQL = """
    SELECT SUBSTR(b.acno,1,2) AS branch,
           SUM(GREATEST(b.Balance, 0)) AS credit_bal,
           SUM(LEAST(b.Balance, 0))    AS debit_bal
    FROM ca_reconbalan b
    JOIN accountmaster am ON am.ACNo = b.acno
    WHERE am.AccStatus <> 9
    GROUP BY branch
"""
BAL_FD_SQL = """
    SELECT SUBSTR(ACNO,1,2) AS branch, SUM(CrAmt - DrAmt) AS bal
    FROM td_recon
    WHERE Auth = 'Y' AND CloseFlag IS NULL AND Dt < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
    GROUP BY branch
"""


def _empty_branch_bal() -> dict:
    return {"sb": 0.0, "rd": 0.0, "tl": 0.0, "dl": 0.0, "fd": 0.0, "ca_credit": 0.0, "ca_debit": 0.0}


async def _job_balances():
    """Job B (§5): closing deposits/advances by branch."""
    global BALANCES
    bal: dict = {}
    warnings = []
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(BAL_SB_RD_TL_DL_SQL)
            for r in await cur.fetchall():
                v = float(r["bal"] or 0)
                if r["nature"] not in KNOWN_ACCT_NATURES and v != 0:
                    warnings.append(f"unknown account nature '{r['nature']}' in branch {r['branch']} (balance {v:.2f})")
                    continue
                b = bal.setdefault(r["branch"], _empty_branch_bal())
                if r["nature"] == "SB": b["sb"] += v
                elif r["nature"] == "RD": b["rd"] += v
                elif r["nature"] == "TL": b["tl"] += v
                elif r["nature"] == "DL": b["dl"] += v

            await cur.execute(BAL_CA_SQL)
            for r in await cur.fetchall():
                b = bal.setdefault(r["branch"], _empty_branch_bal())
                b["ca_credit"] = float(r["credit_bal"] or 0)
                b["ca_debit"]  = float(r["debit_bal"] or 0)

            await cur.execute(BAL_FD_SQL)
            for r in await cur.fetchall():
                b = bal.setdefault(r["branch"], _empty_branch_bal())
                b["fd"] = float(r["bal"] or 0)

    for b in bal.values():
        b["deposits"] = b["sb"] + b["rd"] + b["fd"] + b["ca_credit"]
        b["advances"] = -(b["tl"] + b["dl"]) + abs(b["ca_debit"])

    BALANCES = bal
    for w in warnings:
        if w not in PROFIT_WARNINGS:
            PROFIT_WARNINGS.append(w)
    PROFIT_STATUS["balances_as_of"] = datetime.utcnow().isoformat()


NPA_SQL = """
    SELECT SUBSTR(am.ACNo,1,2)                         AS branch,
           am.AccStatus                                AS status,
           COUNT(*)                                    AS accounts,
           SUM(-COALESCE(rb.Balance, cb.Balance, 0))   AS outstanding
    FROM accountmaster am
    LEFT JOIN reconbalan    rb ON rb.acno = am.ACNo
    LEFT JOIN ca_reconbalan cb ON cb.acno = am.ACNo
    WHERE am.AccStatus IN (11, 12, 13)
    GROUP BY branch, status
"""


async def _job_npa():
    """Job C (§6): Gross NPA by branch and class."""
    global NPA
    npa: dict = {}
    async with profit_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(NPA_SQL)
            rows = await cur.fetchall()
    for r in rows:
        b = npa.setdefault(r["branch"], {s: {"accounts": 0, "amount": 0.0} for s in NPA_CLASS_LABELS})
        b[r["status"]] = {"accounts": r["accounts"], "amount": float(r["outstanding"] or 0)}
    NPA = npa
    PROFIT_STATUS["npa_as_of"] = datetime.utcnow().isoformat()


def _period_pl(branch_filter: Optional[str], from_ym: str, to_ym: str) -> tuple[dict, dict, dict]:
    """Sum PL_MONTH over [from_ym, to_ym] inclusive.

    `totals`/`interest` always include every head — they must equal the raw GL sum
    with no dependency on the inter-branch name match, since a bank whose GL head
    names don't fit the BRANCH/BR/HO convention on both sides of a transfer-pricing
    pair would otherwise corrupt Net Profit (one side excluded, the other not).

    `ib` is a *separate*, best-effort bucket used only for the inter-branch display
    tile and the §9 balance check — callers must cap it (e.g. `min(ib.income,
    ib.expense)`) before subtracting it from `totals` for display, so an unmatched
    side can never remove more from one column than the other.
    """
    totals   = {"income": 0.0, "expense": 0.0}
    interest = {"income": 0.0, "expense": 0.0}
    ib       = {"income": 0.0, "expense": 0.0}
    for branch, gmap in PL_MONTH.items():
        if branch_filter and branch != branch_filter:
            continue
        for gl_code, ymap in gmap.items():
            c = PL_CLASS.get(gl_code)
            if not c:
                continue
            for ym, net_credit in ymap.items():
                if not (from_ym <= ym <= to_ym):
                    continue
                amount = net_credit if c["side"] == "income" else -net_credit
                totals[c["side"]] += amount
                if c["interest"]:
                    interest[c["side"]] += amount
                if c["inter_branch"] and not branch_filter:
                    ib[c["side"]] += amount
    return totals, interest, ib


def _trend_series(branch_filter: Optional[str]) -> list:
    """Quarterly P&L trend across whatever FYs are loaded in PL_MONTH (§7 periods)."""
    quarters: dict = {}
    for branch, gmap in PL_MONTH.items():
        if branch_filter and branch != branch_filter:
            continue
        for gl_code, ymap in gmap.items():
            c = PL_CLASS.get(gl_code)
            if not c:
                continue
            for ym, net_credit in ymap.items():
                label = _ym_quarter(ym)
                q = quarters.setdefault(label, {"interest_income": 0.0, "interest_expense": 0.0,
                                                 "total_income": 0.0, "total_expense": 0.0,
                                                 "ib_income": 0.0, "ib_expense": 0.0})
                amount = net_credit if c["side"] == "income" else -net_credit
                if c["side"] == "income":
                    q["total_income"] += amount
                    if c["interest"]: q["interest_income"] += amount
                    if c["inter_branch"] and not branch_filter: q["ib_income"] += amount
                else:
                    q["total_expense"] += amount
                    if c["interest"]: q["interest_expense"] += amount
                    if c["inter_branch"] and not branch_filter: q["ib_expense"] += amount

    out = []
    for label, q in sorted(quarters.items(), key=lambda kv: _quarter_sort_key(kv[0])):
        start, end_excl = _quarter_bounds(label)
        complete, elapsed_pct = _period_progress(start, end_excl)
        # Same symmetric-cap rule as pl_block: only the amount matched on both
        # sides is stripped from displayed interest income/expense, so Cost of
        # Funds is never thrown off by a one-sided name match. nii/net_profit
        # are computed from the uncapped totals and are unaffected either way.
        ib_matched = min(q["ib_income"], q["ib_expense"])
        out.append({
            "period": label,
            "interest_income": round(q["interest_income"] - ib_matched, 2),
            "interest_expense": round(q["interest_expense"] - ib_matched, 2),
            "nii": round(q["interest_income"] - q["interest_expense"], 2),
            "net_profit": round(q["total_income"] - q["total_expense"], 2),
            "complete": complete,
            "elapsed_pct": elapsed_pct,
        })
    return out


def _agg_balances(branch_filter: Optional[str]) -> tuple[dict, dict]:
    if branch_filter:
        b = BALANCES.get(branch_filter, _empty_branch_bal())
        deposits = {"sb": b["sb"], "rd": b["rd"], "fd": b["fd"], "ca": b["ca_credit"],
                    "total": b.get("deposits", 0.0)}
        advances = {"tl": -b["tl"], "dl": -b["dl"], "cc_od": abs(b["ca_debit"]),
                    "total": b.get("advances", 0.0)}
        return deposits, advances

    deposits = {"sb": 0.0, "rd": 0.0, "fd": 0.0, "ca": 0.0, "total": 0.0}
    advances = {"tl": 0.0, "dl": 0.0, "cc_od": 0.0, "total": 0.0}
    for b in BALANCES.values():
        deposits["sb"] += b["sb"]; deposits["rd"] += b["rd"]; deposits["fd"] += b["fd"]
        deposits["ca"] += b["ca_credit"]; deposits["total"] += b.get("deposits", 0.0)
        advances["tl"] += -b["tl"]; advances["dl"] += -b["dl"]
        advances["cc_od"] += abs(b["ca_debit"]); advances["total"] += b.get("advances", 0.0)
    return deposits, advances


def _agg_npa(branch_filter: Optional[str]) -> tuple[dict, float]:
    by_class = {label: {"accounts": 0, "amount": 0.0} for label in NPA_CLASS_LABELS.values()}
    branches = [NPA[branch_filter]] if branch_filter and branch_filter in NPA else \
               ([] if branch_filter else list(NPA.values()))
    for b in branches:
        for status, label in NPA_CLASS_LABELS.items():
            by_class[label]["accounts"] += b[status]["accounts"]
            by_class[label]["amount"]   += b[status]["amount"]
    for label in by_class:
        by_class[label]["amount"] = round(by_class[label]["amount"], 2)
    gross = sum(v["amount"] for v in by_class.values())
    return by_class, gross


def _cost_of_funds(branch_filter: Optional[str], deposits_total: float) -> tuple[Optional[float], Optional[str]]:
    """Trailing 4 *completed* quarters of interest expense over current deposits (§7)."""
    trend = _trend_series(branch_filter)
    now = datetime.utcnow()
    current_q = _ym_quarter(f"{now.year:04d}{now.month:02d}")
    completed = [t for t in trend if t["period"] != current_q]
    last4 = completed[-4:]
    if len(last4) < 4 or not deposits_total:
        return None, None
    interest_expense_sum = sum(t["interest_expense"] for t in last4)
    pct = round(interest_expense_sum / deposits_total * 100, 2)
    return pct, f"{last4[0]['period']}..{last4[-1]['period']}"


CHECK_TRANDESC13_SQL = """
    SELECT -SUM(r.CrAmt - r.DrAmt) AS net_profit_check
    FROM gltable g
    JOIN gl_recon r ON r.ACNo = g.AcNo
                   AND r.Dt >= %(fy_start)s AND r.Dt < DATE_ADD(%(fy_end_excl)s, INTERVAL 7 DAY)
    WHERE g.AcNo LIKE CONCAT(%(branch)s, '06%%')
      AND SUBSTR(g.AcNo,3,3) IN ('063','064')
      AND r.TranDesc = 13
"""


async def _job_checks():
    """Job D (§9): closed-FY net profit vs reversed closing entries; inter-branch balance."""
    global PROFIT_CHECKS
    checks: dict = {}
    new_warnings: list = []

    prior = FY_INFO.get("prior")
    if prior and PL_BRANCHES:
        from_ym, to_ym = _fy_ym_bounds(prior)
        totals, _, _ = _period_pl(None, from_ym, to_ym)
        net_profit = totals["income"] - totals["expense"]
        recon_total = 0.0
        async with profit_pool.acquire() as conn:
            async with conn.cursor() as cur:
                for branch in PL_BRANCHES:
                    await cur.execute(CHECK_TRANDESC13_SQL, {
                        "branch": branch, "fy_start": prior["from"], "fy_end_excl": prior["to_excl"],
                    })
                    row = await cur.fetchone()
                    recon_total += float(row["net_profit_check"] or 0)
        ok = abs(net_profit - recon_total) < 1.0
        checks["closed_fy_net_profit"] = {
            "fy": prior["f_year"], "net_profit": round(net_profit, 2),
            "reversed_closing": round(recon_total, 2), "ok": ok,
        }
        if not ok:
            new_warnings.append(
                f"closed FY {prior['f_year']} net profit {net_profit:.2f} does not match "
                f"reversed closing entries {recon_total:.2f} — a filter is likely wrong"
            )

    current = FY_INFO.get("current")
    if current:
        from_ym, to_ym = _fy_ym_bounds(current)
        _, _, ib = _period_pl(None, from_ym, to_ym)
        mismatch = abs(ib["income"] - ib["expense"]) > 1.0
        checks["inter_branch"] = {
            "income": round(ib["income"], 2), "expense": round(ib["expense"], 2), "ok": not mismatch,
        }
        if mismatch:
            new_warnings.append(
                f"inter-branch income {ib['income']:.2f} does not equal inter-branch expense "
                f"{ib['expense']:.2f} — some GL head names likely don't match the BRANCH/BR/HO "
                f"naming convention on both sides. Net Profit and NII are exact regardless; "
                f"Total income/expenditure and Cost of Funds use only the matched (smaller) side "
                f"and so are understated/overstated by the unmatched remainder"
            )

    PROFIT_CHECKS = checks
    for w in new_warnings:
        if w not in PROFIT_WARNINGS:
            PROFIT_WARNINGS.append(w)


async def _profitability_refresh(both_fys: bool):
    # Balances and NPA are cheap and feed /advances and /alerts, so load them before
    # the slow P&L scans — otherwise those endpoints show zero NPA through warm-up.
    await _job_balances()
    await _job_npa()
    await _load_fy_info()
    if both_fys and FY_INFO["prior"]:
        await _job_pl(FY_INFO["prior"])
    if FY_INFO["current"]:
        await _job_pl(FY_INFO["current"])
    await _job_checks()


async def _profitability_scheduler():
    """Startup: load previous + current FY, balances, NPA, checks. Then hourly:
    current FY + balances + NPA. Daily: also previous FY + checks (§2)."""
    global profit_pool
    profit_db_config = {**DB_CONFIG, "minsize": 1, "maxsize": 1}
    profit_pool = await aiomysql.create_pool(**profit_db_config)

    try:
        await _profitability_refresh(both_fys=True)
        PROFIT_STATUS["ready"] = True
    except Exception as e:
        PROFIT_WARNINGS.append(f"profitability startup load failed: {e}")

    last_daily = datetime.utcnow()
    while True:
        await asyncio.sleep(3600)
        try:
            due_daily = datetime.utcnow() - last_daily >= timedelta(hours=24)
            await _profitability_refresh(both_fys=due_daily)
            if due_daily:
                last_daily = datetime.utcnow()
            PROFIT_STATUS["ready"] = True
        except Exception as e:
            PROFIT_WARNINGS.append(f"profitability refresh failed: {e}")


@app.on_event("startup")
async def startup():
    global pool
    pool = await aiomysql.create_pool(**DB_CONFIG)
    await _load_lookups()
    asyncio.create_task(_session_cleanup_task())
    asyncio.create_task(_lookup_refresh_task())
    asyncio.create_task(_profitability_scheduler())


@app.on_event("shutdown")
async def shutdown():
    pool.close()
    await pool.wait_closed()


# ── Helpers ───────────────────────────────────────────────────────────────────

def branch_clause(alias: str, branch: Optional[str]) -> tuple[str, list]:
    if branch:
        return f" AND {alias}.CurBrCode = %s", [branch]
    return "", []


def to_yyyymmdd(d: Optional[str]) -> Optional[str]:
    return d.replace("-", "") if d else None


def date_range_frag(alias: str, col: str, from_date: Optional[str], to_date: Optional[str]) -> tuple[str, list]:
    clauses, params = [], []
    f8 = to_yyyymmdd(from_date)
    t8 = to_yyyymmdd(to_date)
    if f8:
        clauses.append(f" AND {alias}.{col} >= %s")
        params.append(f8)
    if t8:
        clauses.append(f" AND {alias}.{col} <= %s")
        params.append(t8)
    return "".join(clauses), params


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    userId: str
    password: str

class LogoutRequest(BaseModel):
    token: str


@app.post("/api/login")
async def login(body: LoginRequest):
    if not body.userId.strip() or not body.password:
        raise HTTPException(status_code=400, detail="User ID and password are required")

    pw_hash = hashlib.md5(body.password.encode()).hexdigest()

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT UserId, UserName, LevelId, Status, brncode "
                "FROM securityinfo WHERE UserId = %s AND LOWER(Password) = %s",
                [body.userId.strip(), pw_hash],
            )
            row = await cur.fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid User ID or password")
    if row.get("Status") != "A":
        raise HTTPException(status_code=403, detail="Account is inactive. Please contact your administrator.")

    # Evict any existing session for this user
    old_tokens = [t for t, s in SESSIONS.items() if s["userId"] == row["UserId"]]
    for t in old_tokens:
        SESSIONS.pop(t, None)

    token = secrets.token_hex(32)
    SESSIONS[token] = {
        "userId":   row["UserId"],
        "userName": row["UserName"],
        "levelId":  row["LevelId"],
        "brncode":  row["brncode"],
        "expires":  datetime.utcnow() + timedelta(hours=8),
    }

    return {
        "token":    token,
        "userId":   row["UserId"],
        "userName": row["UserName"],
        "levelId":  row["LevelId"],
        "role":     LEVEL_NAMES.get(row["LevelId"], f"Level {row['LevelId']}"),
        "brncode":  row["brncode"],
        "branch":   BRANCH_NAMES.get(str(row["brncode"]), str(row["brncode"])),
    }


@app.post("/api/logout")
async def logout(body: LogoutRequest):
    SESSIONS.pop(body.token, None)
    return {"status": "ok"}


# ── Branches ──────────────────────────────────────────────────────────────────

@app.get("/api/branches")
async def get_branches():
    key = ("branches",)
    if key in _static_cache:
        return _static_cache[key]

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT AlphaCode, BranchName, City, BrnCode FROM branchmaster ORDER BY BrnCode"
            )
            rows = await cur.fetchall()

    result = [
        {
            "code":  str(r["BrnCode"]).zfill(2),
            "alpha": r["AlphaCode"],
            "name":  r["BranchName"],
            "city":  r["City"],
            "short": BRANCH_NAMES.get(str(r["BrnCode"]), r["BranchName"]),
        }
        for r in rows
    ]
    _static_cache[key] = result
    return result


# ── Bank Info ─────────────────────────────────────────────────────────────────

@app.get("/api/bank-info")
async def get_bank_info():
    key = ("bank_info",)
    if key in _static_cache:
        return _static_cache[key]

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT DISTINCT BankName FROM parameterinfo LIMIT 1")
            row = await cur.fetchone()
            await cur.execute("SELECT COUNT(*) AS cnt FROM branchmaster")
            br = await cur.fetchone()

    name = (row["BankName"] or "CBS").strip() if row else "CBS"
    result = {
        "bankName":    name,
        "initial":     name[0] if name else "C",
        "branchCount": br["cnt"] if br else 0,
    }
    _static_cache[key] = result
    return result


# ── Accounts ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/accounts")
async def get_accounts(
    branch:    Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date:   Optional[str] = Query(None),
    freq:      str           = Query('year'),  # year | month | day
):
    key = ("accounts", branch, from_date, to_date, freq)
    if key in _metrics_cache:
        return _metrics_cache[key]

    frag, params = branch_clause("am", branch)
    dr_frag, dr_params = date_range_frag("am", "OpeningDt", from_date, to_date)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS total FROM cbs_customer_master_detail WHERE SuspensionFlg NOT IN ('Y', 'S')")
            cust = await cur.fetchone()

            await cur.execute(f"""
                SELECT am.CurBrCode, atm.acctNature, COUNT(*) AS count
                FROM accountmaster am
                JOIN accounttypemaster atm ON am.Accttype = atm.AcctCode
                WHERE atm.acctNature IN ('SB','CA') {frag}
                GROUP BY am.CurBrCode, atm.acctNature
                ORDER BY am.CurBrCode
            """, params)
            sb_ca_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT COUNT(*) AS new_in_period
                FROM accountmaster am
                WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != '' {frag} {dr_frag}
            """, params + dr_params)
            period_row = await cur.fetchone()

            if freq == 'month':
                trend_col = "SUBSTR(am.OpeningDt,1,6)"
                await cur.execute(f"""
                    SELECT {trend_col} AS period, COUNT(*) AS new_accounts
                    FROM accountmaster am
                    WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != ''
                      {frag} {dr_frag}
                    GROUP BY period
                    ORDER BY period
                """, params + dr_params)
            elif freq == 'day':
                await cur.execute(f"""
                    SELECT am.OpeningDt AS period, COUNT(*) AS new_accounts
                    FROM accountmaster am
                    WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != ''
                      {frag} {dr_frag}
                    GROUP BY am.OpeningDt
                    ORDER BY period
                """, params + dr_params)
            else:  # year
                await cur.execute(f"""
                    SELECT SUBSTR(am.OpeningDt,1,4) AS period, COUNT(*) AS new_accounts
                    FROM accountmaster am
                    WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != ''
                      AND SUBSTR(am.OpeningDt,1,4) >= '2020' {frag} {dr_frag}
                    GROUP BY period
                    ORDER BY period
                """, params + dr_params)
            trend_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT am.Accttype AS code, COUNT(*) AS count
                FROM accountmaster am
                WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != '' {frag} {dr_frag}
                GROUP BY am.Accttype
                ORDER BY count DESC
                LIMIT 6
            """, params + dr_params)
            type_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT COUNT(*) AS total FROM accountmaster am WHERE 1=1 {frag}
            """, params)
            total_row = await cur.fetchone()

            await cur.execute(f"""
                SELECT AccStatus, COUNT(*) AS count
                FROM accountmaster am
                WHERE 1=1 {frag}
                GROUP BY AccStatus
                ORDER BY AccStatus
            """, params)
            status_rows = await cur.fetchall()

    total      = total_row["total"]
    sb_total   = sum(r["count"] for r in sb_ca_rows if r["acctNature"] == "SB")
    ca_total   = sum(r["count"] for r in sb_ca_rows if r["acctNature"] == "CA")

    branch_sb_ca: dict = {}
    for r in sb_ca_rows:
        bc = r["CurBrCode"]
        if bc not in branch_sb_ca:
            branch_sb_ca[bc] = {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc), "sb": 0, "ca": 0}
        if r["acctNature"] == "SB":
            branch_sb_ca[bc]["sb"] += r["count"]
        elif r["acctNature"] == "CA":
            branch_sb_ca[bc]["ca"] += r["count"]

    branch_data = sorted(branch_sb_ca.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["total"] = b["sb"] + b["ca"]

    status_breakdown = [
        {"status": r["AccStatus"], "label": ACC_STATUS_LABELS.get(r["AccStatus"], f"Status {r['AccStatus']}"), "count": r["count"]}
        for r in status_rows
    ]

    result = {
        "total_customers":   cust["total"],
        "total":             total,
        "sb_total":          sb_total,
        "ca_total":          ca_total,
        "new_in_period":     period_row["new_in_period"],
        "period_label":      (f"{from_date} to {to_date}" if from_date or to_date
                             else None),
        "trend":             [{"period": r["period"], "count": r["new_accounts"]} for r in trend_rows],
        "trend_freq":        freq,
        "type_distribution": [
            {"name": ACCT_NAMES.get(r["code"], f'Type {r["code"]}'), "count": r["count"]}
            for r in type_rows
        ],
        "branch_breakdown":   branch_data,
        "status_breakdown":   status_breakdown,
    }
    _metrics_cache[key] = result
    return result


# ── Deposits ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/deposits")
async def get_deposits(
    branch:    Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date:   Optional[str] = Query(None),
):
    key = ("deposits", branch, from_date, to_date)
    if key in _metrics_cache:
        return _metrics_cache[key]

    frag, params         = branch_clause("am", branch)
    frag_td, params_td   = branch_clause("tdam", branch)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"""
                SELECT tdam.CurBrCode,
                       COUNT(*)            AS count,
                       SUM(tv.PrinAmt)     AS principal,
                       SUM(tv.CumuPrinAmt) AS maturity_amt
                FROM td_vouchmst tv
                JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
                WHERE tv.Status = 'A' {frag_td}
                GROUP BY tdam.CurBrCode
                ORDER BY tdam.CurBrCode
            """, params_td)
            td_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT
                    am.CurBrCode,
                    atm.AcctCode  AS code,
                    atm.AcctDesc  AS label,
                    atm.acctNature AS nature,
                    COUNT(*)      AS count
                FROM accountmaster am
                JOIN accounttypemaster atm ON am.Accttype = atm.AcctCode
                WHERE atm.acctNature IN ('FD', 'RD') {frag}
                GROUP BY am.CurBrCode, atm.AcctCode, atm.AcctDesc, atm.acctNature
                ORDER BY am.CurBrCode, atm.AcctCode
            """, params)
            acct_type_rows = await cur.fetchall()

            # Forward-looking maturity ladder: only FDs that haven't matured yet,
            # bucketed by month for the next 6 months. Calendar-quarter buckets
            # previously included already-matured (mostly closed-out) FDs from
            # past quarters, which read as a near-zero anomaly rather than backlog.
            await cur.execute(f"""
                SELECT
                    DATE_FORMAT(tv.MatDt, '%%Y-%%m') AS ym,
                    COUNT(*)            AS count,
                    SUM(tv.CumuPrinAmt) AS amount
                FROM td_vouchmst tv
                JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
                WHERE tv.Status = 'A'
                  AND tv.MatDt >= CURDATE()
                  AND tv.MatDt < DATE_ADD(DATE_FORMAT(CURDATE(), '%%Y-%%m-01'), INTERVAL 6 MONTH)
                  {frag_td}
                GROUP BY ym
                ORDER BY ym
            """, params_td)
            maturity_rows = {r["ym"]: r for r in await cur.fetchall()}

            # FD maturity alerts — merged into one query with conditional sums
            await cur.execute(f"""
                SELECT
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 7 DAY)  THEN 1 ELSE 0 END) AS count_7d,
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 7 DAY)  THEN tv.PrinAmt ELSE 0 END) AS amt_7d,
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS count_30d,
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 30 DAY) THEN tv.PrinAmt ELSE 0 END) AS amt_30d
                FROM td_vouchmst tv
                JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
                WHERE tv.Status = 'A'
                  AND tv.MatDt BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
                {frag_td}
            """, params_td)
            mat_row = await cur.fetchone()

    td_count     = sum(r["count"] for r in td_rows)
    td_maturity  = sum(float(r["maturity_amt"] or 0) for r in td_rows)

    # FD principal (incl. capitalised interest, excl. closed accounts) comes from
    # BALANCES (§5/§11 of the profitability spec — td_recon with closeflag IS NULL),
    # not td_vouchmst.PrinAmt which misses interest added to cumulative FDs.
    if branch:
        fd_by_branch = {branch: BALANCES.get(branch, {}).get("fd", 0.0)}
    else:
        fd_by_branch = {bc: b.get("fd", 0.0) for bc, b in BALANCES.items()}
    td_principal = sum(fd_by_branch.values())

    # Build deposit_types summary dynamically from accounttypemaster acctNature
    type_totals: dict = {}
    for r in acct_type_rows:
        code = r["code"]
        if code not in type_totals:
            type_totals[code] = {"code": code, "label": r["label"], "nature": r["nature"], "count": 0}
        type_totals[code]["count"] += r["count"]
    deposit_types = sorted(type_totals.values(), key=lambda x: x["code"])
    acct_type_total = sum(t["count"] for t in deposit_types)

    # Build per-branch map
    branch_map: dict = {}
    for r in td_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0})
        branch_map[bc]["td_count"]     = r["count"]
        branch_map[bc]["td_principal"] = fd_by_branch.get(bc, 0.0)
    for r in acct_type_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0})
        branch_map[bc][r["code"]] = branch_map[bc].get(r["code"], 0) + r["count"]
    for bc, fd_amt in fd_by_branch.items():
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0})
        branch_map[bc]["td_principal"] = fd_amt

    branch_data = sorted(branch_map.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["total_accounts"] = b["td_count"] + sum(b.get(t["code"], 0) for t in deposit_types)

    # Zero-fill all 6 months so the ladder shows genuine gaps, not missing bars.
    ladder_months = []
    cursor_month = date.today().replace(day=1)
    for _ in range(6):
        ym = cursor_month.strftime("%Y-%m")
        ladder_months.append(ym)
        cursor_month = (cursor_month.replace(day=28) + timedelta(days=4)).replace(day=1)

    result = {
        "td_count":      td_count,
        "td_principal":  td_principal,
        "td_maturity":   td_maturity,
        "deposit_types": deposit_types,
        "total_deposit_accounts": td_count + acct_type_total,
        "maturity_window": "Next 6 Months",
        "maturity_trend": [
            {"month": datetime.strptime(ym, "%Y-%m").strftime("%b %Y"),
             "count": int(maturity_rows[ym]["count"]) if ym in maturity_rows else 0,
             "amount": float(maturity_rows[ym]["amount"] or 0) if ym in maturity_rows else 0.0}
            for ym in ladder_months
        ],
        "fd_maturing_7d":      int(mat_row["count_7d"] or 0),
        "fd_maturing_7d_amt":  float(mat_row["amt_7d"] or 0),
        "fd_maturing_30d":     int(mat_row["count_30d"] or 0),
        "fd_maturing_30d_amt": float(mat_row["amt_30d"] or 0),
        "branch_breakdown": branch_data,
    }
    _metrics_cache[key] = result
    return result


# ── Advances ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/advances")
async def get_advances(
    branch:    Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date:   Optional[str] = Query(None),
):
    key = ("advances", branch, from_date, to_date)
    if key in _metrics_cache:
        return _metrics_cache[key]

    frag, params = branch_clause("am", branch)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # Closed loans (AccStatus 9) are ~all of cbs_loan_borrower_details and would
            # swamp the NPA-by-count ratio, so totals cover open accounts only.
            # Loan book totals and per-type breakdown: cbs_loan_borrower_details is the
            # right source for sanctioned amounts/counts by product. NPA classification
            # is NOT taken from here (see below) — NPA_CLASSIFICATION holds suit-filed/
            # recovery codes on loans that may already be closed (§11 of the profitability spec).
            await cur.execute(f"""
                SELECT am.CurBrCode, COUNT(*) AS count, SUM(lbd.SANCTION_AMT) AS sanction_amt
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE am.AccStatus <> 9 {frag}
                GROUP BY am.CurBrCode
                ORDER BY am.CurBrCode
            """, params)
            loan_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT am.Accttype, COUNT(*) AS count, SUM(lbd.SANCTION_AMT) AS sanction_amt
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE am.AccStatus <> 9 {frag}
                GROUP BY am.Accttype
                ORDER BY count DESC
            """, params)
            type_rows = await cur.fetchall()

            # "No transaction in 90 days" is dormancy, not 90-days-overdue (§11).
            await cur.execute(f"""
                SELECT COUNT(*) AS dormant
                FROM accountmaster am
                JOIN accounttypemaster atm ON am.Accttype = atm.AcctCode
                WHERE atm.acctNature IN ('TL','DL')
                  AND am.AccStatus <> 9
                  AND am.Last_Txn_Date IS NOT NULL
                  AND am.Last_Txn_Date < DATE_SUB(NOW(), INTERVAL 90 DAY)
                {frag}
            """, params)
            dormant_row = await cur.fetchone()

            if from_date or to_date:
                dt_frag = ""
                dt_params = list(params)
                if from_date:
                    dt_frag += " AND lbd.CREATION_DATE >= %s"
                    dt_params.append(from_date)
                if to_date:
                    dt_frag += " AND lbd.CREATION_DATE <= %s"
                    dt_params.append(to_date + " 23:59:59")
                await cur.execute(f"""
                    SELECT COUNT(*) AS new_in_period, COALESCE(SUM(lbd.SANCTION_AMT), 0) AS new_sanction
                    FROM cbs_loan_borrower_details lbd
                    JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                    WHERE 1=1 {frag} {dt_frag}
                """, dt_params)
                new_row = await cur.fetchone()
            else:
                new_row = {"new_in_period": None, "new_sanction": None}

    # NPA classification, counts and amounts come from Job C (§6 of the profitability
    # spec): accountmaster.AccStatus 11/12/13, outstanding balance — not sanctioned amount.
    npa_by_class, gross_npa = _agg_npa(branch)
    total_npa_accounts = sum(v["accounts"] for v in npa_by_class.values())

    total      = sum(r["count"] for r in loan_rows)
    total_sanc = sum(float(r["sanction_amt"] or 0) for r in loan_rows)
    standard   = max(total - total_npa_accounts, 0)

    _, advances = _agg_balances(branch)
    npa_ratio_amount = round(gross_npa / advances["total"] * 100, 1) if advances["total"] else 0

    npa_label_map = {"sub_standard": "Sub-Standard", "doubtful": "Doubtful", "loss": "Loss"}
    classification = [
        {"label": npa_label_map[k], "count": v["accounts"], "amount": v["amount"]}
        for k, v in npa_by_class.items()
    ]
    classification.append({"label": "Standard", "count": standard, "amount": None})

    loan_by_branch = {r["CurBrCode"]: r for r in loan_rows}
    all_branches = set(loan_by_branch) | set(NPA.keys() if not branch else ({branch} & set(NPA.keys())))
    branch_data = []
    for bc in sorted(all_branches):
        lr = loan_by_branch.get(bc, {"count": 0, "sanction_amt": 0})
        npa_b = NPA.get(bc, {})
        br_npa_count  = sum(npa_b.get(s, {}).get("accounts", 0) for s in NPA_CLASS_LABELS)
        br_npa_amount = sum(npa_b.get(s, {}).get("amount", 0) for s in NPA_CLASS_LABELS)
        br_advances   = BALANCES.get(bc, {}).get("advances", 0.0)
        br_total = lr["count"]
        branch_data.append({
            "branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
            "total": br_total, "standard": max(br_total - br_npa_count, 0),
            "npa_count": br_npa_count,
            "sanction_amt": float(lr["sanction_amt"] or 0), "npa_sanction": round(br_npa_amount, 2),
            "npa_ratio": round(br_npa_count / br_total * 100, 1) if br_total > 0 else 0,
            "npa_ratio_amount": round(br_npa_amount / br_advances * 100, 1) if br_advances else 0,
        })

    result = {
        "total":            total,
        "standard":         standard,
        "npa_count":        total_npa_accounts,
        "npa_ratio":        round(total_npa_accounts / total * 100, 1) if total > 0 else 0,
        "npa_ratio_amount": npa_ratio_amount,
        "total_sanction":   total_sanc,
        "npa_sanction":     round(gross_npa, 2),  # outstanding, not sanctioned amount (§6/§11)
        "dormant":          dormant_row["dormant"],
        "new_in_period":    new_row["new_in_period"],
        "new_sanction":     float(new_row["new_sanction"] or 0) if new_row["new_sanction"] is not None else None,
        "classification":   classification,
        "branch_breakdown": branch_data,
        "type_breakdown": [
            {
                "name":   ACCT_NAMES.get(r["Accttype"], f'Type {r["Accttype"]}'),
                "count":  r["count"],
                "amount": float(r["sanction_amt"] or 0),
            }
            for r in type_rows
        ],
        "npa_ready": PROFIT_STATUS["npa_as_of"] is not None,
    }
    # Don't cache a response built before Job C has loaded NPA — it would pin
    # NPA at zero for the full TTL after every restart.
    if result["npa_ready"]:
        _metrics_cache[key] = result
    return result


# ── KYC ───────────────────────────────────────────────────────────────────────

@app.get("/api/metrics/kyc")
async def get_kyc(branch: Optional[str] = Query(None)):
    key = ("kyc", branch)
    if key in _metrics_cache:
        return _metrics_cache[key]

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if branch:
                await cur.execute("""
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN k.KycVerifiedBy IS NOT NULL THEN 1 ELSE 0 END) AS verified,
                        SUM(CASE WHEN k.KycVerifiedBy IS NULL     THEN 1 ELSE 0 END) AS pending
                    FROM cbs_cust_kyc_details k
                    WHERE k.BrnCode = %s
                """, [branch])
            else:
                await cur.execute("""
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN KycVerifiedBy IS NOT NULL THEN 1 ELSE 0 END) AS verified,
                        SUM(CASE WHEN KycVerifiedBy IS NULL     THEN 1 ELSE 0 END) AS pending
                    FROM cbs_cust_kyc_details
                """)
            row = await cur.fetchone()

    total    = row["total"] or 0
    verified = int(row["verified"] or 0)
    pending  = int(row["pending"] or 0)

    result = {
        "total":           total,
        "verified":        verified,
        "pending":         pending,
        "compliance_rate": round(verified / total * 100, 1) if total > 0 else 0,
    }
    _metrics_cache[key] = result
    return result


# ── Alerts ────────────────────────────────────────────────────────────────────

@app.get("/api/alerts")
async def get_alerts(branch: Optional[str] = Query(None)):
    key = ("alerts", branch)
    if key in _alerts_cache:
        return _alerts_cache[key]

    frag_am, params_am = branch_clause("am", branch)
    frag_td, params_td = branch_clause("tdam", branch)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # Total loan-account counts per branch (for the NPA-by-count ratio).
            # NPA classification/amounts themselves come from Job C — see below.
            await cur.execute(f"""
                SELECT am.CurBrCode, COUNT(*) AS total
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE am.AccStatus <> 9 {frag_am}
                GROUP BY am.CurBrCode
            """, params_am)
            loan_counts = await cur.fetchall()

            # FD maturity 7d and 30d — single query
            await cur.execute(f"""
                SELECT
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 7 DAY)  THEN 1 ELSE 0 END) AS count_7d,
                    SUM(CASE WHEN tv.MatDt <= DATE_ADD(NOW(), INTERVAL 7 DAY)  THEN tv.PrinAmt ELSE 0 END) AS amt_7d,
                    COUNT(*) AS count_30d,
                    SUM(tv.PrinAmt) AS amt_30d
                FROM td_vouchmst tv
                JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
                WHERE tv.Status = 'A'
                  AND tv.MatDt BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
                {frag_td}
            """, params_td)
            mat_row = await cur.fetchone()

    # NPA classification/amounts (Job C, §6) and CD ratio (Job B closing balances, §5/§7)
    # — not SANCTION_AMT / td_vouchmst.PrinAmt (§11).
    npa_by_class, gross_npa = _agg_npa(branch)
    total_npa   = sum(v["accounts"] for v in npa_by_class.values())
    total_loans = sum(r["total"] for r in loan_counts)

    npa_pct_count  = round(total_npa / total_loans * 100, 1) if total_loans > 0 else 0
    deposits, advances = _agg_balances(branch)
    npa_pct_amount = round(gross_npa / advances["total"] * 100, 1) if advances["total"] else 0

    alerts = []

    if npa_pct_count > 5:
        alerts.append({
            "id": "npa_bank_critical", "severity": "critical", "category": "NPA",
            "title": "NPA Ratio Exceeds 5% Threshold",
            "message": f"Bank-wide NPA is {npa_pct_count}% by count / {npa_pct_amount}% by amount — above RBI 5% threshold",
            "value": f"{npa_pct_count}%", "threshold": "5%",
        })
    elif npa_pct_count > 3:
        alerts.append({
            "id": "npa_bank_warning", "severity": "warning", "category": "NPA",
            "title": "NPA Ratio Approaching Threshold",
            "message": f"Bank-wide NPA is {npa_pct_count}% by count / {npa_pct_amount}% by amount — watch 5% threshold",
            "value": f"{npa_pct_count}%", "threshold": "5%",
        })

    loan_totals_by_branch = {r["CurBrCode"]: r["total"] for r in loan_counts}
    for bc, br_total in loan_totals_by_branch.items():
        br_npa = sum(NPA.get(bc, {}).get(s, {}).get("accounts", 0) for s in NPA_CLASS_LABELS)
        br_pct = round(br_npa / br_total * 100, 1) if br_total > 0 else 0
        if br_pct > 5:
            br_name = BRANCH_NAMES.get(str(bc), str(bc))
            alerts.append({
                "id": f"npa_br_{bc}", "severity": "critical", "category": "NPA",
                "title": f"Branch NPA Alert — {br_name}",
                "message": f"{br_name} NPA ratio is {br_pct}% by count — exceeds 5% threshold",
                "value": f"{br_pct}%", "threshold": "5%", "branch": br_name,
            })

    cd_ratio = round(advances["total"] / deposits["total"] * 100, 1) if deposits["total"] > 0 else None

    if cd_ratio is not None:
        if cd_ratio > 75:
            alerts.append({
                "id": "cd_ratio_high", "severity": "warning", "category": "Liquidity",
                "title": "CD Ratio Exceeds 75%",
                "message": f"Credit-to-Deposit ratio is {cd_ratio}% — above 75% threshold",
                "value": f"{cd_ratio}%", "threshold": "75%",
            })
        elif cd_ratio < 60:
            alerts.append({
                "id": "cd_ratio_low", "severity": "warning", "category": "Liquidity",
                "title": "CD Ratio Below 60%",
                "message": f"Credit-to-Deposit ratio is {cd_ratio}% — below 60% target",
                "value": f"{cd_ratio}%", "threshold": "60%",
            })

    count_7d  = int(mat_row["count_7d"] or 0)
    count_30d = int(mat_row["count_30d"] or 0)

    if count_7d > 0:
        amt7_cr = round(float(mat_row["amt_7d"] or 0) / 1e7, 2)
        alerts.append({
            "id": "fd_mat_7d", "severity": "warning", "category": "Deposits",
            "title": "FDs Maturing in 7 Days",
            "message": f"{count_7d} FDs worth ₹{amt7_cr} Cr maturing within 7 days — plan renewal or payout",
            "value": f"{count_7d} FDs", "threshold": None,
        })

    if count_30d > 0:
        amt30_cr = round(float(mat_row["amt_30d"] or 0) / 1e7, 2)
        alerts.append({
            "id": "fd_mat_30d", "severity": "info", "category": "Deposits",
            "title": "FDs Maturing in 30 Days",
            "message": f"{count_30d} FDs worth ₹{amt30_cr} Cr maturing within 30 days",
            "value": f"{count_30d} FDs", "threshold": None,
        })

    sev_order = {"critical": 0, "warning": 1, "info": 2, "ok": 3}
    alerts.sort(key=lambda x: sev_order.get(x["severity"], 99))

    result = {
        "alerts": alerts,
        "summary": {
            "total":              len(alerts),
            "critical":           sum(1 for a in alerts if a["severity"] == "critical"),
            "warning":            sum(1 for a in alerts if a["severity"] == "warning"),
            "info":               sum(1 for a in alerts if a["severity"] == "info"),
            "npa_pct_count":      npa_pct_count,
            "npa_pct_amount":     npa_pct_amount,
            "cd_ratio":           cd_ratio,
            "fd_maturing_7d":     count_7d,
            "fd_maturing_7d_amt": float(mat_row["amt_7d"] or 0),
            "fd_maturing_30d":    count_30d,
            "fd_maturing_30d_amt": float(mat_row["amt_30d"] or 0),
        },
    }
    # Same as get_advances: NPA/CD-ratio alerts are empty until Jobs B/C finish.
    if PROFIT_STATUS["npa_as_of"] is not None:
        _alerts_cache[key] = result
    return result


# ── Profitability ─────────────────────────────────────────────────────────────

@app.get("/api/metrics/profitability")
async def get_profitability(
    branch: Optional[str] = Query(None),
    period: str           = Query("ytd"),   # ytd | fy
    fy:     Optional[int] = Query(None),
):
    if not PROFIT_STATUS["ready"] or not FY_INFO.get("current"):
        raise HTTPException(status_code=503, detail={"warming_up": True})

    current = FY_INFO["current"]
    prior   = FY_INFO.get("prior")

    if period == "fy":
        target = fy or current["f_year"]
        if current["f_year"] == target:
            window = current
        elif prior and prior["f_year"] == target:
            window = prior
        else:
            loaded = [w["f_year"] for w in (prior, current) if w]
            raise HTTPException(status_code=400, detail=f"FY {target} is not loaded (have {loaded})")
        from_ym, to_ym = _fy_ym_bounds(window)
        period_from, period_to = window["from"], _fy_last_day(window)
        period_complete, period_elapsed_pct = _period_progress(
            date.fromisoformat(window["from"]), date.fromisoformat(window["to_excl"]))
    else:
        period = "ytd"
        from_ym = current["from"][:4] + current["from"][5:7]
        now = datetime.utcnow()
        to_ym = f"{now.year:04d}{now.month:02d}"
        period_from, period_to = current["from"], now.date().isoformat()
        # YTD is incomplete by definition — report how far through the FY "today" falls.
        period_complete, period_elapsed_pct = _period_progress(
            date.fromisoformat(current["from"]), date.fromisoformat(current["to_excl"]))
        period_complete = False

    prior_from_ym = str(int(from_ym) - 100)
    prior_to_ym   = str(int(to_ym) - 100)

    def pl_block(fy_ym, ty_ym):
        totals, interest, ib = _period_pl(branch, fy_ym, ty_ym)
        # Only the amount matched on BOTH sides is treated as inter-branch for
        # display — subtracting the same capped amount from income and expense
        # can never move net_profit/nii (a difference is invariant to that), even
        # if this bank's GL head names only let the classifier match one side.
        ib_matched = min(ib["income"], ib["expense"])
        disp_income  = totals["income"]  - ib_matched
        disp_expense = totals["expense"] - ib_matched
        disp_int_income  = interest["income"]  - ib_matched
        disp_int_expense = interest["expense"] - ib_matched
        return {
            "total_income":      round(disp_income, 2),
            "interest_income":   round(disp_int_income, 2),
            "other_income":      round(disp_income - disp_int_income, 2),
            "total_expenditure": round(disp_expense, 2),
            "interest_expense":  round(disp_int_expense, 2),
            "other_expenditure": round(disp_expense - disp_int_expense, 2),
            "nii":               round(interest["income"] - interest["expense"], 2),
            "net_profit":        round(totals["income"] - totals["expense"], 2),
        }

    pl       = pl_block(from_ym, to_ym)
    pl_prior = pl_block(prior_from_ym, prior_to_ym)
    trend    = _trend_series(branch)

    deposits, advances = _agg_balances(branch)
    npa_by_class, gross_npa = _agg_npa(branch)
    gross_npa_pct = round(gross_npa / advances["total"] * 100, 2) if advances["total"] else None
    cd_ratio      = round(advances["total"] / deposits["total"] * 100, 2) if deposits["total"] else None
    cof_pct, cof_window = _cost_of_funds(branch, deposits["total"])

    _, _, ib = _period_pl(branch, from_ym, to_ym)
    ib_check = "ok" if abs(ib["income"] - ib["expense"]) < 1.0 else "mismatch"
    ib_heads = [code for code, c in PL_CLASS.items() if c["inter_branch"]]
    interest_heads = [
        {"gl_code": code, "head": PL_HEADS.get(code, ""), "side": c["side"]}
        for code, c in PL_CLASS.items() if c["interest"]
    ]

    return {
        "as_of": {
            "pl": PROFIT_STATUS["pl_as_of"],
            "balances": PROFIT_STATUS["balances_as_of"],
            "npa": PROFIT_STATUS["npa_as_of"],
        },
        "period":  {
            "type": period, "from": period_from, "to": period_to,
            "complete": period_complete, "elapsed_pct": period_elapsed_pct,
        },
        "branch":  branch,
        "pl":      pl,
        "pl_prior": pl_prior,
        "trend":   trend,
        "balances": {"deposits": deposits, "advances": advances},
        "npa": {"gross": round(gross_npa, 2), "gross_pct": gross_npa_pct, "by_class": npa_by_class},
        "ratios": {
            "cost_of_funds_pct": cof_pct, "cost_of_funds_window": cof_window,
            "cd_ratio_pct": cd_ratio,
        },
        "inter_branch": {
            "income": round(ib["income"], 2), "expense": round(ib["expense"], 2),
            "heads": ib_heads, "check": ib_check,
        },
        "interest_heads": interest_heads,
        "checks":   PROFIT_CHECKS,
        "warnings": list(PROFIT_WARNINGS),
    }


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok"}
