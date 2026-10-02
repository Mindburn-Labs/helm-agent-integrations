import assert from "node:assert/strict";
import test from "node:test";
import { validateInput } from "../deployed-input.mjs";

const home = "/owner";
const ready = () => ({ schema: "helm.executor.codex.deployed-input/v1", stage: "core-E1-edge-discovery", environment: "qa", controller_run_ref: "controller:qa-smoke", wave1_session: "codex-adapter", cp_origin: "https://cp.test.internal", edge_origin: "https://edge.test.internal", workspace_id: "00000000-0000-0000-0000-000000000001", org_id: "00000000-0000-0000-0000-000000000002", work_item_id: "00000000-0000-0000-0000-000000000003", runtime_home: "/private/qa-home", executor_home: "/private/qa-home/core", slot: "codex-e1-smoke", deployment: { cp_image_digest: "sha256:" + "a".repeat(64), edge_image_digest: "sha256:" + "b".repeat(64), cp_source_sha: "c".repeat(40), edge_source_sha: "d".repeat(40), mcp_server_version: "v0.11.0" } });
test("prepared reference set is input readiness only", () => assert.deepEqual(validateInput(ready(), home), []));
test("unknown input fields are refused", () => assert.notDeepEqual(validateInput({ ...ready(), extra_field: true }, home), []));
test("owner profile paths and sibling state are refused", () => {
  for (const runtime_home of [home, "/owner/.codex", "/owner/.ssh/child", "/owner/.config/helm-executor"]) assert.notDeepEqual(validateInput({ ...ready(), runtime_home, executor_home: runtime_home + "/core" }, home), []);
  assert.notDeepEqual(validateInput({ ...ready(), executor_home: "/private/qa-home-sibling/core" }, home), []);
});
test("userinfo, loopback, path, query and plaintext origins are refused", () => {
  for (const edge_origin of ["https://qa-fixture@edge.test.internal", "http://edge.test.internal", "https://127.0.0.1", "https://edge.test.internal/mcp", "https://edge.test.internal?unapproved=value", "https://executor.qa.example"]) assert.notDeepEqual(validateInput({ ...ready(), edge_origin }, home), []);
});
test("production, other sessions, Linear keys and mutable deployment references are refused", () => {
  for (const patch of [{ environment: "production" }, { wave1_session: "extra-session" }, { work_item_id: "HELM-910" }, { deployment: { ...ready().deployment, cp_image_digest: "latest" } }, { slot: "owner-session" }]) assert.notDeepEqual(validateInput({ ...ready(), ...patch }, home), []);
});
test("missing example prerequisites remain blocked", () => assert.notDeepEqual(validateInput({ ...ready(), cp_origin: null, runtime_home: null, executor_home: null }, home), []));
