//! Lifetime of composer STT. Fn and native teardown never depend on a webview timer.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Binding {
    host_id: String,
    request_id: String,
    binding: String,
    nonce: String,
    thread_id: String,
    repo_path: String,
}

impl Binding {
    pub(crate) fn valid(&self) -> bool {
        [
            &self.host_id,
            &self.request_id,
            &self.binding,
            &self.nonce,
            &self.thread_id,
            &self.repo_path,
        ]
        .iter()
        .all(|value| !value.is_empty() && value.len() <= 512)
    }

    fn current(&self, state: &serde_json::Value) -> bool {
        if state["available"] != true || state["hostId"] != self.host_id {
            return false;
        }
        let dictation = &state["dictation"];
        let identity = serde_json::to_value(self).unwrap_or_default();
        for key in ["requestId", "binding", "nonce", "threadId", "repoPath"] {
            if dictation[key] != identity[key] {
                return false;
            }
        }
        match dictation["state"].as_str() {
            Some("starting" | "listening") => true,
            Some("stopping") => dictation["submit"] == true,
            _ => false,
        }
    }
}

#[derive(Default)]
struct Sessions {
    active: HashMap<u64, Arc<AtomicBool>>,
    discarded: VecDeque<u64>,
}
fn sessions() -> &'static Mutex<Sessions> {
    static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(Sessions::default()))
}

pub(crate) fn register(session: u64) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "Dictation lifetime unavailable.")?
        .active
        .insert(session, Arc::new(AtomicBool::new(false)));
    Ok(())
}

pub(crate) fn token(session: u64) -> Option<Arc<AtomicBool>> {
    sessions().lock().ok()?.active.get(&session).cloned()
}

pub(crate) fn cancelled(session: u64) -> bool {
    sessions()
        .lock()
        .map(|sessions| {
            sessions.discarded.contains(&session)
                || sessions
                    .active
                    .get(&session)
                    .is_some_and(|value| value.load(Ordering::SeqCst))
        })
        .unwrap_or(false)
}

pub(crate) fn cancel(session: u64) -> bool {
    let Ok(mut sessions) = sessions().lock() else {
        return true;
    };
    !sessions
        .active
        .entry(session)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .swap(true, Ordering::SeqCst)
}

pub(crate) fn finish(session: u64) {
    if let Ok(mut sessions) = sessions().lock() {
        if sessions.active.remove(&session).is_some() {
            // Late helper errors/frames from a finished capture cannot clear
            // the global origin/mode of Fn's replacement session.
            sessions.discarded.push_back(session);
            while sessions.discarded.len() > 128 {
                sessions.discarded.pop_front();
            }
        }
    }
}

pub(crate) fn check_lease(
    session: u64,
    binding: &Binding,
    state: Option<&serde_json::Value>,
) -> bool {
    if state.is_some_and(|state| binding.current(state)) {
        return true;
    }
    crate::stt_engine::cancel_headless(session, "Voice host unavailable or binding retired.");
    false
}

#[derive(Default)]
struct LeaseChecks {
    transport_failures: u8,
}

impl LeaseChecks {
    fn check(
        &mut self,
        session: u64,
        binding: &Binding,
        state: Result<&serde_json::Value, &String>,
    ) -> bool {
        match state {
            Ok(state) => {
                self.transport_failures = 0;
                check_lease(session, binding, Some(state))
            }
            Err(_) => {
                self.transport_failures = self.transport_failures.saturating_add(1);
                self.transport_failures < 3 || check_lease(session, binding, None)
            }
        }
    }
}

async fn read_lease_response(response: reqwest::Response) -> Result<serde_json::Value, String> {
    // A missing host is authoritative even if its response body is absent or
    // unreadable. Only transport/body failures receive the retry grace.
    if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Ok(serde_json::json!({"available": false}));
    }
    response.json().await.map_err(|error| error.to_string())
}

// Symon's loopback client is macOS-only on the rail branch. Never strand a
// claim if another platform invokes the headless-only command directly.
#[cfg(target_os = "linux")]
pub(crate) fn watch(session: u64, _binding: Binding) {
    crate::stt_engine::cancel_headless(
        session,
        "Composer dictation host is unavailable on this platform.",
    );
}

#[cfg(target_os = "macos")]
pub(crate) fn watch(session: u64, binding: Binding) {
    let Some(token) = token(session) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut checks = LeaseChecks::default();
        // A slow two-second probe consumes the interval rather than adding
        // another second of sleep to every failed attempt.
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if token.load(Ordering::SeqCst) {
                return;
            }
            if !crate::stt_engine::is_headless_session(session) {
                // A missing/poisoned routing registry must not strand a known
                // headless claim. Cancellation is still fenced by its token.
                crate::stt_engine::cancel_headless(session, "Dictation routing unavailable.");
                return;
            }
            // The existing shell client owns token and port resolution. Never
            // hold a recognizer or ownership lock across the HTTP request.
            let state = match crate::agent::o8_http::get_response_timeout("/api/next/voice-host", 2)
                .await
            {
                Ok(response) => read_lease_response(response).await,
                Err(error) => Err(error),
            };
            if token.load(Ordering::SeqCst) {
                return;
            }
            if !checks.check(session, &binding, state.as_ref()) {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_lease() -> (Binding, serde_json::Value) {
        let binding: Binding = serde_json::from_value(serde_json::json!({
            "hostId":"host", "requestId":"start", "binding":"composer",
            "nonce":"nonce", "threadId":"chat", "repoPath":"/repo"
        }))
        .unwrap();
        let state = serde_json::json!({"available":true, "hostId":"host", "dictation": {
            "requestId":"start", "binding":"composer", "nonce":"nonce",
            "threadId":"chat", "repoPath":"/repo", "state":"listening"
        }});
        (binding, state)
    }

    #[test]
    fn two_transient_failures_then_good_lease_keep_session_and_reset_budget() {
        let _claims = crate::voice_input::TEST_CLAIMS.lock().unwrap();
        let sid = 9_000_021;
        register(sid).unwrap();
        let (binding, state) = live_lease();
        let mut checks = LeaseChecks::default();
        for _ in 0..2 {
            for error in ["timed out", "connection refused"] {
                assert!(checks.check(sid, &binding, Err(&error.to_string())));
                assert!(!cancelled(sid));
            }
            assert!(checks.check(sid, &binding, Ok(&state)));
            assert!(!cancelled(sid));
        }
        finish(sid);
    }

    #[test]
    fn three_consecutive_transient_failures_cancel_session() {
        let _claims = crate::voice_input::TEST_CLAIMS.lock().unwrap();
        let sid = 9_000_022;
        register(sid).unwrap();
        let (binding, _) = live_lease();
        let mut checks = LeaseChecks::default();
        for error in ["timed out", "connection refused"] {
            assert!(checks.check(sid, &binding, Err(&error.to_string())));
            assert!(!cancelled(sid));
        }
        assert!(!checks.check(sid, &binding, Err(&"bad JSON".to_string())));
        assert!(cancelled(sid));
        finish(sid);
    }

    #[test]
    fn one_explicit_lease_mismatch_cancels_without_transport_grace() {
        let _claims = crate::voice_input::TEST_CLAIMS.lock().unwrap();
        let (binding, state) = live_lease();
        let mut mismatches = Vec::new();
        let mut unavailable = state.clone();
        unavailable["available"] = false.into();
        mismatches.push(unavailable);
        let mut replaced = state.clone();
        replaced["hostId"] = "replacement".into();
        mismatches.push(replaced);
        for key in ["requestId", "binding", "nonce", "threadId", "repoPath"] {
            let mut replaced = state.clone();
            replaced["dictation"][key] = "replacement".into();
            mismatches.push(replaced);
        }
        for status in ["idle", "error", "stopping"] {
            let mut ended = state.clone();
            ended["dictation"]["state"] = status.into();
            mismatches.push(ended);
        }
        for (index, mismatch) in mismatches.iter().enumerate() {
            let sid = 9_000_030 + index as u64;
            register(sid).unwrap();
            assert!(!LeaseChecks::default().check(sid, &binding, Ok(mismatch)));
            assert!(cancelled(sid));
            finish(sid);
        }
    }

    #[test]
    fn http_503_is_authoritative_even_without_json_but_bad_json_is_transient() {
        use std::io::{Read, Write};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            for (status, body, authoritative) in [
                (503, "", true),
                (503, "unavailable", true),
                (503, r#"{"code":"VOICE_HOST_UNAVAILABLE"}"#, true),
                (200, "not JSON", false),
            ] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                let server = std::thread::spawn(move || {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
                    let _ = stream.read(&mut [0; 4096]).unwrap();
                    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                });
                let response = reqwest::Client::new()
                    .get(format!("http://{address}/api/next/voice-host"))
                    .timeout(std::time::Duration::from_secs(2))
                    .send().await.unwrap();
                let result = read_lease_response(response).await;
                assert_eq!(result.is_ok(), authoritative);
                if authoritative {
                    assert_eq!(result.unwrap()["available"], false);
                }
                server.join().unwrap();
            }
        });
    }

    #[test]
    fn cancelled_finalization_and_late_helper_frames_remain_discarded_after_complete() {
        let sid = 9_000_015;
        register(sid).unwrap();
        let finalizer = token(sid).unwrap();
        assert!(cancel(sid));
        finish(sid);
        assert!(finalizer.load(Ordering::SeqCst));
        assert!(cancelled(sid));
        assert!(token(sid).is_none());
        assert!(!cancelled(sid + 1));
    }
    #[test]
    fn lease_requires_the_same_host_start_and_binding_and_a_live_state() {
        let binding: Binding =
            serde_json::from_value(serde_json::json!({"hostId":"host", "requestId":"start",
            "binding":"composer", "nonce":"nonce", "threadId":"chat", "repoPath":"/repo"}))
            .unwrap();
        let mut state = serde_json::json!({"available":true, "hostId":"host", "dictation": {
            "requestId":"start", "binding":"composer", "nonce":"nonce", "threadId":"chat", "repoPath":"/repo", "state":"listening"}});
        assert!(binding.current(&state));
        for key in ["requestId", "binding", "nonce", "threadId", "repoPath"] {
            let mut stale = state.clone();
            stale["dictation"][key] = "replacement".into();
            assert!(!binding.current(&stale), "{key}");
        }
        state["available"] = false.into();
        assert!(!binding.current(&state));
        state["available"] = true.into();
        state["hostId"] = "new-host".into();
        assert!(!binding.current(&state));
        state["hostId"] = "host".into();
        for status in ["idle", "error", "stopping"] {
            state["dictation"]["state"] = status.into();
            assert!(!binding.current(&state));
        }
        state["dictation"]["submit"] = true.into();
        assert!(binding.current(&state));
    }
}
