//! Real bound selection and process launch with an isolated executable.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    root: std::path::PathBuf,
    binary: String,
    prior: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new(reject: bool) -> Self {
        let guard = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root = std::env::temp_dir().join(format!(
            "o8-phone-effort-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("planner-fixture");
        let capture = root
            .join("argv.txt")
            .to_string_lossy()
            .replace('\'', "'\\''");
        let result = if reject {
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"The selected model does not support effort xhigh; use low, medium, or high."}"#
        } else {
            r#"{"type":"result","subtype":"success","result":"{\"done\":true,\"say\":\"Fixture answer\"}"}"#
        };
        std::fs::write(&binary, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{capture}'\nwhile IFS= read -r line; do printf '%s\\n' '{result}'; done\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prior = ["O8_DATA_DIR", "O8_CLAUDE_CODE_BIN"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        std::env::set_var("O8_DATA_DIR", &root);
        std::env::set_var("O8_CLAUDE_CODE_BIN", &binary);
        Self {
            root,
            binary: binary.to_string_lossy().into_owned(),
            prior,
            _guard: guard,
        }
    }

    fn args(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join("argv.txt"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.prior {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn phone_bound_pins_reach_actual_worker_arguments() {
    let fixture = Fixture::new(false);
    let adapter = planner_route::PLANNER_ADAPTERS
        .iter()
        .find(|adapter| adapter.transport == planner_route::PlannerTransport::ClaudeStreamJson)
        .unwrap();
    for model in adapter.pinnable_models {
        for effort in ["low", "medium", "high", "xhigh"] {
            let planner_route::PlannerRouting::Selected(seat) =
                planner_route::resolve_bound(adapter.id, model, effort)
            else {
                panic!("Fixture selection must be available");
            };
            assert_eq!(seat.effort, effort);
            let result = claude::run_phone_text_loop_with_binary(
                &seat.binary,
                seat.model_label(),
                seat.effort,
                "Fixture question",
                &TaskCtx::default(),
                ConfirmCorrelation,
            )
            .await
            .unwrap();
            assert_eq!(result.result_text, "Fixture answer");
            let args = fixture.args();
            assert_eq!(
                args[args.iter().position(|arg| arg == "--effort").unwrap() + 1],
                effort
            );
            assert_eq!(
                args[args.iter().position(|arg| arg == "--model").unwrap() + 1],
                seat.model_label()
            );
        }
    }
}

#[tokio::test]
async fn unsupported_bound_effort_returns_the_worker_reason() {
    let fixture = Fixture::new(true);
    let reason = claude::run_phone_text_loop_with_binary(
        &fixture.binary,
        models::CLAUDE_SONNET_5,
        "xhigh",
        "Fixture question",
        &TaskCtx::default(),
        ConfirmCorrelation,
    )
    .await
    .err()
    .unwrap();
    assert!(
        reason.contains("does not support effort xhigh; use low, medium, or high."),
        "{reason}"
    );
}

#[test]
fn legacy_session_keeps_the_model_default_flags() {
    let fixture = Fixture::new(false);
    for model in [models::CLAUDE_SONNET_5, models::CLAUDE_OPUS_5] {
        let mut session = claude::ClaudeSession::spawn(&fixture.binary, model, "{}").unwrap();
        session.send_turn("Fixture question", None).unwrap();
        let args = fixture.args();
        assert_eq!(
            args.iter()
                .position(|arg| arg == "--effort")
                .map(|index| args[index + 1].as_str()),
            planner_route::claude_effort_flag(model)
        );
    }
}

#[tokio::test]
async fn unsupported_bound_effort_on_stderr_returns_the_worker_reason() {
    let fixture = Fixture::new(false);
    std::fs::write(&fixture.binary, "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' 'The selected model does not support effort xhigh; use low, medium, or high.' >&2; exit 2; done\n").unwrap();
    let reason = claude::run_phone_text_loop_with_binary(
        &fixture.binary,
        models::CLAUDE_SONNET_5,
        "xhigh",
        "Fixture question",
        &TaskCtx::default(),
        ConfirmCorrelation,
    )
    .await
    .err()
    .unwrap();
    assert!(
        reason.contains("does not support effort xhigh; use low, medium, or high."),
        "{reason}"
    );
}
