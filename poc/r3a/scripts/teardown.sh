#!/usr/bin/env bash
# Menghentikan semua proses PoC. Data di $POC_RUNTIME tidak dihapus (dihapus oleh setup.sh).
source "$(dirname "$0")/env.sh"
[ -f "$POC_RUNTIME/pgb/pgbouncer.pid" ] && kill "$(cat "$POC_RUNTIME/pgb/pgbouncer.pid")" 2>/dev/null
for d in main pitr/src pitr/rst; do
  [ -d "$POC_RUNTIME/$d" ] && as_pg "'$PG_BIN/pg_ctl' -D '$POC_RUNTIME/$d' stop -m fast" 2>/dev/null
done
exit 0
