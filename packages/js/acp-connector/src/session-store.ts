/**
 * Per-run ACP session store: persists the engine session id so a cold
 * restart resumes via session/load. Mechanism adapted (with attribution,
 * Apache-2.0) from Rowboat's code-mode acp/session-store.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
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
    return path.join(this.dir, `${safe}.json`);
  }

  async read(runId: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(this.fileFor(runId), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        typeof parsed.runId === "string" &&
        typeof parsed.agent === "string" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.sessionId === "string"
      ) {
        return parsed as StoredSession;
      }
      return null;
    } catch {
      return null;
    }
  }

  async write(session: StoredSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(session.runId);
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  async clear(runId: string): Promise<void> {
    await fs.rm(this.fileFor(runId), { force: true });
  }
}
