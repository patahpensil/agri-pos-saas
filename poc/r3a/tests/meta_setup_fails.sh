#!/usr/bin/env bash
# Uji meta (audit R2-03): setup.sh HARUS gagal bila migrasi SQL error.
# Memakai runtime & port terpisah agar tidak mengganggu lingkungan uji utama.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${POC_RESULTS:-$HERE/results}/meta_results.json"
export POC_RUNTIME="${POC_RUNTIME:-/tmp/poc_runtime}_meta" PG_PORT=$(( ${PG_PORT:-55432} + 10 )) PGB_PORT=$(( ${PGB_PORT:-6432} + 10 ))
export POC_SOCK="$POC_RUNTIME/sock" POC_RESULTS="${POC_RESULTS:-$HERE/results}"
POC_SCHEMA="$HERE/tests/fixtures/broken_migration.sql" bash "$HERE/scripts/setup.sh" > "$POC_RESULTS/meta_setup.log" 2>&1
code=$?
bash "$HERE/scripts/teardown.sh" >/dev/null 2>&1
err=$(grep -m1 -o 'ERROR:.*' "$POC_RESULTS/meta_setup.log" || true)
status=FAIL; [ "$code" -ne 0 ] && grep -q "ERROR" "$POC_RESULTS/meta_setup.log" && ! grep -q "^Siap" "$POC_RESULTS/meta_setup.log" && status=PASS
python3 - "$OUT" "$code" "$status" "$err" <<'PY'
import json, sys
out, code, status, err = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
json.dump([{"id": "META-01", "jenis": "Uji meta setup", "kondisi": "setup.sh dengan migrasi yang sengaja salah",
            "harapan": "exit != 0 dan berhenti sebelum 'Siap'", "aktual": f"exit={code}; {err}", "status": status}], open(out, "w"), indent=1)
print(f"[{status}] META-01: exit={code}; {err}")
PY
