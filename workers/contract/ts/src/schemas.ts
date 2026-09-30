// Loader and validators for the JSON Schemas shipped with this package.
//
// workers/contract/schema/ is canonical; `make workers-contract-check` fails when the copy in
// this package drifts from it.

import { readFileSync } from "node:fs";
import AjvModule from "ajv/dist/2020.js";

// Under NodeNext the default import of this CommonJS module is typed as its namespace; at
// runtime module.exports is the class and carries itself as `.default`.
const Ajv2020 = AjvModule.default;

export type SchemaName = "episode.v1" | "status.v1" | "proposal.v1" | "report.v1";

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const cache = new Map<string, unknown>();

export function loadSchema(name: string): Record<string, unknown> {
  const url = new URL(`../schema/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function validatorFor(name: SchemaName) {
  let compiled = cache.get(name) as ReturnType<typeof ajv.compile> | undefined;
  if (!compiled) {
    compiled = ajv.compile(loadSchema(name));
    cache.set(name, compiled);
  }
  return compiled;
}

/** Sorted, human-readable violations of the named schema (empty when valid). */
export function schemaIssues(name: SchemaName, value: unknown): string[] {
  const validate = validatorFor(name);
  if (validate(value)) return [];
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath.replace(/^\//, "") || "(root)"}: ${error.message ?? "invalid"}`)
    .sort();
}
