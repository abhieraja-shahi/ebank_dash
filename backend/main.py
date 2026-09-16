import asyncio
import hashlib
import os
import secrets
from datetime import datetime, timedelta
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

DB_CONFIG = {
    "host":       os.getenv("DB_HOST", "192.168.5.30"),
    "port":       int(os.getenv("DB_PORT", "3306")),
    "user":       os.getenv("DB_USER", "root"),
    "password":   os.getenv("DB_PASSWORD", ""),
    "db":         os.getenv("DB_NAME", "basti20260603"),
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

NPA_LABELS = {
    "": "Standard", "0": "Standard", "NPA": "NPA", "DECRE": "Decreed",
    "SF": "Sub-Standard", "PB": "Doubtful", "SFRC": "Loss",
}
NPA_STANDARD_CODES = {"0", ""}
NPA_ORDER = ["Loss", "Doubtful", "Sub-Standard", "Decreed", "NPA", "Standard"]

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


@app.on_event("startup")
async def startup():
    global pool
    pool = await aiomysql.create_pool(**DB_CONFIG)
    await _load_lookups()
    asyncio.create_task(_session_cleanup_task())
    asyncio.create_task(_lookup_refresh_task())


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
    mat_year = to_date[:4] if to_date else str(datetime.now().year)

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

            await cur.execute(f"""
                SELECT
                    QUARTER(tv.MatDt) AS qtr,
                    COUNT(*)           AS count,
                    SUM(tv.CumuPrinAmt) AS amount
                FROM td_vouchmst tv
                JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
                WHERE tv.Status = 'A'
                  AND YEAR(tv.MatDt) = %s {frag_td}
                GROUP BY QUARTER(tv.MatDt)
                ORDER BY qtr
            """, [mat_year] + params_td)
            maturity_rows = await cur.fetchall()

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
    td_principal = sum(float(r["principal"] or 0) for r in td_rows)
    td_maturity  = sum(float(r["maturity_amt"] or 0) for r in td_rows)

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
        branch_map[bc]["td_principal"] = float(r["principal"] or 0)
    for r in acct_type_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0})
        branch_map[bc][r["code"]] = branch_map[bc].get(r["code"], 0) + r["count"]

    branch_data = sorted(branch_map.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["total_accounts"] = b["td_count"] + sum(b.get(t["code"], 0) for t in deposit_types)

    qtr_labels = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}

    result = {
        "td_count":      td_count,
        "td_principal":  td_principal,
        "td_maturity":   td_maturity,
        "deposit_types": deposit_types,
        "total_deposit_accounts": td_count + acct_type_total,
        "mat_year":      mat_year,
        "maturity_trend": [
            {"quarter": qtr_labels.get(r["qtr"], f"Q{r['qtr']}"),
             "count": r["count"], "amount": float(r["amount"] or 0)}
            for r in maturity_rows
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
            await cur.execute(f"""
                SELECT am.CurBrCode, lbd.NPA_CLASSIFICATION,
                       COUNT(*)              AS count,
                       SUM(lbd.SANCTION_AMT) AS sanction_amt
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE 1=1 {frag}
                GROUP BY am.CurBrCode, lbd.NPA_CLASSIFICATION
                ORDER BY am.CurBrCode
            """, params)
            npa_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT am.Accttype, COUNT(*) AS count, SUM(lbd.SANCTION_AMT) AS sanction_amt
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE 1=1 {frag}
                GROUP BY am.Accttype
                ORDER BY count DESC
            """, params)
            type_rows = await cur.fetchall()

            await cur.execute(f"""
                SELECT COUNT(*) AS overdue_90d
                FROM accountmaster am
                JOIN accounttypemaster atm ON am.Accttype = atm.AcctCode
                WHERE atm.acctNature IN ('TL','DL')
                  AND am.Last_Txn_Date IS NOT NULL
                  AND am.Last_Txn_Date < DATE_SUB(NOW(), INTERVAL 90 DAY)
                {frag}
            """, params)
            overdue_row = await cur.fetchone()

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

    total      = sum(r["count"] for r in npa_rows)
    standard   = sum(r["count"] for r in npa_rows if r["NPA_CLASSIFICATION"] in NPA_STANDARD_CODES)
    npa_count  = total - standard
    total_sanc = sum(float(r["sanction_amt"] or 0) for r in npa_rows)
    npa_sanc   = sum(float(r["sanction_amt"] or 0) for r in npa_rows if r["NPA_CLASSIFICATION"] not in NPA_STANDARD_CODES)
    std_sanc   = total_sanc - npa_sanc

    class_map: dict = {}
    for r in npa_rows:
        key_label = NPA_LABELS.get(r["NPA_CLASSIFICATION"], r["NPA_CLASSIFICATION"])
        if key_label not in class_map:
            class_map[key_label] = {"label": key_label, "count": 0, "amount": 0.0}
        class_map[key_label]["count"]  += r["count"]
        class_map[key_label]["amount"] += float(r["sanction_amt"] or 0)

    classification = sorted(
        class_map.values(),
        key=lambda x: NPA_ORDER.index(x["label"]) if x["label"] in NPA_ORDER else 99
    )

    branch_map: dict = {}
    for r in npa_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {
            "branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
            "total": 0, "standard": 0, "npa_count": 0,
            "sanction_amt": 0.0, "npa_sanction": 0.0,
        })
        cnt = r["count"]
        amt = float(r["sanction_amt"] or 0)
        branch_map[bc]["total"]        += cnt
        branch_map[bc]["sanction_amt"] += amt
        if r["NPA_CLASSIFICATION"] in NPA_STANDARD_CODES:
            branch_map[bc]["standard"]    += cnt
        else:
            branch_map[bc]["npa_count"]   += cnt
            branch_map[bc]["npa_sanction"] += amt

    branch_data = sorted(branch_map.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["npa_ratio"]        = round(b["npa_count"] / b["total"] * 100, 1) if b["total"] > 0 else 0
        b["npa_ratio_amount"] = round(b["npa_sanction"] / b["sanction_amt"] * 100, 1) if b["sanction_amt"] > 0 else 0

    result = {
        "total":            total,
        "standard":         standard,
        "npa_count":        npa_count,
        "npa_ratio":        round(npa_count / total * 100, 1) if total > 0 else 0,
        "npa_ratio_amount": round(npa_sanc / total_sanc * 100, 1) if total_sanc > 0 else 0,
        "total_sanction":   total_sanc,
        "npa_sanction":     npa_sanc,
        "std_sanction":     std_sanc,
        "overdue_90d":      overdue_row["overdue_90d"],
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
    }
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
            await cur.execute(f"""
                SELECT am.CurBrCode,
                       COUNT(*) AS total,
                       SUM(CASE WHEN lbd.NPA_CLASSIFICATION IN ('0', '')  THEN 1 ELSE 0 END) AS standard,
                       SUM(CASE WHEN lbd.NPA_CLASSIFICATION NOT IN ('0', '') THEN 1 ELSE 0 END) AS npa_count,
                       SUM(lbd.SANCTION_AMT) AS total_sanction,
                       SUM(CASE WHEN lbd.NPA_CLASSIFICATION NOT IN ('0', '') THEN lbd.SANCTION_AMT ELSE 0 END) AS npa_sanction
                FROM cbs_loan_borrower_details lbd
                JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
                WHERE 1=1 {frag_am}
                GROUP BY am.CurBrCode
            """, params_am)
            branch_npa = await cur.fetchall()

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

            # CD ratio components — merged into one query
            await cur.execute(f"""
                SELECT
                    COALESCE((
                        SELECT SUM(lbd2.SANCTION_AMT)
                        FROM cbs_loan_borrower_details lbd2
                        JOIN accountmaster am2 ON lbd2.ACC_NO = am2.ACNo
                        WHERE 1=1 {frag_am.replace('am.', 'am2.')}
                    ), 0) AS total_adv,
                    COALESCE((
                        SELECT SUM(tv2.PrinAmt)
                        FROM td_vouchmst tv2
                        JOIN td_accountmaster tdam2 ON tv2.ACNO = tdam2.ACNO
                        WHERE tv2.Status = 'A' {frag_td.replace('tdam.', 'tdam2.')}
                    ), 0) AS total_dep
            """, params_am + params_td)
            cd_row = await cur.fetchone()

    total_loans = sum(r["total"] for r in branch_npa)
    total_npa   = sum(r["npa_count"] for r in branch_npa)
    total_sanc  = sum(float(r["total_sanction"] or 0) for r in branch_npa)
    npa_sanc    = sum(float(r["npa_sanction"] or 0) for r in branch_npa)

    npa_pct_count  = round(total_npa / total_loans * 100, 1) if total_loans > 0 else 0
    npa_pct_amount = round(npa_sanc / total_sanc * 100, 1) if total_sanc > 0 else 0

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

    for r in branch_npa:
        br_pct = round(r["npa_count"] / r["total"] * 100, 1) if r["total"] > 0 else 0
        if br_pct > 5:
            br_name = BRANCH_NAMES.get(str(r["CurBrCode"]), str(r["CurBrCode"]))
            alerts.append({
                "id": f"npa_br_{r['CurBrCode']}", "severity": "critical", "category": "NPA",
                "title": f"Branch NPA Alert — {br_name}",
                "message": f"{br_name} NPA ratio is {br_pct}% by count — exceeds 5% threshold",
                "value": f"{br_pct}%", "threshold": "5%", "branch": br_name,
            })

    total_adv_val = float(cd_row["total_adv"] or 0)
    total_dep_val = float(cd_row["total_dep"] or 0)
    cd_ratio = round(total_adv_val / total_dep_val * 100, 1) if total_dep_val > 0 else None

    if cd_ratio is not None:
        if cd_ratio > 75:
            alerts.append({
                "id": "cd_ratio_high", "severity": "warning", "category": "Liquidity",
                "title": "CD Ratio Exceeds 75%",
                "message": f"Credit-to-Deposit ratio is {cd_ratio}% (FD-based) — above 75% threshold",
                "value": f"{cd_ratio}%", "threshold": "75%",
            })
        elif cd_ratio < 60:
            alerts.append({
                "id": "cd_ratio_low", "severity": "warning", "category": "Liquidity",
                "title": "CD Ratio Below 60%",
                "message": f"Credit-to-Deposit ratio is {cd_ratio}% (FD-based) — below 60% target",
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
    _alerts_cache[key] = result
    return result


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok"}
