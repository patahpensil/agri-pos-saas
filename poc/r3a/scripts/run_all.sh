#!/usr/bin/env bash
# Menjalankan seluruh uji PoC dan mencetak ringkasan. Keluar dengan kode 1 bila ada FAIL.
set -uo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$POC_RESULTS"; rm -f "$POC_RESULTS"/*.json "$POC_RESULTS"/*.log
cd "$REPO"

run() { echo "== $1"; shift; "$@" > "$POC_RESULTS/$LOG.log" 2>&1; tail -n 3 "$POC_RESULTS/$LOG.log"; }

LOG=db       run "Uji database T-01..T-10 + tambahan + beban" python3 tests/run_tests.py
LOG=pooler   run "Uji pooler mode transaksi (PgBouncer)"      python3 tests/pooler_test.py
LOG=api_direct    run "Uji API langsung ke PostgreSQL" \
  env DEV_EXPOSE_OTP=1 POOL_MAX=1 APP_DB_HOST="$POC_SOCK" APP_DB_PORT="$PG_PORT" API_LABEL=direct \
      bash -c "cd api && npx tsx api_tests.ts"
LOG=api_pgbouncer run "Uji API lewat PgBouncer" \
  env DEV_EXPOSE_OTP=1 POOL_MAX=10 APP_DB_HOST=127.0.0.1 APP_DB_PORT="$PGB_PORT" API_LABEL=pgbouncer \
      bash -c "cd api && npx tsx api_tests.ts"
LOG=pitr     run "Uji PITR (WAL + recovery_target_time + tombstone)" python3 tests/pitr_test.py
LOG=meta     run "Uji meta: setup wajib gagal pada migrasi salah" bash tests/meta_setup_fails.sh

python3 - "$POC_RESULTS" <<'EOF'
import json, sys, glob, os
total = fail = 0
expected = ["db_results.json", "pooler_results.json", "api_results_direct.json", "api_results_pgbouncer.json", "pitr_results.json", "meta_results.json"]
missing = [e for e in expected if not os.path.exists(os.path.join(sys.argv[1], e))]
print("\n================ RINGKASAN ================")
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.json"))):
    data = json.load(open(f))
    rows = data if isinstance(data, list) else [{"id": "PITR", "status": data.get("status")}]
    p = sum(r["status"] == "PASS" for r in rows); total += len(rows); fail += len(rows) - p
    print(f"{os.path.basename(f):32s} {p}/{len(rows)} PASS" + ("" if p == len(rows) else "   <-- ADA FAIL: " + ", ".join(r["id"] for r in rows if r["status"] != "PASS")))
for m in missing: print(f"{m:32s} TIDAK ADA — tahap gagal dijalankan (lihat log)")
print(f"TOTAL: {total - fail}/{total} PASS" + (f"; {len(missing)} tahap gagal dijalankan" if missing else ""))
sys.exit(1 if fail or missing or total == 0 else 0)
EOF
