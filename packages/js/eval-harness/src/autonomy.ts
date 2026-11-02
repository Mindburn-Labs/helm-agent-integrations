/**
 * Earned autonomy: pure rules, no storage.
 *
 * Autonomy is set per specialist and action on HELM's single autonomy ladder
 * (controller decision D19): Watch, Suggest, Ask me first, Act within limits,
 * Review regularly. It widens one step at a
 * time, only as a proposal an authorized person decides, and only on a track
 * record: agreement between the specialist's proposals and what people
 * decided or did, counted under the current release and step policy. It
 * narrows automatically, back to Ask me first, on any sign the record no
 * longer holds. The caller stores decisions and settings; these functions
 * only read them.
 */

export type Step = "watch" | "suggest" | "ask_first" | "within_limits" | "review_regularly";

export interface StepDefinition {
  step: Step;
  rank: number;
  /** D19 UI label. */
  label: string;
  /** D19 backend state. */
  backend_state: string;
  /** Plan autonomy levels that land on this step. */
  levels: AutonomyLevel[];
}

/**
 * Plan autonomy levels: A0 watches; A1 suggests; A2 prepares a draft; A3 acts
 * after a person confirms; A4 acts alone and a person can undo within a set
 * window; A5 acts alone within its mandate.
 */
export type AutonomyLevel = "A0" | "A1" | "A2" | "A3" | "A4" | "A5";

export const STEPS: readonly StepDefinition[] = Object.freeze([
  { step: "watch", rank: 1, label: "Watch", backend_state: "draft", levels: ["A0"] },
  { step: "suggest", rank: 2, label: "Suggest", backend_state: "propose_only", levels: ["A1", "A2"] },
  { step: "ask_first", rank: 3, label: "Ask me first", backend_state: "approval-required", levels: ["A3"] },
  { step: "within_limits", rank: 4, label: "Act within limits", backend_state: "constrained-live", levels: ["A4"] },
  { step: "review_regularly", rank: 5, label: "Review regularly", backend_state: "certified-live", levels: ["A5"] },
] as StepDefinition[]);

export function stepRank(step: Step): number {
  return STEPS.find((definition) => definition.step === step)?.rank ?? 0;
}

export function stepForLevel(level: AutonomyLevel): Step {
  const found = STEPS.find((definition) => definition.levels.includes(level));
  if (!found) throw new Error(`unknown autonomy level ${String(level)}`);
  return found.step;
}

function nextStep(step: Step): Step | null {
  return STEPS.find((definition) => definition.rank === stepRank(step) + 1)?.step ?? null;
}

// ---------------------------------------------------------------- statistics

/**
 * Rule of three: with n checked cases and no error, the error rate is at most
 * 3/n with 95% confidence. At other confidences the zero-error bound is
 * -ln(1 - confidence)/n.
 */
function assertConfidence(confidence: number): void {
  if (typeof confidence !== "number" || !(confidence > 0 && confidence < 1)) throw new Error("confidence must be in (0, 1)");
}

export function zeroErrorUpperBound(n: number, confidence = 0.95): number {
  assertConfidence(confidence);
  if (!(n > 0)) return 1;
  const factor = confidence === 0.95 ? 3 : -Math.log(1 - confidence);
  return Math.min(1, factor / n);
}

function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let logCoefficient = 0;
  let total = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) logCoefficient += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(logCoefficient + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

/**
 * One-sided upper bound on the error rate after `errors` in `n` checked cases:
 * the rule of three when there is no error, Clopper-Pearson otherwise.
 */
export function errorRateUpperBound(n: number, errors: number, confidence = 0.95): number {
  if (!Number.isInteger(n) || !Number.isInteger(errors) || errors < 0 || errors > n) throw new Error("need integers 0 <= errors <= n");
  assertConfidence(confidence);
  if (n === 0) return 1;
  if (errors === 0) return zeroErrorUpperBound(n, confidence);
  if (errors === n) return 1;
  const alpha = 1 - confidence;
  let low = errors / n;
  let high = 1;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (low + high) / 2;
    if (binomialCdf(errors, n, middle) > alpha) low = middle;
    else high = middle;
  }
  return high;
}

/** Clean cases needed to prove `targetErrorRate` at 95%: 3/target (600 for 0.5%). */
export function requiredCleanCases(targetErrorRate: number, confidence = 0.95): number {
  if (!(targetErrorRate > 0 && targetErrorRate < 1)) throw new Error("target error rate must be in (0, 1)");
  assertConfidence(confidence);
  const factor = confidence === 0.95 ? 3 : -Math.log(1 - confidence);
  return Math.ceil(factor / targetErrorRate - 1e-9);
}

// ----------------------------------------------------------------- agreement

export type Comparison = "match" | "partial" | "diverge" | "unscored";

export interface ProposedAct {
  action_id: string;
  object: unknown;
  values: unknown;
  recipient: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A practice run compared with what the person actually did in the same case:
 * a match when action, object, values and recipient are equal; partial when it
 * is the same action with other values; diverge otherwise; unscored when there
 * is nothing to compare with inside the comparison window.
 */
export function compareShadow(proposal: ProposedAct, actual: ProposedAct | null): Comparison {
  if (!actual) return "unscored";
  if (proposal.action_id !== actual.action_id) return "diverge";
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  return same(proposal.object, actual.object) && same(proposal.values, actual.values) && same(proposal.recipient, actual.recipient) ? "match" : "partial";
}

/** A live asks-first decision: approved is a match, declined diverges, done by hand is unscored. */
export function compareLiveReview(outcome: "approved" | "declined" | "done_by_person"): Comparison {
  return outcome === "approved" ? "match" : outcome === "declined" ? "diverge" : "unscored";
}

export interface AgreementDecision {
  decision_id: string;
  specialist_id: string;
  action_id: string;
  release_sha256: string;
  policy_version: string;
  /** Monotonic order of decisions for the pair; the store assigns it. */
  sequence: number;
  comparison: Comparison;
  /** Recorded by the auditor's finding or the reviewer's decision, on a scored or unscored decision alike. */
  catastrophe: boolean;
  /** The close was refused (no qualified route, or an audit off independence): it counts only against. */
  close_refused?: boolean;
}

export interface WindowSummary {
  counted: number;
  matches: number;
  partials: number;
  diverges: number;
  unscored: number;
  catastrophes: number;
  match_share: number | null;
  errors: number;
  error_upper_bound: number;
}

export interface WindowKey {
  specialist_id: string;
  action_id: string;
  release_sha256: string;
  policy_version: string;
}

/**
 * The counted window for one pair: decisions under the current release and
 * step policy version, newest `maxWindow` by sequence. Unscored decisions
 * never count toward the share, but a catastrophe on one still counts. A
 * refused close's match leaves the window; its partial or diverging
 * comparison stays.
 */
export function summarizeWindow(decisions: AgreementDecision[], key: WindowKey, options: { maxWindow?: number; confidence?: number } = {}): WindowSummary {
  if (options.maxWindow !== undefined && (!Number.isInteger(options.maxWindow) || options.maxWindow < 1)) throw new Error("maxWindow must be a positive integer");
  // One decision counts once: a repeated decision_id keeps its latest sequence.
  const byId = new Map<string, AgreementDecision>();
  for (const d of decisions) {
    if (d.specialist_id !== key.specialist_id || d.action_id !== key.action_id || d.release_sha256 !== key.release_sha256 || d.policy_version !== key.policy_version) continue;
    const seen = byId.get(d.decision_id);
    if (!seen || d.sequence >= seen.sequence) byId.set(d.decision_id, d);
  }
  let pair = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  if (options.maxWindow !== undefined) pair = pair.slice(-options.maxWindow);
  // A comparison this module does not know reads as a divergence, never as a match.
  const comparison = (d: AgreementDecision): Comparison => (KNOWN_COMPARISONS.has(d.comparison) ? d.comparison : "diverge");
  const catastrophes = pair.filter((d) => d.catastrophe !== false).length;
  const scored = pair.filter((d) => comparison(d) !== "unscored" && !(d.close_refused && comparison(d) === "match"));
  const matches = scored.filter((d) => comparison(d) === "match").length;
  const partials = scored.filter((d) => comparison(d) === "partial").length;
  const diverges = scored.filter((d) => comparison(d) === "diverge").length;
  const counted = scored.length;
  const errors = partials + diverges;
  return {
    counted,
    matches,
    partials,
    diverges,
    unscored: pair.length - scored.length,
    catastrophes,
    match_share: counted === 0 ? null : matches / counted,
    errors,
    error_upper_bound: errorRateUpperBound(counted, errors, options.confidence ?? 0.95),
  };
}

const KNOWN_COMPARISONS: ReadonlySet<string> = new Set(["match", "partial", "diverge", "unscored"]);

// ----------------------------------------------------------------- promotion

export interface StepBar {
  min_decisions: number;
  min_match_share: number;
  /** Requires the error-rate upper bound to be within the target (the 10x rule). */
  statistical: boolean;
}

export interface AutonomyPolicy {
  /** Version of the step policy; a new version resets every window and demotes every widened setting. */
  version: string;
  bars: Record<Exclude<Step, "watch">, StepBar>;
  max_catastrophes: number;
  /** The specialist must err this many times less often than people doing the same work. */
  improvement_factor: number;
  confidence: number;
  /** Stricter maximum error rates per severity class, such as money or legal. */
  severity_max_error_rate: Record<string, number>;
  max_window?: number;
}

export const DEFAULT_AUTONOMY_POLICY: Readonly<AutonomyPolicy> = Object.freeze({
  version: "helm.autonomy-policy.v1",
  bars: {
    suggest: { min_decisions: 0, min_match_share: 0, statistical: false },
    ask_first: { min_decisions: 0, min_match_share: 0, statistical: false },
    within_limits: { min_decisions: 50, min_match_share: 0.95, statistical: false },
    review_regularly: { min_decisions: 50, min_match_share: 0.95, statistical: true },
  },
  max_catastrophes: 0,
  improvement_factor: 10,
  confidence: 0.95,
  severity_max_error_rate: {},
});

export interface ActionProfile {
  /** False for actions that must always ask first (an outside send, a price commitment). */
  delegable: boolean;
  human_only: boolean;
  /** Protective actions (stop, hold, block, alert) are always on and off the ladder. */
  protective: boolean;
  /** Highest step allowed for this action, for example by law where it runs. */
  max_step: Step;
  severity: string;
  /** Measured error rate of people doing this work, when known. */
  human_error_rate: number | null;
}

export interface PromotionVerdict {
  eligible: boolean;
  current_step: Step;
  proposed_step: Step | null;
  blocked_by: string[];
  summary: WindowSummary;
  /** The target error rate the statistical bar used, when it applies. */
  target_error_rate: number | null;
  required_clean_cases: number | null;
  /** A proposal only: an authorized person decides; a plan or payment never widens a step. */
  requires_owner_decision: true;
}

/** Problems with a policy; a policy with any is never used to widen a step. */
export function validateAutonomyPolicy(policy: AutonomyPolicy): string[] {
  const problems: string[] = [];
  if (typeof policy?.version !== "string" || policy.version === "") problems.push("version is required");
  if (!(policy?.confidence > 0 && policy.confidence < 1)) problems.push("confidence must be in (0, 1)");
  if (!(policy?.improvement_factor >= 1) || !Number.isFinite(policy.improvement_factor)) problems.push("improvement_factor must be at least 1");
  if (!Number.isInteger(policy?.max_catastrophes) || policy.max_catastrophes < 0) problems.push("max_catastrophes must be a non-negative integer");
  if (policy?.max_window !== undefined && (!Number.isInteger(policy.max_window) || policy.max_window < 1)) problems.push("max_window must be a positive integer");
  for (const step of ["suggest", "ask_first", "within_limits", "review_regularly"] as const) {
    const bar = policy?.bars?.[step];
    if (!bar || !Number.isInteger(bar.min_decisions) || bar.min_decisions < 0 || !(bar.min_match_share >= 0 && bar.min_match_share <= 1) || typeof bar.statistical !== "boolean") {
      problems.push(`bars.${step} needs min_decisions, min_match_share and statistical`);
    }
  }
  for (const [severity, rate] of Object.entries(policy?.severity_max_error_rate ?? {})) {
    if (!(rate > 0 && rate < 1)) problems.push(`severity_max_error_rate.${severity} must be in (0, 1)`);
  }
  return problems;
}

/** Target error rate for the statistical bar: the human rate over the improvement factor, tightened by severity. */
export function targetErrorRate(action: ActionProfile, policy: AutonomyPolicy): number | null {
  if (action.human_error_rate === null || !(action.human_error_rate > 0)) return null;
  const base = action.human_error_rate / policy.improvement_factor;
  const severity = policy.severity_max_error_rate[action.severity];
  return severity !== undefined ? Math.min(base, severity) : base;
}

/**
 * Whether the pair may be proposed for the next step. `qualified` is true only
 * when the latest closed run's exact route holds a passed qualification at the
 * current release (see gate.ts).
 */
export function evaluatePromotion(input: {
  current_step: Step;
  practice_only: boolean;
  decisions: AgreementDecision[];
  key: WindowKey;
  action: ActionProfile;
  qualified: boolean;
  policy?: AutonomyPolicy;
}): PromotionVerdict {
  const policy = input.policy ?? DEFAULT_AUTONOMY_POLICY;
  const policyProblems = validateAutonomyPolicy(policy);
  const safe = policyProblems.length === 0 ? policy : DEFAULT_AUTONOMY_POLICY;
  const summary = summarizeWindow(input.decisions, input.key, { maxWindow: safe.max_window, confidence: safe.confidence });
  const blocked: string[] = policyProblems.map((problem) => `invalid policy: ${problem}`);
  const proposed = nextStep(input.current_step);
  let target: number | null = null;
  let required: number | null = null;

  if (input.key.policy_version !== safe.version) blocked.push("window is not under the current step policy version");
  if (input.action.human_only) blocked.push("human-only action");
  if (input.action.protective) blocked.push("protective actions are off the ladder");
  if (!proposed) blocked.push("already at the top step");
  else {
    if (stepRank(proposed) > stepRank(input.action.max_step)) blocked.push(`the action's ceiling is ${input.action.max_step}`);
    if (stepRank(proposed) > stepRank("ask_first") && !input.action.delegable) blocked.push("the action always asks first");
    if (input.practice_only && stepRank(proposed) > stepRank("ask_first")) blocked.push("a practice-only setting moves to asks first before it can act within limits");
    if (!input.qualified) blocked.push("no passed qualification on the route the specialist runs on");
    if (summary.catastrophes > safe.max_catastrophes) blocked.push(`${summary.catastrophes} catastrophe(s) in the window`);
    const bar = safe.bars[proposed as Exclude<Step, "watch">];
    if (summary.counted < bar.min_decisions) blocked.push(`${summary.counted} compared decisions, ${bar.min_decisions} needed`);
    if (bar.min_match_share > 0 && (summary.match_share ?? 0) < bar.min_match_share) {
      blocked.push(`match share ${summary.match_share === null ? "none" : summary.match_share.toFixed(3)}, ${bar.min_match_share} needed`);
    }
    if (bar.statistical) {
      target = targetErrorRate(input.action, safe);
      if (target === null) blocked.push("no measured human error rate to compare with");
      else {
        required = requiredCleanCases(target, safe.confidence);
        if (summary.error_upper_bound > target) {
          blocked.push(`error rate bound ${summary.error_upper_bound.toFixed(4)} above target ${target.toFixed(4)} (${required} clean cases prove it with no error)`);
        }
      }
    }
  }
  return {
    eligible: blocked.length === 0,
    current_step: input.current_step,
    proposed_step: blocked.length === 0 ? proposed : null,
    blocked_by: blocked,
    summary,
    target_error_rate: target,
    required_clean_cases: required,
    requires_owner_decision: true,
  };
}

// ------------------------------------------------------------------ demotion

export type DemotionTrigger =
  | "outcome_unknown"
  | "readback_mismatch"
  | "done_by_person"
  | "undo_by_person"
  | "policy_version_changed"
  | "catalog_changed"
  | "release_changed_unqualified"
  | "no_qualified_route"
  | "catastrophe"
  | "auditor_hold";

export interface Setting {
  step: Step;
  /** Practice only: the specialist proposes in full, nothing is executed. */
  practice_only: boolean;
  practice_stopped?: boolean;
}

export interface DemotionResult {
  setting: Setting;
  changed: boolean;
  /** The owner must confirm the setting again before it widens. */
  requires_owner_confirmation: boolean;
  /** A catastrophe opens an exception for the owner. */
  open_exception: boolean;
}

const PRACTICE_STOPPERS: ReadonlySet<string> = new Set(["release_changed_unqualified", "no_qualified_route", "catastrophe", "auditor_hold"]);

/**
 * Automatic fallback. A widened setting (Act within limits or above) falls
 * back to Ask me first on any trigger, and an unknown trigger counts as one.
 * A practice-only setting never falls back to Ask me first, which would give
 * it more autonomy: a release, qualification, catastrophe or hold trigger
 * stops its practice instead.
 */
export function applyDemotion(setting: Setting, trigger: DemotionTrigger | string): DemotionResult {
  const exception = trigger === "catastrophe";
  if (setting.practice_only) {
    // Practice never sits above Ask me first; a setting that claims to is narrowed.
    const step: Step = stepRank(setting.step) > stepRank("ask_first") ? "ask_first" : setting.step;
    const narrowed = step !== setting.step;
    if (PRACTICE_STOPPERS.has(trigger) || !isKnownTrigger(trigger)) {
      return { setting: { ...setting, step, practice_stopped: true }, changed: narrowed || !setting.practice_stopped, requires_owner_confirmation: true, open_exception: exception };
    }
    return { setting: { ...setting, step }, changed: narrowed, requires_owner_confirmation: narrowed, open_exception: exception };
  }
  return fallBack(setting, exception);
}

function fallBack(setting: Setting, exception: boolean): DemotionResult {
  if (stepRank(setting.step) > stepRank("ask_first")) {
    return { setting: { ...setting, step: "ask_first" }, changed: true, requires_owner_confirmation: true, open_exception: exception };
  }
  return { setting, changed: false, requires_owner_confirmation: false, open_exception: exception };
}

const TRIGGERS: ReadonlySet<string> = new Set([
  "outcome_unknown",
  "readback_mismatch",
  "done_by_person",
  "undo_by_person",
  "policy_version_changed",
  "catalog_changed",
  "release_changed_unqualified",
  "no_qualified_route",
  "catastrophe",
  "auditor_hold",
]);

function isKnownTrigger(trigger: string): boolean {
  return TRIGGERS.has(trigger);
}

/**
 * Standing check for a widened setting: when the counted window no longer
 * meets the bar of the step it sits on, it falls back to Ask me first. The
 * share bar trips as soon as the errors exceed what the bar tolerates over
 * its minimum window, and the statistical bar as soon as the observed error
 * rate exceeds the target, so a bad start is not shielded by a small window.
 */
export function checkStanding(input: {
  setting: Setting;
  decisions: AgreementDecision[];
  key: WindowKey;
  action: ActionProfile;
  policy?: AutonomyPolicy;
}): DemotionResult & { reasons: string[] } {
  const policy = input.policy ?? DEFAULT_AUTONOMY_POLICY;
  const reasons: string[] = [];
  const step = input.setting.step;
  const keep = { setting: input.setting, changed: false, requires_owner_confirmation: false, open_exception: false, reasons };
  if (stepRank(step) <= stepRank("ask_first")) return keep;
  if (input.setting.practice_only) reasons.push("a practice-only setting sits above ask first");
  const policyProblems = validateAutonomyPolicy(policy);
  if (policyProblems.length > 0) reasons.push("invalid policy");
  const safe = policyProblems.length === 0 ? policy : DEFAULT_AUTONOMY_POLICY;
  const summary = summarizeWindow(input.decisions, input.key, { maxWindow: safe.max_window, confidence: safe.confidence });
  const bar = safe.bars[step as Exclude<Step, "watch">];
  if (input.key.policy_version !== safe.version) reasons.push("step policy version changed");
  if (summary.catastrophes > safe.max_catastrophes) reasons.push("catastrophe in the window");
  if (bar.min_match_share > 0) {
    const tolerated = Math.floor((1 - bar.min_match_share) * Math.max(bar.min_decisions, summary.counted) + 1e-9);
    if (summary.errors > tolerated) reasons.push("match share fell below the bar");
  }
  if (bar.statistical) {
    const target = targetErrorRate(input.action, safe);
    if (target === null) reasons.push("no measured human error rate to compare with");
    else if ((summary.counted > 0 && summary.errors / summary.counted > target) || (summary.counted >= requiredCleanCases(target, safe.confidence) && summary.error_upper_bound > target)) {
      reasons.push("error rate bound is above the target");
    }
  }
  if (reasons.length === 0) return keep;
  return { ...fallBack(input.setting, reasons.includes("catastrophe in the window")), reasons };
}
