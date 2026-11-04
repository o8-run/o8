//! GTK is linked exclusively into the visualization helper binary.
use super::{
    linux_protocol::{Navigation, Request, Response, TIMEOUT, TIMEOUT_ERROR, parse},
    protocol::{Message, UNAVAILABLE},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use gtk::{glib, prelude::*};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};
use webkit2gtk::{SettingsExt as WebKitSettingsExt, *};

const WORLD: &str = "o8-visualization";

#[derive(Default)]
struct Events {
    height: Option<f64>,
    state: Option<Value>,
    changed: Option<Instant>,
    loaded: bool,
    failed: bool,
    sent: bool,
    applied: bool,
    capturing: bool,
    result: Option<Result<Response, String>>,
}
fn send(web: &WebView, request: &Request, events: Rc<RefCell<Events>>) {
    let theme =
        json!({"type":"o8-visualization:theme", "nonce":request.nonce, "theme":request.theme});
    let state =
        json!({"type":"o8-visualization:state", "nonce":request.nonce, "value":request.state});
    let script = format!(
        "for (const data of [{theme},{state}]) dispatchEvent(new MessageEvent('message', {{source:window,data}}));"
    );
    web.evaluate_javascript(
        &script,
        None,
        None,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let mut events = events.borrow_mut();
            events.failed |= result.is_err();
            events.applied = result.is_ok();
            events.changed = Some(Instant::now());
        },
    );
}

pub fn snapshot(request: Request) -> Result<Response, String> {
    gtk::init().map_err(|_| "The visualization renderer needs a display.")?;
    let context = WebContext::new_ephemeral();
    // This must happen before constructing the view or creating a web process.
    context.set_sandbox_enabled(true);
    if !context.is_sandbox_enabled() || !WebContextExt::is_ephemeral(&context) {
        return Err(UNAVAILABLE.into());
    }
    context.connect_download_started(|_, download| download.cancel());
    let manager = UserContentManager::new();
    if !manager.register_script_message_handler_in_world("o8Visualization", WORLD) {
        return Err(UNAVAILABLE.into());
    }
    // The handler exists only in this isolated world. Only the trusted top
    // frame gets a relay; opaque content frames cannot call it directly.
    manager.add_script(&UserScript::for_world(
        &format!(r#"(() => {{
          if (window !== top) {{
            if (location.href === 'about:srcdoc')
              window.webkit.messageHandlers.o8Visualization.postMessage('o8:sealed-document-start');
            return;
          }}
          addEventListener('o8:native-visualization-message', event => {{
            const data = event.detail;
            if (data?.nonce !== {}) return;
            if (!['o8-visualization:height','o8-visualization:state'].includes(data.type)) return;
            const input = JSON.stringify(data);
            if (input.length <= 24576) window.webkit.messageHandlers.o8Visualization.postMessage(input);
          }});
        }})();"#, json!(request.nonce)),
        UserContentInjectedFrames::AllFrames, UserScriptInjectionTime::Start, WORLD, &[], &[],
    ));
    let events = Rc::new(RefCell::new(Events::default()));
    let navigation = Rc::new(RefCell::new(Navigation::new()));
    let received = events.clone();
    let policy = navigation.clone();
    let nonce = request.nonce.clone();
    manager.connect_script_message_received(Some("o8Visualization"), move |_, result| {
        let Some(value) = result.js_value() else {
            return;
        };
        let input = value.to_string();
        // GTK has no source-frame API on navigation actions. Revoke unused
        // bootstrap permits from the isolated world's document-start script,
        // before any author script in the opaque document can run.
        if input == "o8:sealed-document-start" {
            policy.borrow_mut().close();
            return;
        }
        let Some(message) = parse(&input, &nonce) else {
            return;
        };
        let mut events = received.borrow_mut();
        match message {
            Message::Height(height) => {
                if events.height != Some(height) {
                    events.height = Some(height);
                    events.changed = Some(Instant::now());
                }
                policy.borrow_mut().close();
            }
            Message::State(state) => {
                if events.state.as_ref() != Some(&state) {
                    events.state = Some(state);
                    events.changed = Some(Instant::now());
                }
            }
        }
    });
    let web = WebView::builder()
        .web_context(&context)
        .user_content_manager(&manager)
        .build();
    let settings = WebViewExt::settings(&web).ok_or(UNAVAILABLE)?;
    settings.set_javascript_can_open_windows_automatically(false);
    settings.set_javascript_can_access_clipboard(false);
    settings.set_allow_file_access_from_file_urls(false);
    settings.set_allow_universal_access_from_file_urls(false);
    settings.set_allow_top_navigation_to_data_urls(false);
    settings.set_allow_modal_dialogs(false);
    settings.set_enable_html5_local_storage(false);
    settings.set_enable_html5_database(false);
    settings.set_enable_offline_web_application_cache(false);
    settings.set_enable_page_cache(false);
    settings.set_enable_dns_prefetching(false);
    settings.set_enable_hyperlink_auditing(false);
    settings.set_enable_webrtc(false);
    settings.set_enable_media_stream(false);
    settings.set_enable_write_console_messages_to_stdout(false);
    settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
    web.set_background_color(&gtk::gdk::RGBA::new(0., 0., 0., 0.));
    web.connect_decide_policy(move |_, decision, kind| {
        let allowed = match kind {
            PolicyDecisionType::NavigationAction => decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|decision| decision.navigation_action())
                .is_some_and(|mut action| {
                    let uri = action.request().and_then(|r| r.uri()).unwrap_or_default();
                    navigation.borrow_mut().allow(
                        &uri,
                        action.navigation_type() == NavigationType::Other,
                        action.is_redirect(),
                    )
                }),
            PolicyDecisionType::Response => decision
                .downcast_ref::<ResponsePolicyDecision>()
                .and_then(|decision| decision.request())
                .and_then(|r| r.uri())
                .is_some_and(|uri| {
                    matches!(uri.as_str(), "about:blank" | "about:srcdoc")
                        || uri.starts_with("data:")
                        || uri.starts_with("blob:")
                }),
            _ => false,
        };
        if allowed {
            decision.use_();
        } else {
            decision.ignore();
        }
        true
    });
    web.connect_create(|_, _| None);
    web.connect_permission_request(|_, permission| {
        permission.deny();
        true
    });
    web.connect_script_dialog(|_, dialog| {
        dialog.close();
        true
    });
    let finished = events.clone();
    web.connect_load_changed(move |_, load| {
        if load == LoadEvent::Finished {
            finished.borrow_mut().loaded = true;
        }
    });
    let failed = events.clone();
    web.connect_load_failed(move |_, _, _, error| {
        if !error.matches(NetworkError::Cancelled)
            && !error.matches(PolicyError::FrameLoadInterruptedByPolicyChange)
        {
            failed.borrow_mut().failed = true;
        }
        true
    });
    let failed = events.clone();
    web.connect_web_process_terminated(move |_, _| failed.borrow_mut().failed = true);
    let window = gtk::OffscreenWindow::new();
    let mut height = request.height.ceil() as i32;
    web.set_size_request(request.width as i32, height);
    window.set_default_size(request.width as i32, height);
    window.add(&web);
    window.show_all();
    web.load_html(&request.document, None);
    let started = Instant::now();
    let main = glib::MainContext::default();
    let result = loop {
        // Bounded pumping prevents an event flood from starving our deadline.
        for _ in 0..32 {
            if !main.pending() {
                break;
            }
            main.iteration(false);
        }
        let mut event = events.borrow_mut();
        if let Some(result) = event.result.take() {
            break result;
        }
        if event.failed {
            break Err(UNAVAILABLE.into());
        }
        if started.elapsed() >= TIMEOUT {
            break Err(TIMEOUT_ERROR.into());
        }
        if let Some(reported) = event.height {
            if height != reported as i32 {
                height = reported as i32;
                web.set_size_request(request.width as i32, height);
                // OffscreenWindow ignores resize() for a smaller allocation
                // unless its default size changes as well.
                window.set_default_size(request.width as i32, height);
                window.resize(request.width as i32, height);
                event.changed = Some(Instant::now());
            }
            if !event.sent {
                event.sent = true;
                drop(event);
                send(&web, &request, events.clone());
                continue;
            }
            if event.loaded
                && event.applied
                && !event.capturing
                && event
                    .changed
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(200))
            {
                event.capturing = true;
                let captured = events.clone();
                let changed = event.changed;
                drop(event);
                web.snapshot(
                    SnapshotRegion::FullDocument,
                    SnapshotOptions::TRANSPARENT_BACKGROUND,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |surface| {
                        let result =
                            surface
                                .map_err(|_| UNAVAILABLE.to_string())
                                .and_then(|surface| {
                                    let mut png = Vec::new();
                                    surface.write_to_png(&mut png).map_err(|_| UNAVAILABLE)?;
                                    let events = captured.borrow();
                                    Ok(Response {
                                        height: reported,
                                        state: events.state.clone(),
                                        png: STANDARD.encode(png),
                                    })
                                });
                        let mut events = captured.borrow_mut();
                        events.capturing = false;
                        if events.changed == changed {
                            events.result = Some(result);
                        }
                    },
                );
                continue;
            }
        }
        drop(event);
        std::thread::sleep(Duration::from_millis(5));
    };
    web.stop_loading();
    unsafe {
        window.destroy();
    }
    result
}
