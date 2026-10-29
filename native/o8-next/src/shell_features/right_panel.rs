use super::*;
// The desktop's right panel (O8Panel). Inbox lives here rather than in the tab
// row, opened by its command, the header toggle or Cmd+Alt+B.
struct RightPanel;
register_shell_feature!(RightPanel);
impl ShellFeature for RightPanel {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 50,
            run: |s, _, window, cx| move_inbox_tabs(s, window, cx),
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 90,
            dispatch: |s, event, window, cx| {
                let modifiers = event.keystroke.modifiers;
                if (modifiers.platform || modifiers.control)
                    && modifiers.alt
                    && !modifiers.shift
                    && event.keystroke.key == "b"
                {
                    toggle(s, window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
    fn execute(
        &self,
        s: &mut Shell,
        command: &Command,
        window: &mut Window,
        cx: &mut Context<Shell>,
    ) -> bool {
        if !matches!(command, Command::Inbox) {
            return false;
        }
        s.palette = false;
        open(s, window, cx);
        true
    }
}

#[derive(Default)]
struct Panel {
    open: bool,
}

fn key(s: &Shell) -> String {
    format!("panel|{}", s.state.selected.as_deref().unwrap_or(""))
}

/// The panel column's width when it is open: 30% of the window, at most 440.
pub(super) fn width(s: &Shell, window: &Window) -> Option<f32> {
    s.features.read::<Panel>().filter(|panel| panel.open)?;
    let viewport = f32::from(window.viewport_size().width);
    Some((viewport * 0.30).min(crate::theme::GEOMETRY.right_width))
}

pub(super) fn open(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    s.features.get::<Panel>().open = true;
    let key = key(s);
    if !s.content.contains_key(&key) {
        let workspace = s.state.selected.clone().unwrap_or_default();
        if let Some(content) = (Tab::Inbox.registration().create)(s, Tab::Inbox, workspace, window, cx) {
            s.content.insert(key.clone(), content);
        }
    }
    if let Some(content) = s.content.get(&key) {
        content.focus(false, window, cx);
    }
    cx.notify();
}

pub(super) fn toggle(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.features.read::<Panel>().is_some_and(|panel| panel.open) {
        s.features.get::<Panel>().open = false;
        s.restore_focus(window, cx);
        cx.notify();
    } else {
        open(s, window, cx);
    }
}

/// The panel beside the workspace content, when it is open.
pub(super) fn element(s: &Shell, window: &Window) -> Option<(AnyElement, f32)> {
    let width = width(s, window)?;
    let content = s.content.get(&key(s))?;
    Some((content.element(), width))
}

/// Inbox tabs saved before the panel existed move into the panel.
fn move_inbox_tabs(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let mut moved = false;
    for saved in s.state.workspaces.values_mut() {
        while let Some(index) = saved.tabs.iter().position(|tab| tab == &Tab::Inbox) {
            saved.tabs.remove(index);
            if index < saved.active {
                saved.active -= 1;
            }
            saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
            moved = true;
        }
    }
    if moved {
        s.content.retain(|key, _| !key.ends_with("|Inbox"));
        s.ensure(window, cx);
        s.persist();
        cx.notify();
    }
}

/// RightPanelMorphButton: 30px wide; the panel glyph while closed, columns while open.
pub(super) fn toggle_button(open: bool, cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    super::header::pill(
        "header-right-panel",
        if open { "Close panel  ⌘⌥B" } else { "Open O8 panel  ⌘⌥B" },
        true,
    )
    .w(px(30.))
    .child(crate::icon::stroke(
        if open { COLUMNS } else { PANEL },
        theme().text_secondary,
        16.,
        1.8,
    ))
    .on_click(cx.listener(|this, _, window, cx| {
        this.capture(window, cx);
        toggle(this, window, cx);
    }))
}

/// The panel column's own header strip: its tab, then the close toggle at the far right.
pub(super) fn header(width: f32, cx: &mut Context<Shell>) -> impl IntoElement {
    div()
        .w(px(width))
        .h_full()
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(4.))
        .pl(px(8.))
        .pr(px(8.))
        .child(
            div()
                .id("panel-tab-inbox")
                .debug_selector(|| "panel-tab-inbox".into())
                .mt(px(1.3))
                .h(px(26.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(7.))
                .bg(theme().selection)
                .text_color(theme().text)
                .font_weight(gpui::FontWeight::LIGHT)
                .child(crate::icon::stroke(INBOX, theme().text, 12., 1.8))
                .child("Inbox"),
        )
        .child(div().flex_1())
        .child(div().mt(px(1.3)).child(toggle_button(true, cx)))
}

const PANEL: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M16 4v16 M10 9l3 3-3 3";
const COLUMNS: &str = "M5 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z";
const INBOX: &str = "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z";
