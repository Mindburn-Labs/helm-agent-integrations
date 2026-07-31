/**
 * Kernel-gated ACP permission broker.
 *
 * Tiering mechanism adapted (with attribution, Apache-2.0) from Rowboat's
 * code-mode PermissionBroker (apps/x/packages/core/src/code-mode/acp/
 * permission-broker.ts): sticky per-session allows, a low-risk read tier, and
 * option-family fallback mapping so a decision always lands on an option the
 * agent actually offered. Reimplemented against HELM doctrine:
 *
 *  - Every permission request is routed through a Kernel verdict. There is no
 *    local "yolo": the heaviest local convenience is auto-approve-reads, and
 *    even that only classifies the request into the low-risk tier — the
 *    kernel still issues the verdict.
 *  - Fail-closed default: DENY / ESCALATE / PENDING / transport error /
 *    timeout all resolve to a rejection, never an allow.
 *  - Sticky per-session allows are recorded as receipts: each sticky entry
 *    carries the kernel decisionId/receiptId that authorized it, so the
 *    "always allow" convenience remains auditable evidence.
 */

import type {
  PermissionAsk,
  PermissionDecision,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./types.js";
import { READ_TOOL_KINDS, type KernelEvaluator } from "./kernel-evaluator.js";

function toAsk(request: RequestPermissionRequest): PermissionAsk {
  const tc = request.toolCall ?? {};
  const kind = typeof tc.kind === "string" ? tc.kind : undefined;
  const title = typeof tc.title === "string" && tc.title ? tc.title : kind ?? "Tool call";
  return {
    toolCallId: typeof tc.toolCallId === "string" ? tc.toolCallId : undefined,
    title,
    kind,
    isRead: kind ? READ_TOOL_KINDS.has(kind) : false,
    sessionId: request.sessionId,
    // The full adapter-supplied tool-call payload (rawInput, locations,
    // content, …) — the kernel authorizes this, not the title/kind label.
    toolInput: tc,
  };
}

/**
 * Map a desired decision onto an option the agent actually offered, falling
 * back within the same allow/reject family. Mechanism adapted from Rowboat's
 * pickOption (Apache-2.0, see header note).
 */
export function pickPermissionOption(
  options: PermissionOption[],
  decision: PermissionDecision,
): PermissionOption | undefined {
  const order: Record<PermissionDecision, PermissionOptionKind[]> = {
    allow_always: ["allow_always", "allow_once"],
    allow_once: ["allow_once", "allow_always"],
    reject: ["reject_once", "reject_always"],
  };
  for (const kind of order[decision]) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * Best-effort canonical target for a tool call: the shell command, file path,
 * or URL the call actually acts on, taken from the adapter-supplied payload
 * (ACP rawInput / locations). Sticky allows key on this so an "always allow"
 * for `execute: ls` does NOT silently extend to `execute: rm -rf …`.
 */
export function canonicalAskTarget(ask: PermissionAsk): string | undefined {
  const input = ask.toolInput;
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const rawInput = (rec.rawInput ?? undefined) as Record<string, unknown> | undefined;
  const firstLocation = Array.isArray(rec.locations)
    ? (rec.locations[0] as { path?: unknown } | undefined)?.path
    : undefined;
  const candidates: unknown[] = [
    rawInput?.command,
    rawInput?.file_path,
    rawInput?.path,
    rawInput?.url,
    firstLocation,
    rec.command,
    rec.path,
    rec.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c !== "") return c.slice(0, 512);
  }
  return undefined;
}

function memoryKey(ask: PermissionAsk): string {
  const target = canonicalAskTarget(ask);
  if (ask.kind && target) return `kind:${ask.kind}:target:${target}`;
  if (ask.kind) return `kind:${ask.kind}`;
  return `title:${ask.title}`;
}

/** A sticky allow with its authorizing evidence — the recorded receipt. */
export interface StickyAllowReceipt {
  key: string;
  decisionId?: string;
  receiptId?: string;
  tier: "low" | "standard";
  recordedAt: string;
}

export interface GovernedPermissionBrokerOptions {
  evaluator: KernelEvaluator;
  policy: "ask" | "auto-approve-reads";
  agent: string;
  cwd: string;
  /** Notified of every resolved request (stream event + evidence trail). */
  onResolved?: (ask: PermissionAsk, decision: PermissionDecision, auto: boolean, receiptId?: string) => void;
  /** Sink for sticky-allow receipts (e.g. append to a run evidence log). */
  onStickyAllow?: (receipt: StickyAllowReceipt) => void;
}

export class GovernedPermissionBroker {
  private readonly opts: GovernedPermissionBrokerOptions;
  private readonly sticky = new Map<string, StickyAllowReceipt>();

  constructor(opts: GovernedPermissionBrokerOptions) {
    this.opts = opts;
  }

  /** Sticky allows recorded so far (evidence surface for the run). */
  stickyAllowReceipts(): StickyAllowReceipt[] {
    return [...this.sticky.values()];
  }

  async resolve(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const ask = toAsk(request);
    const key = memoryKey(ask);

    const finish = (
      decision: PermissionDecision,
      auto: boolean,
      receiptId?: string,
    ): RequestPermissionResponse => {
      this.opts.onResolved?.(ask, decision, auto, receiptId);
      const opt = pickPermissionOption(request.options ?? [], decision);
      // If the agent offered no matching option, fall back to its first one
      // rather than deadlocking the turn. A reject with no offered option is
      // answered as cancelled — fail-closed either way.
      if (opt) return selected(opt.optionId);
      const first = request.options?.[0];
      if (first && decision !== "reject") return selected(first.optionId);
      return { outcome: { outcome: "cancelled" } };
    };

    // 1. Sticky allow from earlier this session — itself the product of a
    //    kernel ALLOW, recorded with its receipt.
    const prior = this.sticky.get(key);
    if (prior) return finish("allow_always", true, prior.receiptId);

    // 2. Low-risk tier classification. auto-approve-reads never decides
    //    locally; it only marks the request low-risk for the kernel.
    const tier: "low" | "standard" =
      this.opts.policy === "auto-approve-reads" && ask.isRead ? "low" : "standard";

    // 3. Kernel verdict. Fail-closed: any error or non-ALLOW verdict rejects.
    let verdict;
    try {
      verdict = await this.opts.evaluator.evaluate({
        ask,
        tier,
        agent: this.opts.agent,
        cwd: this.opts.cwd,
        policy: this.opts.policy,
      });
    } catch {
      return finish("reject", true);
    }

    if (verdict.verdict !== "ALLOW") {
      return finish("reject", true, verdict.receiptId);
    }

    // Kernel ALLOW. Sticky recording: only when the kernel marks the allow
    // sticky, or for the low-risk tier under auto-approve-reads (the
    // documented lightweight tier beneath the approval ceremony).
    const sticky = verdict.stickyAllow === true || tier === "low";
    if (sticky) {
      const receipt: StickyAllowReceipt = {
        key,
        decisionId: verdict.decisionId,
        receiptId: verdict.receiptId,
        tier,
        recordedAt: new Date().toISOString(),
      };
      this.sticky.set(key, receipt);
      this.opts.onStickyAllow?.(receipt);
      return finish("allow_always", true, verdict.receiptId);
    }
    return finish("allow_once", true, verdict.receiptId);
  }
}
