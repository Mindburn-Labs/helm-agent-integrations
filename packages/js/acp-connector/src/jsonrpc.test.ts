import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { NdJsonRpcPeer } from "./jsonrpc.js";

test("tool arguments survive UTF-8 chunks split inside a character", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new NdJsonRpcPeer({ input, output });
  const received = new Promise<unknown>(resolve => peer.once("request", (_method, params) => resolve(params)));
  const value = { url: "https://example.test/път", text: "日本語" };
  const line = Buffer.from(JSON.stringify({ id: 1, method: "session/request_permission", params: value }) + "\n");
  const split = line.indexOf(Buffer.from("п")) + 1;
  input.write(line.subarray(0, split));
  input.write(line.subarray(split));
  assert.deepEqual(await received, value);
  peer.close();
});

test("oversized unterminated input fails closed and rejects outstanding work", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new NdJsonRpcPeer({ input, output });
  const pending = peer.request("initialize", {});
  input.write("x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(pending, /connection closed/);
  assert.equal(peer.isClosed, true);
});

test("closed adapter input rejects pending requests and late permission replies stay inert", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new NdJsonRpcPeer({ input, output });
  let reply!: (result: unknown) => void;
  peer.once("request", (_method, _params, respond) => { reply = respond; });
  input.write(JSON.stringify({ id: 7, method: "session/request_permission", params: {} }) + "\n");
  const pending = peer.request("session/prompt", {});
  output.destroy(new Error("write EPIPE"));
  await assert.rejects(pending, /connection closed/);
  assert.doesNotThrow(() => reply({ outcome: { outcome: "cancelled" } }));
});
