# Machine budget

Dispatch reads the OS one-minute load average on macOS and Linux, including work
started outside o8. `O8_DISPATCH_LOAD_PER_CORE` defaults to **0.5** per logical
core. Above this limit workers stay queued with a plain-language reason; the
scheduler retries on later ticks. Invalid settings fall back to 0.5. Windows
load is unknown and admits. Load is a sampled guard, not a CPU reservation.

Workers must wrap native builds and full suites with
`o8 run-heavy -- <command> [args...]`. The packet brief teaches this command.
Concurrency is **1**, shared by all heavy steps and worktrees for the signed-in
OS user. o8 cannot intercept arbitrary shell commands or builds from other tools;
those tools can opt into this same wrapper. The wrapper preserves argument
boundaries, streams output, reports FIFO position, and propagates command failure.

The queue reuses the resource lease store and process-identity checks used by
workspace lifecycle leases. Its database lives in the OS user's o8 machine lease
directory, independent of app data-directory overrides. `O8_MACHINE_LEASE_DIR`
can relocate it; all participating processes must use the same directory. Dead
owners are reclaimed, unknown identities fail closed, and live long-running
owners are never stolen merely because their lease TTL elapsed. Waits time out
after 24 hours. Separate OS users do not share this queue.

`npm run verify:ci` acquires a separate, non-waiting machine lease before planning
or running checks. A second copy refuses and names its holder. An operator can
explicitly override with `npm run verify:ci -- --allow-concurrent`. When started
by a worker, wrap this command in `o8 run-heavy -- npm run verify:ci` as well.
This does not manage Cargo cache size or remove build outputs.
