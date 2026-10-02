// A small model of how Claude Code matches permission deny rules, for the cases the docs spell out
// (code.claude.com/docs/en/permissions: wildcard patterns, compound commands, wrappers, tool-name globs).
// It exists so a change to the deny list is caught by the tests and by conformance without a running Claude Code.
// It is NOT the enforcement: the live conformance step runs the real client, and the docs say Bash rules are not a
// security boundary (git -C . push, an absolute path or sh -c get past them; E2: the gateway holds the credentials).

import { homedir } from "node:os";

const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"]);

function globToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** The simple commands of a compound command, split on && || ; | |& & and newlines. */
function subcommands(command) {
  return command.split(/&&|\|\||\|&|[;|&\n]/).map((c) => c.trim()).filter(Boolean);
}

/** Drop leading VAR=value assignments and the wrappers Claude Code strips before matching a Bash rule. */
function stripWrappers(command) {
  const words = command.split(/\s+/);
  for (;;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    else if (WRAPPERS.has(words[0] ?? "")) {
      words.shift();
      // timeout takes a duration, nice -n takes a number: skip flags and numeric arguments.
      while (words.length > 0 && (/^-/.test(words[0]) || /^\d+[smhd]?$/.test(words[0]))) words.shift();
    } else break;
  }
  return words.join(" ");
}

function bashMatches(spec, command) {
  const trailing = /^(.*) \*$/.exec(spec);
  return subcommands(command).some((sub) => {
    const c = stripWrappers(sub);
    if (trailing && !trailing[1].includes("*")) return c === trailing[1] || c.startsWith(`${trailing[1]} `);
    return globToRegExp(spec).test(c);
  });
}

function pathMatches(spec, path) {
  const expanded = spec.replace(/^~/, homedir());
  const prefix = expanded.replace(/\/\*\*$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The first rule that denies this tool call, or null. `input` is the tool input object. */
export function firstDenyMatch(rules, tool, input = {}) {
  for (const rule of rules) {
    const withSpec = /^([A-Za-z_]+)\((.*)\)$/.exec(rule);
    if (!withSpec) {
      if (globToRegExp(rule).test(tool)) return rule;
      continue;
    }
    const [, ruleTool, spec] = withSpec;
    if (ruleTool !== tool) continue;
    if (tool === "Bash" && typeof input.command === "string" && bashMatches(spec, input.command)) return rule;
    if ((tool === "Read" || tool === "Edit" || tool === "Write") && typeof input.file_path === "string" && pathMatches(spec, input.file_path)) return rule;
  }
  return null;
}
