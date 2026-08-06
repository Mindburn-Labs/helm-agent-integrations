/**
 * @helm-ai/opencode-governance — fail-closed HELM governance plugin for
 * opencode. Private/unpublished; see README.md for the threat model and the
 * list of things this plugin deliberately does NOT do.
 */

export * from "./verdict.js";
export * from "./config.js";
export * from "./kernel.js";
export * from "./evidence.js";
export * from "./plugin.js";
export type {
  OpencodeHooks,
  OpencodePermission,
  OpencodePlugin,
  OpencodePluginInput,
  OpencodePluginModule,
} from "./opencode-types.js";

import { HelmGovernancePlugin, PLUGIN_ID, PLUGIN_VERSION } from "./plugin.js";
import type { OpencodePluginModule } from "./opencode-types.js";

/**
 * opencode PluginModule default export: the loader prefers a default-exported
 * object exposing `server()` (packages/opencode/src/plugin/shared.ts
 * readV1Plugin). The named export above remains for direct import/testing.
 */
const module_: OpencodePluginModule & { version: string } = {
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  server: HelmGovernancePlugin,
};

export default module_;
