use super::*;
#[derive(Default)]
pub(super) struct Pages {
    scopes: std::collections::HashMap<String, Scope>,
    next: u64,
}
#[derive(Default)]
struct Scope {
    entries: Vec<u64>,
    active: usize,
}
fn scope(s: &Shell) -> String {
    s.state.selected.clone().unwrap_or_default()
}
fn page_key(s: &Shell, id: u64) -> String {
    format!("{}|page-{id}", key(s, Tool::Browser))
}
pub(super) fn ensure(s: &mut Shell, cx: &mut Context<Shell>) {
    let scope = scope(s);
    if s.features
        .get::<Panel>()
        .pages
        .scopes
        .get(&scope)
        .is_some_and(|p| !p.entries.is_empty())
    {
        return;
    }
    let base = key(s, Tool::Browser);
    let view = s
        .features
        .get::<Panel>()
        .browsers
        .get(&base)
        .cloned()
        .unwrap_or_else(|| cx.new(crate::browser_panel::BrowserPanel::new));
    let p = s.features.get::<Panel>();
    let id = p.pages.next;
    p.pages.next += 1;
    p.pages.scopes.insert(
        scope,
        Scope {
            entries: vec![id],
            active: 0,
        },
    );
    let k = page_key(s, id);
    s.features.get::<Panel>().browsers.insert(k, view.clone());
    let k = key(s, Tool::Browser);
    s.features.get::<Panel>().browsers.insert(k, view);
}
pub(super) fn new_page(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    show(s, Tool::Browser, w, cx);
    let scope = scope(s);
    let p = s.features.get::<Panel>();
    let id = p.pages.next;
    p.pages.next += 1;
    let pages = p.pages.scopes.entry(scope).or_default();
    pages.entries.push(id);
    pages.active = pages.entries.len() - 1;
    let view = cx.new(crate::browser_panel::BrowserPanel::new);
    view.read(cx).focus(w);
    let k = page_key(s, id);
    s.features.get::<Panel>().browsers.insert(k, view.clone());
    let k = key(s, Tool::Browser);
    s.features.get::<Panel>().browsers.insert(k, view);
    cx.notify();
}
fn select(s: &mut Shell, id: u64, w: &mut Window, cx: &mut Context<Shell>) {
    let k = page_key(s, id);
    let view = s.features.get::<Panel>().browsers.get(&k).cloned();
    let scope = scope(s);
    if let Some(p) = s.features.get::<Panel>().pages.scopes.get_mut(&scope) {
        p.active = p.entries.iter().position(|v| *v == id).unwrap_or(0)
    }
    if let Some(view) = view {
        let k = key(s, Tool::Browser);
        s.features.get::<Panel>().browsers.insert(k, view);
        show(s, Tool::Browser, w, cx)
    }
    cx.notify();
}
fn close(s: &mut Shell, id: u64, w: &mut Window, cx: &mut Context<Shell>) {
    let scope = scope(s);
    let p = s
        .features
        .get::<Panel>()
        .pages
        .scopes
        .get_mut(&scope)
        .unwrap();
    let index = p.entries.iter().position(|v| *v == id).unwrap();
    p.entries.remove(index);
    if index < p.active || p.active == p.entries.len() {
        p.active = p.active.saturating_sub(1)
    }
    let next = p.entries.get(p.active).copied();
    let k = page_key(s, id);
    s.features.get::<Panel>().browsers.remove(&k);
    if let Some(next) = next {
        select(s, next, w, cx)
    } else {
        let k = key(s, Tool::Browser);
        s.features.get::<Panel>().browsers.remove(&k);
        show(s, Tool::Launcher, w, cx)
    }
}
#[derive(Clone)]
struct DragPage(u64);
impl Render for DragPage {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child("Browser page")
    }
}
pub(super) fn tabs(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let Some(pages) = p.pages.scopes.get(&scope(s)) else {
        return div().into_any_element();
    };
    let count = pages.entries.len();
    div()
        .id("panel-browser-pages")
        .debug_selector(|| "panel-browser-pages".into())
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .items_center()
        .gap(px(4.))
        .overflow_x_scroll()
        .children(pages.entries.iter().enumerate().map(|(index, id)| {
            let id = *id;
            let active = index == pages.active;
            let k = page_key(s, id);
            let location = p
                .browsers
                .get(&k)
                .map(|v| v.read(cx).chrome_location(cx))
                .unwrap_or_default();
            let label = if location.is_empty() {
                "New Tab".into()
            } else {
                url::Url::parse(&location)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or(location)
            };
            div()
                .id(("browser-page", id as usize))
                .debug_selector(move || format!("panel-browser-page-{index}"))
                .h(px(22.))
                .max_w(px(if count <= 2 {
                    180.
                } else if count <= 4 {
                    120.
                } else if active {
                    140.
                } else {
                    30.
                }))
                .flex_shrink_0()
                .flex()
                .items_center()
                .rounded(px(6.))
                .when(active, |v| v.bg(theme().selection))
                .child(
                    chrome::button(
                        s,
                        format!("browser-page-select-{id}"),
                        label.clone(),
                        cx,
                        move |s, w, cx| select(s, id, w, cx),
                    )
                    .h(px(22.))
                    .px(px(6.))
                    .gap(px(6.))
                    .text_size(px(11.5))
                    .child(crate::icon::stroke(BROWSER, theme().text_muted, 12., 1.6))
                    .when(count <= 4 || active, |v| v.child(label)),
                )
                .child(
                    chrome::button(
                        s,
                        format!("browser-page-close-{id}"),
                        "Close browser page",
                        cx,
                        move |s, w, cx| close(s, id, w, cx),
                    )
                    .size(px(16.))
                    .child(crate::icon::stroke(
                        "M6 6l12 12M18 6 6 18",
                        theme().text_muted,
                        10.,
                        2.,
                    )),
                )
                .on_drag(DragPage(id), |v, _, _, cx| cx.new(|_| v.clone()))
                .on_drop(cx.listener(move |s, d: &DragPage, _, cx| {
                    let scope = scope(s);
                    let pages = s
                        .features
                        .get::<Panel>()
                        .pages
                        .scopes
                        .get_mut(&scope)
                        .unwrap();
                    let active = pages.entries[pages.active];
                    if let (Some(from), Some(to)) = (
                        pages.entries.iter().position(|v| *v == d.0),
                        pages.entries.iter().position(|v| *v == id),
                    ) {
                        let value = pages.entries.remove(from);
                        pages.entries.insert(to, value);
                        pages.active = pages.entries.iter().position(|v| *v == active).unwrap();
                        cx.notify()
                    }
                }))
        }))
        .into_any_element()
}
