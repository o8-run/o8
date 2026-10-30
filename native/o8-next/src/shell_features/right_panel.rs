use super::*;
use crate::motion::Transition;
use gpui::SharedString;
#[path = "right_panel/chrome.rs"]
mod chrome;
#[path = "right_panel/context.rs"]
mod contextual;
#[path = "right_panel/layout.rs"]
mod layout;
#[path = "right_panel/pages.rs"]
mod pages;
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
            run: |s, _, window, cx| {
                layout::sync(s, window, cx);
                move_inbox_tabs(s, window, cx)
            },
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 90,
            dispatch: |s, event, window, cx| {
                if layout::key(s, event, window, cx) {
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
                    layout::set_width(s, (width + step).clamp(min, max));
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
    Prs,
    Compare,
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
            Tool::Threads | Tool::SideChat | Tool::Resources | Tool::Targeting
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
            Tool::Prs => "Pull requests",
            Tool::Compare => "Compare",
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
            Tool::Prs => "Review a pull request",
            Tool::Compare => "Compare candidates",
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
            Tool::Prs => REVIEW,
            Tool::Compare => COLUMNS,
        }
    }
    fn slug(self) -> String {
        self.label().to_lowercase().replace([' ', '.'], "-")
    }
}

struct Panel {
    /// The column's width and fade: 260ms, as the desktop column animates.
    motion: Transition,
    morph: Transition,
    /// The tool's own fade and 12px slide: 200ms.
    content: Transition,
    /// Open tabs in strip order; the empty strip shows the tool list.
    tabs: Vec<Tool>,
    active: usize,
    selected: Tool,
    viewport: f32,
    scope: Option<String>,
    lower: Option<Tool>,
    maximized: bool,
    more: bool,
    menu_lower: bool,
    menu_index: usize,
    focus: std::collections::HashMap<String, gpui::FocusHandle>,
    launcher_height: std::rc::Rc<std::cell::Cell<f32>>,
    launcher_scroll: gpui::ScrollHandle,
    split_drag: bool,
    split_bounds: std::rc::Rc<std::cell::Cell<gpui::Bounds<gpui::Pixels>>>,
    pages: pages::Pages,
    contexts: contextual::Contexts,
    scroll: super::tab_scroll::Strip,
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
            morph: Transition::new(200),
            content: Transition::new(200),
            tabs: vec![],
            active: 0,
            selected: Tool::Launcher,
            viewport: 1200.,
            scope: None,
            lower: None,
            maximized: false,
            more: false,
            menu_lower: false,
            menu_index: 0,
            focus: Default::default(),
            launcher_height: Default::default(),
            launcher_scroll: Default::default(),
            split_drag: false,
            split_bounds: Default::default(),
            pages: Default::default(),
            contexts: Default::default(),
            scroll: Default::default(),
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
        self.selected
    }
}

fn key(s: &Shell, tool: Tool) -> String {
    format!(
        "panel|{}|{tool:?}",
        s.state.selected.as_deref().unwrap_or("")
    )
}

impl Shell {
    /// The content key of the open panel's front tool, so a surface knows it
    /// is on screen there as well as in the main area.
    pub(crate) fn panel_shows(&self, probe: impl Fn(&str) -> bool) -> bool {
        self.features.read::<Panel>().is_some_and(|p| {
            p.motion.is_open()
                && (probe(&key(self, p.current())) || p.lower.is_some_and(|t| probe(&key(self, t))))
        })
    }
    pub(crate) fn panel_front_key(&self) -> Option<String> {
        let panel = self.features.read::<Panel>()?;
        panel.motion.is_open().then(|| key(self, panel.current()))
    }
}

pub(super) fn sync(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    layout::sync(s, window, cx);
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
    if moving || panel.morph.value().1 || panel.content.value().1 || menu_moving {
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
    let max = MAX_WIDTH.min(
        (available - WORKSPACE_RESERVE - if s.system_glass { COLUMN_CHROME } else { 1. }).max(0.),
    );
    (MIN_WIDTH.min(max), max)
}

/// The column's full width: the dragged one within this window's bounds,
/// else the default.
fn full_width(s: &Shell, viewport: f32) -> f32 {
    let available = viewport
        - super::super::rail::WIDTH
        - if s.surfaces.sidebar.hidden {
            0.
        } else {
            super::super::sidebar::width(s)
        };
    if maximized(s) {
        return available.max(0.);
    }
    let (min, max) = width_bounds(s, viewport);
    layout::preferred_width(s).clamp(min, max)
}
pub(super) fn maximized(s: &Shell) -> bool {
    s.features
        .read::<Panel>()
        .is_some_and(|p| p.maximized && p.motion.is_open())
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
    layout::set_width(s, width.clamp(min, max));
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
                .top(px(if s.system_glass { 22. } else { 0. }))
                .bottom(px(if s.system_glass { 22. } else { 0. }))
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
            layout::select(s, tool, window, cx);
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
            layout::select(s, tool, window, cx);
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
        let view = cx.new(crate::browser_panel::BrowserPanel::new);
        s.features.get::<Panel>().browsers.insert(key.clone(), view);
    }
    if tool == Tool::Browser {
        pages::ensure(s, cx);
    }
    if tool == Tool::Compare {
        contextual::ensure_comparison(s, cx);
    }
    if tool == Tool::Prs {
        contextual::ensure_prs(s, window, cx);
    }
    layout::select(s, tool, window, cx);
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
        "devices" => Tool::Devices,
        "prs" => Tool::Prs,
        "compare" => Tool::Compare,
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
        view.update(cx, |browser, cx| browser.navigate(url, cx));
    }
    true
}

pub(super) fn open_pr(
    s: &mut Shell,
    repo: String,
    number: u64,
    w: &mut Window,
    cx: &mut Context<Shell>,
) {
    contextual::open_pr(s, repo, number, w, cx)
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
        s.features.get::<Panel>().morph.set(false);
        s.features.get::<Panel>().maximized = false;
        s.state.right_panel.visible = false;
        s.persist();
        s.restore_focus(window, cx);
        cx.notify();
    } else {
        if f32::from(window.viewport_size().width) < 1180. {
            return;
        }
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
    super::devices::sync_visibility(s, window, cx);
    let (full, shown) = width(s, window)?;
    let panel = s.features.read::<Panel>()?;
    let (travel, _) = panel.motion.value();
    let (arrive, _) = panel.content.value();
    let body = layout::body(s, cx);
    // A fixed-width inner column, clipped by the travelling outer width, so the
    // tool never reflows while the panel opens or closes.
    let element = div()
        .debug_selector(|| "panel-content".into())
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
    let visible = (panel.current() == Tool::Browser || panel.lower == Some(Tool::Browser))
        && panel.motion.is_open()
        && !panel.motion.value().1
        && !s.palette
        && panel.menu.is_none()
        && !super::header_tools::any_open(s);
    let current = panel.browsers.get(&key(s, Tool::Browser));
    for view in panel.browsers.values() {
        let covered = !visible || current != Some(view);
        view.update(cx, |browser, _| browser.cover(covered));
    }
}

/// Devices follows the same settled, uncovered native-view rule as Browser.
pub(super) fn devices_visible(s: &Shell) -> bool {
    s.features.read::<Panel>().is_some_and(|panel| {
        (panel.current() == Tool::Devices || panel.lower == Some(Tool::Devices))
            && panel.motion.is_open()
            && !panel.motion.value().1
            && !s.palette
            && panel.menu.is_none()
            && !super::header_tools::any_open(s)
    })
}

/// Closes one tab and focuses its neighbour, as a browser strip does.
fn close_tab(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let panel = s.features.get::<Panel>();
    if index >= panel.tabs.len() {
        return;
    }
    let was_active = panel.tabs.get(index) == Some(&panel.selected);
    panel.tabs.remove(index);
    if index < panel.active || (was_active && panel.active == panel.tabs.len()) {
        panel.active = panel.active.saturating_sub(1);
    }
    if was_active {
        panel.content = Transition::new(200);
        panel.content.set(true);
        let tool = panel
            .tabs
            .get(panel.active)
            .copied()
            .unwrap_or(Tool::Launcher);
        panel.selected = tool;
        if tool != Tool::Launcher {
            show(s, tool, window, cx);
            return;
        }
    }
    layout::save(s);
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

fn launcher(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    chrome::launcher(s, cx)
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

pub(super) fn toggle_button(
    s: &Shell,
    open: bool,
    cx: &mut Context<Shell>,
) -> gpui::Stateful<gpui::Div> {
    chrome::toggle(s, open, cx)
}
pub(super) fn header(s: &Shell, full: f32, shown: f32, cx: &mut Context<Shell>) -> AnyElement {
    chrome::header(s, full, shown, cx)
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
