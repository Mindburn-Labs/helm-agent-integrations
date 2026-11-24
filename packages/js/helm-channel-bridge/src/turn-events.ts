// Normalize host turn events and keep a subscription from send through settle.

export type ChannelTurnEvent =
  | { type: "turn_completed"; text: string | null }
  | { type: "turn_failed"; error: string }
  | { type: "turn_cancelled" }
  | {
    type: "turn_suspended";
    pendingAskHuman?: { toolCallId: string; question: string; options?: string[] } | null;
    pendingPermissions?: number;
  };

export interface ChannelTurnEventSource {
  /** Subscribe to settle-relevant events for every turn. Returns unsubscribe. */
  subscribeAll(
    listener: (event: { turnId: string; event: ChannelTurnEvent }) => void,
  ): () => void;
}

export type Settled =
  | { kind: "completed"; text: string | null }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }
  | { kind: "ask_human"; toolCallId: string; question: string; options?: string[] }
  | { kind: "suspended" }
  | { kind: "timeout" };

export function settleOf(event: ChannelTurnEvent): Settled | null {
  switch (event.type) {
    case "turn_completed":
      return { kind: "completed", text: event.text };
    case "turn_failed":
      return { kind: "failed", error: event.error };
    case "turn_cancelled":
      return { kind: "cancelled" };
    case "turn_suspended": {
      const ask = event.pendingAskHuman;
      if (ask) {
        return {
          kind: "ask_human",
          toolCallId: ask.toolCallId,
          question: ask.question || "The agent needs your input.",
          options: ask.options,
        };
      }
      // Suspended without an ask_human means a permission approval is
      // waiting somewhere else (e.g. an operator console); report it.
      if ((event.pendingPermissions ?? 0) > 0) {
        return { kind: "suspended" };
      }
      return null;
    }
    default:
      return null;
  }
}

interface TurnWatcher {
  waitFor(turnId: string, timeoutMs: number): Promise<Settled>;
  dispose(): void;
}

// Buffers settle-relevant events from the moment of subscription so a
// settle firing between sendMessage and waitFor() is never lost. One
// watcher per in-flight message; mechanism adapted from Rowboat's
// ChannelBridge (Apache-2.0), original implementation.
export function watchTurnEvents(source: ChannelTurnEventSource): TurnWatcher {
  const buffered: Array<{ turnId: string; settled: Settled }> = [];
  let waiter: { turnId: string; resolve: (settled: Settled) => void } | null = null;
  let cancelTimer: (() => void) | null = null;
  const unsubscribe = source.subscribeAll((event) => {
    const settled = settleOf(event.event);
    if (!settled) return;
    if (waiter) {
      if (event.turnId === waiter.turnId) waiter.resolve(settled);
      return;
    }
    buffered.push({ turnId: event.turnId, settled });
  });
  return {
    waitFor: (turnId: string, timeoutMs: number): Promise<Settled> =>
      new Promise<Settled>((resolve) => {
        const hit = buffered.find((b) => b.turnId === turnId);
        if (hit) {
          resolve(hit.settled);
          return;
        }
        buffered.length = 0;
        const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        cancelTimer = () => clearTimeout(timer);
        waiter = {
          turnId,
          resolve: (settled) => {
            clearTimeout(timer);
            resolve(settled);
          },
        };
      }),
    dispose: () => {
      unsubscribe();
      cancelTimer?.();
    },
  };
}
