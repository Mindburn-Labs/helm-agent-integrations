/**
 * The public OpenCode v1 plugin contract, sourced from the pinned
 * `@opencode-ai/plugin` development dependency rather than a handwritten
 * structural copy. This makes API drift a typecheck failure.
 */
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";

export type OpencodeHooks = Hooks;
export type OpencodePermission = Parameters<NonNullable<Hooks["permission.ask"]>>[0];
export type OpencodePlugin = Plugin;
export type OpencodePluginInput = PluginInput;
export type OpencodePluginModule = PluginModule;
