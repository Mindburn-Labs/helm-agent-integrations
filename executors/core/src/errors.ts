// Stable failure codes and exit codes. CONTRACT.md section 2 is the spec; contract-doc.test.ts keeps them equal.

import { redactSecrets } from "./redact.js";

export type ErrorCode = "internal" | "usage" | "not_logged_in" | "no_episode" | "episode_ended" | "unavailable" | "rejected";

export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  internal: 1,
  usage: 2,
  not_logged_in: 3,
  no_episode: 4,
  episode_ended: 5,
  unavailable: 6,
  rejected: 7,
};

export class ExecutorError extends Error {
  readonly code: ErrorCode;
  /** True when a request may have been processed although no answer arrived: a timeout or a connection cut mid-flight. */
  readonly outcomeUnknown: boolean;

  constructor(code: ErrorCode, message: string, options: { outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

const MAX_REASON = 200;

/** The one stderr line every failure prints. The reason is redacted, single-line and under 200 characters. */
export function failureLine(code: ErrorCode, message: string): string {
  const reason = redactSecrets(message.slice(0, 1_000)).replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  return `helm-executor: ${code}: ${reason}\n`;
}

export function asExecutorError(err: unknown): ExecutorError {
  if (err instanceof ExecutorError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ExecutorError("internal", detail || "unexpected failure");
}
