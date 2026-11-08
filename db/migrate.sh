#!/usr/bin/env bash
# Menjalankan migrasi berurutan. Gagal total pada error SQL pertama (audit R2-03).
# Koneksi admin lewat variabel standar libpq: PGHOST, PGPORT, PGUSER, PGDATABASE (dan PGPASSWORD bila perlu).
# Setiap file dijalankan dalam satu transaksi dan dicatat beserta SHA-256-nya; file yang sudah tercatat
# dilewati, dan bila isinya berubah setelah diterapkan, migrasi ditolak.
set -Eeuo pipefail

DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "$0")" && pwd)/migrations}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

"${PSQL[@]}" <<'SQL'
create schema if not exists meta;
revoke all on schema meta from public;
create table if not exists meta.schema_migration (
  filename   text primary key,
  sha256     text not null,
  applied_at timestamptz not null default now()
);
SQL

shopt -s nullglob
files=("$DIR"/*.sql)
[ ${#files[@]} -gt 0 ] || { echo "Tidak ada file migrasi di $DIR" >&2; exit 2; }

for f in "${files[@]}"; do
  name="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  applied="$("${PSQL[@]}" -tA -c "select sha256 from meta.schema_migration where filename = '$name'")"
  if [ -n "$applied" ]; then
    if [ "$applied" != "$sum" ]; then
      echo "MIGRASI DITOLAK: $name sudah diterapkan dengan isi berbeda." >&2
      exit 3
    fi
    continue
  fi
  echo "== migrasi $name"
  { cat "$f"; printf "\ninsert into meta.schema_migration (filename, sha256) values ('%s', '%s');\n" "$name" "$sum"; } \
    | "${PSQL[@]}" --single-transaction -f -
done
echo "Migrasi selesai."
