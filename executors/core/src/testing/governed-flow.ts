// The governed write flow an executor must complete through the HELM MCP endpoint: read the repository, push a
// branch, open a draft pull request that waits for approval, and read it back. It is written from the kernel's effect
// schemas (core/pkg/gateway/effectargs/schemas) and the K3 tool contract. Adapters run it from their conformance
// scripts; the fake gateway in this package answers it, a real edge answers it once one exists.

export interface FlowStep {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

export interface FlowOptions {
  edgeUrl: string;
  /** The map `helm-executor headers` prints. */
  headers: Record<string, string>;
  /** github.com/{owner}/{repo} */
  target: string;
  /** The mandate's branch prefix, for example helm/<seat>/. */
  branchPrefix: string;
  /** How long to wait for a person to approve the pull request. 0 reports it as awaiting approval and moves on. */
  waitForApprovalMs?: number;
  /** Called when the pull request escalates. The fake approves it here; a live run tells a person. */
  onEscalated?(attemptId: string): void | Promise<void>;
  /** Called for each finished step. */
  log?(step: FlowStep): void;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ToolResult {
  status: string;
  attemptId: string | undefined;
  result: Json;
  isError: boolean;
  raw: Json;
}

export async function runGovernedFlow(o: FlowOptions): Promise<FlowStep[]> {
  const steps: FlowStep[] = [];
  const done = (name: string, status: FlowStep["status"], detail = ""): boolean => {
    const step = { name, status, detail };
    steps.push(step);
    o.log?.(step);
    return status !== "FAIL";
  };

  let session: string | undefined;
  let id = 0;
  const rpc = async (method: string, params?: Json): Promise<{ status: number; json: Json | null }> => {
    const res = await fetch(`${o.edgeUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" } : {}), ...o.headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++id }), method, ...(params ? { params } : {}) }),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid && method === "initialize") session = sid;
    const text = await res.text();
    let json: Json | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      json = isRecord(parsed) ? parsed : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  const call = async (tool: string, args: Json): Promise<ToolResult | null> => {
    const { status, json } = await rpc("tools/call", { name: tool, arguments: args });
    const content = isRecord(json?.result) ? (json.result as Json) : null;
    const structured = content && isRecord(content.structuredContent) ? (content.structuredContent as Json) : null;
    if (status !== 200 || !structured) return null;
    return { status: String(structured.status ?? ""), attemptId: typeof structured.attempt_id === "string" ? structured.attempt_id : undefined, result: isRecord(structured.result) ? (structured.result as Json) : {}, isError: content?.isError === true, raw: structured };
  };

  // ---- connect and discover ----
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "helm-governed-flow", version: "0" } });
  if (!done("MCP initialize", init.status === 200 && isRecord(init.json?.result) ? "PASS" : "FAIL", `HTTP ${init.status}`)) return steps;
  await rpc("notifications/initialized");
  const listed = await rpc("tools/list", {});
  const tools = (isRecord(listed.json?.result) && Array.isArray((listed.json.result as Json).tools) ? ((listed.json.result as Json).tools as unknown[]) : []).map((t) => (isRecord(t) ? String(t.name) : ""));
  const needed = ["github_repository_get", "github_branch_create_from_changes", "github_pull_request_create_draft", "helm_attempt_get"];
  const missing = needed.filter((n) => !tools.includes(n));
  if (missing.length > 0) {
    done("the edge serves the GitHub effect tools", "SKIP", `not served yet: ${missing.join(", ")}`);
    return steps;
  }
  done("the edge serves the GitHub effect tools", "PASS", `${tools.length} tools`);

  // ---- read, push, replay ----
  const repo = await call("github_repository_get", { target: o.target, arguments: { schema: "helm.github.repository.get.v1" } });
  const baseBranch = String(repo?.result.default_branch ?? "");
  const baseSha = String(repo?.result.default_branch_sha ?? "");
  if (!done("github_repository_get reads the default branch head", repo?.status === "succeeded" && /^[0-9a-f]{40}$/.test(baseSha) ? "PASS" : "FAIL", repo ? `${repo.status} ${String(repo.raw.reason_code ?? repo.raw.message ?? "")}`.trim() : "no structured answer")) return steps;

  const head = `${o.branchPrefix}conformance-${Date.now().toString(36)}`;
  const branchArgs = {
    schema: "helm.github.branch.create_from_changes.v1",
    base: baseBranch,
    base_sha: baseSha,
    head,
    message: "conformance: executor adapter probe",
    files: [{ path: `conformance/${head.replace(/[^A-Za-z0-9._-]/g, "-")}.txt`, mode: "100644", content_utf8: "written by an executor adapter conformance run\n" }],
  };
  const branch = await call("github_branch_create_from_changes", { target: o.target, arguments: branchArgs });
  const commit = String(branch?.result.commit_sha ?? "");
  if (!done("github_branch_create_from_changes creates the branch", branch?.status === "succeeded" && /^[0-9a-f]{40}$/.test(commit) ? "PASS" : "FAIL", branch ? `${branch.status} ${String(branch.raw.reason_code ?? branch.raw.message ?? "")}`.trim() : "no structured answer")) return steps;

  const replay = await call("github_branch_create_from_changes", { target: o.target, arguments: branchArgs });
  done("a replay of the same call after a lost response is the same attempt", replay?.attemptId === branch?.attemptId && replay?.status === "succeeded" ? "PASS" : "FAIL", `${replay?.attemptId ?? "none"} vs ${branch?.attemptId ?? "none"}`);

  // ---- the draft pull request, which needs an approval ----
  const pr = await call("github_pull_request_create_draft", { target: o.target, arguments: { schema: "helm.github.pull_request.create_draft.v1", branch_attempt_id: branch?.attemptId, base: baseBranch, head, head_sha: commit, title: "conformance: executor adapter probe", body: "Opened by an executor adapter conformance run. Safe to close." } });
  if (!done("github_pull_request_create_draft is admitted (succeeded, or escalated for approval)", pr && (pr.status === "succeeded" || pr.status === "escalated") ? "PASS" : "FAIL", pr ? `${pr.status} ${String(pr.raw.reason_code ?? pr.raw.message ?? "")}`.trim() : "no structured answer")) return steps;

  let final = pr;
  if (pr?.status === "escalated" && pr.attemptId) {
    await o.onEscalated?.(pr.attemptId);
    const deadline = Date.now() + (o.waitForApprovalMs ?? 0);
    while (final?.status === "escalated" || final?.status === "reconciling") {
      if (Date.now() >= deadline) break;
      await sleep(250);
      final = await call("helm_attempt_get", { attempt_id: pr.attemptId });
    }
    if (final?.status === "succeeded") done("the approved pull request succeeds and reads back as a draft", final.result.draft === true ? "PASS" : "FAIL", String(final.result.url ?? ""));
    else if (final?.status === "escalated" || final?.status === "reconciling") done("the pull request waits for approval", "SKIP", `approve attempt ${pr.attemptId} in the Console, then read it back with helm_attempt_get`);
    else done("the approval decision", "FAIL", `the attempt ended as ${final?.status ?? "unknown"}`);
  }

  // ---- read back and a bad call ----
  const readBack = branch?.attemptId ? await call("helm_attempt_get", { attempt_id: branch.attemptId }) : null;
  done("helm_attempt_get reads the branch attempt back", readBack?.status === "succeeded" && readBack.attemptId === branch?.attemptId ? "PASS" : "FAIL", readBack?.status ?? "no structured answer");
  const bad = await call("github_branch_create_from_changes", { target: o.target, arguments: { schema: "helm.github.branch.create_from_changes.v1" } });
  done("arguments that break the schema are invalid and make no attempt", bad?.status === "invalid" && bad.isError && bad.attemptId === undefined ? "PASS" : "FAIL", bad?.status ?? "no structured answer");
  return steps;
}
