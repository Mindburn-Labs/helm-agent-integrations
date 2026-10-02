// What every command needs: the environment, where state lives, which slot, and a clock.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ExecutorError } from "./errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Ctx {
  env: Env;
  /** State directory. Holds credentials.json and slots/. */
  home: string;
  slot: string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SLOT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function resolveHome(env: Env): string {
  const set = env.HELM_EXECUTOR_HOME?.trim();
  if (set) {
    if (!isAbsolute(set)) throw new ExecutorError("usage", "HELM_EXECUTOR_HOME must be an absolute path");
    return set;
  }
  return join(homedir(), ".config", "helm-executor");
}

export function resolveSlot(env: Env): string {
  const slot = env.HELM_EXECUTOR_SLOT?.trim() || "default";
  if (!SLOT_PATTERN.test(slot)) {
    throw new ExecutorError("usage", "HELM_EXECUTOR_SLOT must match ^[a-z0-9][a-z0-9_-]{0,31}$");
  }
  return slot;
}

export function makeCtx(env: Env, overrides: Partial<Pick<Ctx, "now" | "sleep" | "home" | "slot">> = {}): Ctx {
  return {
    env,
    home: overrides.home ?? resolveHome(env),
    slot: overrides.slot ?? resolveSlot(env),
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}
