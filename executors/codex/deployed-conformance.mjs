#!/usr/bin/env node
// Parent-only finite E1/edge smoke. No inference, tools/call or fake server.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateInput, within } from "./deployed-input.mjs";

const adapter = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(await readFile(join(adapter, "core-contract.json"), "utf8"));
const { values } = parseArgs({ options: { input: { type: "string" }, report: { type: "string" }, core: { type: "string" }, "run-live": { type: "boolean", default: false }, "timeout-ms": { type: "string", default: "60000" } }, strict: true });
const budget = Number(values["timeout-ms"]);
if (!values.input || !values.report || !Number.isInteger(budget) || budget < 10000 || budget > 120000 || (values["run-live"] && !values.core)) throw new Error("Use --input NONCREDENTIAL_JSON --report NEW_REPORT [--run-live --core PINNED_BUILT_CORE] [--timeout-ms 60000].");
const reportPath = resolve(values.report), start = Date.now(), steps = [], secrets = new Set();
if ([".codex", ".ssh", ".config/helm-executor"].some(p => reportPath === resolve(homedir(), p) || within(reportPath, resolve(homedir(), p)))) throw new Error("Qualification report must be outside the owner's profile and credentials.");
const report = {
  schema: "helm.executor.codex.deployed-smoke/v1", input_result: "NOT_RUN", smoke_result: "NOT_RUN", scope: "Actual shared-core E1 checkout/mint/stop and public edge authentication/MCP discovery only", steps,
  managed_configuration: "NOT_RUN", managed_hook_provenance: "NOT_RUN", installed_managed_client: "NOT_RUN", provider_inference: "NOT_RUN", signed_D24_claim_readback: "NOT_RUN", native_D8: "NOT_RUN", T100: "NOT_QUALIFIED", deployment_refs_verification: "SUPPLIED_NOT_VERIFIED",
  limitations: [
    "Input references are prerequisites, never proof of deployment or approval.",
    "No managed client is started. User-layer app-server proof does not qualify managed authority or CLI inner workspace-write.",
    "No model request carries an episode credential. Only an unauthenticated Responses rejection is checked.",
    "No tools/call or effect proposal is sent; UNKNOWN/reconciliation/dispatch counts are unqualified.",
    "Core stop retires the episode; its last token can remain valid until expiry. Successor admission and retained-attempt drain are separate native gates.",
    "The inspected native MCP gateway is stateless: GET and DELETE return405. A session id is transport correlation, not a stored session or credential."
  ]
};
let input, env, core, checkoutStarted = false, stopped = false, liveStarted = false, reportAllowed = false, episodeId, session, headers, activeStep = "input validation";
class Failure extends Error {}
const check = (ok, reason) => { if (!ok) throw new Failure(reason); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const decode = bytes => { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Failure("Core or edge returned invalid JSON"); } };
const left = () => { const n = budget - (Date.now() - start); check(n > 0, "Finite smoke budget expired"); return n; };
async function step(name, action) { activeStep = name; await action(); steps.push({ name, status: "PASS" }); }
async function unused(path) { try { await lstat(path); throw new Failure("Report path already exists"); } catch (e) { if (e.code !== "ENOENT") throw e; } }
function run(command, args, childEnv, timeout) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { env: childEnv, timeout, maxBuffer: 512 * 1024, encoding: "buffer", killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(new Failure("Core/source command could not finish within its finite budget"));
      else accept({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on("error", () => {}); child.stdin.end();
  });
}
async function cli(args, cleanup = false) {
  const r = await run(process.execPath, [join(core, "dist/cli.js"), ...args], env, cleanup ? 21000 : Math.min(21000, left()));
  (report.core_calls ??= []).push({ command: args[0], exit_code: r.code, stdout_empty: r.stdout.length === 0, failure_code: /^helm-executor: (internal|usage|not_logged_in|no_episode|episode_ended|unavailable|rejected):/.exec(r.stderr.toString())?.[1] ?? null });
  return r;
}
async function status(cleanup = false) { const r = await cli(["status", "--json"], cleanup); check(r.code === 0, "Core status failed"); const s = decode(r.stdout); check(s.schema === "helm.executor.status/v1", "Core status schema differs"); return s; }
async function privateDirectory(path) {
  const s = await lstat(path);
  check(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o700 && s.uid === process.getuid() && await realpath(path) === path, "Runtime directories must be existing private owned0700 directories without symlinks");
}
async function http(url, { method = "POST", payload, authenticated = false, transport = false } = {}) {
  const requestHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(authenticated ? headers : {}), ...(transport && session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" } : {}) };
  const response = await fetch(url, { method, headers: requestHeaders, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error", signal: AbortSignal.timeout(Math.min(8000, left())) });
  let bytes = 0; const chunks = [];
  if (response.body) for await (const chunk of response.body) { bytes += chunk.length; check(bytes <= 2 * 1024 * 1024, "Edge response exceeded its bound"); chunks.push(Buffer.from(chunk)); }
  (report.edge_requests ??= []).push({ route: new URL(url).pathname, method, authenticated, status: response.status, response_bytes: bytes });
  return { status: response.status, bytes, body: Buffer.concat(chunks), session: response.headers.get("mcp-session-id"), contentType: response.headers.get("content-type") };
}
const initRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "helm-codex-deployed-smoke", version: "1" } } };
async function rpc(payload) {
  const r = await http(input.edge_origin + "/mcp", { payload, authenticated: true, transport: payload.method !== "initialize" });
  if (payload.id === undefined) { check(r.status === 202 && r.bytes === 0, "Native MCP notification did not return empty202"); return null; }
  check(r.status === 200 && r.contentType?.startsWith("application/json"), "Native MCP did not return JSON HTTP200");
  const body = decode(r.body); check(body.jsonrpc === "2.0" && body.id === payload.id && body.result && !body.error, "Native MCP response failed exact RPC correlation");
  if (payload.method === "initialize") { check(typeof r.session === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(r.session), "Native MCP initialize omitted its bounded correlation id"); session = r.session; }
  return body.result;
}
async function stopOwnedEpisode() {
  const s = await status(true);
  check(s.slot === input.slot && s.episode?.episode_id === episodeId && s.episode.work_item_id === input.work_item_id && s.episode.client === "codex", "Cleanup refuses a foreign or unresolved slot binding");
  const r = await cli(["stop"], true); check(r.code === 0 && r.stdout.length === 0, "Shared core stop did not acknowledge retirement; preserve state for recovery"); stopped = true;
}

try {
  await unused(reportPath);
  const inputBytes = await readFile(resolve(values.input)); check(inputBytes.length <= 16384, "Noncredential input exceeds its bound"); input = decode(inputBytes);
  check(typeof input?.executor_home !== "string" || (reportPath !== input.executor_home && !within(reportPath, input.executor_home)), "Report must be outside shared core state"); reportAllowed = true;
  const missing = validateInput(input, homedir()); report.input_sha256 = digest(inputBytes); report.missing = missing;
  report.source_files_sha256 = {};
  for (const path of ["deployed-conformance.mjs", "deployed-input.mjs", "core-contract.json"]) report.source_files_sha256[path] = digest(await readFile(join(adapter, path)));
  if (missing.length) { report.input_result = "BLOCKED_INPUTS"; process.exitCode = 2; }
  else {
    report.input_result = "READY"; report.environment = input.environment; report.controller_run_ref = input.controller_run_ref; report.deployment_refs = input.deployment; report.origins = { cp: input.cp_origin, edge: input.edge_origin };
    if (values["run-live"]) {
      liveStarted = true;
      core = resolve(values.core);
      env = { PATH: "/usr/bin:/bin", HOME: input.runtime_home, HELM_EXECUTOR_HOME: input.executor_home, HELM_EXECUTOR_CP_URL: input.cp_origin, HELM_EXECUTOR_ORG: input.org_id, HELM_EXECUTOR_CLIENT: "codex", HELM_EXECUTOR_SLOT: input.slot, HELM_EXECUTOR_OBSERVE_SUMMARY: "off" };
      await step("pinned shared core and private logged-in empty slot", async () => {
        check(Number(process.versions.node.split(".")[0]) >= 22, "Shared core requires Node22+"); await privateDirectory(input.runtime_home); await privateDirectory(input.executor_home);
        const head = await run("git", ["-C", core, "rev-parse", "HEAD:executors/core"], { PATH: "/usr/bin:/bin" }, Math.min(5000, left())); check(head.code === 0 && head.stdout.toString().trim() === pin.core_tree_sha, "Shared-core source tree differs from immutable pin");
        const clean = await run("git", ["-C", core, "diff", "--quiet", "HEAD", "--", "."], { PATH: "/usr/bin:/bin" }, Math.min(5000, left())); check(clean.code === 0, "Shared core has tracked modifications");
        for (const [path, hash] of Object.entries(pin.sha256)) check(digest(await readFile(join(core, path))) === hash, "Shared core contract/schema differs from pin");
        const s = await status(); check(s.logged_in === true && s.workspace_id === input.workspace_id && s.cp_url === input.cp_origin && s.slot === input.slot && s.episode === null && Array.isArray(s.problems) && s.problems.length === 0, "Dedicated slot is not logged into the expected CP workspace or is occupied");
        report.core_source_sha = pin.source_sha; report.core_cli_sha256 = digest(await readFile(join(core, "dist/cli.js")));
      });
      await step("actual E1 checkout and opaque shared headers", async () => {
        checkoutStarted = true; const r = await cli(["checkout", input.work_item_id, "--client", "codex", "--org", input.org_id, "--json"]); check(r.code === 0, "Actual E1 checkout refused or is unresolved; preserve core state");
        const checkout = decode(r.stdout); check(checkout.schema === "helm.executor.checkout/v1" && checkout.work_item_id === input.work_item_id && checkout.client === "codex" && checkout.slot === input.slot && checkout.reused === false, "Actual E1 checkout did not create the intended new binding");
        episodeId = checkout.episode_id; const s = await status(); check(s.episode?.episode_id === episodeId && s.episode.work_item_id === input.work_item_id && s.episode.client === "codex" && s.episode.ended === null && s.episode.seconds_left > 120, "Actual E1 binding lacks the requested work/client or sufficient deadline");
        const h = await cli(["headers"]); check(h.code === 0 && h.stderr.length === 0, "Actual E1 token/header producer failed");
        headers = decode(h.stdout); check(headers && typeof headers === "object" && !Array.isArray(headers) && Object.keys(headers).length > 0 && Object.hasOwn(headers, "Authorization"), "Shared headers map is unavailable");
        for (const [key, value] of Object.entries(headers)) { check(/^[A-Za-z0-9-]{1,64}$/.test(key) && !/^(?:content-type|accept|mcp-session-id|mcp-protocol-version|host)$/i.test(key) && typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\r\n\0]/.test(value), "Shared headers map contains an invalid transport header"); secrets.add(value); }
        report.episode_id = episodeId; report.work_item_id = input.work_item_id;
      });
      await step("public edge rejects unauthenticated MCP and Responses", async () => {
        const m = await http(input.edge_origin + "/mcp", { payload: initRequest }); const r = await http(input.edge_origin + "/v1/responses", { payload: {} });
        check([401, 403].includes(m.status) && [401, 403].includes(r.status), "Public edge did not reject both credential-free requests before dispatch"); report.unauthenticated = { mcp_status: m.status, responses_status: r.status };
      });
      await step("actual authenticated native MCP initialize and tool discovery", async () => {
        const initialized = await rpc(initRequest); check(initialized.protocolVersion === "2025-06-18" && initialized.serverInfo?.name === "helm-gateway" && initialized.serverInfo.version === input.deployment.mcp_server_version, "Native MCP protocol/build readback differs from prepared deployment reference");
        await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
        const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); check(Array.isArray(listed.tools) && listed.tools.length <= 1024, "Native tool inventory is missing or unbounded");
        const names = listed.tools.map(t => t?.name); check(names.every(n => typeof n === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(n)) && new Set(names).size === names.length, "Native tool inventory names are invalid or duplicated");
        const required = ["github_repository_get", "github_branch_create_from_changes", "github_pull_request_create_draft", "helm_attempt_get"]; check(required.every(n => names.includes(n)), "Mandates/read authority do not expose the required native effect and attempt tools"); report.mcp = { protocol: initialized.protocolVersion, server_version: initialized.serverInfo.version, required_tools: required, tool_count: names.length, session_correlation_present: true };
      });
      await step("native stateless MCP GET and DELETE return405", async () => {
        const g = await http(input.edge_origin + "/mcp", { method: "GET", authenticated: true, transport: true }); const d = await http(input.edge_origin + "/mcp", { method: "DELETE", authenticated: true, transport: true });
        check(g.status === 405 && d.status === 405, "Native MCP transport differs from inspected stateless gateway; qualify its actual protocol before proceeding"); report.mcp.get_status = g.status; report.mcp.delete_status = d.status; session = undefined;
      });
      await step("actual E1 retirement and subsequent helper refusal", async () => {
        await stopOwnedEpisode(); const token = await cli(["token"]); check([4, 5].includes(token.code) && token.stdout.length === 0 && /^helm-executor: (?:no_episode|episode_ended): [^\r\n]{1,200}\n$/.test(token.stderr.toString()), "Core token helper did not refuse retired state with empty stdout and a bounded reason"); report.retirement = { stop_acknowledged: true, subsequent_token_exit: token.code, subsequent_token_stdout_empty: true, native_successor_drain: "NOT_RUN" };
      });
      report.smoke_result = "PASS";
    }
  }
} catch (error) {
  report.smoke_result = liveStarted ? "FAIL" : "NOT_RUN"; if (!liveStarted) report.input_result = "INVALID";
  steps.push({ name: activeStep, status: "FAIL", reason: error instanceof Failure ? error.message : "A source, private-directory, subprocess or HTTPS operation failed" }); process.exitCode = 1;
} finally {
  if (checkoutStarted && !stopped) {
    try { if (!episodeId) { const s = await status(true); if (s.episode?.work_item_id === input.work_item_id && s.episode.client === "codex") episodeId = s.episode.episode_id; } check(episodeId, "Checkout response unresolved; recover the original key through shared core before another binding"); await stopOwnedEpisode(); report.cleanup = "OWN_EPISODE_RETIRED"; }
    catch { report.cleanup = "UNRESOLVED_KEEP_CORE_STATE"; report.smoke_result = "FAIL"; process.exitCode = 1; }
  }
  headers = undefined; session = undefined; report.seconds = (Date.now() - start) / 1000;
  const bytes = JSON.stringify(report, null, 2) + "\n"; check([...secrets].every(s => !bytes.includes(s)), "Credential persistence refused");
  if (reportAllowed) await writeFile(reportPath, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ input_result: report.input_result, smoke_result: report.smoke_result, steps: steps.length, T100: report.T100, report: reportAllowed ? reportPath : null }));
}
