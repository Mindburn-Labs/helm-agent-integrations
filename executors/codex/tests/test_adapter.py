"""Local adapter checks. These are not gateway or runtime conformance proof."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tomllib
import unittest
from unittest.mock import patch

ADAPTER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER))

import mcp_headers
import policy
import pre_tool_use
import render


def hook_event(name="Bash", tool_input=None):
    return {
        "hook_event_name": "PreToolUse",
        "session_id": "session-1",
        "turn_id": "turn-1",
        "tool_use_id": "call-1",
        "tool_name": name,
        "tool_input": tool_input if tool_input is not None else {"command": "git status --short"},
    }


class LocalDenyTests(unittest.TestCase):
    def test_raw_commands_are_denied_with_global_flags_and_wrappers(self):
        for command in (
            "git push origin helm/seat/x",
            "git -C '/tmp/a repo' -c credential.helper= push origin HEAD",
            "env MODE=x /usr/bin/git --git-dir=/tmp/repo.git push",
            "git status && gh --repo Mindburn-Labs/repo pr merge 1 --squash",
            "bash -lc 'git -C /tmp/repo push origin HEAD'",
            "kubectl get pods",
            "/usr/local/bin/flux reconcile source git platform",
            "linear issue update HELM-1",
        ):
            with self.subTest(command=command):
                self.assertIsNotNone(policy.shell_deny(command))

    def test_local_read_and_file_edits_do_not_claim_a_gateway_allow(self):
        self.assertIsNone(policy.shell_deny("git -C /tmp/repo diff --check"))
        self.assertIsNone(policy.tool_deny(hook_event("apply_patch", {"command": "*** Add File: guide.md\n+git push\n"})))
        result = pre_tool_use.response(None, "submitted")
        self.assertNotIn("permissionDecision", result["hookSpecificOutput"])

    def test_linear_mcp_writes_require_the_helm_route(self):
        self.assertIsNotNone(policy.tool_deny(hook_event("mcp__linear__save_issue", {"title": "x"})))
        self.assertIsNotNone(policy.tool_deny(hook_event("mcp__linear__create_comment", {"body": "x"})))
        self.assertIsNone(policy.tool_deny(hook_event("mcp__linear__get_issue", {"id": "HELM-1"})))
        self.assertIsNone(policy.tool_deny(hook_event("mcp__helm__linear_issue_create", {"title": "x"})))

    def test_invalid_shell_payload_is_denied(self):
        self.assertIsNotNone(policy.tool_deny(hook_event("Bash", {"command": ["git", "push"]})))
        self.assertIsNotNone(policy.shell_deny("git 'push"))


class ObservationTests(unittest.TestCase):
    def test_observation_contains_no_raw_input_or_authority(self):
        event = hook_event(tool_input={"command": "TOKEN=private git status"})
        payload = pre_tool_use.observation(event, None)
        encoded = json.dumps(payload)
        self.assertNotIn("private", encoded)
        self.assertNotIn("TOKEN", encoded)
        self.assertEqual(payload["coverage"], "observed-only")
        self.assertNotIn("work_item_id", payload)
        self.assertNotIn("episode_id", payload)
        self.assertNotIn("idempotency_key", payload)
        expected = hashlib.sha256(b'{"command":"TOKEN=private git status"}').hexdigest()
        self.assertEqual(payload["tool_input_sha256"], expected)

    def test_sender_failure_does_not_remove_a_local_deny(self):
        with patch.object(pre_tool_use.subprocess, "run", side_effect=subprocess.TimeoutExpired("observer", 3)):
            delivery = pre_tool_use.send_observation(["/opt/helm/observer"], pre_tool_use.observation(hook_event(), "blocked"))
        output = pre_tool_use.response("blocked", delivery)["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("not submitted", output["additionalContext"])

    def test_sink_is_direct_argv_and_never_a_shell_command(self):
        with patch.object(pre_tool_use.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(pre_tool_use.send_observation(["/opt/helm/observer", "codex"], {}), "submitted")
        self.assertEqual(run.call_args.args[0], ["/opt/helm/observer", "codex"])
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(pre_tool_use.send_observation(["observer"], {}), "failed")
        self.assertEqual(pre_tool_use.send_observation(None, {}), "not-configured")

    def test_malformed_or_non_json_event_is_rejected(self):
        for raw in (b"[]", b"{}", b"{", b'{"tool_input":NaN}', b"x" * (pre_tool_use.MAX_INPUT_BYTES + 1)):
            with self.subTest(raw=raw[:24]):
                with self.assertRaises(ValueError):
                    pre_tool_use.parse_event(raw)


class HeaderHelperTests(unittest.TestCase):
    def test_core_token_is_shaped_without_another_auth_implementation(self):
        result = subprocess.CompletedProcess([], 0, b"episode.token.value\n")
        with patch.object(mcp_headers.subprocess, "run", return_value=result) as run:
            self.assertEqual(mcp_headers.authorization_headers("/opt/helm/helm-executor"), {"Authorization": "Bearer episode.token.value"})
        self.assertEqual(run.call_args.args[0], ["/opt/helm/helm-executor", "token"])
        self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_failure_and_header_injection_are_rejected(self):
        for code, stdout in ((1, b"token"), (0, b""), (0, b"token\r\nInjected: x"), (0, b"Bearer token"), (0, b"private" * 4096), (0, b"\xff")):
            with self.subTest(code=code, size=len(stdout)):
                with patch.object(mcp_headers.subprocess, "run", return_value=subprocess.CompletedProcess([], code, stdout)):
                    with self.assertRaises(mcp_headers.TokenUnavailable):
                        mcp_headers.authorization_headers("/opt/helm/helm-executor")
        with self.assertRaises(mcp_headers.TokenUnavailable):
            mcp_headers.authorization_headers("helm-executor")


class RendererTests(unittest.TestCase):
    def test_requirements_pin_local_routes_and_forbid_unrestricted_sandbox(self):
        files = render.rendered_files(render.substitutions("https://executor.qa.example", "/opt/helm/codex", "/opt/helm/bin/helm-executor", "/usr/bin/python3"))
        config = tomllib.loads(files["config.toml"])
        requirements = tomllib.loads(files["requirements.toml"])
        self.assertEqual(requirements["model_provider"], "helm")
        self.assertEqual(config["model_providers"], requirements["model_providers"])
        self.assertEqual(config["model_providers"]["helm"]["base_url"], "https://executor.qa.example/v1")
        self.assertEqual(config["mcp_servers"]["helm"]["url"], requirements["mcp_servers"]["helm"]["identity"]["url"])
        self.assertEqual(config["model_providers"]["helm"]["auth"]["args"], ["token"])
        self.assertNotIn("danger-full-access", requirements["allowed_sandbox_modes"])
        self.assertTrue(requirements["allow_managed_hooks_only"])
        self.assertTrue(requirements["experimental_network"]["enabled"])
        self.assertTrue(requirements["experimental_network"]["managed_allowed_domains_only"])
        self.assertEqual(requirements["experimental_network"]["domains"]["api.github.com"], "deny")
        self.assertNotIn("model", config)
        self.assertNotIn("model_reasoning_effort", config)
        self.assertNotIn("approval_policy", config)

    def test_quoted_admin_paths_preserve_the_helper_argv(self):
        values = render.substitutions("https://executor.qa.example", "/opt/helm's adapter", "/opt/helm core/bin/helm-executor", "/usr/bin/python3", ["/opt/helm core/bin/helm-executor", "observe"])
        config = tomllib.loads(render.rendered_files(values)["config.toml"])
        import shlex
        self.assertEqual(shlex.split(config["mcp_servers"]["helm"]["http_headers_helper"]), ["/usr/bin/python3", "/opt/helm's adapter/mcp_headers.py", "--executor", "/opt/helm core/bin/helm-executor"])

    def test_credentials_paths_and_fake_edge_are_not_rendered(self):
        for edge in ("http://executor.example", "https://user:secret@executor.example", "https://executor.example/v1", "https://executor.example?token=private", "https://executor.invalid"):
            with self.subTest(edge=edge):
                with self.assertRaises(ValueError):
                    render.substitutions(edge, "/opt/helm/codex", "/opt/helm/helm-executor", "/usr/bin/python3")


if __name__ == "__main__":
    unittest.main()
