# o8d opt-in WebSocket delivery

The app can opt into Rust delivery with `O8_WS_O8D=1`. Build the binary first:

```sh
cargo build --locked --release --manifest-path crates/o8d/Cargo.toml --features experimental-ws
```

`O8D_BINARY` can select a build explicitly; otherwise the bridge looks in this
crate's release target directory. Missing binaries fall back to TypeScript.
Without the flag, the existing TypeScript listener and delivery path are unchanged.
No release, packaging, or launcher installation is added here.

The TypeScript entry point starts a private ephemeral loopback listener and
supervises o8d on the resolved public WS port. Clients keep the same app URL.
Rust authenticates each upgrade through the existing TypeScript gate before
accepting it. An inherited random bridge credential authenticates peer metadata;
unmarked upgrades on the private listener are rejected, including upgrades after
HTTP keepalive. Device authentication, revocation, E2EE, commands, bootstrap and
checkpoint generation remain in TypeScript. Encrypted device traffic is relayed;
Rust does not decrypt it or fan it out from the plaintext event bus.

Local operator realtime subscriptions receive TS-stamped live events through one
inherited producer pipe. Rust handles fan-out, application/control heartbeats and
close forwarding. Private subscription barriers reconcile events crossing the
producer and backhaul streams. Evicted crossovers and lagged receivers close with
1013 so clients reconnect for authoritative replay. Socket writes have a 50 ms
budget. A slow socket cannot hold another client's task.

The producer pipe is capped at 1 MiB including queued bytes. Oversized publication
or pipe pressure closes producer input and returns clients to the TS listener;
Rust is retried after two seconds. Rust retains at most 400 events and uses a
count-bounded Tokio broadcast ring; each batch is bounded by the pipe limit. TypeScript
keeps its existing count/byte-bounded replay log and epoch across Rust lifetimes.
Tests recover every retained event through missing-binary fallback, process exit,
publication during fallback, restart, and oversized-publication fallback.

These are **bounded replay guarantees**, not a durable journal: history evicted
from the TS log uses the existing checkpoint/gap protocol. Exact redelivery of
all transitions beyond that retention window is still outstanding for #4533.
HTTP forwarding drains for a fixed 100 ms during orderly Rust shutdown; this is
best effort, and a slow request or abrupt process exit can lose its acknowledgment
after TS accepts it. Completion-aware draining or idempotent ingress remains to
be implemented. The Rust frontend does not negotiate permessage-deflate; device
traffic and legacy channel fan-out still use their TS owners.

## Verification and measurements

```sh
cargo test --locked --manifest-path crates/o8d/Cargo.toml --all-features
O8D_TEST_BINARY=crates/o8d/target/release/o8d O8_WS_PARITY_O8D=1 \
  npx vitest run tests/ws-parity-real-path.test.ts tests/ws-o8d-cutover-real-path.test.ts
O8_WS_O8D=1 O8D_BINARY=crates/o8d/target/release/o8d \
  npx vitest run tests/mobile-e2ee-required-real-path.test.ts
O8D_TEST_BINARY=crates/o8d/target/release/o8d \
  node --import=tsx scripts/bench/ws-cutover.ts
```

The Linux benchmark uses the real TS HTTP producer and app WS entry point in
both modes: 20 warmups and 200 last-subscriber fan-out samples, 1 KiB mutations,
1 and 20 clients. Ten fixture-only large-state JSON bursts block the TS loop for
at least 300 ms each, modeling the synchronous state work implicated in #4367.
A separate process measures application ping RTT every 10 ms, with one pending
ping per client. Memory includes both TS and Rust RSS, at idle and after load;
the reported peak is sampled after each burst, not an allocator high-water mark.
No desktop, operator machine, model provider, or real account is used.

The separate Linux process supervisor uses `experimental-supervisor` and
`--experimental-supervisor`. Its protocol and native launch opt-in are documented
in [SUPERVISOR.md](SUPERVISOR.md). It remains separate from WebSocket mode.

## Standalone slice 1 prototype

Default Cargo features build only the delivery library. The standalone binary
requires both the `experimental-ws` feature and `--experimental-ws`, and refuses
non-loopback listeners unless the app's authenticated backhaul mode is selected.
For isolated recordings, provide `WS_TOKEN` and `O8D_SERVER_VERSION`, then run
`--experimental-ws --listen 127.0.0.1:0`. The first stdout line reports the chosen
address. `--initial-state <file>` supplies TS-produced legacy initial envelopes.
Inherited stdin accepts one JSON array of stamped envelopes per line; invalid
input stops the standalone prototype. It never executes client commands.

The app-backed path passes all four existing recordings. The standalone prototype
still lacks fresh TS checkpoint generation and full legacy command routing.
The protocol is documented in [ws-protocol.md](../../docs/internals/ws-protocol.md).
The older standalone comparison remains in `scripts/bench/ws-event-bus.ts`;
`scripts/bench/ws-cutover.ts` measures the combined app path.

The separate HTTP transport is documented in [Experimental MCP transport](MCP.md).

The native-client HTTP experiment uses its own feature and runtime flag. Its
optional TypeScript owner hosts the existing handlers in the WS process so
native discovery, reconciliation, writes and streams can run without a Next
server. See [native HTTP](HTTP.md) for the explicit opt-ins, route inventory,
replay harness and Linux fixture measurements. Default startup is unchanged.
