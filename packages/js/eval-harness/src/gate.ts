/**
 * Fail-closed route gate.
 *
 * A live or shadow run of a specialist uses a route only when the owner
 * recorded a passed qualification for exactly that specialist, provider,
 * model, effort and release, and no later record for the same key failed.
 * Until then the run abstains `no_qualified_route` before any provider call:
 * no specialist acts on a route nobody qualified. An unqualified primary is
 * not rescued by failing over; unqualified fallbacks are dropped. Eval and
 * synthetic runs need no qualification.
 */

import { SHA256_HEX } from "./canonical.js";
import type { QualificationRecord } from "./qualification.js";
import { RECORD_SCHEMA, type Route } from "./types.js";

export const NO_QUALIFIED_ROUTE = "no_qualified_route" as const;

export type RunClass = "live" | "shadow" | "eval" | "synthetic";
const UNGATED: ReadonlySet<string> = new Set(["eval", "synthetic"]);
const GATED: ReadonlySet<string> = new Set(["live", "shadow"]);

function routeKey(specialistId: string, route: { provider: string; model: string; effort?: string | null }, release: string): string {
  return JSON.stringify([specialistId, route.provider, route.model, route.effort ?? null, release]);
}

function wellFormed(record: QualificationRecord): boolean {
  return (
    record?.schema_version === RECORD_SCHEMA &&
    typeof record.qualification_id === "string" &&
    record.qualification_id !== "" &&
    typeof record.specialist_id === "string" &&
    typeof record.route?.provider === "string" &&
    typeof record.route?.model === "string" &&
    SHA256_HEX.test(record.release_sha256) &&
    SHA256_HEX.test(record.report_sha256) &&
    typeof record.passed === "boolean" &&
    record.recorded_by?.role === "owner" &&
    typeof record.recorded_by.ref === "string" &&
    record.recorded_by.ref !== "" &&
    Number.isInteger(record.sequence)
  );
}

/** The key a record claims, read defensively so a malformed record can still be attributed. */
function claimedKey(record: unknown): string | null {
  const r = record as Partial<QualificationRecord> | null;
  if (!r || typeof r !== "object" || typeof r.specialist_id !== "string" || typeof r.route?.provider !== "string" || typeof r.route?.model !== "string" || typeof r.release_sha256 !== "string") return null;
  return routeKey(r.specialist_id, r.route, r.release_sha256);
}

function governing(records: QualificationRecord[], specialistId: string, route: { provider: string; model: string; effort?: string | null }, release: string): { record: QualificationRecord | null; malformed: boolean } {
  const key = routeKey(specialistId, route, release);
  let best: QualificationRecord | null = null;
  let malformed = false;
  for (const record of Array.isArray(records) ? records : []) {
    if (claimedKey(record) !== key) continue;
    if (!wellFormed(record)) {
      malformed = true;
      continue;
    }
    if (!best || record.sequence > best.sequence || (record.sequence === best.sequence && !record.passed)) best = record;
  }
  return { record: best, malformed };
}

/**
 * The record that governs a key: the highest `sequence` among well-formed
 * records. Two records at the same top sequence that disagree resolve to the
 * failed one. A malformed record that claims the key cannot be ordered, so it
 * governs as a failure: the result is null.
 */
export function governingRecord(records: QualificationRecord[], specialistId: string, route: { provider: string; model: string; effort?: string | null }, release: string): QualificationRecord | null {
  const found = governing(records, specialistId, route, release);
  return found.malformed ? null : found.record;
}

export interface HopDecision {
  route: Route;
  qualification_id: string | null;
}

export type GateResult =
  | { allowed: true; primary: HopDecision; fallbacks: HopDecision[]; skipped: { route: Route; reason: string }[] }
  | { allowed: false; reason: typeof NO_QUALIFIED_ROUTE; skipped: { route: Route; reason: string }[] };

export function selectQualifiedRoute(input: {
  specialist_id: string;
  release_sha256: string | null;
  run_class: RunClass;
  primary: Route;
  fallbacks?: Route[];
  qualifications: QualificationRecord[];
  /** For an audit run: the family that proposed the work under review, which the auditor may not share. */
  reviewed_family?: string | null;
}): GateResult {
  const skipped: { route: Route; reason: string }[] = [];
  const deny = (): GateResult => ({ allowed: false, reason: NO_QUALIFIED_ROUTE, skipped });
  const hops = [input.primary, ...(input.fallbacks ?? [])];
  const reviewed = input.reviewed_family?.trim().toLowerCase() || null;
  const sameFamily = (route: Route) => reviewed !== null && route.family?.trim().toLowerCase() === reviewed;

  if (UNGATED.has(input.run_class)) {
    const usable = hops.filter((route) => {
      if (!sameFamily(route)) return true;
      skipped.push({ route, reason: "same_family_as_reviewed" });
      return false;
    });
    const [primary, ...rest] = usable;
    if (!primary) return deny();
    return { allowed: true, primary: { route: primary, qualification_id: null }, fallbacks: rest.map((route) => ({ route, qualification_id: null })), skipped };
  }
  if (!GATED.has(input.run_class) || !input.specialist_id || !input.release_sha256 || !SHA256_HEX.test(input.release_sha256)) return deny();

  const decide = (route: Route): HopDecision | null => {
    if (sameFamily(route)) {
      skipped.push({ route, reason: "same_family_as_reviewed" });
      return null;
    }
    const { record, malformed } = governing(input.qualifications, input.specialist_id, route, input.release_sha256 as string);
    if (malformed || !record || !record.passed) {
      skipped.push({ route, reason: malformed ? "malformed_record" : record ? "qualification_failed" : "unqualified" });
      return null;
    }
    return { route, qualification_id: record.qualification_id };
  };

  const primary = decide(input.primary);
  if (!primary) return deny();
  const fallbacks = (input.fallbacks ?? []).map(decide).filter((hop): hop is HopDecision => hop !== null);
  return { allowed: true, primary, fallbacks, skipped };
}

/**
 * The check at close: a live or shadow output is kept only when its
 * `qualification_ref` names the governing, passed record for the route and
 * release the close reports. Otherwise the output is dropped and the run is
 * recorded as abstaining `no_qualified_route`; an emergency or safety signal
 * the output raised must still reach a person, which is the caller's duty.
 */
export function verifyClose(input: {
  specialist_id: string;
  release_sha256: string | null;
  run_class: RunClass;
  route: Route;
  qualification_ref: string | null;
  qualifications: QualificationRecord[];
}): { keep: true } | { keep: false; reason: typeof NO_QUALIFIED_ROUTE } {
  if (UNGATED.has(input.run_class)) return { keep: true };
  if (!GATED.has(input.run_class) || !input.release_sha256 || !input.qualification_ref) return { keep: false, reason: NO_QUALIFIED_ROUTE };
  const record = governingRecord(input.qualifications, input.specialist_id, input.route, input.release_sha256);
  if (!record || !record.passed || record.qualification_id !== input.qualification_ref) return { keep: false, reason: NO_QUALIFIED_ROUTE };
  return { keep: true };
}
