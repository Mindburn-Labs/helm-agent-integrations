import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_EXTENSION_URI, PAUSE, RESUME, STEER, controlCapabilities, renderAgentCard,
} from "./index.js";

test("actual adapter cards declare unavailable controls with concrete reasons", () => {
  for (const framework of ["claude-agent-sdk", "openai-agents", "langgraph", "openclaw"]) {
    const card = renderAgentCard({
      framework, url: "http://worker:8080/", version: "0.1.0", modelApis: ["openai-responses"],
    });
    const extensions = (card.capabilities as {
      extensions: {
        uri: string; required: boolean; params: ReturnType<typeof controlCapabilities>;
      }[];
    }).extensions;
    const control = extensions.find((item) => item.uri === CONTROL_EXTENSION_URI)!;
    assert.equal(control.required, false);
    assert.deepEqual(Object.keys(control.params.verbs), [STEER, PAUSE, RESUME]);
    for (const declaration of Object.values(control.params.verbs)) {
      assert.equal(declaration.supported, false);
      assert.ok(declaration.reason.length > 30);
    }
    assert.ok(!JSON.stringify(card).includes("{{"));
  }
});

test("unknown framework names cannot inherit a capability or mutate another card", () => {
  const first = controlCapabilities("__proto__");
  first.verbs[PAUSE]!.reason = "changed";
  const second = controlCapabilities("__proto__");
  for (const declaration of Object.values(second.verbs)) {
    assert.equal(declaration.supported, false);
    assert.match(declaration.reason, /No retained-task control handler/);
  }
});
