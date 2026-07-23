import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FetchLike } from "./evaluator.js";
import {
  TELEGRAM_BOT_TOKEN_ENV,
  TelegramApiError,
  TelegramTransport,
  telegramOptionsFromEnv,
  type TelegramTransportStatus,
  type TelegramUpdate,
} from "./telegram.js";

interface RecordedCall {
  url: string;
  body?: unknown;
}

function fakeFetch(handler: (method: string, body?: unknown) => unknown) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = input;
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const result = handler(method, body);
    const isError = result instanceof TelegramApiError;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        isError
          ? { ok: false, description: result.message, error_code: result.code }
          : { ok: true, result },
      text: async () => "",
    };
  };
  return { calls, fetchImpl };
}

function dmUpdate(chatId: number, text: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false },
    },
  };
}

test("constructor requires a bot token (env-var only)", () => {
  assert.throws(
    () =>
      new TelegramTransport({
        botToken: "  ",
        allowFrom: [],
        stateFile: "/tmp/x.json",
        onInbound: () => undefined,
      }),
    /HELM_TELEGRAM_BOT_TOKEN/,
  );
});

test("telegramOptionsFromEnv reads the token from the environment only", () => {
  assert.throws(
    () =>
      telegramOptionsFromEnv({}, {
        allowFrom: [],
        stateFile: "/tmp/x.json",
        onInbound: () => undefined,
      }),
    /HELM_TELEGRAM_BOT_TOKEN/,
  );
  const opts = telegramOptionsFromEnv(
    { [TELEGRAM_BOT_TOKEN_ENV]: "test-token-from-env" },
    { allowFrom: ["42"], stateFile: "/tmp/x.json", onInbound: () => undefined },
  );
  assert.equal(opts.botToken, "test-token-from-env");
});

test("allowlisted DM is routed to the bridge as telegram:<chatId>", () => {
  const inbound: Array<{ senderKey: string; chatId: string; text: string }> = [];
  const transport = new TelegramTransport({
    botToken: "t",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: (senderKey, chatId, text) => inbound.push({ senderKey, chatId, text }),
  });

  transport.processUpdate(dmUpdate(42, "list", 7));

  assert.deepEqual(inbound, [{ senderKey: "telegram:42", chatId: "42", text: "list" }]);
});

test("group chats, bots, and non-allowlisted chats are rejected fail-closed", async () => {
  const inbound: unknown[] = [];
  const { calls, fetchImpl } = fakeFetch(() => ({}));
  const transport = new TelegramTransport({
    botToken: "t",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: () => inbound.push(1),
    fetch: fetchImpl,
  });

  // Group chat: silently ignored (any member could drive the bridge).
  transport.processUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text: "list",
      chat: { id: -100, type: "group" },
      from: { id: 42, is_bot: false },
    },
  });
  // Bot-authored message: ignored.
  transport.processUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      text: "list",
      chat: { id: 42, type: "private" },
      from: { id: 999, is_bot: true },
    },
  });
  // Non-allowlisted DM: denied with a pairing hint, never routed inbound.
  transport.processUpdate(dmUpdate(1337, "list", 3));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inbound.length, 0);
  const denial = calls.find((c) => c.url.endsWith("/sendMessage"));
  assert.ok(denial);
  const body = denial.body as { chat_id: string; text: string };
  assert.equal(body.chat_id, "1337");
  assert.ok(body.text.includes("Not authorized"));
  assert.ok(body.text.includes("1337"));
});

test("pollOnce advances and persists the update offset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "helm-channel-bridge-"));
  try {
    const stateFile = path.join(dir, "telegram-offset.json");
    const inbound: string[] = [];
    const { calls, fetchImpl } = fakeFetch((method) =>
      method === "getUpdates" ? [dmUpdate(42, "hello", 101), dmUpdate(42, "status", 102)] : {});
    const transport = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: (_senderKey, _chatId, text) => inbound.push(text),
      fetch: fetchImpl,
    });

    await transport.pollOnce();

    assert.deepEqual(inbound, ["hello", "status"]);
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { offset: number };
    assert.equal(persisted.offset, 103);

    await transport.pollOnce();
    const polls = calls.filter((c) => c.url.endsWith("/getUpdates"));
    assert.equal((polls[1].body as { offset: number }).offset, 103);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pollOnce resumes from a persisted offset after restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "helm-channel-bridge-"));
  try {
    const stateFile = path.join(dir, "telegram-offset.json");
    // Prior run: process update 55, which persists offset 56.
    const seeding = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: () => undefined,
      fetch: fakeFetch((method) => (method === "getUpdates" ? [dmUpdate(42, "hi", 55)] : {})).fetchImpl,
    });
    await seeding.pollOnce();

    // Restarted transport: reloads the persisted offset before polling, so
    // the batch confirmed by the previous run is never redelivered.
    const { calls, fetchImpl } = fakeFetch(() => []);
    const resumed = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: () => undefined,
      fetch: fetchImpl,
    });
    await resumed.restoreOffset();
    await resumed.pollOnce();

    const poll = calls.find((c) => c.url.endsWith("/getUpdates"));
    assert.ok(poll);
    assert.equal((poll.body as { offset: number }).offset, 56);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("401/404 from the Bot API are terminal and surface an error status", async () => {
  const statuses: TelegramTransportStatus[] = [];
  const { fetchImpl } = fakeFetch(() => new TelegramApiError("Unauthorized", 401));
  const transport = new TelegramTransport({
    botToken: "revoked-token",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: () => undefined,
    onStatus: (s) => statuses.push(s),
    fetch: fetchImpl,
    sleep: async () => undefined,
  });

  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const error = statuses.find((s) => s.state === "error");
  assert.ok(error);
  if (error.state === "error") {
    assert.ok(error.error.includes("Bot token rejected"));
  }
});

test("send posts to the Bot API without leaking the token into message bodies", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({}));
  const transport = new TelegramTransport({
    botToken: "secret-token",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: () => undefined,
    fetch: fetchImpl,
  });

  await transport.send("42", "⛔ HELM denied");

  const send = calls.find((c) => c.url.endsWith("/sendMessage"));
  assert.ok(send);
  const body = send.body as { chat_id: string; text: string };
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, "⛔ HELM denied");
  assert.ok(!body.text.includes("secret-token"));
});
