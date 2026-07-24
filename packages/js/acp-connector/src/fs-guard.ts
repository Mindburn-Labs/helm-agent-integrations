/**
 * Declarative filesystem allowlist for ACP fs handlers.
 *
 * THE counter-position to Rowboat's central trust-model hole: Rowboat's ACP
 * client implements readTextFile/writeTextFile as raw fs calls on any
 * absolute path (apps/x/packages/core/src/code-mode/acp/client.ts:341-348),
 * giving the spawned engine the user's full filesystem reach. This connector
 * fail-closes instead: a path is served only when it canonicalizes inside a
 * declared allowlist root with the required capability.
 *
 * Canonicalization mechanism adapted (with attribution, Apache-2.0) from
 * Rowboat's own contained-browsing path (code-mode/projects/fs.ts
 * resolveContained) and permission path (filesystem/files.ts
 * resolveFilePathForPermission): realpath the target when it exists, and
 * realpath-walk-up to the deepest existing ancestor when it does not, so
 * symlinked ancestors cannot launder an outside path into an inside one.
 * There is exactly ONE containment check here — Rowboat's own code comment
 * (filesystem/files.ts) warns that "a divergent copy is a permission-bypass
 * risk", and their workspace.ts drifted exactly that way.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface FsAllowlistRoot {
  /** Absolute (or ~) root directory. Canonicalized at construction. */
  path: string;
  read: boolean;
  write: boolean;
}

export interface FsGuardOptions {
  roots: FsAllowlistRoot[];
}

export type FsCapability = "read" | "write";

export class FsAccessDeniedError extends Error {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly capability: FsCapability;

  constructor(requestedPath: string, canonicalPath: string, capability: FsCapability) {
    super(
      `HELM ACP fs guard: ${capability} denied for ${JSON.stringify(requestedPath)} ` +
        `(canonical: ${JSON.stringify(canonicalPath)}) — outside the declarative allowlist`,
    );
    this.name = "FsAccessDeniedError";
    this.requestedPath = requestedPath;
    this.canonicalPath = canonicalPath;
    this.capability = capability;
  }
}

/** THE one containment check. Do not reimplement elsewhere in this package. */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Canonicalize a possibly-non-existent path: realpath the path itself when it
 * exists; otherwise walk up to the deepest existing ancestor, realpath that,
 * and re-append the missing tail. A symlink anywhere in the existing prefix
 * (including a final-component symlink) resolves to its true target, so the
 * subsequent isPathInside check decides on the real location.
 */
export async function canonicalizePath(resolvedPath: string): Promise<string> {
  try {
    return await fs.realpath(resolvedPath);
  } catch {
    const missing: string[] = [];
    let current = resolvedPath;
    const root = path.parse(resolvedPath).root;
    while (current !== root) {
      try {
        const canonicalParent = await fs.realpath(current);
        return path.join(canonicalParent, ...missing.reverse());
      } catch {
        missing.push(path.basename(current));
        current = path.dirname(current);
      }
    }
    return resolvedPath;
  }
}

interface CanonicalRoot {
  canonicalPath: string;
  read: boolean;
  write: boolean;
}

/**
 * Fail-closed filesystem guard. Every engine fs request is canonicalized and
 * checked against the declared roots; anything outside (or lacking the
 * capability) is denied before any disk access happens.
 */
export class FsGuard {
  private rootsPromise: Promise<CanonicalRoot[]> | null = null;
  private readonly declaredRoots: FsAllowlistRoot[];

  constructor(opts: FsGuardOptions) {
    if (!opts.roots || opts.roots.length === 0) {
      throw new Error("FsGuard requires at least one allowlist root (fail-closed: no implicit roots)");
    }
    this.declaredRoots = opts.roots;
  }

  /** Lazily canonicalize the declared roots once per process. */
  private roots(): Promise<CanonicalRoot[]> {
    if (!this.rootsPromise) {
      this.rootsPromise = Promise.all(
        this.declaredRoots.map(async (r) => ({
          canonicalPath: await canonicalizePath(path.resolve(r.path)),
          read: r.read,
          write: r.write,
        })),
      );
    }
    return this.rootsPromise;
  }

  /**
   * Resolve and authorize a path for the given capability. Returns the
   * canonical absolute path to operate on. Throws FsAccessDeniedError when
   * no allowlist root grants the capability at the canonical location.
   */
  async authorize(requestedPath: string, capability: FsCapability): Promise<string> {
    if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
      throw new FsAccessDeniedError(String(requestedPath), "", capability);
    }
    const resolved = path.resolve(requestedPath);
    const canonical = await canonicalizePath(resolved);
    const roots = await this.roots();
    for (const root of roots) {
      if (capability === "read" && !root.read) continue;
      if (capability === "write" && !root.write) continue;
      if (isPathInside(root.canonicalPath, canonical)) {
        return canonical;
      }
    }
    throw new FsAccessDeniedError(requestedPath, canonical, capability);
  }

  /** ACP fs/read_text_file handler. Supports optional line/limit paging. */
  async readTextFile(params: { path: string; line?: number | null; limit?: number | null }): Promise<{ content: string }> {
    const canonical = await this.authorize(params.path, "read");
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${params.path}`);
    }
    const raw = await fs.readFile(canonical, "utf8");
    const line = params.line ?? null;
    const limit = params.limit ?? null;
    if (line === null && limit === null) {
      return { content: raw };
    }
    const lines = raw.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const slice = limit === null ? lines.slice(start) : lines.slice(start, start + Math.max(0, limit));
    return { content: slice.join("\n") };
  }

  /** ACP fs/write_text_file handler. */
  async writeTextFile(params: { path: string; content: string }): Promise<Record<string, never>> {
    const canonical = await this.authorize(params.path, "write");
    await fs.writeFile(canonical, params.content, "utf8");
    return {};
  }
}
