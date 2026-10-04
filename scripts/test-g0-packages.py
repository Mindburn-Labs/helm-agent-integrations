"""Byte and authority controls; fixture tarballs cannot publish."""
import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest

MODULE = runpy.run_path(str(Path(__file__).with_name("g0-packages.py")))


class PackageGateControls(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.package = self.root / "fixture.tgz"
        self.name = "@mindburn/g0-fixture-never-published"
        self.tarball()
        self.digest = "sha256:" + hashlib.sha256(self.package.read_bytes()).hexdigest()
        self.expected = {"repositories": {MODULE["REPO"]: {"source_revision": "1" * 40}},
                         "npm_tarball_digests": {self.name: self.digest}}
        self.receipt = {"result": "PASS", "target": "public-package-publish", "dry_run": False,
                        "report_digest": "sha256:" + "2" * 64, "qualification_kind": "release",
                        "npm_tarball_digests": dict(self.expected["npm_tarball_digests"])}

    def tarball(self, private=False):
        raw = json.dumps({"name": self.name, "version": "0.0.0-fixture", "private": private}).encode()
        with tarfile.open(self.package, "w:gz") as archive:
            item = tarfile.TarInfo("package/package.json")
            item.size = len(raw)
            archive.addfile(item, io.BytesIO(raw))

    def test_exact_digest_and_source_accept(self):
        MODULE["validate"](self.receipt, self.expected, "1" * 40, False, "")
        records = MODULE["inspect_tarballs"](self.root, self.expected["npm_tarball_digests"])
        self.assertEqual(records[0]["digest"], self.digest)

    def test_wrong_source_or_target_or_failed_receipt_refuse(self):
        for changes in ({"target": "signup-flag-flip"}, {"result": "FAIL"},
                        {"qualification_kind": "publication-canary"}, {"report_digest": "self-claimed"}):
            with self.assertRaises(ValueError):
                MODULE["validate"]({**self.receipt, **changes}, self.expected, "1" * 40, False, "")
        with self.assertRaises(ValueError):
            MODULE["validate"](self.receipt, self.expected, "3" * 40, False, "")

    def test_changed_tarball_or_incomplete_set_refuse(self):
        with self.assertRaises(ValueError):
            MODULE["inspect_tarballs"](self.root, {self.name: "sha256:" + "0" * 64})
        with self.assertRaises(ValueError):
            MODULE["inspect_tarballs"](self.root, {self.name: self.digest, "@mindburn/missing": self.digest})

    def test_private_package_and_duplicate_identity_refuse(self):
        self.tarball(private=True)
        with self.assertRaises(ValueError):
            MODULE["package_identity"](self.package)
        self.tarball()
        (self.root / "duplicate.tgz").write_bytes(self.package.read_bytes())
        digest = "sha256:" + hashlib.sha256(self.package.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            MODULE["inspect_tarballs"](self.root, {self.name: digest})

    def test_canary_requires_sandbox_and_never_prepare(self):
        receipt = {**self.receipt, "dry_run": True, "qualification_kind": "publication-canary"}
        MODULE["validate"](receipt, {}, "1" * 40, True, "Mindburn-Labs/g0-publication-sandbox")
        with self.assertRaises(ValueError):
            MODULE["validate"](receipt, {}, "1" * 40, True, MODULE["REPO"])

    def test_source_paths_are_bounded_before_any_install(self):
        for paths in (["../elsewhere"], ["plugins/openclaw", "plugins/openclaw"], []):
            with self.assertRaises(ValueError):
                MODULE["prepare"](self.root, paths, self.root / "out", {})
            self.assertFalse((self.root / "out").exists())


if __name__ == "__main__":
    unittest.main()
