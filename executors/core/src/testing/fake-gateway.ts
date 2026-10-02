// A stand-in for the kernel gateway's MCP endpoint, for adapter conformance runs. It follows the K3 design
// (helm-ai-kernel docs/architecture/gateway-mcp.md, branch gateway-mcp-worker): tool names are the effect types with
// dots as underscores, a call is {target, arguments}, the answer is structuredContent with a status, effect identity is
// per work item so a replay returns the original attempt, and the pull request needs an approval before it succeeds.
// Argument checks cover what the kernel's JSON Schemas require; it does not mirror the gateway beyond that.

import { createHash, randomUUID } from "node:crypto";
import type { EpisodeRecord } from "./fake-cp.js";

type Json = Record<string, unknown>;

export interface Attempt {
  id: string;
  effectType: string;
  target: string;
  episodeId: string;
  workItemId: string;
  status: "succeeded" | "escalated";
  resultKind: string;
  result: Json;
  headSha?: string;
}

export interface McpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeGateway {
  attempts: Map<string, Attempt>;
  /** Approve an escalated attempt the way the Console would. It then dispatches and succeeds. */
  approve(attemptId: string): boolean;
  handle(rpc: Json, episode: EpisodeRecord): McpReply;
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET = /^github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "a".repeat(40);

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (o: Json, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const TOOLS: Record<string, { effect: string; description: string }> = {
  github_repository_get: { effect: "github.repository.get", description: "Read a repository's default branch head." },
  github_branch_create_from_changes: { effect: "github.branch.create_from_changes", description: "Create a branch holding the given files on top of base_sha." },
  github_pull_request_create_draft: { effect: "github.pull_request.create_draft", description: "Open a draft pull request for a branch this episode created. Needs approval." },
  helm_attempt_get: { effect: "", description: "Read back one attempt of this episode by its attempt_id." },
};

export function createFakeGateway(options: { branchPrefix?: string } = {}): FakeGateway {
  const branchPrefix = options.branchPrefix ?? "helm/";
  const attempts = new Map<string, Attempt>();
  const byKey = new Map<string, string>();
  let pullNumber = 0;

  const structured = (body: Json, isError: boolean): McpReply["body"] => ({ content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError });
  const refuse = (status: string, message: string): McpReply["body"] => structured({ status, message }, true);
  const attemptBody = (a: Attempt): Json => ({ attempt_id: a.id, effect_type: a.effectType, target: a.target, state: a.status === "succeeded" ? "OBSERVED" : "ESCALATED", status: a.status, result_kind: a.resultKind, ...(a.status === "succeeded" ? { result: a.result } : {}) });

  function checkArguments(tool: string, target: string, args: Json): string | null {
    if (tool === "github_repository_get") {
      if (args.schema !== "helm.github.repository.get.v1" || !only(args, ["schema", "branch"])) return "arguments break the github.repository.get schema";
      return null;
    }
    if (tool === "github_branch_create_from_changes") {
      const files = args.files;
      const head = args.head;
      if (args.schema !== "helm.github.branch.create_from_changes.v1" || !only(args, ["schema", "base", "base_sha", "head", "message", "files"])) return "arguments break the github.branch.create_from_changes schema";
      if (typeof args.base !== "string" || typeof args.message !== "string" || typeof args.base_sha !== "string" || !SHA.test(args.base_sha)) return "base, base_sha or message is wrong";
      if (typeof head !== "string" || head.startsWith("refs/") || !/^[A-Za-z0-9._/-]+$/.test(head) || head === DEFAULT_BRANCH) return "head is not a valid new branch name";
      if (!head.startsWith(branchPrefix)) return `head must start with the mandate's branch prefix ${branchPrefix}`;
      if (!Array.isArray(files) || files.length < 1 || files.length > 50) return "files must hold 1 to 50 entries";
      for (const f of files) {
        if (!isRecord(f) || !only(f, ["path", "mode", "content_utf8"]) || typeof f.path !== "string" || f.path === "" || f.path.startsWith("/") || f.path.includes("..") || f.path.startsWith(".github/workflows") || !["100644", "100755"].includes(String(f.mode)) || typeof f.content_utf8 !== "string") return "a file entry is wrong";
      }
      return null;
    }
    // github_pull_request_create_draft
    if (args.schema !== "helm.github.pull_request.create_draft.v1" || !only(args, ["schema", "branch_attempt_id", "base", "head", "head_sha", "title", "body"])) return "arguments break the github.pull_request.create_draft schema";
    if (typeof args.branch_attempt_id !== "string" || !UUID.test(args.branch_attempt_id) || typeof args.head_sha !== "string" || !SHA.test(args.head_sha)) return "branch_attempt_id or head_sha is wrong";
    if (typeof args.title !== "string" || args.title === "" || typeof args.body !== "string" || typeof args.base !== "string" || typeof args.head !== "string") return "title, body, base or head is wrong";
    void target;
    return null;
  }

  function call(name: string, rawArgs: unknown, episode: EpisodeRecord): McpReply["body"] {
    const tool = TOOLS[name];
    if (!tool) return undefined;
    const input = isRecord(rawArgs) ? rawArgs : {};
    if (name === "helm_attempt_get") {
      const a = typeof input.attempt_id === "string" ? attempts.get(input.attempt_id) : undefined;
      // Effect identity is per work item, so a later episode of the same work item can read an earlier episode's attempt.
      if (!a || !(a.episodeId === episode.episodeId || a.workItemId === episode.workItemId)) return refuse("not_found", "there is no such attempt of this episode");
      return structured(attemptBody(a), false);
    }
    const target = input.target;
    const args = input.arguments;
    if (!only(input, ["target", "arguments"]) || typeof target !== "string" || !TARGET.test(target) || !isRecord(args)) return refuse("invalid", 'the input must be {"target": "github.com/{owner}/{repo}", "arguments": {...}}');
    const problem = checkArguments(name, target, args);
    if (problem) return refuse("invalid", problem);

    // Effect identity is per work item: the same intent from a later episode is the same attempt.
    const key = sha(`${episode.workItemId}|${tool.effect}|${target}|${canonical(args)}`);
    const known = byKey.get(key);
    if (known) return structured(attemptBody(attempts.get(known) as Attempt), false);

    const id = randomUUID();
    let attempt: Attempt;
    if (name === "github_repository_get") {
      attempt = { id, effectType: tool.effect, target, episodeId: episode.episodeId, workItemId: episode.workItemId, status: "succeeded", resultKind: "github_repository", result: { default_branch: DEFAULT_BRANCH, default_branch_sha: DEFAULT_SHA, branch: typeof args.branch === "string" ? args.branch : "", branch_sha: "", branch_exists: false } };
    } else if (name === "github_branch_create_from_changes") {
      const commit = sha(`${args.base_sha}|${canonical(args.files)}`).slice(0, 40);
      attempt = { id, effectType: tool.effect, target, episodeId: episode.episodeId, workItemId: episode.workItemId, status: "succeeded", resultKind: "github_branch", headSha: commit, result: { ref: `refs/heads/${String(args.head)}`, commit_sha: commit, base_sha: args.base_sha, files_digest: sha(canonical(args.files)) } };
    } else {
      const branch = attempts.get(String(args.branch_attempt_id));
      if (!branch || branch.target !== target || branch.effectType !== "github.branch.create_from_changes") return refuse("refused", "branch_attempt_id is not a branch this episode created on this target");
      if (branch.headSha !== args.head_sha) return refuse("refused", "head_sha is not the branch's head commit");
      pullNumber++;
      attempt = { id, effectType: tool.effect, target, episodeId: episode.episodeId, workItemId: episode.workItemId, status: "escalated", resultKind: "github_pull_request", result: { url: `https://${target}/pull/${pullNumber}`, number: pullNumber, head_ref: String(args.head), head_sha: String(args.head_sha), base_ref: String(args.base), draft: true, state: "open" } };
    }
    attempts.set(id, attempt);
    byKey.set(key, id);
    return structured(attemptBody(attempt), false);
  }

  return {
    attempts,
    approve(attemptId) {
      const a = attempts.get(attemptId);
      if (!a || a.status !== "escalated") return false;
      a.status = "succeeded";
      return true;
    },
    handle(rpc, episode) {
      const id = rpc.id;
      const reply = (result: unknown): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
      switch (rpc.method) {
        case "initialize":
          return { status: 200, headers: { "Mcp-Session-Id": randomUUID() }, body: { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-helm-gateway", version: "0" } } } };
        case "notifications/initialized":
          return { status: 202 };
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: name === "helm_attempt_get" ? { type: "object", additionalProperties: false, required: ["attempt_id"], properties: { attempt_id: { type: "string" } } } : { type: "object", additionalProperties: false, required: ["target", "arguments"], properties: { target: { type: "string" }, arguments: { type: "object" } } } })) });
        case "tools/call": {
          const params = isRecord(rpc.params) ? rpc.params : {};
          const out = call(String(params.name), params.arguments, episode);
          if (out === undefined) return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } } };
          return reply(out);
        }
        default:
          return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } } };
      }
    },
  };
}
