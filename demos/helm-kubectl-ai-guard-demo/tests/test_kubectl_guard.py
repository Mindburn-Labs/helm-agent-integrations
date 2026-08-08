#!/usr/bin/env python3
"""Offline unit tests for kubectl_guard. No kernel, no cluster, no network."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import kubectl_guard as guard  # noqa: E402


class TestParseArgv(unittest.TestCase):
    def assertClass(self, argv, expected, verb=None, namespace=None):
        intent = guard.parse_argv(argv)
        self.assertEqual(intent.command_class, expected, argv)
        if verb is not None:
            self.assertEqual(intent.verb, verb)
        if namespace is not None:
            self.assertEqual(intent.namespace, namespace)
        return intent

    def test_read_verbs(self):
        self.assertClass(["get", "pods"], "read_only", verb="get")
        self.assertClass(
            ["get", "pods", "-n", "mindburn-qa"], "read_only", namespace="mindburn-qa"
        )
        self.assertClass(["describe", "deploy/nginx"], "read_only")
        self.assertClass(["logs", "nginx-abc", "-c", "app"], "read_only")
        self.assertClass(["api-resources"], "read_only")
        self.assertClass(["top", "nodes"], "read_only")
        self.assertClass(["version"], "read_only")
        self.assertClass(["diff", "-f", "deploy.yaml"], "read_only")

    def test_global_flags_before_verb(self):
        intent = self.assertClass(
            ["--namespace", "prod", "get", "pods"],
            "read_only",
            verb="get",
            namespace="prod",
        )
        self.assertEqual(intent.resource, "pods")
        self.assertClass(["-n", "qa", "get", "svc"], "read_only", namespace="qa")
        self.assertClass(["--context=eu-1", "get", "nodes"], "read_only")
        self.assertClass(["--kubeconfig", "/tmp/k", "get", "ns"], "read_only")

    def test_global_target_flags_after_verb(self):
        intent = self.assertClass(["get", "pods", "--context", "prod-eu"], "read_only")
        self.assertEqual(intent.context, "prod-eu")
        self.assertEqual(intent.facts["context"], "prod-eu")
        intent = self.assertClass(
            ["get", "pods", "--server=https://cluster.example"], "read_only"
        )
        self.assertEqual(intent.facts["server"], "https://cluster.example")

    def test_all_namespaces(self):
        intent = self.assertClass(["get", "pods", "-A"], "read_only")
        self.assertTrue(intent.all_namespaces)
        intent = self.assertClass(["get", "pods", "--all-namespaces"], "read_only")
        self.assertTrue(intent.all_namespaces)

    def test_mutating_verbs(self):
        self.assertClass(["apply", "-f", "deploy.yaml"], "mutating")
        self.assertClass(["scale", "deploy/nginx", "--replicas=3"], "mutating")
        self.assertClass(["patch", "pod", "x", "--patch", "{}"], "mutating")
        self.assertClass(["label", "pod", "x", "a=b"], "mutating")
        self.assertClass(["cordon", "node-1"], "mutating")

    def test_destructive_verbs(self):
        self.assertClass(["delete", "pod", "x"], "destructive")
        self.assertClass(["delete", "namespace", "prod"], "destructive")
        self.assertClass(["drain", "node-1"], "destructive")

    def test_exec_channel_verbs(self):
        self.assertClass(["exec", "pod/x", "--", "ls"], "exec_channel")
        self.assertClass(["cp", "pod/x:/etc", "./etc"], "exec_channel")
        self.assertClass(["port-forward", "svc/web", "8080:80"], "exec_channel")
        self.assertClass(["debug", "pod/x", "--image", "busybox"], "exec_channel")

    def test_two_word_verbs(self):
        self.assertClass(["rollout", "status", "deploy/nginx"], "read_only")
        self.assertClass(["rollout", "history", "deploy/nginx"], "read_only")
        self.assertClass(["rollout", "restart", "deploy/nginx"], "mutating")
        self.assertClass(["rollout", "undo", "deploy/nginx"], "mutating")
        self.assertClass(["config", "view"], "read_only")
        self.assertClass(["config", "current-context"], "read_only")
        self.assertClass(["config", "use-context", "prod"], "mutating")
        self.assertClass(["auth", "can-i", "delete", "pods"], "read_only")
        self.assertClass(["certificate", "approve", "csr-1"], "mutating")

    def test_only_client_dry_run_downgrades_to_read_only(self):
        intent = self.assertClass(
            ["apply", "-f", "x.yaml", "--dry-run=client"], "read_only"
        )
        self.assertTrue(intent.dry_run)
        self.assertEqual(intent.dry_run_mode, "client")
        intent = self.assertClass(
            ["delete", "pod", "x", "--dry-run=server"], "destructive"
        )
        self.assertTrue(intent.dry_run)
        self.assertEqual(intent.dry_run_mode, "server")
        self.assertClass(["apply", "-f", "x.yaml", "--dry-run=none"], "mutating")

    def test_exact_argv_is_bound_by_digest(self):
        first = guard.parse_argv(["apply", "-f", "first.yaml"])
        second = guard.parse_argv(["apply", "-f", "second.yaml"])
        self.assertNotEqual(first.argv_sha256, second.argv_sha256)
        self.assertEqual(first.argv_sha256, first.facts["argv_sha256"])

    def test_unknown_verb_fails_safe(self):
        self.assertClass(["frobnicate", "thing"], "mutating")

    def test_missing_verb_raises(self):
        with self.assertRaises(guard.GuardError):
            guard.parse_argv([])
        with self.assertRaises(guard.GuardError):
            guard.parse_argv(["-n", "qa"])

    def test_summary(self):
        intent = guard.parse_argv(["delete", "pod", "nginx", "-n", "prod"])
        self.assertEqual(intent.summary, "delete pod -n prod")

    def test_summary_does_not_copy_exec_arguments(self):
        intent = guard.parse_argv(["exec", "pod/x", "--", "env", "SECRET=value"])
        self.assertEqual(intent.summary, "exec pod/x")
        self.assertNotIn("SECRET", intent.summary)


class TestRiskAndEffect(unittest.TestCase):
    def test_classes(self):
        self.assertEqual(guard.risk_and_effect("read_only"), ("T1", "E2"))
        self.assertEqual(guard.risk_and_effect("mutating"), ("T2", "E3"))
        self.assertEqual(guard.risk_and_effect("destructive"), ("T3", "E4"))
        self.assertEqual(guard.risk_and_effect("exec_channel"), ("T3", "E4"))


def make_config(
    tmp: Path, mode: str = "enforce", real: str = "/usr/local/bin/kubectl"
) -> guard.GuardConfig:
    return guard.GuardConfig(
        helm_url="http://127.0.0.1:7714",
        api_key="test-key",
        tenant_id="local-demo",
        principal_id="kubectl-ai-agent",
        session_id="test-session",
        approval_ref="",
        mode=mode,
        receipts_path=tmp / "receipts.jsonl",
        timeout=1.0,
        real_kubectl=real,
    )


class FakeResponse:
    def __init__(self, body, headers=None, status=200):
        self._body = json.dumps(body).encode()
        self.headers = headers or {}
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def intent_for(argv):
    return guard.parse_argv(argv)


class TestEvaluate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.config = make_config(self.tmp)

    def test_allow_verdict_parsed(self):
        body = {
            "decision": {
                "verdict": "ALLOW",
                "reason_code": "KUBECTL_READ_ONLY_ALLOW",
                "receipt_id": "r-1",
                "decision_id": "d-1",
            }
        }
        with mock.patch.object(
            guard.urllib.request, "urlopen", return_value=FakeResponse(body)
        ):
            verdict = guard.evaluate(self.config, intent_for(["get", "pods"]))
        self.assertEqual(verdict.verdict, "ALLOW")
        self.assertEqual(verdict.reason_code, "KUBECTL_READ_ONLY_ALLOW")
        self.assertEqual(verdict.receipt_id, "r-1")

    def test_header_refs_preferred(self):
        body = {"verdict": "DENY"}
        headers = {
            "X-Helm-Receipt-Id": "r-h",
            "X-Helm-Reason-Code": "KUBECTL_DESTRUCTIVE_DENY",
        }
        with mock.patch.object(
            guard.urllib.request, "urlopen", return_value=FakeResponse(body, headers)
        ):
            verdict = guard.evaluate(self.config, intent_for(["delete", "ns", "prod"]))
        self.assertEqual(verdict.receipt_id, "r-h")
        self.assertEqual(verdict.reason_code, "KUBECTL_DESTRUCTIVE_DENY")

    def test_missing_verdict_defaults_deny(self):
        with mock.patch.object(
            guard.urllib.request, "urlopen", return_value=FakeResponse({})
        ):
            verdict = guard.evaluate(self.config, intent_for(["get", "pods"]))
        self.assertEqual(verdict.verdict, "DENY")

    def test_unexpected_verdict_raises(self):
        with mock.patch.object(
            guard.urllib.request,
            "urlopen",
            return_value=FakeResponse({"verdict": "MAYBE"}),
        ):
            with self.assertRaises(guard.GuardError):
                guard.evaluate(self.config, intent_for(["get", "pods"]))

    def test_http_error_raises(self):
        err = guard.urllib.error.HTTPError(
            "u", 401, "unauthorized", {}, io.BytesIO(b"{}")
        )
        with mock.patch.object(guard.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(guard.GuardError):
                guard.evaluate(self.config, intent_for(["get", "pods"]))

    def test_transport_error_raises(self):
        err = guard.urllib.error.URLError("connection refused")
        with mock.patch.object(guard.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(guard.GuardError):
                guard.evaluate(self.config, intent_for(["get", "pods"]))

    def test_approval_ref_forwarded(self):
        config = guard.GuardConfig(**{**self.config.__dict__, "approval_ref": "appr-9"})
        captured = {}

        def spy(request, timeout=0):
            captured["payload"] = json.loads(request.data.decode())
            return FakeResponse(
                {
                    "decision": {
                        "verdict": "ALLOW",
                        "receipt_id": "r-9",
                        "decision_id": "d-9",
                    }
                }
            )

        with mock.patch.object(guard.urllib.request, "urlopen", side_effect=spy):
            guard.evaluate(config, intent_for(["apply", "-f", "x.yaml"]))
        args = captured["payload"]["context"]["args"]
        self.assertEqual(args["approval_refs"], ["appr-9"])
        self.assertEqual(args["command_class"], "mutating")
        self.assertEqual(len(args["argv_sha256"]), 64)

    def test_allow_without_authoritative_refs_raises(self):
        with mock.patch.object(
            guard.urllib.request,
            "urlopen",
            return_value=FakeResponse({"verdict": "ALLOW"}),
        ):
            with self.assertRaises(guard.GuardError):
                guard.evaluate(self.config, intent_for(["get", "pods"]))

    def test_conflicting_verdicts_raise(self):
        body = {
            "verdict": "DENY",
            "decision": {"verdict": "ALLOW", "receipt_id": "r", "decision_id": "d"},
        }
        with mock.patch.object(
            guard.urllib.request, "urlopen", return_value=FakeResponse(body)
        ):
            with self.assertRaises(guard.GuardError):
                guard.evaluate(self.config, intent_for(["get", "pods"]))


class TestMainFlow(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.real_kubectl = self.tmp / "kubectl"
        self.real_kubectl.write_text("#!/bin/sh\n")
        self.real_kubectl.chmod(0o755)
        self.env = {
            "HELM_URL": "http://127.0.0.1:7714",
            "HELM_API_KEY": "test-key",
            "HELM_KUBECTL_REAL": str(self.real_kubectl),
            "HELM_KUBECTL_GUARD_RECEIPTS": str(self.tmp / "receipts.jsonl"),
            "PATH": "/usr/local/bin",
        }

    def run_main(self, argv, body, env_extra=None):
        env = dict(self.env)
        env.update(env_extra or {})
        with mock.patch.object(
            guard.urllib.request, "urlopen", return_value=FakeResponse(body)
        ):
            with mock.patch.object(guard.os, "execve") as exec_mock:
                code = guard.main(argv, env)
        return code, exec_mock

    def test_allow_dispatches(self):
        code, exec_mock = self.run_main(
            ["get", "pods"],
            {"decision": {"verdict": "ALLOW", "receipt_id": "r", "decision_id": "d"}},
        )
        self.assertEqual(code, 127)  # main returns dispatch()'s fallback
        exec_mock.assert_called_once()
        args = exec_mock.call_args[0]
        expected_real = os.path.realpath(self.real_kubectl)
        self.assertEqual(args[0], expected_real)
        self.assertEqual(args[1], [expected_real, "get", "pods"])
        self.assertNotIn("HELM_API_KEY", args[2])
        lines = (self.tmp / "receipts.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(lines), 1)
        entry = json.loads(lines[0])
        self.assertTrue(entry["dispatch_attempted"])
        self.assertEqual(entry["command_class"], "read_only")

    def test_deny_blocks(self):
        code, exec_mock = self.run_main(
            ["delete", "namespace", "prod"],
            {
                "decision": {
                    "verdict": "DENY",
                    "reason_code": "KUBECTL_DESTRUCTIVE_DENY",
                }
            },
        )
        self.assertEqual(code, 1)
        exec_mock.assert_not_called()
        entry = json.loads((self.tmp / "receipts.jsonl").read_text().strip())
        self.assertFalse(entry["dispatch_attempted"])

    def test_escalate_blocks_with_exit_2(self):
        code, exec_mock = self.run_main(
            ["apply", "-f", "deploy.yaml"],
            {
                "decision": {
                    "verdict": "ESCALATE",
                    "reason_code": "KUBECTL_MUTATION_APPROVAL_REQUIRED",
                    "decision_id": "d-7",
                }
            },
        )
        self.assertEqual(code, 2)
        exec_mock.assert_not_called()

    def test_enforce_fail_closed_on_transport_error(self):
        err = guard.urllib.error.URLError("down")
        with mock.patch.object(guard.urllib.request, "urlopen", side_effect=err):
            with mock.patch.object(guard.os, "execve") as exec_mock:
                code = guard.main(["get", "pods"], self.env)
        self.assertEqual(code, 1)
        exec_mock.assert_not_called()

    def test_observe_mode_dispatches_on_transport_error(self):
        err = guard.urllib.error.URLError("down")
        env = dict(self.env, HELM_KUBECTL_GUARD_MODE="observe")
        with mock.patch.object(guard.urllib.request, "urlopen", side_effect=err):
            with mock.patch.object(guard.os, "execve") as exec_mock:
                code = guard.main(["get", "pods"], env)
        self.assertEqual(code, 127)
        exec_mock.assert_called_once()

    def test_missing_api_key_blocks(self):
        env = dict(self.env)
        env.pop("HELM_API_KEY")
        with mock.patch.object(guard.os, "execve") as exec_mock:
            code = guard.main(["get", "pods"], env)
        self.assertEqual(code, 1)
        exec_mock.assert_not_called()


class TestRealKubectlResolution(unittest.TestCase):
    def test_skips_shim_directory(self):
        with (
            tempfile.TemporaryDirectory() as shim_dir,
            tempfile.TemporaryDirectory() as real_dir,
        ):
            real_path = Path(real_dir) / "kubectl"
            real_path.write_text("#!/bin/sh\n")
            real_path.chmod(0o755)
            (Path(shim_dir) / "kubectl").write_text("# shim\n")
            env = {"PATH": os.pathsep.join([shim_dir, real_dir])}
            self.assertEqual(
                guard.resolve_real_kubectl(env, shim_dir), os.path.realpath(real_path)
            )

    def test_override_wins(self):
        with tempfile.TemporaryDirectory() as real_dir:
            real_path = Path(real_dir) / "kubectl"
            real_path.write_text("#!/bin/sh\n")
            real_path.chmod(0o755)
            env = {"HELM_KUBECTL_REAL": str(real_path), "PATH": ""}
            self.assertEqual(
                guard.resolve_real_kubectl(env, "/x"), os.path.realpath(real_path)
            )

    def test_missing_raises(self):
        with self.assertRaises(guard.GuardError):
            guard.resolve_real_kubectl({"PATH": "/nonexistent"}, "/x")

    def test_relative_override_raises(self):
        with self.assertRaises(guard.GuardError):
            guard.resolve_real_kubectl({"HELM_KUBECTL_REAL": "./kubectl"}, "/x")


class TestConfig(unittest.TestCase):
    def test_plaintext_remote_kernel_is_rejected(self):
        with self.assertRaises(guard.GuardError):
            guard.load_config({"HELM_URL": "http://kernel.example"}, "/x")


if __name__ == "__main__":
    unittest.main()
