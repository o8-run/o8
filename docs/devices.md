# Devices in the workspace

Open **Devices** from the right panel's tab picker. Maximize the panel when you need more room. Its width is remembered separately from Files and Inbox.

## Requirements and setup

- iOS simulators: macOS, Xcode, an installed simulator runtime, and a simulator created in Xcode.
- Android emulators: Android Studio's platform tools and emulator, an installed system image, and an existing virtual device.
- Device viewer setup: Node.js with npm and an internet connection for the optional helper installation.

Opening the panel checks prerequisites. Choose **Set up device viewer** to install the pinned `expo-device-hub` helper, then **Open device workspace** to start it. This setup does not install Xcode, Android Studio, SDKs, simulator runtimes, or system images. Create the devices you need in their platform tools first.

The embedded dashboard provides the installed viewer's device selection, live screens, interaction and capture controls. Available devices and controls depend on the installed platform tools. Closing or hiding the panel releases the embedded viewer; **Stop viewer** terminates o8's viewer helper and leaves simulators running.

The pinned viewer's packaged iOS native module targets Apple Silicon. Intel Macs need an x86_64 build of that module and its matching WebRTC framework; installing the JavaScript helper alone does not supply Intel streaming support. Keep any local native replacement tied to the pinned helper version. Updating or reinstalling the helper can replace it.

## Coding-agent controls

Choose **Set up agent controls** for the optional pinned `agent-device` CLI. **Copy agent instructions** explains the `o8_device` tool. These instructions remain available under **Shared device · Agent controls** while the viewer is open. Setup does not start a simulator. Installed controls attach automatically to supported packet workers; existing workers need a new turn or launch to receive updated tool configuration.

The simulator is shared. Call `o8_device` with `action: "status"`, then `acquire` and a listed `deviceId`. The app assigns a controller session from host authority, conversation, worker process identity and device. All managed commands use one coordinated authority and helper state directory. Workers cannot supply their own session, command, state directory or device path. Packet workers use their own credential and live run marker, through a Devices-only tool route. Android control remains deferred.

The Devices panel shows the active controller and waiting workers, with opaque conversation and worker labels. Prompt text, typed text, local paths and credentials are excluded from the roster. A second acquisition is refused and recorded as waiting. The current controller can explicitly `handoff` to a waiting `targetSession`; the operator can also choose **Hand off control** in the panel. The old helper session is closed only by release, explicit handoff, operator takeover or recovery of its proven exited worker. Independent simulators can have independent controllers.

Use `press`, `swipe`, `scroll`, `type` and `snapshot` with the acquired device. The panel shows a static input marker, coordinates when supplied, and readable attribution for the latest completed command. This marker does not claim to be positioned over the live device screen. Call `release` when finished or cancelled; a waiting worker can also cancel its wait. In-flight input prevents handoff. Failed helper confirmation retains ownership and offers release or handoff recovery instead of guessing that the device is free.

Viewing is passive until **Take operator control** succeeds for every open iOS simulator. Manual viewer input then appears under **Operator**, and agent input is refused until an explicit handoff. Starting a handoff immediately disables input in that panel. The embedded helper still accepts input directly: another app window may retain an older operator grant until its next poll. Server-enforced viewer input ownership remains acceptance work; do not coordinate simultaneous manual input across windows or bypass managed ownership with a raw helper.

Roster reads recover a proven exited worker by closing only its recorded session. An interrupted authority operation can be unlocked after both its recorded authority process and helper process have exited; its controller is retained until release. Unknown process identity or a crash before helper identity was recorded stays blocked. Simulator restart reconciliation and recovery of that unrecorded-helper state remain acceptance work.

While visible, the panel checks its helper state every five seconds and offers recovery if the process stops. Requests time out after fifteen seconds so Refresh remains usable. Hiding the panel stops these checks; restoring it reads the current state without stopping the simulator.

## Local access

The viewer binds to this computer's loopback interface and requires a session token. o8 verifies authenticated access before embedding it. The app page must use its local HTTP address (`127.0.0.1` or `localhost`); remote, HTTPS and custom-scheme pages are not supported by this helper's cookie-based embedding.

## Acceptance boundary

The route and process fixtures cover setup, startup, authentication, cancellation, cleanup, development hot reload and the token-to-cookie flow. Controller fixtures exercise real Devices routes, the MCP tool handler, packet worker admission, owned worker launch configuration and two real stdio tool transports against a shared fixture simulator. They also cover separate devices, explicit handoff, operator takeover, failed release, in-flight refusal and persisted abandoned operations. UI tests cover passive viewing, roster attribution, missing tools and hidden-panel cleanup.

Native acceptance must separately verify two actual workers on one iOS simulator, independent workers on separate simulators, simulator restarts, streaming, input and a screen-positioned touch indicator with readable attribution and reduced-motion behavior. The current static input marker has no animation. Fixture transport success does not establish native acceptance, physical-device support or Android acceptance. Posture and accessibility controls remain separate work in #3973.
