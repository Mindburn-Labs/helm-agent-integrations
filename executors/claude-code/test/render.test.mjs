import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { firstDenyMatch } from "../src/deny-check.mjs";
import { MANAGED_ONLY_KEYS, MIN_CLAUDE_VERSION, REQUIRED_DENY, renderManaged, renderOwnerOtel, renderSession, shellQuote } from "../src/render.mjs";

const BIN = "/usr/local/bin/helm-executor";
const opts = { edgeUrl: "https://executor.helm.example/", cpUrl: "https://cp.helm.example", orgId: "0b6f1d52-3c3e-4a77-9d0f-5f2c7a1e8b34", helmExecutor: BIN };

test("the managed settings carry exactly the keys the Claude Code docs define, with the gateway pinned", () => {
  const { settings, mcp, otel } = renderManaged(opts);
  assert.equal(otel, null);
  assert.deepEqual(Object.keys(settings).sort(), ["allowManagedHooksOnly", "allowManagedMcpServersOnly", "allowedMcpServers", "allowedProviders", "apiKeyHelper", "env", "hooks", "permissions", "requiredMinimumVersion"]);
  assert.equal(settings.requiredMinimumVersion, MIN_CLAUDE_VERSION);
  assert.deepEqual(settings.allowedProviders, ["customEndpoint"]);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://executor.helm.example");
  assert.equal(settings.env.ANTHROPIC_API_KEY, "", "an ambient key must not outrank apiKeyHelper");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, "240000");
  assert.equal(settings.env.HELM_EXECUTOR_CLIENT, "claude-code");
  assert.equal(settings.env.HELM_EXECUTOR_CP_URL, "https://cp.helm.example");
  assert.equal(settings.env.HELM_EXECUTOR_ORG, opts.orgId);
  assert.equal("OTEL_RESOURCE_ATTRIBUTES" in settings.env, false, "a launcher sets the work item; a managed value would override it");
  assert.equal(settings.apiKeyHelper, `${BIN} token`);
  assert.equal(settings.allowManagedHooksOnly, true);
  assert.equal(settings.allowManagedMcpServersOnly, true);
  assert.deepEqual(settings.allowedMcpServers, [{ serverUrl: "https://executor.helm.example/mcp" }]);
  assert.equal("forceLoginMethod" in settings, false, "forceLoginMethod blocks apiKeyHelper");
  assert.deepEqual(mcp, { mcpServers: { helm: { type: "http", url: "https://executor.helm.example/mcp", headersHelper: `${BIN} headers` } } });
});

test("every hook runs `helm-executor observe` in exec form, asynchronously, and never decides anything", () => {
  const { settings } = renderManaged(opts);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart"]);
  for (const [event, groups] of Object.entries(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.deepEqual(Object.keys(hook).filter((k) => !["timeout", "async"].includes(k)).sort(), ["args", "command", "type"]);
        assert.equal(hook.type, "command");
        assert.equal(hook.command, BIN);
        assert.deepEqual(hook.args, ["observe", "--client", "claude-code", "--event", event]);
        if (event === "SessionEnd") assert.equal(hook.timeout, 5);
        else assert.equal(hook.async, true);
      }
    }
  }
});

test("the tool matcher selects side-effecting tools and leaves read-only ones out", () => {
  const { settings } = renderManaged(opts);
  const matcher = new RegExp(settings.hooks.PreToolUse[0].matcher);
  for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "mcp__helm__github_pull_request_create_draft"]) assert.ok(matcher.test(tool), tool);
  for (const tool of ["Read", "Grep", "Glob", "TodoWrite", "BashOutput", "WebFetch", "Notebook"]) assert.ok(!matcher.test(tool), tool);
});

test("the deny rules stop the documented spellings of the raw writes and the Linear tools", () => {
  const { settings } = renderManaged(opts);
  const deny = settings.permissions.deny;
  for (const rule of REQUIRED_DENY) assert.ok(deny.includes(rule), rule);
  const denied = [
    ["Bash", { command: "git push origin main" }],
    ["Bash", { command: "git push" }],
    ["Bash", { command: "cd repo && git push -u origin x" }],
    ["Bash", { command: "FOO=1 timeout 30 git push origin x" }],
    ["Bash", { command: "gh pr merge 12 --squash" }],
    ["Bash", { command: "kubectl get pods -A" }],
    ["Bash", { command: "echo ok; flux reconcile kustomization apps" }],
    ["WebSearch", {}],
    ["WebFetch", { url: "https://example.com" }],
    ["mcp__linear__save_issue", {}],
    ["mcp__claude_ai_Linear__save_comment", {}],
    ["mcp__c86a8029-8640-4461-a4e9-2e6eab1c4946__save_issue", {}],
    ["mcp__linear__delete_comment", {}],
    ["mcp__linear__create_attachment", {}],
    ["mcp__linear__update_diff", {}],
    ["mcp__linear__share_issue", {}],
    ["Read", { file_path: `${process.env.HOME}/.config/helm-executor/credentials.json` }],
    ["Edit", { file_path: `${process.env.HOME}/.config/helm-executor/slots/default.json` }],
  ];
  for (const [tool, input] of denied) assert.ok(firstDenyMatch(deny, tool, input), `${tool} ${JSON.stringify(input)}`);
  const allowed = [
    ["Bash", { command: "git status" }],
    ["Bash", { command: "git commit -m 'fix git push docs'" }],
    ["Bash", { command: "echo kubectl" }],
    ["Bash", { command: "npm test" }],
    ["Read", { file_path: "/work/repo/README.md" }],
    ["mcp__linear__list_issues", {}],
    ["mcp__linear__get_issue", {}],
    ["mcp__helm__github_pull_request_create_draft", {}],
    ["mcp__helm__linear_issue_create", {}],
    ["mcp__helm__helm_attempt_get", {}],
  ];
  for (const [tool, input] of allowed) assert.equal(firstDenyMatch(deny, tool, input), null, `${tool} ${JSON.stringify(input)}`);
});

test("the documented bypass spellings are not matched by the rules, which is why the gateway holds the credentials", () => {
  const { settings } = renderManaged(opts);
  for (const command of ["git -C . push origin x", "/usr/bin/git push origin x", "sh -c 'git push origin x'", "git 'push' origin x"]) {
    assert.equal(firstDenyMatch(settings.permissions.deny, "Bash", { command }), null, command);
  }
});

test("the rendered files hold no credential and no placeholder", () => {
  const text = JSON.stringify(renderManaged({ ...opts, otelEndpoint: "https://otel.helm.example" }));
  assert.ok(!text.includes("{{"));
  assert.ok(!/Bearer|helm_(at|rt|dc|sk)_|sk-[A-Za-z0-9]{16}|ghp_/.test(text));
});

test("helper commands are shell-quoted so a path with spaces still runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-render-"));
  try {
    const spaced = join(dir, "bin dir", "it's");
    mkdirSync(join(dir, "bin dir"));
    writeFileSync(spaced, '#!/bin/sh\necho "ran $*"\n');
    chmodSync(spaced, 0o755);
    const { settings, mcp } = renderManaged({ ...opts, helmExecutor: spaced });
    assert.equal(settings.apiKeyHelper, `${shellQuote(spaced)} token`);
    for (const [command, word] of [[settings.apiKeyHelper, "token"], [mcp.mcpServers.helm.headersHelper, "headers"]]) {
      const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
      assert.equal(r.stdout, `ran ${word}\n`, command);
    }
    assert.equal(renderManaged({ ...opts, helmExecutor: spaced }).settings.hooks.PreToolUse[0].hooks[0].command, spaced, "exec form takes the raw path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(shellQuote("/usr/local/bin/helm-executor"), "/usr/local/bin/helm-executor");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("inputs are validated: https only, no credentials in URLs, an absolute path, a plain organization id", () => {
  const bad = [
    { edgeUrl: "http://executor.helm.example" },
    { edgeUrl: "https://user:pw@executor.helm.example" },
    { edgeUrl: "not a url" },
    { edgeUrl: undefined },
    { cpUrl: "http://cp.helm.example" },
    { orgId: "has space" },
    { orgId: "" },
    { helmExecutor: "helm-executor" },
    { helmExecutor: "/bin/x\ny" },
    { otelEndpoint: "http://otel.helm.example" },
  ];
  for (const override of bad) assert.throws(() => renderManaged({ ...opts, ...override }), Error, JSON.stringify(override));
  assert.doesNotThrow(() => renderManaged({ ...opts, edgeUrl: "https://executor.helm.example/prefix?x=1#y" }));
  assert.equal(renderManaged({ ...opts, edgeUrl: "https://executor.helm.example/prefix?x=1#y" }).mcp.mcpServers.helm.url, "https://executor.helm.example/prefix/mcp");
});

test("telemetry is a separate drop-in, sets no resource attributes and no auth header helper", () => {
  const { otel } = renderManaged({ ...opts, otelEndpoint: "https://otel.helm.example/" });
  assert.deepEqual(otel, {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.helm.example",
      OTEL_METRICS_INCLUDE_SESSION_ID: "true",
      OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "true",
    },
  });
});

test("the session profile is the managed content without the keys only managed settings honor", () => {
  const managed = renderManaged(opts);
  const session = renderSession({ ...opts, edgeUrl: "http://127.0.0.1:8123", cpUrl: "http://127.0.0.1:8124" });
  for (const key of MANAGED_ONLY_KEYS) assert.equal(key in session.settings, false, key);
  assert.deepEqual(Object.keys(session.settings).sort(), ["apiKeyHelper", "env", "hooks", "permissions"]);
  assert.deepEqual(session.settings.permissions, managed.settings.permissions);
  assert.equal(session.settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8123");
  assert.equal(session.mcp.mcpServers.helm.url, "http://127.0.0.1:8123/mcp");
  assert.throws(() => renderManaged({ ...opts, edgeUrl: "http://127.0.0.1:8123" }), /https/, "the managed profile never takes cleartext");
  const withOtel = renderSession({ ...opts, otelEndpoint: "https://otel.helm.example" });
  assert.equal(withOtel.settings.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.helm.example");
});

test("the owner's telemetry block is observation only", () => {
  const env = renderOwnerOtel({ otelEndpoint: "https://otel.helm.example" });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_METRICS_EXPORTER", "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES", "OTEL_METRICS_INCLUDE_SESSION_ID"]);
  assert.throws(() => renderOwnerOtel({ otelEndpoint: "http://otel.helm.example" }), /https/);
});
