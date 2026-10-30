//! Browser page lifecycle, ported from classic O8BrowserPane.
use crate::composer::Submit;
use crate::theme::current as theme;
use address::Address;
use gpui::{
    AnyElement, Bounds, ClipboardItem, Context, Div, Entity, EventEmitter, FocusHandle, FontWeight,
    IntoElement, ParentElement, Pixels, Render, SharedString, Stateful, Styled, Subscription,
    Window, canvas, div, prelude::*, px,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};
mod address;
mod favicon;
pub(crate) mod header;
mod model;
mod state;
mod view;
mod web;
pub use state::{Snapshot, save_pages};
pub struct PagesChanged(pub Snapshot);
impl EventEmitter<PagesChanged> for BrowserPanel {}
use model::Tab;
pub use model::normalize;

struct Page {
    web: Rc<RefCell<Option<web::Web>>>,
    pending: Rc<RefCell<Option<String>>>,
    loading: bool,
    document: bool,
    error: Option<String>,
    back: bool,
    forward: bool,
    creation_failed: Rc<std::cell::Cell<bool>>,
}
impl Default for Page {
    fn default() -> Self {
        Self {
            web: Rc::default(),
            pending: Rc::default(),
            loading: false,
            document: false,
            error: None,
            back: false,
            forward: false,
            creation_failed: Rc::default(),
        }
    }
}
impl Page {
    fn observe_status(&mut self, tab: &mut Tab, status: web::Status) -> bool {
        let mut changed = false;
        if self.document != status.document
            || self.loading != status.loading
            || self.back != status.back
            || self.forward != status.forward
            || self.error != status.error
        {
            self.loading = status.loading;
            self.document = status.document;
            self.back = status.back;
            self.forward = status.forward;
            self.error = status.error;
            changed = true;
        }
        if let Some(url) = status.url
            && !status.loading
            && self.error.is_none()
            && url != tab.url
        {
            tab.url = url;
            changed = true;
        }
        if let Some(title) = status.title
            && !status.loading
            && self.error.is_none()
            && !title.is_empty()
            && title != tab.title
        {
            tab.title = title;
            changed = true;
        }
        changed
    }
}
pub struct BrowserPanel {
    address: Entity<Address>,
    address_focus: FocusHandle,
    tabs: Vec<Tab>,
    active: Option<u64>,
    next_id: u64,
    pages: HashMap<u64, Page>,
    covered: bool,
    focus: FocusHandle,
    copied: Option<Instant>,
    agent_glow: Option<Instant>,
    editing: bool,
    blur_address: bool,
    in_header: bool,
    focus_observed: bool,
    window: Option<gpui::AnyWindowHandle>,
    seeded: bool,
    previews: Vec<u16>,
    last_saved: (Vec<Tab>, Option<u64>),
    favicons: HashMap<String, Option<std::sync::Arc<gpui::Image>>>,
    favicon_loading: usize,
    _subscriptions: Vec<Subscription>,
}
impl BrowserPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let address = cx.new(|cx| {
            let mut field = Address::new(cx);
            field.placeholder = "Enter URL or search...".into();
            field
        });
        let submit = cx.subscribe(&address, |this, address, _: &Submit, cx| {
            let url = normalize(&address.read(cx).text);
            if !url.is_empty() {
                this.load_current(&url, cx);
            }
            // Submit is emitted in the address key handler. Blur after dispatch,
            // just as classic's Enter handler does, without stealing page focus.
            this.blur_address = true;
            cx.notify();
        });
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
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
            tabs: vec![],
            active: None,
            next_id: 1,
            pages: HashMap::new(),
            covered: false,
            focus: cx.focus_handle(),
            copied: None,
            agent_glow: None,
            editing: false,
            blur_address: false,
            in_header: false,
            focus_observed: false,
            window: None,
            seeded: false,
            previews: vec![],
            last_saved: (vec![], None),
            favicons: HashMap::new(),
            favicon_loading: 0,
            _subscriptions: vec![submit],
        }
    }
    pub fn configure(
        &mut self,
        saved: Option<Snapshot>,
        client: crate::client::Client,
        cx: &mut Context<Self>,
    ) {
        self.in_header = true;
        if let Some(saved) = saved {
            self.restore(saved, cx);
        }
        cx.spawn(async move |this, cx| {
            loop {
                let client = client.clone();
                let result = cx
                    .background_executor()
                    .spawn(async move { client.get::<serde_json::Value>("/api/panel/ports", &[]) })
                    .await;
                if this
                    .update(cx, |this, cx| {
                        if let Ok(body) = result {
                            let previews: Vec<u16> = body["ports"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|port| port["kind"] == "page")
                                .filter_map(|port| u16::try_from(port["port"].as_u64()?).ok())
                                .filter(|port| *port != 0)
                                .collect();
                            this.set_previews(previews, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(5)).await;
            }
        })
        .detach();
    }
    fn restore(&mut self, saved: Snapshot, cx: &mut Context<Self>) {
        let saved = saved.restored();
        self.seeded = true;
        self.tabs = saved.tabs;
        self.active = saved.active;
        self.next_id = self
            .tabs
            .iter()
            .map(|t| t.id)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        for tab in &self.tabs {
            let page = Page::default();
            if !tab.url.is_empty() {
                *page.pending.borrow_mut() = Some(tab.url.clone());
            }
            self.pages.insert(tab.id, page);
        }
        self.last_saved = (self.tabs.clone(), self.active);
        self.sync_address(cx);
        self.publish(cx);
        cx.notify();
    }
    fn set_previews(&mut self, previews: Vec<u16>, cx: &mut Context<Self>) {
        if !self.seeded && !previews.is_empty() {
            for port in &previews {
                self.add(format!("http://localhost:{port}"), cx);
            }
            if let Some(id) = self.tabs.first().map(|t| t.id) {
                self.select(id, cx);
            }
        }
        if self.previews != previews {
            self.previews = previews;
            cx.notify();
        }
    }
    fn publish(&mut self, cx: &mut Context<Self>) {
        let current = (self.tabs.clone(), self.active);
        if self.seeded && current != self.last_saved {
            self.last_saved = current;
            cx.emit(PagesChanged(Snapshot::durable(&self.tabs, self.active)));
        }
    }
    fn request_favicons(&mut self, cx: &mut Context<Self>) {
        let hosts: std::collections::BTreeSet<_> = self
            .tabs
            .iter()
            .filter_map(|tab| favicon::host(&tab.url))
            .collect();
        self.favicons.retain(|host, _| hosts.contains(host));
        for host in hosts.into_iter().take(64) {
            if self.favicon_loading >= 4 {
                break;
            }
            if self.favicons.contains_key(&host) {
                continue;
            }
            self.favicons.insert(host.clone(), None);
            self.favicon_loading += 1;
            cx.spawn(async move |this, cx| {
                let requested = host.clone();
                let image = cx
                    .background_executor()
                    .spawn(async move { favicon::fetch(requested) })
                    .await;
                let _ = this.update(cx, |this, cx| {
                    this.favicon_loading = this.favicon_loading.saturating_sub(1);
                    if let Some(slot) = this.favicons.get_mut(&host) {
                        *slot = image.map(std::sync::Arc::new);
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
    fn focus_chrome(&self) {
        for page in self.pages.values() {
            if let Some(web) = page.web.borrow().as_ref() {
                web.focus_chrome();
                break;
            }
        }
    }

    /// Read-only adapter for the panel header page label.
    pub(crate) fn chrome_location(&self, cx: &gpui::App) -> String {
        self.address.read(cx).text.clone()
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus_chrome();
        self.address_focus.focus(window);
    }
    pub fn cover(&mut self, covered: bool) {
        self.covered = covered;
        if covered {
            self.hide_pages();
        }
    }
    fn hide_pages(&self) {
        for page in self.pages.values() {
            if let Some(web) = page.web.borrow().as_ref() {
                web.hide();
            }
        }
    }
    fn current(&self) -> Option<&Tab> {
        self.tabs.iter().find(|tab| Some(tab.id) == self.active)
    }
    fn sync_address(&self, cx: &mut Context<Self>) {
        let url = self.current().map_or("", |tab| tab.url.as_str());
        self.address.update(cx, |field, cx| field.set_text(url, cx));
    }
    fn add(&mut self, url: String, cx: &mut Context<Self>) {
        self.seeded = true;
        self.hide_pages();
        let id = self.next_id;
        self.next_id += 1;
        self.tabs.push(Tab {
            id,
            title: model::title(&url),
            url: String::new(),
            redacted: false,
        });
        self.pages.insert(id, Page::default());
        self.active = Some(id);
        if !url.is_empty() {
            self.load_current(&url, cx);
        }
        self.sync_address(cx);
        self.publish(cx);
        cx.notify();
    }
    pub fn new_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add(String::new(), cx);
        self.focus(window);
    }
    fn select(&mut self, id: u64, cx: &mut Context<Self>) {
        if !self.tabs.iter().any(|tab| tab.id == id) {
            return;
        }
        self.hide_pages();
        self.active = Some(id);
        self.sync_address(cx);
        self.publish(cx);
        cx.notify();
    }
    fn close(&mut self, id: u64, cx: &mut Context<Self>) {
        self.hide_pages();
        self.pages.remove(&id);
        model::close(&mut self.tabs, &mut self.active, id);
        self.sync_address(cx);
        self.publish(cx);
        cx.notify();
    }
    /// External navigation focuses an existing URL or opens a new page, as classic does.
    pub fn navigate(&mut self, raw: &str, cx: &mut Context<Self>) {
        let url = normalize(raw);
        if url.is_empty() {
            return;
        }
        if let Some(id) = self
            .tabs
            .iter()
            .find(|tab| tab.url == url)
            .map(|tab| tab.id)
        {
            self.select(id, cx);
        } else {
            self.add(url, cx);
        }
    }
    pub fn agent_navigate(&mut self, raw: &str, cx: &mut Context<Self>) {
        self.navigate(raw, cx);
        self.agent_glow = Some(Instant::now());
        cx.notify();
    }
    fn load_current(&mut self, url: &str, cx: &mut Context<Self>) {
        let Some(id) = self.active else {
            return;
        };
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) {
            tab.url = url.into();
            tab.title = model::title(url);
            tab.redacted = false;
        }
        if let Some(page) = self.pages.get_mut(&id) {
            page.error = None;
            page.creation_failed.set(false);
            page.loading = cfg!(target_os = "macos");
            match page.web.borrow().as_ref() {
                Some(web) => web.load(url),
                None => *page.pending.borrow_mut() = Some(url.into()),
            }
        }
        self.copied = None;
        self.sync_address(cx);
        self.publish(cx);
        cx.notify();
    }
    fn follow(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        let mut popups = vec![];
        for tab in &mut self.tabs {
            let Some(page) = self.pages.get_mut(&tab.id) else {
                continue;
            };
            if page.creation_failed.get() && page.error.is_none() {
                page.error = Some("Could not create a browser view. Reload to try again, or open this page in your browser.".into());
                page.loading = false;
                changed = true;
            }
            let owned = page.web.clone();
            let slot = owned.borrow();
            let Some(web) = slot.as_ref() else {
                continue;
            };
            let status = web.status();
            if page.observe_status(tab, status) {
                changed = true;
            }
            if page.error.is_some() {
                web.hide();
            }
            popups.extend(web.take_popups());
        }
        for url in popups {
            self.navigate(&url, cx);
            changed = true;
        }
        let native_focus = self
            .active
            .and_then(|id| self.pages.get(&id))
            .is_some_and(|page| page.web.borrow().as_ref().is_some_and(web::Web::is_focused));
        if native_focus && self.editing {
            self.editing = false;
            if let Some(window) = self.window {
                let focus = self.focus.clone();
                cx.defer(move |cx| {
                    let _ = window.update(cx, |_, window, _| focus.focus(window));
                });
            }
            changed = true;
        }
        // Never replace an unsubmitted draft. IME-only suppression loses ordinary typing.
        let focused = self.editing;
        if !focused
            && !self.address.read(cx).text.chars().eq(self
                .current()
                .map_or("", |tab| tab.url.as_str())
                .chars()
                .filter(|ch| !matches!(ch, '\r' | '\n')))
        {
            self.sync_address(cx);
        }
        if self
            .copied
            .is_some_and(|at| at.elapsed() >= Duration::from_millis(1200))
        {
            self.copied = None;
            changed = true;
        }
        if self
            .agent_glow
            .is_some_and(|at| at.elapsed() >= Duration::from_millis(1300))
        {
            self.agent_glow = None;
            changed = true;
        }
        if changed {
            self.publish(cx);
            cx.notify();
        }
    }
    fn act(&mut self, action: fn(&web::Web), cx: &mut Context<Self>) {
        if let Some(page) = self.active.and_then(|id| self.pages.get_mut(&id)) {
            page.error = None;
            page.creation_failed.set(false);
            if let Some(web) = page.web.borrow().as_ref() {
                action(web);
            }
        }
        cx.notify();
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self
            .active
            .and_then(|id| self.pages.get(&id))
            .is_some_and(|page| page.error.is_some())
        {
            if let Some(url) = self.current().map(|tab| tab.url.clone()) {
                self.load_current(&url, cx);
            }
        } else {
            self.act(web::Web::reload, cx);
        }
    }
    fn copy_url(&mut self, cx: &mut Context<Self>) {
        if let Some(tab) = self.current().filter(|tab| !tab.url.is_empty()) {
            cx.write_to_clipboard(ClipboardItem::new_string(tab.url.clone()));
            self.copied = Some(Instant::now());
            cx.notify();
        }
    }
    fn external(&self, cx: &mut Context<Self>) {
        if let Some(tab) = self.current().filter(|tab| !tab.url.is_empty()) {
            cx.open_url(&tab.url);
        }
    }
}
#[cfg(test)]
mod tests;
