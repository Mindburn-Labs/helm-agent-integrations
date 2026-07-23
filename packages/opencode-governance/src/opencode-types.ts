/**
 * Local structural mirror of the opencode plugin contract
 * (`@opencode-ai/plugin`, `packages/plugin/src/index.ts` in the opencode repo).
 *
 * Provenance: opencode clone @ 62e46412 (2026-07-23), studied in
 * research/opencode-study/17-pkg-plugin-codemode.md and
 * research/opencode-study/26-helm-map-kernel-governance.md.
 *
 * These types are intentionally re-declared (structural typing) so this
 * package compiles and tests without pulling the opencode plugin package and
 * its dependency tree. Field shapes below cover exactly the hooks this plugin
 * implements; if opencode changes the contract, update this mirror.
 */

/** Mirrors `Permission` from `@opencode-ai/sdk` (sdk/js/src/gen/types.gen.ts). */
export interface OpencodePermission {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export interface OpencodeProject {
  id: string;
  [key: string]: unknown;
}

/** Mirrors `PluginInput`. Only the fields this plugin reads are required. */
export interface OpencodePluginInput {
  client: unknown;
  project: OpencodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
  [key: string]: unknown;
}

/** Mirrors the `Hooks` entries this plugin implements. */
export interface OpencodeHooks {
  /**
   * Declared at packages/plugin/src/index.ts:261 in the studied clone.
   * NOTE: at that commit no trigger call site was found in the opencode
   * sources (the hook is part of the documented contract but the V2 Effect
   * permission service does not invoke it). This plugin implements it for
   * forward compatibility; enforcement that is live *today* happens in
   * `tool.execute.before`. See README "Known gaps".
   */
  "permission.ask"?: (
    input: OpencodePermission,
    output: { status: "ask" | "deny" | "allow" },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
}

/** Mirrors `Plugin`. */
export type OpencodePlugin = (
  input: OpencodePluginInput,
  options?: Record<string, unknown>,
) => Promise<OpencodeHooks>;

/** Mirrors `PluginModule` (the `server` variant). */
export interface OpencodePluginModule {
  id?: string;
  server: OpencodePlugin;
  tui?: never;
}
