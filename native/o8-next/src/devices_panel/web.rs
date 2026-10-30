//! BrowserPanel's WKWebView/GPUI canvas embedding pattern, with classic's
//! sandboxed iframe and native hit-testing disabled until ownership is live.
#![allow(unexpected_cfgs)]
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
use std::sync::OnceLock;
fn ns(value: &str) -> id {
    unsafe {
        let s = NSString::alloc(nil).init_str(value);
        msg_send![s, autorelease]
    }
}
fn viewer_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        extern "C" fn hit(this: &Object, _: Sel, point: NSPoint) -> id {
            unsafe {
                if *this.get_ivar::<BOOL>("o8Input") != YES {
                    return nil;
                }
                msg_send![super(this, class!(WKWebView)), hitTest: point]
            }
        }
        extern "C" fn accepts(this: &Object, _: Sel) -> BOOL {
            unsafe { *this.get_ivar::<BOOL>("o8Input") }
        }
        let mut decl = ClassDecl::new("O8DevicesViewer", class!(WKWebView)).unwrap();
        decl.add_ivar::<BOOL>("o8Input");
        unsafe {
            decl.add_method(
                sel!(hitTest:),
                hit as extern "C" fn(&Object, Sel, NSPoint) -> id,
            );
            decl.add_method(
                sel!(acceptsFirstResponder),
                accepts as extern "C" fn(&Object, Sel) -> BOOL,
            );
        }
        decl.register()
    })
}
pub(super) struct Viewer {
    view: id,
    url: String,
}
impl Viewer {
    pub fn new(window: &gpui::Window) -> Option<Self> {
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        unsafe {
            let parent = handle.ns_view.as_ptr() as id;
            let configuration: id = msg_send![class!(WKWebViewConfiguration), new];
            let store: id = msg_send![class!(WKWebsiteDataStore), nonPersistentDataStore];
            let _: () = msg_send![configuration, setWebsiteDataStore: store];
            let preferences: id = msg_send![configuration, preferences];
            let _: () = msg_send![preferences, setJavaScriptCanOpenWindowsAutomatically: NO];
            let view: id = msg_send![viewer_class(), alloc];
            let view: id = msg_send![view, initWithFrame: NSRect::new(NSPoint::new(0.,0.),NSSize::new(1.,1.)) configuration: configuration];
            let _: () = msg_send![configuration, release];
            if view == nil {
                return None;
            }
            (*view).set_ivar("o8Input", NO);
            let _: () = msg_send![view, setHidden: YES];
            NSView::addSubview_(parent, view);
            Some(Self {
                view,
                url: String::new(),
            })
        }
    }
    pub fn show(
        &mut self,
        url: &str,
        origin: &str,
        bounds: gpui::Bounds<gpui::Pixels>,
        window: &gpui::Window,
        active: bool,
        manual: bool,
    ) {
        if !active {
            self.hide();
            return;
        }
        // Only the loopback URL returned by the existing device route is embedded.
        let valid = url::Url::parse(url).ok().is_some_and(|u| {
            u.scheme() == "http"
                && matches!(u.host_str(), Some("127.0.0.1" | "localhost"))
                && u.username().is_empty()
                && u.password().is_none()
        });
        if !valid {
            self.hide();
            return;
        }
        unsafe {
            if self.url != url {
                self.url = url.to_owned();
                let escaped = url
                    .replace('&', "&amp;")
                    .replace('"', "&quot;")
                    .replace('<', "&lt;");
                let html = format!(
                    "<!doctype html><meta name='referrer' content='no-referrer'><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden}}iframe{{width:100%;height:100%;border:0}}</style><iframe id='viewer' title='Live device viewer' inert tabindex='-1' referrerpolicy='no-referrer' sandbox='allow-scripts allow-same-origin allow-forms allow-downloads' src=\"{escaped}\"></iframe>"
                );
                let base: id = msg_send![class!(NSURL), URLWithString: ns(origin)];
                let _: () = msg_send![self.view, loadHTMLString: ns(&html) baseURL: base];
            }
            // The native hit-test closes synchronously. The inert iframe also
            // excludes all descendant keyboard focus while viewing passively.
            (*self.view).set_ivar("o8Input", if manual { YES } else { NO });
            if !manual {
                self.resign();
            }
            let script = if manual {
                "document.getElementById('viewer').inert=false;document.getElementById('viewer').tabIndex=0"
            } else {
                "document.getElementById('viewer').inert=true;document.getElementById('viewer').tabIndex=-1"
            };
            let _: () = msg_send![self.view, evaluateJavaScript: ns(script) completionHandler: nil];
            let parent: id = msg_send![self.view, superview];
            let flipped: BOOL = msg_send![parent, isFlipped];
            let x = |v: gpui::Pixels| f64::from(f32::from(v));
            let top = if flipped == YES {
                x(bounds.top())
            } else {
                f64::from(f32::from(window.viewport_size().height)) - x(bounds.bottom())
            };
            let frame = NSRect::new(
                NSPoint::new(x(bounds.left()), top),
                NSSize::new(x(bounds.size.width), x(bounds.size.height)),
            );
            let _: () = msg_send![self.view, setFrame: frame];
            let _: () = msg_send![self.view, setHidden: NO];
        }
    }
    fn resign(&self) {
        unsafe {
            let window: id = msg_send![self.view, window];
            let responder: id = msg_send![window, firstResponder];
            if responder != nil {
                let is_view: BOOL = msg_send![responder, isKindOfClass: class!(NSView)];
                if is_view == YES {
                    let descendant: BOOL = msg_send![responder, isDescendantOf: self.view];
                    if descendant == YES {
                        let parent: id = msg_send![self.view, superview];
                        let _: BOOL = msg_send![window, makeFirstResponder: parent];
                    }
                }
            }
        }
    }
    pub fn hide(&self) {
        unsafe {
            (*self.view).set_ivar("o8Input", NO);
            self.resign();
            let _: () = msg_send![self.view, setHidden: YES];
        }
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.view, stopLoading];
            NSView::removeFromSuperview(self.view);
            let _: () = msg_send![self.view, release];
        }
    }
}
