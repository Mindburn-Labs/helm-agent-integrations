// Library surface for in-process callers. The adapters use the CLI; this exists for tests and for a TypeScript
// front-end (the OCE plugin) that would rather not spawn a process.

export { makeCtx, type Ctx, type Env } from "./ctx.js";
export { EXIT_CODES, ExecutorError, failureLine, type ErrorCode } from "./errors.js";
export { episodeHeaders, episodeToken } from "./commands/token.js";
export { checkout } from "./commands/checkout.js";
export { stop } from "./commands/stop.js";
export { login } from "./commands/login.js";
export { observe, type ObserveOptions, type ObserveOutcome } from "./commands/observe.js";
export { buildObservation, inputDigest, summarize, EXTERNAL_VERDICT_DECISIONS, type Observation, type ExternalVerdict, type ObserveClient, type ObserveEvent } from "./observation.js";
export { redactSecrets } from "./redact.js";
export { runCli, type Io } from "./main.js";
export { VERSION } from "./http.js";
