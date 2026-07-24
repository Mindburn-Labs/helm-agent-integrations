/** FsGuard tests: allowlist enforcement, .. traversal, symlink escape
 *  attempts (including final-component and ancestor symlinks), walk-up
 *  canonicalization for non-existent paths, read/write capability split, and
 *  end-to-end denial through the ACP wire with the fake agent. */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsGuard, FsAccessDeniedError, canonicalizePath, isPathInside } from "./fs-guard.js";
import { GovernedAcpClient } from "./client.js";
import { GovernedPermissionBroker } from "./permission.js";
import type { AcpRunEvent } from "./types.js";
import {
  FakeKernelEvaluator,
  cleanupTmpDir,
  fakeLaunchSpec,
  guardFor,
  makeTmpDir,
} from "./test-utils.js";

test("isPathInside: the one containment check", () => {
  assert.ok(isPathInside("/a/b", "/a/b"));
  assert.ok(isPathInside("/a/b", "/a/b/c/d"));
  assert.ok(!isPathInside("/a/b", "/a/bc"));
  assert.ok(!isPathInside("/a/b", "/a"));
  assert.ok(!isPathInside("/a/b", "/etc/passwd"));
  assert.ok(!isPathInside("/a/b", "/a/b/../../etc"));
});

test("reads inside the allowlist succeed; outside paths deny", async () => {
  const root = await makeTmpDir();
  const outside = await makeTmpDir("helm-acp-outside-");
  try {
    await fs.writeFile(path.join(root, "inside.txt"), "hello", "utf8");
    await fs.writeFile(path.join(outside, "secret.txt"), "top-secret", "utf8");
    const guard = guardFor(root);

    const ok = await guard.readTextFile({ path: path.join(root, "inside.txt") });
    assert.equal(ok.content, "hello");

    await assert.rejects(
      guard.readTextFile({ path: path.join(outside, "secret.txt") }),
      FsAccessDeniedError,
    );
    await assert.rejects(
      guard.readTextFile({ path: path.join(root, "..", path.basename(outside), "secret.txt") }),
      FsAccessDeniedError,
    );
  } finally {
    await cleanupTmpDir(root);
    await cleanupTmpDir(outside);
  }
});

test("symlink escape: a link inside the allowlist pointing outside is denied", async () => {
  const root = await makeTmpDir();
  const outside = await makeTmpDir("helm-acp-outside-");
  try {
    await fs.writeFile(path.join(outside, "secret.txt"), "top-secret", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    const guard = guardFor(root);
    await assert.rejects(guard.readTextFile({ path: path.join(root, "leak.txt") }), FsAccessDeniedError);

    // Ancestor-level escape: link a directory out, then a path through it.
    await fs.symlink(outside, path.join(root, "outdir"));
    await assert.rejects(
      guard.readTextFile({ path: path.join(root, "outdir", "secret.txt") }),
      FsAccessDeniedError,
    );
    await assert.rejects(
      guard.writeTextFile({ path: path.join(root, "outdir", "new-file.txt"), content: "x" }),
      FsAccessDeniedError,
    );
  } finally {
    await cleanupTmpDir(root);
    await cleanupTmpDir(outside);
  }
});

test("symlink to an inside target is allowed (canonical location decides)", async () => {
  const root = await makeTmpDir();
  try {
    await fs.writeFile(path.join(root, "real.txt"), "real-content", "utf8");
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "alias.txt"));
    const guard = guardFor(root);
    const res = await guard.readTextFile({ path: path.join(root, "alias.txt") });
    assert.equal(res.content, "real-content");
  } finally {
    await cleanupTmpDir(root);
  }
});

test("write capability split: a read-only root denies writes", async () => {
  const ro = await makeTmpDir("helm-acp-ro-");
  const rw = await makeTmpDir("helm-acp-rw-");
  try {
    await fs.writeFile(path.join(ro, "f.txt"), "data", "utf8");
    const guard = guardFor(rw, [{ path: ro, read: true, write: false }]);
    const ok = await guard.readTextFile({ path: path.join(ro, "f.txt") });
    assert.equal(ok.content, "data");
    await assert.rejects(
      guard.writeTextFile({ path: path.join(ro, "f.txt"), content: "overwrite" }),
      FsAccessDeniedError,
    );
    await guard.writeTextFile({ path: path.join(rw, "new.txt"), content: "fine" });
    assert.equal(await fs.readFile(path.join(rw, "new.txt"), "utf8"), "fine");
  } finally {
    await cleanupTmpDir(ro);
    await cleanupTmpDir(rw);
  }
});

test("non-existent write target: walk-up canonicalization through a symlinked parent denies escape", async () => {
  const root = await makeTmpDir();
  const outside = await makeTmpDir("helm-acp-outside-");
  try {
    // A new file under a symlinked dir that points outside must deny.
    await fs.symlink(outside, path.join(root, "escape"));
    const guard = guardFor(root);
    await assert.rejects(
      guard.writeTextFile({ path: path.join(root, "escape", "planted.txt"), content: "x" }),
      FsAccessDeniedError,
    );
    assert.equal(
      await fs.stat(path.join(outside, "planted.txt")).then(() => true, () => false),
      false,
      "no file must be planted outside the allowlist",
    );

    // A new file under a real allowed dir is fine.
    await fs.mkdir(path.join(root, "sub"));
    await guard.writeTextFile({ path: path.join(root, "sub", "new.txt"), content: "ok" });
    assert.equal(await fs.readFile(path.join(root, "sub", "new.txt"), "utf8"), "ok");
  } finally {
    await cleanupTmpDir(root);
    await cleanupTmpDir(outside);
  }
});

test("canonicalizePath resolves /tmp-style symlinked roots (macOS /tmp → /private/tmp)", async () => {
  if (process.platform !== "darwin") return;
  const canonical = await canonicalizePath("/tmp");
  assert.equal(canonical, "/private/tmp");
});

test("fail-closed construction: no roots is a hard error", () => {
  assert.throws(() => new FsGuard({ roots: [] }), /at least one allowlist root/);
});

test("end-to-end: engine fs/read_text_file outside the allowlist is denied over the wire", async () => {
  const cwd = await makeTmpDir();
  const outside = await makeTmpDir("helm-acp-outside-");
  try {
    const secretPath = path.join(outside, "secret.txt");
    await fs.writeFile(secretPath, "top-secret", "utf8");
    const events: AcpRunEvent[] = [];
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ readFilePath: secretPath }),
      broker: new GovernedPermissionBroker({
        evaluator: new FakeKernelEvaluator(),
        policy: "ask",
        agent: "claude",
        cwd,
      }),
      fsGuard: guardFor(cwd),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    const sessionId = await client.newSession();
    await client.prompt(sessionId, "read my secrets");
    const msg = events.find((e) => e.type === "message");
    assert.ok(msg && msg.type === "message");
    if (msg.type === "message") {
      assert.ok(msg.text.startsWith("read-denied:"), `expected denial, got: ${msg.text}`);
      assert.ok(msg.text.includes("fs guard"), "denial should come from the fs guard");
    }
    client.dispose();
  } finally {
    await cleanupTmpDir(cwd);
    await cleanupTmpDir(outside);
  }
});

test("end-to-end: engine fs/write_text_file inside the allowlist succeeds over the wire", async () => {
  const cwd = await makeTmpDir();
  try {
    const target = path.join(cwd, "engine-output.txt");
    const events: AcpRunEvent[] = [];
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ writeFilePath: target }),
      broker: new GovernedPermissionBroker({
        evaluator: new FakeKernelEvaluator(),
        policy: "ask",
        agent: "claude",
        cwd,
      }),
      fsGuard: guardFor(cwd),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    const sessionId = await client.newSession();
    await client.prompt(sessionId, "write a file");
    assert.equal(await fs.readFile(target, "utf8"), "engine-wrote-this");
    const msg = events.find((e) => e.type === "message");
    assert.ok(msg && msg.type === "message" && msg.text === "write-ok");
    client.dispose();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("no accidental dependency on os.tmpdir quirks", async () => {
  // Sanity: guard roots under os.tmpdir() canonicalize consistently.
  const root = await makeTmpDir();
  try {
    const guard = guardFor(root);
    const p = path.join(root, "a.txt");
    await fs.writeFile(p, "x", "utf8");
    const authorized = await guard.authorize(p, "read");
    assert.ok(isPathInside(await canonicalizePath(root), authorized));
  } finally {
    await cleanupTmpDir(root);
  }
});
