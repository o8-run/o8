//! WKWebView page host. Data-store and popup permission policy are unchanged.
#[derive(Default)]
pub(super) struct Status {
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: bool,
    pub document: bool,
    pub back: bool,
    pub forward: bool,
    pub error: Option<String>,
}
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod macos {
    use super::Status;
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
    use std::{cell::RefCell, ffi::CStr, rc::Rc, sync::OnceLock};
    #[derive(Default)]
    struct Events {
        error: Option<String>,
        popups: Vec<String>,
        navigating: bool,
        document: bool,
    }
    unsafe fn string(value: id) -> Option<String> {
        if value == nil {
            return None;
        }
        let bytes: *const std::os::raw::c_char = unsafe { msg_send![value, UTF8String] };
        if bytes.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(bytes) }
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }
    fn events(object: &Object) -> &RefCell<Events> {
        unsafe { &*(*object.get_ivar::<usize>("events") as *const RefCell<Events>) }
    }

    fn ns(value: &str) -> id {
        unsafe {
            let string = NSString::alloc(nil).init_str(value);
            msg_send![string, autorelease]
        }
    }

    /// Links that ask for a new window open in this page instead.
    fn delegate_class() -> &'static Class {
        static CLASS: OnceLock<&'static Class> = OnceLock::new();
        CLASS.get_or_init(|| {
            extern "C" fn new_window(object: &Object, _: Sel, _: id, _: id, action: id, _: id) -> id {
                unsafe {
                    let request: id = msg_send![action, request];
                    let url: id = msg_send![request, URL];
                    let absolute: id = msg_send![url, absoluteString];
                    if let Some(url) = string(absolute) { events(object).borrow_mut().popups.push(url); }
                }
                nil
            }
            extern "C" fn started(object: &Object, _: Sel, _: id, _: id) {
                let mut events = events(object).borrow_mut();
                events.error = None; events.navigating = true;
            }
            extern "C" fn committed(object: &Object, _: Sel, _: id, _: id) {
                // Present committed HTML while fonts/images are still loading.
                events(object).borrow_mut().document = true;
            }
            extern "C" fn finished(object: &Object, _: Sel, _: id, _: id) {
                let mut events = events(object).borrow_mut();
                events.navigating = false; events.document = true;
            }
            extern "C" fn failed(object: &Object, _: Sel, _: id, _: id, error: id) {
                unsafe {
                    let code: isize = msg_send![error, code];
                    // A superseded navigation is not a failed page.
                    if code == -999 { return; }
                    let description: id = msg_send![error, localizedDescription];
                    let mut events = events(object).borrow_mut();
                    events.error = string(description).or(Some("Could not load this page".into()));
                    events.navigating = false;
                }
            }
            let mut decl = ClassDecl::new("O8BrowserDelegate", class!(NSObject)).unwrap();
            decl.add_ivar::<usize>("events");
            unsafe {
                decl.add_method(sel!(webView:didStartProvisionalNavigation:), started as extern "C" fn(&Object, Sel, id, id));
                decl.add_method(sel!(webView:didCommitNavigation:), committed as extern "C" fn(&Object, Sel, id, id));
                decl.add_method(sel!(webView:didFinishNavigation:), finished as extern "C" fn(&Object, Sel, id, id));
                decl.add_method(sel!(webView:didFailProvisionalNavigation:withError:), failed as extern "C" fn(&Object, Sel, id, id, id));
                decl.add_method(sel!(webView:didFailNavigation:withError:), failed as extern "C" fn(&Object, Sel, id, id, id));
                decl.add_method(
                    sel!(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:),
                    new_window as extern "C" fn(&Object, Sel, id, id, id, id) -> id,
                );
            }
            decl.register()
        })
    }

    #[cfg(test)]
    pub(super) fn commit_flags_for_test() -> (bool, bool) {
        unsafe {
            let delegate: id = msg_send![delegate_class(), new];
            let events = Rc::new(RefCell::new(Events {
                navigating: true,
                ..Events::default()
            }));
            (*delegate).set_ivar("events", Rc::as_ptr(&events) as usize);
            let handles_commit: BOOL =
                msg_send![delegate, respondsToSelector: sel!(webView:didCommitNavigation:)];
            if handles_commit == YES {
                let _: () = msg_send![delegate, webView: nil didCommitNavigation: nil];
            }
            let flags = (events.borrow().document, events.borrow().navigating);
            let _: () = msg_send![delegate, release];
            flags
        }
    }

    pub struct Web {
        view: id,
        delegate: id,
        events: Rc<RefCell<Events>>,
    }

    impl Web {
        #[cfg(test)]
        pub fn new(_: &gpui::Window) -> Option<Self> {
            None
        }

        #[cfg(not(test))]
        pub fn new(window: &gpui::Window) -> Option<Self> {
            let handle = HasWindowHandle::window_handle(window).ok()?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return None;
            };
            unsafe {
                let parent = handle.ns_view.as_ptr() as id;
                let configuration: id = msg_send![class!(WKWebViewConfiguration), new];
                // Its own cookies and storage, gone when the app quits.
                let store: id = msg_send![class!(WKWebsiteDataStore), nonPersistentDataStore];
                let _: () = msg_send![configuration, setWebsiteDataStore: store];
                let controller: id = msg_send![configuration, userContentController];
                let script: id = msg_send![class!(WKUserScript), alloc];
                let script: id = msg_send![script, initWithSource: ns(include_str!("scrollbars.js")) injectionTime: 0usize forMainFrameOnly: NO];
                let _: () = msg_send![controller, addUserScript: script];
                let _: () = msg_send![script, release];
                let preferences: id = msg_send![configuration, preferences];
                let _: () = msg_send![preferences, setJavaScriptCanOpenWindowsAutomatically: NO];
                let rect = NSRect::new(NSPoint::new(0., 0.), NSSize::new(1., 1.));
                let view: id = msg_send![class!(WKWebView), alloc];
                let view: id = msg_send![view, initWithFrame: rect configuration: configuration];
                let _: () = msg_send![configuration, release];
                if view == nil {
                    return None;
                }
                let delegate: id = msg_send![delegate_class(), new];
                let events = Rc::new(RefCell::new(Events::default()));
                (*delegate).set_ivar("events", Rc::as_ptr(&events) as usize);
                let _: () = msg_send![view, setUIDelegate: delegate];
                let _: () = msg_send![view, setNavigationDelegate: delegate];
                let _: () = msg_send![view, setAllowsBackForwardNavigationGestures: YES];
                let _: () = msg_send![view, setHidden: YES];
                NSView::addSubview_(parent, view);
                Some(Self {
                    view,
                    delegate,
                    events,
                })
            }
        }

        pub fn load(&self, url: &str) {
            self.events.borrow_mut().error = None;
            self.events.borrow_mut().navigating = true;
            unsafe {
                let url: id = msg_send![class!(NSURL), URLWithString: ns(url)];
                if url == nil {
                    let mut events = self.events.borrow_mut();
                    events.error = Some("Could not load this address".into());
                    events.navigating = false;
                    return;
                }
                let request: id = msg_send![class!(NSURLRequest), requestWithURL: url];
                let _: id = msg_send![self.view, loadRequest: request];
            }
        }

        pub fn focus_chrome(&self) {
            unsafe {
                let window: id = msg_send![self.view, window];
                let parent: id = msg_send![self.view, superview];
                let _: BOOL = msg_send![window, makeFirstResponder: parent];
            }
        }
        pub fn has_document(&self) -> bool {
            self.events.borrow().document
        }
        pub fn is_focused(&self) -> bool {
            unsafe {
                let window: id = msg_send![self.view, window];
                let responder: id = msg_send![window, firstResponder];
                let is_view: BOOL = msg_send![responder, isKindOfClass: class!(NSView)];
                if is_view != YES {
                    return false;
                }
                let inside: BOOL = msg_send![responder, isDescendantOf: self.view];
                inside == YES
            }
        }
        pub fn status(&self) -> Status {
            unsafe {
                let title: id = msg_send![self.view, title];
                let loading: BOOL = msg_send![self.view, isLoading];
                let back: BOOL = msg_send![self.view, canGoBack];
                let forward: BOOL = msg_send![self.view, canGoForward];
                Status {
                    url: self.url(),
                    title: string(title),
                    loading: loading == YES || self.events.borrow().navigating,
                    document: self.events.borrow().document,
                    back: back == YES,
                    forward: forward == YES,
                    error: self.events.borrow().error.clone(),
                }
            }
        }
        pub fn take_popups(&self) -> Vec<String> {
            std::mem::take(&mut self.events.borrow_mut().popups)
        }

        pub fn back(&self) {
            unsafe {
                let _: id = msg_send![self.view, goBack];
            }
        }

        pub fn forward(&self) {
            unsafe {
                let _: id = msg_send![self.view, goForward];
            }
        }

        pub fn reload(&self) {
            self.events.borrow_mut().error = None;
            self.events.borrow_mut().navigating = true;
            unsafe {
                let _: id = msg_send![self.view, reload];
            }
        }

        pub fn url(&self) -> Option<String> {
            unsafe {
                let url: id = msg_send![self.view, URL];
                if url == nil {
                    return None;
                }
                let text: id = msg_send![url, absoluteString];
                if text == nil {
                    return None;
                }
                let bytes: *const std::os::raw::c_char = msg_send![text, UTF8String];
                Some(CStr::from_ptr(bytes).to_string_lossy().into_owned())
            }
        }

        pub fn position(&self, bounds: gpui::Bounds<gpui::Pixels>, window: &gpui::Window) {
            unsafe {
                let parent: id = msg_send![self.view, superview];
                let flipped: BOOL = msg_send![parent, isFlipped];
                let height = f64::from(f32::from(window.viewport_size().height));
                let x = |v: gpui::Pixels| f64::from(f32::from(v));
                let top = if flipped == YES {
                    x(bounds.top())
                } else {
                    height - x(bounds.bottom())
                };
                let frame = NSRect::new(
                    NSPoint::new(x(bounds.left()), top),
                    NSSize::new(x(bounds.size.width), x(bounds.size.height)),
                );
                let _: () = msg_send![self.view, setFrame: frame];
                let _: () = msg_send![self.view, setHidden: NO];
            }
        }

        pub fn hide(&self) {
            unsafe {
                let _: () = msg_send![self.view, setHidden: YES];
            }
        }
    }

    impl Drop for Web {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![self.view, stopLoading];
                let _: () = msg_send![self.view, setUIDelegate: nil];
                let _: () = msg_send![self.view, setNavigationDelegate: nil];
                NSView::removeFromSuperview(self.view);
                let _: () = msg_send![self.view, release];
                let _: () = msg_send![self.delegate, release];
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) use macos::Web;

#[cfg(not(target_os = "macos"))]
pub(super) struct Web;
#[cfg(not(target_os = "macos"))]
impl Web {
    pub fn new(_: &gpui::Window) -> Option<Self> {
        None
    }
    pub fn load(&self, _: &str) {}
    pub fn back(&self) {}
    pub fn forward(&self) {}
    pub fn reload(&self) {}
    pub fn hide(&self) {}
    pub fn position(&self, _: gpui::Bounds<gpui::Pixels>, _: &gpui::Window) {}
    pub fn focus_chrome(&self) {}
    pub fn has_document(&self) -> bool {
        false
    }
    pub fn is_focused(&self) -> bool {
        false
    }
    pub fn status(&self) -> Status {
        Status::default()
    }
    pub fn take_popups(&self) -> Vec<String> {
        vec![]
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(super) fn commit_flags_for_test() -> (bool, bool) {
    macos::commit_flags_for_test()
}
