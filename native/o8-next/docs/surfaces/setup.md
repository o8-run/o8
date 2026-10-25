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

The previously fixed OpenCode first-conversation model remains fixed. All four
original GPUI test names are retained and pass through `shell::test_support` and
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
`src/surface_registry.rs` declares default `loaded`/`allow_open` hooks, and
`src/shell.rs` calls them. The surface owns automatic first-run entry and its
existing busy-navigation refusal. Existing Projects and Settings overlays keep
their registration precedence. Client, main, shared shell tests/view/state and
dev-host dispatchers match main.

All [main test names and original surface names](setup/registration/preserved-tests.json)
are preserved. Current gate totals are recorded in the registration receipts.

Current rebase results, failures and retries: [setup/registration/verification.md](setup/registration/verification.md).

Refs #4548
