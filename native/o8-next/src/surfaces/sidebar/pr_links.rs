//! PR links on thread rows, after T3 Code's sidebar: a row with linked pull
//! requests shows a PR glyph with the number (one PR) or a count (several);
//! hovering lists each PR. A click opens the PR in the right panel's viewer,
//! Cmd/Ctrl-click opens it on GitHub. Reimplemented; no code shared.
//!
//! Links are the server's explicit conversation PR context
//! (GET /api/orchestrator/pull-request-context?threadId=…, table
//! conversation_pr_context), refreshed at most once a minute for listed
//! conversations.
//!
//! Dev only: O8_DEV_SIDEBAR_PR_LINKS may name a JSON file of
//! `{ "<threadId>": [{ "repositoryFullName", "number", "title"?, "state"? }] }`
//! that is merged over the server's links, to show the badge without writing
//! links into a real ~/.o8. It is read only when that variable is set.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Corner, MouseButton, Pixels, Point, anchored, deferred, div, px};

/// Lucide git-pull-request.
const PR_ICON: &str =
    "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12";
pub(super) const DEV_FIXTURE_ENV: &str = "O8_DEV_SIDEBAR_PR_LINKS";
const REFRESH: Duration = Duration::from_secs(60);
/// Conversations asked about per refresh; the list shows fewer.
const MAX_THREADS: usize = 60;

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLink {
    pub repository_full_name: String,
    pub number: u64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}
impl PrLink {
    pub fn url(&self) -> String {
        format!("https://github.com/{}/pull/{}", self.repository_full_name, self.number)
    }
    fn valid(&self) -> bool {
        self.number > 0
            && self.repository_full_name.split('/').count() == 2
            && self
                .repository_full_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_.-".contains(c))
    }
}

pub(super) struct PrHover {
    pub id: String,
    pub position: Point<Pixels>,
    pub over_list: bool,
}

/// The badge's text: the number for one PR, "+n" for several (as T3 does).
pub(crate) fn badge_text(links: &[PrLink]) -> String {
    match links {
        [one] => one.number.to_string(),
        many => format!("+{}", many.len()),
    }
}

fn fixture() -> HashMap<String, Vec<PrLink>> {
    let Some(path) = std::env::var_os(DEV_FIXTURE_ENV) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Each listed conversation's links. A failed read leaves that thread out,
/// so its previous links stay until a read succeeds.
pub(super) fn fetch(client: &Client, ids: &[String]) -> HashMap<String, Vec<PrLink>> {
    let mut links = HashMap::new();
    for id in ids.iter().filter(|id| id.starts_with("thoughts-")).take(MAX_THREADS) {
        let Ok(body) = client.get::<Value>(
            "/api/orchestrator/pull-request-context",
            &[("threadId", id.as_str()), ("limit", "20")],
        ) else {
            continue;
        };
        let list: Vec<PrLink> = serde_json::from_value(body["result"]["links"].clone()).unwrap_or_default();
        links.insert(id.clone(), list);
    }
    for (id, list) in fixture() {
        links.insert(id, list);
    }
    for list in links.values_mut() {
        list.retain(PrLink::valid);
        let mut seen = HashSet::new();
        list.retain(|l| seen.insert((l.repository_full_name.to_lowercase(), l.number)));
    }
    links
}

fn state_color(state: Option<&str>) -> gpui::Rgba {
    match state.unwrap_or("").to_lowercase().as_str() {
        "merged" => theme().accent,
        "closed" => theme().danger,
        "open" => theme().success,
        _ => theme().text_muted,
    }
}

impl ThreadList {
    pub(super) fn pr_links_due(&self) -> bool {
        !self.pr_loading
            && !self.sessions.is_empty()
            && self.pr_links_at.is_none_or(|at| at.elapsed() >= REFRESH)
    }
    pub(super) fn load_pr_links(&mut self, cx: &mut Context<Self>) {
        self.pr_loading = true;
        let client = self.client.clone();
        let ids: Vec<String> = self.sessions.iter().map(|s| s.id.clone()).collect();
        let task = cx.background_executor().spawn(async move { fetch(&client, &ids) });
        cx.spawn(async move |this, cx| {
            let links = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pr_loading = false;
                this.pr_links_at = Some(Instant::now());
                this.pr_links.extend(links);
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn links_for(&self, id: &str) -> &[PrLink] {
        self.pr_links.get(id).map(Vec::as_slice).unwrap_or(&[])
    }
    /// Plain click: the right panel's PR viewer. Cmd/Ctrl-click: GitHub.
    pub(super) fn open_pr_link(&mut self, link: &PrLink, browser: bool, cx: &mut Context<Self>) {
        self.pr_hover = None;
        if browser {
            cx.open_url(&link.url());
        } else {
            cx.emit(Event::UiCommand(json!({
                "type": "ui-command",
                "kind": "symon-ui",
                "payload": {"event": "o8:ui-command", "data": {
                    "surface": "prs",
                    "repo": link.repository_full_name,
                    "number": link.number,
                }},
            })));
        }
        cx.notify();
    }
    fn close_hover_soon(&mut self, id: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(220)).await;
            let _ = this.update(cx, |this, cx| {
                if this.pr_hover.as_ref().is_some_and(|h| h.id == id && !h.over_list) {
                    this.pr_hover = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(super) fn pr_badge(&self, id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let links = self.links_for(id);
        if links.is_empty() {
            return None;
        }
        let color = if links.len() == 1 { state_color(links[0].state.as_deref()) } else { theme().text_secondary };
        let hover_id = id.to_owned();
        let click_links = links.to_vec();
        let selector = format!("thread-pr-badge-{id}");
        Some(
            div()
                .id(gpui::SharedString::from(selector.clone()))
                .debug_selector(move || selector.clone())
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(3.))
                .px(px(4.))
                .h(px(18.))
                .rounded(px(5.))
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .text_size(px(10.5))
                .text_color(color)
                .child(crate::icon::stroke(PR_ICON, color, 11., 1.8))
                .child(badge_text(links))
                .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                    if *hovered {
                        this.pr_hover = Some(PrHover {
                            id: hover_id.clone(),
                            position: window.mouse_position(),
                            over_list: false,
                        });
                        cx.notify();
                    } else {
                        this.close_hover_soon(hover_id.clone(), cx);
                    }
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        let browser = event.modifiers.platform || event.modifiers.control;
                        if let [one] = click_links.as_slice() {
                            this.open_pr_link(one, browser, cx);
                        } else if let Some(hover) = &mut this.pr_hover {
                            // Several: the hover list is the chooser; keep it open.
                            hover.over_list = true;
                            cx.notify();
                        }
                    }),
                )
                .into_any_element(),
        )
    }
    /// The hover list: one row per PR, `#number title`.
    pub(super) fn pr_hover_list(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let hover = self.pr_hover.as_ref()?;
        let links = self.links_for(&hover.id).to_vec();
        if links.is_empty() {
            return None;
        }
        let id = hover.id.clone();
        let mut list = div()
            .id("thread-pr-list")
            .debug_selector(|| "thread-pr-list".into())
            .occlude()
            .min_w(px(200.))
            .max_w(px(340.))
            .rounded(px(10.))
            .p(px(4.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if let Some(h) = this.pr_hover.as_mut().filter(|h| h.id == id) {
                    h.over_list = *hovered;
                }
                if !*hovered {
                    this.close_hover_soon(id.clone(), cx);
                }
            }))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.pr_hover = None;
                cx.notify();
            }));
        for (i, link) in links.into_iter().enumerate() {
            let color = state_color(link.state.as_deref());
            let title = link
                .title
                .as_deref()
                .filter(|t| !t.is_empty())
                .map(crate::text::sanitize)
                .unwrap_or_else(|| link.repository_full_name.clone());
            list = list.child(
                div()
                    .id(("thread-pr-item", i))
                    .debug_selector(move || format!("thread-pr-item-{i}"))
                    .h(px(24.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme().hover))
                    .text_size(px(11.5))
                    .child(crate::icon::stroke(PR_ICON, color, 11., 1.8))
                    .child(div().flex_shrink_0().text_color(color).child(format!("#{}", link.number)))
                    .child(div().min_w_0().text_ellipsis().whitespace_nowrap().text_color(theme().text).child(title))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            this.open_pr_link(&link, event.modifiers.platform || event.modifiers.control, cx);
                        }),
                    ),
            );
        }
        Some(
            deferred(
                anchored()
                    .position(hover.position + gpui::point(px(-8.), px(6.)))
                    .anchor(Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(list),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

#[cfg(test)]
impl ThreadList {
    pub(crate) fn set_pr_links(&mut self, id: &str, links: Vec<PrLink>) {
        self.pr_links.insert(id.to_owned(), links);
        // Keep the periodic read from racing the test's links.
        self.pr_links_at = Some(Instant::now());
    }
}
