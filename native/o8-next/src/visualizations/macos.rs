#![allow(unexpected_cfgs)]
//! A full-size document inside an independent native clip. No app origin or credentials.
use super::protocol::{Message, message};
use cocoa::{
    appkit::NSView,
    base::{BOOL, NO, YES, id, nil},
    foundation::{NSPoint, NSRect, NSSize, NSString},
};
use objc::{
    class,
    declare::ClassDecl,
    msg_send,
    runtime::{Class, Object, Sel},
    sel, sel_impl,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::{Value, json};
use std::{cell::RefCell, ffi::CStr, rc::Rc, sync::OnceLock};

#[derive(Default)]
pub struct Events {
    pub messages: Vec<Message>,
    pub finished: bool,
    pub failed: bool,
    pub denied: usize,
}
struct Context {
    nonce: String,
    events: Rc<RefCell<Events>>,
    initial: bool,
    blank: bool,
    inner: bool,
    wake: Option<Rc<dyn Fn()>>,
}
unsafe fn context(this: &Object) -> &mut Context {
    unsafe { &mut *(*this.get_ivar::<usize>("o8Context") as *mut Context) }
}
fn clip_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        extern "C" fn flipped(_: &Object, _: Sel) -> BOOL {
            YES
        }
        extern "C" fn scroll(this: &Object, _: Sel, event: id) {
            unsafe {
                let parent: id = msg_send![this, superview];
                let _: () = msg_send![parent, scrollWheel:event];
            }
        }
        let mut decl = ClassDecl::new("O8VisualizationClip", class!(NSView)).unwrap();
        unsafe {
            decl.add_method(
                sel!(isFlipped),
                flipped as extern "C" fn(&Object, Sel) -> BOOL,
            );
            decl.add_method(
                sel!(scrollWheel:),
                scroll as extern "C" fn(&Object, Sel, id),
            );
        }
        decl.register()
    })
}
fn delegate_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut decl = ClassDecl::new("O8VisualizationDelegate", class!(NSObject)).unwrap();
        decl.add_ivar::<usize>("o8Context");
        unsafe {
            decl.add_method(
                sel!(userContentController:didReceiveScriptMessage:),
                receive as extern "C" fn(&Object, Sel, id, id),
            );
            decl.add_method(
                sel!(webView:decidePolicyForNavigationAction:decisionHandler:),
                navigate as extern "C" fn(&Object, Sel, id, id, id),
            );
            decl.add_method(
                sel!(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:),
                new_window as extern "C" fn(&Object, Sel, id, id, id, id) -> id,
            );
            decl.add_method(
                sel!(_webView:didNotHandleWheelEvent:),
                unhandled_wheel as extern "C" fn(&Object, Sel, id, id),
            );
            decl.add_method(
                sel!(webView:didFinishNavigation:),
                finish as extern "C" fn(&Object, Sel, id, id),
            );
            decl.add_method(
                sel!(webView:didFailProvisionalNavigation:withError:),
                fail as extern "C" fn(&Object, Sel, id, id, id),
            );
            decl.add_method(
                sel!(webView:didFailNavigation:withError:),
                fail as extern "C" fn(&Object, Sel, id, id, id),
            );
            decl.add_method(
                sel!(webViewWebContentProcessDidTerminate:),
                terminate as extern "C" fn(&Object, Sel, id),
            );
            decl.add_method(sel!(dealloc), dealloc as extern "C" fn(&mut Object, Sel));
        }
        decl.register()
    })
}
extern "C" fn receive(this: &Object, _: Sel, _: id, input: id) {
    unsafe {
        let frame: id = msg_send![input, frameInfo];
        let main: BOOL = msg_send![frame, isMainFrame];
        if main != YES {
            return;
        }
        let body: id = msg_send![input, body];
        let string: BOOL = msg_send![body, isKindOfClass:class!(NSString)];
        if string != YES {
            return;
        }
        let length: usize = msg_send![body, lengthOfBytesUsingEncoding:4usize];
        if length > 24 * 1024 {
            return;
        }
        let raw: *const std::ffi::c_char = msg_send![body, UTF8String];
        if raw.is_null() {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(CStr::from_ptr(raw).to_bytes()) else {
            return;
        };
        let state = context(this);
        if let Some(event) = message(&value, &state.nonce) {
            let mut events = state.events.borrow_mut();
            if events.messages.len() < 128 {
                events.messages.push(event);
            }
            drop(events);
            if let Some(wake) = &state.wake {
                wake();
            }
        }
    }
}
extern "C" fn navigate(this: &Object, _: Sel, _: id, action: id, decision: id) {
    unsafe {
        let state = context(this);
        let target: id = msg_send![action, targetFrame];
        let main: BOOL = if target == nil {
            NO
        } else {
            msg_send![target, isMainFrame]
        };
        let source: id = msg_send![action, sourceFrame];
        let source_main: BOOL = msg_send![source, isMainFrame];
        let request: id = msg_send![action, request];
        let url: id = msg_send![request, URL];
        let absolute: id = msg_send![url, absoluteString];
        let raw: *const std::ffi::c_char = msg_send![absolute, UTF8String];
        let url = if raw.is_null() {
            ""
        } else {
            CStr::from_ptr(raw).to_str().unwrap_or("")
        };
        let navigation_type: i64 = msg_send![action, navigationType];
        // Single-use permits belong only to the sealed initial load: the outer
        // page, the inert iframe bootstrap, and its opaque srcdoc.
        let allowed =
            if state.initial && main == YES && url == "about:blank" && navigation_type == -1 {
                state.initial = false;
                true
            } else if state.blank
                && state.inner
                && target != nil
                && main == NO
                && source_main == YES
                && url == "about:blank"
                && navigation_type == -1
            {
                state.blank = false;
                true
            } else if state.inner
                && target != nil
                && main == NO
                && source_main == YES
                && url == "about:srcdoc"
                && navigation_type == -1
            {
                state.inner = false;
                state.blank = false;
                true
            } else {
                false
            };
        if !allowed {
            state.events.borrow_mut().denied += 1;
        }
        (&*(decision as *const block::Block<(i64,), ()>)).call((if allowed { 1 } else { 0 },));
    }
}
extern "C" fn new_window(this: &Object, _: Sel, _: id, _: id, _: id, _: id) -> id {
    unsafe {
        context(this).events.borrow_mut().denied += 1;
    }
    nil
}
extern "C" fn unhandled_wheel(_: &Object, _: Sel, web: id, event: id) {
    unsafe {
        let clip: id = msg_send![web, superview];
        if clip == nil {
            return;
        }
        let hidden: BOOL = msg_send![clip, isHiddenOrHasHiddenAncestor];
        let window: id = msg_send![clip, window];
        let event_window: id = msg_send![event, window];
        if hidden == YES || window == nil || event_window != window {
            return;
        }
        let parent: id = msg_send![clip, superview];
        let _: () = msg_send![parent, scrollWheel:event];
    }
}
extern "C" fn finish(this: &Object, _: Sel, _: id, _: id) {
    unsafe {
        let state = context(this);
        state.initial = false;
        state.events.borrow_mut().finished = true;
        if let Some(wake) = &state.wake {
            wake();
        }
    }
}
extern "C" fn fail(this: &Object, _: Sel, _: id, _: id, error: id) {
    unsafe {
        let code: i64 = msg_send![error, code];
        // Refused document navigation does not replace a loaded card with an error.
        if code != -999 && code != 102 {
            let state = context(this);
            state.events.borrow_mut().failed = true;
            if let Some(wake) = &state.wake {
                wake();
            }
        }
    }
}
extern "C" fn terminate(this: &Object, _: Sel, _: id) {
    unsafe {
        let state = context(this);
        state.events.borrow_mut().failed = true;
        if let Some(wake) = &state.wake {
            wake();
        }
    }
}
extern "C" fn dealloc(this: &mut Object, _: Sel) {
    unsafe {
        let ptr = *this.get_ivar::<usize>("o8Context") as *mut Context;
        if !ptr.is_null() {
            drop(Box::from_raw(ptr));
        }
        let _: () = msg_send![super(this, class!(NSObject)), dealloc];
    }
}
fn ns(value: &str) -> id {
    unsafe {
        {
            let value = NSString::alloc(nil).init_str(value);
            msg_send![value, autorelease]
        }
    }
}

pub struct Host {
    web: id,
    clip: id,
    delegate: id,
    pub events: Rc<RefCell<Events>>,
    nonce: String,
}
impl Host {
    pub fn new(html: &str, nonce: &str, window: &gpui::Window, wake: Rc<dyn Fn()>) -> Option<Self> {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return None;
        };
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        unsafe {
            let host = Self::in_view(html, nonce, handle.ns_view.as_ptr() as id)?;
            context(&*host.delegate).wake = Some(wake);
            Some(host)
        }
    }
    pub unsafe fn in_view(html: &str, nonce: &str, parent: id) -> Option<Self> {
        unsafe {
            let configuration: id = msg_send![class!(WKWebViewConfiguration), new];
            let store: id = msg_send![class!(WKWebsiteDataStore), nonPersistentDataStore];
            let _: () = msg_send![configuration, setWebsiteDataStore:store];
            let preferences: id = msg_send![configuration, preferences];
            let _: () = msg_send![preferences, setJavaScriptCanOpenWindowsAutomatically:NO];
            let events = Rc::new(RefCell::new(Events::default()));
            let delegate: id = msg_send![delegate_class(), new];
            (*delegate).set_ivar(
                "o8Context",
                Box::into_raw(Box::new(Context {
                    nonce: nonce.into(),
                    events: events.clone(),
                    initial: true,
                    blank: true,
                    inner: true,
                    wake: None,
                })) as usize,
            );
            let controller: id = msg_send![configuration, userContentController];
            let _: () =
                msg_send![controller, addScriptMessageHandler:delegate name:ns("o8Visualization")];
            let bridge = format!(
                r#"addEventListener('o8:native-visualization-message', event => {{
                const data = event.detail;
                if (data?.nonce !== {}) return;
                if (['o8-visualization:height','o8-visualization:state'].includes(data.type))
                    window.webkit.messageHandlers.o8Visualization.postMessage(JSON.stringify(data));
            }});"#,
                json!(nonce)
            );
            let script: id = msg_send![class!(WKUserScript), alloc];
            let script: id = msg_send![script, initWithSource:ns(&bridge) injectionTime:0usize forMainFrameOnly:YES];
            let _: () = msg_send![controller, addUserScript:script];
            let _: () = msg_send![script, release];
            let rect = NSRect::new(NSPoint::new(0., 0.), NSSize::new(1., 1.));
            let clip: id = msg_send![clip_class(), alloc];
            let clip: id = msg_send![clip, initWithFrame:rect];
            let _: () = msg_send![clip, setWantsLayer:YES];
            let layer: id = msg_send![clip, layer];
            let _: () = msg_send![layer, setMasksToBounds:YES];
            let _: () = msg_send![clip, setHidden:YES];
            let web: id = msg_send![class!(WKWebView), alloc];
            let web: id = msg_send![web, initWithFrame:rect configuration:configuration];
            let _: () = msg_send![configuration, release];
            if web == nil {
                let _: () = msg_send![clip, release];
                let _: () = msg_send![delegate, release];
                return None;
            }
            let _: () = msg_send![web, setNavigationDelegate:delegate];
            let _: () = msg_send![web, setUIDelegate:delegate];
            let _: () = msg_send![web, setAllowsBackForwardNavigationGestures:NO];
            // The transcript owns the canvas beneath this transparent document.
            let transparent_canvas: BOOL =
                msg_send![web, respondsToSelector:sel!(_setDrawsBackground:)];
            if transparent_canvas == YES {
                let _: () = msg_send![web, _setDrawsBackground:NO];
            }
            let transparent: id = msg_send![class!(NSColor), clearColor];
            let supports: BOOL =
                msg_send![web, respondsToSelector:sel!(setUnderPageBackgroundColor:)];
            if supports == YES {
                let _: () = msg_send![web, setUnderPageBackgroundColor:transparent];
            }
            NSView::addSubview_(clip, web);
            NSView::addSubview_(parent, clip);
            let _: id = msg_send![web, loadHTMLString:ns(html) baseURL:nil];
            Some(Self {
                web,
                clip,
                delegate,
                events,
                nonce: nonce.into(),
            })
        }
    }
    pub fn position(
        &self,
        bounds: gpui::Bounds<gpui::Pixels>,
        viewport: gpui::Bounds<gpui::Pixels>,
        window: &gpui::Window,
    ) {
        let visible = bounds.intersect(&viewport);
        if visible.size.width <= gpui::px(0.) || visible.size.height <= gpui::px(0.) {
            self.hide();
            return;
        }
        unsafe {
            let parent: id = msg_send![self.clip, superview];
            let flipped: BOOL = msg_send![parent, isFlipped];
            let height = f64::from(f32::from(window.viewport_size().height));
            let x = |v: gpui::Pixels| f64::from(f32::from(v));
            let top = if flipped == YES {
                x(visible.top())
            } else {
                height - x(visible.bottom())
            };
            let clip_frame = NSRect::new(
                NSPoint::new(x(visible.left()), top),
                NSSize::new(x(visible.size.width), x(visible.size.height)),
            );
            let _: () = msg_send![self.clip, setFrame:clip_frame];
            let web_y = x(bounds.top() - visible.top());
            let web_frame = NSRect::new(
                NSPoint::new(x(bounds.left() - visible.left()), web_y),
                NSSize::new(x(bounds.size.width), x(bounds.size.height)),
            );
            let _: () = msg_send![self.web, setFrame:web_frame];
            let _: () = msg_send![self.clip, setHidden:NO];
        }
    }
    pub fn hide(&self) {
        unsafe {
            let _: () = msg_send![self.clip, setHidden:YES];
        }
    }
    pub fn send(&self, kind: &str, key: &str, value: &Value) {
        let event =
            json!({"type":format!("o8-visualization:{kind}"), "nonce":self.nonce, key:value});
        self.evaluate(
            &format!("dispatchEvent(new MessageEvent('message', {{source:window,data:{event}}}));"),
            None,
        );
    }
    pub fn evaluate(&self, script: &str, callback: Option<&block::Block<(id, id), ()>>) {
        unsafe {
            let completion = callback.map_or(std::ptr::null(), |block| block as *const _);
            let _: () =
                msg_send![self.web, evaluateJavaScript:ns(script) completionHandler:completion];
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.web, stopLoading];
            let _: () = msg_send![self.web, setNavigationDelegate:nil];
            let _: () = msg_send![self.web, setUIDelegate:nil];
            let configuration: id = msg_send![self.web, configuration];
            let controller: id = msg_send![configuration, userContentController];
            let _: () =
                msg_send![controller, removeScriptMessageHandlerForName:ns("o8Visualization")];
            NSView::removeFromSuperview(self.clip);
            let _: () = msg_send![self.web, release];
            let _: () = msg_send![self.clip, release];
            let _: () = msg_send![self.delegate, release];
        }
    }
}
