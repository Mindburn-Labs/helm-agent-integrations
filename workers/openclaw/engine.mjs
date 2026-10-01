// Private stdin carries the episode token. Vendor logs never enter A2A stdout.
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {boundedEmitter, gatewayFetch, validateConfiguration} from "./boundary.mjs";

const emit = boundedEmitter((line) => process.stdout.write(line));
for (const method of ["log", "info", "debug", "warn", "error"]) console[method] = () => {};
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
let client;
let timer;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) throw new Error("Unbounded episode configuration");
  }
  const config = validateConfiguration(JSON.parse(input));
  timer = setTimeout(() => controller.abort(), Math.min(config.deadline_ms - Date.now(), 3600000));
  const fetch = gatewayFetch(config, globalThis.fetch.bind(globalThis), controller.signal);
  // Global requests are fenced too. The native provider receives this fetch
  // through its public embedding port; the ambient hook alone is insufficient.
  globalThis.fetch = fetch;
  const {runEpisode} = await import("./adapter.mjs");
  client = new Client({name: "helm-openclaw-worker", version: "0.1.0"});
  await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp_url), {
    fetch, requestInit: {headers: {Authorization: `Bearer ${config.token}`}},
  }), {signal: controller.signal, timeout: 60000});
  await runEpisode(config, {client, emit, signal: controller.signal, fetch});
} catch {
  emit({type: "error"});
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  if (client) await client.close().catch(() => {});
}
