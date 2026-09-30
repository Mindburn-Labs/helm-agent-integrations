// Only private, structured IPC reaches stdout. Vendor logs never reach the A2A stream.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OutcomeTracker } from "@mindburn/helm-worker-contract";
import { normalizeToolResult } from "./result.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const allowed = new Set(config.allowed);
const tracker = new OutcomeTracker();
const controller = new AbortController();
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
process.on("SIGTERM", () => controller.abort());
const bare = (name) => name.startsWith("mcp__helm__") ? name.slice(11) : name;

try {
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
    canUseTool: async (name, args) => allowed.has(bare(name)) && !tracker.stopped
      ? { behavior: "allow", updatedInput: args }
      : { behavior: "deny", message: "Tool is not allowed in this HELM episode." },
    hooks: {
      PreToolUse: [{ hooks: [async (event) => {
        if (!allowed.has(bare(event.tool_name)) || tracker.stopped) return {
          continue: false, stopReason: "HELM tool boundary",
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
            permissionDecisionReason: "Tool is not allowed in this HELM episode." },
        };
        return {};
      }] }],
      PostToolUse: [{ hooks: [async (event) => {
        const name = bare(event.tool_name);
        const response = event.tool_response;
        const result = normalizeToolResult(response);
        const observation = tracker.observe(name, event.tool_input, result);
        emit({ type: "tool", name, arguments: event.tool_input, is_error: result.isError,
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
