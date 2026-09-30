# Shared worker runtime

The three SDK adapters share this A2A v1.0 JSON-RPC transport. It enforces the required HELM
extension and ingress bearer, streams task/status/artifact events, and retains the current
task for `GetTask` and `SubscribeToTask` while the sandbox exists. A pod accepts one episode;
the control plane owns durable state and starts another pod for a continuation.

Cancellation and the episode deadline interrupt the framework coroutine, including an open
model or MCP request. The Claude adapter terminates the entire SDK subprocess group. Every
tool result uses the outcome rules in `helm-worker-contract`: escalation, delegation and input
requests park; an applied report ends the episode; finishing without a report fails.

The runtime is a worker transport, not an authority boundary. Deploy workers with the
contract's restricted sandbox and network policy: only the provided gateway endpoints are
reachable, provider credentials remain at the gateway, and the control plane destroys the pod
after every terminal episode.
