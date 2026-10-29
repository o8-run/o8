use super::*;
use crate::motion::Transition;
// The desktop's right panel (O8Panel). It opens on a New tab picker; Inbox,
// Terminal and Review open inside it rather than in the tab row. Cmd+Alt+B
// or the header toggle opens and closes it.
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
        // Inbox navigation still leaves foreground overlays, while retaining
        // the workspace's active tab behind its new panel destination.
        for registration in registrations() {
            (registration.before_tab)(s);
            (registration.after_tab)(s);
        }
        s.palette = false;
        show(s, Tool::Inbox, window, cx);
        true
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tool {
    Launcher,
    Inbox,
    Terminal,
    Review,
}

impl Tool {
    const PICKER: [Tool; 3] = [Tool::Terminal, Tool::Review, Tool::Inbox];
    fn tab(self) -> Option<Tab> {
        match self {
            Tool::Launcher => None,
            Tool::Inbox => Some(Tab::Inbox),
            Tool::Terminal => Some(Tab::Terminal),
            Tool::Review => Some(Tab::Diff),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Tool::Launcher => "New tab",
            Tool::Inbox => "Inbox",
            Tool::Terminal => "Terminal",
            Tool::Review => "Review",
        }
    }
    fn description(self) -> &'static str {
        match self {
            Tool::Launcher => "",
            Tool::Inbox => "GitHub replies, approvals, and agent issues",
            Tool::Terminal => "Run commands in an interactive shell",
            Tool::Review => "Worker changes waiting for review",
        }
    }
    fn icon(self) -> &'static str {
        match self {
            Tool::Launcher => PLUS,
            Tool::Inbox => INBOX,
            Tool::Terminal => TERMINAL,
            Tool::Review => REVIEW,
        }
    }
}

struct Panel {
    scope: Option<String>,
    /// The column's width and fade: 260ms, as the desktop column animates.
    motion: Transition,
    /// The tool's own fade and 12px slide: 200ms.
    content: Transition,
    tool: Tool,
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            scope: None,
            motion: Transition::new(260),
            content: Transition::new(200),
            tool: Tool::Launcher,
        }
    }
}

fn key(s: &Shell, tool: Tool) -> String {
    format!("panel|{}|{tool:?}", s.state.selected.as_deref().unwrap_or(""))
}

pub(super) fn is_open(s: &Shell) -> bool {
    s.features.read::<Panel>().is_some_and(|panel| panel.motion.is_open())
}

/// The column's full width (30% of the window, at most 440) and the width it
/// shows at this frame of its open or close travel. None once fully closed.
pub(super) fn width(s: &Shell, window: &Window) -> Option<(f32, f32)> {
    let panel = s.features.read::<Panel>()?;
    let (travel, moving) = panel.motion.value();
    if moving || panel.content.value().1 {
        window.request_animation_frame();
    }
    if travel <= 0. && !moving {
        return None;
    }
    let viewport = f32::from(window.viewport_size().width);
    let full = (viewport * 0.30).min(crate::theme::GEOMETRY.right_width);
    Some((full, full * travel))
}

/// Opens the panel on one tool, creating that tool's view the first time.
fn show(s: &mut Shell, tool: Tool, window: &mut Window, cx: &mut Context<Shell>) {
    let workspace = s.state.selected.clone().unwrap_or_default();
    let key = key(s, tool);
    if let Some(tab) = tool.tab()
        && !s.content.contains_key(&key)
    {
        // Workspace-scoped tools read their saved slice; Inbox also works before one exists.
        if tab != Tab::Inbox && !s.state.workspaces.contains_key(&workspace) {
            s.notice = "Open a workspace before using this tool.".into();
            cx.notify();
            return;
        }
        if let Some(content) = (tab.registration().create)(s, tab, workspace.clone(), window, cx) {
            s.content.insert(key.clone(), content);
        }
    }
    let panel = s.features.get::<Panel>();
    panel.scope = Some(workspace);
    if panel.tool != tool || !panel.motion.is_open() {
        panel.content = Transition::new(200);
        panel.content.set(true);
    }
    panel.tool = tool;
    panel.motion.set(true);
    save_inbox(s, tool == Tool::Inbox);
    if let Some(content) = s.content.get(&key) {
        content.focus(false, window, cx);
    }
    cx.notify();
}

pub(super) fn open(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    show(s, Tool::Inbox, window, cx);
}

pub(super) fn toggle(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if is_open(s) {
        s.features.get::<Panel>().motion.set(false);
        save_inbox(s, false);
        s.restore_focus(window, cx);
        cx.notify();
    } else {
        let tool = s.features.read::<Panel>().map_or(Tool::Launcher, |panel| panel.tool);
        show(s, tool, window, cx);
    }
}

/// The panel beside the workspace content while it is open or moving.
pub(super) fn element(
    s: &Shell,
    window: &Window,
    cx: &mut Context<Shell>,
) -> Option<(AnyElement, f32, f32)> {
    let (full, shown) = width(s, window)?;
    let panel = s.features.read::<Panel>()?;
    let (travel, _) = panel.motion.value();
    let (arrive, _) = panel.content.value();
    let body = match panel.tool {
        Tool::Launcher => launcher(cx).into_any_element(),
        tool => s
            .content
            .get(&key(s, tool))
            .map(Content::element)
            .unwrap_or_else(|| launcher(cx).into_any_element()),
    };
    // A fixed-width inner column, clipped by the travelling outer width, so the
    // tool never reflows while the panel opens or closes.
    let element = div()
        // The outer column's one-pixel divider is inside its full width.
        .w(px((full - 1.).max(0.)))
        .h_full()
        .flex()
        .flex_col()
        .opacity(travel * arrive)
        .relative()
        .left(px(12. * (1. - arrive)))
        .child(body)
        .into_any_element();
    Some((element, full, shown))
}

/// The New tab picker: one card per panel tool.
fn launcher(cx: &mut Context<Shell>) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .justify_center()
        .px(px(28.))
        .gap(px(6.))
        .children(Tool::PICKER.into_iter().map(|tool| {
            div()
                .id(("panel-tool", tool as usize))
                .debug_selector(move || format!("panel-tool-{}", tool.label().to_lowercase()))
                .flex()
                .items_center()
                .gap(px(12.))
                .px(px(12.))
                .py(px(10.))
                .rounded(px(12.))
                .border_1()
                .border_color(theme().border)
                .cursor_pointer()
                .hover(|card| card.bg(theme().hover))
                .child(
                    div()
                        .size(px(30.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().hover)
                        .child(crate::icon::stroke(tool.icon(), theme().text_secondary, 15., 1.6)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(div().text_size(px(13.)).text_color(theme().text).child(tool.label()))
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(tool.description()),
                        ),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.capture(window, cx);
                    show(this, tool, window, cx);
                }))
        }))
}

/// Inbox tabs saved before the panel existed move into the panel.
fn move_inbox_tabs(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let mut moved = false;
    for saved in s.state.workspaces.values_mut() {
        while let Some(index) = saved.tabs.iter().position(|tab| tab == &Tab::Inbox) {
            saved.surfaces.inbox.panel_inbox_open = true;
            saved.tabs.remove(index);
            if index < saved.active {
                saved.active -= 1;
            }
            saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
            moved = true;
        }
    }
    if moved {
        s.content.retain(|key, _| key.starts_with("panel|") || !key.ends_with("|Inbox"));
        s.ensure(window, cx);
        s.persist();
        cx.notify();
    }
    let scope = s.state.selected.clone().unwrap_or_default();
    if s.features.get::<Panel>().scope.as_ref() != Some(&scope) {
        let restore = s.state.workspaces.get(&scope)
            .is_some_and(|saved| saved.surfaces.inbox.panel_inbox_open);
        let panel = s.features.get::<Panel>();
        panel.scope = Some(scope);
        panel.motion.set(false);
        panel.tool = Tool::Launcher;
        if restore {
            show(s, Tool::Inbox, window, cx);
        }
    }
}

fn save_inbox(s: &mut Shell, open: bool) {
    let scope = s.state.selected.clone().unwrap_or_default();
    if !open && !s.state.workspaces.contains_key(&scope) {
        return;
    }
    let saved = s.state.workspaces.entry(scope).or_default();
    if saved.surfaces.inbox.panel_inbox_open != open {
        saved.surfaces.inbox.panel_inbox_open = open;
        s.persist();
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

/// The panel column's own header strip: its tab and the New tab opener, then
/// the close toggle at the far right. Clipped to the column's travelling width.
pub(super) fn header(s: &Shell, full: f32, shown: f32, cx: &mut Context<Shell>) -> impl IntoElement {
    let panel = s.features.read::<Panel>();
    let tool = panel.map_or(Tool::Launcher, |panel| panel.tool);
    let travel = panel.map_or(0., |panel| panel.motion.value().0);
    div()
        .w(px(shown))
        .h_full()
        .flex_shrink_0()
        .overflow_hidden()
        .child(
            div()
                .w(px(full))
                .h_full()
                .flex()
                .items_center()
                .gap(px(4.))
                .pl(px(8.))
                .pr(px(8.))
                .opacity(travel)
                .child(
                    div()
                        .id("panel-tab")
                        .debug_selector(|| "panel-tab".into())
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
                        .when(tool != Tool::Launcher, |pill| {
                            pill.child(crate::icon::stroke(tool.icon(), theme().text, 12., 1.8))
                        })
                        .child(tool.label()),
                )
                .child(
                    div().mt(px(1.3)).child(
                        super::header::icon_button("panel-new-tab", PLUS, 14., 2., "New tab", true)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.capture(window, cx);
                                show(this, Tool::Launcher, window, cx);
                            })),
                    ),
                )
                .child(div().flex_1())
                .child(div().mt(px(1.3)).child(toggle_button(true, cx))),
        )
}

const PANEL: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M16 4v16 M10 9l3 3-3 3";
const COLUMNS: &str = "M5 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z";
const PLUS: &str = "M12 5v14M5 12h14";
const INBOX: &str = "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z";
const TERMINAL: &str = "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M7 10l3 2-3 2 M12 15h5";
const REVIEW: &str = "M3 12l4 4 8-8 M11 16l1 1 9-9";
