from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
HARNESS = REPO_ROOT / "demos" / "lib" / "run_safe_harness.py"
SCENARIO = REPO_ROOT / "demos" / "helm-shell-mcp-demo" / "scenario.json"


class SafeHarnessCLITests(unittest.TestCase):
    def test_repo_argument_is_required(self) -> None:
        result = subprocess.run(
            [sys.executable, str(HARNESS), "--scenario", str(SCENARIO), "--safe"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--repo", result.stderr)

    def test_explicit_repo_runs_sample_fixture(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(HARNESS),
                "--repo",
                str(REPO_ROOT),
                "--scenario",
                str(SCENARIO),
                "--safe",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PASS helm-shell-mcp-demo", result.stdout)


if __name__ == "__main__":
    unittest.main()
