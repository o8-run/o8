use super::*;

impl Tool {
    pub(super) fn parse(value: &str) -> Self {
        Self::GROUPS
            .iter()
            .flat_map(|(_, tools)| tools.iter())
            .copied()
            .chain([Self::Launcher, Self::Prs, Self::Compare])
            .find(|t| t.slug() == value)
            .unwrap_or(Self::Launcher)
    }
    pub(super) fn utility(self) -> bool {
        !matches!(
            self,
            Self::Launcher | Self::Browser | Self::Prs | Self::Compare
        )
    }
}

pub(super) fn sync(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let scope = s.state.selected.clone().unwrap_or_default();
    let viewport = f32::from(window.viewport_size().width);
    let fresh = s.features.get::<Panel>().scope.as_deref() != Some(scope.as_str());
    let p = s.features.get::<Panel>();
    p.viewport = viewport;
    let ids = [
        "panel-new-tab",
        "panel-more-views",
        "panel-lower-picker",
        "panel-maximize",
        "panel-split",
        "panel-split-resize",
        "header-right-panel",
        "panel-launcher-more",
        "panel-add-browser-page",
        "panel-tab",
    ];
    for id in ids.into_iter().map(String::from).chain(
        Tool::GROUPS
            .iter()
            .flat_map(|(_, tools)| tools.iter())
            .flat_map(|t| {
                [
                    format!("panel-tool-{}", t.label().to_lowercase()),
                    format!("panel-add-{}", t.slug()),
                    format!("panel-tab-select-{}", t.slug()),
                    format!("panel-tab-close-{}", t.slug()),
                ]
            }),
    ) {
        p.focus.entry(id).or_insert_with(|| cx.focus_handle());
    }
    let finish_drag = p.split_drag && !cx.has_active_drag();
    if finish_drag {
        p.split_drag = false;
    }
    if !fresh {
        if viewport < 1180. && p.motion.is_open() {
            p.motion.set(false);
            p.morph.set(false);
            p.maximized = false;
            cx.notify();
        }
        if viewport >= 1180.
            && s.state.right_panel.visible
            && !s.features.get::<Panel>().motion.is_open()
        {
            s.features.get::<Panel>().motion.set(true);
            s.features.get::<Panel>().morph.set(true);
            cx.notify();
        }
        if finish_drag {
            s.persist();
        }
        contextual::refresh(s, cx);
        return;
    }
    let saved = s.state.right_panel.clone();
    let p = s.features.get::<Panel>();
    p.scope = Some(scope.clone());
    p.tabs = saved
        .utility_tabs
        .get(&scope)
        .into_iter()
        .flatten()
        .map(|v| Tool::parse(v))
        .filter(|v| v.utility())
        .fold(vec![], |mut out, v| {
            if !out.contains(&v) {
                out.push(v);
            }
            out
        });
    p.selected = Tool::parse(&saved.primary);
    p.active = p.tabs.iter().position(|t| *t == p.selected).unwrap_or(0);
    p.lower = saved.split.then(|| Tool::parse(&saved.secondary)).map(|t| {
        if t == p.selected {
            if t == Tool::Browser {
                Tool::Spec
            } else {
                Tool::Browser
            }
        } else {
            t
        }
    });
    p.motion = Transition::settled(260, saved.visible && viewport >= 1180.);
    p.morph = Transition::settled(200, saved.visible && viewport >= 1180.);
    p.content = Transition::settled(200, true);
    let (upper, lower) = (p.selected, p.lower);
    if saved.visible && viewport >= 1180. {
        show(s, upper, window, cx);
        if let Some(lower) = lower {
            show(s, lower, window, cx);
            s.features.get::<Panel>().selected = upper;
            s.features.get::<Panel>().lower = Some(lower);
        }
        save(s);
    }
    contextual::refresh(s, cx);
}

pub(super) fn save(s: &mut Shell) {
    let p = s.features.get::<Panel>();
    let (scope, tabs, primary, lower) = (
        p.scope.clone().unwrap_or_default(),
        p.tabs.iter().map(|t| t.slug()).collect(),
        p.selected.slug(),
        p.lower,
    );
    let saved = &mut s.state.right_panel;
    saved.primary = primary;
    saved.utility_tabs.insert(scope, tabs);
    saved.split = lower.is_some();
    if let Some(t) = lower {
        saved.secondary = t.slug();
    }
    s.persist();
}

pub(super) fn select(s: &mut Shell, tool: Tool, _: &mut Window, cx: &mut Context<Shell>) {
    let p = s.features.get::<Panel>();
    if p.lower == Some(tool) {
        p.lower = Some(p.selected);
    }
    if p.selected != tool || !p.motion.is_open() {
        p.content = Transition::new(200);
        p.content.set(true);
    }
    if tool.utility() && !p.tabs.contains(&tool) {
        p.tabs.push(tool);
    }
    p.active = p
        .tabs
        .iter()
        .position(|t| *t == tool)
        .unwrap_or(p.active.min(p.tabs.len().saturating_sub(1)));
    p.selected = tool;
    p.menu = None;
    p.motion.set(true);
    p.morph.set(true);
    s.state.right_panel.visible = true;
    save(s);
    cx.notify();
}

pub(super) fn preferred_width(s: &Shell) -> f32 {
    let ordinary = s.state.right_panel_width.unwrap_or(440.);
    let p = s.features.read::<Panel>();
    let has = |t| p.is_some_and(|p| p.selected == t || p.lower == Some(t));
    let wide = if has(Tool::Compare) {
        Some(("compare", 960.))
    } else if has(Tool::Spec) {
        Some(("spec", 600.))
    } else if has(Tool::Devices) {
        Some(("device", 600.))
    } else {
        None
    };
    wide.map_or(ordinary, |(key, default)| {
        s.state
            .right_panel
            .tool_widths
            .get(key)
            .copied()
            .unwrap_or(ordinary.max(default))
    })
}
pub(super) fn set_width(s: &mut Shell, value: f32) {
    let p = s.features.get::<Panel>();
    let has = |t| p.selected == t || p.lower == Some(t);
    if let Some(key) = if has(Tool::Compare) {
        Some("compare")
    } else if has(Tool::Spec) {
        Some("spec")
    } else if has(Tool::Devices) {
        Some("device")
    } else {
        None
    } {
        s.state.right_panel.tool_widths.insert(key.into(), value);
    } else {
        s.state.right_panel_width = Some(value);
    }
}

pub(super) fn focus(s: &Shell, id: &str, window: &mut Window) {
    if let Some(f) = s.features.read::<Panel>().and_then(|p| p.focus.get(id)) {
        f.focus(window);
    }
}
pub(super) fn menu(s: &mut Shell, lower: bool, window: &mut Window, cx: &mut Context<Shell>) {
    let p = s.features.get::<Panel>();
    p.menu_lower = lower;
    p.menu = if p.menu.is_some() {
        None
    } else {
        Some(std::time::Instant::now())
    };
    p.menu_index = 0;
    if p.menu.is_some() {
        focus(
            s,
            if lower {
                "panel-add-files"
            } else {
                "panel-add-browser-page"
            },
            window,
        );
    } else {
        focus(
            s,
            if lower {
                "panel-lower-picker"
            } else {
                "panel-more-views"
            },
            window,
        );
    }
    cx.notify();
}
pub(super) fn choose(s: &mut Shell, tool: Tool, window: &mut Window, cx: &mut Context<Shell>) {
    let lower = s.features.get::<Panel>().menu_lower;
    let upper = s.features.get::<Panel>().selected;
    let previous = s.features.get::<Panel>().lower;
    show(s, tool, window, cx);
    if lower {
        let p = s.features.get::<Panel>();
        p.selected = if tool == upper {
            previous.unwrap_or(if tool == Tool::Browser {
                Tool::Spec
            } else {
                Tool::Browser
            })
        } else {
            upper
        };
        p.lower = Some(tool);
    }
    save(s);
    focus(
        s,
        if lower {
            "panel-lower-picker"
        } else {
            "panel-more-views"
        },
        window,
    );
    cx.notify();
}
pub(super) fn split(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let p = s.features.get::<Panel>();
    if p.lower.take().is_none() {
        let upper = p.selected;
        let lower = Tool::parse(&s.state.right_panel.secondary);
        let lower = if lower == upper {
            if upper == Tool::Browser {
                Tool::Spec
            } else {
                Tool::Browser
            }
        } else {
            lower
        };
        show(s, lower, window, cx);
        let p = s.features.get::<Panel>();
        p.selected = upper;
        p.lower = Some(lower);
    }
    save(s);
    focus(s, "panel-split", window);
    cx.notify();
}
pub(super) fn key(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> bool {
    let key = event.keystroke.key.as_str();
    let overlays = s.palette || super::super::header_tools::any_open(s);
    let p = s.features.get::<Panel>();
    if p.menu.is_some() {
        if matches!(key, "escape" | "tab") {
            let lower = p.menu_lower;
            p.menu = None;
            focus(
                s,
                if lower {
                    "panel-lower-picker"
                } else {
                    "panel-more-views"
                },
                window,
            );
            if key == "tab" {
                if event.keystroke.modifiers.shift {
                    window.focus_prev()
                } else {
                    window.focus_next()
                }
            };
            cx.notify();
            return true;
        }
        let tools: Vec<_> = Tool::GROUPS
            .iter()
            .flat_map(|(_, t)| t.iter())
            .copied()
            .collect();
        let offset = usize::from(!p.menu_lower);
        let len = tools.len() + offset;
        let index = match key {
            "home" => 0,
            "end" => len - 1,
            "down" | "right" => (p.menu_index + 1) % len,
            "up" | "left" => (p.menu_index + len - 1) % len,
            _ => return false,
        };
        p.menu_index = index;
        let id = if index == 0 && offset == 1 {
            "panel-add-browser-page".into()
        } else {
            format!("panel-add-{}", tools[index - offset].slug())
        };
        focus(s, &id, window);
        cx.notify();
        return true;
    }
    if key == "escape" && p.maximized && !overlays {
        p.maximized = false;
        focus(s, "panel-maximize", window);
        cx.notify();
        return true;
    }
    if p.focus
        .get("panel-split-resize")
        .is_some_and(|f| f.is_focused(window))
    {
        let ratio = s.state.right_panel.ratio;
        let next = match key {
            "up" => ratio - 5.,
            "down" => ratio + 5.,
            "home" => 25.,
            "end" => 75.,
            _ => return false,
        };
        s.state.right_panel.ratio = next.clamp(25., 75.);
        s.persist();
        cx.notify();
        return true;
    }
    let launcher = p.selected == Tool::Launcher
        && p.focus
            .get("panel-tab")
            .is_some_and(|f| f.is_focused(window));
    let selected = p.tabs.iter().position(|tool| {
        p.focus
            .get(&format!("panel-tab-select-{}", tool.slug()))
            .is_some_and(|f| f.is_focused(window))
    });
    if let Some(index) = selected.or_else(|| launcher.then_some(p.tabs.len())) {
        if !launcher && (key == "delete" || key == "backspace") {
            close_tab(s, index, window, cx);
            let tool = s.features.get::<Panel>().current();
            let id = if tool == Tool::Launcher {
                "panel-tab".into()
            } else {
                format!("panel-tab-select-{}", tool.slug())
            };
            focus(s, &id, window);
            return true;
        }
        let len = p.tabs.len();
        if len == 0 {
            return false;
        }
        let next = match key {
            "left" | "end" if launcher => len - 1,
            "right" | "home" if launcher => 0,
            "left" => (index + len - 1) % len,
            "right" => (index + 1) % len,
            "home" => 0,
            "end" => len - 1,
            _ => return false,
        };
        let tool = p.tabs[next];
        p.scroll.request_reveal();
        show(s, tool, window, cx);
        focus(s, &format!("panel-tab-select-{}", tool.slug()), window);
        return true;
    }
    false
}

pub(super) fn pane(s: &Shell, tool: Tool, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    if tool == Tool::Launcher {
        return launcher(s, cx);
    }
    if s.state.selected.is_none()
        && matches!(
            tool,
            Tool::Files | Tool::Spec | Tool::Review | Tool::Activity | Tool::Prs | Tool::Terminal
        )
    {
        return div()
            .debug_selector(|| "panel-no-repository".into())
            .size_full()
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .gap(px(8.))
            .p(px(24.))
            .child("No repository selected")
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Select a repository to use this panel view."),
            )
            .into_any_element();
    }
    match tool {
        Tool::Devices => super::super::devices::element(s, cx),
        Tool::Compare => contextual::comparison(s, cx),
        Tool::Prs => contextual::pr(s, cx),
        tool if !tool.ready() => placeholder(tool).into_any_element(),
        tool => s
            .content
            .get(&super::key(s, tool))
            .map(Content::element)
            .or_else(|| {
                p.files
                    .get(&super::key(s, tool))
                    .map(|v| v.clone().into_any_element())
            })
            .or_else(|| {
                p.browsers
                    .get(&super::key(s, tool))
                    .map(|v| v.clone().into_any_element())
            })
            .unwrap_or_else(|| div().child("Preparing panel view…").into_any_element()),
    }
}
pub(super) fn body(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let upper = pane(s, p.selected, cx);
    let Some(lower) = p.lower else { return upper };
    let bounds = p.split_bounds.clone();
    let ratio = s.state.right_panel.ratio;
    let share = |body, amount| {
        let mut v = div()
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_hidden()
            .child(body);
        v.style().flex_grow = Some(amount);
        v.style().flex_basis = Some(px(0.).into());
        v
    };
    div()
        .debug_selector(|| "panel-split-body".into())
        .relative()
        .size_full()
        .flex()
        .flex_col()
        .child(share(upper, ratio))
        .child(chrome::divider(s, lower, cx))
        .child(share(pane(s, lower, cx), 100. - ratio))
        .child(
            canvas(move |b, _, _| bounds.set(b), |_, _, _, _| {})
                .absolute()
                .inset_0(),
        )
        .on_drag_move(
            cx.listener(move |s, e: &gpui::DragMoveEvent<SplitDrag>, _, cx| {
                let p = s.features.get::<Panel>();
                p.split_drag = true;
                let b = p.split_bounds.get();
                let available = (f32::from(b.size.height) - 36.).max(1.);
                s.state.right_panel.ratio = ((f32::from(e.event.position.y - b.top()) / available)
                    * 100.)
                    .round()
                    .clamp(25., 75.);
                cx.notify();
            }),
        )
        .into_any_element()
}
pub(super) struct SplitDrag;
impl Render for SplitDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}
