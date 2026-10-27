# Mobile relay heartbeat

The desktop negotiates application heartbeats on its outbound `/mac` socket.
The relay advertises support with `"heartbeat":"app-v1"` in a `devices` frame.
After that frame the desktop sends these exact frames, in order:

```json
{"t":"relay-capabilities","heartbeat":"app-v1"}
{"t":"relay-heartbeat","v":1}
```

The heartbeat repeats every 25 seconds. Repeated `devices` frames do not create
another timer or declaration. A version 1 `relay-heartbeat-ack` counts as inbound
liveness alongside protocol pongs. The existing protocol ping schedule remains
active. Stop and disconnect clear both schedules; a new socket negotiates again.

The hosted relay implementation is outside this repository. It must advertise
support before this desktop enables heartbeats. Bare `devices` frames retain the
existing behavior, so an older relay receives no new control frames.

The relay contract exempts desktops that never declare the capability. Once a
desktop declares it, only a version 1 application heartbeat renews the 90-second
deadline. On expiry, the relay removes online presence immediately and closes
with 1012 `heartbeat_timeout`; it must not wait for a TCP close handshake to mark
the desktop offline. The desktop then uses its ordinary reconnect backoff.

`src/lib/mobile/relay-connector.test.ts` exercises the bootstrap entry point with
cached fixture credentials and an independent local `/mac` relay. It checks the
production 25-second schedule, healthy presence beyond 90 seconds, a paused TCP
receive path, offline timing, 1012 recovery, and compatibility in both directions.
This fixture verifies the client contract; hosted support must ship separately.
