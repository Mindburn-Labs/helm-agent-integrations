/**
 * Per-run ACP session store: persists the engine session id so a cold
 * restart resumes via session/load. Mechanism adapted (with attribution,
 * Apache-2.0) from Rowboat's code-mode acp/session-store.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { CodingAgent } from "./types.js";

export interface StoredSession {
  runId: string;
  agent: CodingAgent;
  cwd: string;
  sessionId: string;
}

export class SessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
    // Sanitization alone is not injective — distinct runIds ("a/b", "a:b")
    // collapse to the same filename. Bind the file to the exact runId with a
    // hash suffix; read() additionally requires the stored runId to match.
    const digest = crypto.createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 16);
    return path.join(this.dir, `${safe}-${digest}.json`);
  }

  async read(runId: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(this.fileFor(runId), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        typeof parsed.runId === "string" &&
        typeof parsed.agent === "string" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.sessionId === "string" &&
        // The file must belong to THIS runId — a filename collision or a
        // swapped file must never resume another run's session.
        parsed.runId === runId
      ) {
        return parsed as StoredSession;
      }
      return null;
    } catch {
      return null;
    }
  }

  async write(session: StoredSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.fileFor(session.runId);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(session, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async clear(runId: string): Promise<void> {
    await fs.rm(this.fileFor(runId), { force: true });
  }
}
