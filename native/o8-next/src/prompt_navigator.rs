//! Prompt rail adapted to native GPUI from the behavior in T3 Code (MIT):
//! https://github.com/pingdotgg/t3code
//! apps/web/src/components/chat/TimelineMinimap.tsx
//! apps/web/src/components/chat/timelineMinimapItems.ts
//! commit 8f144827f680f4064cb3951b4b60d4e24043748d.
//! Retains upstream's keyboard-selected preview and final assistant per turn;
//! uses o8's list, typography and theme without scroll or hover animation.
use crate::{model::Row, retained::RowState, theme::current as theme};
use gpui::{
    AnyElement, App, FocusHandle, ListOffset, ListState, Window, canvas, div, point, prelude::*, px,
};
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::atomic::{AtomicUsize, Ordering},
};

type Rows = Rc<Vec<Rc<RefCell<RowState>>>>;
pub(crate) type Jump = Rc<dyn Fn(&mut Window, &mut App)>;
#[derive(Clone)]
struct Prompt {
    id: String,
    row: usize,
}
pub(crate) struct Navigator {
    id: usize,
    rows: Weak<Vec<Rc<RefCell<RowState>>>>,
    prompts: Rc<Vec<Prompt>>,
    focus: Option<FocusHandle>,
    hovered: Option<String>,
    selected: Option<String>,
    aligned: bool,
    pending: bool,
}
impl Default for Navigator {
    fn default() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            rows: Weak::new(),
            prompts: Rc::default(),
            focus: None,
            hovered: None,
            selected: None,
            aligned: false,
            pending: false,
        }
    }
}
impl Navigator {
    pub(crate) fn is_aligned(&self) -> bool {
        self.aligned
    }
    pub(crate) fn resume(&mut self) {
        self.aligned = false;
        self.pending = false;
    }
    pub(crate) fn ready(&mut self) {
        self.pending = false;
    }
    pub(crate) fn at_end(&self, list: &ListState) -> bool {
        if self.pending {
            return false;
        }
        if self.aligned {
            list.max_offset_for_scrollbar().height + list.scroll_px_offset_for_scrollbar().y
                <= px(1.)
        } else {
            crate::retained::at_end(list)
        }
    }
    pub(crate) fn resume_at_end(&mut self, list: &ListState) -> bool {
        if self.aligned && self.at_end(list) {
            self.resume();
            crate::retained::pin_end(list);
            true
        } else {
            false
        }
    }
    pub(crate) fn bottom_space(&self, height: gpui::Pixels) -> gpui::Pixels {
        if self.aligned {
            (height - px(1.)).max(px(0.))
        } else {
            px(0.)
        }
    }
    fn prepare(&mut self, rows: &Rows, cx: &App) {
        if !self
            .rows
            .upgrade()
            .is_some_and(|old| Rc::ptr_eq(&old, rows))
        {
            self.prompts = Rc::new(
                rows.iter()
                    .enumerate()
                    .filter_map(|(row, state)| {
                        let state = state.borrow();
                        match &state.row {
                            Row::PacketHeader { id, .. } => Some(Prompt {
                                id: id.clone(),
                                row,
                            }),
                            Row::Message { id, role, .. } if role == "user" => Some(Prompt {
                                id: id.clone(),
                                row,
                            }),
                            _ => None,
                        }
                    })
                    .collect(),
            );
            self.rows = Rc::downgrade(rows);
            for id in [&mut self.hovered, &mut self.selected] {
                if id
                    .as_ref()
                    .is_some_and(|id| !self.prompts.iter().any(|p| &p.id == id))
                {
                    *id = None;
                }
            }
        }
        if self.prompts.len() >= 2 && self.focus.is_none() {
            self.focus = Some(cx.focus_handle().tab_stop(true));
        }
    }
    pub(crate) fn focus(&self, window: &mut Window) -> bool {
        if self.prompts.len() < 2 {
            return false;
        }
        if let Some(focus) = &self.focus {
            focus.focus(window);
            return true;
        }
        false
    }
    pub(crate) fn is_focused(&self, window: &Window) -> bool {
        self.prompts.len() >= 2 && self.focus.as_ref().is_some_and(|f| f.is_focused(window))
    }
}

// Preview only the selected turn; never parse or shape every answer for the rail.
fn compact(chars: impl Iterator<Item = char>, limit: usize) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    let mut count = 0;
    for c in chars {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if count + usize::from(pending_space) + 1 > limit {
            out.push('…');
            break;
        }
        if pending_space {
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        out.push(c);
        count += 1;
    }
    out
}
fn node_preview(nodes: &[crate::text::Node], limit: usize) -> String {
    compact(
        nodes.iter().filter(|n| n.data.is_none()).flat_map(|n| {
            n.runs
                .iter()
                .flat_map(|r| r.text.chars())
                .chain(std::iter::once(' '))
        }),
        limit,
    )
}
fn preview(rows: &Rows, prompts: &[Prompt], index: usize) -> (String, String) {
    let prompt = &rows[prompts[index].row].borrow().row;
    let title = match prompt {
        Row::PacketHeader { prompt, .. } => {
            let source: String = prompt.chars().take(1500).collect();
            node_preview(&crate::text::markdown(&source), 512)
        }
        Row::Message { nodes, .. } => node_preview(nodes, 512),
        _ => String::new(),
    };
    let end = prompts.get(index + 1).map_or(rows.len(), |p| p.row);
    let answer = (prompts[index].row + 1..end)
        .rev()
        .find_map(|i| {
            if let Row::Message { role, nodes, .. } = &rows[i].borrow().row {
                if role == "assistant" {
                    let text = node_preview(nodes, 1500);
                    return Some(text);
                }
            }
            None
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "No text response recorded".into());
    (
        if title.is_empty() {
            "Attachment".into()
        } else {
            title
        },
        answer,
    )
}
fn jump(
    state: &Rc<RefCell<Navigator>>,
    list: &ListState,
    prompt: &Prompt,
    notify: &Jump,
    window: &mut Window,
    cx: &mut App,
) {
    {
        let mut s = state.borrow_mut();
        s.aligned = true;
        s.pending = true;
    }
    notify(window, cx);
    list.scroll_to(ListOffset {
        item_ix: prompt.row,
        offset_in_item: px(0.),
    });
    window.refresh();
}

pub(crate) fn overlay(
    state: Rc<RefCell<Navigator>>,
    rows: Rows,
    list: ListState,
    on_jump: Jump,
) -> AnyElement {
    canvas(
        move |bounds, window, cx| {
            let clip = bounds.intersect(&window.content_mask().bounds);
            if clip.size.width <= px(0.) || clip.size.height <= px(0.) {
                return Vec::new();
            }
            let (id, prompts, focus, hovered, selected) = {
                let mut s = state.borrow_mut();
                s.prepare(&rows, cx);
                if s.prompts.len() < 2 || bounds.size.height <= px(32.) {
                    return Vec::new();
                }
                (
                    s.id,
                    s.prompts.clone(),
                    s.focus.as_ref().unwrap().clone(),
                    s.hovered.clone(),
                    s.selected.clone(),
                )
            };
            let current = prompts
                .partition_point(|p| p.row <= list.logical_scroll_top().item_ix)
                .saturating_sub(1);
            let preview_index = hovered
                .or_else(|| {
                    focus
                        .is_focused(window)
                        .then(|| selected.unwrap_or_else(|| prompts[current].id.clone()))
                })
                .and_then(|id| prompts.iter().position(|p| p.id == id));
            let height = (prompts.len() as f32 * 12.)
                .min(360.)
                .min(f32::from(bounds.size.height) - 32.);
            let top = (f32::from(bounds.size.height) - height) / 2.;
            let rail_origin = point(bounds.origin.x, bounds.origin.y + px(top));
            let pointer_index = move |y: gpui::Pixels| {
                ((f32::from(y - rail_origin.y) / height * prompts.len() as f32)
                    .floor()
                    .max(0.) as usize)
                    .min(prompts.len() - 1)
            };
            // Capture only cheap prompt identities in tick and input elements.
            let prompts = state.borrow().prompts.clone();
            let mouse_state = state.clone();
            let mouse_prompts = prompts.clone();
            let hover_state = state.clone();
            let click_state = state.clone();
            let click_prompts = prompts.clone();
            let click_list = list.clone();
            let click_jump = on_jump.clone();
            let click_focus = focus.clone();
            let key_state = state.clone();
            let key_prompts = prompts.clone();
            let key_list = list.clone();
            let key_jump = on_jump.clone();
            let click_index = pointer_index.clone();
            let wheel_list = list.clone();
            let wheel_jump = on_jump.clone();
            let mut rail = div()
                .id(("prompt-navigator", id))
                .debug_selector(|| "prompt-navigator".into())
                .w(px(24.))
                .h(px(height))
                .relative()
                .track_focus(&focus)
                .tab_stop(true)
                .cursor_pointer()
                .rounded(px(4.))
                .focus(|s| s.bg(theme().hover))
                .on_scroll_wheel(move |event, window, cx| {
                    wheel_jump(window, cx);
                    wheel_list.scroll_by(-event.delta.pixel_delta(px(20.)).y);
                    window.refresh();
                    cx.stop_propagation();
                })
                .on_mouse_move(move |event, window, _| {
                    if event.pressed_button.is_some() {
                        return;
                    }
                    let next = Some(mouse_prompts[pointer_index(event.position.y)].id.clone());
                    let mut s = mouse_state.borrow_mut();
                    if s.hovered != next {
                        s.selected = next.clone();
                        s.hovered = next;
                        window.refresh();
                    }
                })
                .on_hover(move |hovering, window, _| {
                    if !*hovering && hover_state.borrow_mut().hovered.take().is_some() {
                        window.refresh();
                    }
                })
                .on_click(move |event, window, cx| {
                    let index = event
                        .mouse_position()
                        .map(|position| click_index(position.y))
                        .unwrap_or_else(|| {
                            click_state
                                .borrow()
                                .selected
                                .as_ref()
                                .and_then(|id| click_prompts.iter().position(|p| &p.id == id))
                                .unwrap_or(current)
                        });
                    {
                        let mut s = click_state.borrow_mut();
                        s.selected = Some(click_prompts[index].id.clone());
                        s.hovered = event
                            .mouse_position()
                            .map(|_| click_prompts[index].id.clone());
                    }
                    click_focus.focus(window);
                    jump(
                        &click_state,
                        &click_list,
                        &click_prompts[index],
                        &click_jump,
                        window,
                        cx,
                    );
                    cx.stop_propagation();
                })
                .on_key_down(move |event, window, cx| {
                    let mut s = key_state.borrow_mut();
                    let index = s
                        .selected
                        .as_ref()
                        .and_then(|id| key_prompts.iter().position(|p| &p.id == id))
                        .unwrap_or(current);
                    let next = match event.keystroke.key.as_str() {
                        "up" => index.saturating_sub(1),
                        "down" => (index + 1).min(key_prompts.len() - 1),
                        "home" => 0,
                        "end" => key_prompts.len() - 1,
                        "enter" | "space" => {
                            drop(s);
                            jump(
                                &key_state,
                                &key_list,
                                &key_prompts[index],
                                &key_jump,
                                window,
                                cx,
                            );
                            cx.stop_propagation();
                            return;
                        }
                        _ => return,
                    };
                    s.selected = Some(key_prompts[next].id.clone());
                    s.hovered = None;
                    window.refresh();
                    cx.stop_propagation();
                });
            for (index, prompt) in prompts.iter().enumerate() {
                let selector = prompt.id.clone();
                let marked = prompt.id.clone();
                let selected = preview_index == Some(index);
                let active = index == current;
                rail = rail.child(
                    div()
                        .debug_selector(move || format!("prompt-nav-tick-{selector}"))
                        .absolute()
                        .left_0()
                        .top(px(index as f32 * height / prompts.len() as f32))
                        .w(px(24.))
                        .h(px(height / prompts.len() as f32))
                        .child(
                            div()
                                .when(active, |v| {
                                    v.debug_selector(move || format!("prompt-nav-current-{marked}"))
                                })
                                .absolute()
                                .left(px(6.))
                                .top(px(height / prompts.len() as f32 / 2. - 1.))
                                .w(px(if active {
                                    16.
                                } else if selected {
                                    12.
                                } else {
                                    7.
                                }))
                                .h(px(2.))
                                .rounded(px(1.))
                                .bg(if active || selected {
                                    theme().text
                                } else {
                                    theme().text_muted
                                })
                                .opacity(if active || selected { 1. } else { 0.45 }),
                        ),
                );
            }
            let mut elements = Vec::new();
            let mut rail = rail.into_any_element();
            rail.layout_as_root(
                gpui::size(px(24.), px(height)).map(gpui::AvailableSpace::Definite),
                window,
                cx,
            );
            rail.prepaint_at(rail_origin, window, cx);
            elements.push(rail);
            if let Some(index) = preview_index {
                let (title, answer) = preview(&rows, &prompts, index);
                #[cfg(test)]
                crate::ui::prompt_navigator_tests::record_preview(&title, &answer);
                let width = (f32::from(bounds.size.width) - 36.).clamp(0., 320.);
                let card_list = list.clone();
                let card_jump = on_jump.clone();
                let mut card = div()
                    .id(("prompt-nav-preview", id))
                    .occlude()
                    .on_scroll_wheel(move |event, window, cx| {
                        card_jump(window, cx);
                        card_list.scroll_by(-event.delta.pixel_delta(px(20.)).y);
                        window.refresh();
                        cx.stop_propagation();
                    })
                    .debug_selector(|| "prompt-nav-preview".into())
                    .w(px(width))
                    .max_h(bounds.size.height.min(px(80.)))
                    .min_w_0()
                    .overflow_hidden()
                    .p(px(10.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(crate::theme::popover_background())
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .font_family(theme().font_ui)
                    .child(
                        div()
                            .debug_selector(|| "prompt-nav-preview-title".into())
                            .w_full()
                            .min_w_0()
                            .truncate()
                            .text_color(theme().text)
                            .child(title),
                    )
                    .child(
                        div()
                            .debug_selector(|| "prompt-nav-preview-answer".into())
                            .w_full()
                            .max_h(px(36.))
                            .overflow_hidden()
                            .whitespace_normal()
                            .text_ellipsis()
                            .line_clamp(2)
                            .text_color(theme().text_secondary)
                            .child(answer),
                    )
                    .into_any_element();
                let size = card.layout_as_root(
                    gpui::size(
                        gpui::AvailableSpace::Definite(px(width)),
                        gpui::AvailableSpace::MinContent,
                    ),
                    window,
                    cx,
                );
                let y = (top + (index as f32 + 0.5) * height / prompts.len() as f32
                    - f32::from(size.height) / 2.)
                    .clamp(0., (f32::from(bounds.size.height - size.height)).max(0.));
                card.prepaint_at(bounds.origin + point(px(28.), px(y)), window, cx);
                elements.push(card);
            }
            elements
        },
        |_, elements, window, cx| {
            for mut element in elements {
                element.paint(window, cx)
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}
