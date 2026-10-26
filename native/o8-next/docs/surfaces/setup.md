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

The final local correction removes the lifecycle changes to the shared registry
and shell dispatcher. The setup runtime owns a once-per-shell first-run check,
scheduled through the existing navigation hook after the shell connects. The
existing key hook and the view's per-frame capture listeners block navigation
while setup is busy. Closing setup leaves the shell-lifetime check complete.
Shared client, registry, shell view/state/tests and dev-host dispatchers match main;
the native shell adds only its one setup inventory line.

All [main test names and original surface names](setup/registration/preserved-tests.json)
are preserved. Current gate totals are recorded in the registration receipts.

Current rebase results, failures and retries: [setup/registration/verification.md](setup/registration/verification.md).

Correction round 2: [setup/correction-2/verification.md](setup/correction-2/verification.md).
OpenCode lead recommendations now resolve a saved model, validated CLI default,
then the canonical OpenCode default. The native view refuses an absent model
before creating a conversation. A Codex worker pool cannot supply its lead model.

Final local round: [matrix and receipts](setup/final-local/verification.md).
Claude, Codex and OpenCode keep their own saved or canonical models. Codex uses
its validated local lead default when present. Pi uses its detected model; an
unresolved choice asks for a model in the native tools page before any
conversation is created. The managed o8 backend uses its canonical managed
model, independently of saved preferences from another backend. No runtime model
ID is copied into the native implementation.

The final compiler proof applies only setup source files and its single inventory
line to an untouched main snapshot. Both the registered and removed-entry native
applications compile, including unchanged surface constructors and tests.
Earlier registration and correction receipts remain historical evidence.

Refs #4548
