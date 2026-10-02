# Future goals

Parked direction for after the current milestone. Not scheduled yet.

## Serve both REST and a client WebSocket

Today the gateway proxies an upstream creator-platform service and serves REST
only. The goal is to also supply that upstream ourselves and serve a live
WebSocket to API clients, so a client gets both the REST surface and a real-time
event stream from one bearer key.

- **One auth model.** REST and WebSocket both authenticate with a stored `gk_`
  key (hash only), scoped to the key's account allowlist. The socket auths via
  `Sec-WebSocket-Protocol: bearer.<key>`.
- **Supply the upstream.** Ship the upstream as a separate service alongside the
  gateway rather than folding its source into this public repo. See the full
  plan in [docs/spec/handoff-of-serving.md](docs/spec/handoff-of-serving.md).

## User-designable statistics page

After serving works, let each workspace build its own stats page over the data
we serve: pick metrics, arrange widgets, save the layout per workspace. Start
with a fixed widget set, not a plugin system.

## One-command Hostinger deploy

Extend the deploy compose so the whole stack — gateway, Postgres, the upstream,
Caddy — comes up together on a Hostinger VPS, upstream reached over the internal
network. Details in the handoff, section 5.

Full build phases, the module list, the must-replace items, and open decisions
live in [docs/spec/handoff-of-serving.md](docs/spec/handoff-of-serving.md).
