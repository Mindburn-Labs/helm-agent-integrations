// Helpers shared by the tests. Not part of the package surface.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { makeCtx, type Ctx } from "./ctx.js";
import { login } from "./commands/login.js";
import { checkout } from "./commands/checkout.js";
import type { Io } from "./main.js";
import { startFakeCp, type FakeCp, type FakeCpOptions } from "./testing/fake-cp.js";

export const START = Date.parse("2026-10-08T12:00:00.000Z");

/** A clock the test moves by hand. `sleep` advances it and returns at once. */
export function manualClock(start = START): { now(): number; advance(ms: number): void; sleep(ms: number): Promise<void> } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms) => {
      t += ms;
    },
  };
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "helm-executor-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function captureIo(stdin: string | null = ""): { io: Io; out(): string; err(): string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
      readStdin: async () => stdin,
    },
    out: () => out,
    err: () => err,
  };
}

export interface World {
  fake: FakeCp;
  clock: ReturnType<typeof manualClock>;
  home: string;
  ctx(overrides?: { slot?: string; env?: Record<string, string | undefined> }): Ctx;
  env(extra?: Record<string, string | undefined>): Record<string, string | undefined>;
  close(): Promise<void>;
}

/** A fake control plane on a manual clock plus an empty state directory. */
export async function world(options: FakeCpOptions = {}): Promise<World> {
  const clock = manualClock();
  const fake = await startFakeCp({ now: clock.now, ...options });
  const tmp = tempDir();
  const home = join(tmp.dir, "state");
  const baseEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    HELM_EXECUTOR_HOME: home,
    HELM_EXECUTOR_CP_URL: fake.url,
    HELM_EXECUTOR_ORG: fake.orgId,
    ...extra,
  });
  return {
    fake,
    clock,
    home,
    env: baseEnv,
    ctx: (o = {}) => makeCtx(baseEnv(o.env), { now: clock.now, sleep: clock.sleep, home, slot: o.slot ?? "default" }),
    close: async () => {
      await fake.close();
      tmp.cleanup();
    },
  };
}

export async function loggedIn(w: World): Promise<Ctx> {
  const ctx = w.ctx();
  await login(ctx, { say: () => undefined });
  return ctx;
}

export async function checkedOut(w: World, workItem = "HELM-910", client = "claude-code"): Promise<Ctx> {
  const ctx = await loggedIn(w);
  await checkout(ctx, { workItem, client });
  return ctx;
}

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => unknown;

export function schemaValidator(file: string): (value: unknown) => string | null {
  const schema = JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), "utf8")) as object;
  // strictRequired off: `required` in an if/then or anyOf branch names properties declared on the parent schema.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return (value) => (validate(value) ? null : ajv.errorsText(validate.errors));
}

/** Strings that look like credentials, assembled at run time so no scanner mistakes the test source for a leak. */
export const fakeSecrets = {
  helmAccess: ["helm", "_at_", "A".repeat(43)].join(""),
  helmRefresh: ["helm", "_rt_", "B".repeat(43)].join(""),
  openai: ["sk", "-", "proj", "-", "c".repeat(30)].join(""),
  github: ["gh", "p_", "D".repeat(36)].join(""),
  githubPat: ["github", "_pat_", "E".repeat(40)].join(""),
  aws: ["AK", "IA", "F".repeat(16)].join(""),
  slack: ["xo", "xb-", "1234567890-", "g".repeat(20)].join(""),
  jwt: [["eyJ", "h".repeat(20)].join(""), ["eyJ", "p".repeat(20)].join(""), "s".repeat(24)].join("."),
  bearer: ["Bear", "er ", "q".repeat(30)].join(""),
  stripe: ["sk", "_live_", "H".repeat(24)].join(""),
  npm: ["np", "m_", "I".repeat(36)].join(""),
  huggingface: ["h", "f_", "J".repeat(34)].join(""),
  gitlab: ["glp", "at-", "K".repeat(20)].join(""),
  linear: ["lin", "_api_", "L".repeat(40)].join(""),
  google: ["AI", "za", "M".repeat(35)].join(""),
  vault: ["hv", "s.", "N".repeat(24)].join(""),
};
