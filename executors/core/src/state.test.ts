import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ExecutorError } from "./errors.js";
import { ensureSecureDir, loadCredentials, loadCredentialsLenient, loadSlot, readJson, saveSlot, skewFrom, localMs, withLock, writeJsonAtomic } from "./state.js";
import { loggedIn, tempDir, world } from "./test-utils.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

test("ensureSecureDir creates a 0700 directory and tightens a loose one", () => {
  const t = tempDir();
  try {
    const dir = join(t.dir, "a", "b");
    ensureSecureDir(dir);
    assert.equal(mode(dir), 0o700);
    chmodSync(dir, 0o755);
    ensureSecureDir(dir);
    assert.equal(mode(dir), 0o700);
  } finally {
    t.cleanup();
  }
});

test("ensureSecureDir refuses a symlink in place of the directory", () => {
  const t = tempDir();
  try {
    const target = join(t.dir, "elsewhere");
    mkdirSync(target);
    const link = join(t.dir, "state");
    symlinkSync(target, link);
    assert.throws(() => ensureSecureDir(link), (e: unknown) => e instanceof ExecutorError && e.code === "internal");
  } finally {
    t.cleanup();
  }
});

test("writeJsonAtomic writes a 0600 file and leaves no temporary file behind", () => {
  const t = tempDir();
  try {
    const file = join(t.dir, "x.json");
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    assert.equal(mode(file), 0o600);
    assert.deepEqual(readJson(file), { a: 2 });
    assert.deepEqual(readdirSync(t.dir), ["x.json"]);
  } finally {
    t.cleanup();
  }
});

test("readJson returns null for a missing file and an internal error for a corrupt one", () => {
  const t = tempDir();
  try {
    assert.equal(readJson(join(t.dir, "none.json")), null);
    const bad = join(t.dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.throws(() => readJson(bad), (e: unknown) => e instanceof ExecutorError && e.code === "internal");
  } finally {
    t.cleanup();
  }
});

test("withLock runs critical sections one at a time", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    let active = 0;
    let overlaps = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(lock, 5_000, async () => {
          if (++active > 1) overlaps++;
          await new Promise((r) => setTimeout(r, 15));
          active--;
          done++;
        }),
      ),
    );
    assert.equal(done, 8);
    assert.equal(overlaps, 0);
    assert.deepEqual(readdirSync(t.dir), []);
  } finally {
    t.cleanup();
  }
});

test("withLock takes over a lock whose owner process is gone", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, t: Date.now() }));
    assert.equal(await withLock(lock, 1_000, async () => "ran"), "ran");
  } finally {
    t.cleanup();
  }
});

test("withLock gives up as unavailable when a live process holds the lock", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() }));
    await assert.rejects(withLock(lock, 150, async () => "never"), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
  } finally {
    t.cleanup();
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a long holder keeps its lock: the heartbeat means age alone never makes a live holder stale", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    // The holder runs for almost twice the stale age; only its heartbeat keeps the lock from being taken over.
    const timing = { staleMs: 1_000, heartbeatMs: 50 };
    const events: string[] = [];
    const first = withLock(lock, 10_000, async () => {
      events.push("a:start");
      await sleep(1_800);
      events.push("a:end");
    }, timing);
    await sleep(50);
    const second = withLock(lock, 10_000, async () => {
      events.push("b:start");
    }, timing);
    await Promise.all([first, second]);
    assert.deepEqual(events, ["a:start", "a:end", "b:start"], "the second waited for the whole of the first, longer than the stale age");
    assert.deepEqual(readdirSync(t.dir), []);
  } finally {
    t.cleanup();
  }
});

test("a live holder that stopped refreshing its lock is taken over once it is stale", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() }));
    const old = new Date(Date.now() - 5_000);
    utimesSync(lock, old, old);
    assert.equal(await withLock(lock, 1_000, async () => "ran", { staleMs: 300, heartbeatMs: 50 }), "ran");
  } finally {
    t.cleanup();
  }
});

test("a holder never removes a lock someone else took over from it", async () => {
  const t = tempDir();
  try {
    const lock = join(t.dir, "l.lock");
    const other = JSON.stringify({ pid: 1, t: 0, n: "taken-over" });
    await withLock(lock, 1_000, async () => {
      writeFileSync(lock, other);
    });
    assert.equal(readFileSync(lock, "utf8"), other, "the lock the holder finds is not its own, so it is left alone");
  } finally {
    t.cleanup();
  }
});

test("waiters that see the same dead holder admit exactly one of themselves at a time, across processes", async () => {
  const t = tempDir();
  try {
    const stateModule = fileURLToPath(new URL("./state.js", import.meta.url));
    const script = `
      const { withLock } = await import(${JSON.stringify(stateModule)});
      const [lock, log] = process.argv.slice(1);
      const fs = await import("node:fs");
      await withLock(lock, 20000, async () => {
        fs.appendFileSync(log, "in " + process.pid + "\\n");
        await new Promise((r) => setTimeout(r, 25));
        fs.appendFileSync(log, "out " + process.pid + "\\n");
      });
    `;
    const trials = 12;
    const waiters = 8;
    for (let trial = 0; trial < trials; trial++) {
      const lock = join(t.dir, `l${trial}.lock`);
      const log = join(t.dir, `l${trial}.log`);
      writeFileSync(log, "");
      writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, t: Date.now() }));
      await Promise.all(
        Array.from({ length: waiters }, () => new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, lock, log], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`waiter exited ${code}: ${stderr.slice(0, 300)}`))));
        })),
      );
      const lines = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(lines.length, waiters * 2, `trial ${trial}: every waiter ran`);
      let inside = 0;
      for (const line of lines) {
        inside += line.startsWith("in ") ? 1 : -1;
        assert.ok(inside >= 0 && inside <= 1, `trial ${trial}: two waiters were inside at once`);
      }
      assert.deepEqual(readdirSync(t.dir).filter((f) => f.startsWith(`l${trial}.lock`)), [], "no lock or guard is left behind");
    }
  } finally {
    t.cleanup();
  }
});

test("an unreadable credentials file is not_logged_in with its full path; an unreadable slot is no_episode", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const credentialsFile = join(w.home, "credentials.json");
    writeFileSync(credentialsFile, "{ not json");
    assert.throws(() => loadCredentials(ctx), (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in" && e.message.includes(credentialsFile) && /helm-executor login/.test(e.message));
    assert.equal(loadCredentialsLenient(ctx), null, "login can replace it");

    saveSlot(ctx, { slot: "default", client: "codex", org_id: "o", workspace_id: "w", work_item_id: "x", episode_id: "e", deadline: "2026-10-08T13:00:00.000Z", checked_out_at: "2026-10-08T12:00:00.000Z" });
    const slotFile = join(w.home, "slots", "default.json");
    writeFileSync(slotFile, "[");
    assert.throws(() => loadSlot(ctx), (e: unknown) => e instanceof ExecutorError && e.code === "no_episode" && e.message.includes(slotFile) && /stop --local/.test(e.message));
  } finally {
    await w.close();
  }
});

test("skew is remembered only when the clock is clearly off, and a control plane time is read on this machine's clock", () => {
  assert.equal(skewFrom(null, 1_000_000), 0);
  assert.equal(skewFrom(1_003_000, 1_000_000), 0, "3 s is noise");
  assert.equal(skewFrom(1_000_000 + 20 * 60_000, 1_000_000), 20 * 60_000);
  assert.equal(skewFrom(1_000_000 - 90_000, 1_000_000), -90_000);
  assert.equal(skewFrom(1_000_000 + 3 * 24 * 3_600_000, 1_000_000), 0, "a difference of days is nonsense, not skew");
  assert.equal(localMs({ clock_skew_ms: 20 * 60_000 }, "2026-10-08T12:20:00.000Z"), Date.parse("2026-10-08T12:00:00.000Z"));
  assert.equal(localMs({}, "2026-10-08T12:00:00.000Z"), Date.parse("2026-10-08T12:00:00.000Z"));
});
