#!/usr/bin/env bash
# Menyiapkan lingkungan PoC dari nol: PostgreSQL 16, PgBouncer (mode transaksi), skema, dependensi.
# Prasyarat: PostgreSQL 16 (server + client), PgBouncer >= 1.21, Python 3.10+, Node.js 20+.
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -x "$PG_BIN/initdb" ] || { echo "PG_BIN tidak ditemukan ($PG_BIN). Set PG_BIN=/path/ke/bin PostgreSQL 16."; exit 1; }
command -v pgbouncer >/dev/null || { echo "pgbouncer tidak ditemukan di PATH."; exit 1; }
"$PG_BIN/postgres" --version | grep -q " 16\." || echo "PERINGATAN: PoC divalidasi pada PostgreSQL 16."

if [ "$(id -u)" = "0" ] && ! id "$RUN_AS" >/dev/null 2>&1; then useradd -m "$RUN_AS"; fi
bash "$(dirname "$0")/teardown.sh" >/dev/null 2>&1 || true
# Pengaman: hanya menghapus folder yang memang dibuat skrip ini (berpenanda), atau folder kosong.
if [ -d "$POC_RUNTIME" ] && [ -n "$(ls -A "$POC_RUNTIME" 2>/dev/null)" ] && [ ! -f "$POC_RUNTIME/.poc_runtime_marker" ]; then
  echo "MENOLAK menghapus $POC_RUNTIME: bukan folder runtime PoC (tidak ada .poc_runtime_marker)."; exit 2
fi
case "$(realpath -m "$POC_RUNTIME")" in /|/home|/root|/usr|/etc|/var|"$HOME") echo "MENOLAK: POC_RUNTIME berbahaya ($POC_RUNTIME)"; exit 2;; esac
rm -rf "$POC_RUNTIME"; mkdir -p "$POC_RUNTIME/pgb" "$POC_SOCK" "$POC_RESULTS"; touch "$POC_RUNTIME/.poc_runtime_marker"
[ "$(id -u)" = "0" ] && chown -R "$RUN_AS" "$POC_RUNTIME"
chmod 777 "$POC_RUNTIME" "$POC_SOCK"

echo "== PostgreSQL utama di port $PG_PORT"
as_pg "'$PG_BIN/initdb' -D '$POC_RUNTIME/main' -U postgres -A trust >/dev/null"
as_pg "'$PG_BIN/pg_ctl' -D '$POC_RUNTIME/main' -l '$POC_RUNTIME/main.log' -w -o \"-p $PG_PORT -k $POC_SOCK -c listen_addresses='' -c max_connections=1200 -c shared_buffers=256MB -c track_commit_timestamp=on\" start" >/dev/null
psql_admin -d postgres -c "create database poc" -c "create database tombstone_store"
# Migrasi: ON_ERROR_STOP + set -e -> error SQL menghentikan setup dengan exit != 0 (audit R2-03)
export PGOPTIONS="-c client_min_messages=warning"
psql_admin -d poc -f "${POC_SCHEMA:-$REPO/db/schema.sql}"
psql_admin -d poc -f "$REPO/db/iam.sql"
unset PGOPTIONS

echo "== PgBouncer mode transaksi di 127.0.0.1:$PGB_PORT"
sed -e "s#@SOCK@#$POC_SOCK#g" -e "s#@PG_PORT@#$PG_PORT#g" -e "s#@PGB_PORT@#$PGB_PORT#g" -e "s#@RUNTIME@#$POC_RUNTIME#g" \
    "$REPO/config/pgbouncer.ini.template" > "$POC_RUNTIME/pgb/pgbouncer.ini"
cp "$REPO/config/userlist.txt" "$POC_RUNTIME/pgb/userlist.txt"
[ "$(id -u)" = "0" ] && chown -R "$RUN_AS" "$POC_RUNTIME/pgb"
as_pg "pgbouncer -d '$POC_RUNTIME/pgb/pgbouncer.ini'"
sleep 1

echo "== Dependensi"
python3 -c "import psycopg" 2>/dev/null || pip install "psycopg[binary]>=3.2" ${PIP_EXTRA:-}
( cd "$REPO/api" && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null )
echo "Siap. Jalankan: bash scripts/run_all.sh"
