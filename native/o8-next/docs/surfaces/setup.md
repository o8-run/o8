# First-run setup

Opt-in setup retains project registration, tool selection, privacy choices and
first-conversation creation through the production desktop routes. The selected
lead backend and model remain attached to the first conversation and first send.

Registration and lifecycle policy live in `src/surfaces/setup.rs`; the view and
all four existing onboarding tests live in `src/surfaces/setup/`. The dev host
discovers `05-setup.surface.ts`. Original parity, red/green and timing receipts
remain in [setup/verification.md](setup/verification.md).

The surface also owns `Client::setup_request`, following the request extraction
on main at `9f44b02ea`. It uses the shared URL, request and decoding helpers while
preserving its prior routes, operator bearer and refusal text.

Explicit saved OpenCode models remain covered. All four original GPUI test names
are retained and pass through `shell::test_support` and
the discovered production-route fixture. The moved receipts retain the original
audit trail. [Registration red](setup/registration/red-tail.txt) failed three
first-run entry cases before the load hook; [green](setup/registration/green-tail.txt)
passes all four, including saved model and first-send routing.

The Projects integration can supply registered workspace paths before any saved
conversation exists. Setup therefore keeps the previous conversation-based
first-run trigger. A [new red](setup/registration/registered-red.txt) reproduced
suppression by registered paths; [final green](setup/registration/registered-green.txt)
passes all five setup and sixteen Projects cases through their real entries.

Two shared files need lifecycle dispatch in addition to the inventory line:
`src/surface_registry.rs` declares optional `loaded`/`allow_open` callbacks, both
defaulting to `None`, and `src/shell.rs` calls opted-in callbacks. The surface owns automatic first-run entry and its
existing busy-navigation refusal. Existing Projects and Settings overlays keep
their registration precedence. Client, main, shared shell tests/view/state and
dev-host dispatchers match main.

All [main test names and original surface names](setup/registration/preserved-tests.json)
are preserved. Current gate totals are recorded in the registration receipts.

Current rebase results, failures and retries: [setup/registration/verification.md](setup/registration/verification.md).

Correction round 2: [setup/correction-2/verification.md](setup/correction-2/verification.md).
OpenCode lead recommendations now resolve a saved model, validated CLI default,
then the canonical OpenCode default. The native view refuses an absent model
before creating a conversation. A Codex worker pool cannot supply its lead model.

Only first-run setup opts into the lifecycle callbacks. `loaded` needs the GPUI
context after asynchronous workspace loading to open first-run setup before its
frame. `allow_open` rejects commands before navigation mutates state while setup
is busy. Other registered modules keep their existing constructors and no hooks;
the unchanged main probe is exercised through the native shell. Setup state and
callback policy remain in its module.

Refs #4548
