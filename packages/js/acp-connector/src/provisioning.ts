/**
 * Managed engine provisioning client: lockfile-pinned versions, sha512
 * verification, atomic install, ledger — plus the HELM outperform Rowboat
 * does not have: an Ed25519-signed manifest and provisioned-binary hashes
 * receipted into evidence records.
 *
 * Install-pipeline mechanisms adapted (with attribution, Apache-2.0) from
 * Rowboat's engine-provisioner.ts (apps/x/packages/core/src/code-mode/acp/):
 * download → SRI verify → temp-dir extract → atomic rename → .meta ledger →
 * prune superseded versions; fast-path cache check; per-call unique temp dirs
 * so concurrent callers are safe. Reimplemented with two governance additions:
 *
 *  1. SIGNED MANIFEST. The manifest maps agent → version → per-platform
 *     tarball + sha512 integrity + executable path. When trusted release
 *     public keys are configured, provisioning REFUSES to proceed without a
 *     valid Ed25519 signature over the canonical manifest bytes (fail-closed;
 *     Rowboat verifies tarball hashes but nothing authenticates the manifest
 *     itself — their R4 supply-chain risk).
 *  2. RECEIPTED INSTALLS. A successful install emits a ProvisioningReceipt
 *     (sha512 of the installed binary, manifest digest, integrity string,
 *     ledger path) so the exact bytes being executed downstream are
 *     receipted evidence.
 *
 * CONTRACT NOTE (helm-desktop / platform-actions): the manifest is expected
 * to be generated in platform-actions CI from lockfile pins (same role as
 * Rowboat's gen-engine-manifest.mjs), signed with the HELM release key, and
 * shipped beside helm-desktop. helm-desktop should consume THIS package's
 * ensureEngine()/verifyManifestSignature() rather than reimplementing the
 * pipeline. The receipt object is the handoff point for EvidencePack
 * assembly on the desktop side.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface EnginePlatformEntry {
  /** npm package name the tarball was pinned from. */
  pkg: string;
  pkgVersion: string;
  /** Tarball URL (lockfile-pinned registry URL). */
  tarball: string;
  /** npm Subresource Integrity string, "sha512-<base64>". */
  integrity: string;
  /** Executable path relative to the extracted package root. */
  executableRelPath: string;
}

export interface EngineManifestEntry {
  version: string;
  platforms: Record<string, EnginePlatformEntry>;
}

export type EngineManifest = Record<string, EngineManifestEntry>;

export interface EngineProgress {
  phase: "check" | "verify-manifest" | "download" | "verify" | "extract" | "receipt" | "done";
  receivedBytes?: number;
  totalBytes?: number;
}

export interface ProvisioningReceipt {
  receiptId: string;
  agent: string;
  version: string;
  platform: string;
  tarball: string;
  tarballIntegrity: string;
  /** sha512 (hex) of the installed executable — the bytes that will run. */
  binarySha512: string;
  /** sha256 (hex) of the canonical manifest bytes used for this install. */
  manifestDigestSha256: string;
  executablePath: string;
  ledgerPath: string;
  installedAt: string;
}

export interface EnsureEngineOptions {
  manifest: EngineManifest;
  /** Base64 Ed25519 signature over canonicalManifestBytes(manifest). */
  manifestSignature?: string;
  /** PEM Ed25519 public keys trusted to sign engine manifests. When
   *  non-empty, a missing/invalid signature fails closed. */
  trustedPublicKeys?: string[];
  enginesRoot?: string;
  receiptsDir?: string;
  onProgress?: (p: EngineProgress) => void;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ProvisionedEngine {
  executablePath: string;
  version: string;
  receipt: ProvisioningReceipt;
}

export const DEFAULT_ENGINES_ROOT = path.join(os.homedir(), ".helm", "engines");

/** Deterministic JSON (recursively sorted keys) — the signing surface. */
export function canonicalManifestBytes(manifest: unknown): Buffer {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return Buffer.from(JSON.stringify(canonical(manifest)), "utf8");
}

export function manifestDigestSha256(manifest: unknown): string {
  return crypto.createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex");
}

/**
 * Verify the manifest's Ed25519 signature against the trusted key set.
 * Fail-closed: throws unless at least one trusted key verifies.
 */
export function verifyManifestSignature(
  manifest: unknown,
  signatureBase64: string | undefined,
  trustedPublicKeys: string[],
): void {
  if (trustedPublicKeys.length === 0) return; // unsigned mode (dev only)
  if (!signatureBase64) {
    throw new Error("HELM engine manifest signature is required but missing (fail-closed)");
  }
  const payload = canonicalManifestBytes(manifest);
  const signature = Buffer.from(signatureBase64, "base64");
  for (const pem of trustedPublicKeys) {
    try {
      const key = crypto.createPublicKey(pem);
      if (crypto.verify(null, payload, key, signature)) return;
    } catch {
      // try the next trusted key
    }
  }
  throw new Error("HELM engine manifest signature did not verify against any trusted key (fail-closed)");
}

/** Map this process's platform/arch (+ libc on linux) to a manifest key. */
export function platformKey(entry: EngineManifestEntry): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) return null;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(`darwin-${arch}`);
  } else if (process.platform === "win32") {
    candidates.push(`win32-${arch}`);
  } else if (process.platform === "linux") {
    if (isMuslLibc()) candidates.push(`linux-${arch}-musl`);
    candidates.push(`linux-${arch}`);
  }
  return candidates.find((c) => c in entry.platforms) ?? null;
}

// glibc builds expose glibcVersionRuntime in the process report header; musl
// (Alpine) does not. Heuristic adapted from Rowboat's provisioner.
function isMuslLibc(): boolean {
  try {
    const report = (process as unknown as { report?: { getReport?: () => unknown } }).report?.getReport?.();
    const header = (report as { header?: Record<string, unknown> } | undefined)?.header;
    return !(header && "glibcVersionRuntime" in header);
  } catch {
    return false;
  }
}

function executablePath(root: string, plat: EnginePlatformEntry): string | null {
  const p = path.join(root, plat.executableRelPath);
  return fs.existsSync(p) ? p : null;
}

/** Verify the tarball against the npm SRI string ("sha512-<base64>"). */
export async function verifyIntegrity(file: string, integrity: string): Promise<void> {
  const dash = integrity.indexOf("-");
  if (dash <= 0) throw new Error("HELM provisioning: malformed integrity string");
  const algo = integrity.slice(0, dash);
  if (algo !== "sha512" && algo !== "sha256" && algo !== "sha384") {
    throw new Error(`HELM provisioning: unsupported integrity algorithm ${algo}`);
  }
  const expected = integrity.slice(dash + 1);
  const actual = crypto.createHash(algo).update(await fsp.readFile(file)).digest("base64");
  if (actual !== expected) {
    throw new Error(`HELM provisioning: integrity check failed (${algo}) — download may be corrupt or tampered`);
  }
}

export async function sha512FileHex(file: string): Promise<string> {
  return crypto.createHash("sha512").update(await fsp.readFile(file)).digest("hex");
}

// Extract an npm tarball, stripping its leading `package/` component. Uses the
// system tar (bsdtar on macOS/Windows 10+, GNU tar on Linux) — all support
// -xzf and --strip-components. Windows pinning adapted from Rowboat: PATH tar
// may be a GNU tar that misreads drive-letter paths; pin System32 bsdtar.
function extractTarball(tarPath: string, destDir: string): void {
  let tarCmd = "tar";
  let tarArgs = ["-xzf", tarPath, "-C", destDir, "--strip-components=1"];
  let spawnOpts: Parameters<typeof spawnSync>[2] = { stdio: "pipe" };
  if (process.platform === "win32") {
    const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sysTar)) {
      tarCmd = sysTar;
    } else {
      tarArgs = ["-xzf", path.basename(tarPath), "-C", destDir, "--strip-components=1"];
      spawnOpts = { stdio: "pipe", cwd: path.dirname(tarPath) };
    }
  }
  const r = spawnSync(tarCmd, tarArgs, spawnOpts);
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim() || r.error?.message || `tar exited ${r.status}`;
    throw new Error(`HELM provisioning: failed to extract engine — ${err}`);
  }
}

async function downloadTo(url: string, dest: string, opts: EnsureEngineOptions): Promise<void> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No fetch implementation available for engine download");
  opts.onProgress?.({ phase: "download", receivedBytes: 0 });
  const res = await fetchImpl(url, { signal: opts.signal });
  if (!res.ok || !res.body) {
    throw new Error(`HELM provisioning: engine download failed (HTTP ${res.status}) — ${url}`);
  }
  const total = Number(res.headers.get("content-length")) || undefined;
  let received = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    opts.onProgress?.({ phase: "download", receivedBytes: received, totalBytes: total });
  });
  await pipeline(body, fs.createWriteStream(dest));
}

// Remove every provisioned version except keepVersion (+ stale .meta entries).
// Best-effort — cleanup must never fail a good install.
function pruneOldVersions(enginesRoot: string, agent: string, keepVersion: string): void {
  const agentRoot = path.join(enginesRoot, agent);
  try {
    for (const name of fs.readdirSync(agentRoot)) {
      if (name === keepVersion || name === ".meta" || name.startsWith(".tmp-")) continue;
      const full = path.join(agentRoot, name);
      try {
        if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore a single stubborn entry */
      }
    }
    const metaDir = path.join(agentRoot, ".meta");
    if (fs.existsSync(metaDir)) {
      for (const f of fs.readdirSync(metaDir)) {
        if (f !== `${agent}-${keepVersion}.json`) {
          try {
            fs.rmSync(path.join(metaDir, f), { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* agentRoot unreadable — nothing to prune */
  }
}

/**
 * Ensure the pinned engine for `agent` is provisioned locally, downloading it
 * on first use. Idempotent, cached, concurrency-safe (unique temp dirs; the
 * final rename is idempotent). Emits a ProvisioningReceipt for every install
 * AND every cache hit — the running engine is always receipted.
 */
export async function ensureEngine(agent: string, opts: EnsureEngineOptions): Promise<ProvisionedEngine> {
  const entry = opts.manifest[agent];
  if (!entry) throw new Error(`HELM provisioning: no manifest entry for agent ${JSON.stringify(agent)}`);
  const enginesRoot = opts.enginesRoot ?? DEFAULT_ENGINES_ROOT;

  opts.onProgress?.({ phase: "verify-manifest" });
  verifyManifestSignature(opts.manifest, opts.manifestSignature, opts.trustedPublicKeys ?? []);

  const version = entry.version;
  const key = platformKey(entry);
  if (!key) {
    throw new Error(`HELM provisioning: no ${agent} engine is available for ${process.platform}/${process.arch}`);
  }
  const plat = entry.platforms[key];

  const agentRoot = path.join(enginesRoot, agent);
  const versionDir = path.join(agentRoot, version);
  const metaDir = path.join(agentRoot, ".meta");
  const metaPath = path.join(metaDir, `${agent}-${version}.json`);
  const manifestDigest = manifestDigestSha256(opts.manifest);

  const buildReceipt = async (exe: string): Promise<ProvisioningReceipt> => ({
    receiptId: `prov-${agent}-${version}-${crypto.randomBytes(6).toString("hex")}`,
    agent,
    version,
    platform: key,
    tarball: plat.tarball,
    tarballIntegrity: plat.integrity,
    binarySha512: await sha512FileHex(exe),
    manifestDigestSha256: manifestDigest,
    executablePath: exe,
    ledgerPath: metaPath,
    installedAt: new Date().toISOString(),
  });

  const persistReceipt = async (receipt: ProvisioningReceipt): Promise<void> => {
    if (!opts.receiptsDir) return;
    await fsp.mkdir(opts.receiptsDir, { recursive: true });
    await fsp.writeFile(
      path.join(opts.receiptsDir, `${receipt.receiptId}.json`),
      JSON.stringify(receipt, null, 2),
      "utf8",
    );
  };

  opts.onProgress?.({ phase: "check" });
  // Fast path: already provisioned and intact — re-verify the binary hash
  // against the ledger so a tampered cache is not silently reused.
  const existing = executablePath(versionDir, plat);
  if (existing && fs.existsSync(metaPath)) {
    try {
      const ledger = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { binarySha512?: string };
      if (ledger.binarySha512 && ledger.binarySha512 !== (await sha512FileHex(existing))) {
        throw new Error("cached engine binary hash mismatch — reprovisioning");
      }
      const receipt = await buildReceipt(existing);
      await persistReceipt(receipt);
      opts.onProgress?.({ phase: "done" });
      return { executablePath: existing, version, receipt };
    } catch (err) {
      if (err instanceof Error && err.message.includes("hash mismatch")) {
        fs.rmSync(versionDir, { recursive: true, force: true });
        fs.rmSync(metaPath, { force: true });
      } else {
        throw err;
      }
    }
  }

  fs.mkdirSync(agentRoot, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(agentRoot, `.tmp-${version}-`));
  try {
    const tarPath = path.join(tmpRoot, "engine.tgz");
    await downloadTo(plat.tarball, tarPath, opts);

    opts.onProgress?.({ phase: "verify" });
    await verifyIntegrity(tarPath, plat.integrity);

    opts.onProgress?.({ phase: "extract" });
    const extractDir = path.join(tmpRoot, "pkg");
    fs.mkdirSync(extractDir);
    extractTarball(tarPath, extractDir);

    const exe = executablePath(extractDir, plat);
    if (!exe) {
      throw new Error(`HELM provisioning: ${agent} engine binary not found at ${plat.executableRelPath} in the package`);
    }
    if (process.platform !== "win32") fs.chmodSync(exe, 0o755);

    if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
    fs.renameSync(extractDir, versionDir);

    const finalExe = executablePath(versionDir, plat);
    if (!finalExe) {
      throw new Error(`HELM provisioning: ${agent} engine binary missing after install`);
    }

    opts.onProgress?.({ phase: "receipt" });
    const receipt = await buildReceipt(finalExe);
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          version,
          platform: key,
          integrity: plat.integrity,
          executableRelPath: plat.executableRelPath,
          binarySha512: receipt.binarySha512,
          manifestDigestSha256: manifestDigest,
          installedAt: receipt.installedAt,
        },
        null,
        2,
      ),
    );
    await persistReceipt(receipt);

    pruneOldVersions(enginesRoot, agent, version);
    opts.onProgress?.({ phase: "done" });
    return { executablePath: finalExe, version, receipt };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Return the provisioned engine's executable path, or throw. The runtime path
 * deliberately does NOT download: provisioning must happen up front so the
 * user never eats a surprise multi-hundred-MB download mid-conversation.
 */
export function getProvisionedEnginePath(
  agent: string,
  manifest: EngineManifest,
  enginesRoot: string = DEFAULT_ENGINES_ROOT,
): string {
  const entry = manifest[agent];
  if (!entry) throw new Error(`HELM provisioning: no manifest entry for agent ${JSON.stringify(agent)}`);
  const key = platformKey(entry);
  const plat = key ? entry.platforms[key] : undefined;
  const exe = plat ? executablePath(path.join(enginesRoot, agent, entry.version), plat) : null;
  if (!exe) {
    throw new Error(`HELM: the ${agent} engine is not provisioned yet — provision it before starting a session`);
  }
  return exe;
}
