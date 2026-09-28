# Demo name changes — `nrpbank` (localhost MySQL)

Applied 2026-09-28. Bank and branch names were replaced with dummy values for a demonstration. Nothing else was changed (addresses, cities, IFSC, phone, emails, PAN etc. are untouched).

Full backup of both tables (original data): `nrpbank_names_backup_20260928.sql`

## Bank name — `parameterinfo.BankName` (all 11 rows)

| Original | Dummy |
|----------|-------|
| NRP | DEMO BANK |

## Branch names — `branchmaster.BranchName`

| BrnCode | Original | Dummy |
|---------|----------|-------|
| 2  | MAIN BRANCH      | CENTRAL BRANCH |
| 3  | ALAMBAGH         | RIVERSIDE |
| 4  | KANPUR           | STATION ROAD |
| 5  | ALLAHABAD        | LAKEVIEW |
| 6  | MURADABAD        | MARKET SQUARE |
| 7  | VARANASI         | GREENFIELD |
| 11 | ATM BRANCH       | ATM SERVICES |
| 22 | NEFT RTGS BRANCH | PAYMENTS HUB |
| 33 | MOBILE BANKING   | DIGITAL BANKING |
| 90 | HEAD OFFICE      | HEAD OFFICE (unchanged) |
| 99 | PARAM            | SYSTEM BRANCH |

## Not changed (may still show real names)

`branchmaster.Address` / `City`, `parameterinfo.Address` / `City`, and the historical/customer tables (`cbs_customer_master_detail*.BankName/BranchName`, `share_holder*.BankName`, `bnkadd`, `clg_bankdirectory`). The dashboard does not read these.

## Revert

Option A — SQL (run against `nrpbank`):

```sql
START TRANSACTION;
UPDATE parameterinfo SET BankName = 'NRP';
UPDATE branchmaster SET BranchName = CASE BrnCode
  WHEN 2 THEN 'MAIN BRANCH'   WHEN 3 THEN 'ALAMBAGH'  WHEN 4 THEN 'KANPUR'
  WHEN 5 THEN 'ALLAHABAD'     WHEN 6 THEN 'MURADABAD' WHEN 7 THEN 'VARANASI'
  WHEN 11 THEN 'ATM BRANCH'   WHEN 22 THEN 'NEFT RTGS BRANCH'
  WHEN 33 THEN 'MOBILE BANKING' WHEN 90 THEN 'HEAD OFFICE' WHEN 99 THEN 'PARAM'
END;
COMMIT;
```

Option B — restore the backup (overwrites both tables from the dump):

```bash
mysql -u root -p nrpbank < nrpbank_names_backup_20260928.sql
```

After reverting, restart the backend (or wait for its TTL caches to expire) so cached branch/bank names refresh.
