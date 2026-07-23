# @mindburn/helm-channel-bridge

HELM-governed channel bridge: human-in-the-loop by phone. Inbound chat
commands (Telegram today) become Kernel-evaluated governed turns; pending
`ask_human` questions are relayed to the phone and the answers routed back —
every hop receipted by the HELM AI Kernel.

This is a HELM-compatible example adapter. Command-bridge and transport
mechanisms are adapted from the Apache-2.0
[Rowboat](https://github.com/rowboatlabs/rowboat) project's ChannelBridge and
Telegram transport; the implementation here is original and adds HELM
governance semantics Rowboat does not have (Rowboat runs channel turns with
`autoPermission: true` and no per-command policy evaluation).

## Governance model (fail closed)

- **Every inbound command is Kernel-evaluated.** `help`, `list`, `status`,
  `resume`, `new`, `stop`, chat turns, and `ask_human` answers each produce a
  `/api/v1/evaluate` preflight with a distinct action URN
  (`channel.<transport>.command.<name>`, `channel.<transport>.turn.run`,
  `channel.<transport>.ask_human.answer`). Only an explicit `ALLOW` dispatches.
- **Deny by default.** Unknown verdicts, `ESCALATE`, evaluator outages, and
  malformed responses are treated as denials. Unknown slash-commands are
  denied locally without evaluation or dispatch.
- **autoPermission is allowlist-only.** It is granted only to commands in the
  operator's explicit allowlist (default: the routine read-only commands
  `help`/`list`/`status`). Chat turns run with `autoPermission: false` so tool
  effects inside the turn still need Kernel/permission approval. Adding
  `"chat"` to the allowlist restores Rowboat-style permission-less turns —
  a deliberate, risky operator choice.
- **Transport is fail closed.** Telegram DMs only (group chats are ignored —
  any member could otherwise drive the bridge), an explicit chat-ID allowlist
  (empty = deny everyone), persisted poll offset (no re-execution after
  restart), and terminal handling for revoked tokens (401/404).

## Credentials

The Telegram bot token is read from the `HELM_TELEGRAM_BOT_TOKEN` environment
variable **only** — never from config files, command arguments, or inbound
messages. It is never logged or embedded in message text.

```bash
export HELM_TELEGRAM_BOT_TOKEN=...   # from @BotFather
```

## Usage

```ts
import {
  ChannelBridge,
  TelegramTransport,
  createKernelEvaluator,
  telegramOptionsFromEnv,
} from "@mindburn/helm-channel-bridge";

const bridge = new ChannelBridge({
  transportName: "telegram",
  evaluator: createKernelEvaluator({
    tenantId: process.env.HELM_TENANT_ID!,
    apiKey: process.env.HELM_API_KEY!,
  }),
  sessions: myGovernedSessions,     // ChannelSessions implementation
  turnEvents: myTurnEventBus,       // ChannelTurnEventSource implementation
});

const transport = new TelegramTransport(
  telegramOptionsFromEnv(process.env, {
    allowFrom: ["123456789"],       // your Telegram chat ID
    stateFile: ".helm/telegram-offset.json",
    onInbound: (senderKey, chatId, text) =>
      void bridge.handleInbound(senderKey, text, (msg) => transport.send(chatId, msg)),
  }),
);

await transport.start();
```

`ChannelSessions` / `ChannelTurnEventSource` are minimal interfaces your
governed runtime implements (create session, send message, stop turn, respond
to ask_human, settle-event stream). The bridge only ever calls them after a
Kernel `ALLOW`.

## Demo of a non-dispatching path

See `src/bridge.test.ts`: a `DENY` verdict (with receipt ID) blocks dispatch
and is reported to the sender; `ESCALATE`, unknown verdicts, evaluator
outages, and unknown slash-commands are all denied without touching the turn
engine.

## Development

```bash
npm install
npm test
```

Tests use a fake transport, fake session engine, fake evaluator, and an
in-memory event bus — no network, no credentials.
