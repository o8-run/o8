//! Sentry crash/error reporting for the native (Rust) shell — panics + native
//! crashes, tagged with the app version + plan + a founder boolean.
//!
//! DORMANT unless this is a RELEASE build that had a DSN baked in (build.rs sets
//! `O8_SENTRY_DSN` via `cargo:rustc-env`, RELEASE profile only) — dev / `tauri
//! dev` (debug) stay silent regardless. `environment` is always "production"
//! because we never reach here in debug.
//!
//! Privacy is brand (telemetry ruling): `before_send` collapses `/Users/<user>`
//! + `/home/<user>` home paths to an ellipsis and drops the machine name;
//! `send_default_pii` is false so no username/IP is attached. The live "Crash &
//! error reports" toggle is re-read every 30s (and checked in `before_send`), so
//! turning it OFF stops the wire within the budget without dropping the client.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(target_os = "macos")]
use crate::entitlement;

/// Live mirror of the operator toggle — refreshed by the 30s watcher and read in
/// `before_send`. Defaults OFF so consent absence can never create consent.
static CRASH_REPORTS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Canonical o8 data dir (`~/.o8`, overridable). Kept local so this module stays
/// dependency-free, mirroring `entitlement::o8_data_dir`.
fn o8_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

/// Read the "Crash & error reports" toggle from `~/.o8/operator-defaults.json`
/// (`crashReportsEnabled`). Missing, unreadable, malformed, or non-boolean state
/// resolves to OFF. Never panics.
fn read_toggle() -> bool {
    let path = o8_data_dir().join("operator-defaults.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    match value.get("crashReportsEnabled") {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => false,
    }
}

/// The baked DSN (runtime env wins, else the compile-time bake), or None. Empty
/// is treated as absent. `None` in a debug build (build.rs bakes release-only).
fn resolve_dsn() -> Option<String> {
    if let Ok(dsn) = std::env::var("O8_SENTRY_DSN") {
        if !dsn.trim().is_empty() {
            return Some(dsn);
        }
    }
    match option_env!("O8_SENTRY_DSN") {
        Some(dsn) if !dsn.trim().is_empty() => Some(dsn.to_string()),
        _ => None,
    }
}

/// Collapse `/Users/<user>` and `/home/<user>` home prefixes to `/Users/…` /
/// `/home/…`, keeping the trailing path so a stack stays debuggable. The
/// username is the PII. Pure; operates on char boundaries.
pub fn scrub_paths(input: &str) -> String {
    scrub_prefix(&scrub_prefix(input, "/Users/"), "/home/")
}

fn scrub_prefix(input: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(prefix);
        out.push('…');
        let after = &rest[idx + prefix.len()..];
        // Drop the identity-bearing username segment up to the next path
        // separator / terminator; keep everything after it.
        let end = after
            .find(|c: char| {
                c == '/' || c.is_whitespace() || c == '"' || c == '\'' || c == ':' || c == ')'
            })
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Make the baked DSN visible to child processes (the Next server + ws-server
/// inherit the parent env), so all layers share one source. RELEASE-only; a
/// real runtime `O8_SENTRY_DSN` (e.g. from the wrapper bake) already set wins.
pub fn export_dsn_to_env() {
    if cfg!(debug_assertions) {
        return;
    }
    if std::env::var("O8_SENTRY_DSN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_some()
    {
        return;
    }
    if let Some(dsn) = option_env!("O8_SENTRY_DSN") {
        if !dsn.trim().is_empty() {
            std::env::set_var("O8_SENTRY_DSN", dsn);
        }
    }
}

/// Initialize Sentry for the native shell. Returns the guard (hold it for the
/// program's lifetime so panics flush on exit) or None when dormant. Never
/// panics.
pub fn init() -> Option<sentry::ClientInitGuard> {
    // Dev / `tauri dev` stay silent.
    if cfg!(debug_assertions) {
        return None;
    }
    let dsn = resolve_dsn()?;

    CRASH_REPORTS_ENABLED.store(read_toggle(), Ordering::Relaxed);

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(crate::app_version::app_version().into()),
            environment: Some("production".into()),
            send_default_pii: false,
            // Errors only — no performance/tracing.
            traces_sample_rate: 0.0,
            // Never attach the machine name.
            server_name: None,
            before_send: Some(Arc::new(|mut event| {
                // Live kill-switch: OFF → drop every event (no wire).
                if !CRASH_REPORTS_ENABLED.load(Ordering::Relaxed) {
                    return None;
                }
                event.server_name = None;
                if let Some(msg) = event.message.take() {
                    event.message = Some(scrub_paths(&msg));
                }
                for exception in event.exception.values.iter_mut() {
                    if let Some(value) = exception.value.take() {
                        exception.value = Some(scrub_paths(&value));
                    }
                }
                Some(event)
            })),
            ..Default::default()
        },
    ));

    sentry::configure_scope(|scope| {
        scope.set_tag("app_version", crate::app_version::app_version());
        // Plan/founder come from the macOS-gated entitlement module (#1673) —
        // off-macOS builds tag the version + surface only.
        #[cfg(target_os = "macos")]
        {
            scope.set_tag(
                "plan",
                entitlement::read_plan().unwrap_or_else(|| "free".to_string()),
            );
            // Boolean only — never the operator number.
            scope.set_tag("founder", entitlement::is_founder());
        }
        scope.set_tag("surface", "rust");
    });

    // Live-toggle watcher: OFF is respected within ~30s across layers.
    let _ = std::thread::Builder::new()
        .name("o8-sentry-toggle".to_string())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            CRASH_REPORTS_ENABLED.store(read_toggle(), Ordering::Relaxed);
        });

    Some(guard)
}

/// Start native crash capture — the crash class the `sentry` panic hook in
/// `init()` CANNOT observe: hardware faults + aborts (SIGSEGV / SIGABRT / SIGBUS
/// / SIGILL / SIGFPE, and stack-overflow). Returns the reporter handle (hold it
/// for the program lifetime — dropping it closes the reporter process) or None
/// when dormant/gated.
///
/// Composes with EVERY gate in `init()`: this is only reachable when `init()`
/// returned a live guard, i.e. a RELEASE build that baked a DSN (debug / no-DSN
/// stay dormant — the caller never has a guard to pass).
///
/// Architecture (`sentry-rust-minidump 0.8` → `minidumper-child 0.2` →
/// `crash-handler 0.6` + `minidumper 0.8`): `sentry_rust_minidump::init` RE-EXECS
/// this binary with `--crash-reporter-server=<uuid>` to run an out-of-process
/// reporter sibling. Everything BEFORE that call runs in BOTH processes; inside
/// it the reporter runs its server loop and `process::exit(0)`s, so it never
/// returns to run the app's boot-identity / port-allocation / orphan-reaping /
/// window setup. That is exactly why the caller places this immediately after
/// `init()` and BEFORE any of that setup — both to catch early crashes and so
/// the reporter never becomes a second full app instance (never binds ports,
/// never reaps the main app's Node children).
///
/// Toggle: honored at LAUNCH. If `crashReportsEnabled` is OFF when the main
/// process starts, the reporter is never spawned (a mid-session flip to ON
/// applies on the NEXT launch — the settings subtitle discloses this). If ON at
/// launch, a mid-session flip to OFF is ALSO respected: the reporter runs
/// `init()` too, so its own `before_send` drops the minidump event within ~30s.
///
/// PII honesty: a minidump is a raw memory snapshot — thread stacks (locals,
/// string fragments, and any secret/token that was live on a stack at crash
/// time), CPU registers, and the loaded-module list (dylib paths carry the
/// username). `before_send` scrubs EVENT metadata only; the minidump ATTACHMENT
/// bytes are uploaded RAW. This is industry-standard for crash reporting and is
/// covered by the disclosed "Crash & error reports" toggle.
pub fn init_minidump_handler(
    guard: &sentry::ClientInitGuard,
) -> Option<sentry_rust_minidump::Handle> {
    // Detect the re-exec'd reporter child by minidumper-child's default server
    // arg. In the reporter we MUST call through to `sentry_rust_minidump::init`
    // REGARDLESS of the toggle: inside it the reporter runs its server loop and
    // `process::exit(0)`s, never reaching the app's port/window setup. Skipping
    // it here (e.g. because the toggle raced OFF between the parent spawning us
    // and us reading it) would let this process fall through and boot a second
    // full app instance. The launch-toggle gate therefore applies to the MAIN
    // process only.
    let is_reporter = std::env::args().any(|arg| arg.starts_with("--crash-reporter-server"));

    if !is_reporter && !read_toggle() {
        return None;
    }

    // `guard: &ClientInitGuard` coerces to the `&sentry::Client` the API wants
    // via `Deref<Target = Client>`.
    match sentry_rust_minidump::init(guard) {
        Ok(handle) => Some(handle),
        Err(err) => {
            log::warn!("[telemetry] native crash handler failed to start: {err}");
            None
        }
    }
}

/// Hidden crash-test trigger for post-ship end-to-end verification of the native
/// crash pipeline (a real crash can't be exercised by a `#[cfg(test)]` unit).
/// Set `O8_CRASH_TEST=segv|abort|stackoverflow` and launch once — the process
/// crashes that exact way so the operator can confirm the event + minidump land
/// in the Sentry dashboard.
///
/// Checked ONCE at startup, AFTER telemetry + minidump init, in the MAIN process
/// only (the reporter child `exit(0)`s inside `init_minidump_handler` and never
/// reaches this call). Active in debug AND release, but only a signed release
/// with a baked DSN and the toggle ON actually uploads — a debug/no-DSN build
/// just crashes. No-op when the var is unset or empty.
pub fn maybe_trigger_crash_test() {
    let Ok(mode) = std::env::var("O8_CRASH_TEST") else {
        return;
    };
    let mode = mode.trim().to_ascii_lowercase();
    if mode.is_empty() {
        return;
    }

    log::error!(
        "[telemetry] O8_CRASH_TEST={mode} — deliberately crashing to verify native crash capture"
    );
    // Let the log line and any queued sentry envelope drain before we crash.
    std::thread::sleep(Duration::from_millis(250));

    match mode.as_str() {
        "abort" => {
            // Raises SIGABRT — the same signal Rust's stack-overflow handler
            // raises via abort(); crash-handler hooks SIGABRT explicitly on macOS.
            std::process::abort();
        }
        "segv" => {
            // Null write → SIGSEGV / EXC_BAD_ACCESS (Mach exception port path).
            #[allow(deref_nullptr)]
            unsafe {
                std::ptr::null_mut::<u8>().write_volatile(1);
            }
        }
        "stackoverflow" => {
            // Unbounded recursion → guard-page fault: reproduces tonight's exact
            // crash class (EXC_BAD_ACCESS in Rust's stack-overflow handler →
            // abort). Captured out-of-process on a fresh stack. `black_box` keeps
            // the optimizer from turning this into a tail call / eliding it.
            #[allow(unconditional_recursion)] // deliberate: this IS the overflow
            fn overflow(depth: u64) -> u64 {
                let frame = [depth; 256];
                std::hint::black_box(&frame);
                overflow(std::hint::black_box(frame[0]).wrapping_add(1))
            }
            std::hint::black_box(overflow(std::hint::black_box(0)));
        }
        other => {
            log::warn!(
                "[telemetry] unknown O8_CRASH_TEST value {other:?} (want segv|abort|stackoverflow) — not crashing"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_toggle, scrub_paths};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    fn read_toggle_from(setup: impl FnOnce(&Path)) -> bool {
        let _lock = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_o8 = std::env::var_os("O8_DATA_DIR");
        let previous_cortex = std::env::var_os("CORTEX_IDE_DATA_DIR");
        let test_dir = std::env::temp_dir().join(format!(
            "o8-telemetry-toggle-{}-{}",
            std::process::id(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&test_dir);
        std::fs::create_dir_all(&test_dir).expect("create toggle test dir");
        std::env::set_var("O8_DATA_DIR", &test_dir);
        std::env::remove_var("CORTEX_IDE_DATA_DIR");

        setup(&test_dir.join("operator-defaults.json"));
        let result = read_toggle();

        match previous_o8 {
            Some(value) => std::env::set_var("O8_DATA_DIR", value),
            None => std::env::remove_var("O8_DATA_DIR"),
        }
        match previous_cortex {
            Some(value) => std::env::set_var("CORTEX_IDE_DATA_DIR", value),
            None => std::env::remove_var("CORTEX_IDE_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(test_dir);
        result
    }

    #[test]
    fn missing_toggle_file_fails_closed_through_real_reader() {
        assert!(!read_toggle_from(|_| {}));
    }

    #[test]
    fn malformed_toggle_json_fails_closed_through_real_reader() {
        assert!(!read_toggle_from(|path| {
            std::fs::write(path, "{not-json").expect("write malformed toggle");
        }));
    }

    #[test]
    fn unknown_toggle_shape_fails_closed_through_real_reader() {
        assert!(!read_toggle_from(|path| {
            std::fs::write(path, r#"{"telemetry":{"crashReportsEnabled":true}}"#)
                .expect("write unknown toggle shape");
        }));
    }

    #[test]
    fn unreadable_toggle_path_fails_closed_through_real_reader() {
        assert!(!read_toggle_from(|path| {
            std::fs::create_dir(path).expect("create unreadable toggle path");
        }));
    }

    #[test]
    fn explicit_boolean_toggle_round_trips_through_real_reader() {
        assert!(read_toggle_from(|path| {
            std::fs::write(path, r#"{"crashReportsEnabled":true}"#).expect("write enabled toggle");
        }));
        assert!(!read_toggle_from(|path| {
            std::fs::write(path, r#"{"crashReportsEnabled":false}"#)
                .expect("write disabled toggle");
        }));
    }

    #[test]
    fn collapses_macos_home_username_keeps_path() {
        assert_eq!(
            scrub_paths("/Users/example/o8/src/x.rs"),
            "/Users/…/o8/src/x.rs"
        );
    }

    #[test]
    fn collapses_linux_home() {
        assert_eq!(
            scrub_paths("panicked at /home/deploy/app/main.rs:12"),
            "panicked at /home/…/app/main.rs:12"
        );
    }

    #[test]
    fn scrubs_multiple_occurrences() {
        assert_eq!(
            scrub_paths("/Users/quise/a.rs and /Users/quise/b.rs"),
            "/Users/…/a.rs and /Users/…/b.rs"
        );
    }

    #[test]
    fn username_at_end_of_string() {
        assert_eq!(scrub_paths("home is /Users/quise"), "home is /Users/…");
    }

    #[test]
    fn leaves_non_home_paths_untouched() {
        assert_eq!(scrub_paths("/var/log/o8.log"), "/var/log/o8.log");
    }
}
