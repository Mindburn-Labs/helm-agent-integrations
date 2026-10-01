# Retained episode controls

The optional AgentCard extension `urn:helm:a2a:episode-control:v1` exposes
`params.schema = helm.episode.control.capabilities.v1` and a `params.verbs` map.
Each of `helm/episode.steer`, `helm/episode.pause`, and `helm/episode.resume`
contains `supported` and a concrete unavailable `reason`.

The current four adapters declare all three unavailable. Their source-owned
profile describes the missing steering or checkpoint channel. Installing a
framework SDK, selecting a plugin, or supporting A2A Cancel does not enable a
control. The profile is mirrored byte-for-byte into the language packages.

Steering uses A2A message send with the retained `message.taskId`. A control
request cannot become a new first message. The shared runtime refuses unsupported
controls with JSON-RPC error `-32010` and scoped data containing `extension`,
`verb`, `taskId`, `supported: false`, and `reason`. Missing, foreign, or conflicting
task IDs fail before the unavailable response. The existing ingress bearer and
required episode-extension negotiation still apply.

No pause acknowledgement or checkpoint is fabricated. A real implementation
must stop at a tool boundary, retain a resumable checkpoint, and publish a
Subscribe-visible extension state `paused` before advertising support. Cancel
remains terminal; the control plane also owns the Kernel stop fence. Teardown
and deadline enforcement remain bound to the original episode.

This slice implements honest capability declaration and rejection. Native
steering/pause/resume, the control-plane client, and their actual framework
conformance scenarios remain subsequent source and qualification work.
