// Run the fake control plane as a process: `node dist/testing/serve.js [--port N]`.
// Prints one JSON line on stdout, {"cp_url","org_id","workspace_id"}, then serves until SIGTERM or SIGINT.
// The first device-code poll is pending and the second is approved.

import { parseArgs } from "node:util";
import { startFakeCp } from "./fake-cp.js";

const { values } = parseArgs({ options: { port: { type: "string" } } });
const fake = await startFakeCp({ port: values.port ? Number(values.port) : 0 });
process.stdout.write(`${JSON.stringify({ cp_url: fake.url, org_id: fake.orgId, workspace_id: fake.workspaceId })}\n`);

const shutdown = (): void => {
  void fake.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
