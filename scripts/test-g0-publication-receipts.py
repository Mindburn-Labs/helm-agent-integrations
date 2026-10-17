"""Exercise the publication workflow's actual sanitized receipt programs."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github/workflows/publish-g0-packages.yml"
)
SOURCE = WORKFLOW.read_text()
MARKER = "private-probe-marker-never-in-a-receipt"


def program(name):
    match = re.search(
        r"python3 - <<'" + name + r"'\n(.*?)\n          " + name, SOURCE, re.S
    )
    if not match:
        raise AssertionError(f"missing {name} program in publication workflow")
    return textwrap.dedent(match.group(1))


REQUEST = program("PY_RECEIPT")
OUTCOME = program("PY_OUTCOME")


def private_file(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as target:
        target.write(value)


class PublicationReceipts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.expected = json.dumps(
            {
                "schema": "helm.release-train.inputs.v1",
                "release": "G0",
                "private": MARKER,
            }
        )
        self.environment = {
            **os.environ,
            "RUNNER_TEMP": str(self.root),
            "G0_REQUEST_TARGET": "public-package-publish",
            "G0_CALLER_REPOSITORY": "Mindburn-Labs/helm-agent-integrations",
            "G0_CALLER_SOURCE_REVISION": "a" * 40,
            "G0_CALLER_WORKFLOW_REVISION": "b" * 40,
            "G0_CALLER_WORKFLOW_REF": "Mindburn-Labs/helm-agent-integrations/"
            ".github/workflows/publish-g0-packages.yml@refs/heads/main",
            "G0_CALLER_RUN_ID": "123",
            "G0_CALLER_RUN_ATTEMPT": "1",
            "G0_CALLER_EVENT": "workflow_dispatch",
            "G0_DRY_RUN": "true",
            "G0_SANDBOX": "Mindburn-Labs/g0-publication-sandbox",
            "G0_QUALIFICATION_RUN_ID": "456",
            "G0_QUALIFICATION_ARTIFACT_ID": "789",
            "G0_EXPECTED_INPUTS": self.expected,
        }

    def execute(self, source):
        subprocess.run(
            [sys.executable, "-c", source],
            env=self.environment,
            check=True,
            capture_output=True,
            timeout=5,
        )

    def request(self):
        self.execute(REQUEST)
        raw = (self.root / "g0-request.json").read_bytes()
        self.assertNotIn(MARKER.encode(), raw)
        value = json.loads(raw)
        self.assertEqual(value["caller"]["run_id"], "123")
        self.assertEqual(value["caller"]["run_attempt"], "1")
        self.assertEqual(value["caller"]["source_revision"], "a" * 40)
        self.assertEqual(
            value["request"]["expected_inputs_digest"],
            "sha256:" + hashlib.sha256(self.expected.encode()).hexdigest(),
        )
        return raw

    def outcome(self, output=None, exit_code=None):
        request = self.request()
        if output is not None:
            private_file(self.root / "g0-verifier-output", json.dumps(output) + "\n")
        if exit_code is not None:
            private_file(self.root / "g0-verifier-exit", str(exit_code))
        self.execute(OUTCOME)
        raw = (self.root / "g0-outcome.json").read_bytes()
        self.assertNotIn(MARKER.encode(), raw)
        value = json.loads(raw)
        self.assertEqual(
            value["request_digest"], "sha256:" + hashlib.sha256(request).hexdigest()
        )
        self.assertEqual(value["caller"]["run_attempt"], "1")
        return value["verifier"]

    def test_uninvoked_verifier_has_no_refusal_authority(self):
        self.assertEqual(self.outcome()["outcome"], "NOT_INVOKED")

    def test_exact_native_no_pass_refusal_is_distinct(self):
        verifier = self.outcome(
            {"result": "REFUSED", "reason": "no PASS release evidence"}, 2
        )
        self.assertEqual(verifier["outcome"], "NO_PASS_RELEASE_EVIDENCE")
        self.assertEqual(verifier["exit_code"], 2)
        self.assertTrue(verifier["stdout_digest"].startswith("sha256:"))

    def test_refusal_text_with_success_exit_is_not_native_refusal(self):
        verifier = self.outcome(
            {"result": "REFUSED", "reason": "no PASS release evidence"}, 0
        )
        self.assertEqual(verifier["outcome"], "INVALID_OUTPUT")

    def test_pass_shaped_verifier_output_is_recorded(self):
        verifier = self.outcome(
            {"result": "PASS", "target": "public-package-publish", "dry_run": True}, 0
        )
        self.assertEqual(verifier["outcome"], "VERIFIED_PASS")

    def test_existing_request_file_is_not_overwritten(self):
        private_file(self.root / "g0-request.json", "existing")
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(REQUEST)
        self.assertEqual((self.root / "g0-request.json").read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
