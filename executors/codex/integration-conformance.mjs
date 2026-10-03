#!/usr/bin/env node
// Finite local consumer integration. Uses the real core CLI and its published fake CP;
// it never connects to a live edge, provider, GitHub, or an owner's client profile.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const adapter = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(await readFile(join(adapter, "core-contract.json"), "utf8"));
const { values } = parseArgs({ options: {
  core: { type: "string" }, python: { type: "string", default: "python3" },
  report: { type: "string" }, "timeout-ms": { type: "string", default: "45000" },
}, strict: true });
const timeoutMs = Number(values["timeout-ms"]);
if (!values.core || !values.report || !Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) {
  throw new Error("Use --core BUILT_CORE_DIRECTORY --report NEW_REPORT_JSON [--python PYTHON3] [--timeout-ms 45000].");
}
const core = resolve(values.core);
const reportPath = resolve(values.report);
const children = new Set();
const steps = [];
let activeStep = "producer source pin";
let temporary;
let fake;
let coreCheckout;
let adapterCheckout;

class CheckFailure extends Error {}
function check(condition, reason) { if (!condition) throw new CheckFailure(reason); }
function data(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new CheckFailure(`${label} did not return JSON`); }
}
function quote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
async function step(name, action) {
  activeStep = name;
  await action();
  steps.push({ name, status: "PASS" });
}
function processResult(command, args, env, input = Buffer.alloc(0)) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { env, timeout: 10000, maxBuffer: 9 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      children.delete(child);
      if (error && typeof error.code !== "number") reject(new CheckFailure("A helper could not start or exceeded its finite process budget"));
      else accept({ code: error?.code ?? 0, stdout, stderr });
    });
    children.add(child);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function run() {
  check(Number(process.versions.node.split(".")[0]) >= 22, "Shared core requires Node 22 or later");
  await step("producer contract and schema hashes match the consumer pin", async () => {
    for (const [name, expected] of Object.entries(pin.sha256)) {
      const source = await readFile(join(core, name));
      check(createHash("sha256").update(source).digest("hex") === expected, "The supplied core contract or schema differs from the consumer pin");
    }
    const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const consumer = await processResult("git", ["-C", adapter, "rev-parse", "HEAD"], gitEnv);
    check(consumer.code === 0, "The adapter source must be supplied from its qualified Git checkout");
    adapterCheckout = consumer.stdout.toString("utf8").trim();
    const consumerDirt = await processResult("git", ["-C", adapter, "diff", "--quiet", "HEAD", "--", ":(top)executors/codex"], gitEnv);
    check(consumerDirt.code === 0, "The adapter source contains uncheckpointed changes");
    const head = await processResult("git", ["-C", core, "rev-parse", "HEAD"], gitEnv);
    check(head.code === 0, "The core source must be supplied from its qualified Git checkout");
    coreCheckout = head.stdout.toString("utf8").trim();
    const source = await processResult("git", ["-C", core, "diff", "--quiet", pin.source_sha, "--", ":(top)executors/core"], gitEnv);
    check(source.code === 0, "The core source differs from the pinned producer checkpoint");
    const untracked = await processResult("git", ["-C", core, "ls-files", "--others", "--exclude-standard", "--", ":(top)executors/core"], gitEnv);
    check(untracked.code === 0 && untracked.stdout.length === 0, "Uncheckpointed core files cannot enter this qualification run");
  });
  const { startFakeCp } = await import(pathToFileURL(join(core, "dist/testing/fake-cp.js")));
  const { runGovernedFlow } = await import(pathToFileURL(join(core, "dist/testing/governed-flow.js")));
  temporary = await mkdtemp(join(tmpdir(), "helm-codex-integration-"));
  const home = join(temporary, "home");
  await mkdir(home, { mode: 0o700 });
  const executor = join(temporary, "helm-executor");
  // Installation wrapper only: all subcommand handling stays in the actual core CLI.
  await writeFile(executor, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(core, "dist/cli.js"))} "$@"\n`, { mode: 0o700 });
  await chmod(executor, 0o700);

  let droppedAttempt;
  fake = await startFakeCp({ pollsBeforeApproval: 0 });
  const branchCount = () => [...fake.gateway.attempts.values()].filter((attempt) => attempt.effectType === "github.branch.create_from_changes").length;
  check(new URL(fake.url).hostname === "127.0.0.1", "This runner only accepts the shared loopback fake");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temporary,
    HELM_EXECUTOR_HOME: join(temporary, "state"), HELM_EXECUTOR_CP_URL: fake.url,
    HELM_EXECUTOR_ORG: fake.orgId, HELM_EXECUTOR_OBSERVE_SUMMARY: "off" };
  const first = { ...env, HELM_EXECUTOR_SLOT: "claude-conformance", HELM_EXECUTOR_CLIENT: "claude-code" };
  const second = { ...env, HELM_EXECUTOR_SLOT: "codex-conformance", HELM_EXECUTOR_CLIENT: "codex" };
  const cli = (args, context = second) => processResult(executor, args, context);
  const shell = (command, raw, context = second) => processResult("/bin/sh", ["-c", command], context, raw);
  const review = join(temporary, "review");
  let config, hooks, firstEpisode, secondEpisode, firstHeaders, secondHeaders;
  const work = randomUUID();

  await step("rendered provider, header and hook commands use the actual core CLI", async () => {
    const rendered = await processResult(values.python, [join(adapter, "render.py"), "--edge", "https://executor.qa.example", "--adapter", adapter, "--executor", executor, "--output", review], env);
    check(rendered.code === 0, "The review renderer failed");
    const parsed = await processResult(values.python, ["-c", "import json,sys,tomllib; from pathlib import Path; p=Path(sys.argv[1]); print(json.dumps({n:tomllib.loads((p/n).read_text()) for n in ['config.toml','requirements.toml']}))", review], env);
    check(parsed.code === 0, "The rendered TOML could not be parsed");
    const files = data(parsed.stdout, "rendered configuration");
    config = files["config.toml"];
    hooks = files["requirements.toml"].hooks;
    check(config.model_providers.helm.auth.command === executor, "Provider auth did not select the actual helper");
    check(hooks.PreToolUse[0].hooks[0].async !== true, "The local deny must be synchronous");
    check(hooks.PreToolUse[0].hooks[1].async === true && hooks.PostToolUse[0].hooks[0].async === true, "Shared observations must be asynchronous");
  });
  await step("actual device login and first-slot checkout", async () => {
    const loggedIn = await cli(["login", "--cp-url", fake.url, "--org", fake.orgId], first);
    check(loggedIn.code === 0 && loggedIn.stdout.length === 0, "Device login failed or printed non-data stdout");
    const checkout = await cli(["checkout", work, "--client", "claude-code", "--json"], first);
    check(checkout.code === 0, "The first slot could not check out the fake work item");
    firstEpisode = data(checkout.stdout, "first checkout");
    check(firstEpisode.work_item_id === work && firstEpisode.client === "claude-code", "First checkout bound the wrong work item or client");
    const headerResult = await shell(config.mcp_servers.helm.http_headers_helper, Buffer.alloc(0), first);
    check(headerResult.code === 0, "The shared header helper failed for the first slot");
    firstHeaders = data(headerResult.stdout, "first headers");
  });
  await step("a second live slot is refused without an episode or token", async () => {
    const checkout = await cli(["checkout", work, "--client", "codex", "--json"]);
    check(checkout.code === 7 && checkout.stdout.length === 0, "The fake live-episode conflict did not fail closed");
    const token = await cli(["token"]);
    check(token.code === 4 && token.stdout.length === 0, "A refused slot unexpectedly supplied a token");
  });
  await step("reuse the shared governed MCP flow including draft approval and replay", async () => {
    const flow = await runGovernedFlow({ edgeUrl: fake.url, headers: firstHeaders,
      target: "github.com/Mindburn-Labs/helm-qa-sandbox", branchPrefix: "helm/", waitForApprovalMs: 5000,
      onEscalated: (id) => check(fake.gateway.approve(id), "The fake did not approve its escalated draft attempt") });
    check(flow.length >= 9 && flow.every((item) => item.status === "PASS"), "The shared governed flow did not complete all local fake checks");
  });

  let rpcId = 0;
  const sessions = new WeakMap();
  async function rpc(method, params, headers) {
    const session = sessions.get(headers);
    const notification = method.startsWith("notifications/");
    const answer = await fetch(`${fake.url}/mcp`, { method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers,
      ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++rpcId }), method, params }), redirect: "manual", signal: AbortSignal.timeout(3000) });
    if (notification) {
      check(answer.status === 202, "The local MCP initialized notification failed");
      await answer.arrayBuffer();
      return null;
    }
    check(answer.status === 200, "A local MCP call was refused");
    if (method === "initialize") {
      const id = answer.headers.get("mcp-session-id");
      check(typeof id === "string" && id.length > 0, "The local MCP did not supply a session id");
      sessions.set(headers, id);
    }
    return answer.json();
  }
  async function initialize(headers) {
    const connected = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-local-conformance", version: "1" } }, headers);
    check(connected.result?.protocolVersion === "2025-06-18", "Local MCP protocol negotiation failed");
    await rpc("notifications/initialized", {}, headers);
  }
  const target = "github.com/Mindburn-Labs/helm-qa-sandbox";
  const intent = { schema: "helm.github.branch.create_from_changes.v1", base: "main", base_sha: "a".repeat(40),
    head: `helm/codex-d8-${randomUUID()}`, message: "local response-loss probe",
    files: [{ path: "conformance/codex-d8.txt", mode: "100644", content_utf8: "local fake only\n" }] };
  await step("drop the MCP response after the shared fake applies the branch effect", async () => {
    await initialize(firstHeaders);
    const before = new Set(fake.gateway.attempts.keys());
    const count = branchCount();
    fake.dropResponse("POST /mcp", 1);
    let responseLost = false;
    try { await rpc("tools/call", { name: "github_branch_create_from_changes", arguments: { target, arguments: intent } }, firstHeaders); }
    catch { responseLost = true; }
    const created = [...fake.gateway.attempts.values()].filter((attempt) => !before.has(attempt.id) && attempt.effectType === "github.branch.create_from_changes");
    droppedAttempt = created[0];
    check(responseLost && created.length === 1 && droppedAttempt?.status === "succeeded", "The transport loss did not occur after the fake effect was applied");
    check(branchCount() === count + 1, "The loss scenario did not create exactly one fake application");
  });
  await step("stop first slot, handle an injected successor hold, then checkout Codex", async () => {
    const stopped = await cli(["stop"], first);
    check(stopped.code === 0 && stopped.stdout.length === 0, "The first slot did not stop cleanly");
    const oldToken = await cli(["token"], first);
    check(oldToken.code === 4 && oldToken.stdout.length === 0, "The stopped slot still supplied a token");
    const oldAdmission = await fetch(`${fake.url}/mcp`, { method: "POST", headers: firstHeaders, body: "{}", signal: AbortSignal.timeout(3000) });
    check(oldAdmission.status === 401, "The fake admitted a stopped episode token");
    await oldAdmission.arrayBuffer();
    // The fake has no native drain barrier. Fault injection checks consumer handling only.
    fake.fail("/executor-episodes", 409, 1);
    const held = await cli(["checkout", work, "--client", "codex", "--json"]);
    check(held.code === 7 && held.stdout.length === 0, "An injected successor hold did not refuse checkout");
    const checkout = await cli(["checkout", work, "--client", "codex", "--json"]);
    check(checkout.code === 0, "Codex checkout failed after the injected hold was released");
    secondEpisode = data(checkout.stdout, "second checkout");
    check(secondEpisode.work_item_id === work && secondEpisode.episode_id !== firstEpisode.episode_id && secondEpisode.slot !== firstEpisode.slot, "The switch did not preserve work identity while changing episode and slot");
    const headerResult = await shell(config.mcp_servers.helm.http_headers_helper, Buffer.alloc(0));
    check(headerResult.code === 0, "The rendered Codex header helper failed");
    secondHeaders = data(headerResult.stdout, "second headers");
    const auth = config.model_providers.helm.auth;
    const token = await processResult(auth.command, auth.args, second);
    check(token.code === 0 && secondHeaders.Authorization === "Bearer " + token.stdout.toString("utf8").trim(), "Provider and MCP helpers did not use the same active slot");
  });
  await step("D8 retry across slots returns the retained attempt and one fake application", async () => {
    await initialize(secondHeaders);
    check(sessions.get(firstHeaders) !== sessions.get(secondHeaders), "The D8 retry did not use a distinct MCP session");
    const reordered = Object.fromEntries(Object.entries(intent).reverse());
    const applicationCount = branchCount();
    const attemptCount = fake.gateway.attempts.size;
    const retry = await rpc("tools/call", { name: "github_branch_create_from_changes", arguments: { target, arguments: reordered } }, secondHeaders);
    const result = retry.result?.structuredContent;
    check(result?.status === "succeeded" && result.attempt_id === droppedAttempt.id, "Retry did not resolve to the retained attempt");
    check(branchCount() === applicationCount && fake.gateway.attempts.size === attemptCount, "Retry created an additional fake effect or attempt");
    const readback = await rpc("tools/call", { name: "helm_attempt_get", arguments: { attempt_id: result.attempt_id } }, secondHeaders);
    const observed = readback.result?.structuredContent;
    check(observed?.status === "succeeded" && observed.attempt_id === droppedAttempt.id && observed.result?.commit_sha === droppedAttempt.result.commit_sha, "Retained effect readback did not establish the same fake result");
  });
  const deny = hooks.PreToolUse[0].hooks[0].command;
  const preObserve = hooks.PreToolUse[0].hooks[1].command;
  await step("rendered deny blocks raw tools without executing them", async () => {
    for (const [tool, input] of [
      ["exec_command", { command: "git push origin HEAD" }], ["exec_command", { command: "gh pr merge 1 --squash" }],
      ["exec_command", { command: "kubectl get pods" }], ["exec_command", { command: "flux reconcile source git platform" }],
      ["mcp__linear__save_issue", { title: "local probe" }],
    ]) {
      const raw = Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "local-deny", tool_name: tool, tool_input: input }));
      const denied = await shell(deny, raw);
      check(denied.code === 0 && data(denied.stdout, "deny hook").hookSpecificOutput?.permissionDecision === "deny", "A raw tool was not locally denied");
    }
  });
  await step("original Pre/Post hook JSON reaches shared core and the fake observation sink", async () => {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const input = { command: "printf 'café'" };
      const envelope = { hook_event_name: event, session_id: "local-observe", turn_id: "turn-local",
        tool_use_id: `call-${event}`, tool_name: "exec_command", tool_input: input,
        episode_id: "untrusted-hook-episode", work_item_id: "untrusted-hook-work", future_field: [true, "café"], tool_response: "output-not-for-post" };
      const raw = Buffer.from(" \n" + JSON.stringify(envelope, null, 2) + "\n");
      const command = hooks[event][0].hooks.at(-1).command;
      const before = fake.observations.length;
      const observed = await shell(command, raw);
      check(observed.code === 0 && observed.stdout.length === 0, "The shared observation command blocked or emitted stdout");
      check(fake.observations.length === before + 1, "The shared observation was not accepted by the fake CP");
      const posted = fake.observations.at(-1);
      check(posted.client === "codex" && posted.coverage === "observed-only" && posted.event === event && posted.session_id === envelope.session_id && posted.turn_id === envelope.turn_id, "Observation correlation changed");
      check(posted.episode_id === secondEpisode.episode_id && posted.work_item_id === work, "Hook input supplied authority instead of core state");
      const digest = "sha256:" + createHash("sha256").update(JSON.stringify(input)).digest("hex");
      check(posted.tool?.name === envelope.tool_name && posted.tool?.use_id === envelope.tool_use_id && posted.tool?.input_digest === digest, "Original hook tool input or identity was transformed");
      check(posted.tool.input_summary === undefined && !JSON.stringify(posted).includes(envelope.tool_response), "A disabled summary or tool output was posted");
    }
  });
  await step("failed observation exits zero with no delivery claim and local deny remains", async () => {
    const raw = Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "failure-observe", tool_name: "exec_command", tool_input: { command: "git push origin HEAD" } }));
    const before = fake.observations.length;
    fake.fail("/observations", 503, 1);
    const observed = await shell(preObserve, raw);
    check(observed.code === 0 && observed.stdout.length === 0 && fake.observations.length === before, "Observation failure was treated as delivery or blocked a tool");
    const denied = await shell(deny, raw);
    const output = data(denied.stdout, "deny hook").hookSpecificOutput;
    check(output.permissionDecision === "deny" && output.additionalContext === undefined, "Observer failure changed deny or reported delivery");
    const status = await cli(["status", "--json"]);
    check(status.code === 0 && typeof data(status.stdout, "core status").observe?.last_error === "string", "The core did not expose observation failure diagnostics");
    const malformed = await shell(preObserve, Buffer.from("not JSON"));
    check(malformed.code === 0 && malformed.stdout.length === 0 && fake.observations.length === before, "Malformed input blocked or was submitted");
  });
  await step("stopped Codex provider and MCP auth return no credential", async () => {
    check((await cli(["stop"])).code === 0, "Codex stop failed");
    const auth = config.model_providers.helm.auth;
    const token = await processResult(auth.command, auth.args, second);
    const headers = await shell(config.mcp_servers.helm.http_headers_helper, Buffer.alloc(0));
    check(token.code === 4 && token.stdout.length === 0 && headers.code === 4 && headers.stdout.length === 0, "The stopped Codex slot still printed a credential");
  });
}

let failed = false;
let deadline;
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new CheckFailure("The finite integration budget expired")), timeoutMs); })]);
} catch (error) {
  failed = true;
  steps.push({ name: activeStep, status: "FAIL", detail: error instanceof CheckFailure ? error.message : "Integration setup or dependency failed; inspect the supplied source/build paths" });
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGKILL");
  if (fake) await fake.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
const report = { schema: "helm.executor.codex.local-integration.v1", scope: "local core CLI and published fake CP/gateway only",
  adapter_source_sha: adapterCheckout, core_source_sha: pin.source_sha, core_checkout_sha: coreCheckout, local_result: failed ? "FAIL" : "PASS", steps,
  deployed_qa: "NOT_RUN", actual_codex_managed_hooks: "NOT_RUN", public_edge_and_D24_signed_admission: "NOT_RUN",
  native_D8_provider_reconciliation: "NOT_RUN", limitations: [
    "Rendered helper commands are executed by this runner, not by an installed Codex managed hook engine.",
    "The shared fake has no native stopped-token/retained-attempt drain barrier; one injected 409 checks consumer refusal and retry only.",
    "The response loss is after a fake application and before MCP result delivery; one fake application is not real provider dispatch proof.",
    "The fake does not qualify TLS, gateway credential custody, machine-to-seat enrollment, signed D24 audience/client/TTL admission, native Kernel D8 UNKNOWN reconciliation or deployed CP E1.",
  ] };
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ scope: report.scope, adapter_source_sha: report.adapter_source_sha, core_source_sha: report.core_source_sha, local_result: report.local_result, steps: steps.length, report: reportPath }));
process.exitCode = failed ? 1 : 0;
