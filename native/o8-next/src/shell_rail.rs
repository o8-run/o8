//! Left navigation rail, the native counterpart of CompactNavigationRail.tsx.
//! Surfaces keep their own entries through `Registration::nav`; the rail only
//! lays them out and adds the shell-level destinations.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, Image, ImageFormat, ObjectFit, Rgba, Stateful, img};
use std::sync::{Arc, OnceLock};

// NAVIGATION_RAIL_WIDTH and the 44px rail target in shell-geometry.ts.
pub(super) const WIDTH: f32 = 60.;
const TARGET: f32 = 44.;
const ICON: f32 = 19.;

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Terminal,
    Canvas,
    Plugins,
    Folder,
    PullRequest,
    Setup,
    Keyboard,
    Account,
}

impl Icon {
    // Lucide paths used by the desktop rail, embedded for native use.
    fn path(self) -> &'static str {
        match self {
            Self::Terminal => "m4 17 6-6-6-6 M12 19h8",
            Self::Canvas => {
                "M8 3h8a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5Z M9 9h.01 M15 9h.01 M9 15h.01 M15 15h.01"
            }
            Self::Plugins => {
                "M8 3H5a2 2 0 0 0-2 2v3a3 3 0 1 1 0 6v3a2 2 0 0 0 2 2h3a3 3 0 1 1 6 0h3a2 2 0 0 0 2-2v-3a3 3 0 1 0 0-6V5a2 2 0 0 0-2-2h-3a3 3 0 1 0-6 0Z"
            }
            Self::Folder => {
                "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
            }
            Self::PullRequest => {
                "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12"
            }
            Self::Setup => {
                "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"
            }
            Self::Keyboard => {
                "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M6 8h.01 M10 8h.01 M14 8h.01 M18 8h.01 M8 12h.01 M12 12h.01 M16 12h.01 M7 16h10"
            }
            Self::Account => {
                "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"
            }
        }
    }
}

fn glyph(icon: Icon, color: Rgba) -> impl IntoElement {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#{:02x}{:02x}{:02x}" stroke-opacity="{}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="{}"/></svg>"##,
        (color.r * 255.) as u8,
        (color.g * 255.) as u8,
        (color.b * 255.) as u8,
        color.a,
        icon.path()
    );
    img(Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes())))
        .size(px(ICON))
        .flex_shrink_0()
}

/// One rail target. Callers attach the click handler; `active` marks the open destination.
pub(super) fn button(id: &'static str, icon: Icon, active: bool) -> Stateful<Div> {
    target(id)
        .when(active, |view| view.bg(theme().hover))
        .child(glyph(
            icon,
            if active {
                theme().text
            } else {
                theme().text_secondary
            },
        ))
}

fn target(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(TARGET))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .cursor_pointer()
        .hover(|view| view.bg(theme().hover))
}

fn divider() -> Div {
    div()
        .w(px(27.))
        .h(px(1.))
        .my(px(6.))
        .flex_shrink_0()
        .bg(theme().border)
}

fn brand() -> impl IntoElement {
    static LOGO: OnceLock<Arc<Image>> = OnceLock::new();
    let logo = LOGO.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("surfaces/sidebar/project_identity.png").to_vec(),
        ))
    });
    img(logo.clone())
        .size(px(24.))
        .object_fit(ObjectFit::Contain)
}

impl Shell {
    pub(super) fn render_rail(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let top = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::BeforeWorkspaces, cx))
            .collect::<Vec<_>>();
        let bottom = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::AfterWorkspaces, cx))
            .collect::<Vec<_>>();
        let active = self.active();
        let tab = |id: &'static str, icon: Icon, tab: Tab, command: fn() -> Command| {
            button(id, icon, active.as_ref() == Some(&tab)).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.capture(window, cx);
                    this.execute(command(), window, cx);
                },
            ))
        };
        let projects_open = self.surfaces.projects.open;
        div()
            .id("shell-rail")
            .absolute()
            .top(px(crate::theme::GEOMETRY.header))
            .bottom_0()
            .left_0()
            .w(px(WIDTH))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .py(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .child(
                // Home returns to the workspace, which is what "Back to workspace" did.
                target(if projects_open {
                    "shell-workspace"
                } else {
                    "shell-home"
                })
                .child(brand())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.surfaces.projects.open = false;
                    this.restore_focus(window, cx);
                    cx.notify();
                })),
            )
            .child(tab(
                "rail-terminal",
                Icon::Terminal,
                Tab::Terminal,
                || Command::Terminal,
            ))
            .child(tab("rail-grid", Icon::Canvas, Tab::Grid, || Command::Grid))
            .child(divider())
            .children(top)
            .child(tab(
                "rail-pull-requests",
                Icon::PullRequest,
                Tab::PullRequests,
                || Command::PullRequests,
            ))
            .child(divider())
            .child(div().flex_1().min_h_0())
            .children(bottom)
            .into_any_element()
    }
}
