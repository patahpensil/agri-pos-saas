#!/usr/bin/env bash
# Uji mutasi terisolasi: mengaktifkan versi RENTAN dari migrasi (penanda "@kontrol:NAMA" dihapus,
# baris "-- @mutasi:NAMA " diaktifkan) di database terpisah, lalu menjalankan uji terkait.
# Lulus bila SEMUA ID yang diharapkan FAIL (kontrol terbukti dideteksi uji).
#
# Pemakaian: mutation.sh NAMA[,NAMA2] ID[,ID2] [harapan]
#   harapan: FAIL (bawaan) atau PASS (untuk mutasi yang memang dijaga lapis kedua; informatif)
# Butuh env admin libpq (PGHOST, PGPORT, PGUSER), env uji TEST_RUNTIME_HOST/PORT, TEST_ADMIN_*,
# dan RESULTS_DIR. Backend harus sudah di-build (backend/dist).
set -Eeuo pipefail
export PGOPTIONS="-c client_min_messages=warning"
names="$1"; ids="$2"; expect="${3:-FAIL}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
tag="$(echo "$names" | tr 'A-Z,' 'a-z_')"
tmp="$(mktemp -d)"
cp "$root"/db/migrations/*.sql "$tmp"/
for n in ${names//,/ }; do
  sed -i -e "/@kontrol:${n}\b/d" -e "s/^-- @mutasi:${n} //" "$tmp"/*.sql
done
if diff -rq "$root/db/migrations" "$tmp" > /dev/null; then
  echo "MUTASI $names: tidak ada baris yang berubah (penanda hilang)" >&2
  exit 2
fi
db="mut_${tag}"
psql -X -q -d postgres -c "drop database if exists $db with (force)" -c "create database $db"
PGDATABASE="$db" MIGRATIONS_DIR="$tmp" bash "$root/db/migrate.sh" > /dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$root/db/test/test_security_params.sql"

out="$RESULTS_DIR/mutation-$tag"
mkdir -p "$out"
set +e
( cd "$root/backend" && TEST_TARGET=direct TEST_DB_NAME="$db" TEST_SUITES=db,aud TEST_ONLY_IDS="$ids" \
    TEST_RESULTS_DIR="$out" node dist/test/run.js ) > "$out/run.log" 2>&1
set -e
psql -X -q -d postgres -c "drop database if exists $db with (force)"

python3 - "$out/results-direct.json" "$ids" "$names" "$expect" <<'PY'
import json, sys
path, ids, names, expect = sys.argv[1], sys.argv[2].split(","), sys.argv[3], sys.argv[4]
rows = {r["id"]: r for r in json.load(open(path, encoding="utf-8"))}
ok = True
for i in ids:
    st = rows.get(i, {}).get("status", "BELUM DIUJI")
    det = rows.get(i, {}).get("detail", "")[:140]
    good = st == expect
    ok &= good
    print(f"MUTASI {names}: {i} = {st} (harapan {expect}) {'OK' if good else 'TIDAK SESUAI'} :: {det}")
json.dump({"mutation": names, "expect": expect, "ok": ok,
           "ids": {i: rows.get(i, {}).get("status", "BELUM DIUJI") for i in ids}},
          open(path.replace("results-direct.json", "verdict.json"), "w"))
sys.exit(0 if ok else 1)
PY
