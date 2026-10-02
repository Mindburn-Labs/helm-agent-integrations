// Argument parsing and dispatch. Returns the exit code instead of exiting, so tests can run it in process.
// CONTRACT.md sections 1 and 2 are the spec: stdout carries data only, every failure is one stderr line, and
// `observe` exits 0 whatever happens.

import { parseArgs } from "node:util";
import { makeCtx, type Ctx, type Env } from "./ctx.js";
import { asExecutorError, ExecutorError, failureLine } from "./errors.js";
import { VERSION } from "./http.js";
import { checkout, CHECKOUT_CLIENTS } from "./commands/checkout.js";
import { login } from "./commands/login.js";
import { MAX_INPUT_BYTES, observe } from "./commands/observe.js";
import { renderEnv, renderStatus, otelResourceAttributes, statusReport } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { episodeHeaders, episodeToken } from "./commands/token.js";

export interface Io {
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
  /** The whole of stdin as text, or null when it is larger than `maxBytes`. */
  readStdin(maxBytes: number): Promise<string | null>;
}

export const USAGE = `usage: helm-executor <command> [options]

commands:
  login     --cp-url <url> [--org <org-id>] [--name <label>]   authorize this machine (device code)
  checkout  <work-item-id> --client <claude-code|codex|openclaw> [--org <org-id>] [--json]
  token                                                        print a bearer token for the checked-out episode
  headers                                                      print {"Authorization":"Bearer ..."}
  observe   --client <claude-code|codex> --event <event>       report one hook event (stdin); always exits 0
  stop      [--local]                                          end the episode
  status    [--json]                                           show state, no secrets
  env       [--format shell|json]                              print OTEL_RESOURCE_ATTRIBUTES for the episode

environment: HELM_EXECUTOR_HOME, HELM_EXECUTOR_CP_URL, HELM_EXECUTOR_ORG, HELM_EXECUTOR_CLIENT, HELM_EXECUTOR_SLOT
`;

function parse<T extends Record<string, { type: "string" | "boolean" }>>(args: string[], options: T, positionals: number) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== positionals) {
      throw new ExecutorError("usage", positionals === 0 ? "unexpected argument" : `expected ${positionals} argument`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof ExecutorError) throw err;
    throw new ExecutorError("usage", err instanceof Error ? err.message.split("\n")[0] ?? "bad arguments" : "bad arguments");
  }
}

export async function runCli(argv: string[], env: Env, io: Io, overrides: Partial<Pick<Ctx, "now" | "sleep" | "home" | "slot">> = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    await io.stdout(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    await io.stdout(`${VERSION}\n`);
    return 0;
  }
  try {
    return await dispatch(command, rest, env, io, overrides);
  } catch (err) {
    const e = asExecutorError(err);
    const debug = env.HELM_EXECUTOR_DEBUG === "1" && err instanceof Error && err.stack ? `${err.stack}\n` : "";
    await io.stderr(failureLine(e.code, e.message) + (debug ? `${debug}` : ""));
    return command === "observe" ? 0 : e.exitCode;
  }
}

async function dispatch(command: string | undefined, rest: string[], env: Env, io: Io, overrides: Partial<Pick<Ctx, "now" | "sleep" | "home" | "slot">>): Promise<number> {
  switch (command) {
    case "observe": {
      // Nothing on this path may throw to the caller or exit non-zero: it runs inside a client hook.
      try {
        const { values } = parse(rest, { client: { type: "string" }, event: { type: "string" } }, 0);
        const ctx = makeCtx(env, overrides);
        const input = await io.readStdin(MAX_INPUT_BYTES);
        const outcome = await observe(ctx, { client: values.client ?? env.HELM_EXECUTOR_CLIENT, event: values.event, input });
        if (outcome.status === "failed") await io.stderr(outcome.line);
        else if (outcome.status === "skipped" && env.HELM_EXECUTOR_DEBUG === "1") await io.stderr(`helm-executor: observe skipped: ${outcome.reason}\n`);
      } catch (err) {
        const e = asExecutorError(err);
        await io.stderr(failureLine(e.code, e.message));
      }
      return 0;
    }
    case "login": {
      const { values } = parse(rest, { "cp-url": { type: "string" }, org: { type: "string" }, name: { type: "string" } }, 0);
      await login(makeCtx(env, overrides), { cpUrl: values["cp-url"], org: values.org, name: values.name, say: (line) => void io.stderr(`${line}\n`) });
      return 0;
    }
    case "checkout": {
      const { values, positionals } = parse(rest, { client: { type: "string" }, org: { type: "string" }, json: { type: "boolean" } }, 1);
      const client = values.client ?? env.HELM_EXECUTOR_CLIENT;
      if (!client) throw new ExecutorError("usage", `--client is required (${CHECKOUT_CLIENTS.join(", ")}) or set HELM_EXECUTOR_CLIENT`);
      const { slot, reused } = await checkout(makeCtx(env, overrides), { workItem: positionals[0] ?? "", client, org: values.org });
      if (values.json) {
        await io.stdout(
          `${JSON.stringify({
            schema: "helm.executor.checkout/v1",
            episode_id: slot.episode_id,
            work_item_id: slot.work_item_id,
            client: slot.client,
            slot: slot.slot,
            deadline: slot.deadline,
            reused,
          })}\n`,
        );
      } else {
        await io.stdout(`${reused ? "already checked out" : "checked out"} ${slot.work_item_id} as episode ${slot.episode_id} (client ${slot.client}, slot ${slot.slot}); deadline ${slot.deadline}\n`);
      }
      return 0;
    }
    case "token": {
      parse(rest, {}, 0);
      await io.stdout(`${await episodeToken(makeCtx(env, overrides))}\n`);
      return 0;
    }
    case "headers": {
      parse(rest, {}, 0);
      await io.stdout(`${await episodeHeaders(makeCtx(env, overrides))}\n`);
      return 0;
    }
    case "stop": {
      const { values } = parse(rest, { local: { type: "boolean" } }, 0);
      const stopped = await stop(makeCtx(env, overrides), { local: values.local === true });
      await io.stderr(stopped ? "episode stopped\n" : "nothing to stop\n");
      return 0;
    }
    case "status": {
      const { values } = parse(rest, { json: { type: "boolean" } }, 0);
      const report = statusReport(makeCtx(env, overrides));
      await io.stdout(values.json ? `${JSON.stringify(report)}\n` : renderStatus(report));
      return 0;
    }
    case "env": {
      const { values } = parse(rest, { format: { type: "string" } }, 0);
      const format = values.format ?? "plain";
      if (format !== "plain" && format !== "shell" && format !== "json") throw new ExecutorError("usage", "--format must be shell or json");
      await io.stdout(renderEnv(otelResourceAttributes(makeCtx(env, overrides)), format));
      return 0;
    }
    case undefined:
      await io.stderr(USAGE);
      return 2;
    default:
      throw new ExecutorError("usage", `unknown command "${command.slice(0, 40)}"; run helm-executor --help`);
  }
}
