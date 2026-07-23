/**
 * Plugin configuration: environment variables + opencode.json plugin options.
 *
 * Fail-closed law: missing or invalid required configuration is a hard error
 * at plugin initialization. There is deliberately NO disable/bypass flag and
 * no default that would let the plugin load without a reachable kernel
 * target — a governance plugin that cannot reach its authority must not load
 * silently and wave traffic through.
 */

export type KernelMode = "http" | "binary";

export interface GovernanceConfig {
  mode: KernelMode;
  /** http mode: base URL of the HELM kernel (or control-plane PEP façade). */
  kernelUrl?: string;
  /** http mode: bearer token for the tenant-scoped evaluate endpoint. */
  apiKey?: string;
  /** binary mode: path to the local kernel binary (e.g. helm-ai-kernel). */
  kernelBinary?: string;
  /** binary mode: argv placed between the binary path and the payload. */
  kernelBinaryArgs: string[];
  tenantId: string;
  principal: string;
  riskClass: string;
  effectClass: string;
  /** Directory where boundary evidence records are appended (JSONL). */
  evidenceDir: string;
  /** Milliseconds before a kernel evaluation is aborted -> DENY. */
  timeoutMs: number;
  /**
   * When true (default), a failure to write the pre-execution evidence record
   * blocks the tool call (mirrors the kernel hook behavior where receipt
   * write failure denies). Set HELM_EVIDENCE_STRICT=0 only for development.
   */
  strictEvidence: boolean;
}

export class GovernanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceConfigError";
  }
}

const SUPPORTED_RISK_CLASSES = new Set(["T0", "T1", "T2", "T3"]);
const SUPPORTED_EFFECT_CLASSES = new Set(["E0", "E1", "E2", "E3", "E4"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export interface ConfigSource {
  env: Record<string, string | undefined>;
  options?: Record<string, unknown>;
  /** Used only to derive the default evidence dir. */
  homeDir: string;
}

function pick(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  optionKey: string,
  envKey: string,
): string | undefined {
  const fromOptions = options?.[optionKey];
  if (typeof fromOptions === "string" && fromOptions.trim() !== "") {
    return fromOptions.trim();
  }
  const fromEnv = env[envKey];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return undefined;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: missing required configuration ${name} (fail closed: refusing to load)`,
    );
  }
  return value;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: HELM_TIMEOUT_MS must be an integer in 1..${MAX_TIMEOUT_MS}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

function parseStrictEvidence(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new GovernanceConfigError(
    `@helm-ai/opencode-governance: HELM_EVIDENCE_STRICT must be a boolean, got ${JSON.stringify(raw)}`,
  );
}

function normalizeClassification(
  value: string | undefined,
  fallback: string,
  supported: Set<string>,
  name: string,
): string {
  const normalized = value?.trim().toUpperCase() || fallback;
  if (!supported.has(normalized)) {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: unsupported ${name} ${JSON.stringify(value)} (supported: ${[...supported].join(", ")})`,
    );
  }
  return normalized;
}

/**
 * Resolve plugin configuration. Precedence: explicit plugin options
 * (opencode.json `["@helm-ai/opencode-governance", { ... }]`) > environment
 * variables > documented defaults. Required fields have no default.
 */
export function resolveConfig(source: ConfigSource): GovernanceConfig {
  const { env, options, homeDir } = source;

  const explicitMode = pick(options, env, "mode", "HELM_KERNEL_MODE");
  const kernelUrl = pick(options, env, "kernelUrl", "HELM_KERNEL_URL");
  const kernelBinary = pick(options, env, "kernelBinary", "HELM_KERNEL_BINARY");

  let mode: KernelMode;
  if (explicitMode !== undefined) {
    if (explicitMode !== "http" && explicitMode !== "binary") {
      throw new GovernanceConfigError(
        `@helm-ai/opencode-governance: HELM_KERNEL_MODE must be "http" or "binary", got ${JSON.stringify(explicitMode)}`,
      );
    }
    mode = explicitMode;
  } else if (kernelUrl !== undefined && kernelBinary === undefined) {
    mode = "http";
  } else if (kernelBinary !== undefined && kernelUrl === undefined) {
    mode = "binary";
  } else if (kernelUrl !== undefined && kernelBinary !== undefined) {
    throw new GovernanceConfigError(
      "@helm-ai/opencode-governance: both HELM_KERNEL_URL and HELM_KERNEL_BINARY are set; " +
        "set HELM_KERNEL_MODE=http|binary explicitly (fail closed: refusing to guess the authority)",
    );
  } else {
    throw new GovernanceConfigError(
      "@helm-ai/opencode-governance: no kernel target configured; set HELM_KERNEL_URL (http) " +
        "or HELM_KERNEL_BINARY (binary) (fail closed: refusing to load without an authority)",
    );
  }

  const apiKey = pick(options, env, "apiKey", "HELM_API_KEY");
  if (mode === "http") {
    requireValue(kernelUrl, "HELM_KERNEL_URL");
    requireValue(apiKey, "HELM_API_KEY");
  } else {
    requireValue(kernelBinary, "HELM_KERNEL_BINARY");
  }

  const tenantId = requireValue(pick(options, env, "tenantId", "HELM_TENANT_ID"), "HELM_TENANT_ID");
  const principal = requireValue(pick(options, env, "principal", "HELM_PRINCIPAL"), "HELM_PRINCIPAL");

  const binaryArgsRaw = options?.["kernelBinaryArgs"];
  let kernelBinaryArgs: string[] = [];
  if (Array.isArray(binaryArgsRaw) && binaryArgsRaw.every((item) => typeof item === "string")) {
    kernelBinaryArgs = binaryArgsRaw as string[];
  } else if (typeof env.HELM_KERNEL_BINARY_ARGS === "string" && env.HELM_KERNEL_BINARY_ARGS.trim() !== "") {
    kernelBinaryArgs = env.HELM_KERNEL_BINARY_ARGS.trim().split(/\s+/);
  }

  return {
    mode,
    kernelUrl: kernelUrl?.replace(/\/$/, ""),
    apiKey,
    kernelBinary,
    kernelBinaryArgs,
    tenantId,
    principal,
    riskClass: normalizeClassification(
      pick(options, env, "riskClass", "HELM_RISK_CLASS"),
      "T2",
      SUPPORTED_RISK_CLASSES,
      "riskClass",
    ),
    effectClass: normalizeClassification(
      pick(options, env, "effectClass", "HELM_EFFECT_CLASS"),
      "E4",
      SUPPORTED_EFFECT_CLASSES,
      "effectClass",
    ),
    evidenceDir: pick(options, env, "evidenceDir", "HELM_EVIDENCE_DIR")
      ?? `${homeDir}/.helm-ai-kernel/evidence/opencode`,
    timeoutMs: parseTimeout(pick(options, env, "timeoutMs", "HELM_TIMEOUT_MS")),
    strictEvidence: parseStrictEvidence(pick(options, env, "strictEvidence", "HELM_EVIDENCE_STRICT")),
  };
}
