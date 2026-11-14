from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("swap-fleet60-source-acls.py")
SPEC = importlib.util.spec_from_file_location("swap_fleet60_source_acls", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load source ACL script")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SourceAclSwapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old = "192.168.60.199"
        self.new = "192.168.60.167"
        self.original = (
            "allow * 192.168.60.199,192.168.52.10\n"
            "parent 1000 connect+ provider.invalid 10001 SECRET_SENTINEL\n"
            "deny *\n"
        )

    def test_prepare_finalize_and_rollback_preserve_orch_and_unrelated_lines(self) -> None:
        prepared = MODULE.rewrite(self.original, self.old, self.new, "prepare")
        self.assertIn("allow * 192.168.60.199,192.168.60.167,192.168.52.10\n", prepared)
        self.assertIn("SECRET_SENTINEL\n", prepared)
        finalized = MODULE.rewrite(prepared, self.old, self.new, "finalize")
        self.assertIn("allow * 192.168.60.167,192.168.52.10\n", finalized)
        self.assertEqual(MODULE.rewrite(prepared, self.old, self.new, "rollback"), self.original)
        self.assertEqual(MODULE.rewrite(finalized, self.old, self.new, "rollback"), self.original)

    def test_unexpected_acl_source_fails_without_rewriting(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.rewrite(self.original.replace("192.168.52.10", "192.168.52.11"),
                           self.old, self.new, "prepare")

    def test_duplicate_matching_allow_lines_fail(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.rewrite(self.original.replace("deny *\n", "allow * 192.168.60.199,192.168.52.10\n"),
                           self.old, self.new, "prepare")

    def test_manifest_accepts_closed_18_route_plan_without_private_files(self) -> None:
        # Synthetic closed permutation, not a real commissioning assignment.
        rows = [{"route_id": f"fleet60-fleet{i}-dc{i:02d}",
                 "old_source_ip": f"192.168.60.{i}",
                 "new_source_ip": f"192.168.60.{i + 1 if i < 20 else 3}"}
                for i in range(3, 21)]
        with tempfile.TemporaryDirectory(prefix="fleet-acl-test-") as fixture_dir:
            path = Path(fixture_dir) / "manifest.json"
            path.write_text(json.dumps({"credential_free": True,
                                       "operation_id": "fleet60-swap-test-fixture", "routes": rows}), encoding="utf-8")
            operation, rows = MODULE.load_manifest(path)
        self.assertEqual(operation, "fleet60-swap-test-fixture")
        self.assertEqual(len(rows), 18)
        self.assertEqual({row["route_id"] for row in rows},
                         {f"fleet60-fleet{i}-dc{i:02d}" for i in range(3, 21)})


if __name__ == "__main__":
    unittest.main()
