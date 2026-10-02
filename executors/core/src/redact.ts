// Best-effort secret redaction for stderr lines and observation summaries.
// ponytail: pattern based, so a secret with no recognizable shape gets through. The observation also drops tool
// output entirely and HELM_EXECUTOR_OBSERVE_SUMMARY=off drops the summary; upgrade to a vetted detector if the
// summary ever carries more than one command line or a path.

const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /helm_(?:at|rt|dc|sk)_[A-Za-z0-9_-]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g,
];

// KEY=value where KEY names a secret: keep the name, drop the value.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(ASSIGNMENT, `$1=${REDACTED}`);
}
