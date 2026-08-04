from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import mysql.connector
from mysql.connector import Error
import os
from typing import Optional
from dotenv import load_dotenv

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
    "host":     os.getenv("DB_HOST", "192.168.5.30"),
    "port":     int(os.getenv("DB_PORT", "3306")),
    "user":     os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "basti20260603"),
}

NPA_LABELS = {
    "0": "Standard", "NPA": "NPA", "DECRE": "Decreed",
    "SF": "Sub-Standard", "PB": "Doubtful", "SFRC": "Loss",
}
NPA_ORDER = ["Loss", "Doubtful", "Sub-Standard", "Decreed", "NPA", "Standard"]

ACCT_NAMES = {
    "01": "Current Account", "02": "Cash Credit",  "04": "Demand Loan",
    "05": "Fixed Deposit",   "07": "Over Draft",   "08": "Provident Fund",
    "09": "Recurring Deposit","10": "Saving Bank",  "11": "Term Loan",
    "12": "Individual Loan", "15": "Home Deposit", "18": "FD Re-Invest",
    "22": "Personal Loan",   "23": "Staff Loan",   "24": "Monthly Income Deposit",
}

BRANCH_NAMES = {
    "11": "Gandhi Nagar", "12": "Collectorate",
    "13": "Hospital",     "14": "Purani Basti",
    "90": "Head Office",
}


def get_db():
    try:
        return mysql.connector.connect(**DB_CONFIG)
    except Error as e:
        raise HTTPException(status_code=503, detail=f"DB connection failed: {e}")


def branch_clause(alias: str, branch: Optional[str]) -> tuple[str, list]:
    """Return a WHERE/AND fragment and params list for optional branch filter."""
    if branch:
        return f" AND {alias}.CurBrCode = %s", [branch]
    return "", []


# ── Branches ──────────────────────────────────────────────────────────────────

@app.get("/api/branches")
def get_branches():
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(
            "SELECT AlphaCode, BranchName, City, BrnCode FROM branchmaster ORDER BY BrnCode"
        )
        rows = cur.fetchall()
    finally:
        cur.close(); conn.close()

    return [
        {
            "code":  str(r["BrnCode"]),
            "alpha": r["AlphaCode"],
            "name":  r["BranchName"],
            "city":  r["City"],
            "short": BRANCH_NAMES.get(str(r["BrnCode"]), r["BranchName"]),
        }
        for r in rows
    ]


# ── Accounts ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/accounts")
def get_accounts(branch: Optional[str] = Query(None)):
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    frag, params = branch_clause("am", branch)
    try:
        # Total customer count
        cur.execute("SELECT COUNT(*) AS total FROM cbs_customer_master_detail")
        cust = cur.fetchone()

        # SB + CA counts per branch
        cur.execute(f"""
            SELECT am.CurBrCode, am.Accttype, COUNT(*) AS count
            FROM accountmaster am
            WHERE am.Accttype IN ('10','01') {frag}
            GROUP BY am.CurBrCode, am.Accttype
            ORDER BY am.CurBrCode
        """, params)
        sb_ca_rows = cur.fetchall()

        # New accounts per year trend (all types)
        cur.execute(f"""
            SELECT SUBSTR(am.OpeningDt,1,4) AS year, COUNT(*) AS new_accounts
            FROM accountmaster am
            WHERE am.OpeningDt IS NOT NULL AND am.OpeningDt != ''
              AND SUBSTR(am.OpeningDt,1,4) >= '2020' {frag}
            GROUP BY SUBSTR(am.OpeningDt,1,4)
            ORDER BY year
        """, params)
        trend_rows = cur.fetchall()

        # Account type distribution (top 6)
        cur.execute(f"""
            SELECT am.Accttype AS code, COUNT(*) AS count
            FROM accountmaster am
            WHERE 1=1 {frag}
            GROUP BY am.Accttype
            ORDER BY count DESC
            LIMIT 6
        """, params)
        type_rows = cur.fetchall()

        # Total accounts
        cur.execute(f"""
            SELECT COUNT(*) AS total FROM accountmaster am WHERE 1=1 {frag}
        """, params)
        total_row = cur.fetchone()

    finally:
        cur.close(); conn.close()

    total = total_row["total"]
    sb_ca_total = sum(r["count"] for r in sb_ca_rows)
    sb_total = sum(r["count"] for r in sb_ca_rows if r["Accttype"] == "10")
    ca_total = sum(r["count"] for r in sb_ca_rows if r["Accttype"] == "01")

    # Branch breakdown for SB+CA
    branch_sb_ca: dict = {}
    for r in sb_ca_rows:
        bc = r["CurBrCode"]
        if bc not in branch_sb_ca:
            branch_sb_ca[bc] = {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc), "sb": 0, "ca": 0}
        if r["Accttype"] == "10":
            branch_sb_ca[bc]["sb"] = r["count"]
        elif r["Accttype"] == "01":
            branch_sb_ca[bc]["ca"] = r["count"]

    branch_data = sorted(branch_sb_ca.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["total"] = b["sb"] + b["ca"]

    new_this_year = next(
        (r["new_accounts"] for r in trend_rows if r["year"] == "2026"), 0
    )

    return {
        "total_customers": cust["total"],
        "total":           total,
        "sb_total":        sb_total,
        "ca_total":        ca_total,
        "new_this_year":   new_this_year,
        "trend":           [{"year": r["year"], "count": r["new_accounts"]} for r in trend_rows],
        "type_distribution": [
            {"name": ACCT_NAMES.get(r["code"], f'Type {r["code"]}'), "count": r["count"]}
            for r in type_rows
        ],
        "branch_breakdown": branch_data,
    }


# ── Deposits ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/deposits")
def get_deposits(branch: Optional[str] = Query(None)):
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    frag, params = branch_clause("am", branch)
    frag_td, params_td = branch_clause("tdam", branch)
    try:
        # Fixed Deposits (live vouchers)
        cur.execute(f"""
            SELECT tdam.CurBrCode,
                   COUNT(*)        AS count,
                   SUM(tv.PrinAmt) AS principal,
                   SUM(tv.CumuPrinAmt) AS maturity_amt
            FROM td_vouchmst tv
            JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
            WHERE tv.Status = 'A' {frag_td}
            GROUP BY tdam.CurBrCode
            ORDER BY tdam.CurBrCode
        """, params_td)
        td_rows = cur.fetchall()

        # Recurring Deposits
        cur.execute(f"""
            SELECT am.CurBrCode, COUNT(*) AS count
            FROM accountmaster am
            WHERE am.Accttype = '09' {frag}
            GROUP BY am.CurBrCode
            ORDER BY am.CurBrCode
        """, params)
        rd_rows = cur.fetchall()

        # Home Deposits (Pigmy / Daily Deposit scheme)
        cur.execute(f"""
            SELECT am.CurBrCode, COUNT(*) AS count
            FROM accountmaster am
            WHERE am.Accttype = '15' {frag}
            GROUP BY am.CurBrCode
            ORDER BY am.CurBrCode
        """, params)
        hd_rows = cur.fetchall()

        # TD maturity trend — maturing per quarter this year
        cur.execute(f"""
            SELECT
                QUARTER(tv.MatDt) AS qtr,
                COUNT(*)           AS count,
                SUM(tv.CumuPrinAmt) AS amount
            FROM td_vouchmst tv
            JOIN td_accountmaster tdam ON tv.ACNO = tdam.ACNO
            WHERE tv.Status = 'A'
              AND YEAR(tv.MatDt) = 2026 {frag_td}
            GROUP BY QUARTER(tv.MatDt)
            ORDER BY qtr
        """, params_td)
        maturity_rows = cur.fetchall()

    finally:
        cur.close(); conn.close()

    # Aggregate totals
    td_count     = sum(r["count"] for r in td_rows)
    td_principal = sum(float(r["principal"] or 0) for r in td_rows)
    td_maturity  = sum(float(r["maturity_amt"] or 0) for r in td_rows)
    rd_count     = sum(r["count"] for r in rd_rows)
    hd_count     = sum(r["count"] for r in hd_rows)

    # Branch table combining all deposit types
    branch_map: dict = {}
    for r in td_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0, "rd_count": 0, "hd_count": 0})
        branch_map[bc]["td_count"]     = r["count"]
        branch_map[bc]["td_principal"] = float(r["principal"] or 0)
    for r in rd_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0, "rd_count": 0, "hd_count": 0})
        branch_map[bc]["rd_count"] = r["count"]
    for r in hd_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {"branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
                                   "td_count": 0, "td_principal": 0.0, "rd_count": 0, "hd_count": 0})
        branch_map[bc]["hd_count"] = r["count"]

    branch_data = sorted(branch_map.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["total_accounts"] = b["td_count"] + b["rd_count"] + b["hd_count"]

    qtr_labels = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
    maturity_trend = [
        {"quarter": qtr_labels.get(r["qtr"], f"Q{r['qtr']}"),
         "count": r["count"], "amount": float(r["amount"] or 0)}
        for r in maturity_rows
    ]

    return {
        "td_count":      td_count,
        "td_principal":  td_principal,
        "td_maturity":   td_maturity,
        "rd_count":      rd_count,
        "hd_count":      hd_count,
        "total_deposit_accounts": td_count + rd_count + hd_count,
        "maturity_trend":   maturity_trend,
        "branch_breakdown": branch_data,
    }


# ── Advances ──────────────────────────────────────────────────────────────────

@app.get("/api/metrics/advances")
def get_advances(branch: Optional[str] = Query(None)):
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    frag, params = branch_clause("am", branch)
    try:
        # NPA classification by branch
        cur.execute(f"""
            SELECT am.CurBrCode, lbd.NPA_CLASSIFICATION,
                   COUNT(*)             AS count,
                   SUM(lbd.SANCTION_AMT) AS sanction_amt
            FROM cbs_loan_borrower_details lbd
            JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
            WHERE 1=1 {frag}
            GROUP BY am.CurBrCode, lbd.NPA_CLASSIFICATION
            ORDER BY am.CurBrCode
        """, params)
        npa_rows = cur.fetchall()

        # Loan type breakdown
        cur.execute(f"""
            SELECT am.Accttype, COUNT(*) AS count, SUM(lbd.SANCTION_AMT) AS sanction_amt
            FROM cbs_loan_borrower_details lbd
            JOIN accountmaster am ON lbd.ACC_NO = am.ACNo
            WHERE 1=1 {frag}
            GROUP BY am.Accttype
            ORDER BY count DESC
        """, params)
        type_rows = cur.fetchall()

    finally:
        cur.close(); conn.close()

    total        = sum(r["count"] for r in npa_rows)
    standard     = sum(r["count"] for r in npa_rows if r["NPA_CLASSIFICATION"] == "0")
    npa_count    = total - standard
    total_sanc   = sum(float(r["sanction_amt"] or 0) for r in npa_rows)
    npa_sanc     = sum(float(r["sanction_amt"] or 0) for r in npa_rows if r["NPA_CLASSIFICATION"] != "0")

    # NPA classification totals
    class_map: dict = {}
    for r in npa_rows:
        key = NPA_LABELS.get(r["NPA_CLASSIFICATION"], r["NPA_CLASSIFICATION"])
        if key not in class_map:
            class_map[key] = {"label": key, "count": 0, "amount": 0.0}
        class_map[key]["count"]  += r["count"]
        class_map[key]["amount"] += float(r["sanction_amt"] or 0)

    classification = sorted(
        class_map.values(),
        key=lambda x: NPA_ORDER.index(x["label"]) if x["label"] in NPA_ORDER else 99
    )

    # Branch breakdown
    branch_map: dict = {}
    for r in npa_rows:
        bc = r["CurBrCode"]
        branch_map.setdefault(bc, {
            "branch_code": bc, "branch": BRANCH_NAMES.get(bc, bc),
            "total": 0, "standard": 0, "npa_count": 0, "sanction_amt": 0.0,
        })
        cnt = r["count"]
        amt = float(r["sanction_amt"] or 0)
        branch_map[bc]["total"]      += cnt
        branch_map[bc]["sanction_amt"] += amt
        if r["NPA_CLASSIFICATION"] == "0":
            branch_map[bc]["standard"] += cnt
        else:
            branch_map[bc]["npa_count"] += cnt

    branch_data = sorted(branch_map.values(), key=lambda x: x["branch_code"])
    for b in branch_data:
        b["npa_ratio"] = round(b["npa_count"] / b["total"] * 100, 1) if b["total"] > 0 else 0

    return {
        "total":          total,
        "standard":       standard,
        "npa_count":      npa_count,
        "npa_ratio":      round(npa_count / total * 100, 1) if total > 0 else 0,
        "total_sanction": total_sanc,
        "npa_sanction":   npa_sanc,
        "classification": classification,
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


# ── KYC (with branch via cbs_cust_kyc_details + accountmaster link) ───────────

@app.get("/api/metrics/kyc")
def get_kyc(branch: Optional[str] = Query(None)):
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    try:
        if branch:
            cur.execute("""
                SELECT
                    COUNT(*)  AS total,
                    SUM(CASE WHEN k.KycVerifiedBy IS NOT NULL THEN 1 ELSE 0 END) AS verified,
                    SUM(CASE WHEN k.KycVerifiedBy IS NULL     THEN 1 ELSE 0 END) AS pending
                FROM cbs_cust_kyc_details k
                WHERE k.BrnCode = %s
            """, [branch])
        else:
            cur.execute("""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN KycVerifiedBy IS NOT NULL THEN 1 ELSE 0 END) AS verified,
                    SUM(CASE WHEN KycVerifiedBy IS NULL     THEN 1 ELSE 0 END) AS pending
                FROM cbs_cust_kyc_details
            """)
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()

    total    = row["total"] or 0
    verified = int(row["verified"] or 0)
    pending  = int(row["pending"] or 0)

    return {
        "total":           total,
        "verified":        verified,
        "pending":         pending,
        "compliance_rate": round(verified / total * 100, 1) if total > 0 else 0,
    }


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}
