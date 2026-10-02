// Black-box tests: the real executable, a fake control plane, and only what a client would see.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startFakeCp, type FakeCp } from "./testing/fake-cp.js";
import { schemaValidator, tempDir } from "./test-utils.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const validObservation = schemaValidator("observation.schema.json");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, input = ""): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

let fake: FakeCp;
let tmp: ReturnType<typeof tempDir>;
let n = 0;

before(async () => {
  fake = await startFakeCp();
  tmp = tempDir();
});
after(async () => {
  await fake.close();
  tmp.cleanup();
});

function envFor(name: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HELM_EXECUTOR_HOME: join(tmp.dir, name), HELM_EXECUTOR_CP_URL: fake.url, HELM_EXECUTOR_ORG: fake.orgId, HELM_EXECUTOR_TEST_POLL_MS: "20", ...extra };
}

// The control plane allows one live episode per work item, so every ready() session gets its own.
async function ready(name: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env = envFor(`${name}-${++n}`, extra);
  assert.equal((await run(["login"], env)).code, 0);
  assert.equal((await run(["checkout", `work-${n}`, "--client", "claude-code"], env)).code, 0);
  return env;
}

// A session whose control plane then goes away. The credential belongs to the control plane that issued it, so "down"
// has to be that very one.
async function readyThenDown(name: string): Promise<Record<string, string>> {
  const own = await startFakeCp();
  const env = envFor(`${name}-${++n}`, { HELM_EXECUTOR_CP_URL: own.url, HELM_EXECUTOR_ORG: own.orgId });
  assert.equal((await run(["login"], env)).code, 0);
  assert.equal((await run(["checkout", `work-${n}`, "--client", "claude-code"], env)).code, 0);
  await own.close();
  return env;
}

function ageToken(env: Record<string, string>, slot = "default"): void {
  const file = join(env.HELM_EXECUTOR_HOME ?? "", "slots", `${slot}.json`);
  const state = JSON.parse(readFileSync(file, "utf8")) as { token: { minted_at: string } };
  state.token.minted_at = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(file, JSON.stringify(state));
}

const claudeHook = JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", cwd: "/w", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "toolu_1", tool_response: { stdout: "RESPONSE-MARKER" } });

test("login, checkout, token, headers, observe, status, env and stop through the executable", async () => {
  const env = envFor("e2e");
  const login = await run(["login"], env);
  assert.equal(login.code, 0);
  assert.equal(login.stdout, "", "login prints human text to stderr only");
  assert.match(login.stderr, /approve the code ABCD-2345/);

  const checkout = await run(["checkout", "HELM-910", "--client", "claude-code", "--json"], env);
  assert.equal(checkout.code, 0);
  const co = JSON.parse(checkout.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(co).sort(), ["client", "deadline", "episode_id", "reused", "schema", "slot", "work_item_id"]);
  assert.equal(co.schema, "helm.executor.checkout/v1");
  assert.equal(co.reused, false);
  assert.equal(checkout.stderr, "");

  const token = await run(["token"], env);
  assert.equal(token.code, 0);
  assert.match(token.stdout, /^[A-Za-z0-9_.-]+\n$/, "the token and one LF, nothing else");
  assert.equal(token.stderr, "");
  const headers = await run(["headers"], env);
  assert.equal(headers.code, 0);
  assert.equal(headers.stdout, `${JSON.stringify({ Authorization: `Bearer ${token.stdout.trim()}` })}\n`);
  assert.ok(fake.episodeForToken(`Bearer ${token.stdout.trim()}`));

  const observe = await run(["observe", "--client", "claude-code", "--event", "PostToolUse"], env, claudeHook);
  assert.equal(observe.code, 0);
  assert.equal(observe.stdout, "");
  assert.equal(fake.observations.length > 0, true);
  assert.equal(validObservation(fake.observations.at(-1)), null);
  assert.ok(!JSON.stringify(fake.observations.at(-1)).includes("RESPONSE-MARKER"));

  const status = JSON.parse((await run(["status", "--json"], env)).stdout) as { logged_in: boolean; episode: { work_item_id: string; seconds_left: number }; observe: { last_ok_at: string | null } };
  assert.equal(status.logged_in, true);
  assert.equal(status.episode.work_item_id, "HELM-910");
  assert.ok(status.episode.seconds_left > 3_000);
  assert.ok(status.observe.last_ok_at);

  const otel = await run(["env", "--format", "shell"], env);
  assert.match(otel.stdout, /^export OTEL_RESOURCE_ATTRIBUTES='helm\.work_item_id=HELM-910,helm\.episode_id=[0-9a-f-]+,helm\.executor=claude-code'\n$/);
  assert.equal(JSON.parse((await run(["env", "--format", "json"], env)).stdout).OTEL_RESOURCE_ATTRIBUTES.startsWith("helm.work_item_id=HELM-910"), true);

  const stop = await run(["stop"], env);
  assert.equal(stop.code, 0);
  assert.equal(stop.stdout, "");
  const after = await run(["token"], env);
  assert.equal(after.code, 4);
  assert.equal(after.stdout, "");
  assert.match(after.stderr, /^helm-executor: no_episode: .+\n$/);
});

test("every failure prints exactly one stderr line, nothing on stdout, and its documented exit code", async () => {
  const cases: { name: string; code: number; line: RegExp; go: () => Promise<Run> }[] = [
    { name: "unknown command", code: 2, line: /^helm-executor: usage: /, go: () => run(["bogus"], envFor(`f${++n}`)) },
    { name: "missing argument", code: 2, line: /^helm-executor: usage: /, go: () => run(["checkout", "--client", "claude-code"], envFor(`f${++n}`)) },
    { name: "bad --wait", code: 2, line: /^helm-executor: usage: --wait must be a whole number of seconds from 0 to 1200/, go: () => run(["checkout", "HELM-910", "--client", "codex", "--wait", "5000"], envFor(`f${++n}`)) },
    { name: "missing client", code: 2, line: /^helm-executor: usage: --client is required/, go: () => run(["checkout", "HELM-910"], envFor(`f${++n}`)) },
    { name: "not logged in", code: 3, line: /^helm-executor: not_logged_in: /, go: () => run(["checkout", "HELM-910", "--client", "claude-code"], envFor(`f${++n}`)) },
    { name: "no episode", code: 4, line: /^helm-executor: no_episode: /, go: () => run(["token"], envFor(`f${++n}`)) },
    {
      name: "control plane unreachable",
      code: 6,
      line: /^helm-executor: unavailable: /,
      go: async () => {
        // The credential belongs to the control plane it was issued by, so the one that goes away is the one logged in to.
        const gone = await startFakeCp();
        const env = envFor(`f${++n}`, { HELM_EXECUTOR_CP_URL: gone.url, HELM_EXECUTOR_ORG: gone.orgId });
        await run(["login"], env);
        await gone.close();
        return run(["checkout", "HELM-910", "--client", "claude-code"], env);
      },
    },
    {
      name: "rejected by the control plane",
      code: 7,
      line: /^helm-executor: rejected: /,
      go: async () => {
        const env = envFor(`f${++n}`);
        await run(["login"], env);
        fake.fail("/executor-episodes", 403, 1);
        return run(["checkout", "HELM-910", "--client", "claude-code"], env);
      },
    },
    {
      name: "episode ended",
      code: 5,
      line: /^helm-executor: episode_ended: /,
      go: async () => {
        const env = await ready("ended");
        for (const episode of fake.episodes.values()) episode.stopped = true;
        ageToken(env);
        return run(["token"], env);
      },
    },
  ];
  for (const c of cases) {
    const result = await c.go();
    assert.equal(result.code, c.code, c.name);
    assert.equal(result.stdout, "", `${c.name}: stdout`);
    assert.match(result.stderr, c.line, c.name);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1, `${c.name}: one line`);
    assert.ok(result.stderr.length < 260, c.name);
  }
});

test("observe exits 0 and writes nothing to stdout whatever it is given", async () => {
  const env = await ready("observe");
  const inputs: [string[], string][] = [
    [["observe", "--client", "claude-code", "--event", "PreToolUse"], ""],
    [["observe", "--client", "claude-code", "--event", "PreToolUse"], "garbage {"],
    [["observe", "--client", "claude-code", "--event", "Stop"], claudeHook],
    [["observe", "--client", "vim", "--event", "PreToolUse"], claudeHook],
    [["observe", "--bogus"], claudeHook],
    [["observe"], claudeHook],
    [["observe", "--client", "codex", "--event", "PreToolUse", "extra"], claudeHook],
  ];
  for (const [args, input] of inputs) {
    const r = await run(args, env, input);
    assert.equal(r.code, 0, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
  }
  const noState = await run(["observe", "--client", "claude-code", "--event", "PostToolUse"], envFor(`none-${++n}`), claudeHook);
  assert.equal(noState.code, 0);
  assert.equal(noState.stdout, "");
  assert.equal(noState.stderr, "", "no episode: silent");
  const down = await run(["observe", "--client", "claude-code", "--event", "PostToolUse"], await readyThenDown("observe-down"), claudeHook);
  assert.equal(down.code, 0);
  assert.match(down.stderr, /^helm-executor: unavailable: /);
});

test("no command prints a credential except token and headers", async () => {
  const env = await ready("secrets");
  const down = await readyThenDown("secrets-down");
  const secrets = new Set<string>();
  const home = env.HELM_EXECUTOR_HOME ?? "";
  const creds = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as { access_token: string; refresh_token: string };
  const slot = JSON.parse(readFileSync(join(home, "slots", "default.json"), "utf8")) as { token: { value: string } };
  const downHome = down.HELM_EXECUTOR_HOME ?? "";
  const downCreds = JSON.parse(readFileSync(join(downHome, "credentials.json"), "utf8")) as { access_token: string; refresh_token: string };
  const downSlot = JSON.parse(readFileSync(join(downHome, "slots", "default.json"), "utf8")) as { token: { value: string } };
  for (const s of [creds.access_token, creds.refresh_token, slot.token.value, downCreds.access_token, downCreds.refresh_token, downSlot.token.value]) secrets.add(s);
  const outputs: Run[] = [
    await run(["status"], env),
    await run(["status", "--json"], env),
    await run(["env"], env),
    await run(["checkout", "HELM-910", "--client", "claude-code"], env),
    await run(["observe", "--client", "claude-code", "--event", "PostToolUse"], env, claudeHook),
    await run(["observe", "--client", "claude-code", "--event", "PostToolUse"], { ...down, HELM_EXECUTOR_DEBUG: "1" }, claudeHook),
    await run(["checkout", "HELM-911", "--client", "claude-code"], env),
    await run(["bogus"], env),
    await run(["--help"], env),
  ];
  for (const out of outputs) for (const s of secrets) assert.ok(!out.stdout.includes(s) && !out.stderr.includes(s), "a credential was printed");
  const token = await run(["token"], env);
  assert.equal(token.stdout, `${slot.token.value}\n`, "token prints the one just minted by checkout");
  assert.equal(token.stderr, "");
});

test("state directories are 0700 and state files 0600", async () => {
  const env = await ready("modes");
  const home = env.HELM_EXECUTOR_HOME ?? "";
  const mode = (p: string): number => statSync(p).mode & 0o777;
  assert.equal(mode(home), 0o700);
  assert.equal(mode(join(home, "slots")), 0o700);
  assert.equal(mode(join(home, "credentials.json")), 0o600);
  assert.equal(mode(join(home, "slots", "default.json")), 0o600);
  assert.deepEqual(readdirSync(join(home, "slots")), ["default.json"], "no lock or temporary file is left behind");
});

test("HELM_EXECUTOR_SLOT keeps two sessions' episodes apart", async () => {
  const base = await ready("slots");
  const second = { ...base, HELM_EXECUTOR_SLOT: "codex-1" };
  assert.equal((await run(["checkout", "work-slot-b", "--client", "codex"], second)).code, 0);
  const a = (await run(["token"], base)).stdout.trim();
  const b = (await run(["token"], second)).stdout.trim();
  assert.notEqual(a, b);
  assert.equal(fake.episodeForToken(`Bearer ${a}`)?.workItemId.startsWith("work-"), true);
  assert.equal(fake.episodeForToken(`Bearer ${b}`)?.workItemId, "work-slot-b");
  assert.equal((await run(["stop"], second)).code, 0);
  assert.equal((await run(["token"], base)).code, 0);
  assert.equal((await run(["token"], second)).code, 4);
  assert.equal((await run(["status"], { ...base, HELM_EXECUTOR_SLOT: "Bad Slot" })).code, 2);
});

test("helpers that start at the same moment in separate processes share one mint", async () => {
  const env = await ready("parallel");
  ageToken(env);
  const before = fake.requests.filter((r) => r.path.endsWith("/token") && r.path.includes("executor-episodes")).length;
  const results = await Promise.all(Array.from({ length: 6 }, () => run(["token"], env)));
  for (const r of results) assert.equal(r.code, 0);
  assert.equal(new Set(results.map((r) => r.stdout)).size, 1);
  const after = fake.requests.filter((r) => r.path.endsWith("/token") && r.path.includes("executor-episodes")).length;
  assert.equal(after - before, 1);
});

test("--help and --version", async () => {
  const help = await run(["--help"], envFor("help"));
  assert.equal(help.code, 0);
  for (const command of ["login", "checkout", "token", "headers", "observe", "stop", "status", "env"]) assert.match(help.stdout, new RegExp(`\\n  ${command}\\b`));
  const version = await run(["--version"], envFor("version"));
  assert.equal(version.stdout, `${PACKAGE.version}\n`);
  assert.equal((await run([], envFor("none"))).code, 2);
});

test("observe gives up on a stdin that never ends, and exits 0 although its stderr reader is gone", async () => {
  const env = await ready("observe-io");

  // A producer that keeps the pipe open and never closes it: the hook must not hang.
  const held = await new Promise<{ code: number | null; stderr: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, "observe", "--client", "claude-code", "--event", "PreToolUse"], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
    child.stdin.write('{"session_id":"s"');
    const guard = setTimeout(() => child.kill("SIGKILL"), 8_000);
    child.on("close", () => clearTimeout(guard));
  });
  assert.equal(held.code, 0, `exit ${held.code} after ${held.ms} ms`);
  assert.ok(held.ms < 6_000, `took ${held.ms} ms`);
  assert.match(held.stderr, /^helm-executor: rejected: hook input was larger than 8 MiB or did not end within 3 s; skipped\n$/);
  const status = JSON.parse((await run(["status", "--json"], env)).stdout) as { observe: { last_error: string | null } };
  assert.match(status.observe.last_error ?? "", /did not end within 3 s/);

  // A reader that is gone: a failure line is written to a closed pipe, which must not turn into exit 1.
  const piped = await new Promise<string>((resolve, reject) => {
    const quoted = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
    const command = `${quoted(process.execPath)} ${quoted(CLI)} observe --client vim --event PreToolUse < /dev/null 2>&1 >/dev/null | true; echo "exit:\${PIPESTATUS[0]}"`;
    const child = spawn("bash", ["-c", command], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
  assert.match(piped, /exit:0\n$/, piped);
});
