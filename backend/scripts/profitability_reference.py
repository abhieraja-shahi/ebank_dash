"""Reference implementation of Dashboard/PROFITABILITY_METRICS_METHODOLOGY.md.

Produces the worked-example numbers in §9 of that doc. GL_MAP, PRODUCTS and the reserve codes
below are ccbl260817's; another bank needs its own (doc §4.3).

    cd Dashboard/backend && .venv/Scripts/python scripts/profitability_reference.py
"""
import time
from datetime import date
from pathlib import Path
import pymysql

env = {}
for line in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
conn = pymysql.connect(host=env["DB_HOST"], user=env["DB_USER"], password=env.get("DB_PASSWORD", ""),
                       db=env["DB_NAME"], read_timeout=900, cursorclass=pymysql.cursors.DictCursor)

def q(sql, params=None):
    t = time.time()
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        rows = cur.fetchall()
    print(f"  [{time.time()-t:5.1f}s] {sql.strip().splitlines()[0][:70]}")
    return rows

# ---------------------------------------------------------------- GL mapping (ccbl)
GL_MAP = {
    "06302501": "int_inc_advances", "06302502": "int_inc_advances", "06302503": "int_inc_advances",
    "06302505": "int_inc_investments", "06302601": "int_inc_investments", "06302740": "int_inc_investments",
    "06402353": "int_inc_investments",
    "06402001": "int_exp_deposits", "06402002": "int_exp_deposits", "06402003": "int_exp_deposits",
    "06302984": "non_operating", "06403051": "non_operating", "06403052": "non_operating",
    "06302881": "other_income", "06402632": "other_income",
    "06402700": "prov_loans", "06402850": "prov_loans", "06403001": "prov_loans",
    "06402901": "prov_investments", "06403002": "prov_investments",
    "06402900": "prov_other", "06402950": "prov_other", "06403003": "prov_other", "06402617": "prov_other",
    "06403100": "tax", "06402364": "tax", "06402365": "tax",
    "06302721": "inter_branch", "06302722": "inter_branch", "06402051": "inter_branch", "06402151": "inter_branch",
    "06402000": "pl_control", "06499999": "pl_control",
}
def bucket(code):
    if code in GL_MAP:
        return GL_MAP[code], True
    return ("other_income" if code.startswith("063") else "operating_expense"), False

# ---------------------------------------------------------------- P&L
PL_SQL = """
SELECT SUBSTR(g.AcNo,1,2) AS branch, SUBSTR(g.AcNo,3,8) AS gl_code, MIN(TRIM(g.AcName)) AS head,
       SUM(r.CrAmt - r.DrAmt) AS net_credit
FROM gltable g
JOIN gl_recon r ON r.ACNo = g.AcNo
WHERE SUBSTR(g.AcNo,3,3) IN ('063','064')
  AND r.auth = 'Y'
  AND COALESCE(r.TranDesc,0) <> 13
  AND (
        (r.Dt >= %(from_dt)s AND r.Dt < %(to_dt)s
         AND NOT (r.TranDesc = 77 AND r.ValueDt < %(from_dt)s))
     OR (r.Dt >= %(to_dt)s AND r.TranDesc = 77
         AND r.ValueDt >= %(from_dt)s AND r.ValueDt < %(to_dt)s)
      )
GROUP BY branch, gl_code
"""
def pl(from_dt, to_dt, branch=None):
    rows = q(PL_SQL, dict(from_dt=from_dt, to_dt=to_dt))
    b = {}
    unmapped = set()
    for r in rows:
        if branch and r["branch"] != branch:
            continue
        name, mapped = bucket(r["gl_code"])
        if not mapped:
            unmapped.add(r["gl_code"])
        if name == "pl_control" or (name == "inter_branch" and not branch):
            continue
        b[name] = b.get(name, 0.0) + float(r["net_credit"])
    inc = lambda k: b.get(k, 0.0)
    exp = lambda k: -b.get(k, 0.0)
    L = {}
    L["interest_income"] = inc("int_inc_advances") + inc("int_inc_investments")
    L["  on advances"] = inc("int_inc_advances")
    L["  on investments"] = inc("int_inc_investments")
    L["interest_expense"] = exp("int_exp_deposits") + exp("int_exp_borrowings")
    L["inter_branch_net"] = inc("inter_branch")
    L["NII"] = L["interest_income"] - L["interest_expense"] + L["inter_branch_net"]
    L["other_income"] = inc("other_income")
    L["net_operating_income"] = L["NII"] + L["other_income"]
    L["operating_expense"] = exp("operating_expense")
    L["operating_profit"] = L["net_operating_income"] - L["operating_expense"]
    L["non_operating"] = inc("non_operating")
    L["prov_loans"] = exp("prov_loans")
    L["prov_investments"] = exp("prov_investments")
    L["prov_other"] = exp("prov_other")
    L["provisions"] = L["prov_loans"] + L["prov_investments"] + L["prov_other"]
    L["tax"] = exp("tax")
    L["net_profit"] = L["operating_profit"] + L["non_operating"] - L["provisions"] - L["tax"]
    return L, sorted(unmapped)

print("P&L FY25-26")
L, unmapped = pl("2025-04-01", "2026-04-01")
for k, v in L.items():
    print(f"  {k:24s} {v/1e7:8.4f} Cr")
print("  unmapped codes (defaulted by prefix):", len(unmapped))

# cross-check: closing entries reverse the net profit
chk = q("""SELECT -SUM(r.CrAmt-r.DrAmt) AS np FROM gltable g JOIN gl_recon r ON r.ACNo=g.AcNo
           WHERE SUBSTR(g.AcNo,3,3) IN ('063','064') AND r.TranDesc=13
             AND r.Dt >= '2025-04-01' AND r.Dt < DATE_ADD('2026-04-01', INTERVAL 7 DAY)""")[0]["np"]
print(f"  cross-check TranDesc13 net profit {float(chk)/1e7:.4f} Cr")

# ---------------------------------------------------------------- balance history from ledgers
PRODUCTS = {  # accttype -> (ledger, class)
    "03": "deposit_sb", "08": "deposit_sb", "10": "deposit_sb", "16": "deposit_sb",
    "01": "deposit_ca", "09": "deposit_rd", "05": "deposit_fd",
    "02": "advance_cc_od", "07": "advance_cc_od", "04": "advance_dl",
    # 12/13/14 are TL products (Decreed / Protested Bill / Suit Filed), not AccStatus codes
    "11": "advance_tl", "12": "advance_tl", "13": "advance_tl", "14": "advance_tl",
}
LEDGERS = {
    "recon":      "auth='Y'",
    "ca_recon":   "auth='Y'",
    "rdrecon":    "auth='Y'",
    "loan_recon": "auth='Y'",
    "td_recon":   "auth='Y' AND closeflag IS NULL",
}
print("Ledger month movements")
movement = {}  # (class, branch, ym) -> net
for table, cond in LEDGERS.items():
    rows = q(f"""SELECT SUBSTR(acno,1,2) AS branch, SUBSTR(acno,3,2) AS prod, DATE_FORMAT(dt,'%%Y%%m') AS ym,
                        SUM(cramt-dramt) AS net
                 FROM {table} WHERE {cond} GROUP BY branch, prod, ym""")
    for r in rows:
        cls = PRODUCTS.get(r["prod"])
        if cls:
            key = (cls, r["branch"], r["ym"])
            movement[key] = movement.get(key, 0.0) + float(r["net"])

def month_end_series(cls, branch=None):
    per_ym = {}
    for (c, br, ym), v in movement.items():
        if c == cls and (branch is None or br == branch):
            per_ym[ym] = per_ym.get(ym, 0.0) + v
    out, run = {}, 0.0
    for ym in sorted(per_ym):
        run += per_ym[ym]
        out[ym] = run
    return out

def at(series, ym):
    ks = [k for k in series if k <= ym]
    return series[max(ks)] if ks else 0.0

FY = [f"2025{m:02d}" for m in range(4, 13)] + [f"2026{m:02d}" for m in range(1, 4)]
CLASSES = ["deposit_sb", "deposit_ca", "deposit_rd", "deposit_fd", "advance_tl", "advance_dl", "advance_cc_od"]
series = {c: month_end_series(c) for c in CLASSES}
avg = {c: sum(at(series[c], ym) for ym in FY) / len(FY) for c in CLASSES}
now = {c: at(series[c], "202608") for c in CLASSES}
print("  class            avgFY25-26   closing(Aug-26)")
for c in CLASSES:
    print(f"  {c:16s} {avg[c]/1e7:9.2f} {now[c]/1e7:12.2f}")
avg_dep = sum(avg[c] for c in CLASSES if c.startswith("deposit"))
avg_adv = -sum(avg[c] for c in CLASSES if c.startswith("advance"))
cls_dep = sum(now[c] for c in CLASSES if c.startswith("deposit"))
cls_adv = -sum(now[c] for c in CLASSES if c.startswith("advance"))
print(f"  avg deposits {avg_dep/1e7:.2f}  avg advances {avg_adv/1e7:.2f}  closing deposits {cls_dep/1e7:.2f}  closing advances {cls_adv/1e7:.2f}")

# ---------------------------------------------------------------- ratios
print("Ratios FY25-26 (average basis)")
print(f"  Cost of Funds        {L['interest_expense']/avg_dep*100:6.2f}%")
print(f"  Yield on Advances    {L['  on advances']/avg_adv*100:6.2f}%")
print(f"  Cost-to-Income       {L['operating_expense']/L['net_operating_income']*100:6.2f}%")
print(f"  CD ratio (avg)       {avg_adv/avg_dep*100:6.2f}%")

# ---------------------------------------------------------------- NPA and provisioning (as of snapshot date)
AS_OF = date(2026, 8, 17)
npa = q("""
SELECT x.acno, x.accttype, x.status, x.outstanding, x.security_value,
  (SELECT MIN(s.EFFDT) FROM accountstatus s WHERE s.acno = x.acno AND s.AUTH='Y'
      AND s.SPFLAG IN ('11','12','13') AND s.EFFDT > COALESCE(x.last_upgrade,'1900-01-01')) AS npa_since,
  (SELECT MIN(s.EFFDT) FROM accountstatus s WHERE s.acno = x.acno AND s.AUTH='Y'
      AND s.SPFLAG IN ('12','13') AND s.EFFDT > COALESCE(x.last_upgrade,'1900-01-01')) AS doubtful_since
FROM (
  SELECT am.ACNo AS acno, am.Accttype AS accttype, am.AccStatus AS status,
         -COALESCE(rb.Balance, cb.Balance) AS outstanding,
         (SELECT COALESCE(SUM(ls.matvalue),0) FROM loansecurity ls
           WHERE ls.Acno = am.ACNo AND UPPER(ls.Status) = 'ACTIVE') AS security_value,
         (SELECT MAX(s.EFFDT) FROM accountstatus s WHERE s.acno = am.ACNo AND s.AUTH='Y' AND s.SPFLAG = '1'
             AND s.EFFDT < (SELECT MAX(s2.EFFDT) FROM accountstatus s2
                             WHERE s2.acno = am.ACNo AND s2.SPFLAG IN ('11','12','13'))) AS last_upgrade
  FROM accountmaster am
  LEFT JOIN reconbalan    rb ON rb.acno = am.ACNo
  LEFT JOIN ca_reconbalan cb ON cb.acno = am.ACNo
  WHERE am.AccStatus IN (11,12,13)
) x""")

RATES = dict(standard=0.004, sub_standard=0.10, d1_secured=0.20, d2_secured=0.30, d3=1.00, unsecured=1.00, loss=1.00)
def years(d0):
    return (AS_OF - d0.date()).days / 365.25 if d0 else None

gross = {11: 0.0, 12: 0.0, 13: 0.0}
required_npa = 0.0
for r in npa:
    out = float(r["outstanding"] or 0)
    gross[r["status"]] += out
    secured = min(out, float(r["security_value"] or 0))
    unsecured = out - secured
    if r["status"] == 11:
        req = out * RATES["sub_standard"]
    elif r["status"] == 13:
        req = out * RATES["loss"]
    else:
        age = years(r["doubtful_since"])
        if age is None or age <= 1:
            sr = RATES["d1_secured"]
        elif age <= 3:
            sr = RATES["d2_secured"]
        else:
            sr = RATES["d3"]
        req = secured * sr + unsecured * RATES["unsecured"]
    required_npa += req
gross_npa = sum(gross.values())
standard_adv = cls_adv - gross_npa
required_std = standard_adv * RATES["standard"]
print("NPA as of", AS_OF)
print(f"  accounts {len(npa)}  sub-std {gross[11]/1e7:.4f}  doubtful {gross[12]/1e7:.4f}  loss {gross[13]/1e7:.4f}  gross {gross_npa/1e7:.4f} Cr")
print(f"  gross NPA % {gross_npa/cls_adv*100:.2f}%")
print(f"  required: NPA {required_npa/1e7:.4f}  standard {required_std/1e7:.4f}  total {(required_npa+required_std)/1e7:.4f} Cr")

held = {r["gl_code"]: float(r["bal"]) for r in q("""
SELECT SUBSTR(g.AcNo,3,8) AS gl_code, SUM(r.CrAmt - r.DrAmt) AS bal
FROM gltable g JOIN gl_recon r ON r.ACNo = g.AcNo
WHERE SUBSTR(g.AcNo,3,8) IN ('06103141','06103142','06103195','06103194','06103180','06103051')
  AND r.auth = 'Y'
GROUP BY gl_code""")}
print("  held:", {k: round(v/1e7, 4) for k, v in held.items()})
npa_prov_held = held.get("06103141", 0) + held.get("06103142", 0) + held.get("06103195", 0)
std_prov_held = held.get("06103194", 0)
net_npa = max(0.0, gross_npa - npa_prov_held)
print(f"  net NPA {net_npa/1e7:.4f} Cr  net NPA % {net_npa/max(cls_adv-npa_prov_held,1)*100:.2f}%  PCR {npa_prov_held/gross_npa*100 if gross_npa else 0:.1f}%")
print(f"  surplus NPA prov {(npa_prov_held-required_npa)/1e7:.4f}  surplus std prov {(std_prov_held-required_std)/1e7:.4f} Cr")

# branch prefix consistency
print(q("""SELECT COUNT(*) AS n, SUM(CurBrCode <> SUBSTR(ACNo,1,2)) AS mismatched,
                  SUM(Accttype <> SUBSTR(ACNo,3,2)) AS type_mismatch FROM accountmaster"""))
