import {configureAiTransportHost} from "@openclaw/ai";
import {getApiProvider} from "openclaw/plugin-sdk/llm";

// Install the public embedding port after SDK imports. The OpenClaw convenience
// stream lazily installs its own host and can choose imported Undici instead of
// global fetch. Select the actual registered Responses provider directly, keeping
// its protocol/parser and disabling plugin/runtime routing through inert defaults.
export function createGatewayStream(config, fetch) {
  const provider = getApiProvider("openai-responses");
  if (typeof provider?.streamSimple !== "function") throw new Error("Native Responses provider unavailable");
  const assertModel = (model) => {
    if (model.api !== "openai-responses" || model.provider !== "helm"
        || model.id !== config.model || model.baseUrl !== config.base_url + "/v1") {
      throw new Error("Native model escaped the retained route");
    }
  };
  configureAiTransportHost({
    buildModelFetch: (model) => { assertModel(model); return fetch; },
    requiresManagedTransport: () => true,
  });
  return (model, context, options) => {
    assertModel(model);
    return provider.streamSimple(model, context, options);
  };
}
