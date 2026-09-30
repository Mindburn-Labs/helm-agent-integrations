// Render the worker AgentCard (with the required episode extension) from the shared template.

import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

function template(): Json {
  const url = new URL("../schema/agent-card.template.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Json;
}

function fill(node: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => fill(item, values));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Json).map(([k, v]) => [k, fill(v, values)]));
  }
  if (typeof node === "string" && node.includes("{{")) {
    let text = node;
    for (const [key, value] of Object.entries(values)) {
      const token = `{{${key}}}`;
      if (text === token) return structuredClone(value);
      text = text.split(token).join(String(value));
    }
    if (text.includes("{{")) throw new Error(`unfilled placeholder in AgentCard template: ${text}`);
    return text;
  }
  return node;
}

/** The AgentCard JSON (A2A v1.0 wire form) for a worker of `framework` served at `url`. */
export function renderAgentCard(fields: {
  framework: string;
  url: string;
  version: string;
  modelApis: readonly string[];
}): Json {
  return fill(template(), {
    name: `HELM worker (${fields.framework})`,
    description: `Runs HELM episodes with ${fields.framework}. Model APIs: ${fields.modelApis.join(", ")}.`,
    version: fields.version,
    url: fields.url,
    model_apis: [...fields.modelApis],
  }) as Json;
}
