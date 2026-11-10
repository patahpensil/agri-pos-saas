"""Regression tests for docs-integrity; fixtures stay in memory or temp files."""
import copy
import tempfile
import unittest
from pathlib import Path

from scripts import verify_docs as vd


class VerifyDocsTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {"CAT-01": {"direct", "pgbouncer"}, "T-CONFIG-01": {"direct"}}
        self.req = {
            "requirement_id": "PRD-01", "priority": "MUST", "summary": "uji", "sad_module": "Catalog",
            "implementation_status": "NOT_IMPLEMENTED", "ci_test_ids": "", "notes": "",
        }
        self.case = {
            "test_id": "ST-INV-02", "origin": "PRD V1.1 FINAL Appendix A",
            "github_ci_status": "BELUM_DIUJI", "ci_test_ids": "", "test_type": "", "notes": "",
        }

    def req_rows(self, **values):
        row = {**self.req, **values}
        return [row] + [{**self.req, "requirement_id": f"DUMMY-{i:03}"} for i in range(130)]

    def test_pass_with_registered_id_and_type(self):
        rows = [{**self.case, "github_ci_status": "PASS", "ci_test_ids": "CAT-01", "test_type": "API"}]
        rows += [{**self.case, "test_id": f"ST-DUMMY-{i:03}"} for i in range(134)]
        self.assertEqual(vd.validate_acceptance_tests(rows, self.catalog)["PASS"], 1)

    def test_pass_without_id_fails(self):
        self.assert_bad_test(github_ci_status="PASS", test_type="API")

    def test_unknown_id_fails(self):
        self.assert_bad_test(github_ci_status="PASS", ci_test_ids="ST-POS-01", test_type="API")

    def test_pass_without_type_fails(self):
        self.assert_bad_test(github_ci_status="PASS", ci_test_ids="CAT-01")

    def test_implemented_without_id_fails(self):
        with self.assertRaisesRegex(ValueError, "requires ci_test_ids"):
            vd.validate_requirements(self.req_rows(implementation_status="IMPLEMENTED_CI"), self.catalog)

    def test_partial_without_notes_fails(self):
        with self.assertRaisesRegex(ValueError, "PARTIAL requires notes"):
            vd.validate_requirements(self.req_rows(implementation_status="PARTIAL", ci_test_ids="CAT-01"), self.catalog)

    def test_unknown_status_fails(self):
        for value in ("DONE", "NOT_RUN"):
            with self.subTest(value=value):
                self.assert_bad_test(github_ci_status=value)
                with self.assertRaisesRegex(ValueError, "invalid implementation_status"):
                    vd.validate_requirements(self.req_rows(implementation_status=value), self.catalog)

    def test_single_target_requires_named_target(self):
        self.assert_bad_test(github_ci_status="PASS", ci_test_ids="T-CONFIG-01", test_type="unit")

    def test_nfr_not_verified_required(self):
        rows = [{"nfr_id": f"NFR-{i:02}", "summary": f"nfr {i}", "status": "NOT_VERIFIED"} for i in range(1, 13)]
        prd = "\n".join(f"| NFR-{i:02} | nfr {i} | TBD |" for i in range(1, 13))
        vd.validate_nfr(rows, prd)
        rows[0]["status"] = "PASS"
        with self.assertRaisesRegex(ValueError, "NFR evidence"):
            vd.validate_nfr(rows, prd)

    def test_changed_prd_hash_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "PRD_V1_1_FINAL.md"
            path.write_text("modified PRD", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Canonical PRD changed"):
                vd.check_prd_hash(path)

    def test_import_gate_does_not_run_main_and_evaluates_fstrings(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ci_gate.py"
            path.write_text("COMMON=[(f'CAT-{i:02}', 'API') for i in (1,2)]\n"
                            "EXPECTED={'direct': COMMON+[('U-01','unit')], 'pgbouncer': COMMON}\n"
                            "def main(): raise RuntimeError('Must never execute')\n"
                            "if __name__ == '__main__': main()\n", encoding="utf-8")
            catalog = vd.load_ci_catalog(path)
            self.assertEqual(catalog["CAT-02"], {"direct", "pgbouncer"})
            self.assertEqual(catalog["U-01"], {"direct"})

    def assert_bad_test(self, **values):
        rows = [{**self.case, **values}]
        rows += [{**self.case, "test_id": f"ST-DUMMY-{i:03}"} for i in range(134)]
        with self.assertRaises(ValueError):
            vd.validate_acceptance_tests(rows, self.catalog)


if __name__ == "__main__":
    unittest.main()
