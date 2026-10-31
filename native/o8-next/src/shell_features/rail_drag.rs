use super::*;
use gpui::DragMoveEvent;
// The rail's Run orchestrator and Run terminal buttons are also drag handles,
// as in classic's CompactNavigationRail (startPaneDrag). Dropped on the
// workspace they split the pane under the pointer (panes.rs); either can also
// go into the right panel, which stacks its views top and bottom.
struct RailDrag;
register_shell_feature!(RailDrag);
impl ShellFeature for RailDrag {}

/// The dragged rail button, drawn as a header tab pill.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Pane {
    Chat,
    Terminal,
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        match self {
            Pane::Chat => super::header_tabs::pill(
                "New chat".into(),
                super::header::glyph(&Tab::Session(String::new())),
            ),
            Pane::Terminal => {
                super::header_tabs::pill("Terminal".into(), super::header::glyph(&Tab::Terminal))
            }
        }
    }
}

/// Where a drop on the right panel goes: its top or bottom view.
#[derive(Default)]
struct Target {
    lower: Option<bool>,
}

/// Starts a chat on the operator's lead, or setup when no repository is open.
pub(crate) fn start_chat(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.start_thread(true, cx).is_none() {
        s.execute(Command::Setup, window, cx);
    }
}

/// Makes the right panel a drop target for the rail's chat and terminal.
pub(super) fn panel_target(s: &Shell, panel: gpui::Div, cx: &mut Context<Shell>) -> gpui::Div {
    let lower = cx
        .has_active_drag()
        .then(|| s.features.read::<Target>().and_then(|t| t.lower))
        .flatten();
    panel
        .relative()
        .on_drag_move(cx.listener(|s, event: &DragMoveEvent<Pane>, _, cx| {
            let position = event.event.position;
            let next = event
                .bounds
                .contains(&position)
                .then(|| position.y > event.bounds.center().y);
            let target = s.features.get::<Target>();
            if target.lower != next {
                target.lower = next;
                cx.notify();
            }
        }))
        .on_drop(cx.listener(|s, pane: &Pane, window, cx| {
            let lower = s.features.get::<Target>().lower.take();
            if let Some(lower) = lower {
                s.capture(window, cx);
                s.panel_drop(*pane == Pane::Chat, lower, window, cx);
            }
        }))
        .when_some(lower, |panel, lower| panel.child(overlay(lower)))
}

fn overlay(lower: bool) -> gpui::Div {
    let accent = theme().accent;
    div()
        .debug_selector(move || if lower { "panel-drop-below" } else { "panel-drop-above" }.into())
        .absolute()
        .left_0()
        .right_0()
        .when(lower, |d| d.top(gpui::relative(0.5)).bottom_0())
        .when(!lower, |d| d.top_0().h(gpui::relative(0.5)))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(12.))
        .bg(gpui::Rgba { a: 0.13, ..accent })
        .border_1()
        .border_color(accent)
        .text_size(px(13.))
        .text_color(theme().text)
        .child(if lower { "Open below in panel" } else { "Open in panel" })
}
