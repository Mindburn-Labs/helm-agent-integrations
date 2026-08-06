/**
 * Runnable, deterministic examples for every framework intent normalizer.
 *
 * Run from this package with:
 *
 *   npm run example:framework-helpers
 *
 * The examples normalize representative framework call payloads and exercise
 * the preflight contract with an in-process transport double. They do not call
 * a provider API, a live Kernel, or dispatch an external effect.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  type BoundaryIntent,
  type FetchLike,
  fromBrowserUseAction,
  fromClaudeToolCall,
  fromCodexToolCall,
  fromComposioAction,
  fromE2BExecution,
  fromHermesToolCall,
  fromMastraToolCall,
  fromOpenClawSkillCall,
  fromTinyFishAgentRun,
  fromTinyFishBrowserSession,
  fromTinyFishFetch,
  fromTinyFishSearch,
  preflightAction,
  withHelmBoundary,
} from "./index.js";

export interface FrameworkHelperExample {
  helper: string;
  intent: BoundaryIntent;
}

export function frameworkHelperExamples(): FrameworkHelperExample[] {
  return [
    {
      helper: "Hermes",
      intent: fromHermesToolCall({
        tool_name: "shell.exec",
        arguments: { command: "pwd" },
        task_id: "task-demo-1",
      }),
    },
    {
      helper: "OpenClaw",
      intent: fromOpenClawSkillCall({
        skill: "mail",
        action: "send",
        input: { to: "review@example.test", subject: "Review" },
      }),
    },
    {
      helper: "Mastra",
      intent: fromMastraToolCall({
        toolName: "create_ticket",
        args: { project: "HELM", title: "Review effect" },
      }),
    },
    {
      helper: "Codex",
      intent: fromCodexToolCall({
        recipient_name: "functions.exec_command",
        parameters: { cmd: "git status --short" },
        session_id: "codex-demo-1",
        risk_class: "T0",
        effect_class: "E1",
      }),
    },
    {
      helper: "Claude Code",
      intent: fromClaudeToolCall({
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        session_id: "claude-demo-1",
        risk_class: "T0",
        effect_class: "E1",
      }),
    },
    {
      helper: "Browser Use",
      intent: fromBrowserUseAction({
        action: "submit",
        url: "https://shop.example.test/checkout",
        form: { confirm: true },
      }),
    },
    {
      helper: "TinyFish Search",
      intent: fromTinyFishSearch({ query: "HELM governed effects" }),
    },
    {
      helper: "TinyFish Fetch",
      intent: fromTinyFishFetch({ urls: ["https://example.test/source"], ttl: 3600 }),
    },
    {
      helper: "TinyFish Browser",
      intent: fromTinyFishBrowserSession({
        url: "https://portal.example.test",
        credential_grant_ref: "grant:demo",
      }),
    },
    {
      helper: "TinyFish Agent",
      intent: fromTinyFishAgentRun({
        url: "https://shop.example.test/checkout",
        goal: "Submit the saved cart",
        action_intent: "submit",
      }),
    },
    {
      helper: "E2B",
      intent: fromE2BExecution({ language: "python", code: "print(1)" }),
    },
    {
      helper: "Composio",
      intent: fromComposioAction({
        app: "salesforce",
        action: "export_records",
        payload: { object: "Lead" },
      }),
    },
  ];
}

export function verifyFrameworkHelperExamples(): FrameworkHelperExample[] {
  const examples = frameworkHelperExamples();
  assert.equal(examples.length, 12, "all twelve framework helpers must stay runnable");

  const expected = [
    ["Hermes", "tool.hermes.shell.exec", undefined, undefined],
    ["OpenClaw", "tool.openclaw.send", undefined, undefined],
    ["Mastra", "tool.mastra.create_ticket", undefined, undefined],
    ["Codex", "tool.codex.functions.exec_command", "T2", "E4"],
    ["Claude Code", "tool.claude.Bash", "T2", "E4"],
    ["Browser Use", "tool.browser_use.submit", "T2", "E4"],
    ["TinyFish Search", "tool.tinyfish.search.query", "T2", "E2"],
    ["TinyFish Fetch", "tool.tinyfish.fetch.extract", "T2", "E2"],
    ["TinyFish Browser", "tool.tinyfish.browser.session", "T2", "E3"],
    ["TinyFish Agent", "tool.tinyfish.agent.external_action", "T2", "E4"],
    ["E2B", "tool.e2b.execute", "T2", "E4"],
    ["Composio", "tool.composio.salesforce.export_records", undefined, undefined],
  ] as const;

  for (const [index, [helper, actionUrn, riskClass, effectClass]] of expected.entries()) {
    const example = examples[index];
    assert.equal(example.helper, helper);
    assert.equal(example.intent.actionUrn, actionUrn);
    assert.equal(example.intent.riskClass, riskClass);
    assert.equal(example.intent.effectClass, effectClass);
  }

  const codex = examples[3].intent;
  assert.deepEqual(codex.input, { cmd: "git status --short" });
  assert.equal(codex.metadata?.risk_class, undefined, "caller downgrades must not survive normalization");

  const e2b = examples[10].intent;
  assert.equal(e2b.metadata?.network, "external", "unknown E2B network capability must fail closed");

  return examples;
}

function contractResponse(verdict: "ALLOW" | "DENY") {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string): string | null {
        const values: Record<string, string> = {
          "x-helm-decision-id": `decision-${verdict.toLowerCase()}`,
          "x-helm-receipt-id": `receipt-${verdict.toLowerCase()}`,
          "x-helm-verdict": verdict,
        };
        return values[name.toLowerCase()] ?? null;
      },
    },
    json: async () => ({
      verdict,
      decision_id: `decision-${verdict.toLowerCase()}`,
      receipt_id: `receipt-${verdict.toLowerCase()}`,
    }),
    text: async () => verdict,
  };
}

/**
 * Exercise every normalizer through the versioned Kernel preflight wire shape.
 *
 * The transport is an in-process contract double. It validates the same
 * `/api/v1/evaluate` request and dispatch-gate behavior without claiming a
 * live Kernel, a provider call, or external execution.
 */
export async function verifyFrameworkHelperPreflightContract(): Promise<FrameworkHelperExample[]> {
  const examples = verifyFrameworkHelperExamples();
  const observed: Array<Record<string, unknown>> = [];
  const allowFetch: FetchLike = async (url, init) => {
    assert.equal(url, "https://kernel.example.test/api/v1/evaluate");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.Authorization, "Bearer framework-example-api-key");
    assert.equal(init?.headers?.["X-Helm-Tenant-ID"], "framework-example-tenant");
    assert.equal(init?.headers?.["X-Helm-Principal-ID"], "framework-example-principal");
    observed.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return contractResponse("ALLOW");
  };

  for (const example of examples) {
    const intent = example.intent;
    const result = await preflightAction({
      actionUrn: intent.actionUrn,
      input: intent.input,
      sessionId: intent.sessionId ?? "framework-example-session",
      tenantId: "framework-example-tenant",
      principal: "framework-example-principal",
      apiKey: "framework-example-api-key",
      helmUrl: "https://kernel.example.test",
      riskClass: intent.riskClass,
      effectClass: intent.effectClass,
      metadata: intent.metadata,
      fetch: allowFetch,
    });
    assert.equal(result.decision.verdict, "ALLOW");

    const payload = observed.at(-1);
    assert.ok(payload);
    assert.equal(payload.action, "EXECUTE_TOOL");
    assert.equal(payload.resource, intent.actionUrn);
    const context = payload.context as Record<string, unknown>;
    assert.equal(context.tool, intent.actionUrn);
    assert.deepEqual(context.args, intent.input);
    assert.deepEqual(context.arguments, intent.input);
    assert.equal(context.session_id, intent.sessionId ?? "framework-example-session");
  }

  let deniedDispatches = 0;
  const denied = await withHelmBoundary({
    actionUrn: "tool.hermes.unknown",
    sessionId: "framework-example-session",
    tenantId: "framework-example-tenant",
    principal: "framework-example-principal",
    apiKey: "framework-example-api-key",
    helmUrl: "https://kernel.example.test",
    tool: async () => {
      deniedDispatches += 1;
      return { unexpected: true };
    },
    fetch: async () => contractResponse("DENY"),
  })({ attempt: "unknown-tool" });
  assert.equal(denied.verdict, "DENY");
  assert.equal(denied.dispatched, false);
  assert.equal(deniedDispatches, 0, "the default-deny vector must not dispatch");

  return examples;
}

function summarize(examples: FrameworkHelperExample[]) {
  return examples.map(({ helper, intent }) => ({
    helper,
    action_urn: intent.actionUrn,
    risk_class: intent.riskClass ?? null,
    effect_class: intent.effectClass ?? null,
  }));
}

async function main() {
  const examples = await verifyFrameworkHelperPreflightContract();
  process.stdout.write(`${JSON.stringify({
    helpers: summarize(examples),
    preflight_contracts: examples.length,
    default_deny_dispatched: false,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
