import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, main, parseVersion } from "../src/install.mjs";

const CORE = fileURLToPath(new URL("../../core", import.meta.url));
const mode = (p) => statSync(p).mode & 0o777;

function fixture() {
  assert.ok(existsSync(join(CORE, "dist", "cli.js")), "build executors/core first: npm run build");
  const root = mkdtempSync(join(tmpdir(), "helm-install-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}\n');
  const claude = join(root, "claude");
  const stubClaude = (version) => {
    writeFileSync(claude, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(claude, 0o755);
  };
  stubClaude("2.1.290");
  const prefix = join(root, "prefix");
  const managed = join(root, "managed");
  const args = (extra = []) => ["managed", "--edge-url", "https://executor.helm.example", "--cp-url", "https://cp.helm.example", "--org", "org-1", "--prefix", prefix, "--managed-dir", managed, "--claude", claude, ...extra];
  return { root, home, claude, stubClaude, prefix, managed, args, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function run(argv) {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map((p) => `${p}:${statSync(join(dir, p)).isDirectory() ? "d" : readFileSync(join(dir, p), "utf8").length}`);
}

test("versions parse and compare", () => {
  assert.deepEqual(parseVersion("2.1.274 (Claude Code)"), [2, 1, 274]);
  assert.equal(parseVersion("nope"), null);
  assert.ok(compareVersions([2, 1, 274], [2, 1, 285]) < 0);
  assert.ok(compareVersions([2, 2, 0], [2, 1, 999]) > 0);
  assert.equal(compareVersions([2, 1, 285], [2, 1, 285]), 0);
});

test("without --yes managed prints the plan and writes nothing", async () => {
  const f = fixture();
  try {
    const r = await run(f.args());
    assert.equal(r.code, 0);
    assert.match(r.out, /machine-wide Claude Code policy/);
    assert.match(r.out, /50-helm-executor\.json/);
    assert.match(r.out, /Nothing was written/);
    assert.equal(existsSync(f.prefix), false);
    assert.equal(existsSync(f.managed), false);
  } finally {
    f.cleanup();
  }
});

test("managed --yes installs the CLI, the drop-in and the MCP file, then proves they work", async () => {
  const f = fixture();
  try {
    const r = await run(f.args(["--yes"]));
    assert.equal(r.code, 0, r.err + r.out);
    const bin = join(f.prefix, "bin", "helm-executor");
    const dropIn = join(f.managed, "managed-settings.d", "50-helm-executor.json");
    const mcp = join(f.managed, "managed-mcp.json");
    assert.equal(mode(bin), 0o755);
    assert.equal(mode(dropIn), 0o644);
    assert.equal(mode(mcp), 0o644);
    assert.equal(existsSync(join(f.managed, "managed-settings.d", "60-helm-executor-otel.json")), false);
    const settings = JSON.parse(readFileSync(dropIn, "utf8"));
    assert.equal(settings.apiKeyHelper, `${bin} token`);
    assert.equal(settings.env.HELM_EXECUTOR_ORG, "org-1");
    assert.equal(JSON.parse(readFileSync(mcp, "utf8")).mcpServers.helm.headersHelper, `${bin} headers`);
    assert.match(r.out, /ok {3}helm-executor --version runs/);
    assert.match(r.out, /ok {3}apiKeyHelper fails closed with nothing on stdout/);
    assert.match(r.out, /ok {3}headersHelper fails closed/);
    assert.match(r.out, /ok {3}the observe hook exits 0 and prints nothing/);
    assert.ok(!/FAIL/.test(r.out));
    const installedDist = readdirSync(join(f.prefix, "lib", "helm-executor", "dist"), { recursive: true, encoding: "utf8" });
    assert.ok(installedDist.includes("cli.js"));
    assert.ok(!installedDist.some((p) => p.includes("test") || p.startsWith("testing")), "no tests or fake server on the executor host");
    const manifest = JSON.parse(readFileSync(join(f.prefix, "lib", "helm-executor", "install-manifest.json"), "utf8"));
    assert.equal(manifest.schema, "helm.executor.install/v1");
    assert.ok(manifest.files.some((e) => e.path === dropIn && /^[0-9a-f]{64}$/.test(e.sha256)));
    const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  } finally {
    f.cleanup();
  }
});

test("installing again changes nothing, and dropping the OTEL endpoint removes its drop-in", async () => {
  const f = fixture();
  try {
    assert.equal((await run(f.args(["--yes", "--otel-endpoint", "https://otel.helm.example"]))).code, 0);
    const otel = join(f.managed, "managed-settings.d", "60-helm-executor-otel.json");
    assert.equal(existsSync(otel), true);
    assert.equal(JSON.parse(readFileSync(otel, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.helm.example");
    assert.equal((await run(f.args(["--yes", "--otel-endpoint", "https://otel.helm.example"]))).code, 0);
    const before = snapshot(f.managed);
    assert.equal((await run(f.args(["--yes"]))).code, 0);
    assert.equal(existsSync(otel), false);
    assert.deepEqual(snapshot(f.managed), before.filter((e) => !e.startsWith("managed-settings.d/60-helm-executor-otel.json")));
  } finally {
    f.cleanup();
  }
});

test("a file this installer did not write is never overwritten without --force", async () => {
  const f = fixture();
  try {
    mkdirSync(f.managed, { recursive: true });
    writeFileSync(join(f.managed, "managed-mcp.json"), '{"mcpServers":{"other":{"type":"http","url":"https://x.example"}}}\n');
    const refused = await run(f.args(["--yes"]));
    assert.equal(refused.code, 1);
    assert.match(refused.err, /managed-mcp\.json exists and this installer did not write it/);
    assert.equal(existsSync(f.prefix), false, "nothing was installed");
    assert.match(readFileSync(join(f.managed, "managed-mcp.json"), "utf8"), /other/);
    const forced = await run(f.args(["--yes", "--force"]));
    assert.equal(forced.code, 0, forced.err);
    assert.match(readFileSync(join(f.managed, "managed-mcp.json"), "utf8"), /helm/);
  } finally {
    f.cleanup();
  }
});

test("a Claude Code older than the floor is refused unless the check is skipped", async () => {
  const f = fixture();
  try {
    f.stubClaude("2.1.274");
    const refused = await run(f.args(["--yes"]));
    assert.equal(refused.code, 1);
    assert.match(refused.err, /claude 2\.1\.274 is older than 2\.1\.285/);
    assert.equal(existsSync(f.managed), false);
    assert.equal((await run(f.args(["--yes", "--skip-version-check"]))).code, 0);
  } finally {
    f.cleanup();
  }
});

test("a missing claude binary is a warning, not a failure", async () => {
  const f = fixture();
  try {
    const r = await run(f.args(["--claude", join(f.root, "no-such-claude")]));
    assert.equal(r.code, 0);
    assert.match(r.err, /warning: claude was not found/);
  } finally {
    f.cleanup();
  }
});

test("a directory the user cannot write is a clear error that names sudo", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write anywhere");
  const f = fixture();
  try {
    mkdirSync(f.managed, { recursive: true });
    chmodSync(f.managed, 0o555);
    const r = await run(f.args(["--yes"]));
    assert.equal(r.code, 1);
    assert.match(r.err, /not writable by this user; run the installer with sudo/);
    assert.equal(existsSync(f.prefix), false);
  } finally {
    chmodSync(f.managed, 0o755);
    f.cleanup();
  }
});

test("bad inputs fail before anything is written", async () => {
  const f = fixture();
  try {
    for (const extra of [["--edge-url", "http://executor.helm.example"], ["--org", "bad org"], ["--cp-url", "https://u:p@cp.helm.example"]]) {
      const r = await run([...f.args(["--yes"]), ...extra]);
      assert.equal(r.code, 1, extra.join(" "));
    }
    assert.equal(existsSync(f.prefix) || existsSync(f.managed), false);
    assert.equal((await run(["managed", "--bogus"])).code, 1);
    assert.equal((await run(["nope"])).code, 2);
    assert.equal((await run([])).code, 2);
    assert.equal((await run(["--help"])).code, 0);
  } finally {
    f.cleanup();
  }
});

test("uninstall removes what was installed, keeps what changed, and leaves the directories it does not own", async () => {
  const f = fixture();
  try {
    assert.equal((await run(f.args(["--yes"]))).code, 0);
    const foreign = join(f.managed, "managed-settings.d", "10-other-team.json");
    writeFileSync(foreign, "{}\n");
    const dropIn = join(f.managed, "managed-settings.d", "50-helm-executor.json");
    writeFileSync(dropIn, `${readFileSync(dropIn, "utf8")}\n`);
    const kept = await run(["uninstall", "--prefix", f.prefix]);
    assert.equal(kept.code, 1);
    assert.match(kept.err, /kept .*50-helm-executor\.json: it changed/);
    assert.equal(existsSync(dropIn), true);
    assert.equal(existsSync(join(f.prefix, "bin", "helm-executor")), false);
    const forced = await run(["uninstall", "--prefix", f.prefix, "--force"]);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(existsSync(dropIn), false);
    assert.equal(readFileSync(foreign, "utf8"), "{}\n");
    assert.equal(existsSync(f.managed), true);
    assert.equal(existsSync(join(f.prefix, "lib", "helm-executor")), false);
    assert.equal(existsSync(f.prefix), true);
    assert.equal((await run(["uninstall", "--prefix", f.prefix])).code, 1, "nothing left to remove");
  } finally {
    f.cleanup();
  }
});

test("no command touches the user's own Claude Code settings, except owner-otel --yes", async () => {
  const f = fixture();
  const saved = { HOME: process.env.HOME, HELM_EXECUTOR_HOME: process.env.HELM_EXECUTOR_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = f.home;
  process.env.HELM_EXECUTOR_HOME = join(f.home, ".config", "helm-executor");
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const before = snapshot(f.home);
    await run(f.args());
    await run(f.args(["--yes"]));
    await run(["session", "--out", join(f.root, "session"), "--edge-url", "http://127.0.0.1:1", "--cp-url", "http://127.0.0.1:2", "--org", "o", "--helm-executor", join(f.prefix, "bin", "helm-executor")]);
    await run(["owner-otel", "--otel-endpoint", "https://otel.helm.example"]);
    await run(["uninstall", "--prefix", f.prefix]);
    assert.deepEqual(snapshot(f.home), before);
    assert.equal(readFileSync(join(f.home, ".claude", "settings.json"), "utf8"), '{"model":"opus"}\n');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    f.cleanup();
  }
});

test("session writes a settings file and an MCP config into --out and nowhere else", async () => {
  const f = fixture();
  try {
    const out = join(f.root, "session-profile");
    const bin = join(f.root, "wrapper");
    const r = await run(["session", "--out", out, "--edge-url", "http://127.0.0.1:8123", "--cp-url", "http://127.0.0.1:8124", "--org", "org-1", "--helm-executor", bin]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readdirSync(out).sort(), ["mcp.json", "settings.json"]);
    assert.equal(mode(out), 0o700);
    assert.equal(mode(join(out, "settings.json")), 0o600);
    const settings = JSON.parse(readFileSync(join(out, "settings.json"), "utf8"));
    assert.equal(settings.allowedProviders, undefined);
    assert.equal(settings.apiKeyHelper, `${bin} token`);
    assert.match(r.out, /claude --settings .*settings\.json --mcp-config .*mcp\.json --strict-mcp-config/);
    assert.equal(existsSync(f.prefix) || existsSync(f.managed), false);
    assert.equal((await run(["session", "--edge-url", "http://127.0.0.1:1"])).code, 1, "--out is required");
  } finally {
    f.cleanup();
  }
});

test("owner-otel is opt-in, adds only telemetry env, backs up the file, and can be undone", async () => {
  const f = fixture();
  const saved = process.env.HELM_EXECUTOR_HOME;
  process.env.HELM_EXECUTOR_HOME = join(f.root, "executor-home");
  try {
    const file = join(f.root, "user-settings.json");
    const original = '{\n  "model": "opus",\n  "env": { "FOO": "bar" },\n  "permissions": { "allow": ["Bash(ls *)"] }\n}\n';
    writeFileSync(file, original);
    chmodSync(file, 0o640);
    const args = ["owner-otel", "--otel-endpoint", "https://otel.helm.example", "--settings-file", file];

    const dry = await run(args);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /Nothing was written/);
    assert.equal(readFileSync(file, "utf8"), original);

    const applied = await run([...args, "--yes"]);
    assert.equal(applied.code, 0, applied.err);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.model, "opus");
    assert.deepEqual(after.permissions, { allow: ["Bash(ls *)"] });
    assert.equal(after.env.FOO, "bar");
    assert.equal(after.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
    assert.equal(after.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.helm.example");
    assert.equal("ANTHROPIC_BASE_URL" in after.env, false);
    assert.equal("hooks" in after, false);
    assert.equal(mode(file), 0o640, "the file's own mode is kept");
    const backups = readdirSync(f.root).filter((p) => p.startsWith("user-settings.json.helm-executor."));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(f.root, backups[0]), "utf8"), original);

    const removed = await run(["owner-otel", "--remove", "--settings-file", file]);
    assert.equal(removed.code, 0, removed.err);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "opus", env: { FOO: "bar" }, permissions: { allow: ["Bash(ls *)"] } });
    assert.equal((await run(["owner-otel", "--remove", "--settings-file", file])).code, 1, "nothing left to remove");
  } finally {
    if (saved === undefined) delete process.env.HELM_EXECUTOR_HOME;
    else process.env.HELM_EXECUTOR_HOME = saved;
    f.cleanup();
  }
});

test("owner-otel refuses to overwrite a value, to edit a file that is not JSON, and to send telemetry in clear", async () => {
  const f = fixture();
  const saved = process.env.HELM_EXECUTOR_HOME;
  process.env.HELM_EXECUTOR_HOME = join(f.root, "executor-home");
  try {
    const file = join(f.root, "s.json");
    const args = ["owner-otel", "--otel-endpoint", "https://otel.helm.example", "--settings-file", file, "--yes"];
    writeFileSync(file, '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://elsewhere.example"}}\n');
    const conflict = await run(args);
    assert.equal(conflict.code, 1);
    assert.match(conflict.err, /already sets OTEL_EXPORTER_OTLP_ENDPOINT/);
    assert.match(readFileSync(file, "utf8"), /elsewhere/);

    writeFileSync(file, "{ not json");
    assert.equal((await run(args)).code, 1);
    assert.equal(readFileSync(file, "utf8"), "{ not json");

    writeFileSync(file, "[]");
    assert.equal((await run(args)).code, 1);

    assert.equal((await run(["owner-otel", "--otel-endpoint", "http://otel.helm.example", "--settings-file", file, "--yes"])).code, 1);

    rmSync(file);
    assert.equal((await run(args)).code, 0, "a missing file is created");
    assert.equal(mode(file), 0o600);
  } finally {
    if (saved === undefined) delete process.env.HELM_EXECUTOR_HOME;
    else process.env.HELM_EXECUTOR_HOME = saved;
    f.cleanup();
  }
});
