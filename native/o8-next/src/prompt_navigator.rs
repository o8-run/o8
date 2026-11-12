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
pub(crate) type Wheel = Rc<dyn Fn(&gpui::ScrollWheelEvent, &mut Window, &mut App)>;
#[derive(Clone)]
struct Prompt {
    id: String,
    row: usize,
}
struct CachedPreview {
    prompt: Weak<RefCell<RowState>>,
    answer_row: Option<Weak<RefCell<RowState>>>,
    title: gpui::SharedString,
    answer: gpui::SharedString,
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
    /// The rail's own preview follows keyboard selection, never focus alone.
    keyed: bool,
    range: Option<usize>,
    current: Option<String>,
    preview: Option<CachedPreview>,
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
            keyed: false,
            range: None,
            current: None,
            preview: None,
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
            let anchor = self
                .range
                .and_then(|start| self.prompts.get(start))
                .map(|p| p.id.clone());
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
            self.range = anchor.and_then(|id| self.prompts.iter().position(|p| p.id == id));
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
    fn preview_text(
        &mut self,
        rows: &Rows,
        index: usize,
    ) -> (gpui::SharedString, gpui::SharedString) {
        let prompt = &rows[self.prompts[index].row];
        let end = self.prompts.get(index + 1).map_or(rows.len(), |p| p.row);
        let answer = rows[self.prompts[index].row + 1..end]
            .iter()
            .rev()
            .find(|row| matches!(&row.borrow().row, Row::Message{role,..} if role == "assistant"));
        let same_prompt = self
            .preview
            .as_ref()
            .and_then(|p| p.prompt.upgrade())
            .is_some_and(|old| Rc::ptr_eq(&old, prompt));
        let same_answer = self
            .preview
            .as_ref()
            .is_some_and(|p| match (&p.answer_row, answer) {
                (None, None) => true,
                (Some(old), Some(answer)) => {
                    old.upgrade().is_some_and(|old| Rc::ptr_eq(&old, answer))
                }
                _ => false,
            });
        if !same_prompt || !same_answer {
            let title = if same_prompt {
                self.preview.as_ref().unwrap().title.clone()
            } else {
                prompt_title(&prompt.borrow().row).into()
            };
            let text = answer
                .map(|row| match &row.borrow().row {
                    Row::Message { nodes, .. } => node_preview(nodes, 1500),
                    _ => String::new(),
                })
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "No text response recorded".into());
            self.preview = Some(CachedPreview {
                prompt: Rc::downgrade(prompt),
                answer_row: answer.map(Rc::downgrade),
                title,
                answer: text.into(),
            });
        }
        let cached = self.preview.as_ref().unwrap();
        (cached.title.clone(), cached.answer.clone())
    }
    #[cfg(test)]
    pub(crate) fn cached_preview(&self) -> Option<(gpui::SharedString, gpui::SharedString)> {
        self.preview
            .as_ref()
            .map(|p| (p.title.clone(), p.answer.clone()))
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
fn prompt_title(row: &Row) -> String {
    let title = match row {
        Row::PacketHeader { prompt, .. } => {
            let source: String = prompt.chars().take(1500).collect();
            node_preview(&crate::text::markdown(&source), 512)
        }
        Row::Message { nodes, .. } => node_preview(nodes, 512),
        _ => String::new(),
    };
    if title.is_empty() {
        "Attachment".into()
    } else {
        title
    }
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
    on_wheel: Wheel,
) -> AnyElement {
    canvas(
        move |bounds, window, cx| {
            let clip = bounds.intersect(&window.content_mask().bounds);
            if clip.size.width <= px(0.)
                || clip.size.height <= px(0.)
                || bounds.size.height <= px(80.)
            {
                return Vec::new();
            }
            let (id, prompts, focus) = {
                let mut s = state.borrow_mut();
                s.prepare(&rows, cx);
                if s.prompts.len() < 2 {
                    return Vec::new();
                }
                (s.id, s.prompts.clone(), s.focus.as_ref().unwrap().clone())
            };
            let current = prompts
                .partition_point(|p| p.row <= list.logical_scroll_top().item_ix)
                .saturating_sub(1);
            // Virtualize prompt ticks, preserving a 12px target and access to
            // every prompt through paging and keyboard selection.
            let available = (f32::from(bounds.size.height) - 32.).min(360.);
            let capacity = (((available - 36.) / 12.).floor() as usize).clamp(1, 24);
            let visible = prompts.len().min(capacity);
            let paged = prompts.len() > visible;
            let (start, preview_index) = {
                let mut s = state.borrow_mut();
                if s.current.as_ref() != Some(&prompts[current].id) {
                    if s.range
                        .is_some_and(|start| current < start || current >= start + visible)
                    {
                        s.range = None;
                    }
                    s.current = Some(prompts[current].id.clone());
                }
                if !focus.is_focused(window) {
                    s.keyed = false;
                }
                let start = s
                    .range
                    .unwrap_or(current.saturating_sub(visible / 2))
                    .min(prompts.len() - visible);
                let preview = s
                    .hovered
                    .clone()
                    .or_else(|| {
                        (focus.is_focused(window) && s.keyed).then(|| {
                            s.selected
                                .clone()
                                .unwrap_or_else(|| prompts[current].id.clone())
                        })
                    })
                    .and_then(|id| prompts.iter().position(|p| p.id == id))
                    .filter(|index| *index >= start && *index < start + visible);
                (start, preview)
            };
            let height = visible as f32 * 12. + if paged { 36. } else { 0. };
            let top = (f32::from(bounds.size.height) - height) / 2.;
            let rail_origin = point(bounds.origin.x, bounds.origin.y + px(top));
            let tick_top = if paged { 18. } else { 0. };
            let pointer_index = move |y: gpui::Pixels| {
                let y = f32::from(y - rail_origin.y) - tick_top;
                (y >= 0. && y < visible as f32 * 12.).then(|| start + (y / 12.).floor() as usize)
            };
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
            let wheel_state = state.clone();
            let wheel = on_wheel.clone();
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
                    wheel_list.scroll_by(-event.delta.pixel_delta(px(20.)).y);
                    {
                        let mut s = wheel_state.borrow_mut();
                        s.hovered = None;
                        s.keyed = false;
                        s.range = None;
                    }
                    wheel(event, window, cx);
                    window.refresh();
                    cx.stop_propagation();
                })
                .on_mouse_move(move |event, window, _| {
                    if event.pressed_button.is_some() {
                        return;
                    }
                    let next = pointer_index(event.position.y)
                        .map(|index| mouse_prompts[index].id.clone());
                    let mut s = mouse_state.borrow_mut();
                    if s.hovered != next {
                        if next.is_some() {
                            s.selected = next.clone();
                        }
                        s.hovered = next;
                        s.keyed = false;
                        window.refresh();
                    }
                })
                .on_hover(move |hovering, window, _| {
                    let mut s = hover_state.borrow_mut();
                    if !*hovering && (s.hovered.take().is_some() || s.keyed) {
                        s.keyed = false;
                        window.refresh();
                    }
                })
                .on_click(move |event, window, cx| {
                    let index = if let Some(position) = event.mouse_position() {
                        let Some(index) = click_index(position.y) else {
                            return;
                        };
                        index
                    } else {
                        click_state
                            .borrow()
                            .selected
                            .as_ref()
                            .and_then(|id| click_prompts.iter().position(|p| &p.id == id))
                            .unwrap_or(current)
                    };
                    {
                        let mut s = click_state.borrow_mut();
                        s.selected = Some(click_prompts[index].id.clone());
                        s.hovered = None;
                        s.keyed = false;
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
                        "escape" if s.keyed || s.hovered.is_some() => {
                            s.hovered = None;
                            s.keyed = false;
                            window.refresh();
                            cx.stop_propagation();
                            return;
                        }
                        "enter" | "space" => {
                            s.hovered = None;
                            s.keyed = false;
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
                    if next < start {
                        s.range = Some(next);
                    } else if next >= start + visible {
                        s.range = Some(next + 1 - visible);
                    }
                    s.selected = Some(key_prompts[next].id.clone());
                    s.hovered = None;
                    s.keyed = true;
                    window.refresh();
                    cx.stop_propagation();
                });
            for (offset, prompt) in prompts.iter().skip(start).take(visible).enumerate() {
                let index = start + offset;
                let selector = prompt.id.clone();
                let marked = prompt.id.clone();
                let selected = preview_index == Some(index);
                let active = index == current;
                rail = rail.child(
                    div()
                        .debug_selector(move || format!("prompt-nav-tick-{selector}"))
                        .absolute()
                        .left_0()
                        .top(px(tick_top + offset as f32 * 12.))
                        .w(px(24.))
                        .h(px(12.))
                        .child(
                            div()
                                .when(active, |v| {
                                    v.debug_selector(move || format!("prompt-nav-current-{marked}"))
                                })
                                .absolute()
                                .left(px(6.))
                                .top(px(5.))
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
            if paged {
                for (earlier, to, show) in [
                    (true, start.saturating_sub(visible), start > 0),
                    (
                        false,
                        (start + visible).min(prompts.len() - visible),
                        start + visible < prompts.len(),
                    ),
                ] {
                    if !show {
                        continue;
                    }
                    let page_state = state.clone();
                    let page_focus = focus.clone();
                    let page_selected = prompts[to].id.clone();
                    rail = rail.child(
                        div()
                            .id(if earlier {
                                "prompt-nav-earlier"
                            } else {
                                "prompt-nav-later"
                            })
                            .debug_selector(move || {
                                if earlier {
                                    "prompt-nav-earlier".into()
                                } else {
                                    "prompt-nav-later".into()
                                }
                            })
                            .absolute()
                            .left_0()
                            .top(px(if earlier { 0. } else { height - 18. }))
                            .w(px(24.))
                            .h(px(18.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .hover(|s| s.bg(theme().hover))
                            .child(if earlier { "↑" } else { "↓" })
                            .on_click(move |_, window, cx| {
                                let mut s = page_state.borrow_mut();
                                s.range = Some(to);
                                s.selected = Some(page_selected.clone());
                                s.hovered = None;
                                s.keyed = false;
                                drop(s);
                                page_focus.focus(window);
                                window.refresh();
                                cx.stop_propagation();
                            }),
                    );
                }
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
                let (title, answer) = state.borrow_mut().preview_text(&rows, index);
                let width = (f32::from(bounds.size.width) - 36.).clamp(0., 320.);
                let card_list = list.clone();
                let card_state = state.clone();
                let card_wheel = on_wheel.clone();
                let mut card = div()
                    .id(("prompt-nav-preview", id))
                    .occlude()
                    .on_scroll_wheel(move |event, window, cx| {
                        card_list.scroll_by(-event.delta.pixel_delta(px(20.)).y);
                        {
                            let mut s = card_state.borrow_mut();
                            s.hovered = None;
                            s.keyed = false;
                            s.range = None;
                        }
                        card_wheel(event, window, cx);
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
                let slot = index.saturating_sub(start).min(visible - 1);
                let y = (top + tick_top + (slot as f32 + 0.5) * 12. - f32::from(size.height) / 2.)
                    .clamp(0., f32::from(bounds.size.height - size.height).max(0.));
                card.prepaint_at(bounds.origin + point(px(28.), px(y)), window, cx);
                elements.push(card);
            }
            elements
        },
        |_, elements, window, cx| {
            for mut element in elements {
                element.paint(window, cx);
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}
