//! Port of src-tauri/src/remote_preview.rs. This host has no agent/eval surface.
use super::client::Access;
pub(super) fn valid_access(access: &Access) -> bool {
    access
        .id
        .as_ref()
        .is_some_and(|id| id.len() == 48 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        && access
            .url
            .as_ref()
            .and_then(|raw| url::Url::parse(raw).ok())
            .is_some_and(|url| {
                let ticket = url.query().and_then(|q| q.strip_prefix("ticket="));
                url.scheme() == "http"
                    && url.host_str() == Some("[::1]")
                    && url.port().is_some_and(|p| p != 0)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/__o8_connect"
                    && ticket
                        .is_some_and(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
            })
}
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod mac {
    use super::*;
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
    struct Policy {
        origin: url::Origin,
        error: Rc<RefCell<Option<String>>>,
    }
    unsafe fn text(value: id) -> Option<String> {
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
    fn policy(object: &Object) -> &Policy {
        unsafe { &*(*object.get_ivar::<usize>("policy") as *const Policy) }
    }
    fn delegate() -> &'static Class {
        static CLASS: OnceLock<&'static Class> = OnceLock::new();
        CLASS.get_or_init(|| {
            extern "C" fn navigation(object:&Object,_:Sel,_:id,action:id,handler:id) {
                unsafe {
                    let request:id=msg_send![action,request]; let address:id=msg_send![request,URL];
                    let absolute:id=msg_send![address,absoluteString];
                    let allowed=text(absolute).and_then(|s|url::Url::parse(&s).ok()).is_some_and(|u|u.origin()==policy(object).origin);
                    let supports:BOOL=msg_send![action,respondsToSelector:sel!(shouldPerformDownload)];
                    let download=if supports==YES { let value:BOOL=msg_send![action,shouldPerformDownload]; value==YES }else{false};
                    let block=&*(handler as *const block::Block<(isize,),()>);
                    block.call((if allowed && !download {1}else{0},));
                }
            }
            extern "C" fn response(_: &Object,_:Sel,_:id,response:id,handler:id) {
                unsafe {
                    let show:BOOL=msg_send![response,canShowMIMEType];
                    let source:id=msg_send![response,response];
                    let supports:BOOL=msg_send![source,respondsToSelector:sel!(valueForHTTPHeaderField:)];
                    let attachment=if supports==YES {
                        let key=NSString::alloc(nil).init_str("Content-Disposition");
                        let value:id=msg_send![source,valueForHTTPHeaderField:key];
                        let _:()=msg_send![key,release];
                        text(value).is_some_and(|v|v.to_ascii_lowercase().trim_start().starts_with("attachment"))
                    }else{false};
                    let block=&*(handler as *const block::Block<(isize,),()>); block.call((if show==YES && !attachment {1}else{0},));
                }
            }
            extern "C" fn new_window(_: &Object,_:Sel,_:id,_:id,_:id,_:id)->id {nil}
            extern "C" fn failed(object:&Object,_:Sel,_:id,_:id,error:id) {
                unsafe { let code:isize=msg_send![error,code]; if code==-999{return;} }
                *policy(object).error.borrow_mut()=Some("The native preview could not open. Reconnect to try again.".into());
            }
            let mut decl=ClassDecl::new("O8IsolatedRemotePreviewDelegate",class!(NSObject)).unwrap();
            decl.add_ivar::<usize>("policy");
            unsafe {
                decl.add_method(sel!(webView:decidePolicyForNavigationAction:decisionHandler:),navigation as extern "C" fn(&Object,Sel,id,id,id));
                decl.add_method(sel!(webView:decidePolicyForNavigationResponse:decisionHandler:),response as extern "C" fn(&Object,Sel,id,id,id));
                decl.add_method(sel!(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:),new_window as extern "C" fn(&Object,Sel,id,id,id,id)->id);
                decl.add_method(sel!(webView:didFailProvisionalNavigation:withError:),failed as extern "C" fn(&Object,Sel,id,id,id));
                decl.add_method(sel!(webView:didFailNavigation:withError:),failed as extern "C" fn(&Object,Sel,id,id,id));
            }
            decl.register()
        })
    }
    pub(crate) struct Host {
        view: id,
        delegate: id,
        _policy: Box<Policy>,
    }
    impl Host {
        #[cfg(test)]
        pub fn new(_: &Access, _: &gpui::Window, _: Rc<RefCell<Option<String>>>) -> Option<Self> {
            None
        }
        #[cfg(not(test))]
        pub fn new(
            access: &Access,
            window: &gpui::Window,
            error: Rc<RefCell<Option<String>>>,
        ) -> Option<Self> {
            if !valid_access(access) {
                return None;
            }
            let RawWindowHandle::AppKit(handle) =
                HasWindowHandle::window_handle(window).ok()?.as_raw()
            else {
                return None;
            };
            let parsed = url::Url::parse(access.url.as_ref()?).ok()?;
            unsafe {
                // Separate configuration; preserve WebKit's existing cookie policy.
                // No initialization script, user content bridge, eval, or operator headers.
                let config: id = msg_send![class!(WKWebViewConfiguration), new];
                let view: id = msg_send![class!(WKWebView), alloc];
                let view: id = msg_send![view,initWithFrame:NSRect::new(NSPoint::new(0.,0.),NSSize::new(1.,1.)) configuration:config];
                let _: () = msg_send![config, release];
                if view == nil {
                    return None;
                }
                let delegate: id = msg_send![delegate(), new];
                let policy = Box::new(Policy {
                    origin: parsed.origin(),
                    error,
                });
                (*delegate).set_ivar("policy", &*policy as *const Policy as usize);
                let _: () = msg_send![view,setNavigationDelegate:delegate];
                let _: () = msg_send![view,setUIDelegate:delegate];
                let _: () = msg_send![view,setHidden:YES];
                NSView::addSubview_(handle.ns_view.as_ptr() as id, view);
                let source = NSString::alloc(nil).init_str(access.url.as_ref()?);
                let url: id = msg_send![class!(NSURL),URLWithString:source];
                let _: () = msg_send![source, release];
                let request: id = msg_send![class!(NSURLRequest),requestWithURL:url];
                let _: id = msg_send![view,loadRequest:request];
                Some(Self {
                    view,
                    delegate,
                    _policy: policy,
                })
            }
        }
        pub fn hide(&self) {
            unsafe {
                let _: () = msg_send![self.view,setHidden:YES];
            }
        }
        pub fn position(&self, bounds: gpui::Bounds<gpui::Pixels>, _: &gpui::Window) {
            unsafe {
                let parent: id = msg_send![self.view, superview];
                let frame: NSRect = msg_send![parent, bounds];
                let flipped: BOOL = msg_send![parent, isFlipped];
                let x = f64::from(bounds.origin.x).max(0.);
                let top = f64::from(bounds.origin.y).max(0.);
                let w = f64::from(bounds.size.width).min((frame.size.width - x).max(0.));
                let h = f64::from(bounds.size.height).min((frame.size.height - top).max(0.));
                if w < 1. || h < 1. {
                    self.hide();
                    return;
                }
                let y = if flipped == YES {
                    top
                } else {
                    frame.size.height - top - h
                };
                let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
                let _: () = msg_send![self.view, setFrame: rect];
                let _: () = msg_send![self.view,setHidden:NO];
            }
        }
    }
    impl Drop for Host {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![self.view, stopLoading];
                let _: () = msg_send![self.view,setNavigationDelegate:nil];
                let _: () = msg_send![self.view,setUIDelegate:nil];
                let _: () = msg_send![self.view, removeFromSuperview];
                let _: () = msg_send![self.view, release];
                let _: () = msg_send![self.delegate, release];
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub(super) use mac::Host;
#[cfg(not(target_os = "macos"))]
pub(super) struct Host;
#[cfg(not(target_os = "macos"))]
impl Host {
    pub fn new(
        _: &Access,
        _: &gpui::Window,
        _: std::rc::Rc<std::cell::RefCell<Option<String>>>,
    ) -> Option<Self> {
        None
    }
    pub fn hide(&self) {}
    pub fn position(&self, _: gpui::Bounds<gpui::Pixels>, _: &gpui::Window) {}
}
