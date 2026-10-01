// Actual adapter declarations; these are neither a control implementation nor authority.
import { readFileSync } from "node:fs";

export const CONTROL_EXTENSION_URI = "urn:helm:a2a:episode-control:v1";
export const STEER = "helm/episode.steer";
export const PAUSE = "helm/episode.pause";
export const RESUME = "helm/episode.resume";

export interface ControlCapabilities {
  schema: string;
  verbs: Record<string, { supported: false; reason: string }>;
}

export function controlCapabilities(framework: string): ControlCapabilities {
  const profile = JSON.parse(readFileSync(
    new URL("../schema/episode-control.profile.json", import.meta.url), "utf8",
  )) as { schema: string; verbs: string[]; default_reason: string; unsupported: Record<string, string> };
  const reason = Object.hasOwn(profile.unsupported, framework)
    ? profile.unsupported[framework]! : profile.default_reason;
  return {
    schema: profile.schema,
    verbs: Object.fromEntries(profile.verbs.map((verb) => [verb, { supported: false as const, reason }])),
  };
}
