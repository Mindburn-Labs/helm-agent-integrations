#!/usr/bin/env node
// Parent-run, finite installed-client probe. All inference is a local SSE fixture.
// User-layer hook execution cannot qualify managed requirements or enforcement.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const adapter = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(await readFile(join(adapter, "core-contract.json"), "utf8"));
const inspected = JSON.parse(await readFile(join(adapter, "installed-client.json"), "utf8"));
const { values } = parseArgs({ options: {
  codex: { type: "string", default: inspected.binary }, core: { type: "string" },
  python: { type: "string", default: "python3" }, report: { type: "string" },
  "timeout-ms": { type: "string", default: "60000" },
}, strict: true });
const budget = Number(values["timeout-ms"]);
if (!values.core || !values.report || !Number.isInteger(budget) || budget < 10000 || budget > 120000) {
  throw new Error("Use --core BUILT_CORE_DIRECTORY --report NEW_REPORT_JSON [--codex BINARY] [--python PYTHON3] [--timeout-ms 60000].");
}
const core = resolve(values.core), binary = resolve(values.codex), reportPath = resolve(values.report);
const diagnosticsPath = reportPath + ".diagnostics.log", diagnosticSecrets = new Set();
const children = new Set(), steps = [], clientDiagnostics = [], hookReadback = [];
let temporary, fake, provider, consumerSha, activeStep = "installed binary and source pins", binarySha, cancelled = false;
class Failure extends Error {}
function check(value, reason) { if (!value) throw new Failure(reason); }
function quote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function decode(bytes) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Failure("A local helper did not return JSON"); } }
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
async function step(name, action) { check(!cancelled, "Probe was cancelled"); activeStep = name; await action(); check(!cancelled, "Probe was cancelled"); steps.push({ name, status: "PASS" }); }
function killGroup(child) { if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return; try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
function run(command, args, env, input = "", timeout = 10000) {
  check(!cancelled, "Probe was cancelled");
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { env, detached: true, timeout, maxBuffer: 9 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      children.delete(child);
      if (error && typeof error.code !== "number") { killGroup(child); reject(new Failure("A child could not start or exceeded its finite budget")); }
      else accept({ code: error?.code ?? 0, stdout, stderr });
    });
    children.add(child); child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
function diagnostics(label, result) {
  let text = result.stderr.toString("utf8");
  // Drop a possibly partial first line before redaction if the retained tail was capped.
  if (result.stderr_bytes > 65536) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
  for (const secret of diagnosticSecrets) text = text.replaceAll(secret, "[redacted]");
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability[_-]?token|token|password|secret|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replaceAll(resolve(homedir()), "[owner-home]");
  if (temporary) text = text.replaceAll(temporary, "[probe]");
  clientDiagnostics.push({ label, exit_code: result.code ?? null, signal: result.signal ?? null,
    spawn_error: result.spawn_error ?? null, terminated_by_probe: result.terminated_by_probe ?? false,
    stderr_sha256: result.stderr_sha256 ?? digest(result.stderr), stderr_bytes: result.stderr_bytes ?? result.stderr.length,
    stderr_complete: result.stderr_complete ?? true,
    stderr_truncated: result.stderr_bytes > 65536 || text.length > 8192, stderr_sanitized: text.slice(-8192),
    unknown_fields: [...text.matchAll(/unknown field [`']([a-z_]+)[`']/g)].map(m => m[1]) });
}

async function readConfiguration(command, args, env) {
  check(!cancelled, "Probe was cancelled");
  const child = spawn(command, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); child.stdin.on("error", () => {});
  const stderr = createHash("sha256"); let errorTail = Buffer.alloc(0), stderrBytes = 0;
  const stderrData = chunk => { stderr.update(chunk); stderrBytes += chunk.length; errorTail = Buffer.concat([errorTail, chunk]).subarray(-65536); };
  child.stderr.on("data", stderrData);
  const waiting = new Map(); let nextId = 0, bytes = 0, closed = false, code = null, signal = null, spawnError = null, terminatedByProbe = false, rpcDeadline;
  let resolveClose; const closePromise = new Promise(accept => { resolveClose = accept; });
  const rejectAll = () => { for (const w of waiting.values()) w.reject(new Failure("Installed app-server exited before configuration readback")); waiting.clear(); };
  child.on("error", error => { spawnError = error.code ?? "UNKNOWN"; rejectAll(); });
  child.on("exit", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; });
  child.on("close", (exitCode, exitSignal) => { closed = true; code = exitCode; signal = exitSignal; rejectAll(); resolveClose(); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 4 * 1024 * 1024) { terminatedByProbe = true; rejectAll(); killGroup(child); return; }
    let m; try { m = JSON.parse(line); } catch { terminatedByProbe = true; rejectAll(); killGroup(child); return; }
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); m.error ? w.reject(new Failure("Installed app-server rejected a documented configuration RPC")) : w.accept(m.result); }
  });
  const request = (method, params) => new Promise((accept, reject) => {
    if (closed || spawnError !== null) { reject(new Failure("Installed app-server exited before configuration readback")); return; }
    const id = ++nextId; waiting.set(id, { accept, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    return await Promise.race([(async () => {
      await request("initialize", { clientInfo: { name: "helm_codex_local_probe", title: "HELM local acceptance", version: "1" } });
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      const config = await request("config/read", { includeLayers: false });
      const requirements = await request("configRequirements/read", {});
      return { config: config.config, requirements: requirements.requirements };
    })(), new Promise((_, reject) => { rpcDeadline = setTimeout(() => reject(new Failure("Configuration RPC budget expired")), 8000); rpcDeadline.unref(); })]);
  } finally {
    clearTimeout(rpcDeadline);
    let closeDeadline;
    if (!closed) {
      terminatedByProbe = spawnError === null; killGroup(child);
      await Promise.race([closePromise, new Promise(accept => { closeDeadline = setTimeout(accept, 1000); })]);
      clearTimeout(closeDeadline);
    }
    child.stderr.off("data", stderrData); child.stderr.resume();
    diagnostics("configuration-readback", { code, signal, spawn_error: spawnError, terminated_by_probe: terminatedByProbe,
      stderr: errorTail, stderr_sha256: stderr.digest("hex"), stderr_bytes: stderrBytes, stderr_complete: closed });
    lines.close(); if (closed) children.delete(child);
  }
}

async function probe() {
  const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  check(process.platform === "darwin" && Number(process.versions.node.split(".")[0]) >= 22, "This inspected binary probe requires macOS, sandbox-exec and Node 22+");
  check(![join(homedir(), ".codex"), join(homedir(), ".ssh"), "/etc/codex"].some(p => reportPath === p || reportPath.startsWith(p + "/")), "Report path must not be a live user or managed profile");
  for (const path of [reportPath, diagnosticsPath]) {
    try { await lstat(path); throw new Failure("Report or diagnostics path already exists; use a new qualification output"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  temporary = await realpath(await mkdtemp(join(tmpdir(), "helm-codex-client-")));
  const home = join(temporary, "home"), codexHome = join(temporary, "codex"), workspace = join(temporary, "workspace"), captures = join(temporary, "capture"), bins = join(temporary, "bin");
  for (const d of [home, codexHome, workspace, captures, bins]) await mkdir(d, { mode: 0o700 });
  const inspectionEnv = { ...gitEnv, HOME: home, CODEX_HOME: codexHome, TMPDIR: temporary };
  await step("installed binary and consumer/core source match their inspected pins", async () => {
    binarySha = digest(await readFile(binary)); check(binarySha === inspected.sha256, "Installed binary changed; refresh the read-only inspection before accepting it");
    const version = await run(binary, ["--version"], inspectionEnv);
    check(version.code === 0 && version.stdout.toString("utf8").trim() === inspected.version, "Installed version differs from the inspected binary");
    const head = await run("git", ["-C", adapter, "rev-parse", "HEAD"], gitEnv); check(head.code === 0, "Consumer Git checkpoint is unavailable"); consumerSha = head.stdout.toString("utf8").trim();
    check((await run("git", ["-C", adapter, "diff", "--quiet", "HEAD", "--", ":(top)executors/codex"], gitEnv)).code === 0, "Consumer source has uncheckpointed changes");
    const consumerOther = await run("git", ["-C", adapter, "ls-files", "--others", "--exclude-standard", "--", ":(top)executors/codex"], gitEnv);
    check(consumerOther.code === 0 && consumerOther.stdout.length === 0, "Untracked consumer source cannot enter this run");
    for (const [name, hash] of Object.entries(pin.sha256)) check(digest(await readFile(join(core, name))) === hash, "Shared core contract/schema hash differs from the pin");
    check((await run("git", ["-C", core, "diff", "--quiet", pin.source_sha, "--", ":(top)executors/core"], gitEnv)).code === 0, "Core source differs from its pinned checkpoint");
    const other = await run("git", ["-C", core, "ls-files", "--others", "--exclude-standard", "--", ":(top)executors/core"], gitEnv);
    check(other.code === 0 && other.stdout.length === 0, "Untracked core source cannot enter this run");
  });
  const executor = join(bins, "helm-executor"), sentinel = join(temporary, "raw-tool-ran");
  await writeFile(executor, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(core, "dist/cli.js"))} "$@"\n`, { mode: 0o700 });
  // These fixtures turn an unexpected raw dispatch into a local sentinel; never a real write.
  for (const name of ["git", "gh", "kubectl", "flux", "linear"]) {
    const guard = name === "git" ? '[ "$1" = push ]' : name === "gh" ? '[ "$1" = pr ] && [ "$2" = merge ]' : "true";
    const fallback = name === "git" ? 'exec /usr/bin/git "$@"' : "exit 2";
    await writeFile(join(bins, name), `#!/bin/sh\nif ${guard}; then /usr/bin/touch ${quote(sentinel)}; exit 97; fi\n${fallback}\n`, { mode: 0o700 });
  }
  const { startFakeCp } = await import(pathToFileURL(join(core, "dist/testing/fake-cp.js")));
  fake = await startFakeCp({ pollsBeforeApproval: 0 });
  check(new URL(fake.url).hostname === "127.0.0.1", "The supplied fake CP must bind loopback");
  const env = { PATH: bins + ":" + gitEnv.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: temporary, LANG: "en_US.UTF-8", TERM: "dumb",
    HELM_EXECUTOR_HOME: join(temporary, "executor"), HELM_EXECUTOR_CP_URL: fake.url, HELM_EXECUTOR_ORG: fake.orgId, HELM_EXECUTOR_CLIENT: "codex", HELM_EXECUTOR_SLOT: "installed-client-probe", HELM_EXECUTOR_OBSERVE_SUMMARY: "off" };
  let episode, authorization, config, captured = [];
  await step("actual shared core opens one isolated Codex slot on its loopback fake", async () => {
    check((await run(executor, ["login", "--cp-url", fake.url, "--org", fake.orgId], env)).code === 0, "Shared fake login failed");
    const checkout = await run(executor, ["checkout", randomUUID(), "--client", "codex", "--json"], env);
    check(checkout.code === 0, "Shared fake checkout failed"); episode = decode(checkout.stdout);
    const headers = await run(executor, ["headers"], env); check(headers.code === 0, "Shared header helper failed"); authorization = decode(headers.stdout).Authorization;
    check(typeof authorization === "string" && authorization.length > 0, "Shared header helper omitted Authorization");
    diagnosticSecrets.add(authorization); const token = authorization.replace(/^Bearer /i, ""); if (token) diagnosticSecrets.add(token);
  });
  const commands = ["printf 'helm-codex-client-ok'", "git push", "gh pr merge", "kubectl version", "flux version", "linear issue create"];
  let requestCount = 0; const feedback = new Map(), requestErrors = [];
  provider = createServer((req, res) => { void (async () => {
    try {
      check(req.method === "POST" && req.url === "/v1/responses", "Unexpected fixture route");
      check(req.headers.authorization === authorization, "Installed provider did not use the active core helper");
      check(!req.headers["content-encoding"], "Fixture requires uncompressed Responses JSON");
      const chunks = []; let total = 0; for await (const chunk of req) { total += chunk.length; check(total < 4 * 1024 * 1024, "Fixture request exceeded its cap"); chunks.push(chunk); }
      const body = decode(Buffer.concat(chunks)); check(body.model === "gpt-6.1-sol" && body.reasoning?.effort === "max", "Probe model/effort changed");
      for (const item of body.input ?? []) if (item.type === "function_call_output") feedback.set(item.call_id, String(item.output));
      const n = requestCount++; check(n <= commands.length, "Installed client exceeded the finite fixture sequence");
      if (n === 0) check((body.tools ?? []).some(t => t.name === "exec_command" || t.tools?.some(f => f.name === "exec_command")), "Installed client did not advertise the inspected exec_command tool");
      const id = `local-response-${n}`;
      const item = n < commands.length ? { type: "function_call", call_id: `local-call-${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: commands[n], login: false, yield_time_ms: 1000, max_output_tokens: 200 }) }
        : { type: "message", id: "local-message", role: "assistant", content: [{ type: "output_text", text: "Local fixture complete." }] };
      // A finite final hold lets asynchronous hooks finish before Codex closes the session.
      if (n === commands.length) await new Promise(accept => setTimeout(accept, 2000));
      const events = [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.end(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
    } catch { requestErrors.push("Responses fixture rejected route/auth/model/tool/schema or request budget"); res.writeHead(400); res.end('{"error":{"message":"Local fixture rejected request"}}'); }
  })(); });
  await new Promise(accept => provider.listen(0, "127.0.0.1", accept));
  const responsesUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const python = await run(values.python, ["-c", "import sys; print(sys.executable)"], gitEnv); check(python.code === 0, "Python interpreter is unavailable");
  const pythonPath = python.stdout.toString("utf8").trim();
  const prepared = await run(pythonPath, ["-c", `import json,sys;sys.path.insert(0,sys.argv[1]);from render import rendered_files,substitutions;print(json.dumps(rendered_files(substitutions('https://executor-probe.example.test',sys.argv[1],sys.argv[2],sys.argv[3]))))`, adapter, executor, pythonPath], env);
  check(prepared.code === 0, "Production template rendering failed"); const rendered = decode(prepared.stdout);
  // Only this disposable user profile substitutes loopback URLs and disables the managed network proxy.
  const captureCommand = [pythonPath, join(adapter, "tests/capture_client_hook.py"), "--directory", captures].map(quote).join(" ");
  let profile = rendered["config.toml"].replace('"https://executor-probe.example.test/v1"', JSON.stringify(responsesUrl)).replace('"https://executor-probe.example.test/mcp"', JSON.stringify(fake.url + "/mcp"))
    .replace("[features.network_proxy]\nenabled = true", "[features.network_proxy]\nenabled = false").replace("network_access = true", "network_access = false");
  profile = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n' + profile;
  profile = profile.replace("[features]\nhooks = true", "[features]\nhooks = true\nunified_exec = true\nplugins = false");
  const hookSection = rendered["requirements.toml"].slice(rendered["requirements.toml"].indexOf("[hooks]"), rendered["requirements.toml"].indexOf("[rules]"))
    .replace(/^managed_dir = .*\n/m, "");
  profile += '\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n' + hookSection;
  for (const event of ["PreToolUse", "PostToolUse"]) profile += `\n[[hooks.${event}]]\nmatcher = ".*"\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(captureCommand)}\nasync = true\ntimeout = 5\n`;
  await writeFile(join(codexHome, "config.toml"), profile, { mode: 0o600 });
  const ownerHome = resolve(homedir());
  const sandbox = `(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*")) (deny file-write* (require-not (subpath ${JSON.stringify(temporary)}))) (deny file-read* (subpath ${JSON.stringify(join(ownerHome, ".codex"))}) (subpath ${JSON.stringify(join(ownerHome, ".ssh"))}))`;
  const sandboxArgs = ["-p", sandbox, binary];
  await step("installed strict config readback uses the isolated user layer with no managed requirements", async () => {
    const readback = await readConfiguration("/usr/bin/sandbox-exec", [...sandboxArgs, "app-server", "--strict-config", "--listen", "stdio://"], env);
    check(readback.requirements === null, "Host has managed requirements; qualify in a dedicated environment instead of bypassing them");
    config = readback.config;
    check(config.model_provider === "helm" && config.model_providers?.helm?.base_url === responsesUrl, "Installed config readback did not retain the local HELM provider");
    check(config.model_providers.helm.auth?.command === executor && JSON.stringify(config.model_providers.helm.auth.args) === '["token"]', "Installed provider auth schema changed");
    check(config.mcp_servers?.helm?.http_headers_helper === quote(executor) + " headers" || config.mcp_servers?.helm?.http_headers_helper === executor + " headers", "Installed MCP helper schema changed");
    check(config.features?.hooks === true, "Installed hooks feature is not enabled");
  });
  await step("installed Codex runs the finite local fixture and initializes HELM MCP", async () => {
    const result = await run("/usr/bin/sandbox-exec", [...sandboxArgs, "--no-daemon", "exec", "--strict-config", "--ephemeral", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--json", "--color", "never", "-C", workspace, "Run the local acceptance fixture tools, then finish."], env, "", 30000);
    diagnostics("isolated-client", result);
    captured = await Promise.all((await readdir(captures)).map(async name => {
      const raw = await readFile(join(captures, name)), input = decode(raw);
      hookReadback.push({ raw_sha256: digest(raw), event: input.hook_event_name, tool: input.tool_name, use_id: input.tool_use_id,
        input_keys: Object.keys(input.tool_input ?? {}).sort(), input_digest: "sha256:" + digest(JSON.stringify(canonical(input.tool_input))) });
      return input;
    }));
    check(result.code === 0 && requestErrors.length === 0 && requestCount === commands.length + 1, "Installed client or fixture sequence failed; inspect the minimized diagnostics");
    check(fake.requests.some(r => r.path === "/mcp" && r.body?.method === "initialize") && fake.requests.some(r => r.path === "/mcp" && r.body?.method === "tools/list"), "Installed HELM MCP did not initialize and discover tools");
  });
  await step("allowed tool executes and five raw tools are denied before their sentinel fixtures", async () => {
    check(feedback.get("local-call-0")?.includes("helm-codex-client-ok"), "The allowed command did not execute");
    const reasons = ["Raw git push", "Raw PR merge", "Raw cluster or Flux", "Raw cluster or Flux", "Raw Linear write"];
    for (let n = 1; n < commands.length; n++) check(feedback.get(`local-call-${n}`)?.includes(reasons[n - 1]), "A raw tool lacked the adapter's explicit deny feedback");
    check(!(await readdir(temporary)).includes("raw-tool-ran"), "A raw tool reached its local dispatch sentinel");
  });
  await step("actual client hook payloads correlate with the shared observed-only fake sink", async () => {
    const allowedPost = captured.find(e => e.hook_event_name === "PostToolUse" && e.tool_use_id === "local-call-0");
    check(allowedPost, "The actual allowed tool did not produce PostToolUse");
    for (let n = 0; n < commands.length; n++) check(captured.some(e => e.hook_event_name === "PreToolUse" && e.tool_use_id === `local-call-${n}`), "An actual tool did not produce PreToolUse");
    for (const input of captured) {
      const matching = fake.observations.find(o => o.event === input.hook_event_name && o.session_id === input.session_id && o.tool?.use_id === input.tool_use_id);
      check(matching?.coverage === "observed-only" && matching.client === "codex" && matching.episode_id === episode.episode_id && matching.work_item_id === episode.work_item_id, "Actual hook correlation did not reach the fake sink with core-owned binding");
      check(matching.tool.input_digest === "sha256:" + digest(JSON.stringify(canonical(input.tool_input))), "Actual hook input changed across the observation seam");
      check(matching.tool.input_summary === undefined && matching.tool.name === input.tool_name, "Core input minimization or actual tool identity changed");
    }
    check(fake.gateway.attempts.size === 0, "The local client probe unexpectedly dispatched a fake governed effect");
  });
}

let failed = false, deadline;
try { await Promise.race([probe(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Failure("Finite installed-client budget expired")), budget); })]); }
catch (error) { failed = true; cancelled = true; steps.push({ name: activeStep, status: "FAIL", detail: error instanceof Failure ? error.message : "Probe setup failed; inspect binary, pinned core build and private temporary profile" }); }
finally {
  clearTimeout(deadline); for (const child of children) killGroup(child);
  if (provider) { provider.closeAllConnections(); await new Promise(accept => provider.close(accept)); }
  if (fake) await fake.close(); if (temporary) await rm(temporary, { recursive: true, force: true });
}
const report = { schema: "helm.executor.codex.installed-client-probe.v1", consumer_source_sha: consumerSha, core_source_sha: pin.source_sha,
  binary, binary_sha256: binarySha, inspected_version: inspected.version, local_result: failed ? "FAIL" : "PASS", steps, client_diagnostics: clientDiagnostics, diagnostics_log: diagnosticsPath, hook_readback: hookReadback,
  scope: "Installed local Codex user configuration/hook engine, actual shared core and loopback fake CP/MCP/Responses only",
  managed_configuration: "NOT_RUN", managed_hook_provenance: "NOT_RUN", deployed_E1_public_edge: "NOT_RUN", signed_D24_native_D8: "NOT_RUN",
  limitations: ["CODEX_HOME does not relocate Unix /etc/codex requirements or MDM/cloud policy. This probe refuses non-null managed requirements.",
    "The disposable profile copies hook commands from the template as user hooks and uses the documented trust flag for those vetted QA sources. This is not managed hook authority.",
    "Only the disposable profile substitutes loopback URLs and disables the production managed network proxy. Outer sandbox-exec permits loopback and denies writes outside its temporary directory.",
    "No provider inference, paid usage, actual user credentials, real effects, deployed QA, public TLS/network custody, signed admission or native D8 reconciliation is qualified."] };
const reportText = JSON.stringify(report, null, 2) + "\n", diagnosticsText = clientDiagnostics.map(d => JSON.stringify(d)).join("\n") + "\n";
for (const secret of diagnosticSecrets) {
  const encoded = JSON.stringify(secret).slice(1, -1);
  check(![reportText, diagnosticsText].some(text => text.includes(secret) || text.includes(encoded)), "Diagnostics still contain an opaque probe credential; refusing to persist them");
}
await writeFile(diagnosticsPath, diagnosticsText, { flag: "wx", mode: 0o600 });
await writeFile(reportPath, reportText, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ local_result: report.local_result, scope: report.scope, steps: steps.length, report: reportPath, diagnostics_log: diagnosticsPath }));
process.exitCode = failed ? 1 : 0;
