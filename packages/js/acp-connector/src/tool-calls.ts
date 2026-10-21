import { canonicalJson, kernelToolInput } from "./kernel-evaluator.js";
import type { ToolAction, ToolCallUpdate } from "./types.js";

export const ACP_EVENT_PAYLOAD_CAP = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function absoluteUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return new URL(value).href; } catch { return undefined; }
}

/** A permission must identify actual arguments, even when they are empty. */
export function concreteAction(call: ToolCallUpdate): ToolAction {
  const input = record(call.rawInput);
  if (!input) throw new Error("HELM ACP: missing concrete rawInput (fail-closed)");
  // Also rejects non-JSON values and oversized authorization inputs.
  kernelToolInput(input);
  const name = text(call.name) ?? text(call.title);
  const match = name?.match(/^mcp\.([^.]+)\.(.+)$/) ?? name?.match(/^mcp__(.+?)__(.+)$/);
  const wrapped = ("server" in input && "tool" in input) || ("arguments" in input && ("server" in input || "tool" in input));
  if (wrapped && (!text(input.server) || !text(input.tool) || !record(input.arguments))) throw new Error("HELM ACP: incomplete MCP tool arguments (fail-closed)");
  const server = (wrapped ? text(input.server) : undefined) ?? match?.[1];
  const tool = (wrapped ? text(input.tool) : undefined) ?? match?.[2] ?? text(call.name) ?? text(call.title);
  if (!tool || (!call.name && !input.tool && !match && tool === call.kind)) throw new Error("HELM ACP: missing concrete tool identity (fail-closed)");
  if (match && (match[1] !== server || match[2] !== tool)) {
    throw new Error("HELM ACP: tool identity conflicts with rawInput (fail-closed)");
  }
  const args = wrapped ? input.arguments : input;
  if (!record(args)) throw new Error("HELM ACP: tool arguments must be a JSON object (fail-closed)");
  const url = absoluteUrl(record(args)?.url);
  if (record(args)?.url !== undefined && !url) throw new Error("HELM ACP: invalid tool URL (fail-closed)");
  return { ...(server ? { server } : {}), tool, arguments: args, ...(url ? { url } : {}) };
}

/** Joins sparse permission requests to the tool calls on this connection. */
export class ToolCallTracker {
  private readonly calls = new Map<string, ToolCallUpdate>();
  private readonly contexts = new Map<string, { url: string; sourceToolCallId: string }>();
  private readonly pages = new Map<string, string>();

  beginPrompt(): void { this.calls.clear(); }

  observe(update: ToolCallUpdate): void {
    const id = text(update.toolCallId);
    if (!id) throw new Error("HELM ACP: tool update missing toolCallId");
    if (Buffer.byteLength(canonicalJson(update), "utf8") > ACP_EVENT_PAYLOAD_CAP) {
      throw new Error("HELM ACP: tool event exceeds retained evidence limit (fail-closed)");
    }
    if (this.calls.size >= 10_000 && !this.calls.has(id)) throw new Error("HELM ACP: too many pending tool calls");
    const previous = this.calls.get(id) ?? {};
    // Completion messages may clear rawInput; retain the input being completed.
    const merged = { ...previous, ...update, rawInput: update.rawInput ?? previous.rawInput };
    this.calls.set(id, merged);
    if (update.status === "completed") this.confirmBrowserContext(id, merged);
  }

  correlate(request: ToolCallUpdate, completedEvidence = false): ToolCallUpdate {
    const id = text(request.toolCallId);
    if (!id) throw new Error("HELM ACP: permission missing toolCallId");
    const previous = this.calls.get(id);
    if (!completedEvidence && (previous?.status === "completed" || previous?.status === "failed")) throw new Error("HELM ACP: permission references a completed tool call (fail-closed)");
    if (previous) {
      for (const field of ["name", "kind", "rawInput"] as const) {
        if (request[field] !== undefined && previous[field] !== undefined && canonicalJson(request[field]) !== canonicalJson(previous[field])) {
          throw new Error(`HELM ACP: permission ${field} disagrees with its tool call (fail-closed)`);
        }
      }
    }
    const merged = { ...previous, ...request, rawInput: request.rawInput ?? previous?.rawInput };
    // Do not authorize previous results, display diffs, or a generic kind.
    return {
      toolCallId: id,
      ...(merged.name ? { name: merged.name } : {}),
      ...(merged.title ? { title: merged.title } : {}),
      ...(merged.kind ? { kind: merged.kind } : {}),
      ...(merged.rawInput !== undefined ? { rawInput: merged.rawInput } : {}),
    };
  }

  action(call: ToolCallUpdate): ToolAction {
    const action = concreteAction(call);
    if (!action.server) return action;
    if (!/browser|chrome|playwright|devtools/i.test(action.server) && !/^(new_page|navigate_page|browser_navigate)$/.test(action.tool)) return action;
    const args = record(action.arguments)!;
    const pageId = args.pageId ?? args.page_id;
    const selected = pageId === undefined ? undefined : this.pages.get(`${action.server}:${String(pageId)}`);
    if (pageId !== undefined && !selected) throw new Error("HELM ACP: browser target page has no confirmed URL (fail-closed)");
    const context = selected ? { url: selected, sourceToolCallId: call.toolCallId! } : this.contexts.get(action.server);
    if (!action.url && context) {
      action.url = context.url;
      action.browserContext = context;
    }
    if (!action.url && !["list_pages", "browser_tabs", "take_snapshot", "browser_snapshot"].includes(action.tool)) {
      throw new Error("HELM ACP: browser operation has no confirmed URL context (fail-closed)");
    }
    return action;
  }

  private confirmBrowserContext(id: string, call: ToolCallUpdate): void {
    let action: ToolAction;
    try { action = concreteAction(call); } catch { return; }
    if (!action.server) return;
    const output = canonicalJson(call.rawOutput ?? call.content ?? null);
    // Chrome MCP page lists and snapshots give the selected page explicitly.
    const decoded = output.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    let selectedUrl: string | undefined;
    for (const line of decoded.split("\n")) {
      const page = line.match(/(?:^|\s)(\d+):.*?\((https?:\/\/[^\s)]+)\)(.*)/);
      if (page) {
        const url = absoluteUrl(page[2]);
        if (url) {
          this.pages.set(`${action.server}:${page[1]}`, url);
          if (page[3].includes("[selected]")) selectedUrl = url;
        }
      }
    }
    const snapshot = decoded.match(/RootWebArea[^\n]*\burl="([^"]+)"/);
    const confirmed = absoluteUrl(snapshot?.[1]) ?? selectedUrl;
    if (confirmed) this.contexts.set(action.server, { url: confirmed, sourceToolCallId: id });
    else if (!/^(list_pages|browser_tabs|take_snapshot|browser_snapshot|take_screenshot)$/.test(action.tool)) this.contexts.delete(action.server);
  }
}
