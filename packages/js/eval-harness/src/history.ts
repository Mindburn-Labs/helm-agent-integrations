/**
 * History evaluation: the third score of a release. A specialist is replayed
 * on an organization's own past records and its proposals are compared with
 * what actually happened.
 *
 * Business facts may reach the model; personal identifiers may not. A pack
 * implements `HistoryCaseBuilder` for its export format. This module gives the
 * builder its guard rails: every export field is classified or the build
 * stops, identifiers become stable salted tokens, free text is scrubbed and
 * dropped when anything unknown survives, every prompt passes a guard, cases
 * hold only what was known at decision time, and only aggregates are
 * published. Real records never enter a repository.
 */

import { createHmac } from "node:crypto";
import { toCaseDuration } from "./time.js";
import type { EvalCase } from "./types.js";

export type FieldClass = "identifier" | "address" | "free_text" | "linked" | "named" | "reviewed" | "never_copied";

export interface FieldClassification {
  /** record type -> field -> class. */
  record_types: Record<string, Record<string, FieldClass>>;
  /** Fields never copied, in any record type; a trailing `*` matches a prefix (`custom_*`). */
  never_copied: string[];
}

/**
 * Fields of `record` that the classification does not cover. Names only:
 * values never appear in the result, so the report of an unclassified field
 * cannot leak it. A builder refuses the export when the list is not empty.
 */
export function unclassifiedFields(recordType: string, record: Record<string, unknown>, classification: FieldClassification): string[] {
  for (const pattern of classification.never_copied) {
    if (pattern === "*" || pattern === "") throw new Error("a never_copied wildcard needs a prefix");
  }
  const known = Object.hasOwn(classification.record_types, recordType) ? classification.record_types[recordType] : undefined;
  if (!known) return Object.keys(record).sort();
  const neverCopied = (field: string) =>
    classification.never_copied.some((pattern) => (pattern.endsWith("*") ? field.startsWith(pattern.slice(0, -1)) : field === pattern));
  return Object.keys(record)
    .filter((field) => !Object.hasOwn(known, field) && !neverCopied(field))
    .sort();
}

/** Stable letters-only tokens, keyed by a salt that stays outside the repository. */
export function createPseudonymizer(salt: string): (kind: string, value: string) => string {
  if (typeof salt !== "string" || salt.length < 16) throw new Error("pseudonymizer salt must be at least 16 characters");
  return (kind, value) => {
    const digest = createHmac("sha256", salt).update(`${kind}\u0000${value.trim().toLowerCase()}`).digest();
    let token = "";
    for (let index = 0; index < 10; index += 1) token += String.fromCharCode(97 + ((digest[index] ?? 0) % 26));
    return `${kind.toLowerCase()} ${token}`;
  };
}

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;

/**
 * Detectable patterns, most specific first. Residual risk: a bare five-digit
 * postal code is not matched, because amounts of the same shape must survive.
 */
const PATTERNS: [string, RegExp][] = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["url", /\bhttps?:\/\/\S+|\bwww\.\S+/gi],
  ["ip_address", /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
  [
    "date",
    new RegExp(
      String.raw`\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|` +
        String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+\d{4})?\b|\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?`,
      "gi",
    ),
  ],
  ["zip_plus_four", /\b\d{5}-\d{4}\b/g],
  ["phone", /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g],
  ["coordinates", /-?\d{1,3}\.\d{3,},\s*-?\d{1,3}\.\d{3,}/g],
  ["postal_code", /\b[A-Za-z]\d[A-Za-z][\s-]?\d[A-Za-z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g],
  ["long_number", /\b\d{8,}\b/g],
];

function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A dictionary value in any case, with any whitespace between its words, possessive or plural. */
function valuePattern(value: string, flags: string): RegExp {
  const words = value.split(/\s+/).filter(Boolean).map(escapeRegExp).join(String.raw`\s+`);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])` + words + String.raw`(?:'s|s)?(?![\p{L}\p{N}])`, flags);
}

export interface ScrubOptions {
  /** Every identifier value in the export: names, companies, street lines. */
  dictionary: string[];
  /** Words allowed to remain; when given, any other word drops the text. */
  isOrdinaryWord?: (word: string) => boolean;
  placeholder?: string;
}

export interface ScrubResult {
  /** Null when the text was dropped. */
  text: string | null;
  replaced: number;
  /** Pattern kinds that matched; never the matched values. */
  patterns: string[];
}

/**
 * Scrubs one free-text value: detectable patterns, then dictionary values in
 * any case, possessive or plural form. With `isOrdinaryWord`, text that
 * still holds a word outside the vocabulary is dropped, not passed: a name the
 * dictionary missed costs the text, never the person.
 */
export function scrubText(text: string, options: ScrubOptions): ScrubResult {
  const placeholder = options.placeholder ?? "[redacted]";
  let out = normalizeText(text);
  let replaced = 0;
  // Patterns first, so an identifier inside an address or an email goes with the whole match.
  const patterns: string[] = [];
  for (const [kind, pattern] of PATTERNS) {
    out = out.replace(pattern, () => {
      replaced += 1;
      if (!patterns.includes(kind)) patterns.push(kind);
      return placeholder;
    });
  }
  const values = [...new Set(options.dictionary.map((value) => normalizeText(value).trim()).filter((value) => value.length >= 2))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.replace(valuePattern(value, "giu"), () => {
      replaced += 1;
      return placeholder;
    });
  }
  if (options.isOrdinaryWord) {
    const remaining = out.split(placeholder).join(" ").match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    if (remaining.some((word) => !options.isOrdinaryWord?.(word))) return { text: null, replaced, patterns };
  }
  return { text: out, replaced, patterns };
}

/**
 * A guard for every assembled prompt: finds any original identifier (any case)
 * and any detectable pattern. The runner sends nothing that fails it.
 */
export function createPromptGuard(originals: string[]): (prompt: string) => { ok: true } | { ok: false; violations: string[] } {
  const values = [...new Set(originals.map((value) => normalizeText(value).trim().toLowerCase()).filter((value) => value.length >= 2))];
  return (prompt) => {
    const text = normalizeText(prompt);
    const lowered = text.toLowerCase();
    const violations: string[] = [];
    const dictionaryHits = values.filter((value) => valuePattern(value, "iu").test(lowered)).length;
    if (dictionaryHits > 0) violations.push(`dictionary_value x${dictionaryHits}`);
    for (const [kind, pattern] of PATTERNS) {
      const matches = text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
      if (matches > 0) violations.push(`${kind} x${matches}`);
    }
    return violations.length === 0 ? { ok: true } : { ok: false, violations };
  };
}

/** Records known at decision time, with times rewritten as case durations from it. */
export function pointInTime<T extends { recorded_at_ms: number }>(records: T[], decisionAtMs: number): (Omit<T, "recorded_at_ms"> & { observed_at: string })[] {
  return records
    .filter((record) => record.recorded_at_ms <= decisionAtMs)
    .map(({ recorded_at_ms, ...rest }) => ({ ...rest, observed_at: toCaseDuration(recorded_at_ms - decisionAtMs) }));
}

export interface HistoryBuild {
  /** Cases ready for replay; their facts are pseudonymised and point in time. */
  cases: EvalCase[];
  /** Outcomes per case id; never part of a prompt. */
  truths: Record<string, unknown>;
  stats: { kept_text: number; dropped_text: number; skipped: Record<string, number> };
}

/** What a pack implements for its export format. */
export interface HistoryCaseBuilder<TExport> {
  classification: FieldClassification;
  build(input: TExport, tools: { pseudonymize: (kind: string, value: string) => string; scrub: (text: string) => ScrubResult }): HistoryBuild;
}

export interface Share {
  n: number;
  suppressed: boolean;
  value?: number;
  low?: number;
  high?: number;
}

/** Wilson 95% interval for k successes in n. */
export function wilsonInterval(k: number, n: number, z = 1.959963984540054): { low: number; high: number } {
  if (!(n > 0) || k < 0 || k > n) throw new Error("wilson interval needs 0 <= k <= n and n > 0");
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** A publishable share: nothing under 5 records, and no small cell (1 to 4) on either side. */
export function publishShare(k: number, n: number): Share {
  if (n < 5 || (k >= 1 && k <= 4) || (n - k >= 1 && n - k <= 4)) return { n, suppressed: true };
  return { n, suppressed: false, value: k / n, ...wilsonInterval(k, n) };
}

export interface HistoryBar {
  metric: string;
  min?: number;
  max?: number;
  min_n?: number;
  /** A missed gating bar fails the release; an advisory bar only reports. */
  gating: boolean;
}

export interface HistoryBarResult {
  metric: string;
  gating: boolean;
  status: "met" | "missed" | "insufficient";
  value: number | null;
  n: number;
}

/** Applies history bars to raw metrics. Fewer than `min_n` (default 5) records reads insufficient, never missed. */
export function evaluateHistoryBars(
  metrics: Record<string, { value: number | null; n: number }>,
  bars: HistoryBar[],
): { results: HistoryBarResult[]; gating_missed: boolean; gating_insufficient: boolean; advisory: boolean } {
  for (const bar of bars) {
    if (bar.min === undefined && bar.max === undefined) throw new Error(`history bar ${bar.metric} needs min or max`);
  }
  const results = bars.map((bar) => {
    const metric = Object.hasOwn(metrics, bar.metric) ? metrics[bar.metric] : undefined;
    const n = metric?.n ?? 0;
    const value = metric?.value ?? null;
    if (value === null || n < (bar.min_n ?? 5)) return { metric: bar.metric, gating: bar.gating, status: "insufficient" as const, value: null, n };
    const met = (bar.min === undefined || value >= bar.min) && (bar.max === undefined || value <= bar.max);
    return { metric: bar.metric, gating: bar.gating, status: met ? ("met" as const) : ("missed" as const), value, n };
  });
  return {
    results,
    gating_missed: results.some((result) => result.gating && result.status === "missed"),
    // A gating bar without enough records leaves the history score open: it neither passes nor fails.
    gating_insufficient: results.some((result) => result.gating && result.status === "insufficient"),
    advisory: !bars.some((bar) => bar.gating),
  };
}
