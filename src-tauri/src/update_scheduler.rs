//! Native schedule and server handoff. No webview, React mount, or JS timer is needed.
#[path = "update_auto_apply.rs"]
pub(crate) mod auto_apply;
#[path = "update_schedule.rs"]
mod schedule;
use schedule::UpdateSchedule;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};

static WOKE: AtomicBool = AtomicBool::new(false);

pub fn observe_wake() {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
        use objc2_foundation::NSNotification;
        let block = block2::RcBlock::new(|_: std::ptr::NonNull<NSNotification>| {
            WOKE.store(true, Ordering::Release);
        });
        let observer = NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            );
        // The scheduler and this one observer live for the entire application process.
        std::mem::forget(observer);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub async fn run<R: Runtime>(app: AppHandle<R>) {
    loop {
        let owned = app.clone();
        let result = tauri::async_runtime::spawn(async move {
            run_with_effects(
                owned,
                |app, client, base, token| auto_apply::NativeEffects {
                    app,
                    client,
                    base,
                    token,
                },
                Duration::from_secs(60),
            )
            .await;
        })
        .await;
        log::warn!("[updater] scheduler stopped: {result:?}; restarting task");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub(crate) async fn run_with_effects<R: Runtime, E: auto_apply::Effects>(
    app: AppHandle<R>,
    factory: impl Fn(AppHandle<R>, reqwest::Client, String, String) -> E + Send,
    auto_interval: Duration,
) {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::error!("[updater] state transport unavailable: {error}");
            return;
        }
    };
    let mut schedule = UpdateSchedule::default();
    let mut report: Option<serde_json::Value> = None;
    let mut served_request = String::new();
    let mut served_apply = String::new();
    let mut auto_apply = auto_apply::AutoApply::new(auto_interval);
    loop {
        // Only the deliberate sleep contributes to gap detection, not awaited I/O.
        let signaled = WOKE.swap(false, Ordering::AcqRel);
        let woke = schedule.due(now_ms(), false) || (signaled && schedule.wake(now_ms()));
        // Boot starts before port allocation. Never fall back to another running server.
        let url = std::env::var("O8_API_PORT")
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .map(|port| format!("http://127.0.0.1:{port}/api/panel/app/update-state"));
        let token = crate::resolve_ws_token();
        let control = if let Some(url) = &url {
            match client.get(url).bearer_auth(&token).send().await {
                Ok(response) if response.status().is_success() => {
                    response.json::<serde_json::Value>().await.ok()
                }
                _ => None,
            }
        } else {
            None
        };
        let request = control
            .as_ref()
            .and_then(|v| v["checkRequestedAt"].as_str())
            .unwrap_or_default();
        if woke || (!request.is_empty() && request != served_request) {
            let result = super::run_check(&app).await;
            report = (!result.is_null()).then_some(result);
            served_request = request.to_string();
            // Checking the network can itself take seconds. That is not a sleep/wake gap.
            schedule.completed(now_ms());
        }
        if let (Some(url), Some(report)) = (&url, &report) {
            let recorded = control.as_ref().map(|v| &v["state"]["check"]);
            let already_recorded = recorded.is_some_and(|check| {
                if check["checkSession"] == report["checkSession"] {
                    check["checkSequence"].as_u64() >= report["checkSequence"].as_u64()
                } else {
                    check["checkedAt"].as_str() >= report["checkedAt"].as_str()
                }
            });
            if crate::update_ping::is_current_report(&app, report) && !already_recorded {
                // Retry the retained report after startup or server replacement, even without UI.
                let _ = client
                    .post(url)
                    .bearer_auth(&token)
                    .json(report)
                    .send()
                    .await;
            }
        }
        // An Update click with o8 next as the window: try the install now, not
        // at the next automatic interval.
        let apply = control
            .as_ref()
            .and_then(|v| v["applyRequestedAt"].as_str())
            .unwrap_or_default();
        if !apply.is_empty() && apply != served_apply {
            auto_apply.expedite();
            served_apply = apply.to_string();
        }
        if let Some(url) = &url {
            let effects = factory(
                app.clone(),
                client.clone(),
                url.trim_end_matches("/api/panel/app/update-state").into(),
                token.clone(),
            );
            auto_apply.tick(&client, url, &token, &effects).await;
        }
        schedule.awake(now_ms());
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
