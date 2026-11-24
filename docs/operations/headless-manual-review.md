# Headless manual review hold

Start a headless profile with `O8_REVIEW_MODE=manual o8 serve` to hold background
review work for that process lifetime. `o8 serve status` reports `reviewMode`.
The default is `automatic`; values other than these two are rejected at startup.
Use the same environment on a subsequent restart to retain the hold. A supervised
restart retains its existing mode and refuses an explicitly different or invalid
mode before signaling. Stop the profile, then start it again to change its mode.

Manual mode does not reclaim abandoned review attempts, claim queued reviews,
or enqueue review continuations. The headless children
also receive per-run overrides disabling the heal bot, supervisor escalation,
and Brain warmup. Background sprint ticks from the WebSocket
bridge are held. Saved operator defaults and existing review claims are preserved.

The hold is a startup recovery control. It does not cancel already-running turns
or prohibit explicitly requested tasks. Stop the previous runtime and verify its
owned processes have exited before starting a profile in manual mode. Inspect the
preserved review state before returning that profile to automatic mode.

## Renew a stopped private profile token

Use `O8_DATA_DIR=<private-profile> o8 serve renew-token` after stopping the profile.
This atomically replaces only its local runtime token and prints a success receipt,
never the credential. The command requires an existing headless profile and refuses
the default desktop directories, workers, retained owner/state files, and listening
runtime ports. It does not clear stale ownership evidence. Reconcile an unresolved
shutdown before retrying. Account authentication is separate and remains unchanged.

Keep the private profile stopped throughout renewal. Headless starts contend on
its owner file; do not open that profile in a desktop app concurrently. Start the
same profile with the new credential only after the ownership and review controls
have been verified.

Lifecycle commands share an exclusive profile operation lock. State writes and
cleanup also check the launch generation under a short mutation lock. A daemon
defers to an external stop owner after that owner retains the descendant census.
An interrupted lock owner leaves the profile held for ownership reconciliation;
locks are never stolen merely because a timeout or age threshold elapsed.
