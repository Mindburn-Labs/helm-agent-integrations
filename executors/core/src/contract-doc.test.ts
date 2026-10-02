// CONTRACT.md is what codex:executors and codex:cp-org build against. These tests keep it equal to the code:
// exit codes, commands, environment variables, wire paths and the JSON examples.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { statusReport } from "./commands/status.js";
import { episodeStopPath, episodeTokenPath, episodesPath, observationsPath } from "./contract.js";
import { EXIT_CODES } from "./errors.js";
import { USAGE } from "./main.js";
import { checkedOut, schemaValidator, world } from "./test-utils.js";

const doc = readFileSync(new URL("../CONTRACT.md", import.meta.url), "utf8");
const distDir = fileURLToPath(new URL(".", import.meta.url));

function jsonBlocks(): unknown[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  let language = "";
  for (const line of doc.split("\n")) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (!fence) {
      current?.push(line);
    } else if (current === null) {
      current = [];
      language = fence[1] ?? "";
    } else {
      if (language === "json") blocks.push(current.join("\n"));
      current = null;
    }
  }
  return blocks.map((text) => JSON.parse(text) as unknown);
}

test("the exit code table is the one in the code", () => {
  const rows = [...doc.matchAll(/^\| (\d) \| (?:`([a-z_]+)`)? ?\|/gm)].map((m) => [Number(m[1]), m[2]] as const);
  assert.equal(rows.length, 8);
  assert.deepEqual(
    Object.fromEntries(rows.filter(([, name]) => name).map(([code, name]) => [name, code])),
    EXIT_CODES,
  );
  assert.equal(rows.find(([code]) => code === 0)?.[1], undefined);
});

test("the commands in section 1 are the commands --help lists", () => {
  const documented = new Set([...doc.matchAll(/^\| `helm-executor (\w+)/gm)].map((m) => m[1]));
  const listed = new Set([...USAGE.matchAll(/^ {2}(\w+) /gm)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...listed].sort());
  assert.equal(documented.size, 8);
});

test("the environment variables in section 2 are the ones the code reads", () => {
  const documented = new Set([...doc.matchAll(/^\| `(HELM_EXECUTOR_[A-Z_]+)`/gm)].map((m) => m[1]));
  const read = new Set<string>();
  for (const file of readdirSync(distDir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".js") || file.includes("test") || file.startsWith("testing")) continue;
    for (const m of readFileSync(join(distDir, file), "utf8").matchAll(/HELM_EXECUTOR_[A-Z_]+/g)) read.add(m[0]);
  }
  read.delete("HELM_EXECUTOR_TEST_POLL_MS");
  assert.deepEqual([...documented].sort(), [...read].sort());
});

test("the control plane paths in section 7 are the ones the client builds", () => {
  const org = "/api/v1/workspaces/WS/organizations/ORG";
  const template = (path: string): string => path.replace(org, "{ORG}").replace("/WI/", "/{work_item_id}/").replace("/EP/", "/{episode_id}/");
  assert.ok(doc.includes(`\`POST ${template(episodesPath("WS", "ORG", "WI"))}\``));
  assert.ok(doc.includes(`\`POST ${template(episodeTokenPath("WS", "ORG", "WI", "EP"))}\``));
  assert.ok(doc.includes(`\`POST ${template(episodeStopPath("WS", "ORG", "WI", "EP"))}\``));
  assert.ok(doc.includes(`\`POST ${template(observationsPath("WS", "ORG"))}\``));
  for (const path of ["/api/v1/auth/device/code", "/api/v1/auth/device/token", "/api/v1/auth/device/refresh"]) assert.ok(doc.includes(`\`POST ${path}\``), path);
});

test("the JSON examples in the contract are accurate", async () => {
  const blocks = jsonBlocks() as Record<string, unknown>[];
  const bySchema = (name: string): Record<string, unknown> => {
    const found = blocks.find((b) => b.schema === name);
    assert.ok(found, name);
    return found;
  };

  assert.equal(schemaValidator("observation.schema.json")(bySchema("helm.executor.observation/v1")), null);

  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const live = statusReport(ctx) as unknown as Record<string, Record<string, unknown> | unknown>;
    const example = bySchema("helm.executor.status/v1");
    assert.deepEqual(Object.keys(example).sort(), Object.keys(live).sort());
    assert.deepEqual(Object.keys(example.episode as object).sort(), Object.keys(live.episode as object).sort());
    assert.deepEqual(Object.keys(example.observe as object).sort(), Object.keys(live.observe as object).sort());
  } finally {
    await w.close();
  }
  assert.deepEqual(Object.keys(bySchema("helm.executor.checkout/v1")).sort(), ["client", "deadline", "episode_id", "reused", "schema", "slot", "work_item_id"]);
});

test("both schemas compile in strict mode", () => {
  schemaValidator("observe-input.schema.json");
  schemaValidator("observation.schema.json");
});
