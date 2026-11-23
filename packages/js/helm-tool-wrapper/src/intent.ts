export interface BoundaryIntent<Input = unknown> {
  actionUrn: string;
  input: Input;
  sessionId?: string;
  principal?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
}

export const TRUSTED_AGENT_RISK_CLASS = "T2";
export const TRUSTED_AGENT_EFFECT_CLASS = "E4";

const UNTRUSTED_AUTHORITY_METADATA = [
  "principal",
  "agent_id",
  "tenant_id",
  "risk_class",
  "riskClass",
  "effect_class",
  "effectClass",
] as const;

export function withoutAuthorityMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized = { ...metadata };
  for (const key of UNTRUSTED_AUTHORITY_METADATA) {
    delete sanitized[key];
  }
  return sanitized;
}
