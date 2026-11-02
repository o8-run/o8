//! Private fixture-runner executable. Exercises the production WebKit host on its main thread.
#[cfg(target_os = "macos")]
#[path = "../src/visualizations/macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
#[path = "../src/visualizations/protocol.rs"]
mod protocol;
#[cfg(target_os = "macos")]
fn main() {
    use cocoa::{
        appkit::{
            NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
            NSWindowStyleMask,
        },
        base::{NO, id, nil},
        foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize},
    };
    use objc::{class, msg_send, sel, sel_impl};
    use protocol::Message;
    use serde_json::json;
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 4, "HTML, nonce, probe origin, output");
    let html = std::fs::read_to_string(&args[0]).unwrap();
    unsafe {
        let _pool = NSAutoreleasePool::new(nil);
        let app = NSApplication::sharedApplication(nil);
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
        );
        let window = NSWindow::alloc(nil).initWithContentRect_styleMask_backing_defer_(
            NSRect::new(NSPoint::new(-10000., -10000.), NSSize::new(800., 500.)),
            NSWindowStyleMask::NSBorderlessWindowMask,
            NSBackingStoreType::NSBackingStoreBuffered,
            NO,
        );
        let parent: id = msg_send![window, contentView];
        let host = macos::Host::in_view(&html, &args[1], parent).expect("native host");
        let runloop: id = msg_send![class!(NSRunLoop), currentRunLoop];
        let started = std::time::Instant::now();
        let mut phase = 0;
        let mut dark = false;
        let mut light = false;
        let mut proof = None;
        let mut height = None;
        while started.elapsed().as_secs() < 12 {
            let until: id = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow:0.01f64];
            let _: () = msg_send![runloop, runUntilDate:until];
            let messages: Vec<_> = host.events.borrow_mut().messages.drain(..).collect();
            for event in messages {
                match event {
                    Message::Height(value) => {
                        height = Some(value);
                    }
                    Message::State(value) => {
                        if value["restored"] == "Week 2" && value["theme"] == "dark" {
                            dark = true;
                        }
                        if value["restored"] == "Week 2" && value["theme"] == "light" {
                            light = true;
                        }
                        if value["proof"].is_object() {
                            proof = Some(value["proof"].clone());
                        }
                    }
                }
            }
            if phase == 0 && height.is_some() && host.events.borrow().finished {
                host.send(
                    "theme",
                    "theme",
                    &json!({"colorScheme":"dark","variables":{}}),
                );
                host.send("state", "value", &json!({"saved":"Week 2"}));
                phase = 1;
            }
            if phase == 1 && dark {
                host.send(
                    "theme",
                    "theme",
                    &json!({"colorScheme":"light","variables":{}}),
                );
                host.send("state", "value", &json!({"saved":"Week 2"}));
                phase = 2;
            }
            if phase == 2 && light {
                host.send("state", "value", &json!({"probeOrigin":args[2]}));
                host.evaluate(
                    &format!(
                        "location.href={}; window.open({});",
                        json!(format!("{}/sandbox-top", args[2])),
                        json!(format!("{}/sandbox-window", args[2]))
                    ),
                    None,
                );
                phase = 3;
            }
            if proof.is_some() {
                break;
            }
        }
        let result = json!({"height":height,"dark":dark,"light":light,"proof":proof,"denied":host.events.borrow().denied,"failed":host.events.borrow().failed});
        std::fs::write(&args[3], result.to_string()).unwrap();
        drop(host);
        let _: () = msg_send![window, close];
        assert!(dark && light && proof.is_some(), "{result}");
        for key in ["network", "popup", "bridge", "parent", "rtc"] {
            assert_eq!(proof.as_ref().unwrap()[key], true, "{key}: {result}");
        }
        assert_eq!(proof.unwrap()["referrer"], "");
        assert!(result["denied"].as_u64().unwrap() >= 1, "{result}");
    }
}
#[cfg(not(target_os = "macos"))]
fn main() {}
