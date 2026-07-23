import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GovernanceConfigError, resolveConfig } from "./config.js";

const HOME = "/home/test";

function envOf(entries: Record<string, string>): Record<string, string | undefined> {
  return { ...entries };
}

const BASE_ENV = envOf({
  HELM_KERNEL_URL: "http://127.0.0.1:7714",
  HELM_API_KEY: "test-key",
  HELM_TENANT_ID: "tenant-1",
  HELM_PRINCIPAL: "agent-1",
});

describe("resolveConfig", () => {
  it("resolves a complete http configuration with defaults", () => {
    const config = resolveConfig({ env: BASE_ENV, homeDir: HOME });
    assert.equal(config.mode, "http");
    assert.equal(config.kernelUrl, "http://127.0.0.1:7714");
    assert.equal(config.apiKey, "test-key");
    assert.equal(config.tenantId, "tenant-1");
    assert.equal(config.principal, "agent-1");
    assert.equal(config.riskClass, "T2");
    assert.equal(config.effectClass, "E4");
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.strictEvidence, true);
    assert.equal(config.evidenceDir, `${HOME}/.helm-ai-kernel/evidence/opencode`);
  });

  it("fails closed when no kernel target is configured", () => {
    assert.throws(
      () =>
        resolveConfig({
          env: envOf({ HELM_API_KEY: "k", HELM_TENANT_ID: "t", HELM_PRINCIPAL: "p" }),
          homeDir: HOME,
        }),
      GovernanceConfigError,
    );
  });

  it("fails closed when both kernel targets are set without an explicit mode", () => {
    assert.throws(
      () =>
        resolveConfig({
          env: envOf({ ...BASE_ENV, HELM_KERNEL_BINARY: "/bin/echo" }),
          homeDir: HOME,
        }),
      /both HELM_KERNEL_URL and HELM_KERNEL_BINARY/,
    );
  });

  it("fails closed when http mode lacks an api key", () => {
    const env = { ...BASE_ENV };
    delete env.HELM_API_KEY;
    assert.throws(() => resolveConfig({ env, homeDir: HOME }), /HELM_API_KEY/);
  });

  it("fails closed on missing tenant or principal", () => {
    const noTenant = { ...BASE_ENV };
    delete noTenant.HELM_TENANT_ID;
    assert.throws(() => resolveConfig({ env: noTenant, homeDir: HOME }), /HELM_TENANT_ID/);
    const noPrincipal = { ...BASE_ENV };
    delete noPrincipal.HELM_PRINCIPAL;
    assert.throws(() => resolveConfig({ env: noPrincipal, homeDir: HOME }), /HELM_PRINCIPAL/);
  });

  it("fails closed on unsupported classification values", () => {
    assert.throws(
      () => resolveConfig({ env: envOf({ ...BASE_ENV, HELM_RISK_CLASS: "T9" }), homeDir: HOME }),
      /unsupported riskClass/,
    );
    assert.throws(
      () => resolveConfig({ env: envOf({ ...BASE_ENV, HELM_EFFECT_CLASS: "E7" }), homeDir: HOME }),
      /unsupported effectClass/,
    );
  });

  it("fails closed on invalid timeout", () => {
    assert.throws(
      () => resolveConfig({ env: envOf({ ...BASE_ENV, HELM_TIMEOUT_MS: "-5" }), homeDir: HOME }),
      /HELM_TIMEOUT_MS/,
    );
    assert.throws(
      () => resolveConfig({ env: envOf({ ...BASE_ENV, HELM_TIMEOUT_MS: "abc" }), homeDir: HOME }),
      /HELM_TIMEOUT_MS/,
    );
  });

  it("resolves binary mode and binary args", () => {
    const config = resolveConfig({
      env: envOf({
        HELM_KERNEL_BINARY: "/usr/local/bin/helm-ai-kernel",
        HELM_KERNEL_BINARY_ARGS: "hook decide --format json",
        HELM_TENANT_ID: "tenant-1",
        HELM_PRINCIPAL: "agent-1",
      }),
      homeDir: HOME,
    });
    assert.equal(config.mode, "binary");
    assert.equal(config.kernelBinary, "/usr/local/bin/helm-ai-kernel");
    assert.deepEqual(config.kernelBinaryArgs, ["hook", "decide", "--format", "json"]);
  });

  it("plugin options override env vars", () => {
    const config = resolveConfig({
      env: BASE_ENV,
      options: { tenantId: "tenant-from-options", timeoutMs: "1234" },
      homeDir: HOME,
    });
    assert.equal(config.tenantId, "tenant-from-options");
    assert.equal(config.timeoutMs, 1234);
  });

  it("explicit mode wins over inference", () => {
    const config = resolveConfig({
      env: envOf({
        ...BASE_ENV,
        HELM_KERNEL_BINARY: "/bin/echo",
        HELM_KERNEL_MODE: "binary",
      }),
      homeDir: HOME,
    });
    assert.equal(config.mode, "binary");
  });

  it("strict evidence parses boolean-ish values and rejects garbage", () => {
    const relaxed = resolveConfig({
      env: envOf({ ...BASE_ENV, HELM_EVIDENCE_STRICT: "0" }),
      homeDir: HOME,
    });
    assert.equal(relaxed.strictEvidence, false);
    assert.throws(
      () => resolveConfig({ env: envOf({ ...BASE_ENV, HELM_EVIDENCE_STRICT: "maybe" }), homeDir: HOME }),
      /HELM_EVIDENCE_STRICT/,
    );
  });
});
