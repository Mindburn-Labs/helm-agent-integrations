#!/usr/bin/env node
// Installer for the HELM Claude Code adapter.
//
//   managed    machine-wide: helm-executor, the managed-settings drop-in and managed-mcp.json (needs root)
//   session    renders a settings file and an MCP config for one session; writes nowhere else
//   owner-otel opt-in: adds telemetry env to the owner's own settings file
//   uninstall  removes what `managed` wrote
//
// Nothing is written without --yes; without it every command prints its plan and stops. No command touches a
// user's Claude Code settings except `owner-otel --yes`.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MIN_CLAUDE_VERSION, renderManaged, renderOwnerOtel, renderSession, shellQuote } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function defaultManagedDir(os = platform()) {
  return os === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
}

export function parseVersion(text) {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1, 4).map(Number) ?? null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Both are [major, minor, patch]. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function writeAtomic(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode, flag: "wx" });
  chmodSync(tmp, mode);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---- managed profile -------------------------------------------------------------------------------------

function programFiles(coreDir) {
  const dist = join(coreDir, "dist");
  if (!existsSync(join(dist, "cli.js"))) throw new Error(`${dist}/cli.js is missing; build executors/core first (npm run build)`);
  const out = [{ rel: "package.json", buf: readFileSync(join(coreDir, "package.json")) }];
  for (const rel of readdirSync(dist, { recursive: true, encoding: "utf8" }).sort()) {
    if (!rel.endsWith(".js") || rel.endsWith(".test.js") || rel === "test-utils.js" || rel.startsWith("testing")) continue;
    out.push({ rel: join("dist", rel), buf: readFileSync(join(dist, rel)) });
  }
  return out;
}

function wrapper(node, cli) {
  return `#!/bin/sh\n# Written by the HELM Claude Code adapter installer. Reinstall to change it.\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`;
}

export function planManaged(opts) {
  const prefix = resolve(opts.prefix ?? "/usr/local");
  const managedDir = resolve(opts.managedDir ?? defaultManagedDir());
  const libDir = join(prefix, "lib", "helm-executor");
  const bin = join(prefix, "bin", "helm-executor");
  const node = opts.node ?? process.execPath;
  const rendered = renderManaged({ edgeUrl: opts.edgeUrl, cpUrl: opts.cpUrl, orgId: opts.orgId, helmExecutor: bin, otelEndpoint: opts.otelEndpoint });
  const files = programFiles(resolve(opts.coreDir ?? join(here, "..", "..", "core"))).map((f) => ({ path: join(libDir, f.rel), mode: 0o644, content: f.buf }));
  files.push({ path: bin, mode: 0o755, content: wrapper(node, join(libDir, "dist", "cli.js")) });
  files.push({ path: join(managedDir, "managed-settings.d", "50-helm-executor.json"), mode: 0o644, content: json(rendered.settings) });
  files.push({ path: join(managedDir, "managed-mcp.json"), mode: 0o644, content: json(rendered.mcp) });
  if (rendered.otel) files.push({ path: join(managedDir, "managed-settings.d", "60-helm-executor-otel.json"), mode: 0o644, content: json(rendered.otel) });
  return { prefix, managedDir, libDir, bin, node, files, manifestPath: join(libDir, "install-manifest.json"), rendered };
}

/** Problems that stop an install. Warnings are returned separately. */
export function preflight(plan, opts = {}) {
  const problems = [];
  const warnings = [];
  const nodeVersion = spawnSync(plan.node, ["--version"], { encoding: "utf8" });
  const nodeParsed = nodeVersion.status === 0 ? parseVersion(nodeVersion.stdout) : null;
  if (!nodeParsed || nodeParsed[0] < 22) problems.push(`${plan.node} is not Node 22 or newer`);

  if (!opts.skipVersionCheck) {
    const claude = spawnSync(opts.claude ?? "claude", ["--version"], { encoding: "utf8" });
    const installed = claude.status === 0 ? parseVersion(claude.stdout) : null;
    if (!installed) warnings.push("claude was not found on PATH; requiredMinimumVersion will stop an older binary from starting");
    else if (compareVersions(installed, parseVersion(MIN_CLAUDE_VERSION)) < 0) {
      problems.push(`claude ${installed.join(".")} is older than ${MIN_CLAUDE_VERSION}, which allowedProviders needs; this policy would lock it out. Run \`claude update\` or pass --skip-version-check`);
    }
  }

  const old = readManifest(plan.manifestPath);
  const owned = new Map((old?.files ?? []).map((f) => [f.path, f.sha256]));
  for (const f of plan.files) {
    if (!existsSync(f.path)) continue;
    const current = sha256(readFileSync(f.path));
    if (current !== sha256(f.content) && owned.get(f.path) !== current) {
      problems.push(`${f.path} exists and this installer did not write it${opts.force ? " (overwriting: --force)" : "; pass --force to replace it"}`);
    }
  }
  if (opts.force) return { problems: problems.filter((p) => !p.endsWith("(overwriting: --force)")), warnings };

  for (const f of plan.files) {
    let dir = dirname(f.path);
    while (!existsSync(dir)) dir = dirname(dir);
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      problems.push(`${dir} is not writable by this user; run the installer with sudo`);
      break;
    }
  }
  return { problems, warnings };
}

export function applyManaged(plan, opts = {}) {
  const old = readManifest(plan.manifestPath);
  for (const f of plan.files) writeAtomic(f.path, f.content, f.mode);
  const keep = new Set(plan.files.map((f) => f.path));
  for (const f of old?.files ?? []) {
    // A file an earlier install wrote and this plan no longer has, such as the OTEL drop-in, goes away unless edited.
    if (!keep.has(f.path) && existsSync(f.path) && sha256(readFileSync(f.path)) === f.sha256) rmSync(f.path);
  }
  writeAtomic(
    plan.manifestPath,
    json({ schema: "helm.executor.install/v1", installed_at: new Date().toISOString(), claude_min_version: MIN_CLAUDE_VERSION, files: plan.files.map((f) => ({ path: f.path, sha256: sha256(f.content) })) }),
    0o644,
  );
}

/** Run the installed pieces the way Claude Code will, against an empty state directory. */
export function verifyManaged(plan) {
  const home = join(tmpdir(), `helm-executor-verify-${randomBytes(4).toString("hex")}`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HELM_EXECUTOR_HOME: home };
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });
  try {
    const version = spawnSync(plan.bin, ["--version"], { encoding: "utf8", env });
    check("helm-executor --version runs", version.status === 0 && /^\d+\.\d+\.\d+\n$/.test(version.stdout), version.stderr.trim());
    const status = spawnSync(plan.bin, ["status", "--json"], { encoding: "utf8", env });
    let parsed = null;
    try {
      parsed = JSON.parse(status.stdout);
    } catch {
      parsed = null;
    }
    check("helm-executor status --json is valid", status.status === 0 && parsed?.schema === "helm.executor.status/v1", status.stderr.trim());
    for (const [label, command] of [
      ["apiKeyHelper", plan.rendered.settings.apiKeyHelper],
      ["headersHelper", plan.rendered.mcp.mcpServers.helm.headersHelper],
    ]) {
      const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env });
      check(`${label} fails closed with nothing on stdout when no episode is checked out`, r.status === 4 && r.stdout === "" && /^helm-executor: no_episode: /.test(r.stderr), `exit ${r.status}`);
    }
    const hook = plan.rendered.settings.hooks.PreToolUse[0].hooks[0];
    const observe = spawnSync(hook.command, hook.args, { encoding: "utf8", env, input: JSON.stringify({ session_id: "install-check", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }) });
    check("the observe hook exits 0 and prints nothing", observe.status === 0 && observe.stdout === "", `exit ${observe.status}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return results;
}

export function uninstallManaged(opts = {}) {
  const prefix = resolve(opts.prefix ?? "/usr/local");
  const manifestPath = join(prefix, "lib", "helm-executor", "install-manifest.json");
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`no install manifest at ${manifestPath}; nothing to remove`);
  const removed = [];
  const kept = [];
  for (const f of manifest.files) {
    if (!existsSync(f.path)) continue;
    if (!opts.force && sha256(readFileSync(f.path)) !== f.sha256) kept.push(f.path);
    else {
      rmSync(f.path);
      removed.push(f.path);
    }
  }
  if (kept.length === 0) {
    rmSync(manifestPath);
    removed.push(manifestPath);
  }
  // Empty directories this installer created, deepest first. Never the prefix, the bin directory or the managed directory.
  const dirs = new Set(manifest.files.flatMap((f) => [dirname(f.path), dirname(dirname(f.path))]));
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (!/helm-executor|managed-settings\.d$/.test(dir)) continue;
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or already gone
    }
  }
  return { removed, kept };
}

// ---- session profile --------------------------------------------------------------------------------------

export function writeSession(opts) {
  const { settings, mcp } = renderSession(opts);
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeAtomic(join(out, "settings.json"), json(settings), 0o600);
  writeAtomic(join(out, "mcp.json"), json(mcp), 0o600);
  return { settings: join(out, "settings.json"), mcp: join(out, "mcp.json") };
}

// ---- owner opt-in -------------------------------------------------------------------------------------------

const defaultUserSettings = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
const ownerManifestPath = () => join(process.env.HELM_EXECUTOR_HOME ?? join(homedir(), ".config", "helm-executor"), "owner-otel.json");

/** What `owner-otel` would change in the settings file. Throws when it cannot do so without overwriting something. */
export function planOwnerOtel(opts) {
  const file = resolve(opts.settingsFile ?? defaultUserSettings());
  const add = renderOwnerOtel({ otelEndpoint: opts.otelEndpoint });
  let current = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first, nothing was changed`);
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) throw new Error(`${file} is not a JSON object; nothing was changed`);
  }
  const env = current.env ?? {};
  const conflicts = Object.keys(add).filter((k) => k in env && env[k] !== add[k]);
  if (conflicts.length > 0) throw new Error(`${file} already sets ${conflicts.join(", ")} to other values; remove them or merge by hand. Nothing was changed`);
  const next = { ...current, env: { ...env, ...add } };
  return { file, add, next, existed: existsSync(file), hadEnv: "env" in current };
}

export function applyOwnerOtel(plan) {
  if (plan.existed) writeAtomic(`${plan.file}.helm-executor.${Date.now()}.bak`, readFileSync(plan.file), 0o600);
  const mode = plan.existed ? statSync(plan.file).mode & 0o777 : 0o600;
  writeAtomic(plan.file, json(plan.next), mode);
  writeAtomic(ownerManifestPath(), json({ schema: "helm.executor.owner-otel/v1", settings_file: plan.file, keys: plan.add, had_env: plan.hadEnv }), 0o600);
}

export function removeOwnerOtel(opts = {}) {
  const manifest = readManifest(ownerManifestPath());
  if (!manifest) throw new Error("no owner-otel record; nothing to remove");
  const file = resolve(opts.settingsFile ?? manifest.settings_file);
  const current = JSON.parse(readFileSync(file, "utf8"));
  const env = { ...(current.env ?? {}) };
  for (const [key, value] of Object.entries(manifest.keys)) if (env[key] === value) delete env[key];
  const next = { ...current, env };
  if (Object.keys(env).length === 0 && !manifest.had_env) delete next.env;
  writeAtomic(file, json(next), statSync(file).mode & 0o777);
  rmSync(ownerManifestPath());
  return file;
}

// ---- command line -------------------------------------------------------------------------------------------

const MACHINE_WIDE = `
This is a machine-wide Claude Code policy. Every Claude Code session on this machine, including personal
interactive ones, will use the HELM gateway as its only provider, authenticate with the episode token, load only
the HELM MCP server and run only the managed hooks. Install it on executor hosts only. For a single session on a
shared machine use \`install.mjs session\`.
`;

const USAGE = `usage: install.mjs <command> [options]

  managed     --edge-url <https url> --cp-url <https url> --org <id> [--otel-endpoint <url>]
              [--prefix /usr/local] [--managed-dir <dir>] [--node <path>] [--core-dir <dir>] [--claude <path>]
              [--skip-version-check] [--force] [--yes]
  session     --out <dir> --edge-url <url> --cp-url <url> --org <id> --helm-executor <abs path> [--otel-endpoint <url>]
  owner-otel  --otel-endpoint <url> [--settings-file <path>] [--yes]      (opt-in; edits your own settings)
  owner-otel  --remove [--settings-file <path>]
  uninstall   [--prefix /usr/local] [--force]

Nothing is written without --yes (session writes only --out). managed needs root unless --prefix and --managed-dir
point somewhere you own.
`;

export async function main(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
  const [command, ...rest] = argv;
  const options = {
    "edge-url": { type: "string" },
    "cp-url": { type: "string" },
    org: { type: "string" },
    "otel-endpoint": { type: "string" },
    prefix: { type: "string" },
    "managed-dir": { type: "string" },
    node: { type: "string" },
    "core-dir": { type: "string" },
    claude: { type: "string" },
    "skip-version-check": { type: "boolean" },
    force: { type: "boolean" },
    yes: { type: "boolean" },
    out: { type: "string" },
    "helm-executor": { type: "string" },
    "settings-file": { type: "string" },
    remove: { type: "boolean" },
  };
  try {
    if (!command || command === "--help" || command === "-h") {
      io.out(USAGE);
      return command ? 0 : 2;
    }
    const { values: v } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
    switch (command) {
      case "managed": {
        const plan = planManaged({ edgeUrl: v["edge-url"], cpUrl: v["cp-url"], orgId: v.org, otelEndpoint: v["otel-endpoint"], prefix: v.prefix, managedDir: v["managed-dir"], node: v.node, coreDir: v["core-dir"] });
        const { problems, warnings } = preflight(plan, { claude: v.claude, skipVersionCheck: v["skip-version-check"], force: v.force });
        io.out(MACHINE_WIDE);
        io.out("\nFiles:\n");
        for (const f of plan.files) io.out(`  ${f.path}  (${f.mode.toString(8)}, ${f.content.length} bytes)\n`);
        for (const w of warnings) io.err(`warning: ${w}\n`);
        for (const p of problems) io.err(`problem: ${p}\n`);
        if (problems.length > 0) return 1;
        if (!v.yes) {
          io.out("\nNothing was written. Re-run with --yes to install.\n");
          return 0;
        }
        applyManaged(plan);
        const results = verifyManaged(plan);
        for (const r of results) io.out(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : `: ${r.detail}`}\n`);
        io.out(`\nInstalled. Next, as each executor user: ${plan.bin} login --cp-url ${plan.rendered.settings.env.HELM_EXECUTOR_CP_URL}\nThen start Claude Code and run /status: the setting sources line must show the managed settings file.\n`);
        return results.every((r) => r.ok) ? 0 : 1;
      }
      case "session": {
        if (!v.out) throw new Error("--out is required");
        const written = writeSession({ out: v.out, edgeUrl: v["edge-url"], cpUrl: v["cp-url"], orgId: v.org, helmExecutor: v["helm-executor"], otelEndpoint: v["otel-endpoint"] });
        io.out(`wrote ${written.settings}\nwrote ${written.mcp}\n\nStart a session with:\n  claude --settings ${shellQuote(written.settings)} --mcp-config ${shellQuote(written.mcp)} --strict-mcp-config\n`);
        return 0;
      }
      case "owner-otel": {
        if (v.remove) {
          io.out(`removed the telemetry keys from ${removeOwnerOtel({ settingsFile: v["settings-file"] })}\n`);
          return 0;
        }
        const plan = planOwnerOtel({ otelEndpoint: v["otel-endpoint"], settingsFile: v["settings-file"] });
        io.out(`This adds the following keys to the env block of ${plan.file}. Nothing else in the file changes.\n${json(plan.add)}`);
        if (!v.yes) {
          io.out("\nNothing was written. Re-run with --yes to apply.\n");
          return 0;
        }
        applyOwnerOtel(plan);
        io.out(`\nApplied. A backup of the previous file is next to it. Undo with: install.mjs owner-otel --remove\n`);
        return 0;
      }
      case "uninstall": {
        const { removed, kept } = uninstallManaged({ prefix: v.prefix, force: v.force });
        for (const p of removed) io.out(`removed ${p}\n`);
        for (const p of kept) io.err(`kept ${p}: it changed since it was installed (use --force to remove it)\n`);
        return kept.length > 0 ? 1 : 0;
      }
      default:
        io.err(`unknown command "${command}"\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err(`install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
