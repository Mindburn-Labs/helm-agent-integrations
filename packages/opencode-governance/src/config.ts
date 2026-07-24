/**
 * Plugin configuration: environment variables + opencode.json plugin options.
 *
 * Fail-closed law: missing or invalid required configuration is a hard error
 * at plugin initialization. There is deliberately NO disable/bypass flag and
 * no default that would let the plugin load without a reachable kernel
 * target — a governance plugin that cannot reach its authority must not load
 * silently and wave traffic through.
 *
 * Type discipline (P2 CONFIG_OPTION_TYPES_IGNORED): plugin options may carry
 * native JSON types (boolean strictEvidence, numeric timeoutMs, string-array
 * kernelBinaryArgs). A value of the WRONG type is a hard configuration
 * error — type confusion is never silently ignored in favor of env/default
 * values, since silent fallback could weaken strict evidence gating.
 *
 * Transport security (P1 INSECURE_KERNEL_TRANSPORT): plaintext http kernel
 * URLs are accepted only for loopback targets; anything else requires https.
 * Bearer credentials and authorization verdicts must never traverse an
 * interceptable network path.
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

/**
 * Resolve a raw config value: explicit plugin options win over env. Native
 * JSON option values are passed through for field-level validation; empty
 * strings are treated as absent (matching the previous env-fallback
 * behavior). Returns undefined when neither source provides a value.
 */
function pickRaw(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  optionKey: string,
  envKey: string,
): unknown {
  if (options !== undefined && options[optionKey] !== undefined) {
    const value = options[optionKey];
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    return value;
  }
  const fromEnv = env[envKey];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return undefined;
}

/** String fields: any non-string native value is a hard type-confusion error. */
function stringField(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: ${name} must be a string, got ${
        Array.isArray(value) ? "array" : typeof value
      } (fail closed: type confusion is never silently ignored)`,
    );
  }
  return value;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: missing required configuration ${name} (fail closed: refusing to load)`,
    );
  }
  return value;
}

function parseTimeout(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string") {
    parsed = Number.parseInt(raw, 10);
  } else {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: HELM_TIMEOUT_MS must be a number or numeric string, got ${typeof raw}`,
    );
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: HELM_TIMEOUT_MS must be an integer in 1..${MAX_TIMEOUT_MS}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

function parseStrictEvidence(raw: unknown): boolean {
  if (raw === undefined) {
    return true;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  throw new GovernanceConfigError(
    `@helm-ai/opencode-governance: HELM_EVIDENCE_STRICT must be a boolean, got ${JSON.stringify(raw)}`,
  );
}

function parseBinaryArgs(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const fromOptions = options?.["kernelBinaryArgs"];
  if (fromOptions !== undefined) {
    if (Array.isArray(fromOptions) && fromOptions.every((item) => typeof item === "string")) {
      return fromOptions as string[];
    }
    throw new GovernanceConfigError(
      "@helm-ai/opencode-governance: kernelBinaryArgs option must be an array of strings",
    );
  }
  if (typeof env.HELM_KERNEL_BINARY_ARGS === "string" && env.HELM_KERNEL_BINARY_ARGS.trim() !== "") {
    return env.HELM_KERNEL_BINARY_ARGS.trim().split(/\s+/);
  }
  return [];
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
 * Transport security: plaintext http is loopback-only. Returns the
 * normalized URL (trailing slash stripped) or throws.
 */
export function assertSecureKernelUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: HELM_KERNEL_URL is not a valid URL: ${JSON.stringify(rawUrl)}`,
    );
  }
  if (parsed.protocol === "https:") {
    return rawUrl.replace(/\/$/, "");
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "localhost"
      || host.endsWith(".localhost")
      || host === "::1"
      || host === "[::1]"
      || (host.startsWith("127.") && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
    if (isLoopback) {
      return rawUrl.replace(/\/$/, "");
    }
    throw new GovernanceConfigError(
      `@helm-ai/opencode-governance: HELM_KERNEL_URL ${JSON.stringify(rawUrl)} uses plaintext http for a ` +
        "non-loopback host; bearer credentials and verdicts must not traverse an interceptable path. " +
        "Use https (or a loopback address for a local kernel).",
    );
  }
  throw new GovernanceConfigError(
    `@helm-ai/opencode-governance: HELM_KERNEL_URL must use https (or http on loopback), got protocol ${parsed.protocol}`,
  );
}

/**
 * Resolve plugin configuration. Precedence: explicit plugin options
 * (opencode.json `["@helm-ai/opencode-governance", { ... }]`) > environment
 * variables > documented defaults. Required fields have no default.
 */
export function resolveConfig(source: ConfigSource): GovernanceConfig {
  const { env, options, homeDir } = source;

  const explicitMode = stringField(pickRaw(options, env, "mode", "HELM_KERNEL_MODE"), "HELM_KERNEL_MODE");
  const kernelUrl = stringField(pickRaw(options, env, "kernelUrl", "HELM_KERNEL_URL"), "HELM_KERNEL_URL");
  const kernelBinary = stringField(
    pickRaw(options, env, "kernelBinary", "HELM_KERNEL_BINARY"),
    "HELM_KERNEL_BINARY",
  );

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

  const apiKey = stringField(pickRaw(options, env, "apiKey", "HELM_API_KEY"), "HELM_API_KEY");
  let secureKernelUrl: string | undefined;
  if (mode === "http") {
    requireValue(kernelUrl, "HELM_KERNEL_URL");
    requireValue(apiKey, "HELM_API_KEY");
    secureKernelUrl = assertSecureKernelUrl(kernelUrl as string);
  } else {
    requireValue(kernelBinary, "HELM_KERNEL_BINARY");
  }

  const tenantId = requireValue(
    stringField(pickRaw(options, env, "tenantId", "HELM_TENANT_ID"), "HELM_TENANT_ID"),
    "HELM_TENANT_ID",
  );
  const principal = requireValue(
    stringField(pickRaw(options, env, "principal", "HELM_PRINCIPAL"), "HELM_PRINCIPAL"),
    "HELM_PRINCIPAL",
  );

  return {
    mode,
    kernelUrl: secureKernelUrl,
    apiKey,
    kernelBinary,
    kernelBinaryArgs: parseBinaryArgs(options, env),
    tenantId,
    principal,
    riskClass: normalizeClassification(
      stringField(pickRaw(options, env, "riskClass", "HELM_RISK_CLASS"), "HELM_RISK_CLASS"),
      "T2",
      SUPPORTED_RISK_CLASSES,
      "riskClass",
    ),
    effectClass: normalizeClassification(
      stringField(pickRaw(options, env, "effectClass", "HELM_EFFECT_CLASS"), "HELM_EFFECT_CLASS"),
      "E4",
      SUPPORTED_EFFECT_CLASSES,
      "effectClass",
    ),
    evidenceDir: stringField(pickRaw(options, env, "evidenceDir", "HELM_EVIDENCE_DIR"), "HELM_EVIDENCE_DIR")
      ?? `${homeDir}/.helm-ai-kernel/evidence/opencode`,
    timeoutMs: parseTimeout(pickRaw(options, env, "timeoutMs", "HELM_TIMEOUT_MS")),
    strictEvidence: parseStrictEvidence(pickRaw(options, env, "strictEvidence", "HELM_EVIDENCE_STRICT")),
  };
}
