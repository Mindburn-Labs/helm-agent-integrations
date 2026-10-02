// Best-effort secret redaction for stderr lines, control plane error text and observation summaries.
// ponytail: pattern based, so a secret with no recognizable shape gets through. What keeps credentials out of an
// observation is not this list: a Bash summary is the command's shape (shape.ts) and carries no argument at all, the
// observation drops tool output entirely, and HELM_EXECUTOR_OBSERVE_SUMMARY=off drops the summary. Upgrade to a
// vetted detector if a summary ever carries free text.

const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /helm_(?:at|rt|dc|sk)_[A-Za-z0-9_-]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:npm|hf)_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhvs\.[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g,
];

// KEY=value where KEY names a secret: keep the name, drop the value. The name's length is bounded so that a hostile
// string such as "TOKENTOKEN..." cannot make the match quadratic.
const ASSIGNMENT = /\b([A-Za-z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]{0,64})=("[^"]*"|'[^']*'|\S+)/gi;

/** Input beyond this many characters is dropped before matching, which keeps the worst case bounded. */
const MAX_INPUT = 4096;

export function redactSecrets(text: string): string {
  let out = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(ASSIGNMENT, `$1=${REDACTED}`);
}
