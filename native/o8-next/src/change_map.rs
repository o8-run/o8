//! Shared review disclosure. Evidence is computed by the classic review routes.
use crate::{client::Client, theme::current as theme};
use gpui::{AnyElement, Context, SharedString, div, prelude::*, px};
use serde_json::{Value, json};
use std::rc::Rc;

#[derive(Clone, Default)]
pub(crate) struct ChangeMap {
    pub(crate) delta: Value,
    pub(crate) attention: Value,
    pub(crate) error: Option<String>,
    pub(crate) expanded: bool,
    pub(crate) selected: Vec<String>,
}
#[derive(Clone)]
pub(crate) enum Command {
    Toggle,
    Select(Vec<String>),
    Focus(String),
    Clear,
}
impl ChangeMap {
    pub(crate) fn bind_revision(
        &mut self,
        mut query: Vec<(String, String)>,
        revision: Option<&str>,
    ) -> Option<Vec<(String, String)>> {
        let Some(revision) =
            revision.filter(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_hexdigit()))
        else {
            self.error =
                Some("Change map unavailable: refresh the diff to verify its revision.".into());
            return None;
        };
        query.push(("expectedRevision".into(), revision.to_lowercase()));
        Some(query)
    }
    pub(crate) fn read(client: &Client, query: &[(String, String)], paths: &[String]) -> Self {
        let query: Vec<_> = query
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let mut map = Self::default();
        match client.get_explained::<Value>("/api/review/architecture-delta", &query) {
            Ok(v) if v["ok"] == true => {
                let expected = query
                    .iter()
                    .find(|(k, _)| *k == "expectedRevision")
                    .map(|(_, v)| *v);
                if expected.is_some_and(|r| v["reviewRevision"].as_str() != Some(r)) {
                    map.error = Some("Change map unavailable: the review revision could not be verified. Refresh the diff.".into());
                } else {
                    map.delta = v;
                }
            }
            Ok(_) => map.error = Some("Change map unavailable. Refresh to try again.".into()),
            Err(e) => map.error = Some(e),
        }
        if map.delta["status"] == "ready" && !paths.is_empty() {
            let body = json!({"expectedAnalysisId":map.delta["analysisId"],"scopePaths":paths});
            match client.activity_request(
                "POST",
                "/api/review/architecture-attention",
                &query,
                Some(&body),
            ) {
                Ok(v) if v["ok"] == true && v["analysisId"] == map.delta["analysisId"] => {
                    map.attention = v
                }
                Ok(_) => {
                    map.error = Some("Attention evidence changed. Refresh the change map.".into())
                }
                Err(e) if e.status == Some(409) => {
                    map.delta = Value::Null;
                    map.error =
                        Some("Architecture evidence changed. Refresh the change map.".into());
                }
                Err(e) => map.error = Some(format!("Attention unavailable: {}", e.message)),
            }
        }
        map
    }
    pub(crate) fn load<T: 'static>(
        client: Client,
        query: Vec<(String, String)>,
        paths: Vec<String>,
        cx: &mut Context<T>,
        apply: impl FnOnce(&mut T, Self, &mut Context<T>) + 'static,
    ) {
        let task = cx
            .background_executor()
            .spawn(async move { Self::read(&client, &query, &paths) });
        cx.spawn(async move |this, cx| {
            let map = task.await;
            let _ = this.update(cx, |s, cx| apply(s, map, cx));
        })
        .detach();
    }
    pub(crate) fn summary(&self) -> String {
        if self.delta["status"] != "ready" {
            return self.delta["reason"]
                .as_str()
                .unwrap_or("Change map unavailable")
                .into();
        }
        let s = &self.delta["summary"];
        let count = |key: &str| s[key].as_u64().unwrap_or(0);
        let areas = self.attention["items"].as_array().map_or(0, Vec::len);
        let plural = |n: u64, one: &str, many: &str| {
            if n == 1 {
                one.to_owned()
            } else {
                many.to_owned()
            }
        };
        let attention = if self.attention["status"] == "ready" {
            format!(
                "{areas} {} {} attention",
                plural(areas as u64, "area", "areas"),
                if areas == 1 { "needs" } else { "need" }
            )
        } else {
            "attention unavailable".into()
        };
        format!(
            "{} {} touched, {} new {}, {} removed {}, {attention}",
            count("changedModules"),
            plural(count("changedModules"), "module", "modules"),
            count("addedEdges"),
            plural(count("addedEdges"), "dependency", "dependencies"),
            count("removedEdges"),
            plural(count("removedEdges"), "dependency", "dependencies")
        )
    }
    pub(crate) fn apply(&mut self, command: &Command) {
        match command {
            Command::Toggle => self.expanded = !self.expanded,
            Command::Select(paths) => self.selected = paths.clone(),
            Command::Focus(path) => {
                self.selected = vec![path.clone()];
                self.expanded = false;
            }
            Command::Clear => self.selected.clear(),
        }
    }
    pub(crate) fn keeps(&self, path: &str) -> bool {
        self.selected.is_empty() || self.selected.iter().any(|p| p == path)
    }
    pub(crate) fn view<T: 'static>(
        &self,
        id: &str,
        cx: &mut Context<T>,
        action: impl Fn(&mut T, Command, &mut Context<T>) + 'static,
    ) -> AnyElement {
        let action = Rc::new(action);
        let control = |key: String, label: String, command: Command, cx: &mut Context<T>| {
            let action = action.clone();
            let selector = key.clone();
            let keyboard = command.clone();
            let key_action = action.clone();
            div()
                .id(SharedString::from(key))
                .debug_selector(move || selector.clone())
                .focusable()
                .cursor_pointer()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .min_h(px(28.))
                .px(px(8.))
                .py(px(5.))
                .rounded(px(7.))
                .hover(|s| s.bg(theme().hover))
                .focus(|s| s.bg(theme().selection))
                .child(label)
                .on_click(cx.listener(move |s, _, _, cx| {
                    action(s, command.clone(), cx);
                    cx.stop_propagation();
                }))
                .on_key_down(cx.listener(move |s, e: &gpui::KeyDownEvent, _, cx| {
                    if matches!(e.keystroke.key.as_str(), "enter" | "space")
                        && !e.keystroke.modifiers.modified()
                    {
                        key_action(s, keyboard.clone(), cx);
                        cx.stop_propagation();
                    }
                }))
        };
        let summary = if self.delta.is_null() {
            self.error
                .clone()
                .unwrap_or_else(|| "Reading change map…".into())
        } else {
            self.summary()
        };
        let summary_tip = summary.clone();
        let mut view = div()
            .id(SharedString::from(format!("{id}-change-map")))
            .min_w_0()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(6.))
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(11.))
            .text_color(theme().text_secondary)
            .child(
                control(
                    "change-map-summary".into(),
                    format!(
                        "{} Change map · {summary}",
                        if self.expanded { "⌄" } else { "›" }
                    ),
                    Command::Toggle,
                    cx,
                )
                .tooltip(move |_, cx| {
                    cx.new(|_| crate::icon::Tip(summary_tip.clone().into()))
                        .into()
                }),
            );
        if self.expanded {
            let mut details = div()
                .id(SharedString::from(format!("{id}-details")))
                .min_w_0()
                .max_h(px(300.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(6.));
            let nodes = self.delta["nodes"].as_array().cloned().unwrap_or_default();
            if nodes.is_empty() {
                details = details.child(
                    div()
                        .px(px(8.))
                        .debug_selector(|| "change-map-empty".into())
                        .child(if self.delta.is_null() {
                            self.error
                                .clone()
                                .unwrap_or_else(|| "Reading change map…".into())
                        } else {
                            self.delta["reason"]
                                .as_str()
                                .unwrap_or("No architectural effect in this change.")
                                .to_owned()
                        }),
                );
            } else {
                let paths: Vec<_> = nodes
                    .iter()
                    .map(|n| n["path"].as_str().unwrap_or("").to_owned())
                    .collect();
                let edges: Vec<_> = self.delta["edges"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| {
                        Some((
                            paths
                                .iter()
                                .position(|p| Some(p.as_str()) == e["from"].as_str())?,
                            paths
                                .iter()
                                .position(|p| Some(p.as_str()) == e["to"].as_str())?,
                            e["state"].as_str().unwrap_or("context").to_owned(),
                        ))
                    })
                    .collect();
                let drawing = crate::transcript_diagram::change_map::drawing(nodes.len(), edges);
                let mut graph = div()
                    .debug_selector(|| "change-map-graph".into())
                    .relative()
                    .min_w_0()
                    .child(drawing);
                let mut rows = div().relative().flex().flex_col().pl(px(38.)).pr(px(8.));
                for (index, node) in nodes.iter().enumerate() {
                    let path = paths[index].clone();
                    let mut focus: Vec<String> = node["focusPath"]
                        .as_str()
                        .map(|p| vec![p.into()])
                        .unwrap_or_default();
                    // A context node selects the changed files that reference it.
                    if focus.is_empty() {
                        for edge in self.delta["edges"].as_array().into_iter().flatten() {
                            if edge["from"] == path || edge["to"] == path {
                                if let Some(p) = edge["focusPath"].as_str() {
                                    focus.push(p.into());
                                }
                            }
                        }
                    }
                    if focus.is_empty() {
                        focus.push(path.clone());
                    }
                    let active = !self.selected.is_empty()
                        && focus.iter().any(|p| self.selected.contains(p));
                    let tip = path.clone();
                    let (name, directory) = path
                        .rsplit_once('/')
                        .map(|(d, n)| (n, d))
                        .unwrap_or((&path, "."));
                    rows = rows.child(
                        div().h(px(36.)).min_w_0().py(px(2.)).child(
                            control(
                                format!("change-map-node-{index}"),
                                format!(
                                    "{} · {name} · {directory}",
                                    node["state"].as_str().unwrap_or("context"),
                                ),
                                Command::Select(focus),
                                cx,
                            )
                            .text_size(px(13.5))
                            .when(active, |s| s.bg(theme().selection))
                            .when(!self.selected.is_empty() && !active, |s| s.opacity(0.6))
                            .tooltip(move |_, cx| {
                                cx.new(|_| crate::icon::Tip(tip.clone().into())).into()
                            }),
                        ),
                    );
                }
                graph = graph.child(rows);
                details = details.child(graph.flex_shrink_0());
                details = details.child(
                    div()
                        .px(px(8.))
                        .text_color(theme().text_muted)
                        .child("Dependencies: green added · red removed · muted existing"),
                );
            }
            for (index, edge) in self.delta["edges"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter(|(_, e)| e["state"] != "context")
            {
                let from = edge["from"].as_str().unwrap_or("");
                let to = edge["to"].as_str().unwrap_or("");
                let mark = if edge["state"] == "added" { "+" } else { "−" };
                let paths = edge["focusPath"]
                    .as_str()
                    .map(|p| vec![p.to_owned()])
                    .unwrap_or_else(|| vec![from.into()]);
                let tip = format!("{mark} {from} → {to}");
                details = details.child(
                    control(
                        format!("{id}-edge-{index}"),
                        format!(
                            "{mark} {} → {}",
                            from.rsplit('/').next().unwrap_or(from),
                            to.rsplit('/').next().unwrap_or(to)
                        ),
                        Command::Select(paths),
                        cx,
                    )
                    .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone().into())).into()),
                );
            }
            for (key, label) in [
                ("unsupportedPaths", "Unsupported files"),
                ("omittedPaths", "Omitted files"),
                ("resolutionWarnings", "Resolution warnings"),
            ] {
                let count = self.delta[key].as_array().map_or(0, Vec::len);
                if count > 0 {
                    details = details.child(div().px(px(8.)).child(format!("{label}: {count}")));
                }
            }
            if self.delta["truncated"] == true {
                details = details.child(
                    div()
                        .px(px(8.))
                        .text_color(theme().warning)
                        .child("Partial map: some architecture evidence was omitted."),
                );
            }
            for item in self.attention["items"].as_array().into_iter().flatten() {
                if let Some(path) = item["reviewPath"].as_str() {
                    let tip = path.to_owned();
                    details = details.child(
                        control(
                            format!("{id}-attention-{path}"),
                            format!(
                                "{} · {} · advisory",
                                path.rsplit('/').next().unwrap_or(path),
                                match item["lens"].as_str().unwrap_or("general") {
                                    "auth_trust" => "Auth and trust",
                                    "state_persistence" => "State and persistence",
                                    "async_lifecycle" => "Async lifecycle",
                                    "interface_contract" => "API and contracts",
                                    "ui_behavior" => "UI behavior",
                                    "tests_docs" => "Tests and docs",
                                    _ => "General review",
                                }
                            ),
                            Command::Focus(path.into()),
                            cx,
                        )
                        .tooltip(move |_, cx| {
                            cx.new(|_| crate::icon::Tip(tip.clone().into())).into()
                        }),
                    );
                }
            }
            for note in [self.error.as_deref(), self.attention["reason"].as_str()]
                .into_iter()
                .flatten()
            {
                details = details.child(
                    div()
                        .px(px(8.))
                        .text_color(theme().text_muted)
                        .child(note.to_owned()),
                );
            }
            view = view.child(details);
        }
        if !self.selected.is_empty() {
            view = view.child(control(
                format!("{id}-clear"),
                "Show all files".into(),
                Command::Clear,
                cx,
            ));
        }
        view.into_any_element()
    }
}
