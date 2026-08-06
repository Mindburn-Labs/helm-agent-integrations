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
 *  - Sticky per-session allows require an explicit kernel sticky hint, bind
 *    the complete canonical request, and carry decision + receipt ids.
 */

import type {
  PermissionAsk,
  PermissionDecision,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./types.js";
import { READ_TOOL_KINDS, toolInputSha256, type KernelEvaluator } from "./kernel-evaluator.js";

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

function memoryKey(ask: PermissionAsk): string {
  return toolInputSha256({
    sessionId: ask.sessionId,
    title: ask.title,
    kind: ask.kind ?? null,
    toolInput: ask.toolInput ?? null,
  });
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

    const finish = (
      decision: PermissionDecision,
      auto: boolean,
      receiptId?: string,
    ): RequestPermissionResponse => {
      this.opts.onResolved?.(ask, decision, auto, receiptId);
      const opt = pickPermissionOption(request.options ?? [], decision);
      if (opt) return selected(opt.optionId);
      // An unknown option kind has unknown authority semantics. Never select
      // an arbitrary first option, even after Kernel ALLOW.
      return { outcome: { outcome: "cancelled" } };
    };

    let key: string;
    try {
      key = memoryKey(ask);
    } catch {
      return finish("reject", true);
    }

    // 1. Exact-payload sticky allow from earlier this session — itself the
    //    product of a kernel ALLOW, recorded with decision + receipt ids.
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

    if (verdict.verdict !== "ALLOW" || !verdict.decisionId || !verdict.receiptId) {
      return finish("reject", true, verdict.receiptId);
    }

    // Reuse is permitted only when the Kernel explicitly marks the exact
    // payload sticky and the agent offered an allow-always option.
    const sticky =
      verdict.stickyAllow === true &&
      (request.options ?? []).some((option) => option.kind === "allow_always");
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
