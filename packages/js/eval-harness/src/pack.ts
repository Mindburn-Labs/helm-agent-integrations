/**
 * Eval pack: the files a vertical pack supplies for its specialists.
 *
 *   pack.json                      manifest (this module's PackManifest)
 *   catalog.v1.json                the pack's action catalog
 *   <specialist_id>/allowlist.v1.json
 *   <specialist_id>/golden.v1.json
 *   <specialist_id>/redteam.v1.json
 *   <specialist_id>/rubric.v1.json
 *
 * Paths in the manifest are relative to the manifest and may not leave its
 * directory.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { canonicalSha256 } from "./canonical.js";
import { extendVocabulary } from "./catastrophes.js";
import {
  DEFAULT_CASE_POLICY,
  DEFAULT_RELEASE_BAR,
  coverageProblems,
  validateActionCatastrophes,
  validateAllowlist,
  validateCaseFile,
  validateCatalog,
  validateRubric,
  type CasePolicy,
} from "./validate.js";
import {
  PACK_SCHEMA,
  type ActionCatalog,
  type Allowlist,
  type CaseFile,
  type CatastropheDef,
  type CatastropheVocabulary,
  type ReleaseBar,
  type Route,
  type Rubric,
} from "./types.js";

export interface PackSpecialistEntry {
  specialist_id: string;
  allowlist: string;
  golden: string;
  redteam: string;
  rubric: string;
}

export interface PackManifest {
  schema_version: typeof PACK_SCHEMA;
  pack_id: string;
  /** The model that wrote the cases (family `human` for people); the judge may never be that model. */
  case_author: Route;
  /** IANA zone the runner resolves `$case_date` markers and case clocks in. */
  time_zone: string;
  catalog: string;
  catastrophes?: CatastropheDef[];
  /** human_only action id -> mapped catastrophe ids its call alone is. */
  action_catastrophes: Record<string, string[]>;
  case_policy?: Partial<CasePolicy>;
  /** Required when `case_policy` sets any count below the release-grade default. */
  case_policy_reason?: string;
  specialists: PackSpecialistEntry[];
}

export interface LoadedSpecialist {
  specialist_id: string;
  allowlist: Allowlist;
  golden: CaseFile;
  redteam: CaseFile;
  rubric: Rubric;
}

export interface LoadedPack {
  manifest: PackManifest;
  catalog: ActionCatalog;
  catalog_sha256: string;
  vocabulary: CatastropheVocabulary;
  action_catastrophes: Record<string, string[]>;
  case_policy: CasePolicy;
  specialists: LoadedSpecialist[];
}

function safeRelative(path: unknown): string {
  if (typeof path !== "string" || path === "" || isAbsolute(path)) throw new Error(`pack path must be relative: ${String(path)}`);
  const clean = normalize(path);
  if (clean === ".." || clean.startsWith(`..${sep}`)) throw new Error(`pack path leaves the pack directory: ${path}`);
  return clean;
}

/** Builds a pack from a manifest and a reader of the files it names (no file system needed). */
export function parsePack(manifest: PackManifest, read: (relativePath: string) => unknown): LoadedPack {
  if (!manifest || manifest.schema_version !== PACK_SCHEMA) throw new Error(`pack manifest schema_version must be ${PACK_SCHEMA}`);
  if (!Array.isArray(manifest.specialists) || manifest.specialists.length === 0) throw new Error("pack manifest lists no specialists");
  const catalog = read(safeRelative(manifest.catalog)) as ActionCatalog;
  return {
    manifest,
    catalog,
    catalog_sha256: canonicalSha256(catalog),
    vocabulary: extendVocabulary(manifest.catastrophes ?? []),
    action_catastrophes: manifest.action_catastrophes ?? {},
    case_policy: { ...DEFAULT_CASE_POLICY, ...(manifest.case_policy ?? {}) },
    specialists: manifest.specialists.map((entry) => ({
      specialist_id: entry.specialist_id,
      allowlist: read(safeRelative(entry.allowlist)) as Allowlist,
      golden: read(safeRelative(entry.golden)) as CaseFile,
      redteam: read(safeRelative(entry.redteam)) as CaseFile,
      rubric: read(safeRelative(entry.rubric)) as Rubric,
    })),
  };
}

/** Loads `pack.json` and the files it names from disk. */
export function loadEvalPack(manifestPath: string): LoadedPack {
  const root = dirname(manifestPath);
  const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as unknown;
  return parsePack(JSON.parse(readFileSync(manifestPath, "utf8")) as PackManifest, readJson);
}

/** Every problem in a loaded pack; empty when the pack is valid. */
export function validatePack(pack: LoadedPack, options: { repetitions?: number; releaseBar?: ReleaseBar } = {}): string[] {
  const problems: string[] = [];
  const manifest = pack.manifest;
  if (typeof manifest.pack_id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.pack_id)) problems.push("pack_id must be lowercase kebab case");
  if (typeof manifest.time_zone !== "string" || manifest.time_zone === "") problems.push("time_zone is required");
  else {
    try {
      new Intl.DateTimeFormat("en", { timeZone: manifest.time_zone });
    } catch {
      problems.push(`time_zone ${manifest.time_zone} is not an IANA zone`);
    }
  }
  if (typeof manifest.case_author?.family !== "string" || manifest.case_author.family === "" || typeof manifest.case_author?.model !== "string" || manifest.case_author.model === "") {
    problems.push("case_author must name the model and family that wrote the cases");
  }
  const policy = pack.case_policy;
  for (const key of ["min_golden", "min_redteam", "min_redteam_categories"] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1) problems.push(`case_policy.${key} must be a positive integer`);
    else if (policy[key] < DEFAULT_CASE_POLICY[key] && (typeof manifest.case_policy_reason !== "string" || manifest.case_policy_reason.trim() === "")) {
      problems.push(`case_policy.${key} is below the release-grade ${DEFAULT_CASE_POLICY[key]} without a case_policy_reason`);
    }
  }
  const catalogProblems = validateCatalog(pack.catalog);
  problems.push(...catalogProblems);
  if (catalogProblems.length > 0) return problems;
  problems.push(...validateActionCatastrophes(pack.action_catastrophes, pack.catalog, pack.vocabulary));

  const seen = new Set<string>();
  for (const specialist of pack.specialists) {
    const id = specialist.specialist_id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(id)) {
      problems.push(`specialist id ${String(id)} must be snake case`);
      continue;
    }
    if (seen.has(id)) problems.push(`specialist ${id} is listed twice`);
    seen.add(id);
    const allowlistProblems = validateAllowlist(specialist.allowlist, pack.catalog, id);
    problems.push(...allowlistProblems);
    problems.push(...validateRubric(specialist.rubric, id, { repetitions: options.repetitions, baseBar: options.releaseBar ?? DEFAULT_RELEASE_BAR }));
    if (allowlistProblems.length > 0) continue;
    const base = { specialistId: id, catalog: pack.catalog, allowlist: specialist.allowlist, vocabulary: pack.vocabulary };
    const golden = validateCaseFile(specialist.golden, { ...base, suite: "golden" });
    const redteam = validateCaseFile(specialist.redteam, { ...base, suite: "redteam" });
    problems.push(...golden, ...redteam);
    if (golden.length === 0 && redteam.length === 0) {
      problems.push(...coverageProblems(specialist.golden, specialist.redteam, pack.case_policy));
      const goldenIds = new Set(specialist.golden.cases.map((c) => c.id));
      for (const c of specialist.redteam.cases) if (goldenIds.has(c.id)) problems.push(`${c.id} appears in both suites`);
    }
  }
  return problems;
}

/** Every case id of a specialist, per suite, in file order: the ids a complete suite must score. */
export function expectedCaseIds(specialist: LoadedSpecialist): { golden: string[]; redteam: string[] } {
  return {
    golden: specialist.golden.cases.map((c) => c.id),
    redteam: specialist.redteam.cases.map((c) => c.id),
  };
}
