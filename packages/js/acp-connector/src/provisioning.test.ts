/** Provisioning tests: sha512 integrity verification, signed-manifest
 *  enforcement (fail-closed), atomic install + ledger, receipted binary
 *  hashes, cache-hit re-verification, and tamper-triggered reprovisioning. */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalManifestBytes,
  ensureEngine,
  manifestDigestSha256,
  sha512FileHex,
  verifyIntegrity,
  verifyManifestSignature,
  type EngineManifest,
} from "./provisioning.js";
import { cleanupTmpDir, makeTmpDir } from "./test-utils.js";

const BINARY_CONTENT = "#!/bin/sh\necho fake-engine-v1\n";

function platformKeyForTest(): string {
  return `${process.platform}-${process.arch}`;
}

interface Fixture {
  dir: string;
  tarballPath: string;
  manifest: EngineManifest;
  integrity: string;
}

async function makeEngineFixture(): Promise<Fixture> {
  const dir = await makeTmpDir("helm-acp-prov-");
  const pkgRoot = path.join(dir, "staging", "package");
  await fs.mkdir(path.join(pkgRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(pkgRoot, "bin", "engine"), BINARY_CONTENT, "utf8");
  const tarballPath = path.join(dir, "engine.tgz");
  const r = spawnSync("tar", ["-czf", tarballPath, "-C", path.join(dir, "staging"), "package"], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`test fixture tar failed: ${r.stderr?.toString()}`);
  const data = await fs.readFile(tarballPath);
  const integrity = `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`;
  const manifest: EngineManifest = {
    "fake-agent": {
      version: "1.0.0",
      platforms: {
        [platformKeyForTest()]: {
          pkg: "fake-engine",
          pkgVersion: "1.0.0",
          tarball: `file://${tarballPath}`,
          integrity,
          executableRelPath: "bin/engine",
        },
      },
    },
  };
  return { dir, tarballPath, manifest, integrity };
}

function fileFetch(): typeof globalThis.fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (!url.startsWith("file://")) throw new Error(`test fetch only supports file:// — got ${url}`);
    const data = await fs.readFile(url.slice("file://".length));
    return new Response(new Blob([data]).stream(), {
      status: 200,
      headers: { "content-length": String(data.length) },
    });
  }) as unknown as typeof globalThis.fetch;
}

function makeKeyPair(): { publicKeyPem: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

test("happy path: verify → extract → atomic install → ledger + receipted binary hash", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  const enginesRoot = path.join(fx.dir, "engines");
  const receiptsDir = path.join(fx.dir, "receipts");
  try {
    const result = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      receiptsDir,
      fetch: fileFetch(),
    });
    assert.equal(result.version, "1.0.0");
    assert.equal(await fs.readFile(result.executablePath, "utf8"), BINARY_CONTENT);

    // Executable bit set on posix.
    const mode = (await fs.stat(result.executablePath)).mode & 0o111;
    assert.notEqual(mode, 0, "installed binary must be executable");

    // Ledger written with the receipted hash.
    const ledger = JSON.parse(
      await fs.readFile(path.join(enginesRoot, "fake-agent", ".meta", "fake-agent-1.0.0.json"), "utf8"),
    );
    const expectedHash = await sha512FileHex(result.executablePath);
    assert.equal(ledger.binarySha512, expectedHash);
    assert.equal(ledger.integrity, fx.integrity);
    assert.equal(ledger.manifestDigestSha256, manifestDigestSha256(fx.manifest));

    // Receipt persisted, carrying the hash of the exact bytes that will run.
    assert.equal(result.receipt.binarySha512, expectedHash);
    const receiptFiles = await fs.readdir(receiptsDir);
    assert.equal(receiptFiles.length, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(receiptsDir, receiptFiles[0]), "utf8"));
    assert.equal(persisted.receiptId, result.receipt.receiptId);
    assert.equal(persisted.binarySha512, expectedHash);
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("integrity mismatch fails closed — corrupt/tampered download never installs", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  fx.manifest["fake-agent"].platforms[platformKeyForTest()].integrity =
    `sha512-${crypto.createHash("sha512").update("not-the-tarball").digest("base64")}`;
  try {
    await assert.rejects(
      ensureEngine("fake-agent", {
        manifest: fx.manifest,
        allowUnsignedManifest: true,
        enginesRoot: path.join(fx.dir, "engines"),
        fetch: fileFetch(),
      }),
      /integrity check failed/,
    );
    // Nothing installed.
    await assert.rejects(fs.stat(path.join(fx.dir, "engines", "fake-agent", "1.0.0")));
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("unsigned manifests need an explicit development opt-in before download", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  let fetched = false;
  const countingFetch: typeof globalThis.fetch = (async () => {
    fetched = true;
    return fileFetch()("file:///unused");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      ensureEngine("fake-agent", { manifest: fx.manifest, enginesRoot: path.join(fx.dir, "engines"), fetch: countingFetch }),
      /trustedPublicKeys are required/,
    );
    assert.equal(fetched, false, "unsigned manifests must fail before download");
    const result = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot: path.join(fx.dir, "engines"),
      fetch: fileFetch(),
    });
    assert.equal(result.version, "1.0.0");
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("signed manifest: valid signature installs; missing/invalid fails closed before download", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  const { publicKeyPem, privateKey } = makeKeyPair();
  const signature = crypto.sign(null, canonicalManifestBytes(fx.manifest), privateKey).toString("base64");
  try {
    // Missing signature → refuse before touching the network.
    let fetched = false;
    const countingFetch: typeof globalThis.fetch = (async (...args: unknown[]) => {
      fetched = true;
      return (fileFetch() as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(
      ensureEngine("fake-agent", {
        manifest: fx.manifest,
        enginesRoot: path.join(fx.dir, "e1"),
        trustedPublicKeys: [publicKeyPem],
        fetch: countingFetch,
      }),
      /signature is required/,
    );
    assert.equal(fetched, false, "download must not start without a valid signature");

    // Wrong key → refuse.
    const other = makeKeyPair();
    await assert.rejects(
      ensureEngine("fake-agent", {
        manifest: fx.manifest,
        manifestSignature: signature,
        enginesRoot: path.join(fx.dir, "e2"),
        trustedPublicKeys: [other.publicKeyPem],
        fetch: fileFetch(),
      }),
      /did not verify/,
    );

    // Valid signature → install proceeds.
    const ok = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      manifestSignature: signature,
      enginesRoot: path.join(fx.dir, "e3"),
      trustedPublicKeys: [publicKeyPem, other.publicKeyPem],
      fetch: fileFetch(),
    });
    assert.equal(ok.version, "1.0.0");
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("verifyManifestSignature: canonicalization makes key order irrelevant", () => {
  const { publicKeyPem, privateKey } = makeKeyPair();
  const a = { b: 1, a: { z: 2, y: 3 } };
  const sig = crypto.sign(null, canonicalManifestBytes(a), privateKey).toString("base64");
  // Same content, different key order → same canonical bytes → verifies.
  verifyManifestSignature({ a: { y: 3, z: 2 }, b: 1 }, sig, [publicKeyPem]);
  assert.throws(() => verifyManifestSignature({ a: { y: 3, z: 4 }, b: 1 }, sig, [publicKeyPem]), /did not verify/);
});

test("cache hit re-verifies the ledger hash; tampered cache reprovisions", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  const enginesRoot = path.join(fx.dir, "engines");
  let fetches = 0;
  const countingFetch = (async (input: unknown) => {
    fetches++;
    const url = String(input);
    const data = await fs.readFile(url.slice("file://".length));
    return new Response(new Blob([data]).stream(), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  try {
    const first = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      fetch: countingFetch,
    });
    assert.equal(fetches, 1);

    // Cache hit: no second download, but a fresh receipt is still emitted.
    const second = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      fetch: countingFetch,
    });
    assert.equal(fetches, 1);
    assert.equal(second.receipt.binarySha512, first.receipt.binarySha512);
    assert.notEqual(second.receipt.receiptId, first.receipt.receiptId);

    // Tamper with the installed binary → the next ensure reprovisions.
    await fs.writeFile(first.executablePath, "evil-binary", "utf8");
    const third = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      fetch: countingFetch,
    });
    assert.equal(fetches, 2, "tampered cache must trigger a fresh verified download");
    assert.equal(await fs.readFile(third.executablePath, "utf8"), BINARY_CONTENT);
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("cache re-provisions when the manifest changes at the same engine version", async (t) => {
  if (process.platform === "win32") return t.skip("fixture uses posix tar");
  const fx = await makeEngineFixture();
  const enginesRoot = path.join(fx.dir, "engines");
  let fetches = 0;
  const countingFetch = (async (input: unknown) => {
    fetches++;
    const data = await fs.readFile(String(input).slice("file://".length));
    return new Response(new Blob([data]).stream(), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  try {
    await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      fetch: countingFetch,
    });
    fx.manifest["fake-agent"].platforms[platformKeyForTest()].pkg = "fake-engine-reissued";
    const reprovisioned = await ensureEngine("fake-agent", {
      manifest: fx.manifest,
      allowUnsignedManifest: true,
      enginesRoot,
      fetch: countingFetch,
    });
    assert.equal(fetches, 2, "a changed manifest must not reuse the old cache");
    assert.equal(reprovisioned.receipt.manifestDigestSha256, manifestDigestSha256(fx.manifest));
  } finally {
    await cleanupTmpDir(fx.dir);
  }
});

test("verifyIntegrity rejects malformed and wrong-algorithm strings", async () => {
  const dir = await makeTmpDir("helm-acp-prov-");
  try {
    const f = path.join(dir, "x.bin");
    await fs.writeFile(f, "data", "utf8");
    await assert.rejects(verifyIntegrity(f, "garbage"), /malformed/);
    await assert.rejects(verifyIntegrity(f, "md5-deadbeef"), /unsupported integrity algorithm/);
  } finally {
    await cleanupTmpDir(dir);
  }
});
