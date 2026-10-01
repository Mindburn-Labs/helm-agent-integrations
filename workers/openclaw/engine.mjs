// Private stdin carries the episode token. Vendor logs never enter A2A stdout.
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {gatewayFetch, validateConfiguration} from "./boundary.mjs";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
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
  const fetch = gatewayFetch(config, globalThis.fetch.bind(globalThis));
  // Install the same gate before importing OpenClaw's provider runtime, so its
  // native fetch cannot choose a provider/telemetry endpoint or follow redirects.
  globalThis.fetch = fetch;
  const {runEpisode} = await import("./adapter.mjs");
  client = new Client({name: "helm-openclaw-worker", version: "0.1.0"});
  await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp_url), {
    fetch, requestInit: {headers: {Authorization: `Bearer ${config.token}`}},
  }), {signal: controller.signal, timeout: 60000});
  await runEpisode(config, {client, emit, signal: controller.signal});
} catch {
  emit({type: "error"});
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  if (client) await client.close().catch(() => {});
}
