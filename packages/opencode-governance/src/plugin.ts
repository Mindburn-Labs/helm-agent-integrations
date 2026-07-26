/**
 * The opencode plugin: maps kernel verdicts onto opencode's permission.ask
 * slot and taps tool.execute.before/after for boundary evidence.
 *
 * Enforcement posture (fail closed, defense in depth):
 *
 * 1. `permission.ask` — when opencode triggers it, the kernel verdict is
 *    mapped ALLOW->allow, ESCALATE->ask, DENY->deny. Any kernel failure or
 *    unknown verdict material becomes deny (never ask, never allow).
 * 2. `tool.execute.before` — the enforcement point that is live in the
 *    studied opencode commit (session/tools.ts triggers it for every tool
 *    call, and a thrown error blocks execution — the documented ".env
 *    protection" pattern). Every tool call requires an exact kernel ALLOW;
 *    anything else throws HelmGovernanceDeny BEFORE the tool runs.
 * 3. `tool.execute.after` — evidence tap only; never mutates output and
 *    never throws (the effect already happened). Sink failures here are
 *    reported and, in strict mode, arm a next-call deny gate.
 *
 * Verdict caching: non-ALLOW evaluations are cached for a short TTL keyed by
 * (sessionID, callID, hash of the EXACT evaluated payload) so mutated args
 * under a reused callID can never ride a stale verdict. ALLOW outcomes are
 * never cached — every authorization is freshly evaluated. The cache is hard
 * bounded (VERDICT_CACHE_MAX_ENTRIES) so agent-driven unique denies cannot
 * exhaust memory.
 */

import type { GovernanceConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type {
  BoundaryRecord,
  EvidenceSink,
} from "./evidence.js";
import {
  BOUNDARY_CLOSE_RECORD,
  BOUNDARY_DENY_RECORD,
  BOUNDARY_OPEN_RECORD,
  JsonlEvidenceSink,
  PERMISSION_DECISION_RECORD,
  canonicalize,
  hashBoundaryValue,
  sha256Hex,
} from "./evidence.js";
import type { KernelClient, KernelEvaluationRequest, KernelOutcome } from "./kernel.js";
import { BinaryKernelClient, HttpKernelClient } from "./kernel.js";
import { homedir } from "node:os";
import type {
  OpencodeHooks,
  OpencodePermission,
  OpencodePlugin,
  OpencodePluginInput,
} from "./opencode-types.js";
import type { NormalizedVerdict } from "./verdict.js";
import { isAuthorized, verdictToPermissionStatus } from "./verdict.js";

export const PLUGIN_ID = "@helm-ai/opencode-governance";
export const PLUGIN_VERSION = "0.1.0";

const VERDICT_CACHE_TTL_MS = 30_000;
/**
 * Hard bound on cached non-ALLOW evaluations. Without it, an agent firing
 * unique denied calls could grow the map indefinitely (memory exhaustion).
 * On insert, expired entries are swept first; if still full, the oldest
 * entries are evicted (Map iteration order = insertion order).
 */
export const VERDICT_CACHE_MAX_ENTRIES = 256;

/** Error thrown from tool.execute.before to block a non-allowed tool call. */
export class HelmGovernanceDeny extends Error {
  readonly verdict: Exclude<NormalizedVerdict, "ALLOW">;
  readonly reasonCode: string;
  readonly decisionId?: string;
  readonly locallySynthesized: boolean;

  constructor(
    message: string,
    verdict: Exclude<NormalizedVerdict, "ALLOW">,
    reasonCode: string,
    options: { decisionId?: string; locallySynthesized?: boolean } = {},
  ) {
    super(message);
    this.name = "HelmGovernanceDeny";
    this.verdict = verdict;
    this.reasonCode = reasonCode;
    this.decisionId = options.decisionId;
    this.locallySynthesized = options.locallySynthesized ?? false;
  }
}

interface ResolvedEvaluation {
  verdict: NormalizedVerdict;
  reasonCode?: string;
  decisionId?: string;
  receiptId?: string;
  locallySynthesized: boolean;
  raw?: unknown;
}

function resolveOutcome(outcome: KernelOutcome): ResolvedEvaluation {
  if (outcome.kind === "verdict") {
    return {
      verdict: outcome.verdict,
      reasonCode: outcome.reasonCode,
      decisionId: outcome.decisionId,
      receiptId: outcome.receiptId,
      locallySynthesized: false,
      raw: outcome.raw,
    };
  }
  return {
    verdict: "UNKNOWN",
    reasonCode: outcome.reasonCode,
    locallySynthesized: true,
    raw: outcome.raw,
  };
}

/**
 * Best-effort execution-outcome detection for close records. opencode's
 * tool.execute.after output carries {title, output, metadata}; tool failures
 * surface as error markers in metadata when the runtime provides them
 * (error / isError / is_error). Absence of markers means "completed" — the
 * hash of the actual output is always recorded either way.
 */
export function detectExecutionOutcome(output: {
  title: string;
  output: string;
  metadata: unknown;
}): "completed" | "error" {
  if (typeof output.metadata === "object" && output.metadata !== null) {
    const metadata = output.metadata as Record<string, unknown>;
    if (
      metadata.error !== undefined && metadata.error !== null && metadata.error !== false
      && metadata.error !== ""
    ) {
      return "error";
    }
    if (metadata.isError === true || metadata.is_error === true) {
      return "error";
    }
  }
  return "completed";
}

/**
 * Recursively freeze an args object (cycle-safe). Applied to tool arguments
 * AFTER authorization so that later plugins in opencode's sequential hook
 * chain — which receive the SAME mutable args object — cannot mutate
 * arguments the kernel has already evaluated (P1
 * POST_AUTH_ARGUMENT_MUTATION). A mutation attempt on a frozen object throws
 * in ESM strict mode, failing that plugin's hook and blocking the call
 * (fail closed).
 */
export function deepFreezeArgs(value: unknown, seen: Set<object> = new Set()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreezeArgs((value as Record<string, unknown>)[key], seen);
  }
}

export interface GovernanceDeps {
  config: GovernanceConfig;
  kernel: KernelClient;
  sink: EvidenceSink;
  now?: () => Date;
  stderr?: (line: string) => void;
}

interface CachedVerdict {
  evaluation: ResolvedEvaluation;
  expiresAt: number;
}

/**
 * Build the hook bag from explicit dependencies. Exported for tests and for
 * embedding; the opencode-facing plugin factory wraps this with env config.
 */
export function createGovernanceHooks(deps: GovernanceDeps): OpencodeHooks {
  const { config, kernel, sink } = deps;
  const now = deps.now ?? (() => new Date());
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const verdictCache = new Map<string, CachedVerdict>();
  /**
   * Post-execution evidence gate. A sink failure on tool.execute.after must
   * never throw into the tool path (the effect already happened — throwing
   * would invite retries and duplicate side effects). Instead the failure is
   * reported via stderr and, in strict mode, arms this gate so the NEXT
   * pre-execution check denies with EVIDENCE_SINK_FAILURE until restart.
   */
  let evidenceGate: string | undefined;

  function baseRecord(sessionID: string, callID?: string) {
    return {
      plugin: PLUGIN_ID,
      plugin_version: PLUGIN_VERSION,
      session_id: sessionID,
      call_id: callID,
      tenant_id: config.tenantId,
      principal: config.principal,
      observed_at: now().toISOString(),
    };
  }

  async function evaluate(request: KernelEvaluationRequest): Promise<ResolvedEvaluation> {
    // The cache key binds the EXACT evaluated payload (tool + args +
    // permission material): mutated arguments under a reused callID can never
    // ride a stale verdict. ALLOW outcomes are never cached at all — every
    // authorization is freshly evaluated (fail closed against trajectory and
    // doom-loop policies that a cached ALLOW would bypass).
    const payloadHash = hashBoundaryValue({
      tool: request.tool,
      args: request.args,
      permission: request.permission,
      patterns: request.patterns,
    });
    const key = `${request.sessionID}:${request.callID ?? ""}:${payloadHash}`;
    const cached = verdictCache.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > now().getTime()) {
        return cached.evaluation;
      }
      verdictCache.delete(key);
    }
    const evaluation = resolveOutcome(await kernel.evaluate(request));
    if (evaluation.verdict !== "ALLOW") {
      // Bounded cache: sweep expired entries, then evict oldest until under
      // the hard cap (P2 UNBOUNDED_VERDICT_CACHE — agent-driven unique
      // denies must not grow memory without bound).
      const nowMs = now().getTime();
      for (const [cachedKey, entry] of verdictCache) {
        if (entry.expiresAt <= nowMs) {
          verdictCache.delete(cachedKey);
        }
      }
      while (verdictCache.size >= VERDICT_CACHE_MAX_ENTRIES) {
        const oldest = verdictCache.keys().next();
        if (oldest.done === true) {
          break;
        }
        verdictCache.delete(oldest.value);
      }
      verdictCache.set(key, {
        evaluation,
        expiresAt: nowMs + VERDICT_CACHE_TTL_MS,
      });
    }
    return evaluation;
  }

  async function appendEvidence(record: BoundaryRecord, context: string): Promise<void> {
    try {
      await sink.append(record);
    } catch (error) {
      const message = `${PLUGIN_ID}: evidence sink failure in ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (config.strictEvidence) {
        throw new HelmGovernanceDeny(message, "UNKNOWN", "EVIDENCE_SINK_FAILURE", {
          locallySynthesized: true,
        });
      }
      stderr(message);
    }
  }

  async function permissionAsk(
    input: OpencodePermission,
    output: { status: "ask" | "deny" | "allow" },
  ): Promise<void> {
    const patterns = input.pattern === undefined
      ? []
      : Array.isArray(input.pattern)
      ? input.pattern
      : [input.pattern];
    const evaluation = await evaluate({
      tool: input.type,
      sessionID: input.sessionID,
      callID: input.callID,
      args: input.metadata,
      permission: input.type,
      patterns,
      metadata: input.metadata,
    });
    const status = verdictToPermissionStatus(evaluation.verdict);
    output.status = status;
    const record: BoundaryRecord = {
      ...baseRecord(input.sessionID, input.callID),
      record_type: PERMISSION_DECISION_RECORD,
      permission: input.type,
      patterns,
      verdict: evaluation.verdict,
      mapped_status: status,
      reason_code: evaluation.reasonCode,
      decision_id: evaluation.decisionId,
      locally_synthesized: evaluation.locallySynthesized,
    };
    // A sink failure here must not throw across the permission boundary; it
    // forces deny instead (fail closed).
    try {
      await sink.append(record);
    } catch (error) {
      output.status = "deny";
      stderr(
        `${PLUGIN_ID}: evidence sink failure in permission.ask forced deny: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Best-effort deny evidence + blocking throw. The deny never depends on the sink. */
  async function recordDenyAndThrow(
    input: { tool: string; sessionID: string; callID: string },
    argsHash: string,
    evaluation: { verdict: Exclude<NormalizedVerdict, "ALLOW">; reasonCode?: string; decisionId?: string; locallySynthesized: boolean },
  ): Promise<never> {
    const record: BoundaryRecord = {
      ...baseRecord(input.sessionID, input.callID),
      record_type: BOUNDARY_DENY_RECORD,
      tool: input.tool,
      args_hash: argsHash,
      verdict: evaluation.verdict,
      reason_code: evaluation.reasonCode ?? "UNKNOWN",
      decision_id: evaluation.decisionId,
      locally_synthesized: evaluation.locallySynthesized,
    };
    try {
      await sink.append(record);
    } catch (error) {
      stderr(
        `${PLUGIN_ID}: failed to record deny evidence (denying anyway): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw new HelmGovernanceDeny(
      `${PLUGIN_ID}: tool ${JSON.stringify(input.tool)} blocked by HELM ` +
        `(verdict=${evaluation.verdict}, reason=${evaluation.reasonCode ?? "n/a"}` +
        `${evaluation.decisionId ? `, decision=${evaluation.decisionId}` : ""})`,
      evaluation.verdict,
      evaluation.reasonCode ?? "UNKNOWN",
      { decisionId: evaluation.decisionId, locallySynthesized: evaluation.locallySynthesized },
    );
  }

  async function toolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ): Promise<void> {
    // Next-call gate: a previous post-execution evidence failure blocks all
    // further execution in strict mode until the plugin is reloaded.
    if (evidenceGate !== undefined) {
      throw new HelmGovernanceDeny(
        `${PLUGIN_ID}: evidence pipeline degraded (${evidenceGate}); denying until reload`,
        "UNKNOWN",
        "EVIDENCE_SINK_FAILURE",
        { locallySynthesized: true },
      );
    }

    // P1 POST_AUTH_ARGUMENT_MUTATION defense, step 1: snapshot the exact
    // arguments at hook entry and evaluate a defensive COPY. opencode passes
    // one mutable args object sequentially through every plugin's
    // tool.execute.before hook, and our kernel evaluation awaits (yielding
    // the event loop) — a concurrently retained reference could mutate the
    // live object mid-evaluation.
    let entryCanonical: string;
    let evaluatedArgs: unknown;
    try {
      entryCanonical = canonicalize(output.args);
      evaluatedArgs = JSON.parse(entryCanonical);
    } catch (error) {
      await recordDenyAndThrow(input, "unserializable", {
        verdict: "UNKNOWN",
        reasonCode: "EVIDENCE_SERIALIZATION_FAILURE",
        locallySynthesized: true,
      });
      throw error; // unreachable; satisfies control-flow analysis
    }
    const argsHash = sha256Hex(entryCanonical);

    const evaluation = await evaluate({
      tool: input.tool,
      sessionID: input.sessionID,
      callID: input.callID,
      args: evaluatedArgs,
    });

    // P1 defense, step 2: re-verify at the last moment this hook controls.
    // If the live args object no longer matches what the kernel evaluated,
    // deny — authorization must never bind to mutated arguments.
    let postEvaluationCanonical: string;
    try {
      postEvaluationCanonical = canonicalize(output.args);
    } catch {
      postEvaluationCanonical = "<unserializable>";
    }
    if (postEvaluationCanonical !== entryCanonical) {
      await recordDenyAndThrow(input, argsHash, {
        verdict: "UNKNOWN",
        reasonCode: "ARGS_MUTATED_DURING_EVALUATION",
        locallySynthesized: true,
      });
    }

    if (!isAuthorized(evaluation.verdict)) {
      await recordDenyAndThrow(input, argsHash, {
        verdict: evaluation.verdict,
        reasonCode: evaluation.reasonCode,
        decisionId: evaluation.decisionId,
        locallySynthesized: evaluation.locallySynthesized,
      });
    }

    const record: BoundaryRecord = {
      ...baseRecord(input.sessionID, input.callID),
      record_type: BOUNDARY_OPEN_RECORD,
      tool: input.tool,
      args_hash: argsHash,
      verdict: "ALLOW",
      decision_id: evaluation.decisionId,
      receipt_id: evaluation.receiptId,
    };
    // Strict mode: failing to mint the pre-execution record blocks the call,
    // mirroring the kernel hook's "receipt-write-failure denies" posture.
    await appendEvidence(record, "tool.execute.before");

    // P1 defense, step 3: freeze the authorized args object so LATER plugins
    // in the chain cannot mutate what the kernel authorized. Mutation of a
    // frozen object throws in ESM strict mode, failing that hook and
    // blocking the call. Residual limitation (documented in README): we
    // cannot observe mutation by opencode internals or the tool itself after
    // all hooks return.
    deepFreezeArgs(output.args);
  }

  async function toolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void> {
    // Post-execution: NOTHING in this hook may throw into the tool path
    // (P2 POST_EFFECT_HASH_THROW). The effect already happened; a throw —
    // from hashing cyclic/BigInt/undefined payloads just as much as from a
    // sink failure — would surface as a tool failure and invite retries
    // with duplicate side effects. All serialization AND the sink append
    // live inside the same try; failures are reported and (strict mode)
    // arm the next-call evidence gate instead.
    try {
      const record: BoundaryRecord = {
        ...baseRecord(input.sessionID, input.callID),
        record_type: BOUNDARY_CLOSE_RECORD,
        tool: input.tool,
        args_hash: hashBoundaryValue(input.args),
        output_hash: hashBoundaryValue({ title: output.title, output: output.output }),
        outcome: detectExecutionOutcome(output),
      };
      await sink.append(record);
    } catch (error) {
      const message = `evidence failure in tool.execute.after: ${
        error instanceof Error ? error.message : String(error)
      }`;
      stderr(`${PLUGIN_ID}: ${message}`);
      if (config.strictEvidence) {
        evidenceGate = message;
      }
    }
  }

  return {
    "permission.ask": permissionAsk,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter,
  };
}

/** Build the kernel client for a resolved config (env-provided fetch/spawn). */
export function createKernelClient(config: GovernanceConfig): KernelClient {
  if (config.mode === "http") {
    return new HttpKernelClient({
      // resolveConfig guarantees these in http mode.
      kernelUrl: config.kernelUrl as string,
      apiKey: config.apiKey as string,
      tenantId: config.tenantId,
      principal: config.principal,
      riskClass: config.riskClass,
      effectClass: config.effectClass,
      timeoutMs: config.timeoutMs,
    });
  }
  return new BinaryKernelClient({
    kernelBinary: config.kernelBinary as string,
    kernelBinaryArgs: config.kernelBinaryArgs,
    tenantId: config.tenantId,
    principal: config.principal,
    riskClass: config.riskClass,
    effectClass: config.effectClass,
    timeoutMs: config.timeoutMs,
  });
}

/**
 * opencode plugin entry point. Configuration comes from process env plus the
 * opencode.json plugin options bag; invalid/missing configuration throws at
 * load time (fail closed — a governance plugin that cannot reach its
 * authority must not load silently).
 */
export const HelmGovernancePlugin: OpencodePlugin = async (
  _input: OpencodePluginInput,
  options?: Record<string, unknown>,
): Promise<OpencodeHooks> => {
  const config = resolveConfig({
    env: process.env,
    options,
    homeDir: homedir(),
  });
  return createGovernanceHooks({
    config,
    kernel: createKernelClient(config),
    sink: new JsonlEvidenceSink(config.evidenceDir),
  });
};
