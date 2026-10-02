import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutorError } from "./errors.js";
import { ensureSecureDir, readJson, withLock, writeJsonAtomic } from "./state.js";
import { tempDir } from "./test-utils.js";

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
