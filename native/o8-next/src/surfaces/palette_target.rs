//! Keyboard target selection shared by hosted surfaces; requests stay in each port.
use super::*;
use crate::theme::current as theme;

pub(in crate::shell) struct Choice {
    pub id: String,
    pub label: String,
}
pub(in crate::shell) trait Port: 'static {
    type View: Render;
    const TITLE: &'static str;
    const EMPTY: &'static str;
    fn choices(client: &Client, workspace: &str) -> Result<Vec<Choice>, String>;
    fn create(
        client: Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self::View>,
    ) -> Self::View;
    fn tick(_view: &Entity<Self::View>, _cx: &mut Context<Shell>) {}
    /// The target a surface opens by itself when nothing is selected (the
    /// workspace's own shell). `None` keeps the picker.
    fn own(_client: &Client, _workspace: &str) -> Option<Result<String, String>> {
        None
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self::View>, cx: &App) -> bool;
}

enum OwnTarget {
    Unrequested,
    Pending,
    Unavailable,
    Ready(String),
    Failed(String),
}

// Creation and inventory are independent jobs. A labelled creation task also
// lets GPUI tests hold it while exercising real inventory and input callbacks.
static OWN_REQUEST: std::sync::LazyLock<gpui::TaskLabel> =
    std::sync::LazyLock::new(gpui::TaskLabel::new);

pub(in crate::shell) struct Picker<P: Port> {
    client: Client,
    workspace: String,
    pub selected: Option<String>,
    pub child: Option<Entity<P::View>>,
    choices: Vec<Choice>,
    focus: FocusHandle,
    child_focus: Option<FocusHandle>,
    query: String,
    choice: usize,
    loading: bool,
    failed: bool,
    requested: Option<String>,
    own: OwnTarget,
    /// Initial restoration and explicit creation retries may adopt. Listing or
    /// manually selecting a target cancels that intent, without losing the reply.
    open_own: bool,
    /// Inventory generations never invalidate an in-flight creation result.
    generation: u64,
}
impl<P: Port> Picker<P> {
    pub fn new(
        client: Client,
        workspace: String,
        selected: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self {
            client,
            workspace,
            selected: selected.clone(),
            child: None,
            choices: vec![],
            focus: cx.focus_handle(),
            child_focus: None,
            query: String::new(),
            choice: 0,
            loading: false,
            failed: false,
            requested: selected,
            own: OwnTarget::Unrequested,
            open_own: true,
            generation: 0,
        };
        view.load(cx);
        view
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if matches!(self.own, OwnTarget::Unrequested | OwnTarget::Failed(_)) {
            self.own = OwnTarget::Pending;
            self.open_own = true;
            let client = self.client.clone();
            let workspace = self.workspace.clone();
            let task = cx
                .background_executor()
                .spawn_labeled(*OWN_REQUEST, async move { P::own(&client, &workspace) });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |s, cx| {
                    // One creation at a time: refreshes coalesce while pending.
                    // Even a later list request must retain this result/error.
                    s.own = match result {
                        Some(Ok(id)) => OwnTarget::Ready(id),
                        Some(Err(error)) => OwnTarget::Failed(error),
                        None => OwnTarget::Unavailable,
                    };
                    s.merge_own();
                    cx.notify();
                });
            })
            .detach();
        }
        self.load_choices(cx);
    }
    fn load_choices(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.failed = false;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx
            .background_executor()
            .spawn(async move { P::choices(&client, &workspace) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                if generation != s.generation {
                    return;
                }
                s.loading = false;
                match result {
                    Ok(choices) => {
                        s.choices = choices;
                        s.merge_own();
                    }
                    Err(_) => s.failed = true,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn is_loading(&self) -> bool {
        self.loading || (self.open_own && matches!(self.own, OwnTarget::Pending))
    }
    fn own_error(&self) -> Option<&str> {
        match &self.own {
            OwnTarget::Failed(error) => Some(error),
            _ => None,
        }
    }
    fn merge_own(&mut self) {
        if let OwnTarget::Ready(id) = &self.own
            && !self.choices.iter().any(|choice| &choice.id == id)
        {
            self.choices.push(Choice {
                id: id.clone(),
                label: id.clone(),
            });
        }
        self.choices
            .sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
        self.choices.dedup_by(|a, b| a.id == b.id);
    }
    fn filtered(&self) -> Vec<usize> {
        let query = self.query.to_lowercase();
        self.choices
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.label.to_lowercase().contains(&query) || c.id.to_lowercase().contains(&query)
            })
            .map(|(i, _)| i)
            .collect()
    }
    fn attach(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if !self.choices.iter().any(|choice| choice.id == id) {
            self.selected = None;
            return;
        }
        self.open_own = false;
        self.requested = None;
        let client = self.client.clone();
        self.child = Some(cx.new(|cx| P::create(client, id.clone(), window, cx)));
        self.child_focus = window.focused(cx);
        self.selected = Some(id);
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && modifiers.alt && key == "o" {
            self.child = None;
            self.open_own = false;
            self.requested = None;
            self.child_focus = None;
            self.selected = None;
            self.query.clear();
            self.choice = 0;
            self.focus.focus(window);
            self.load_choices(cx);
        } else if self.child.is_some() {
            return;
        } else if key == "f5" {
            self.load(cx);
        } else if !modifiers.control && !modifiers.platform && !modifiers.alt {
            match key {
                "up" => self.choice = self.choice.saturating_sub(1),
                "down" => {
                    self.choice = (self.choice + 1).min(self.filtered().len().saturating_sub(1))
                }
                "backspace" => {
                    self.query.pop();
                    self.choice = 0;
                }
                "escape" => {
                    self.query.clear();
                    self.choice = 0;
                }
                "enter" if !self.is_loading() && !self.failed => {
                    if let Some(&index) = self.filtered().get(self.choice) {
                        self.attach(self.choices[index].id.clone(), window, cx);
                    }
                }
                _ => {
                    if let Some(text) = &event.keystroke.key_char {
                        self.query.push_str(text);
                        self.choice = 0;
                    }
                }
            }
        } else {
            return;
        }
        cx.notify();
        cx.stop_propagation();
    }
}
impl<P: Port> Render for Picker<P> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let loading = self.is_loading();
        if !loading && !self.failed && self.open_own {
            self.open_own = false;
            let own = match &self.own {
                OwnTarget::Ready(id) => Some(Ok(id.clone())),
                _ => None,
            };
            adopt(&mut self.choices, &mut self.requested, own);
            if let Some(id) = self.requested.take() {
                self.attach(id, window, cx);
            }
        }
        let choices = self.filtered();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(13.5))
            .font_weight(gpui::FontWeight::LIGHT)
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .when_some(self.child.clone(), |view, child| view.child(child))
            .when(self.child.is_none(), |view| {
                view.child(
                    div()
                        .id("target-picker")
                        .debug_selector(|| "target-picker".into())
                        .size_full()
                        .overflow_y_scroll()
                        .p(px(16.))
                        .child(if self.query.is_empty() {
                            P::TITLE.to_string()
                        } else {
                            self.query.clone()
                        })
                        .when(loading, |view| view.child("Loading…"))
                        .when_some(self.own_error().map(str::to_owned), |view, error| {
                            view.child(
                                div()
                                    .debug_selector(|| "target-own-error".into())
                                    .child(format!("Could not start one: {error}"))
                                    .child(
                                        div()
                                            .id("target-own-retry")
                                            .debug_selector(|| "target-own-retry".into())
                                            .cursor_pointer()
                                            .p(px(8.))
                                            .child("Retry (F5)")
                                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                                    ),
                            )
                        })
                        .when(self.failed, |view| {
                            view.child(
                                div().child("Targets unavailable").child(
                                    div()
                                        .id("target-retry")
                                        .debug_selector(|| "target-retry".into())
                                        .cursor_pointer()
                                        .p(px(8.))
                                        .child("Retry")
                                        .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                                ),
                            )
                        })
                        .when(!loading && !self.failed && choices.is_empty(), |view| {
                            view.child(P::EMPTY)
                        })
                        .children(choices.into_iter().enumerate().map(|(row, index)| {
                            let id = self.choices[index].id.clone();
                            div()
                                .id(gpui::SharedString::from(format!("target:{id}")))
                                .debug_selector(move || format!("target-{row}"))
                                .cursor_pointer()
                                .p(px(8.))
                                .bg(if self.choice == row {
                                    theme().selection
                                } else {
                                    theme().background
                                })
                                .child(self.choices[index].label.clone())
                                .on_click(cx.listener(move |s, _, window, cx| {
                                    s.attach(id.clone(), window, cx)
                                }))
                        })),
                )
            })
    }
}
impl<P: Port> ShellView for Picker<P> {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        let view = view.read(cx);
        view.child_focus
            .as_ref()
            .unwrap_or(&view.focus)
            .focus(window);
    }
    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        if let Some(child) = view.read(cx).child.clone() {
            P::tick(&child, cx);
        }
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        let view = view.read(cx);
        !view.is_loading() && view.child.as_ref().is_none_or(|child| P::ready(child, cx))
    }
}

/// Adds the surface's own target to the listed choices and opens the saved
/// choice while it is still listed, else the own target.
fn adopt(
    choices: &mut Vec<Choice>,
    requested: &mut Option<String>,
    own: Option<Result<String, String>>,
) {
    let Some(Ok(id)) = own else {
        return;
    };
    if !choices.iter().any(|choice| choice.id == id) {
        choices.push(Choice {
            id: id.clone(),
            label: id.clone(),
        });
    }
    if !requested
        .as_ref()
        .is_some_and(|saved| choices.iter().any(|choice| &choice.id == saved))
    {
        *requested = Some(id);
    }
}

#[cfg(test)]
#[path = "palette_target_tests.rs"]
mod tests;
