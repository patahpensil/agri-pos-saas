"""Gerbang CI: setiap ID uji wajib harus ada dan PASS pada target yang ditentukan.
Uji yang hilang dihitung BELUM DIUJI dan menggagalkan gerbang. Ringkasan ditulis ke GITHUB_STEP_SUMMARY."""
import json
import os
import sys

DB = "integrasi DB"
API = "API"
COMMON = (
    [(f"T-DB-0{i}", DB) for i in range(1, 7)] + [("T-DB-07", "uji meta")]
    + [(f"SEC-FIX-0{i}", DB) for i in range(1, 10)]
    + [("SEC-FIX-02", API), ("SEC-FIX-05", API), ("SEC-FIX-07", API), ("SEC-FIX-08", API), ("SEC-FIX-10", API)]
    + [("T-ROLE-01", DB), ("T-ROLE-01", API), ("T-TENANT-01", DB), ("T-TENANT-01", API), ("T-TENANT-02", DB), ("T-TENANT-02", API)]
    + [(f"T-AUTH-0{i}", API) for i in range(1, 7)]
    + [("T-API-01", API), ("T-ENT-01", API), ("T-SEC-01", API), ("T-SEC-02", API), ("T-SEC-03", "uji log"), ("HEALTH-01", API)]
    # Perbaikan audit independen PR #4
    + [("AUD-OTP-01", DB), ("AUD-OTP-01", API), ("AUD-OTP-02", "integrasi DB/pengirim OTP"),
       ("AUD-SESSION-01", DB), ("AUD-SESSION-01", API), ("AUD-LOGIN-01", DB), ("AUD-LOGIN-01", API),
       ("AUD-LOCK-01", DB), ("AUD-LOCK-01", API)]
)
# Uji mutasi (database terpisah, target langsung): kontrol dihapus -> ID ini WAJIB FAIL.
MUTATIONS = {
    "session_lock_login_reserve": ["AUD-SESSION-01"],
    "login_reserve": ["AUD-LOGIN-01"],
    "otp_expiry": ["AUD-OTP-02"],
    "lock_invite": ["AUD-LOCK-01"],
    "issue_grant": ["SEC-FIX-01", "T-DB-04"],
    "no_force": ["T-DB-02"],
}
EXPECTED = {
    "direct": COMMON + [(f"U-0{i}", "unit") for i in range(1, 6)] + [("T-CONFIG-01", "startup"), ("T-OTP-01", "startup"),
                                                                  ("T-TENANT-03", "DB langsung")],
    "pgbouncer": COMMON + [("T-TENANT-03", "DB lewat PgBouncer (transaksi)"),
                           ("T-TENANT-03-KONTROL", "DB lewat PgBouncer (transaksi)")],
}


def main(results_dir: str) -> int:
    lines = ["| Target | ID | Jenis | Status | Detail |", "|---|---|---|---|---|"]
    bad = 0
    counts = {"PASS": 0, "FAIL": 0, "BELUM DIUJI": 0}
    for target, expected in EXPECTED.items():
        path = os.path.join(results_dir, f"results-{target}.json")
        rows = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
        got = {(r["id"], r["kind"]): r for r in rows}
        for key in expected:
            r = got.get(key)
            status = r["status"] if r else "BELUM DIUJI"
            detail = (r["detail"] if r else "hasil tidak ditemukan").replace("|", "/")[:160]
            counts[status] += 1
            if status != "PASS":
                bad += 1
            lines.append(f"| {target} | {key[0]} | {key[1]} | {status} | {detail} |")
        extra = set(got) - set(expected)
        for key in sorted(extra):
            lines.append(f"| {target} | {key[0]} | {key[1]} | {got[key]['status']} | (tambahan) |")
            if got[key]["status"] != "PASS":
                bad += 1
    mut_ok = 0
    mut_total = 0
    mut_lines = ["", "| Mutasi | ID | Status saat kontrol dihapus | Terdeteksi |", "|---|---|---|---|"]
    for name, ids in MUTATIONS.items():
        vpath = os.path.join(results_dir, f"mutation-{name}", "verdict.json")
        v = json.load(open(vpath, encoding="utf-8")) if os.path.exists(vpath) else {"ids": {}}
        for i in ids:
            st = v["ids"].get(i, "BELUM DIUJI")
            mut_total += 1
            if st == "FAIL":
                mut_ok += 1
            else:
                bad += 1
            mut_lines.append(f"| {name} | {i} | {st} | {'YA' if st == 'FAIL' else 'TIDAK'} |")
    lines += mut_lines
    summary = f"PASS={counts['PASS']} FAIL={counts['FAIL']} BELUM DIUJI={counts['BELUM DIUJI']} (wajib {sum(len(v) for v in EXPECTED.values())}); mutasi terdeteksi {mut_ok}/{mut_total}"
    print(summary)
    print("\n".join(lines))
    out = os.environ.get("GITHUB_STEP_SUMMARY")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"## Uji backend PR fondasi\n\n**{summary}**\n\n" + "\n".join(lines) + "\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "results"))
