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
 * 3. `tool.execute.after` — evidence tap only; never mutates output.
 *
 * Verdicts are cached per (sessionID, callID) for a short TTL so the
 * permission.ask -> tool.execute.before sequence costs one kernel evaluation.
 * The cache NEVER caches across different calls and never upgrades a deny.
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
  hashBoundaryValue,
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
    const key = request.callID === undefined ? undefined : `${request.sessionID}:${request.callID}`;
    if (key !== undefined) {
      const cached = verdictCache.get(key);
      if (cached !== undefined && cached.expiresAt > now().getTime()) {
        return cached.evaluation;
      }
      verdictCache.delete(key);
    }
    const evaluation = resolveOutcome(await kernel.evaluate(request));
    if (key !== undefined) {
      verdictCache.set(key, {
        evaluation,
        expiresAt: now().getTime() + VERDICT_CACHE_TTL_MS,
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

  async function toolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ): Promise<void> {
    const evaluation = await evaluate({
      tool: input.tool,
      sessionID: input.sessionID,
      callID: input.callID,
      args: output.args,
    });
    const argsHash = hashBoundaryValue(output.args);

    if (!isAuthorized(evaluation.verdict)) {
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
      // Deny records are best-effort: the deny itself must not depend on the
      // sink. A sink failure is logged loudly, then we still deny.
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
  }

  async function toolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void> {
    const record: BoundaryRecord = {
      ...baseRecord(input.sessionID, input.callID),
      record_type: BOUNDARY_CLOSE_RECORD,
      tool: input.tool,
      args_hash: hashBoundaryValue(input.args),
      output_hash: hashBoundaryValue({ title: output.title, output: output.output }),
      outcome: "completed",
    };
    await appendEvidence(record, "tool.execute.after");
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
