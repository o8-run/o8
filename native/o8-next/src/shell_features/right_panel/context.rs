use super::*;
use serde_json::{Value, json};
#[derive(Default)]
pub(super) struct Contexts {
    pub approvals: usize,
    pending: bool,
    next: Option<std::time::Instant>,
    comparison_next: Option<std::time::Instant>,
    prs: std::collections::HashMap<String, gpui::AnyView>,
    list: Option<(String, gpui::AnyView)>,
    order: Vec<(String, u64)>,
    selected: Option<(String, u64)>,
    comparison: Option<gpui::AnyView>,
}
fn background<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> async_channel::Receiver<T> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(work());
    });
    rx
}
pub(super) fn refresh(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    let panel = s.features.get::<Panel>();
    if panel.motion.is_open()
        && (panel.selected == Tool::Compare || panel.lower == Some(Tool::Compare))
        && panel
            .contexts
            .comparison_next
            .is_none_or(|at| at <= std::time::Instant::now())
    {
        panel.contexts.comparison_next = Some(std::time::Instant::now() + Duration::from_secs(5));
        ensure_comparison(s, w, cx);
    }
    let state = &mut s.features.get::<Panel>().contexts;
    if state.pending || state.next.is_some_and(|at| at > std::time::Instant::now()) {
        return;
    }
    state.pending = true;
    state.next = Some(std::time::Instant::now() + Duration::from_secs(15));
    let client = s.client.clone();
    let rx = background(move || {
        client.get::<Value>(
            "/api/panel/approvals",
            &[("status", "pending"), ("scope", "all")],
        )
    });
    cx.spawn(async move |this, cx| {
        if let Ok(result) = rx.recv().await {
            let _ = this.update(cx, |s, cx| {
                let state = &mut s.features.get::<Panel>().contexts;
                state.pending = false;
                if let Ok(v) = result {
                    state.approvals = v["approvals"].as_array().map_or(0, |a| a.len());
                }
                cx.notify();
            });
        }
    })
    .detach();
}
fn registered_view(
    s: &mut Shell,
    request: &Value,
    w: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<gpui::AnyView> {
    registrations()
        .iter()
        .find(|r| r.tab_label == "Pull requests")
        .and_then(|r| (r.panel_view)(s, request, w, cx))
}
pub(super) fn ensure_prs(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    let workspace = s.state.selected.clone().unwrap_or_default();
    // A restored tab gets its view the first time pull requests show.
    if let Some((repo, number)) = unopened(s) {
        let request = json!({"repo":repo,"number":number});
        if let Some(view) = registered_view(s, &request, w, cx) {
            let prs = &mut s.features.get::<Panel>().contexts.prs;
            prs.insert(format!("{repo}#{number}"), view);
        }
    }
    if s.features.get::<Panel>().contexts.selected.is_some() {
        return;
    }
    if let Some(view) = registered_view(s, &Value::Null, w, cx) {
        s.features.get::<Panel>().contexts.list = Some((workspace, view));
    }
}
pub(super) fn open_pr(
    s: &mut Shell,
    repo: String,
    number: u64,
    w: &mut Window,
    cx: &mut Context<Shell>,
) {
    let id = format!("{repo}#{number}");
    if !s.features.get::<Panel>().contexts.prs.contains_key(&id) {
        let Some(view) = registered_view(s, &json!({"repo":repo,"number":number}), w, cx) else {
            toasts::info("Pull requests are unavailable.", cx);
            cx.notify();
            return;
        };
        s.features.get::<Panel>().contexts.prs.insert(id, view);
    }
    let state = &mut s.features.get::<Panel>().contexts;
    if !state.order.contains(&(repo.clone(), number)) {
        state.order.push((repo.clone(), number));
    }
    state.selected = Some((repo, number));
    show(s, Tool::Prs, w, cx);
}
/// The open pull request tabs and the shown one, as saved state keys.
pub(super) fn saved(s: &mut Shell) -> (Vec<String>, Option<String>) {
    let state = &s.features.get::<Panel>().contexts;
    let key = |(repo, n): &(String, u64)| format!("{repo}#{n}");
    (
        state.order.iter().map(key).collect(),
        state.selected.as_ref().map(key),
    )
}

/// Brings back a workspace's saved pull request tabs; the shown one opens
/// when the panel shows pull requests.
pub(super) fn restore(s: &mut Shell, tabs: &[String], selected: Option<&String>) {
    let parse = |key: &String| {
        let (repo, n) = key.rsplit_once('#')?;
        Some((repo.to_owned(), n.parse::<u64>().ok()?))
    };
    let state = &mut s.features.get::<Panel>().contexts;
    state.order = tabs.iter().filter_map(parse).collect();
    state.selected = selected
        .and_then(parse)
        .filter(|pr| state.order.contains(pr));
}

/// The shown pull request still waiting for its view after a restore.
pub(super) fn unopened(s: &mut Shell) -> Option<(String, u64)> {
    let state = &s.features.get::<Panel>().contexts;
    let (repo, n) = state.selected.clone()?;
    (!state.prs.contains_key(&format!("{repo}#{n}"))).then_some((repo, n))
}

pub(super) fn pr(s: &Shell, _: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    p.contexts
        .selected
        .as_ref()
        .and_then(|(repo, n)| p.contexts.prs.get(&format!("{repo}#{n}")))
        .map(|v| v.clone().into_any_element())
        .or_else(|| {
            p.contexts
                .list
                .as_ref()
                .map(|(_, v)| v.clone().into_any_element())
        })
        .unwrap_or_else(|| {
            div()
                .child("Select a pull request to review it here.")
                .into_any_element()
        })
}
pub(super) fn tabs(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(4.))
        .id("panel-pr-tabs")
        .overflow_x_scroll()
        .children(p.contexts.order.iter().map(|(repo, number)| {
            let (repo, number) = (repo.clone(), *number);
            let close_repo = repo.clone();
            div()
                .flex_shrink_0()
                .h(px(28.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .when(
                    p.selected == Tool::Prs
                        && p.contexts.selected.as_ref() == Some(&(repo.clone(), number)),
                    |v| v.bg(theme().selection),
                )
                .child(
                    chrome::button(
                        s,
                        format!("panel-pr-{repo}-{number}"),
                        format!("PR #{number} in {repo}"),
                        cx,
                        move |s, w, cx| open_pr(s, repo.clone(), number, w, cx),
                    )
                    .h(px(28.))
                    .px(px(8.))
                    .child(format!("#{number}")),
                )
                .child(
                    chrome::button(
                        s,
                        format!("panel-pr-close-{close_repo}-{number}"),
                        "Close pull request",
                        cx,
                        move |s, w, cx| {
                            let state = &mut s.features.get::<Panel>().contexts;
                            state.order.retain(|v| v != &(close_repo.clone(), number));
                            let next = state.order.last().cloned();
                            state.selected = next.clone();
                            if let Some((repo, n)) = next {
                                open_pr(s, repo, n, w, cx)
                            } else {
                                show(s, Tool::Activity, w, cx)
                            }
                        },
                    )
                    .size(px(24.))
                    .child(crate::icon::stroke(
                        "M6 6l12 12M18 6 6 18",
                        theme().text_muted,
                        10.,
                        2.,
                    )),
                )
        }))
        .into_any_element()
}
pub(super) fn ensure_comparison(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    let view = registered_view(s, &json!({"comparison": true}), w, cx);
    s.features.get::<Panel>().contexts.comparison = view;
}
pub(super) fn comparison(s: &Shell, _: &mut Context<Shell>) -> AnyElement {
    s.features
        .read::<Panel>()
        .and_then(|p| p.contexts.comparison.clone())
        .map(|v| v.into_any_element())
        .unwrap_or_else(|| div().child("Compare is unavailable.").into_any_element())
}
