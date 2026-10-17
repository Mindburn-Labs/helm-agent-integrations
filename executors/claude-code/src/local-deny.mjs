#!/usr/bin/env node
// Local convenience gate for the dedicated managed executor. Credential custody
// and network confinement remain the enforcement boundary for shell escapes.
import {readFileSync, realpathSync} from "node:fs";
import {basename} from "node:path";
import {fileURLToPath} from "node:url";

const MAX_INPUT = 128 * 1024;
const PROVIDERS = new Set(["api.github.com", "github.com", "api.linear.app"]);
const WRITE = /^(?:create|update|delete|archive|save|write|comment|add|share|unshare)(?:_|$)/i;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const WRAPPERS = new Set(["env", "timeout", "time", "nice", "nohup", "stdbuf", "command"]);

function words(command) {
  const groups = [[]];
  let word = "", quote = "", escaped = false;
  const push = () => { if (word !== "") { groups.at(-1).push(word); word = ""; } };
  for (const char of command) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char) || ";&|()".includes(char)) {
      push();
      if (";&|()".includes(char) || char === "\n") groups.push([]);
      continue;
    }
    word += char;
  }
  if (quote || escaped) throw new Error("Unclosed shell command");
  push();
  return groups.filter((group) => group.length);
}

function operation(args, valuedFlags) {
  for (let i = 0; i < args.length; i++) {
    if (valuedFlags.has(args[i])) { i++; continue; }
    if (args[i].startsWith("-")) continue;
    return [args[i], args.slice(i + 1)];
  }
  return ["", []];
}

function providerUrl(arg) {
  try { return PROVIDERS.has(new URL(arg).hostname); } catch { return false; }
}

export function shellDeny(command, depth = 0) {
  if (typeof command !== "string" || !command.trim() || depth > 4) return "Unclassifiable shell command in managed executor";
  let groups;
  try { groups = words(command); } catch { return "Unclassifiable shell command in managed executor"; }
  for (const group of groups) {
    let at = 0;
    while (at < group.length) {
      const item = basename(group[at]);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) { at++; continue; }
      if (!WRAPPERS.has(item)) break;
      at++;
      while (at < group.length && (group[at].startsWith("-") || /^\d+[smhd]?$/.test(group[at]))) at++;
    }
    const executable = basename(group[at] ?? "");
    const args = group.slice(at + 1);
    if (executable === "kubectl" || executable === "flux") return "Raw cluster or Flux command is disabled";
    if (executable === "git" && operation(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]))[0] === "push") return "Raw git push is disabled";
    if (executable === "gh") {
      const [first, rest] = operation(args, new Set(["-R", "--repo", "--hostname"]));
      if (first === "pr" && operation(rest, new Set(["-R", "--repo"]))[0] === "merge") return "Raw PR merge is disabled";
    }
    if (executable === "linear" && args.some((arg) => WRITE.test(arg))) return "Raw Linear write is disabled";
    if (["curl", "wget", "http"].includes(executable) && args.some(providerUrl)) return "Direct provider HTTP is disabled";
    if (SHELLS.has(executable)) {
      const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
      if (flag >= 0) {
        const nested = shellDeny(args[flag + 1], depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}

export function toolDeny(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.tool_name !== "string") return "Invalid managed tool event";
  const name = event.tool_name;
  if (name === "Bash") return shellDeny(event.tool_input?.command);
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp__helm__")) return null;
  if (lower.startsWith("mcp__") && lower.includes("linear") && /(?:^|_)(?:create|update|delete|archive|save|write|comment|add|share|unshare)(?:_|$)/.test(lower)) return "Direct Linear MCP write is disabled";
  return null;
}

export function hookResult(reason) {
  return reason ? {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason}} : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    const raw = readFileSync(0);
    if (!raw.length || raw.length > MAX_INPUT) throw new Error("Invalid managed hook input size");
    const event = JSON.parse(raw.toString("utf8"));
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.tool_name !== "string") throw new Error("Invalid managed hook event");
    const result = hookResult(toolDeny(event));
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    // onFailure:block in the managed hook fails closed when the script cannot
    // classify input. No raw hook payload or credential is printed.
    process.exitCode = 1;
  }
}
