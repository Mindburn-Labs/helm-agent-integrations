import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ExecutorError } from "./errors.js";
import { errorDetail, httpJson, normalizeBaseUrl } from "./http.js";
import { fakeSecrets } from "./test-utils.js";

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("normalizeBaseUrl accepts https and loopback http, and strips path slashes, query and fragment", () => {
  assert.equal(normalizeBaseUrl("https://cp.example.com/"), "https://cp.example.com");
  assert.equal(normalizeBaseUrl("https://cp.example.com/prefix/?a=1#x"), "https://cp.example.com/prefix");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeBaseUrl("http://localhost:9"), "http://localhost:9");
  assert.equal(normalizeBaseUrl("http://[::1]:9"), "http://[::1]:9");
});

test("normalizeBaseUrl rejects cleartext remote hosts, embedded credentials and junk", () => {
  for (const bad of ["http://cp.example.com", "ftp://cp.example.com", "https://user:pw@cp.example.com", "not a url", ""]) {
    assert.throws(() => normalizeBaseUrl(bad), (e: unknown) => e instanceof ExecutorError && e.code === "usage", bad);
  }
});

test("httpJson never follows a redirect and never sends the bearer token to its target", async () => {
  let targetHits = 0;
  const target = await serve((_req, res) => {
    targetHits++;
    res.end("{}");
  });
  const origin = await serve((_req, res) => {
    res.writeHead(302, { Location: `${target.url}/steal` });
    res.end();
  });
  try {
    await assert.rejects(
      httpJson({ method: "POST", url: `${origin.url}/x`, bearer: fakeSecrets.helmAccess, body: {}, timeoutMs: 2_000 }),
      (e: unknown) => e instanceof ExecutorError && e.code === "rejected",
    );
    assert.equal(targetHits, 0);
  } finally {
    await origin.close();
    await target.close();
  }
});

test("httpJson maps a timeout and a refused connection to unavailable", async () => {
  const slow = await serve(() => undefined);
  try {
    await assert.rejects(httpJson({ method: "GET", url: `${slow.url}/x`, timeoutMs: 100 }), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable" && /timed out/.test(e.message));
  } finally {
    await slow.close();
  }
  await assert.rejects(httpJson({ method: "GET", url: `${slow.url}/x`, timeoutMs: 500 }), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
});

test("httpJson refuses a response over 1 MiB", async () => {
  const big = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pad: "x".repeat(1_100_000) }));
  });
  try {
    await assert.rejects(httpJson({ method: "GET", url: `${big.url}/x`, timeoutMs: 3_000 }), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
  } finally {
    await big.close();
  }
});

test("httpJson returns null json for a body that is not JSON, and reads Retry-After", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(503, { "Retry-After": "7" });
    res.end("<html>nope</html>");
  });
  try {
    const r = await httpJson({ method: "GET", url: `${s.url}/x`, timeoutMs: 1_000 });
    assert.equal(r.status, 503);
    assert.equal(r.json, null);
    assert.equal(r.retryAfterMs, 7_000);
  } finally {
    await s.close();
  }
});

test("errorDetail reads both control plane error shapes and redacts credentials", () => {
  assert.equal(errorDetail({ status: 400, json: { error: "invalid_grant", error_description: "bad refresh" }, retryAfterMs: null }), "invalid_grant: bad refresh");
  assert.equal(errorDetail({ status: 404, json: { error: "episode_not_found", message: "unknown episode", code: 404 }, retryAfterMs: null }), "episode_not_found: unknown episode");
  assert.equal(errorDetail({ status: 500, json: null, retryAfterMs: null }), "HTTP 500");
  assert.ok(!errorDetail({ status: 400, json: { error: `token ${fakeSecrets.helmRefresh} rejected` }, retryAfterMs: null }).includes(fakeSecrets.helmRefresh));
});
