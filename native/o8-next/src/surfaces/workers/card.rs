use super::{model::Task, *};
use crate::theme::current as theme;
use gpui::{FontWeight, SharedString};

pub struct Card {
    pub task: Task,
    pub compact: bool,
    pub revision: u64,
    pub selected: bool,
}
impl Card {
    pub fn new(task: Task, compact: bool) -> Self {
        Self {
            task,
            compact,
            revision: 0,
            selected: false,
        }
    }
    pub fn update(&mut self, task: Task, cx: &mut Context<Self>) {
        if self.task != task {
            self.task = task;
            self.revision += 1;
            cx.notify();
        }
    }
}
impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let id = format!("worker-card-{}", self.task.id);
        div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .w_full()
            .px(px(16.))
            .py(px(if self.compact { 10. } else { 16. }))
            .border_1()
            .border_color(if self.selected {
                theme().accent
            } else {
                gpui::transparent_black().into()
            })
            .rounded(px(14.))
            .bg(theme().surface)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .text_size(px(9.5))
                    .font_weight(FontWeight(260.))
                    .text_color(theme().text_faint)
                    .child(format!(
                        "{} · {}",
                        self.task.repo(),
                        self.task.text("referenceLabel")
                    )),
            )
            .child(div().text_size(px(13.5)).child(self.task.text("title")))
    }
}
