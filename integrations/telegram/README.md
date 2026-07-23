# Telegram + HELM

Telegram gives operators a phone surface for human-in-the-loop control of
governed agent sessions. HELM evaluates every inbound command before it may
execute — fail closed, receipted, deny by default.

Use `ChannelBridge`, `TelegramTransport`, and `createKernelEvaluator(...)`
from `@mindburn/helm-channel-bridge` (`packages/js/helm-channel-bridge`).

- Bot token via the `HELM_TELEGRAM_BOT_TOKEN` environment variable only.
- DMs only, explicit chat-ID allowlist, empty allowlist denies everyone.
- Every command materializes as a Kernel-evaluated turn; unknown commands are
  denied. `autoPermission` only for explicitly allowlisted routine read-only
  commands (`help`/`list`/`status` by default).
- `ask_human` questions are relayed to the chat; answers are Kernel-evaluated
  before being routed back into the suspended turn.

WhatsApp/baileys is intentionally not supported (unofficial protocol,
account-ban and ToS risk).
