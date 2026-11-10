#!/usr/bin/env python3
"""Validate canonical docs and CI-backed traceability (Python standard library)."""
import csv
import hashlib
import importlib.util
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRD_SHA256 = "b229bc16e3037f16eee4b65a3e691c31f17682ee360ecaad85c5c62483c5deb1"
REQUIRED = (
    "README.md", "docs/PRD_V1_1_FINAL.md", "docs/SAD_V1_0_ARSITEKTUR_A.md",
    "docs/DATABASE_DESIGN_V1_0.md", "docs/API_CONTRACT_V1_0.md",
    "docs/SECURITY_TEST_PLAN_V1_0.md", "docs/ADR_001_ARSITEKTUR_A.md",
    "docs/ADR_002_GITHUB_LAB.md", "docs/TRACEABILITY_REQUIREMENTS.csv",
    "docs/TRACEABILITY_ACCEPTANCE_TESTS.csv", "docs/TRACEABILITY_NFR.csv",
    "docs/VERIFIKASI_ARSITEKTUR_SAD_V1_0.md", ".github/workflows/docs-integrity.yml",
)
REQUIREMENT_FIELDS = ("requirement_id", "priority", "summary", "sad_module",
                      "implementation_status", "ci_test_ids", "notes")
ACCEPTANCE_FIELDS = ("test_id", "origin", "github_ci_status", "ci_test_ids", "test_type", "notes")
NFR_IDS = {f"NFR-{n:02}" for n in range(1, 13)}
REQUIREMENT_STATUSES = ("IMPLEMENTED_CI", "PARTIAL", "NOT_IMPLEMENTED")
TEST_STATUSES = ("PASS", "FAIL", "BELUM_DIUJI")


def check_prd_hash(path: Path, expected: str = PRD_SHA256) -> str:
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("Canonical PRD changed: require owner-approved change request")
    return actual


def load_ci_catalog(path: Path) -> dict[str, set[str]]:
    """Import the real CI gate without running it; include both and single-target IDs."""
    spec = importlib.util.spec_from_file_location("traceability_ci_gate", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load CI gate: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    common = set(module.COMMON)
    expected = module.EXPECTED
    if not common or not {"direct", "pgbouncer"}.issubset(expected):
        raise ValueError("CI gate has no common checks or missing targets")
    if not all(common.issubset(set(expected[target])) for target in ("direct", "pgbouncer")):
        raise ValueError("CI gate COMMON not required in both targets")
    catalog: dict[str, set[str]] = {}
    for target, checks in expected.items():
        for case_id, _kind in checks:
            catalog.setdefault(case_id, set()).add(target)
    return catalog


def _check_columns(row: dict[str, str], fields: tuple[str, ...], label: str) -> None:
    if tuple(row) != fields:
        raise ValueError(f"{label}: CSV columns must be {', '.join(fields)}")


def _references(raw: str | None, catalog: dict[str, set[str]], label: str, notes: str) -> list[str]:
    if not raw or not raw.strip():
        return []
    ids = [value.strip() for value in raw.split(";")]
    if any(not value for value in ids) or len(ids) != len(set(ids)):
        raise ValueError(f"{label}: empty/duplicate ci_test_ids: {raw}")
    for case_id in ids:
        if case_id not in catalog:
            raise ValueError(f"{label}: unknown CI test ID {case_id}")
        if len(catalog[case_id]) == 1:
            target = next(iter(catalog[case_id]))
            if target not in notes.lower():
                raise ValueError(f"{label}: single-target CI test {case_id} requires '{target}' in notes")
    return ids


def validate_requirements(rows: list[dict[str, str]], catalog: dict[str, set[str]]) -> Counter:
    seen: set[str] = set()
    counts: Counter = Counter()
    for line_no, row in enumerate(rows, 2):
        label = f"TRACEABILITY_REQUIREMENTS.csv line {line_no} ({row.get('requirement_id')})"
        _check_columns(row, REQUIREMENT_FIELDS, label)
        requirement_id, status = row["requirement_id"], row["implementation_status"]
        if not requirement_id or requirement_id in seen:
            raise ValueError(f"{label}: missing/duplicate requirement ID")
        seen.add(requirement_id)
        if status not in REQUIREMENT_STATUSES:
            raise ValueError(f"{label}: invalid implementation_status {status!r}")
        notes = (row["notes"] or "").strip()
        ids = _references(row["ci_test_ids"], catalog, label, notes)
        if status in ("IMPLEMENTED_CI", "PARTIAL") and not ids:
            raise ValueError(f"{label}: {status} requires ci_test_ids")
        if status == "PARTIAL" and not notes:
            raise ValueError(f"{label}: PARTIAL requires notes describing missing coverage")
        if status == "NOT_IMPLEMENTED" and ids:
            raise ValueError(f"{label}: NOT_IMPLEMENTED must not claim CI implementation")
        counts[status] += 1
    if len(seen) != 131:
        raise ValueError(f"Expected 131 distinct requirements, got {len(seen)}")
    return counts


def validate_acceptance_tests(rows: list[dict[str, str]], catalog: dict[str, set[str]]) -> Counter:
    seen: set[str] = set()
    counts: Counter = Counter()
    for line_no, row in enumerate(rows, 2):
        label = f"TRACEABILITY_ACCEPTANCE_TESTS.csv line {line_no} ({row.get('test_id')})"
        _check_columns(row, ACCEPTANCE_FIELDS, label)
        case_id, status = row["test_id"], row["github_ci_status"]
        if not case_id or case_id in seen:
            raise ValueError(f"{label}: missing/duplicate acceptance test ID")
        seen.add(case_id)
        if status not in TEST_STATUSES:
            raise ValueError(f"{label}: invalid github_ci_status {status!r}")
        notes = (row["notes"] or "").strip()
        ids = _references(row["ci_test_ids"], catalog, label, notes)
        if status == "PASS" and not ids:
            raise ValueError(f"{label}: PASS requires ci_test_ids")
        if status == "PASS" and not (row["test_type"] or "").strip():
            raise ValueError(f"{label}: PASS requires test_type")
        if status in ("BELUM_DIUJI", "FAIL") and ids and not notes:
            raise ValueError(f"{label}: {status} with evidence requires notes")
        if status == "FAIL" and not notes:
            raise ValueError(f"{label}: FAIL requires notes")
        counts[status] += 1
    if len(seen) != 135:
        raise ValueError(f"Expected 135 distinct acceptance tests, got {len(seen)}")
    return counts


def validate_nfr(rows: list[dict[str, str]], prd_text: str) -> None:
    ids = [row["nfr_id"] for row in rows]
    if len(ids) != 12 or set(ids) != NFR_IDS or len(set(ids)) != 12:
        raise ValueError("Expected 12 distinct NFR-01..12")
    if any(row["status"] != "NOT_VERIFIED" for row in rows):
        raise ValueError("NFR evidence cannot be presumed")
    prd_nfr = {
        match.group(1): match.group(2).strip()
        for match in re.finditer(r"^\|\s*(NFR-\d{2})\s*\|\s*([^|]+?)\s*\|", prd_text, flags=re.MULTILINE)
    }
    if set(prd_nfr) != NFR_IDS:
        raise ValueError("PRD NFR source must contain NFR-01..12")
    if any(prd_nfr[row["nfr_id"]] != row["summary"].strip() for row in rows):
        raise ValueError("NFR summary does not match canonical PRD")


def read_csv(path: Path, fields: tuple[str, ...]) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != fields:
            raise ValueError(f"{path}: expected CSV columns {fields}")
        return list(reader)


def main(root: Path = ROOT) -> int:
    try:
        missing = [name for name in REQUIRED if not (root / name).is_file()]
        if missing:
            raise ValueError(f"Missing files: {missing}")
        for name in REQUIRED:
            if not (root / name).read_text(encoding="utf-8").strip():
                raise ValueError(f"Empty file: {name}")
        actual = check_prd_hash(root / "docs/PRD_V1_1_FINAL.md")
        catalog = load_ci_catalog(root / "backend/test/ci_gate.py")
        req = read_csv(root / "docs/TRACEABILITY_REQUIREMENTS.csv", REQUIREMENT_FIELDS)
        tests = read_csv(root / "docs/TRACEABILITY_ACCEPTANCE_TESTS.csv", ACCEPTANCE_FIELDS)
        nfr = read_csv(root / "docs/TRACEABILITY_NFR.csv",
                       ("nfr_id", "summary", "sad_module", "verification_type", "status"))
        req_counts = validate_requirements(req, catalog)
        test_counts = validate_acceptance_tests(tests, catalog)
        validate_nfr(nfr, (root / "docs/PRD_V1_1_FINAL.md").read_text(encoding="utf-8"))
        print(f"PASS docs-integrity: {len(REQUIRED)} files, 131 requirements, 135 tests, 12 NFR; PRD sha256 {actual[:12]}...")
        print("requirements: " + " ".join(f"{status}={req_counts[status]}" for status in REQUIREMENT_STATUSES)
              + "; tests: " + " ".join(f"{status}={test_counts[status]}" for status in TEST_STATUSES))
        if test_counts["FAIL"]:
            raise ValueError(f"Acceptance matrix contains {test_counts['FAIL']} FAIL; inspect notes")
        return 0
    except (ValueError, OSError, csv.Error, AttributeError) as exc:
        print(f"FAIL docs-integrity: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
