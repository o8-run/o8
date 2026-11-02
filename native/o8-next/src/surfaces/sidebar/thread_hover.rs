//! A thread's facts one hover away, as classic's side panel has them: where it
//! runs, its repository and branch, and when it last moved.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Corner, Div, Stateful, anchored, deferred, div, point, prelude::*, px};
use std::time::Duration;

const OPEN_DELAY: Duration = Duration::from_millis(450);
const CLOSE_DELAY: Duration = Duration::from_millis(160);
const THIS_COMPUTER: &str = "This computer";
const SERVER_ICON: &str = "M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01";

pub(super) struct ThreadHover {
    id: String,
    open: bool,
    over_card: bool,
    wait: u64,
}

/// Where a thread runs, in a person's words.
fn place(session: &Session) -> &str {
    session.away().unwrap_or(THIS_COMPUTER)
}

/// The simple view's mark for a thread on another computer.
pub(super) fn machine_mark() -> impl IntoElement {
    div().flex_shrink_0().child(crate::icon::stroke(
        SERVER_ICON,
        theme().text_faint,
        11.,
        1.8,
    ))
}

fn updated(age: String) -> String {
    if age == "now" {
        age
    } else {
        format!("{age} ago")
    }
}

fn titled(word: &str) -> String {
    let mut letters = word.chars();
    letters.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(letters).collect()
    })
}

fn fact(label: &'static str, value: String) -> impl IntoElement {
    div()
        .flex()
        .gap(px(10.))
        .text_size(px(11.5))
        .child(
            div()
                .w(px(70.))
                .flex_shrink_0()
                .text_color(theme().text_faint)
                .child(label),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(theme().text_secondary)
                .child(crate::text::sanitize(&value)),
        )
}

impl ThreadList {
    /// Wires a thread row to its card, and draws the card when it's open.
    pub(super) fn with_thread_hover(
        &self,
        row: Stateful<Div>,
        id: String,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let card = self.thread_card(&id, cx);
        let target = id.clone();
        row.on_hover(cx.listener(move |this, hovering: &bool, _, cx| {
            this.row_hover(target.clone(), *hovering, cx);
        }))
        .on_any_mouse_down(cx.listener(|this, _, _, cx| {
            if this.thread_hover.take().is_some() {
                cx.notify();
            }
        }))
        .children(card)
    }

    fn row_hover(&mut self, id: String, hovering: bool, cx: &mut Context<Self>) {
        let same = self.thread_hover.as_ref().is_some_and(|h| h.id == id);
        if !hovering && !same {
            return;
        }
        let hover = self.thread_hover.get_or_insert_with(|| ThreadHover {
            id: id.clone(),
            open: false,
            over_card: false,
            wait: 0,
        });
        if !same {
            *hover = ThreadHover {
                id: id.clone(),
                open: false,
                over_card: false,
                wait: hover.wait,
            };
        }
        hover.wait += 1;
        let wait = hover.wait;
        let delay = if hovering { OPEN_DELAY } else { CLOSE_DELAY };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |this, cx| {
                let Some(hover) = this.thread_hover.as_mut().filter(|h| h.wait == wait) else {
                    return;
                };
                if hovering {
                    hover.open = true;
                } else if !hover.over_card {
                    this.thread_hover = None;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn card_hover(&mut self, hovering: bool, cx: &mut Context<Self>) {
        let Some(hover) = self.thread_hover.as_mut() else {
            return;
        };
        hover.over_card = hovering;
        if !hovering {
            let id = hover.id.clone();
            self.row_hover(id, false, cx);
        }
    }

    fn thread_card(&self, id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.thread_hover
            .as_ref()
            .filter(|hover| hover.open && hover.id == id)?;
        let session = self.sessions.iter().find(|s| s.id == id)?;
        let repo = session
            .repo_slug
            .clone()
            .filter(|repo| !repo.is_empty())
            .or_else(|| session.repo_path.as_deref().map(label));
        let age = crate::clock::age(recents::timestamp(&session.last_message_at), recents::now());
        let card = div()
            .id("thread-hover-card")
            .debug_selector(|| "thread-hover-card".into())
            .occlude()
            .w(px(300.))
            .rounded(px(12.))
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .on_hover(cx.listener(|this, hovering: &bool, _, cx| this.card_hover(*hovering, cx)))
            .child(
                div()
                    .mb(px(4.))
                    .text_size(px(12.5))
                    .text_color(theme().text)
                    .child(crate::text::sanitize(&session.title)),
            )
            .child(fact("Machine", place(session).to_owned()))
            .children(repo.map(|repo| fact("Repo", repo)))
            .children(self.branch_of(session).map(|branch| fact("Branch", branch)))
            .children(
                session
                    .repo_path
                    .clone()
                    .map(|path| fact("Workspace", path)),
            )
            .child(fact("Updated", updated(age)))
            .children(
                session
                    .backend
                    .clone()
                    .filter(|backend| !backend.is_empty())
                    .map(|backend| fact("Backend", titled(&backend))),
            );
        Some(
            div()
                .absolute()
                .top_0()
                .right_0()
                .child(
                    deferred(
                        anchored()
                            .anchor(Corner::TopLeft)
                            .offset(point(px(8.), px(0.)))
                            .snap_to_window_with_margin(px(12.))
                            .child(card),
                    )
                    .with_priority(1),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(machine: Option<&str>) -> Session {
        let mut session: Session = serde_json::from_value(json!({
            "id":"a","title":"t","status":"idle"
        }))
        .unwrap();
        session.machine_label = machine.map(str::to_owned);
        session
    }

    #[test]
    fn a_thread_says_which_computer_it_runs_on() {
        assert_eq!(place(&session(None)), THIS_COMPUTER);
        assert_eq!(place(&session(Some("Linux VM"))), "Linux VM");
        let mut cloud = session(None);
        cloud.runtime = "cloud".into();
        assert_eq!(place(&cloud), "Cloud");
    }

    #[test]
    fn the_card_reads_like_a_sentence_fragment() {
        assert_eq!(updated("44m".into()), "44m ago");
        assert_eq!(updated("now".into()), "now");
        assert_eq!(titled("claude"), "Claude");
        assert_eq!(titled(""), "");
    }
}
