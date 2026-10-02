// Input readiness is never runtime evidence. This module holds no credential.
import { isAbsolute, relative, resolve, sep } from "node:path";

const keys = ["schema", "stage", "environment", "controller_run_ref", "wave1_session", "cp_origin", "edge_origin", "workspace_id", "org_id", "work_item_id", "runtime_home", "executor_home", "slot", "deployment"];
const deploymentKeys = ["cp_image_digest", "edge_image_digest", "cp_source_sha", "edge_source_sha", "mcp_server_version"];
const object = value => value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const within = (child, parent) => { const r = relative(parent, child); return r !== "" && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r); };
const fieldsMatch = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));

export function validateInput(input, ownerHome) {
  const missing = [];
  const require = (ok, field) => { if (!ok) missing.push(field); };
  if (!fieldsMatch(input, keys)) return ["exact noncredential input fields"];
  require(input.schema === "helm.executor.codex.deployed-input/v1", "schema");
  require(input.stage === "core-E1-edge-discovery", "stage");
  require(input.environment === "qa", "environment=qa");
  require(typeof input.controller_run_ref === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:# -]{0,255}$/.test(input.controller_run_ref), "controller_run_ref");
  require(input.wave1_session === "codex-adapter", "named Wave1 codex-adapter session");
  for (const key of ["cp_origin", "edge_origin"]) {
    let ok = false;
    try {
      const u = new URL(input[key]);
      ok = typeof input[key] === "string" && u.origin === input[key] && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash &&
        u.hostname.includes(".") && !/^(?:localhost|127\.|0\.|\[|.*\.localhost$)/i.test(u.hostname) && !u.hostname.endsWith(".example") && !u.hostname.endsWith(".invalid");
    } catch {}
    require(ok, key + " (actual HTTPS origin without userinfo, path or query)");
  }
  for (const key of ["workspace_id", "org_id", "work_item_id"]) require(typeof input[key] === "string" && uuid.test(input[key]) && input[key] !== "00000000-0000-0000-0000-000000000000", key + " (retained lowercase UUID)");
  const path = key => typeof input[key] === "string" && isAbsolute(input[key]) && resolve(input[key]) === input[key];
  require(path("runtime_home") && input.runtime_home !== resolve(ownerHome) && ![".codex", ".ssh", ".config/helm-executor"].some(p => input.runtime_home === resolve(ownerHome, p) || within(input.runtime_home, resolve(ownerHome, p))), "separate private runtime_home");
  require(path("executor_home") && path("runtime_home") && within(input.executor_home, input.runtime_home), "executor_home inside separate runtime_home");
  require(typeof input.slot === "string" && /^codex-e1-[a-z0-9_-]{1,23}$/.test(input.slot), "fresh named codex-e1 slot (at most32 characters)");
  if (!fieldsMatch(input.deployment, deploymentKeys)) missing.push("exact deployment reference fields");
  else {
    for (const key of ["cp_image_digest", "edge_image_digest"]) require(typeof input.deployment[key] === "string" && /^sha256:[0-9a-f]{64}$/.test(input.deployment[key]), key);
    for (const key of ["cp_source_sha", "edge_source_sha"]) require(typeof input.deployment[key] === "string" && /^[0-9a-f]{40}$/.test(input.deployment[key]), key);
    require(typeof input.deployment.mcp_server_version === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(input.deployment.mcp_server_version) && input.deployment.mcp_server_version !== "development", "mcp_server_version");
  }
  return missing;
}
