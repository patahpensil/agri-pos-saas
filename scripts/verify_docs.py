#!/usr/bin/env python3
"""Validate required design files + canonical PRD sha256 (stdlib only)."""
from pathlib import Path
import hashlib
import csv
import re

root = Path(__file__).resolve().parent.parent
required = [
    "README.md",
    "docs/PRD_V1_1_FINAL.md",
    "docs/SAD_V1_0_ARSITEKTUR_A.md",
    "docs/DATABASE_DESIGN_V1_0.md",
    "docs/API_CONTRACT_V1_0.md",
    "docs/SECURITY_TEST_PLAN_V1_0.md",
    "docs/ADR_001_ARSITEKTUR_A.md",
    "docs/ADR_002_GITHUB_LAB.md",
    "docs/TRACEABILITY_REQUIREMENTS.csv",
    "docs/TRACEABILITY_ACCEPTANCE_TESTS.csv",
    "docs/TRACEABILITY_NFR.csv",
    "docs/VERIFIKASI_ARSITEKTUR_SAD_V1_0.md",
    ".github/workflows/docs-integrity.yml",
]
missing = [p for p in required if not (root / p).is_file()]
assert not missing, f"Missing files: {missing}"
actual = hashlib.sha256((root / "docs/PRD_V1_1_FINAL.md").read_bytes()).hexdigest()
expected = "b229bc16e3037f16eee4b65a3e691c31f17682ee360ecaad85c5c62483c5deb1"
assert actual == expected, "Canonical PRD changed: require owner-approved change request"
for f in required:
    data = (root / f).read_text(encoding="utf-8")
    assert data.strip(), f"Empty file: {f}"
with (root / "docs/TRACEABILITY_REQUIREMENTS.csv").open(newline="", encoding="utf-8") as fp:
    req = list(csv.DictReader(fp))
with (root / "docs/TRACEABILITY_ACCEPTANCE_TESTS.csv").open(newline="", encoding="utf-8") as fp:
    tests = list(csv.DictReader(fp))
assert len(req) == len({r["requirement_id"] for r in req}) == 131, "Expected 131 distinct requirements"
assert len(tests) == len({t["test_id"] for t in tests}) == 135, "Expected 135 distinct acceptance tests"
assert all(r["implementation_status"] == "NOT_IMPLEMENTED" for r in req)
assert all(t["github_ci_status"] == "NOT_RUN" for t in tests)
with (root / "docs/TRACEABILITY_NFR.csv").open(newline="", encoding="utf-8") as fp:
    nfr = list(csv.DictReader(fp))
expected_nfr_ids = {f"NFR-{i:02d}" for i in range(1, 13)}
assert len(nfr) == 12 and {r["nfr_id"] for r in nfr} == expected_nfr_ids, "Expected 12 distinct NFR-01..12"
assert all(r["status"] == "NOT_VERIFIED" for r in nfr), "NFR evidence cannot be presumed"
prd_text = (root / "docs/PRD_V1_1_FINAL.md").read_text(encoding="utf-8")
prd_nfr = {
    m.group(1): m.group(2).strip()
    for m in re.finditer(r"^\|\s*(NFR-\d{2})\s*\|\s*([^|]+?)\s*\|", prd_text, flags=re.MULTILINE)
}
assert set(prd_nfr) == expected_nfr_ids, "PRD NFR source must contain NFR-01..12"
assert all(prd_nfr[row["nfr_id"]] == row["summary"].strip() for row in nfr), "NFR summary does not match canonical PRD"
print(f"PASS docs-integrity: {len(required)} files, {len(req)} requirements, {len(tests)} tests, {len(nfr)} NFR; PRD sha256 {actual[:12]}...")
