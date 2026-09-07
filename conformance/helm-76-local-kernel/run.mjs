import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  fromClaudeToolCall,
  fromCodexToolCall,
  withHelmBoundary,
} from "../../packages/js/helm-tool-wrapper/dist/index.js";

const helmUrl = requiredEnv("HELM_URL").replace(/\/$/, "");
const apiKey = requiredEnv("HELM_ADMIN_API_KEY");
const tenantId = requiredEnv("HELM_TENANT_ID");
const principal = requiredEnv("HELM_PRINCIPAL_ID");
const kernelSha = requiredEnv("HELM_KERNEL_SHA");
const maxEvidenceBytes = 8 * 1024 * 1024;
const requests = [];
const preDispatchProof = [];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function authenticatedFetch(url, init) {
  assert.equal(init?.headers?.Authorization, `Bearer ${apiKey}`);
  assert.equal(init?.headers?.["X-Helm-Tenant-ID"], tenantId);
  assert.equal(init?.headers?.["X-Helm-Principal-ID"], principal);
  const path = new URL(url).pathname;
  requests.push(path);
  const response = await fetch(url, init);
  if (path === "/api/v1/evaluate") {
    const body = await response.clone().json();
    assert.ok(body.receipt_id, "Kernel evaluate response must carry a durable receipt_id");
    preDispatchProof.push("receipt-observed");
  } else if (path === "/api/v1/evidence/export") {
    const content = new Uint8Array(await response.clone().arrayBuffer());
    const expected = response.headers.get("x-helm-evidence-hash");
    const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    assert.equal(actual, expected, "authenticated EvidencePack transport digest mismatch");
    preDispatchProof.push("evidence-hash-verified");
  }
  return response;
}

function verifyPreflightEvidence(result, label) {
  assert.ok(result.receipt?.receiptId, `${label}: durable receipt_id missing`);
  assert.ok(result.evidencePack, `${label}: authenticated EvidencePack missing`);
  assert.match(result.evidencePack.evidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.evidencePack.content.length > 0, `${label}: EvidencePack is empty`);
  assert.ok(
    result.evidencePack.content.length <= maxEvidenceBytes,
    `${label}: EvidencePack exceeds the local ${maxEvidenceBytes}-byte bound`,
  );
  const actual = `sha256:${createHash("sha256").update(result.evidencePack.content).digest("hex")}`;
  assert.equal(actual, result.evidencePack.evidenceHash, `${label}: EvidencePack digest mismatch`);
  return result.evidencePack.content.length;
}

const codex = fromCodexToolCall({
  recipient_name: "functions.exec_command",
  parameters: { cmd: "git status --short" },
  session_id: "helm-76-codex-deny",
  risk_class: "T0",
  effect_class: "E1",
});
assert.equal(codex.actionUrn, "tool.codex.functions.exec_command");
assert.equal(codex.riskClass, "T2");
assert.equal(codex.effectClass, "E4");

let codexDispatches = 0;
const denied = await withHelmBoundary({
  actionUrn: codex.actionUrn,
  sessionId: codex.sessionId,
  tenantId,
  principal,
  apiKey,
  helmUrl,
  riskClass: codex.riskClass,
  effectClass: codex.effectClass,
  metadata: codex.metadata,
  exportEvidence: true,
  timeoutMs: 10_000,
  fetch: authenticatedFetch,
  tool: async () => {
    codexDispatches += 1;
    throw new Error("Codex DENY vector dispatched unexpectedly");
  },
})(codex.input);

assert.equal(denied.allowed, false);
assert.equal(denied.dispatched, false);
assert.equal(denied.verdict, "DENY");
assert.equal(codexDispatches, 0);
const deniedEvidenceBytes = verifyPreflightEvidence(denied, "Codex DENY");
assert.deepEqual(requests, ["/api/v1/evaluate", "/api/v1/evidence/export"]);
assert.deepEqual(preDispatchProof, ["receipt-observed", "evidence-hash-verified"]);
preDispatchProof.length = 0;

const claude = fromClaudeToolCall({
  tool_name: "Read",
  tool_input: { file_path: "README.md" },
  session_id: "helm-76-claude-allow",
  risk_class: "T0",
  effect_class: "E1",
});
assert.equal(claude.actionUrn, "tool.claude.Read");
assert.equal(claude.riskClass, "T2");
assert.equal(claude.effectClass, "E4");

let claudeDispatches = 0;
const allowed = await withHelmBoundary({
  actionUrn: claude.actionUrn,
  sessionId: claude.sessionId,
  tenantId,
  principal,
  apiKey,
  helmUrl,
  riskClass: claude.riskClass,
  effectClass: claude.effectClass,
  metadata: claude.metadata,
  exportEvidence: true,
  timeoutMs: 10_000,
  fetch: authenticatedFetch,
  tool: async (input) => {
    assert.deepEqual(
      preDispatchProof,
      ["receipt-observed", "evidence-hash-verified"],
      "Claude callback ran before receipt and EvidencePack hash proof",
    );
    claudeDispatches += 1;
    assert.equal(claudeDispatches, 1, "Claude callback must dispatch at most once");
    assert.deepEqual(input, { file_path: "README.md" });
    return { kind: "bounded-local-callback", input };
  },
})(claude.input);

assert.equal(allowed.allowed, true);
assert.equal(allowed.dispatched, true);
assert.equal(allowed.verdict, "ALLOW");
assert.equal(claudeDispatches, 1);
assert.deepEqual(allowed.output, {
  kind: "bounded-local-callback",
  input: { file_path: "README.md" },
});
const allowedEvidenceBytes = verifyPreflightEvidence(allowed, "Claude ALLOW");
assert.deepEqual(requests, [
  "/api/v1/evaluate",
  "/api/v1/evidence/export",
  "/api/v1/evaluate",
  "/api/v1/evidence/export",
]);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  kernel_sha: kernelSha,
  codex: {
    verdict: denied.verdict,
    dispatched: denied.dispatched,
    receipt_id: denied.receipt.receiptId,
    evidence_hash: denied.evidencePack.evidenceHash,
    evidence_bytes: deniedEvidenceBytes,
  },
  claude: {
    verdict: allowed.verdict,
    dispatched: allowed.dispatched,
    receipt_id: allowed.receipt.receiptId,
    evidence_hash: allowed.evidencePack.evidenceHash,
    evidence_bytes: allowedEvidenceBytes,
  },
  proof_boundary: {
    local_kernel: true,
    authenticated_preflight: true,
    evidence_hash_verified: true,
    live_provider_execution: false,
    post_effect_receipt: false,
  },
}, null, 2)}\n`);
