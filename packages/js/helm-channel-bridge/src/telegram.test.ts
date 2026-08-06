import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("allowlisted DM is routed to the bridge as telegram:<chatId>", async () => {
  const inbound: Array<{ senderKey: string; chatId: string; text: string }> = [];
  const transport = new TelegramTransport({
    botToken: "t",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: (senderKey, chatId, text) => {
      inbound.push({ senderKey, chatId, text });
    },
  });

  await transport.processUpdate(dmUpdate(42, "list", 7));

  assert.deepEqual(inbound, [{ senderKey: "telegram:42", chatId: "42", text: "list" }]);
});

test("group chats, bots, and non-allowlisted chats are rejected fail-closed", async () => {
  const inbound: unknown[] = [];
  const { calls, fetchImpl } = fakeFetch(() => ({}));
  const transport = new TelegramTransport({
    botToken: "t",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: () => {
      inbound.push(1);
    },
    fetch: fetchImpl,
  });

  // Group chat: silently ignored (any member could drive the bridge).
  await transport.processUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text: "list",
      chat: { id: -100, type: "group" },
      from: { id: 42, is_bot: false },
    },
  });
  // Bot-authored message: ignored.
  await transport.processUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      text: "list",
      chat: { id: 42, type: "private" },
      from: { id: 999, is_bot: true },
    },
  });
  // Non-allowlisted DM: silently dropped — no pairing hint (spam/discovery
  // vector), never routed inbound.
  await transport.processUpdate(dmUpdate(1337, "list", 3));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inbound.length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/sendMessage")).length, 0);
});

test("an allowlisted chat is still dropped when the sender user ID is not allowlisted", async () => {
  const inbound: unknown[] = [];
  const { calls, fetchImpl } = fakeFetch(() => ({}));
  const transport = new TelegramTransport({
    botToken: "t",
    allowFrom: ["42"],
    stateFile: "/tmp/x.json",
    onInbound: () => {
      inbound.push(1);
    },
    fetch: fetchImpl,
  });

  // chat.id is allowlisted but from.id is not: drop silently.
  await transport.processUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text: "list",
      chat: { id: 42, type: "private" },
      from: { id: 1337, is_bot: false },
    },
  });
  // Missing sender identity: drop.
  await transport.processUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      text: "list",
      chat: { id: 42, type: "private" },
    },
  });

  assert.equal(inbound.length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/sendMessage")).length, 0);
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
      onInbound: (_senderKey, _chatId, text) => {
        inbound.push(text);
      },
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

test("offset is persisted only after inbound handling completes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "helm-channel-bridge-"));
  try {
    const stateFile = path.join(dir, "telegram-offset.json");
    let release: () => void = () => undefined;
    const handled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = fakeFetch((method) =>
      method === "getUpdates" ? [dmUpdate(42, "hello", 101)] : {});
    const transport = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: () => handled,
      fetch: fetchImpl,
    });

    const poll = transport.pollOnce();
    // Let the getUpdates round reach the (still pending) handler.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Handling has not completed: nothing may be persisted yet.
    await assert.rejects(readFile(stateFile, "utf8"), /ENOENT/);

    release();
    await poll;
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { offset: number };
    assert.equal(persisted.offset, 102);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handler failure keeps the update unconfirmed (no offset advance, nothing persisted)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "helm-channel-bridge-"));
  try {
    const stateFile = path.join(dir, "telegram-offset.json");
    const { calls, fetchImpl } = fakeFetch((method) =>
      method === "getUpdates" ? [dmUpdate(42, "boom", 201)] : {});
    const transport = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: () => Promise.reject(new Error("bridge exploded")),
      fetch: fetchImpl,
    });

    await assert.rejects(transport.pollOnce(), /bridge exploded/);
    await assert.rejects(readFile(stateFile, "utf8"), /ENOENT/);

    // The next poll must re-fetch from the un-advanced offset.
    await assert.rejects(transport.pollOnce(), /bridge exploded/);
    const polls = calls.filter((c) => c.url.endsWith("/getUpdates"));
    assert.equal(polls.length, 2);
    assert.equal((polls[0].body as { offset: number }).offset, 0);
    assert.equal((polls[1].body as { offset: number }).offset, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offset persistence failure fails closed: offset not advanced, error surfaced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "helm-channel-bridge-"));
  try {
    // A directory as the state file makes writeFile fail (EISDIR).
    const stateFile = path.join(dir, "offset-as-dir");
    await mkdir(stateFile);
    const handled: string[] = [];
    const { calls, fetchImpl } = fakeFetch((method) =>
      method === "getUpdates" ? [dmUpdate(42, "hello", 301)] : {});
    const transport = new TelegramTransport({
      botToken: "t",
      allowFrom: ["42"],
      stateFile,
      onInbound: (_senderKey, _chatId, text) => {
        handled.push(text);
      },
      fetch: fetchImpl,
    });

    await assert.rejects(
      transport.pollOnce(),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.ok(error.message.includes("Failed to persist the Telegram poll offset"));
        return true;
      },
    );
    // The update WAS handled (side effect ran), but it was NOT confirmed.
    assert.deepEqual(handled, ["hello"]);

    // Next poll re-fetches from the un-advanced offset. Consumers must make
    // side effects idempotent across that intentional redelivery.
    await assert.rejects(transport.pollOnce(), /Failed to persist/);
    const polls = calls.filter((c) => c.url.endsWith("/getUpdates"));
    assert.equal(polls.length, 2);
    assert.equal((polls[0].body as { offset: number }).offset, 0);
    assert.equal((polls[1].body as { offset: number }).offset, 0);
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
