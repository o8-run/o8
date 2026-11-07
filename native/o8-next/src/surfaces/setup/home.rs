//! The desktop's first page (OnboardingOpen.tsx): "Open a project.", the
//! folder action, your projects, the optional setup cards and the quiet way
//! to start without a project.
use super::look::{self, Look};
use super::{Action, Project, Setup, Snapshot, Step, primary, quiet};
use crate::theme::current as theme;
use gpui::{AnyElement, Context, Div, FontWeight, div, prelude::*, px, relative};

const FOLDER: &str =
    "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z";
const CHEVRON: &str = "m9 5 7 7-7 7";
const PLUS: &str = "M12 5v14M5 12h14";
const TOOLS: &str = "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4";
const IMPORT: &str = "M12 3v12m-5-5 5 5 5-5M5 21h14";

/// The last two parts of a project's folder, as the desktop shows it.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}

/// One optional setup card: an icon, a label, a line under it and ›.
fn card(
    id: &'static str,
    icon: &'static str,
    label: &'static str,
    detail: &'static str,
    busy: bool,
) -> gpui::Stateful<Div> {
    look::button(id, "", !busy, Look::Bordered)
        .flex_1()
        .min_w(px(240.))
        .p(px(16.))
        .rounded(px(12.))
        .bg(gpui::transparent_black())
        .child(crate::icon::stroke(icon, theme().text_secondary, 20., 1.4))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().text_size(px(13.)).child(label))
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(11.))
                        .line_height(relative(1.5))
                        .text_color(theme().text_muted)
                        .child(detail),
                ),
        )
        .child(div().text_color(theme().text_muted).child("›"))
}

impl Setup {
    pub(super) fn home(
        &self,
        busy: bool,
        snapshot: Option<&Snapshot>,
        width: f32,
        cx: &mut Context<Self>,
    ) -> Div {
        let projects = snapshot.map(|s| s.projects.clone()).unwrap_or_default();
        let mut heading = div();
        heading
            .style()
            .text
            .get_or_insert_with(Default::default)
            .letter_spacing = Some(px(-1.2));
        let rows: Vec<AnyElement> = projects
            .into_iter()
            .enumerate()
            .map(|(i, project)| self.project_row(i, project, busy, cx))
            .collect();
        div()
            .debug_selector(|| "setup-projects".into())
            .flex()
            .flex_col()
            .child(
                heading
                    .text_size(px((width * 0.04).clamp(30., 40.)))
                    .font_weight(FontWeight::LIGHT)
                    .line_height(relative(1.15))
                    .child("Open a project."),
            )
            .child(
                div()
                    .mt(px(14.))
                    .mb(px(28.))
                    .text_size(px(14.))
                    .font_weight(FontWeight::LIGHT)
                    .line_height(relative(1.6))
                    .text_color(theme().text_secondary)
                    .child("Use your coding tools in one workspace."),
            )
            .child(
                div().flex().flex_wrap().items_center().gap(px(12.)).child(
                    primary("setup-folder", "", !busy)
                        .px(px(22.))
                        .justify_center()
                        .child(crate::icon::stroke(FOLDER, theme().background, 16., 1.6))
                        .child("Open a folder")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.navigate(Step::Folder, cx);
                            this.folder.read(cx).focus.focus(window);
                        })),
                ),
            )
            .child(
                div()
                    .min_h(px(22.))
                    .mt(px(12.))
                    .text_size(px(12.))
                    .text_color(theme().text_secondary)
                    .when(busy, |v| {
                        v.child(
                            div()
                                .debug_selector(|| "setup-loading".into())
                                .child("Checking setup…"),
                        )
                    }),
            )
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div().mt(px(4.)).mb(px(8.)).child(look::feedback(
                        "setup-error",
                        error,
                        "You can check again, choose another folder, or change your tools below.",
                        Some(
                            quiet("setup-refresh", "Check again", !busy)
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.act(Action::Load(true), cx)),
                                )
                                .into_any_element(),
                        ),
                    )),
                )
            })
            .when_some(self.import.note.clone(), |v, note| {
                v.child(
                    div()
                        .debug_selector(|| "setup-import-note".into())
                        .mt(px(4.))
                        .text_size(px(12.))
                        .text_color(theme().text_secondary)
                        .child(note),
                )
            })
            .when(!rows.is_empty(), |v| {
                v.child(
                    div()
                        .mt(px(16.))
                        .flex()
                        .flex_col()
                        .child(look::label("YOUR PROJECTS").mb(px(8.)).pl(px(12.)))
                        .child(
                            div()
                                .id("setup-project-list")
                                .max_h(px(200.))
                                .overflow_y_scroll()
                                .children(rows),
                        ),
                )
            })
            .child(look::label("OPTIONAL SETUP").mt(px(24.)))
            .child(
                div()
                    .mt(px(8.))
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(
                        card(
                            "setup-new-project",
                            PLUS,
                            "New project",
                            "Create a repository and open it.",
                            busy,
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_new_project(window, cx)),
                        ),
                    )
                    .child(
                        card(
                            "setup-change-tools",
                            TOOLS,
                            "Set up tools",
                            "Choose a coding tool to get started.",
                            busy,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.navigate(Step::Tools, cx))),
                    )
                    .when(self.import.pending(), |v| {
                        v.child(
                            card(
                                "setup-import-open",
                                IMPORT,
                                "Bring in existing threads",
                                "Continue your Codex and Claude Code sessions here.",
                                busy,
                            )
                            .on_click(
                                cx.listener(|this, _, _, cx| this.navigate(Step::Import, cx)),
                            ),
                        )
                    }),
            )
            .child(
                div().mt(px(12.)).flex().child(
                    quiet("setup-explore", "Start without a project", !busy)
                        .pl_0()
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .on_click(cx.listener(|this, _, _, cx| this.act(Action::Choose(None), cx))),
                ),
            )
    }

    /// One project: a quiet row with its folder icon, name and short path.
    fn project_row(
        &self,
        index: usize,
        project: Project,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let path = short_path(&project.local_path);
        let name = project.name.clone();
        quiet(&format!("setup-project-{index}"), "", !busy)
            .w_full()
            .min_h(px(64.))
            .gap(px(16.))
            .text_color(theme().text)
            .hover(|v| v.bg(theme().hover))
            .child(crate::icon::stroke(FOLDER, theme().text_muted, 20., 1.4))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().text_size(px(13.5)).truncate().child(name))
                    .child(
                        div()
                            .mt(px(4.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .truncate()
                            .child(path),
                    ),
            )
            .child(crate::icon::stroke(CHEVRON, theme().text_muted, 14., 1.5))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.act(Action::Choose(Some(project.clone())), cx)
            }))
            .into_any_element()
    }
}
