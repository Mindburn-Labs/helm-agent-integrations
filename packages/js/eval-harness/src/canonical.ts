/**
 * Canonical JSON and SHA-256 helpers. Keys are sorted, no whitespace is
 * written, and values JSON cannot represent exactly (undefined, functions,
 * non-finite numbers) are refused rather than dropped, so two parties hashing
 * the same release get the same digest.
 */

import { createHash } from "node:crypto";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical JSON refuses non-finite numbers");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON refuses ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export interface ReleaseParts {
  specialist_id: string;
  /**
   * SHA-256 of each file that defines the specialist's behaviour: its
   * instructions, its allowlist, shared instructions, and the action catalog.
   * `catalog` is required.
   */
  components: Record<string, string>;
}

/**
 * A specialist release: SHA-256 of the canonical JSON of the specialist id and
 * its component hashes. Any change to a component makes a new release, and a
 * new release qualifies again on every route it runs on.
 */
export function releaseSha256(parts: ReleaseParts): string {
  if (typeof parts.specialist_id !== "string" || parts.specialist_id === "") {
    throw new Error("release needs a specialist_id");
  }
  const names = Object.keys(parts.components ?? {});
  if (!names.includes("catalog")) throw new Error("release needs a catalog component hash");
  for (const name of names) {
    if (!SHA256_HEX.test(parts.components[name] ?? "")) {
      throw new Error(`release component ${name} is not a lowercase SHA-256`);
    }
  }
  return canonicalSha256({ specialist_id: parts.specialist_id, components: parts.components });
}
