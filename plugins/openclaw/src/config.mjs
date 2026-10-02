import {isAbsolute} from "node:path";

export const PLUGIN_ID = "helm-openclaw";
export const PROVIDER_ID = "helm";
export const RUNTIME_MARKER = "helm-executor-runtime-only";

// These broad native capabilities cannot prove a governed effect. The gateway
// and executor network profile enforce custody; this local hook is observed-only.
export const BLOCKED_NATIVE_TOOLS = Object.freeze([
  "exec", "bash", "shell", "shell_command", "process", "browser", "web_fetch", "web_search",
  "github_push", "github_merge_pr", "github_create_pr", "linear_create_issue", "linear_update_issue",
  "kubectl", "flux",
]);

const name = {type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$"};
const names = {type: "array", items: name, uniqueItems: true, maxItems: 256};
export const CONFIG_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["executorHome", "slot", "edgeOrigin", "model", "maxOutputTokens", "contextWindow", "grantedTools"],
  properties: {
    executorHome: {type: "string", minLength: 1},
    slot: {type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$"},
    edgeOrigin: {type: "string", format: "uri"},
    model: {type: "string", minLength: 1, maxLength: 128},
    maxOutputTokens: {type: "integer", minimum: 1, maximum: 1048576},
    contextWindow: {type: "integer", minimum: 1, maximum: 1048576},
    grantedTools: names, observedNativeTools: names, blockedNativeTools: names,
  },
};

export function configuration(raw) {
  const keys = new Set(Object.keys(CONFIG_SCHEMA.properties));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).some((key) => !keys.has(key))
      || typeof raw.executorHome !== "string" || !isAbsolute(raw.executorHome)
      || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw.slot ?? "")
      || typeof raw.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(raw.model)
      || !Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1 || raw.maxOutputTokens > 1048576
      || !Number.isSafeInteger(raw.contextWindow) || raw.contextWindow < raw.maxOutputTokens || raw.contextWindow > 1048576) {
    throw new Error("Invalid HELM plugin configuration");
  }
  const edge = new URL(raw.edgeOrigin);
  if (edge.protocol !== "https:" || edge.username || edge.password || edge.search || edge.hash || edge.pathname !== "/") {
    throw new Error("HELM executor edge must be an explicit HTTPS origin");
  }
  const list = (value, required = false) => {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || value.length > 256 || new Set(value).size !== value.length
        || value.some((item) => typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item))) {
      throw new Error("Invalid HELM plugin tool surface");
    }
    return [...value];
  };
  const granted = list(raw.grantedTools, true);
  const observed = list(raw.observedNativeTools);
  const blocked = [...new Set([...BLOCKED_NATIVE_TOOLS, ...list(raw.blockedNativeTools)])];
  if (observed.some((tool) => granted.includes(tool) || blocked.includes(tool))) {
    throw new Error("Native tools must be distinct from gateway and blocked tools");
  }
  return Object.freeze({...raw, edgeOrigin: edge.origin, grantedTools: Object.freeze(granted),
    observedNativeTools: Object.freeze(observed), blockedNativeTools: Object.freeze(blocked)});
}
