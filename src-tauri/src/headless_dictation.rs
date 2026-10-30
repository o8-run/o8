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
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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
            let state = crate::agent::o8_http::get_json_timeout("/api/next/voice-host", 2).await;
            if token.load(Ordering::SeqCst) {
                return;
            }
            if !check_lease(session, &binding, state.as_ref().ok()) {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
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
