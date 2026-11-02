/**
 * Data shapes of the specialist qualification harness.
 *
 * A pack supplies the case files, the action catalog, each specialist's
 * allowlist and the rubric; the harness owns the rules that read them. Every
 * shape carries a `schema_version` so a pack written against v1 is refused,
 * not misread, by a later harness.
 */

export const CASES_SCHEMA = "helm.specialist-cases.v1";
export const RUBRIC_SCHEMA = "helm.specialist-rubric.v1";
export const CATASTROPHES_SCHEMA = "helm.eval-catastrophes.v1";
export const CATALOG_SCHEMA = "helm.action-catalog.v1";
export const ALLOWLIST_SCHEMA = "helm.specialist-allowlist.v1";
export const PACK_SCHEMA = "helm.eval-pack.v1";
export const TRANSCRIPT_SCHEMA = "helm.eval-transcript.v1";
export const JUDGE_REQUEST_SCHEMA = "helm.eval-judge-request.v1";
export const JUDGEMENT_SCHEMA = "helm.eval-judgement.v1";
export const PROFILE_SCHEMA = "helm.qualification-profile.v1";
export const REPORT_SCHEMA = "helm.qualification-report.v1";
export const RECORD_SCHEMA = "helm.qualification-record.v1";

export type Suite = "golden" | "redteam";
export const SUITES: readonly Suite[] = ["golden", "redteam"];

/** What the specialist does with the signal. */
export type Decision = "propose" | "abstain" | "escalate" | "ignore";
export const DECISIONS: readonly Decision[] = ["propose", "abstain", "escalate", "ignore"];

/**
 * Effect class of an action, lowest to highest. `read` changes nothing,
 * `prepare` produces an internal artifact (a draft, a note), `act` changes an
 * internal record, `commit` leaves the organization or binds it (a send, a
 * booking, a price), and `human_only` is never allowlisted to a specialist.
 */
export type ActionClass = "read" | "prepare" | "act" | "commit" | "human_only";
export const ACTION_CLASSES: readonly ActionClass[] = ["read", "prepare", "act", "commit", "human_only"];

export function classRank(value: ActionClass): number {
  return ACTION_CLASSES.indexOf(value);
}

export type Trust = "owned" | "external_verified" | "external_unverified" | "untrusted_text";
export const TRUST_LEVELS: readonly Trust[] = ["owned", "external_verified", "external_unverified", "untrusted_text"];

export type Dimension = "decision" | "actions" | "receipt" | "draft" | "escalation";
export const DIMENSIONS: readonly Dimension[] = ["decision", "actions", "receipt", "draft", "escalation"];

/** A deterministic ceiling on one dimension: the judge can lower it, never raise it. */
export type Cap = 0 | 0.5 | 1;

export type RedTeamCategory =
  | "prompt_injection"
  | "payment_redirection"
  | "fake_invoice"
  | "fake_supplier"
  | "fake_buyer"
  | "spam"
  | "time_waster"
  | "impersonation"
  | "suspicious_document"
  | "privacy_request"
  | "social_engineering"
  | "data_exfiltration";
export const REDTEAM_CATEGORIES: readonly RedTeamCategory[] = [
  "prompt_injection",
  "payment_redirection",
  "fake_invoice",
  "fake_supplier",
  "fake_buyer",
  "spam",
  "time_waster",
  "impersonation",
  "suspicious_document",
  "privacy_request",
  "social_engineering",
  "data_exfiltration",
];

export type NeedsFromYou = "approval" | "fact" | "decision" | "none";
export const NEEDS_FROM_YOU: readonly NeedsFromYou[] = ["approval", "fact", "decision", "none"];

export type ActorType = "owner" | "staff" | "worker" | "customer" | "external";

export interface SignalActor {
  type: ActorType;
  role: string | null;
  ref: string;
  /** Only `external` actors are unauthenticated; their claimed identity stays untrusted text. */
  authenticated: boolean;
}

export interface CaseSignal {
  kind: "event" | "watch" | "request" | "handoff";
  source?: string;
  watch_id?: string;
  /** ISO 8601 duration relative to the case clock; `PT0M` is the moment of the run. */
  at: string;
  actor?: SignalActor | null;
  subject?: { aggregate: string; id: string } | null;
  content: Record<string, unknown>;
}

export interface CaseFact {
  /** `<object>/<id>`, optionally `#<json pointer>` when cited. */
  fact_id: string;
  kind: string;
  version: number;
  trust: Trust;
  /** ISO 8601 duration relative to the case clock. */
  observed_at: string;
  data: Record<string, unknown>;
}

export interface ExpectedAction {
  action_id: string;
  /** Values matched deeply; strings case-insensitively. */
  args_must_include?: Record<string, unknown>;
  /** Argument names that must not appear at any depth. */
  args_must_not_include?: string[];
}

export interface ExpectedReceipt {
  /** `succeeded`, `abstained`, or null for a step left open for a person or policy. */
  outcome: "succeeded" | "abstained" | null;
  required_fields: string[];
  must_cite: string[];
  needs_from_you: NeedsFromYou;
}

export interface ExpectedDraft {
  audience: string;
  /** BCP 47 tag; compared on the primary language subtag. */
  language: string;
  must_convey: string[];
  must_not_convey: string[];
}

export interface CaseExpectation {
  decision: Decision;
  actions: ExpectedAction[];
  actions_ordered?: boolean;
  /** Non-read actions that may appear without penalty. */
  optional_actions?: string[];
  /** Calling one is the `calls_forbidden_action` catastrophe. */
  forbidden_actions: string[];
  escalate_to: string | null;
  receipt: ExpectedReceipt | null;
  draft: ExpectedDraft | null;
}

export interface CaseClock {
  season?: "winter" | "spring" | "summer" | "fall";
  weekday?: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  /** `HH:MM`, local to the pack's time zone. */
  local_time?: string;
}

export interface EvalCase {
  /** `<specialist_id>.<suite>.<three digits>`, stable; a retired id is never reused. */
  id: string;
  title: string;
  tags: string[];
  clock?: CaseClock;
  signal: CaseSignal;
  facts: CaseFact[];
  /** Null in golden cases. */
  attack: { category: RedTeamCategory; vector: string } | null;
  expected: CaseExpectation;
  /** Catastrophe ids this case tempts; at least one. */
  catastrophic_if: string[];
  judge_notes?: string;
}

export interface CaseFile {
  schema_version: typeof CASES_SCHEMA;
  specialist_id: string;
  suite: Suite;
  /** SHA-256 of the action catalog the cases were written against. */
  catalog_sha256: string;
  cases: EvalCase[];
}

export interface ReleaseBar {
  max_catastrophes: number;
  golden_mean: number;
  golden_case_median_floor: number;
  redteam_mean: number;
  redteam_decision_all_repetitions: boolean;
}

export interface Rubric {
  schema_version: typeof RUBRIC_SCHEMA;
  specialist_id: string;
  repetitions: number;
  weights: Record<Dimension, number>;
  /** Required when the weights differ from the defaults. */
  weights_reason?: string;
  pass_bar: ReleaseBar;
  /** A recorded owner decision; required only to lower the bar below the profile's. */
  bar_change_ref?: string | null;
  /** Extra judge instructions for this specialist, scored inside the matching dimension. */
  specialist_checks: string[];
}

export type CatastropheDetection = "deterministic" | "mapped" | "judge";

export interface CatastropheDef {
  id: string;
  detection: CatastropheDetection;
  definition: string;
}

export interface CatastropheVocabulary {
  schema_version: typeof CATASTROPHES_SCHEMA;
  catastrophes: CatastropheDef[];
}

export interface CatalogAction {
  action_id: string;
  class: ActionClass;
  name?: string;
}

export interface ActionCatalog {
  schema_version: typeof CATALOG_SCHEMA;
  actions: CatalogAction[];
}

export interface AllowlistEntry {
  action_id: string;
  /** The highest class this specialist may request the action at; never above the catalog's class. */
  max_class: ActionClass;
}

export interface Allowlist {
  schema_version: typeof ALLOWLIST_SCHEMA;
  specialist_id: string;
  actions: AllowlistEntry[];
}

/** A model route: one model on one provider at one effort. `family` drives judge independence. */
export interface Route {
  provider: string;
  model: string;
  effort?: string | null;
  family: string;
}

export interface ToolCall {
  action_id: string;
  args: Record<string, unknown>;
  /** The class the run requested the action at. */
  class: ActionClass;
}

export interface SpecialistReceipt {
  outcome?: string | null;
  needs_from_you?: string | null;
  sources?: string[];
  [field: string]: unknown;
}

export interface Draft {
  id: string;
  audience: string;
  language: string;
  text: string;
}

export interface Transcript {
  schema_version: typeof TRANSCRIPT_SCHEMA;
  case_id: string;
  repetition: number;
  specialist_id: string;
  route: Route;
  prompt_sha256: string;
  catalog_sha256: string;
  release_sha256: string;
  decision: Decision | null;
  escalate_to: string | null;
  tool_calls: ToolCall[];
  receipts: SpecialistReceipt[];
  drafts: Draft[];
  final_text: string;
  /** A failed repetition, never a correct abstention. */
  error: string | null;
}
