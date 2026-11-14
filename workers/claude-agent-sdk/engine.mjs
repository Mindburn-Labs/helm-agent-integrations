// Only private, structured IPC reaches stdout. Vendor logs never reach the A2A stream.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OutcomeTracker, bindTarget } from "@mindburn/helm-worker-contract";
import { normalizeToolResult } from "./result.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const allowed = new Set(config.allowed);
const tracker = new OutcomeTracker(config.evaluation_target ?? null);
const controller = new AbortController();
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
process.on("SIGTERM", () => controller.abort());
const bare = (name) => name.startsWith("mcp__helm__") ? name.slice(11) : name;
const denied = "Tool is not allowed in this HELM episode.";

try {
  // The targets the episode fixes. The SDK sends MCP calls itself, so its hooks are the only
  // place to fill one the model left out and to refuse one that differs before it is sent.
  const targets = config.targets;
  if (targets === null || typeof targets !== "object" || Array.isArray(targets)
      || Object.values(targets).some((value) => typeof value !== "string" || !value)) {
    throw new Error("Invalid bound targets");
  }
  // Discover the catalog through the actual MCP SDK so disallowedTools removes every
  // ungranted MCP tool from the model's context, as well as denying its execution.
  const client = new Client({ name: "helm-claude-worker", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp_url), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }));
  const catalog = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    catalog.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();

  const options = {
    model: config.model, systemPrompt: config.system, tools: [],
    allowedTools: config.allowed.map((name) => `mcp__helm__${name}`),
    disallowedTools: catalog.filter((tool) => !allowed.has(tool.name))
      .map((tool) => `mcp__helm__${tool.name}`),
    permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true,
    persistSession: false, cwd: config.home, maxTurns: 20,
    mcpServers: { helm: { type: "http", url: config.mcp_url,
      headers: { Authorization: `Bearer ${config.token}` } } },
    env: {
      PATH: process.env.PATH, HOME: config.home, TMPDIR: config.home,
      ANTHROPIC_BASE_URL: config.base_url, ANTHROPIC_AUTH_TOKEN: config.token,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.max_output_tokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
    },
    canUseTool: async (name, args) => {
      if (!allowed.has(bare(name)) || tracker.stopped) return { behavior: "deny", message: denied };
      // PreToolUse already bound this input; binding it again is a no-op unless it was skipped.
      const { arguments: sent, refusal } = bindTarget(bare(name), args, targets);
      return refusal ? { behavior: "deny", message: refusal.text } : { behavior: "allow", updatedInput: sent };
    },
    hooks: {
      PreToolUse: [{ hooks: [async (event) => {
        const name = bare(event.tool_name);
        if (!allowed.has(name) || tracker.stopped) return {
          continue: false, stopReason: "HELM tool boundary",
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
            permissionDecisionReason: denied },
        };
        const { arguments: sent, refusal } = bindTarget(name, event.tool_input, targets);
        if (refusal) {
          // An ordinary tool error the model can act on; the episode goes on.
          tracker.observe(name, sent, refusal);
          emit({ type: "tool", name, arguments: sent, is_error: true,
            structured: refusal.structured, text: refusal.text });
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
            permissionDecisionReason: refusal.text } };
        }
        // Unbound input passes as before; a filled-in target replaces the model's input.
        return sent === event.tool_input ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse",
          permissionDecision: "allow", updatedInput: sent } };
      }] }],
      PostToolUse: [{ hooks: [async (event) => {
        const name = bare(event.tool_name);
        const response = event.tool_response;
        const result = normalizeToolResult(response);
        // The input that was sent: PreToolUse bound it, so binding again only restates it.
        const sent = bindTarget(name, event.tool_input, targets).arguments;
        const observation = tracker.observe(name, sent, result);
        emit({ type: "tool", name, arguments: sent, is_error: result.isError,
          structured: result.structured, text: result.text });
        return observation.stop ? { continue: false, stopReason: "HELM episode parked or reported" } : {};
      }] }],
    },
    abortController: controller, stderr: () => {},
  };
  for await (const event of query({ prompt: config.user, options })) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") emit({ type: "text", text: block.text });
      }
    }
    if (event.type === "result" && event.is_error) throw new Error("SDK result failed");
  }
} catch {
  emit({ type: "error" });
  process.exitCode = 1;
}
