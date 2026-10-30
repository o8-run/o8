use super::*;
use crate::browser_panel::header as browser_header;
use crate::motion::Transition;
use gpui::SharedString;
// The desktop's right panel (O8Panel). Its tools open as tabs in the panel's
// own strip; "+" lists every desktop panel tool (o8-panel/panel-tools.tsx),
// including the ones o8 next does not have yet, which open a placeholder.
// Cmd+Alt+B or the header toggle opens and closes it.
//
// The tab strip and its add menu follow T3 Code (MIT, Copyright (c) 2026 T3
// Tools Inc.): https://github.com/pingdotgg/t3code
// apps/web/src/components/RightPanelTabs.tsx and
// apps/web/src/components/ui/panel-tab-close-button.tsx at
// 5b4f2aa1532730d4dd51d2cb48a57ff74a0f54eb.
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
                if event.keystroke.key == "escape"
                    && s.features
                        .read::<Panel>()
                        .is_some_and(|panel| panel.menu.is_some())
                {
                    s.features.get::<Panel>().menu = None;
                    cx.notify();
                    return KeyResult::Handled;
                }
                let modifiers = event.keystroke.modifiers;
                let step = match event.keystroke.key.as_str() {
                    "left" => 16.,
                    "right" => -16.,
                    _ => 0.,
                };
                if step != 0.
                    && !modifiers.modified()
                    && s.features
                        .read::<Panel>()
                        .and_then(|panel| panel.edge.as_ref())
                        .is_some_and(|edge| edge.is_focused(window))
                {
                    let viewport = f32::from(window.viewport_size().width);
                    let (min, max) = width_bounds(s, viewport);
                    let width = full_width(s, viewport);
                    s.state.right_panel_width = Some((width + step).clamp(min, max));
                    s.persist();
                    cx.notify();
                    return KeyResult::Handled;
                }
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
        show(s, Tool::Inbox, window, cx);
        true
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tool {
    Launcher,
    Files,
    Browser,
    Devices,
    Terminal,
    Review,
    Inbox,
    Spec,
    Threads,
    Activity,
    SideChat,
    Resources,
    Targeting,
}

impl Tool {
    /// PANEL_TOOLS, in the desktop's groups and order.
    const GROUPS: [(&'static str, &'static [Tool]); 3] = [
        (
            "Tools",
            &[
                Tool::Files,
                Tool::Browser,
                Tool::Devices,
                Tool::Terminal,
                Tool::Review,
                Tool::Inbox,
                Tool::Spec,
            ],
        ),
        ("More", &[Tool::Threads, Tool::Activity, Tool::SideChat]),
        ("Diagnostics", &[Tool::Resources, Tool::Targeting]),
    ];
    fn tab(self) -> Option<Tab> {
        match self {
            Tool::Inbox => Some(Tab::Inbox),
            Tool::Terminal => Some(Tab::Terminal),
            Tool::Review => Some(Tab::Diff),
            Tool::Activity => Some(Tab::Activity),
            _ => None,
        }
    }
    /// Tools o8 next has not built yet open a placeholder tab.
    fn ready(self) -> bool {
        !matches!(
            self,
            Tool::Devices | Tool::Threads | Tool::SideChat | Tool::Resources | Tool::Targeting
        )
    }
    fn label(self) -> &'static str {
        match self {
            Tool::Launcher => "New tab",
            Tool::Files => "Files",
            Tool::Browser => "Browser",
            Tool::Devices => "Devices",
            Tool::Spec => "o8.md",
            Tool::Inbox => "Inbox",
            Tool::Terminal => "Terminal",
            Tool::Review => "Review",
            Tool::Threads => "Threads",
            Tool::Activity => "Activity",
            Tool::SideChat => "Side chat",
            Tool::Resources => "Resources",
            Tool::Targeting => "Targeting",
        }
    }
    fn description(self) -> &'static str {
        match self {
            Tool::Launcher => "",
            Tool::Files => "Browse and read repository files",
            Tool::Browser => "Open websites and local previews",
            Tool::Devices => "iOS simulators and Android emulators",
            Tool::Spec => "Workspace notes and instructions",
            Tool::Inbox => "GitHub replies, approvals, and agent issues",
            Tool::Terminal => "Run commands in an interactive shell",
            Tool::Review => "Working changes across your project",
            Tool::Threads => "Project tasks and agent exchanges",
            Tool::Activity => "Repository history and mission decisions",
            Tool::SideChat => "A separate conversation with its own messages",
            Tool::Resources => "Live session CPU and memory",
            Tool::Targeting => "Find code to direct your agents toward",
        }
    }
    fn icon(self) -> &'static str {
        match self {
            Tool::Launcher => PLUS,
            Tool::Files => FILES,
            Tool::Browser => BROWSER,
            Tool::Devices => DEVICES,
            Tool::Spec => SPEC,
            Tool::Inbox => INBOX,
            Tool::Terminal => TERMINAL,
            Tool::Review => REVIEW,
            Tool::Threads => THREADS,
            Tool::Activity => ACTIVITY,
            Tool::SideChat => SIDE_CHAT,
            Tool::Resources => RESOURCES,
            Tool::Targeting => TARGETS,
        }
    }
    fn slug(self) -> String {
        self.label().to_lowercase().replace([' ', '.'], "-")
    }
}

/// A panel tab being dragged along the strip.
#[derive(Clone)]
struct Dragged {
    index: usize,
    tool: Tool,
}
impl Render for Dragged {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .h(px(24.))
            .pl(px(6.))
            .pr(px(8.))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(6.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_md()
            .text_size(px(12.))
            .text_color(theme().text)
            .child(crate::icon::stroke(
                self.tool.icon(),
                theme().text,
                12.,
                1.8,
            ))
            .child(self.tool.label())
    }
}

struct Panel {
    /// The column's width and fade: 260ms, as the desktop column animates.
    motion: Transition,
    /// The tool's own fade and 12px slide: 200ms.
    content: Transition,
    /// Open tabs in strip order; the empty strip shows the tool list.
    tabs: Vec<Tool>,
    active: usize,
    /// The "+" menu, and when it opened (its 140ms fade and drop).
    menu: Option<std::time::Instant>,
    /// Files and o8.md views, keyed like panel content.
    files: std::collections::HashMap<String, gpui::Entity<crate::files_panel::FilesPanel>>,
    browsers: std::collections::HashMap<String, gpui::Entity<crate::browser_panel::BrowserPanel>>,
    /// The left edge is being dragged; the width saves when it is let go.
    resizing: bool,
    /// Where the press on the edge began and the width then (useColumnResize's
    /// startX and startWidth), so the drag threshold never shifts the edge.
    drag_from: Option<(f32, f32)>,
    /// The edge takes focus when pressed, so Left and Right resize by 16 px.
    edge: Option<gpui::FocusHandle>,
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            motion: Transition::new(260),
            content: Transition::new(200),
            tabs: vec![],
            active: 0,
            menu: None,
            files: Default::default(),
            browsers: Default::default(),
            resizing: false,
            drag_from: None,
            edge: None,
        }
    }
}

impl Panel {
    fn current(&self) -> Tool {
        self.tabs
            .get(self.active)
            .copied()
            .unwrap_or(Tool::Launcher)
    }
}

fn key(s: &Shell, tool: Tool) -> String {
    format!(
        "panel|{}|{tool:?}",
        s.state.selected.as_deref().unwrap_or("")
    )
}

pub(super) fn is_open(s: &Shell) -> bool {
    s.features
        .read::<Panel>()
        .is_some_and(|panel| panel.motion.is_open())
}

/// The column's full width (theme::right_panel_width) and the width it
/// shows at this frame of its open or close travel. None once fully closed.
pub(super) fn width(s: &Shell, window: &Window) -> Option<(f32, f32)> {
    let panel = s.features.read::<Panel>()?;
    let (travel, moving) = panel.motion.value();
    let menu_moving = panel
        .menu
        .is_some_and(|at| at.elapsed() < std::time::Duration::from_millis(140));
    if moving || panel.content.value().1 || menu_moving {
        window.request_animation_frame();
    }
    if travel <= 0. && !moving {
        return None;
    }
    let full = full_width(s, f32::from(window.viewport_size().width));
    Some((full, full * travel))
}

// RightPanelResizeEdge with useColumnResize's limits for the o8 panel
// (useRightPanelWidths.ts): 400 to 1200 px, and the workspace keeps
// WORKSPACE_RESERVE beside it plus RIGHT_COLUMN_CHROME.
const MIN_WIDTH: f32 = 400.;
const MAX_WIDTH: f32 = 1200.;
const WORKSPACE_RESERVE: f32 = 420.;
const COLUMN_CHROME: f32 = 8.;
/// The edge's grab target reaches this far either side of the boundary.
const EDGE_SLOP: f32 = 8.;

/// The narrowest and widest the panel may be in this window.
fn width_bounds(s: &Shell, viewport: f32) -> (f32, f32) {
    let sidebar = if s.surfaces.sidebar.hidden {
        0.
    } else {
        super::super::sidebar::width(s)
    };
    let available = viewport - super::super::rail::WIDTH - sidebar;
    let max = MAX_WIDTH.min((available - WORKSPACE_RESERVE - COLUMN_CHROME).max(0.));
    (MIN_WIDTH.min(max), max)
}

/// The column's full width: the dragged one within this window's bounds,
/// else the default.
fn full_width(s: &Shell, viewport: f32) -> f32 {
    match s.state.right_panel_width.filter(|width| width.is_finite()) {
        Some(width) => {
            let (min, max) = width_bounds(s, viewport);
            width.clamp(min, max)
        }
        None => crate::theme::right_panel_width(viewport),
    }
}

/// A drag of the panel's left edge.
pub(super) struct Resize;
impl gpui::Render for Resize {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}

/// Moves the edge with the pointer from where the press began.
pub(super) fn resize(s: &mut Shell, event: &gpui::DragMoveEvent<Resize>, window: &Window) {
    let Some((from, start)) = s.features.read::<Panel>().and_then(|panel| panel.drag_from) else {
        return;
    };
    let width = start + from - f32::from(event.event.position.x);
    let (min, max) = width_bounds(s, f32::from(window.viewport_size().width));
    s.state.right_panel_width = Some(width.clamp(min, max));
    s.features.get::<Panel>().resizing = true;
}

/// Saves the width once the edge is let go, as the sidebar's edge does.
pub(super) fn settle_resize(s: &mut Shell, cx: &Context<Shell>) {
    if s.features
        .read::<Panel>()
        .is_some_and(|panel| panel.resizing)
        && !cx.has_active_drag()
    {
        let panel = s.features.get::<Panel>();
        panel.resizing = false;
        panel.drag_from = None;
        s.persist();
    }
}

/// A wide grab target over the panel's left boundary, `shown` from the row's
/// right, with a quiet line that glows on hover, focus and drag (ResizeEdge).
pub(super) fn edge(
    s: &mut Shell,
    shown: f32,
    window: &Window,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    let focus = s
        .features
        .get::<Panel>()
        .edge
        .get_or_insert_with(|| cx.focus_handle())
        .clone();
    let lit = s.features.get::<Panel>().resizing || focus.is_focused(window);
    let accent = theme().accent;
    div()
        .id("panel-resize")
        .debug_selector(|| "panel-resize".into())
        .group("panel-resize")
        .track_focus(&focus)
        .absolute()
        .top_0()
        .bottom_0()
        .right(px(shown - EDGE_SLOP - 0.5))
        .w(px(EDGE_SLOP * 2. + 1.))
        .cursor(gpui::CursorStyle::ResizeLeftRight)
        .on_mouse_down(
            gpui::MouseButton::Left,
            cx.listener(|this, event: &gpui::MouseDownEvent, window, _| {
                let width = full_width(this, f32::from(window.viewport_size().width));
                this.features.get::<Panel>().drag_from = Some((f32::from(event.position.x), width));
            }),
        )
        .on_drag(Resize, |_, _, _, cx| cx.new(|_| Resize))
        .child(
            div()
                .absolute()
                .top(px(22.))
                .bottom(px(22.))
                .left(px(EDGE_SLOP))
                .w(px(1.))
                .bg(accent)
                .shadow(vec![gpui::BoxShadow {
                    color: accent.into(),
                    offset: gpui::point(px(0.), px(0.)),
                    blur_radius: px(8.),
                    spread_radius: px(0.),
                }])
                .opacity(if lit { 0.85 } else { 0. })
                .group_hover("panel-resize", |style| style.opacity(0.85)),
        )
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
    if matches!(tool, Tool::Files | Tool::Spec)
        && !s.features.get::<Panel>().files.contains_key(&key)
    {
        if workspace.is_empty() {
            s.notice = "Open a workspace before using this tool.".into();
            cx.notify();
            return;
        }
        let mode = if tool == Tool::Files {
            crate::files_panel::Mode::Files
        } else {
            crate::files_panel::Mode::Spec
        };
        let client = s.client.in_workspace(&workspace);
        let view = files_view(s, client, workspace.clone(), mode, cx);
        s.features.get::<Panel>().files.insert(key.clone(), view);
    }
    if tool == Tool::Browser && !s.features.get::<Panel>().browsers.contains_key(&key) {
        let saved = s.state.browser_pages.get(&workspace).cloned();
        let client = s.client.in_workspace(&workspace);
        let view = cx.new(|cx| {
            let mut view = crate::browser_panel::BrowserPanel::new(cx);
            view.configure(saved, client, cx);
            view
        });
        s.subscriptions
            .push(cx.observe(&view, |_, _, cx| cx.notify()));
        s.subscriptions.push(cx.subscribe(
            &view,
            move |s, _, event: &crate::browser_panel::PagesChanged, _| {
                crate::browser_panel::save_pages(&mut s.state, &workspace, event.0.clone());
                s.persist();
            },
        ));
        s.features.get::<Panel>().browsers.insert(key.clone(), view);
    }
    let panel = s.features.get::<Panel>();
    if panel.current() != tool || !panel.motion.is_open() {
        panel.content = Transition::new(200);
        panel.content.set(true);
    }
    // A tool already open is focused; any other is added as a new tab.
    if tool != Tool::Launcher {
        match panel.tabs.iter().position(|open| *open == tool) {
            Some(index) => panel.active = index,
            None => {
                panel.tabs.push(tool);
                panel.active = panel.tabs.len() - 1;
            }
        }
    }
    panel.menu = None;
    panel.motion.set(true);
    if let Some(content) = s.content.get(&key) {
        content.focus(false, window, cx);
    } else if let Some(view) = s
        .features
        .read::<Panel>()
        .and_then(|panel| panel.files.get(&key))
    {
        view.read(cx).focus(window);
    } else if let Some(view) = s
        .features
        .read::<Panel>()
        .and_then(|panel| panel.browsers.get(&key))
        .cloned()
    {
        view.read(cx).focus(window);
    }
    cx.notify();
}

/// Opens the panel on a desktop O8 panel tab as Symon names it
/// (O8_TAB_SURFACES), loading `url` into the Browser; false for any other name.
pub(super) fn open_surface(
    s: &mut Shell,
    surface: &str,
    url: Option<&str>,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> bool {
    let tool = match surface {
        "inbox" => Tool::Inbox,
        "activity" => Tool::Activity,
        "review" => Tool::Review,
        "o8md" => Tool::Spec,
        "workspace" | "files" => Tool::Files,
        "terminal" => Tool::Terminal,
        "browser" => Tool::Browser,
        _ => return false,
    };
    show(s, tool, window, cx);
    if let (Tool::Browser, Some(url)) = (tool, url)
        && let Some(view) = s
            .features
            .read::<Panel>()
            .and_then(|panel| panel.browsers.get(&key(s, Tool::Browser)))
            .cloned()
    {
        view.update(cx, |browser, cx| browser.agent_navigate(url, cx));
    }
    true
}

pub(super) fn open(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    show(s, Tool::Inbox, window, cx);
}

pub(super) fn open_review(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    show(s, Tool::Review, window, cx);
}

pub(super) fn open_spec(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    show(s, Tool::Spec, window, cx);
}

/// Files for the workspace, or for another of its worktrees.
pub(super) fn open_files(
    s: &mut Shell,
    root: Option<String>,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    if let Some(root) = root {
        let key = key(s, Tool::Files);
        let client = s.client.in_workspace(&root);
        let view = files_view(s, client, root, crate::files_panel::Mode::Files, cx);
        s.features.get::<Panel>().files.insert(key, view);
    }
    show(s, Tool::Files, window, cx);
}

// Pins use the same shell state and save path as tabs, including scratch states.
fn files_view(
    s: &mut Shell,
    client: crate::client::Client,
    workspace: String,
    mode: crate::files_panel::Mode,
    cx: &mut Context<Shell>,
) -> gpui::Entity<crate::files_panel::FilesPanel> {
    let pins = s.state.pins(&workspace);
    let view = cx.new(|cx| {
        let mut view = crate::files_panel::FilesPanel::new(client, workspace.clone(), mode, cx);
        view.set_pins(&workspace, pins, cx);
        view
    });
    s.subscriptions.push(cx.subscribe(
        &view,
        |s, _, pins: &crate::files_panel::PinsChanged, cx| {
            s.state.set_pins(pins.workspace.clone(), pins.paths.clone());
            s.persist();
            for view in s
                .features
                .get::<Panel>()
                .files
                .values()
                .cloned()
                .collect::<Vec<_>>()
            {
                view.update(cx, |view, cx| {
                    view.set_pins(&pins.workspace, pins.paths.clone(), cx)
                });
            }
            cx.notify();
        },
    ));
    view
}

/// The Browser, at a page.
pub(super) fn open_browser(
    s: &mut Shell,
    url: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    show(s, Tool::Browser, window, cx);
    let key = key(s, Tool::Browser);
    if let Some(view) = s
        .features
        .read::<Panel>()
        .and_then(|panel| panel.browsers.get(&key))
        .cloned()
    {
        view.update(cx, |browser, cx| browser.navigate(&url, cx));
    }
}

pub(super) fn toggle(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if is_open(s) {
        s.features.get::<Panel>().motion.set(false);
        s.restore_focus(window, cx);
        cx.notify();
    } else {
        let tool = s
            .features
            .read::<Panel>()
            .map_or(Tool::Launcher, Panel::current);
        show(s, tool, window, cx);
    }
}

/// The panel beside the workspace content while it is open or moving.
pub(super) fn element(
    s: &Shell,
    window: &Window,
    cx: &mut Context<Shell>,
) -> Option<(AnyElement, f32, f32)> {
    cover_browsers(s, cx);
    let (full, shown) = width(s, window)?;
    let panel = s.features.read::<Panel>()?;
    let (travel, _) = panel.motion.value();
    let (arrive, _) = panel.content.value();
    let body = match panel.current() {
        Tool::Launcher => launcher(cx).into_any_element(),
        tool if !tool.ready() => placeholder(tool).into_any_element(),
        tool => s
            .content
            .get(&key(s, tool))
            .map(Content::element)
            .or_else(|| {
                panel
                    .files
                    .get(&key(s, tool))
                    .map(|view| view.clone().into_any_element())
            })
            .or_else(|| {
                panel
                    .browsers
                    .get(&key(s, tool))
                    .map(|view| view.clone().into_any_element())
            })
            .unwrap_or_else(|| launcher(cx).into_any_element()),
    };
    // A fixed-width inner column, clipped by the travelling outer width, so the
    // tool never reflows while the panel opens or closes.
    let element = div()
        .w(px(full))
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

/// A native page draws above everything the window paints, so it shows only
/// while its Browser is the settled, uncovered panel tool.
fn cover_browsers(s: &Shell, cx: &mut Context<Shell>) {
    let Some(panel) = s.features.read::<Panel>() else {
        return;
    };
    let showing = (panel.current() == Tool::Browser
        && panel.motion.is_open()
        && !panel.motion.value().1
        && !s.palette
        && panel.menu.is_none()
        && !super::header_tools::any_open(s))
    .then(|| key(s, Tool::Browser));
    for (key, view) in panel.browsers.clone() {
        let covered = showing.as_deref() != Some(key.as_str());
        view.update(cx, |browser, _| browser.cover(covered));
    }
}

/// Closes one tab and focuses its neighbour, as a browser strip does.
fn close_tab(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let panel = s.features.get::<Panel>();
    if index >= panel.tabs.len() {
        return;
    }
    let was_active = index == panel.active;
    panel.tabs.remove(index);
    if index < panel.active || (was_active && panel.active == panel.tabs.len()) {
        panel.active = panel.active.saturating_sub(1);
    }
    if was_active {
        panel.content = Transition::new(200);
        panel.content.set(true);
        let tool = panel.current();
        if tool != Tool::Launcher {
            show(s, tool, window, cx);
            return;
        }
    }
    cx.notify();
}

/// A tool o8 next has not built yet: what it will be, in its own tab.
fn placeholder(tool: Tool) -> impl IntoElement {
    div()
        .id(SharedString::from(format!(
            "panel-placeholder-{}",
            tool.slug()
        )))
        .debug_selector(move || format!("panel-placeholder-{}", tool.slug()))
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.))
        .px(px(32.))
        .child(
            div()
                .size(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().hover)
                .child(crate::icon::stroke(
                    tool.icon(),
                    theme().text_secondary,
                    18.,
                    1.6,
                )),
        )
        .child(
            div()
                .text_size(px(14.))
                .text_color(theme().text)
                .child(format!("{} is not in o8 next yet", tool.label())),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .text_center()
                .child(tool.description()),
        )
}

/// The empty strip's tool list: every desktop panel tool, in its groups.
fn launcher(cx: &mut Context<Shell>) -> impl IntoElement {
    div()
        .id("panel-launcher")
        .size_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .justify_center()
        .px(px(28.))
        .py(px(16.))
        .gap(px(6.))
        .children(
            Tool::GROUPS
                .iter()
                .flat_map(|(_, tools)| tools.iter().copied())
                .map(|tool| {
                    div()
                        .id(("panel-tool", tool as usize))
                        .debug_selector(move || {
                            format!("panel-tool-{}", tool.label().to_lowercase())
                        })
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
                                .child(crate::icon::stroke(
                                    tool.icon(),
                                    theme().text_secondary,
                                    15.,
                                    1.6,
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .text_size(px(13.))
                                        .text_color(theme().text)
                                        .child(tool.label())
                                        .when(!tool.ready(), |row| row.child(soon())),
                                )
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
                }),
        )
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
        s.content
            .retain(|key, _| key.starts_with("panel|") || !key.ends_with("|Inbox"));
        s.ensure(window, cx);
        s.persist();
        cx.notify();
    }
}

/// RightPanelMorphButton: 30px wide; the panel glyph while closed, columns while open.
pub(super) fn toggle_button(open: bool, cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    super::header::pill(
        "header-right-panel",
        if open {
            "Close panel  ⌘⌥B"
        } else {
            "Open O8 panel  ⌘⌥B"
        },
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

/// "Soon" beside a tool o8 next has not built yet.
fn soon() -> impl IntoElement {
    div()
        .px(px(5.))
        .rounded(px(4.))
        .bg(theme().hover)
        .text_size(px(10.))
        .text_color(theme().text_muted)
        .child("Soon")
}

/// One tab in the panel strip (RightPanelTab): 24px, at most 144px wide, its
/// glyph turning into a close mark while the tab is hovered.
fn tab_pill(index: usize, tool: Tool, active: bool, cx: &mut Context<Shell>) -> impl IntoElement {
    let group = SharedString::from(format!("panel-tab-{index}"));
    let label = tool.label();
    div()
        .id(("panel-tab", index))
        .debug_selector(move || {
            if active {
                "panel-tab".to_string()
            } else {
                format!("panel-tab-{}", tool.slug())
            }
        })
        .group(group.clone())
        .mt(px(1.3))
        .h(px(24.))
        .max_w(px(144.))
        .flex_shrink_0()
        .pl(px(6.))
        .pr(px(8.))
        .flex()
        .items_center()
        .gap(px(2.))
        .rounded(px(6.))
        .text_size(px(12.))
        .cursor_pointer()
        .when(active, |pill| {
            pill.bg(theme().selection).text_color(theme().text)
        })
        .when(!active, |pill| {
            pill.text_color(theme().text_muted)
                .hover(|pill| pill.bg(theme().hover).text_color(theme().text))
        })
        .child(
            div()
                .id(("panel-tab-close", index))
                .debug_selector(move || format!("panel-tab-close-{}", tool.slug()))
                .relative()
                .size(px(16.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .hover(|close| close.bg(theme().hover))
                .child(
                    div()
                        .absolute()
                        .group_hover(group.clone(), |icon| icon.opacity(0.))
                        .child(crate::icon::stroke(
                            tool.icon(),
                            if active {
                                theme().text
                            } else {
                                theme().text_muted
                            },
                            12.,
                            1.8,
                        )),
                )
                .child(
                    div()
                        .absolute()
                        .opacity(0.)
                        .group_hover(group, |mark| mark.opacity(1.))
                        .child(crate::icon::stroke(CLOSE, theme().text, 12., 2.)),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    close_tab(this, index, window, cx);
                })),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label),
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            show(this, tool, window, cx);
        }))
        .on_drag(Dragged { index, tool }, |dragged, _, _, cx| {
            cx.new(|_| dragged.clone())
        })
        .drag_over::<Dragged>(|pill, _, _, _| pill.bg(theme().hover))
        .on_drop(cx.listener(move |this, dragged: &Dragged, _, cx| {
            let panel = this.features.get::<Panel>();
            if dragged.index < panel.tabs.len() && dragged.index != index {
                let active = panel.current();
                let moved = panel.tabs.remove(dragged.index);
                panel.tabs.insert(index.min(panel.tabs.len()), moved);
                panel.active = panel
                    .tabs
                    .iter()
                    .position(|open| *open == active)
                    .unwrap_or(0);
                cx.notify();
            }
        }))
}

/// The "+" menu: every desktop panel tool in its group; picking one adds it
/// as a tab (or focuses it when it is open already).
fn add_menu(
    appear: f32,
    browser: Option<Entity<crate::browser_panel::BrowserPanel>>,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    let rows = Tool::GROUPS
        .iter()
        .enumerate()
        .map(|(group_index, (name, tools))| {
            div()
                .flex()
                .flex_col()
                .when(group_index > 0, |group| {
                    group.child(div().my(px(4.)).h(px(1.)).bg(theme().border))
                })
                .child(
                    div()
                        .px(px(8.))
                        .pt(px(4.))
                        .pb(px(2.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(*name),
                )
                .children(tools.iter().copied().map(|tool| {
                    div()
                        .id(SharedString::from(format!("panel-add-{}", tool.slug())))
                        .debug_selector(move || format!("panel-add-{}", tool.slug()))
                        .h(px(30.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(6.))
                        .text_size(px(13.))
                        .text_color(theme().text)
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .child(crate::icon::stroke(
                            tool.icon(),
                            theme().text_secondary,
                            14.,
                            1.6,
                        ))
                        .child(div().flex_1().child(tool.label()))
                        .when(!tool.ready(), |row| row.child(soon()))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            show(this, tool, window, cx);
                        }))
                }))
        });
    div()
        .absolute()
        .top(px(28.))
        .left(px(0.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .position(gpui::point(px(0.), px(0.)))
                    .child(
                        div()
                            .id("panel-add-backdrop")
                            .w(px(100_000.))
                            .h(px(100_000.))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, _, cx| {
                                    this.features.get::<Panel>().menu = None;
                                    cx.notify();
                                }),
                            ),
                    ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopLeft)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id("panel-add-menu")
                            .debug_selector(|| "panel-add-menu".into())
                            .occlude()
                            .w(px(232.))
                            .p(px(4.))
                            .opacity(appear)
                            .relative()
                            .top(px(-4. * (1. - appear)))
                            .rounded(px(10.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .children(browser.map(|browser| {
                                browser_header::new_page_item(
                                    browser,
                                    |s, _| s.features.get::<Panel>().menu = None,
                                    cx,
                                )
                            }))
                            .children(rows),
                    ),
            )
            .with_priority(2),
        )
}

/// The panel column's own header strip: its tabs and the "+" opener, then
/// the close toggle at the far right. Clipped to the column's travelling width.
pub(super) fn header(
    s: &Shell,
    full: f32,
    shown: f32,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    let panel = s.features.read::<Panel>();
    let tabs = panel.map(|panel| panel.tabs.clone()).unwrap_or_default();
    let active = panel.map_or(0, |panel| panel.active);
    let travel = panel.map_or(0., |panel| panel.motion.value().0);
    let mut pills = vec![];
    for (index, tool) in tabs.iter().enumerate() {
        // Classic excludes Browser from the utility strip; pages belong only to its active state.
        if (*tool == Tool::Browser && index != active)
            || (tabs.get(active) == Some(&Tool::Browser) && *tool != Tool::Browser)
        {
            continue;
        }
        if *tool == Tool::Browser
            && let Some(view) = panel.and_then(|panel| panel.browsers.get(&key(s, Tool::Browser)))
        {
            let pages = view.update(cx, |browser, cx| browser.page_strip(cx));
            pills.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .min_w_0()
                    .child(pages)
                    .child(browser_header::launcher(
                        |s, window, cx| {
                            let panel = s.features.get::<Panel>();
                            panel.active = panel.tabs.len();
                            show(s, Tool::Launcher, window, cx);
                            cx.stop_propagation();
                        },
                        cx,
                    ))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|s, _, window, cx| show(s, Tool::Browser, window, cx)),
                    )
                    .into_any_element(),
            );
        } else {
            pills.push(tab_pill(index, *tool, index == active, cx).into_any_element());
        }
    }
    let browser = panel
        .filter(|p| p.current() == Tool::Browser)
        .and_then(|p| p.browsers.get(&key(s, Tool::Browser)))
        .cloned();
    let (opener_icon, opener_size, opener_weight, opener_label) = if browser.is_some() {
        (browser_header::MORE, 16., 3., "More panel views")
    } else {
        (PLUS, 14., 2., "Add panel tool")
    };
    let menu = panel
        .and_then(|panel| panel.menu)
        .map(|at| crate::motion::ease_out((at.elapsed().as_secs_f32() / 0.14).min(1.)));
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
                        .id("panel-tabs")
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .overflow_x_scroll()
                        .when(tabs.is_empty(), |strip| {
                            strip.child(
                                div()
                                    .id("panel-tab")
                                    .debug_selector(|| "panel-tab".into())
                                    .mt(px(1.3))
                                    .h(px(24.))
                                    .px(px(8.))
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.))
                                    .bg(theme().selection)
                                    .text_size(px(12.))
                                    .text_color(theme().text)
                                    .child(Tool::Launcher.label()),
                            )
                        })
                        .children(pills)
                        .child(
                            div()
                                .relative()
                                .mt(px(1.3))
                                .child(
                                    super::header::icon_button(
                                        "panel-new-tab",
                                        opener_icon,
                                        opener_size,
                                        opener_weight,
                                        // The tooltip would sit over the open menu.
                                        if menu.is_some() { "" } else { opener_label },
                                        true,
                                    )
                                    .when(browser.is_some(), |button| {
                                        browser_header::more(button, cx)
                                    })
                                    .when(menu.is_some(), |button| button.bg(theme().hover))
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.capture(window, cx);
                                            let panel = this.features.get::<Panel>();
                                            panel.menu = match panel.menu {
                                                Some(_) => None,
                                                None => Some(std::time::Instant::now()),
                                            };
                                            window.refresh();
                                            cx.notify();
                                        },
                                    )),
                                )
                                .children(menu.map(|appear| add_menu(appear, browser.clone(), cx))),
                        ),
                )
                .child(div().mt(px(1.3)).child(toggle_button(true, cx))),
        )
}

const PANEL: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M16 4v16 M10 9l3 3-3 3";
const COLUMNS: &str = "M5 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z";
const PLUS: &str = "M12 5v14M5 12h14";
// PanelToolIcon in o8-panel/panel-tools.tsx.
const INBOX: &str = "M5 4h14l3 9v7H2v-7l3-9Z M2 13h6l2 3h4l2-3h6";
const TERMINAL: &str =
    "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M7 9l3 3-3 3 M12 16h5";
const REVIEW: &str = "M3 12l4 4L17 6 M12 15l3 3 7-8";
const FILES: &str = "M3 7V4h7l2 3h9v13H3V7h7";
const BROWSER: &str =
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M2 12h20 M12 2c5 5 5 15 0 20-5-5-5-15 0-20Z";
const SPEC: &str = "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5 M14 3l5 5v3 M8 9h6 M8 13h4 M18.4 13.6a1.4 1.4 0 0 1 2 2L16 20l-3 1 1-3Z";
const DEVICES: &str =
    "M9 2h6a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z M10 5h4 M11 19h2";
const THREADS: &str = "M4 4h16v13H9l-5 4V4Z M8 9h8 M8 13h5";
const ACTIVITY: &str = "M2 12h4l3-9 6 18 3-9h4";
const SIDE_CHAT: &str = "M11 5a8 8 0 1 0 0 16 8 8 0 1 0 0-16Z M19 2v6 M16 5h6";
const RESOURCES: &str = "M4 15a8 8 0 0 1 16 0 M12 15l4-4 M12 14a1 1 0 1 0 0 2 1 1 0 1 0 0-2Z";
const TARGETS: &str = "M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16Z M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M12 2v3 M12 19v3 M2 12h3 M19 12h3";
const CLOSE: &str = "M18 6 6 18 M6 6l12 12";
