#!/usr/bin/env node
// Conformance for the Claude Code executor adapter.
//
//   node conformance/run.mjs                      fake control plane and fake edge, no Claude Code
//   node conformance/run.mjs --claude             also drive the installed `claude` through the session profile
//   node conformance/run.mjs --cp-url <url> --edge-url <url> --org <id> [--work-item <id>] [--login] [--claude]
//        [--governed-flow --target github.com/<owner>/<repo> --branch-prefix helm/<seat>/ [--wait-approval <seconds>]]
//        [--model <routed model name>]             a live control plane and edge (helm-qa-sandbox)
//
// Every check prints PASS, FAIL or SKIP. The exit code is 1 when any check fails. --report <file> writes the
// results as JSON. Nothing here proves enforcement: the gateway is the authority, this proves the adapter's side.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { firstDenyMatch } from "../src/deny-check.mjs";
import { writeSession } from "../src/install.mjs";
import { MIN_CLAUDE_VERSION, REQUIRED_DENY } from "../src/render.mjs";
import { scriptedMessages, toolResultsSinceLastAssistant } from "./scripted-edge.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORE = resolve(HERE, "..", "..", "core");
const AMBIENT_KEY = ["ambient", "key", "must", "never", "reach", "the", "edge"].join("-");
const AMBIENT_BEARER = ["ambient", "bearer", "must", "never", "reach", "the", "edge"].join("-");

function run(command, args, { env = {}, input = "", cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function postJson(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run every check. `options.fake` starts the fake control plane; otherwise cpUrl, edgeUrl, org and workItem are required. */
export async function runConformance(options) {
  const checks = [];
  const record = (name, ok, detail = "") => {
    checks.push({ name, status: ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL", detail });
    if (options.log) options.log(`${ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}\n`);
  };
  const tmp = mkdtempSync(join(tmpdir(), "helm-conformance-"));
  let fake = null;
  let scripted = null;
  try {
    let cpUrl = options.cpUrl;
    let edgeUrl = options.edgeUrl;
    let org = options.org;
    const workItem = options.workItem ?? `conformance-${Date.now()}`;
    if (options.fake) {
      const { startFakeCp } = await import(resolve(CORE, "dist", "testing", "fake-cp.js"));
      scripted = scriptedMessages();
      fake = await startFakeCp({ routes: { "POST /v1/messages": scripted.route } });
      cpUrl = fake.url;
      edgeUrl = fake.url;
      org = fake.orgId;
    }
    if (!cpUrl || !edgeUrl || !org) throw new Error("--cp-url, --edge-url and --org are required without the fake control plane");

    const home = options.home ?? join(tmp, "executor-home");
    const slot = `conformance-${Math.random().toString(16).slice(2, 8)}`;
    const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, HELM_EXECUTOR_HOME: home, HELM_EXECUTOR_CP_URL: cpUrl, HELM_EXECUTOR_ORG: org, HELM_EXECUTOR_SLOT: slot, HELM_EXECUTOR_TEST_POLL_MS: "20" };
    const wrapper = join(tmp, "helm-executor");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(CORE, "dist", "cli.js")}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const cli = (args, extra = {}) => run(wrapper, args, { env: { ...baseEnv, ...extra.env }, input: extra.input });

    // ---- login and checkout ----
    if (options.fake || options.login) {
      const login = await cli(["login", "--cp-url", cpUrl, "--org", org]);
      record("login proves the machine credential", login.code === 0 && login.stdout === "", login.stderr.trim().split("\n").at(-1));
    }
    const status0 = await cli(["status", "--json"]);
    const loggedIn = status0.code === 0 && JSON.parse(status0.stdout).logged_in === true;
    record("a machine credential is stored", loggedIn, loggedIn ? "" : "run `helm-executor login` first, or pass --login");
    if (!loggedIn) return finish();

    const checkout = await cli(["checkout", workItem, "--client", "claude-code", "--json"]);
    let episode = null;
    try {
      episode = JSON.parse(checkout.stdout);
    } catch {
      episode = null;
    }
    record("checkout creates an episode for the work item", checkout.code === 0 && episode?.schema === "helm.executor.checkout/v1", checkout.stderr.trim());
    if (!episode) return finish();

    // ---- token and headers ----
    const token = await cli(["token"]);
    const tokenValue = token.stdout.trim();
    record("token prints the bearer token and one LF, nothing else", token.code === 0 && /^[^\s]+\n$/.test(token.stdout) && token.stderr === "", `exit ${token.code}`);
    const headers = await cli(["headers"]);
    let headerMap = null;
    try {
      headerMap = JSON.parse(headers.stdout);
    } catch {
      headerMap = null;
    }
    record("headers prints one Authorization header", headers.code === 0 && headerMap && Object.keys(headerMap).join() === "Authorization" && /^Bearer [^\s]+$/.test(headerMap.Authorization), `exit ${headers.code}`);

    // ---- the edge accepts the token ----
    const probe = (auth) => postJson(`${edgeUrl}/v1/messages`, auth, { model: options.model ?? "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "." }] });
    const accepted = await probe({ "anthropic-version": "2023-06-01", "x-api-key": tokenValue, Authorization: `Bearer ${tokenValue}` });
    record("the edge accepts the episode token on /v1/messages", accepted.status !== 401 && accepted.status !== 403 && accepted.status < 500, `HTTP ${accepted.status}`);
    const refused = await probe({ "anthropic-version": "2023-06-01", "x-api-key": "not-a-token", Authorization: "Bearer not-a-token" });
    record("the edge refuses a token that is not an episode token", refused.status === 401 || refused.status === 403, `HTTP ${refused.status}`);

    const mcp = (id, method, params, session) => postJson(`${edgeUrl}/mcp`, { ...(headerMap ?? {}), Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) }, { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const init = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "helm-conformance", version: "0" } });
    const session = init.headers.get("mcp-session-id") ?? undefined;
    const listed = await mcp(2, "tools/list", {}, session);
    const names = (listed.json?.result?.tools ?? []).map((t) => t.name);
    record("the HELM MCP endpoint accepts the headers and lists helm_attempt_get", init.status === 200 && listed.status === 200 && names.includes("helm_attempt_get"), `initialize ${init.status}, tools/list ${listed.status}, ${names.length} tools`);

    // ---- the governed write flow: read, push, draft pull request awaiting approval, read back ----
    const target = options.target ?? (options.fake ? "github.com/Mindburn-Labs/helm-qa-sandbox" : undefined);
    const branchPrefix = options.branchPrefix ?? (options.fake ? "helm/" : undefined);
    if (!options.fake && !options.governedFlow) {
      record("governed write flow", "skip", "pass --governed-flow --target github.com/<owner>/<repo> --branch-prefix helm/<seat>/");
    } else if (!target || !branchPrefix) {
      record("governed write flow", "skip", "needs --target and --branch-prefix");
    } else {
      const { runGovernedFlow } = await import(resolve(CORE, "dist", "testing", "governed-flow.js"));
      const steps = await runGovernedFlow({
        edgeUrl,
        headers: headerMap ?? {},
        target,
        branchPrefix,
        waitForApprovalMs: (options.waitApprovalSeconds ?? (fake ? 10 : 0)) * 1000,
        onEscalated: (attemptId) => {
          if (fake) setTimeout(() => fake.gateway.approve(attemptId), 200);
          else options.log?.(`     approve attempt ${attemptId} in the Console\n`);
        },
      });
      for (const step of steps) record(`governed flow: ${step.name}`, step.status === "SKIP" ? "skip" : step.status === "PASS", step.detail);
    }

    // ---- observation ----
    const hook = (event, extra) => JSON.stringify({ session_id: "conformance-session", hook_event_name: event, cwd: tmp, tool_name: "Bash", tool_input: { command: "printf observe-probe" }, tool_use_id: "toolu_probe", ...extra });
    const pre = await cli(["observe", "--client", "claude-code", "--event", "PreToolUse"], { input: hook("PreToolUse") });
    const post = await cli(["observe", "--client", "claude-code", "--event", "PostToolUse"], { input: hook("PostToolUse", { tool_response: { stdout: "observe-probe" }, duration_ms: 3 }) });
    record("observe exits 0 and prints nothing", pre.code === 0 && post.code === 0 && pre.stdout === "" && post.stdout === "", `${pre.stderr.trim()}${post.stderr.trim()}`);
    const status1 = JSON.parse((await cli(["status", "--json"])).stdout);
    record("status shows the observations were delivered", status1.observe.last_ok_at !== null && status1.observe.last_error === null, JSON.stringify(status1.observe));
    if (fake) {
      const bodies = fake.observations.map((b) => `${b.event}:${b.tool?.phase}`);
      record("the control plane recorded observed-only observations for the episode", fake.observations.length === 2 && fake.observations.every((b) => b.coverage === "observed-only" && b.episode_id === episode.episode_id), bodies.join(","));
    } else {
      record("the control plane recorded the observations", "skip", "not readable from the client; status above is the evidence");
    }

    // ---- rendered session profile ----
    const out = join(tmp, "session");
    const files = writeSession({ out, edgeUrl, cpUrl, orgId: org, helmExecutor: wrapper });
    const settings = JSON.parse(readFileSync(files.settings, "utf8"));
    const mcpConfig = JSON.parse(readFileSync(files.mcp, "utf8"));
    const helper = await run("/bin/sh", ["-c", settings.apiKeyHelper], { env: baseEnv });
    record("the rendered apiKeyHelper prints a token", helper.code === 0 && /^[^\s]+\n$/.test(helper.stdout), `exit ${helper.code}`);
    const mcpHelper = await run("/bin/sh", ["-c", mcpConfig.mcpServers.helm.headersHelper], { env: baseEnv });
    let helperHeaders = null;
    try {
      helperHeaders = JSON.parse(mcpHelper.stdout);
    } catch {
      helperHeaders = null;
    }
    record("the rendered headersHelper prints a header map", mcpHelper.code === 0 && typeof helperHeaders?.Authorization === "string", `exit ${mcpHelper.code}`);
    const deny = settings.permissions.deny;
    const missing = REQUIRED_DENY.filter((r) => !deny.includes(r));
    const sample = [["Bash", { command: "git push origin x" }], ["Bash", { command: "gh pr merge 1" }], ["Bash", { command: "kubectl get pods" }], ["Bash", { command: "flux get all" }], ["WebSearch", {}], ["WebFetch", {}], ["mcp__linear__save_issue", {}]];
    const slipped = sample.filter(([tool, input]) => !firstDenyMatch(deny, tool, input)).map(([tool]) => tool);
    record("the deny rules cover raw push, merge, kubectl, flux, web tools and Linear writes", missing.length === 0 && slipped.length === 0, [...missing, ...slipped].join(", "));

    // ---- the real Claude Code ----
    if (!options.claude) {
      record("Claude Code drives the session profile", "skip", "pass --claude to run the installed claude binary");
    } else {
      await claudeSession({ options, fake, scripted, files, tmp, home, slot, baseEnv, record, edgeUrl });
    }

    // ---- stop ----
    const stop = await cli(["stop"]);
    const after = await cli(["token"]);
    record("stop ends the episode; token then fails closed with nothing on stdout", stop.code === 0 && after.code === 4 && after.stdout === "" && /^helm-executor: no_episode: /.test(after.stderr), `stop ${stop.code}, token ${after.code}`);
    return finish();
  } finally {
    if (fake) await fake.close();
    if (!options.keep) rmSync(tmp, { recursive: true, force: true });
  }

  function finish() {
    return { ok: checks.every((c) => c.status !== "FAIL"), checks };
  }
}

async function claudeSession({ options, fake, scripted, files, tmp, home, slot, baseEnv, record, edgeUrl }) {
  const claude = options.claudeBin ?? "claude";
  const version = spawnSync(claude, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) return record("Claude Code drives the session profile", false, `${claude} did not run`);
  const installed = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? "unknown";
  const cwd = join(tmp, "workdir");
  mkdirSync(cwd, { recursive: true });
  const env = {
    PATH: baseEnv.PATH,
    HOME: tmp,
    CLAUDE_CONFIG_DIR: join(tmp, "claude-config"),
    HELM_EXECUTOR_HOME: home,
    HELM_EXECUTOR_SLOT: slot,
    // Ambient credentials the managed env block must neutralize: they outrank apiKeyHelper in Claude Code's order.
    ANTHROPIC_API_KEY: AMBIENT_KEY,
    ANTHROPIC_AUTH_TOKEN: AMBIENT_BEARER,
    TERM: "dumb",
  };
  const rejectedBefore = scripted?.seen.rejected ?? 0;
  const prompt = fake ? "Run the two commands you want." : "Reply with one word: connected";
  const args = ["-p", prompt, "--settings", files.settings, "--mcp-config", files.mcp, "--strict-mcp-config", "--output-format", "json", ...(fake ? ["--permission-mode", "bypassPermissions"] : []), ...(options.model ? ["--model", options.model] : [])];
  const result = await run(claude, args, { env, cwd, timeoutMs: 120_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  record(`claude ${installed} -p completes through the session profile`, result.code === 0 && parsed && parsed.is_error !== true, `exit ${result.code}${parsed?.result ? `, "${String(parsed.result).slice(0, 40)}"` : ` ${result.stderr.trim().slice(0, 160)}`}`);
  if (installed !== "unknown") {
    const [a, b, c] = installed.split(".").map(Number);
    const [x, y, z] = MIN_CLAUDE_VERSION.split(".").map(Number);
    const meets = a > x || (a === x && (b > y || (b === y && c >= z)));
    record(`claude ${installed} against the managed-profile floor ${MIN_CLAUDE_VERSION}`, meets ? true : "skip", meets ? "" : "below the floor: the session profile does not need it, the managed profile does");
  }
  if (!fake) return;

  const seen = scripted.seen;
  if (process.env.HELM_CONFORMANCE_DEBUG === "1") process.stderr.write(`${JSON.stringify(seen.log, null, 1)}\n${JSON.stringify(result, null, 1).slice(0, 1500)}\n`);
  const tokens = new Set(seen.messages.map((m) => m.token));
  record("the edge saw only helm-executor's token, in both headers, and never the ambient keys", seen.messages.length > 0 && tokens.size >= 1 && seen.messages.every((m) => m.token === m.key && m.token !== AMBIENT_KEY && m.token !== AMBIENT_BEARER) && seen.rejected === rejectedBefore, `${seen.messages.length} requests, ${seen.rejected - rejectedBefore} rejected during the session`);
  const first = seen.messages.find((m) => m.request.tools?.some((t) => t?.name === "Bash"));
  const toolNames = (first?.request.tools ?? []).map((t) => t?.name);
  record("WebSearch and WebFetch are not offered to the model", toolNames.length > 0 && !toolNames.includes("WebSearch") && !toolNames.includes("WebFetch"), toolNames.slice(0, 12).join(","));
  const final = seen.messages.find((m) => toolResultsSinceLastAssistant(m.request.messages ?? []).length > 0);
  const results = new Map(toolResultsSinceLastAssistant(final?.request.messages ?? []).map((b) => [b.tool_use_id, b]));
  const textOf = (b) => (typeof b?.content === "string" ? b.content : JSON.stringify(b?.content ?? ""));
  const denied = results.get(scripted.SCRIPT_TOOLS[0].id);
  const allowed = results.get(scripted.SCRIPT_TOOLS[1].id);
  record("the raw git push was denied by the deny rule", denied?.is_error === true && /permission|denied|deny/i.test(textOf(denied)), textOf(denied).slice(0, 100));
  const denials = (parsed?.permission_denials ?? []).map((d) => d.tool_use_id);
  record("Claude Code itself reports the raw git push as a permission denial, and only that one", denials.includes(scripted.SCRIPT_TOOLS[0].id) && !denials.includes(scripted.SCRIPT_TOOLS[1].id), denials.join(",") || "none");
  record("an allowed command still ran", allowed?.is_error !== true && textOf(allowed).includes("conformance-ok"), textOf(allowed).slice(0, 100));
  await sleep(600);
  const observed = fake.observations.map((o) => `${o.event}:${o.tool?.name ?? ""}:${o.tool?.input_summary ?? ""}`);
  // The summary is the command's shape (programs and action words), so the probe above is `printf` and these are not.
  const wanted = ["SessionStart::", "PreToolUse:Bash:git push origin", "PreToolUse:Bash:echo"];
  const lostAtTeardown = observed.includes("PostToolUse:Bash:echo") ? "" : "; the echo's PostToolUse did not arrive (claude -p stops async hooks at exit)";
  record("the hooks reported the session start, the denied attempt and the allowed command as observed-only", wanted.every((w) => observed.includes(w)) && fake.observations.every((o) => o.coverage === "observed-only"), `${observed.filter((o) => !o.endsWith(":printf")).join(" | ").slice(0, 260)}${lostAtTeardown}`);
  const mcpRequests = fake.requests.filter((r) => r.path === "/mcp");
  record("Claude Code connected to the HELM MCP server with the headersHelper token", mcpRequests.length > 0 && mcpRequests.every((r) => String(r.headers.authorization ?? "").startsWith("Bearer ")) && mcpRequests.some((r) => r.body?.method === "tools/list"), `${mcpRequests.length} MCP requests`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "cp-url": { type: "string" },
      "edge-url": { type: "string" },
      org: { type: "string" },
      "work-item": { type: "string" },
      claude: { type: "boolean" },
      "claude-bin": { type: "string" },
      "governed-flow": { type: "boolean" },
      target: { type: "string" },
      "branch-prefix": { type: "string" },
      "wait-approval": { type: "string" },
      model: { type: "string" },
      login: { type: "boolean" },
      report: { type: "string" },
      keep: { type: "boolean" },
    },
  });
  const live = Boolean(values["cp-url"] || values["edge-url"]);
  const result = await runConformance({
    fake: !live,
    cpUrl: values["cp-url"],
    edgeUrl: values["edge-url"],
    org: values.org,
    workItem: values["work-item"],
    claude: values.claude,
    claudeBin: values["claude-bin"],
    governedFlow: values["governed-flow"],
    target: values.target,
    branchPrefix: values["branch-prefix"],
    waitApprovalSeconds: values["wait-approval"] === undefined ? undefined : Number(values["wait-approval"]),
    model: values.model,
    login: values.login,
    keep: values.keep,
    log: (line) => process.stdout.write(line),
  });
  if (values.report) {
    writeFileSync(values.report, `${JSON.stringify({ schema: "helm.executor.conformance/v1", adapter: "claude-code", mode: live ? "live" : "fake", ran_at: new Date().toISOString(), ok: result.ok, checks: result.checks }, null, 2)}\n`);
  }
  const failed = result.checks.filter((c) => c.status === "FAIL").length;
  process.stdout.write(`\n${result.checks.length} checks, ${failed} failed\n`);
  process.exit(result.ok ? 0 : 1);
}
