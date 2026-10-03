"""Local adapter checks. These are not gateway or runtime conformance proof."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import tomllib
import unittest

ADAPTER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER))

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
        result = pre_tool_use.response(None)
        self.assertNotIn("permissionDecision", result["hookSpecificOutput"])
        self.assertNotIn("additionalContext", result["hookSpecificOutput"])

    def test_linear_mcp_writes_require_the_helm_route(self):
        self.assertIsNotNone(policy.tool_deny(hook_event("mcp__linear__save_issue", {"title": "x"})))
        self.assertIsNotNone(policy.tool_deny(hook_event("mcp__linear__create_comment", {"body": "x"})))
        self.assertIsNone(policy.tool_deny(hook_event("mcp__linear__get_issue", {"id": "HELM-1"})))
        self.assertIsNone(policy.tool_deny(hook_event("mcp__helm__linear_issue_create", {"title": "x"})))

    def test_invalid_shell_payload_is_denied(self):
        self.assertIsNotNone(policy.tool_deny(hook_event("Bash", {"command": ["git", "push"]})))
        self.assertIsNotNone(policy.shell_deny("git 'push"))


class HookInputTests(unittest.TestCase):
    def test_malformed_or_non_json_event_is_rejected(self):
        for raw in (b"[]", b"{}", b"{", b'{"tool_input":NaN}', b"x" * (pre_tool_use.MAX_INPUT_BYTES + 1)):
            with self.subTest(raw=raw[:24]):
                with self.assertRaises(ValueError):
                    pre_tool_use.parse_event(raw)

    def test_non_shell_input_and_unknown_fields_need_no_adapter_envelope(self):
        event = hook_event("apply_patch", "*** Begin Patch\n*** End Patch")
        event["future_field"] = {"opaque": True}
        self.assertEqual(pre_tool_use.parse_event(json.dumps(event).encode()), event)
        event.pop("tool_input")
        self.assertEqual(pre_tool_use.parse_event(json.dumps(event).encode()), event)


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
        self.assertGreaterEqual(config["model_providers"]["helm"]["auth"]["timeout_ms"], 8000)
        self.assertNotIn("danger-full-access", requirements["allowed_sandbox_modes"])
        self.assertTrue(requirements["allow_managed_hooks_only"])
        self.assertTrue(requirements["experimental_network"]["enabled"])
        self.assertTrue(requirements["experimental_network"]["managed_allowed_domains_only"])
        self.assertEqual(requirements["experimental_network"]["domains"]["api.github.com"], "deny")
        self.assertNotIn("model", config)
        self.assertNotIn("model_reasoning_effort", config)
        self.assertNotIn("approval_policy", config)
        self.assertIn("HELM_EXECUTOR_SLOT", config["shell_environment_policy"]["include_only"])

    def test_quoted_admin_paths_preserve_the_helper_argv(self):
        values = render.substitutions("https://executor.qa.example", "/opt/helm's adapter", "/opt/helm core/bin/helm-executor", "/usr/bin/python3")
        files = render.rendered_files(values)
        config = tomllib.loads(files["config.toml"])
        requirements = tomllib.loads(files["requirements.toml"])
        self.assertEqual(shlex.split(config["mcp_servers"]["helm"]["http_headers_helper"]), ["/opt/helm core/bin/helm-executor", "headers"])
        deny, observe = requirements["hooks"]["PreToolUse"][0]["hooks"]
        self.assertEqual(shlex.split(deny["command"]), ["/usr/bin/python3", "/opt/helm's adapter/pre_tool_use.py"])
        self.assertFalse(deny.get("async", False))
        self.assertEqual(shlex.split(observe["command"]), ["/opt/helm core/bin/helm-executor", "observe", "--client", "codex", "--event", "PreToolUse"])
        self.assertTrue(observe["async"])
        post = requirements["hooks"]["PostToolUse"][0]["hooks"][0]
        self.assertEqual(shlex.split(post["command"]), ["/opt/helm core/bin/helm-executor", "observe", "--client", "codex", "--event", "PostToolUse"])
        self.assertTrue(post["async"])

    def test_credentials_paths_and_fake_edge_are_not_rendered(self):
        for edge in ("http://executor.example", "https://user:secret@executor.example", "https://executor.example/v1", "https://executor.example?token=private", "https://executor.invalid"):
            with self.subTest(edge=edge):
                with self.assertRaises(ValueError):
                    render.substitutions(edge, "/opt/helm/codex", "/opt/helm/helm-executor", "/usr/bin/python3")


class GeneratedCommandTests(unittest.TestCase):
    """Exercise rendered command boundaries with a process fixture, never a CP."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="helm-codex-command-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.executor = self.directory / "core's helper"
        fixture = (Path(__file__).parent / "core_command_fixture.py").read_text()
        self.executor.write_text("#!" + sys.executable + "\n" + fixture)
        self.executor.chmod(0o700)
        files = render.rendered_files(render.substitutions("https://executor.qa.example", str(ADAPTER), str(self.executor), sys.executable))
        self.config = tomllib.loads(files["config.toml"])
        self.hooks = tomllib.loads(files["requirements.toml"])["hooks"]
        self.capture = self.directory / "stdin.bin"
        self.env = {**os.environ, "CODEX_CORE_FIXTURE_CAPTURE": str(self.capture)}

    def run_command(self, command, raw=b"", env=None):
        return subprocess.run(command, shell=True, input=raw, capture_output=True, timeout=3, env=env or self.env)

    def test_original_hook_stdin_reaches_each_shared_observe_command(self):
        for event in ("PreToolUse", "PostToolUse"):
            with self.subTest(event=event):
                raw = (' { "hook_event_name": "' + event + '", "session_id": "s", "tool_name": "apply_patch", "tool_input": "café", "unknown": [1, 2] }\n').encode()
                hook = self.hooks[event][0]["hooks"][-1]
                result = self.run_command(hook["command"], raw)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(self.capture.read_bytes(), raw)

    def test_observer_zero_exit_with_failure_does_not_report_delivery_or_remove_deny(self):
        raw = json.dumps(hook_event(tool_input={"command": "git push origin HEAD"})).encode()
        deny, observe = self.hooks["PreToolUse"][0]["hooks"]
        result = self.run_command(observe["command"], raw, {**self.env, "CODEX_CORE_FIXTURE_FAILURE": "1"})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"fixture failure", result.stderr)
        local = self.run_command(deny["command"], raw)
        self.assertEqual(local.returncode, 0, local.stderr)
        output = json.loads(local.stdout)["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertNotIn("additionalContext", output)

    def test_opaque_header_map_keeps_future_core_keys(self):
        command = self.config["mcp_servers"]["helm"]["http_headers_helper"]
        result = self.run_command(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"Authorization": "Bearer fixture", "Future-Header": "fixture-value"})


if __name__ == "__main__":
    unittest.main()
