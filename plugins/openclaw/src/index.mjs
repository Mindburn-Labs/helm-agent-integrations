import {definePluginEntry} from "openclaw/plugin-sdk/plugin-entry";
import {CONFIG_SCHEMA, PLUGIN_ID, PROVIDER_ID, RUNTIME_MARKER} from "./config.mjs";
import {createRuntime} from "./runtime.mjs";

export default definePluginEntry({
  id: PLUGIN_ID, name: "HELM", description: "HELM-compatible gateway tools and retained executor model route",
  configSchema: {jsonSchema: CONFIG_SCHEMA},
  register(api) {
    const runtime = createRuntime(api.pluginConfig);
    api.registerService({id: PLUGIN_ID, start: () => runtime.initialize(), stop: () => runtime.close()});
    api.lifecycle.registerRuntimeLifecycle({id: PLUGIN_ID, dispose: () => runtime.close()});
    api.registerTool({contextVersion: 2, create: runtime.factory});
    api.on("before_model_resolve", runtime.select);
    api.on("before_prompt_build", runtime.prompt);
    api.on("before_tool_call", runtime.beforeTool);
    api.on("after_tool_call", runtime.afterTool);
    api.registerProvider({
      id: PROVIDER_ID, label: "HELM executor", auth: [],
      resolveDynamicModel(context) {
        const model = runtime.model();
        if (context.provider !== PROVIDER_ID || context.modelId !== model.id) throw new Error("Unbound HELM model selection");
        return model;
      },
      createStreamFn: runtime.createStream,
      wrapSimpleCompletionStreamFn: runtime.createStream,
      resolveSyntheticAuth: () => ({apiKey: RUNTIME_MARKER, source: "helm-executor",
        mode: "api-key", nativeAuth: {runtime: "helm-executor", mode: "token"}}),
    });
  },
});
