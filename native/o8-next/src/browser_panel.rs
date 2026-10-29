//! The right panel's Browser tool (O8BrowserPane). A plain WKWebView with its
//! own non-persistent website data and no script bridge into o8, laid over the
//! panel body each frame. Other platforms show a notice.
use crate::composer::{Composer, Submit};
use crate::theme::current as theme;
use gpui::{
    Bounds, Context, Entity, FocusHandle, IntoElement, ParentElement, Pixels, Render, Styled,
    Subscription, Window, canvas, div, prelude::*, px,
};
use std::{cell::RefCell, rc::Rc, time::Duration};

/// normalizeBrowserUrl in src/lib/browser/url.ts. Only web addresses load.
pub fn normalize(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return value.into();
    }
    let dotted = value
        .split('.')
        .take(4)
        .filter(|part| !part.is_empty())
        .count()
        == 4
        && value.chars().next().is_some_and(|c| c.is_ascii_digit());
    if value.starts_with("localhost") || dotted {
        format!("http://{value}")
    } else {
        format!("https://{value}")
    }
}

pub struct BrowserPanel {
    address: Entity<Composer>,
    address_focus: FocusHandle,
    #[cfg(target_os = "macos")]
    web: Rc<RefCell<Option<web::Web>>>,
    #[cfg(not(target_os = "macos"))]
    web: Rc<RefCell<Option<()>>>,
    /// An address asked for before the native page exists.
    pending: Rc<RefCell<Option<String>>>,
    /// Hidden while the panel moves, or a menu or the palette sits over it.
    covered: bool,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl BrowserPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let address = cx.new(|cx| {
            let mut field = Composer::new(cx);
            field.placeholder = "Search or enter address".into();
            field
        });
        let submit = cx.subscribe(&address, |this, address, _: &Submit, cx| {
            let url = normalize(&address.read(cx).text);
            if !url.is_empty() {
                address.update(cx, |field, cx| field.set_text(&url, cx));
                this.load(&url);
            }
            cx.notify();
        });
        // The page navigates on its own; keep the address field following it.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                if this.update(cx, |this, cx| this.follow(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            address_focus: address.read(cx).focus.clone(),
            address,
            web: Rc::default(),
            pending: Rc::default(),
            covered: false,
            focus: cx.focus_handle(),
            _subscriptions: vec![submit],
        }
    }

    pub fn focus(&self, window: &mut Window) {
        self.address_focus.focus(window);
    }

    /// Hides the native page (it draws above everything the window paints).
    pub fn cover(&mut self, covered: bool) {
        self.covered = covered;
        if covered {
            #[cfg(target_os = "macos")]
            if let Some(web) = self.web.borrow().as_ref() {
                web.hide();
            }
        }
    }

    /// Opens a page and shows its address.
    pub fn navigate(&mut self, url: &str, cx: &mut Context<Self>) {
        self.address.update(cx, |field, cx| field.set_text(url, cx));
        self.load(url);
        cx.notify();
    }

    fn load(&self, url: &str) {
        #[cfg(target_os = "macos")]
        match self.web.borrow().as_ref() {
            Some(web) => web.load(url),
            None => *self.pending.borrow_mut() = Some(url.into()),
        }
        #[cfg(not(target_os = "macos"))]
        let _ = url;
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        {
            let current = self.web.borrow().as_ref().and_then(|web| web.url());
            let field = self.address.read(cx);
            if let Some(current) = current
                && field.text != current
                && !field.composing()
            {
                self.address
                    .update(cx, |field, cx| field.set_text(&current, cx));
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = cx;
    }

    fn act(&self, action: fn(&web::Web)) {
        #[cfg(target_os = "macos")]
        if let Some(web) = self.web.borrow().as_ref() {
            action(web);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = action;
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let button = |id: &'static str, path: &'static str, tip: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .size(px(26.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .cursor_pointer()
                .hover(|button| button.bg(theme().hover))
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
                .child(crate::icon::stroke(path, theme().text_secondary, 15., 1.7))
        };
        let web = self.web.clone();
        let pending = self.pending.clone();
        let covered = self.covered;
        div()
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .min_h(px(44.))
                    .py(px(4.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .px(px(8.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        button("browser-back", BACK, "Back")
                            .on_click(cx.listener(|this, _, _, _| this.act(web::Web::back))),
                    )
                    .child(
                        button("browser-forward", FORWARD, "Forward")
                            .on_click(cx.listener(|this, _, _, _| this.act(web::Web::forward))),
                    )
                    .child(
                        button("browser-reload", RELOAD, "Reload")
                            .on_click(cx.listener(|this, _, _, _| this.act(web::Web::reload))),
                    )
                    .child(
                        // A column so the framed field stretches across the bar.
                        div()
                            .ml(px(4.))
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .text_size(px(12.))
                            .child(self.address.clone()),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        div()
                            .p(px(16.))
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .child(if cfg!(target_os = "macos") {
                                "Type a web address or a localhost port above."
                            } else {
                                "The Browser needs macOS for now."
                            }),
                    )
                    .child(
                        canvas(
                            |bounds, _, _| bounds,
                            move |bounds: Bounds<Pixels>, _, window, _| {
                                #[cfg(target_os = "macos")]
                                {
                                    let mut slot = web.borrow_mut();
                                    if slot.is_none() {
                                        *slot = web::Web::new(window);
                                        if let (Some(page), Some(url)) =
                                            (slot.as_ref(), pending.borrow_mut().take())
                                        {
                                            page.load(&url);
                                        }
                                    }
                                    // Blank until an address loads, so no white page shows.
                                    if let Some(page) = slot.as_ref() {
                                        if covered || page.url().is_none() {
                                            page.hide();
                                        } else {
                                            page.position(bounds, window);
                                        }
                                    }
                                }
                                #[cfg(not(target_os = "macos"))]
                                let _ = (bounds, window, &web, &pending, covered);
                            },
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    ),
            )
    }
}

const BACK: &str = "M19 12H5m6-6-6 6 6 6";
const FORWARD: &str = "M5 12h14m-6-6 6 6-6 6";
const RELOAD: &str = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";

#[cfg(not(target_os = "macos"))]
mod web {
    pub struct Web;
    impl Web {
        pub fn back(&self) {}
        pub fn forward(&self) {}
        pub fn reload(&self) {}
    }
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod web {
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
    use std::{ffi::CStr, sync::OnceLock};

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
            extern "C" fn new_window(_: &Object, _: Sel, web: id, _: id, action: id, _: id) -> id {
                unsafe {
                    let request: id = msg_send![action, request];
                    let _: id = msg_send![web, loadRequest: request];
                }
                nil
            }
            let mut decl = ClassDecl::new("O8BrowserDelegate", class!(NSObject)).unwrap();
            unsafe {
                decl.add_method(
                    sel!(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:),
                    new_window as extern "C" fn(&Object, Sel, id, id, id, id) -> id,
                );
            }
            decl.register()
        })
    }

    pub struct Web {
        view: id,
        delegate: id,
    }

    impl Web {
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
                let _: () = msg_send![view, setUIDelegate: delegate];
                let _: () = msg_send![view, setAllowsBackForwardNavigationGestures: YES];
                let _: () = msg_send![view, setHidden: YES];
                NSView::addSubview_(parent, view);
                Some(Self { view, delegate })
            }
        }

        pub fn load(&self, url: &str) {
            unsafe {
                let url: id = msg_send![class!(NSURL), URLWithString: ns(url)];
                if url == nil {
                    return;
                }
                let request: id = msg_send![class!(NSURLRequest), requestWithURL: url];
                let _: id = msg_send![self.view, loadRequest: request];
            }
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
                NSView::removeFromSuperview(self.view);
                let _: () = msg_send![self.view, release];
                let _: () = msg_send![self.delegate, release];
            }
        }
    }
}
