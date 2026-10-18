import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {chmod, link, mkdtemp, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CASES, invocation, retainedClaudeDebug, validateInput} from "../run.mjs";

const digest = "a".repeat(64);
const root = "/run/g0-private/agent-rows";
const references = Object.fromEntries([
  "model-stub", "provider-fakes", "network-policy", "claude-effective-managed", "codex-effective-managed", "openclaw-installed-plugin",
].map(name => [name, {path: `${root}/${name}.json`, sha256: digest}]));
const clients = Object.fromEntries(["claude-code", "codex", "openclaw"].map((name, index) => [name, {
  binary: `/opt/helm/bin/${name}`, sha256: digest, version: "1.0.0", slot: name,
  work_item_id: `00000000-0000-0000-0000-00000000000${index}`, commitment_id: "00000000-0000-0000-0000-000000000000",
  cwd: `${root}/${name}/cwd`, home: `${root}/${name}/home`, config: `${root}/${name}/config`,
  ...(name === "openclaw" ? {config_sha256: digest} : {}),
}]));
const input = {
  schema: "helm.agent-rows.producer-input/v1", slot: "dev-1", namespace: "dev-1",
  profile: "g0-disposable-managed-fake-stub", model_upstream: "stub", provider_endpoints: "fakes",
  control_plane_origin: "https://cp.qa.example", edge_origin: "https://edge.qa.example",
  organization_id: "00000000-0000-0000-0000-000000000000",
  source_revision: "b".repeat(40), image_digest: `sha256:${digest}`, node_runtime_sha256: digest, artifact_root: root,
  fixtures: {allowedTool: "github_branch_create_from_changes", externalDeniedTool: "github_pull_request_create",
    nativeDuplicateTool: "github_branch_create_from_changes", allowedTarget: "github.com/qa/fake",
    excludedTarget: "github.com/qa/excluded", calls: {
      t87ControlCall: {tool: "github_branch_create_from_changes", target: "github.com/qa/fake", arguments: {schema: "test"}},
      t98ExcludedCall: {tool: "github_branch_create_from_changes", target: "github.com/qa/excluded", arguments: {schema: "test"}},
      t98ExternalDeniedCall: {tool: "github_pull_request_create", target: "github.com/qa/fake", arguments: {schema: "test"}},
      t98ControlCall: {tool: "github_branch_create_from_changes", target: "github.com/qa/fake", arguments: {schema: "test"}},
    }}, references,
  core: {binary: "/opt/helm/bin/helm-executor", sha256: digest}, clients,
};

test("finite case inventory covers each client and both control paths", () => {
  assert.equal(CASES.length, 26);
  assert.equal(new Set(CASES.map(c => c.id)).size, CASES.length);
  assert.deepEqual(new Set(CASES.map(c => c.row)), new Set(["T87", "T98"]));
  assert.equal(CASES.filter(c => c.id.includes("allowed_helm_control")).length, 2);
  assert.equal(CASES.filter(c => c.id.endsWith("external_allow_kernel_allow")).length, 1);
});

test("input validation is fail closed on scope, references and binary pins", () => {
  assert.equal(validateInput(structuredClone(input)).slot, "dev-1");
  for (const mutate of [
    i => {i.slot = "production";},
    i => {i.namespace = "dev-2";},
    i => {i.model_upstream = "paid";},
    i => {i.control_plane_origin = "https://user:secret@cp.qa.example";},
    i => {i.provider_endpoints = "real";},
    i => {i.clients.codex.sha256 = "wrong";},
    i => {i.references["provider-fakes"].path = "/tmp/fakes";},
    i => {delete i.references["network-policy"];},
    i => {i.fixtures.excludedTarget = i.fixtures.allowedTarget;},
    i => {i.fixtures.calls.t98ControlCall.target = i.fixtures.excludedTarget;},
    i => {i.fixtures.calls.t87ControlCall.arguments.api_key = "secret";},
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => validateInput(copy));
  }
});

test("each Claude process writes a separate private native debug trace", () => {
  const caseDir = "/run/g0-private/agent-rows/traces/T87.claude-code.raw_git_push";
  const [binary, args] = invocation("claude-code", "/opt/helm/bin/claude", "probe", caseDir);
  assert.equal(binary, "/opt/helm/bin/claude");
  assert.deepEqual(args.slice(-2), ["--debug-file", `${caseDir}/claude-debug.log`]);
  assert.throws(() => invocation("claude-code", binary, "probe", "relative/path"), /absolute case directory/);
  assert.equal(invocation("codex", "/opt/helm/bin/codex", "probe", caseDir)[1].includes("--debug-file"), false);
});

test("native debug retention pins only owner regular file bytes and refuses alternate paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "helm-claude-debug-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const debug = join(directory, "claude-debug.log");
  const data = Buffer.from("loaded plugin trace\n");
  await writeFile(debug, data);
  await chmod(debug, 0o644);
  const retained = await retainedClaudeDebug(debug);
  assert.deepEqual(retained, {status: "RETAINED_PRIVATE", path: debug,
    sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length});
  assert.equal((await stat(debug)).mode & 0o777, 0o600);
  const linked = join(directory, "linked-debug.log");
  await link(debug, linked);
  assert.deepEqual(await retainedClaudeDebug(debug), {status: "UNAVAILABLE"});
  await rm(linked);
  await symlink(debug, linked);
  assert.deepEqual(await retainedClaudeDebug(linked), {status: "UNAVAILABLE"});
  assert.deepEqual(await retainedClaudeDebug(join(directory, "absent")), {status: "UNAVAILABLE"});
  await writeFile(debug, Buffer.alloc(0));
  assert.deepEqual(await retainedClaudeDebug(debug), {status: "UNAVAILABLE"});
  await writeFile(debug, Buffer.alloc(1024 * 1024 + 1));
  assert.deepEqual(await retainedClaudeDebug(debug), {status: "UNAVAILABLE"});
});
