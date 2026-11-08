# Variabel bersama. Semua bisa ditimpa dari luar sebelum menjalankan skrip.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PG_BIN="${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PG_PORT="${PG_PORT:-55432}"            # PostgreSQL utama
export PGB_PORT="${PGB_PORT:-6432}"           # PgBouncer mode transaksi
export PITR_SRC_PORT="${PITR_SRC_PORT:-55433}"
export PITR_RST_PORT="${PITR_RST_PORT:-55434}"
export POC_RUNTIME="${POC_RUNTIME:-/tmp/poc_runtime}"   # data cluster, backup, arsip WAL
export POC_SOCK="${POC_SOCK:-$POC_RUNTIME/sock}"        # socket Unix PostgreSQL
export POC_RESULTS="${POC_RESULTS:-$REPO/results}"
export RUN_AS="${RUN_AS:-pgpoc}"                         # user OS bila skrip dijalankan sebagai root

as_pg() {   # PostgreSQL & PgBouncer menolak berjalan sebagai root
  if [ "$(id -u)" = "0" ]; then su "$RUN_AS" -c "$*"; else bash -c "$*"; fi
}
psql_admin() { "$PG_BIN/psql" -h "$POC_SOCK" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
