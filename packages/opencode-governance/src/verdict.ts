/**
 * Kernel verdict normalization and opencode permission-status mapping.
 *
 * Fail-closed law (HELM invariant): only the exact kernel verdicts ALLOW,
 * DENY, and ESCALATE are recognized. Anything else — unknown strings, missing
 * fields, malformed payloads, transport failures represented upstream — maps
 * to DENY. Locally synthesized outcomes carry reason codes that cannot be
 * confused with kernel-signed evidence (pattern stolen from
 * svc-helm-control-plane/internal/kernel/evaluate_client.go, see
 * research/opencode-study/26-helm-map-kernel-governance.md §3.1).
 */

export const KERNEL_VERDICTS = ["ALLOW", "DENY", "ESCALATE"] as const;
export type KernelVerdict = (typeof KERNEL_VERDICTS)[number];

/** Marker for any verdict material that is not an exact kernel verdict. */
export type UnknownVerdict = "UNKNOWN";
export type NormalizedVerdict = KernelVerdict | UnknownVerdict;

/**
 * Reason codes for locally synthesized (unsigned) deny outcomes.
 * These are deliberately disjoint from kernel-issued reason codes.
 */
export const LOCAL_DENY_REASONS = [
  "KERNEL_UNAVAILABLE",
  "KERNEL_UNKNOWN_VERDICT",
  "KERNEL_MALFORMED_RESPONSE",
  "PLUGIN_MISCONFIGURED",
  "EVIDENCE_SINK_FAILURE",
] as const;
export type LocalDenyReason = (typeof LOCAL_DENY_REASONS)[number];

/** opencode permission.ask status values. */
export type PermissionStatus = "allow" | "deny" | "ask";

/**
 * Normalize raw verdict material. Case-insensitive trim; everything that is
 * not exactly ALLOW/DENY/ESCALATE becomes UNKNOWN (fail closed).
 */
export function normalizeVerdict(raw: unknown): NormalizedVerdict {
  if (typeof raw !== "string") {
    return "UNKNOWN";
  }
  const candidate = raw.trim().toUpperCase();
  return (KERNEL_VERDICTS as readonly string[]).includes(candidate)
    ? candidate as KernelVerdict
    : "UNKNOWN";
}

/**
 * Map a normalized verdict onto opencode's permission status slot.
 *
 * - ALLOW     -> allow
 * - ESCALATE  -> ask   (human/approval ceremony decides; HELM never auto-allows)
 * - DENY      -> deny
 * - UNKNOWN   -> deny  (fail closed: unknown material is never ask/allow)
 */
export function verdictToPermissionStatus(verdict: NormalizedVerdict): PermissionStatus {
  switch (verdict) {
    case "ALLOW":
      return "allow";
    case "ESCALATE":
      return "ask";
    default:
      return "deny";
  }
}

/**
 * Whether a normalized verdict authorizes tool execution.
 * Only an exact ALLOW authorizes; UNKNOWN never does.
 */
export function isAuthorized(verdict: NormalizedVerdict): verdict is "ALLOW" {
  return verdict === "ALLOW";
}
