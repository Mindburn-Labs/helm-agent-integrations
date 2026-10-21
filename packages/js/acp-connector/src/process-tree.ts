import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessTermination } from "./types.js";

const exec = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type ProcessRow = { pid: number; parent: number; group: number; state: string; birth: string };

async function processes(): Promise<ProcessRow[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], { maxBuffer: 4 * 1024 * 1024, timeout: 1000 });
  return stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], state: match[4], birth: match[5] }] : [];
  });
}

/** Owns a detached POSIX process group and any observed escaped descendants. */
export class OwnedProcessTree {
  private readonly observed = new Map<number, string>();
  private termination?: Promise<ProcessTermination>;
  private monitor?: ReturnType<typeof setInterval>;
  private sampling?: Promise<ProcessRow[]>;
  private monitorFailed = false;
  private exited = false;
  private readonly exit: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    if (process.platform === "win32") throw new Error("HELM ACP: supervised process-tree termination requires POSIX");
    this.exit = new Promise(resolve => {
      child.once("exit", () => { this.exited = true; resolve(); });
      child.once("error", () => { if (!child.pid) { this.exited = true; resolve(); } });
    });
    // Sample promptly so a vendor child that detaches can still be reclaimed.
    void this.snapshot().catch(() => { this.monitorFailed = true; });
    this.monitor = setInterval(() => { void this.snapshot().catch(() => { this.monitorFailed = true; }); }, 100);
    this.monitor.unref();
  }

  private snapshot(): Promise<ProcessRow[]> {
    if (this.sampling) return this.sampling;
    this.sampling = this.readOwned().finally(() => { this.sampling = undefined; });
    return this.sampling;
  }

  private async readOwned(): Promise<ProcessRow[]> {
    const rows = await processes();
    const owned = new Set<number>();
    if (this.child.pid && !this.exited) owned.add(this.child.pid);
    const knownGroup = !this.exited || rows.some(row => row.group === this.child.pid && this.observed.get(row.pid) === row.birth);
    for (const row of rows) {
      if (this.observed.get(row.pid) === row.birth || (knownGroup && row.group === this.child.pid)) owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
    const result = rows.filter(row => owned.has(row.pid) && !row.state.startsWith("Z"));
    for (const row of result) this.observed.set(row.pid, row.birth);
    return result;
  }

  terminate(termGraceMs = 500, killGraceMs = 1500): Promise<ProcessTermination> {
    return this.termination ??= this.terminateInner(termGraceMs, killGraceMs);
  }

  private async signal(signal: NodeJS.Signals): Promise<void> {
    const rows = await this.snapshot();
    const groups = new Set(rows.map(row => row.group));
    if (this.child.pid && groups.has(this.child.pid)) {
      try { process.kill(-this.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (const row of rows) {
      if (row.group === this.child.pid) continue;
      try { process.kill(row.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }

  private async waitForEmpty(ms: number): Promise<boolean> {
    const deadline = performance.now() + ms;
    do {
      if ((await this.snapshot()).length === 0) {
        if (!this.exited) await Promise.race([this.exit, pause(25)]);
        return this.exited;
      }
      await pause(25);
    } while (performance.now() < deadline);
    return false;
  }

  private async terminateInner(termGraceMs: number, killGraceMs: number): Promise<ProcessTermination> {
    let forced = false;
    try {
      await this.signal("SIGTERM");
      if (!await this.waitForEmpty(termGraceMs)) {
        forced = true;
        await this.signal("SIGKILL");
        await this.waitForEmpty(killGraceMs);
      }
      const remaining = await this.snapshot();
      return { adapterExited: this.exited, descendantsExited: !this.monitorFailed && remaining.length === 0, forced };
    } finally {
      if (this.monitor) clearInterval(this.monitor);
    }
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("HELM ACP: cancelled", "AbortError");
}

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(new DOMException("HELM ACP: cancelled", "AbortError")); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("HELM ACP: cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
