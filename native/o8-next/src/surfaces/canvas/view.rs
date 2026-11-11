use super::{
    geometry::{Camera, Rect},
    model::{Card, Layout},
};
use crate::{client::Client, diff::Target, diff_ui::DiffSurface, theme::current as theme};
use gpui::{prelude::*, *};
use std::collections::HashMap;

#[derive(Clone)]
pub(super) struct Saved(pub Layout);
pub(crate) struct View {
    pub layout: Layout,
    client: Client,
    workspace: String,
    pub diffs: HashMap<String, Entity<DiffSurface>>,
    pub focus: FocusHandle,
    bounds: Bounds<Pixels>,
    drag: Option<Drag>,
    choices: Vec<(String, String)>,
    generation: u64,
    choosing: bool,
    notice: String,
}
#[derive(Clone)]
enum Drag {
    Pan {
        pointer: [f32; 2],
        camera: Camera,
    },
    Card {
        id: String,
        pointer: [f32; 2],
        rect: Rect,
        resize: bool,
    },
}
impl EventEmitter<Saved> for View {}
impl View {
    pub fn new(client: Client, workspace: String, layout: Layout, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            layout: layout.restored(),
            client,
            workspace,
            diffs: HashMap::new(),
            focus: cx.focus_handle(),
            bounds: Bounds::default(),
            drag: None,
            choices: vec![],
            generation: 0,
            choosing: false,
            notice: String::new(),
        };
        view.load(cx);
        view
    }
    pub fn workspace(&mut self, client: Client, workspace: String, cx: &mut Context<Self>) {
        if self.workspace != workspace {
            self.client = client;
            self.workspace = workspace;
            self.load(cx);
        }
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        use super::super::palette::target::Port;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        self.notice = "Reading packets…".into();
        self.choices.clear();
        cx.notify();
        let task = cx.background_executor().spawn(async move {
            <super::super::diff::PacketDiff as Port>::choices(&client, &workspace)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(choices) => {
                        this.choices = choices
                            .into_iter()
                            .filter(|c| !c.id.starts_with("working:"))
                            .map(|c| (c.id, c.label))
                            .collect();
                        this.notice = if this.choices.is_empty() {
                            "No packets available".into()
                        } else {
                            String::new()
                        };
                    }
                    Err(e) => this.notice = e,
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.layout.camera = self.layout.camera.bounded();
        cx.emit(Saved(self.layout.clone()));
        cx.notify();
    }
    pub fn reset(&mut self, cx: &mut Context<Self>) {
        self.drag = None;
        self.layout.camera.zoom_at(
            1.,
            [
                f32::from(self.bounds.size.width) / 2.,
                f32::from(self.bounds.size.height) / 2.,
            ],
        );
        self.changed(cx);
    }
    pub fn fit(&mut self, cx: &mut Context<Self>) {
        self.drag = None;
        self.layout.camera.fit(
            self.layout.diff.iter().map(|c| c.rect),
            [
                self.bounds.size.width.into(),
                self.bounds.size.height.into(),
            ],
        );
        self.changed(cx);
    }
    fn add(&mut self, id: String, title: String, cx: &mut Context<Self>) {
        if self.layout.diff.iter().any(|c| c.lane_id == id) {
            self.layout.raise(&id);
        } else if self.layout.diff.len() < 32 {
            let p = self.layout.camera.to_canvas([32., 32.]);
            self.layout.diff.push(Card {
                lane_id: id,
                title,
                rect: Rect {
                    x: p[0],
                    y: p[1],
                    w: 720.,
                    h: 480.,
                }
                .bounded(),
            });
        }
        self.choosing = false;
        self.changed(cx);
    }
    fn local(&self, p: Point<Pixels>) -> [f32; 2] {
        [
            (p.x - self.bounds.origin.x).into(),
            (p.y - self.bounds.origin.y).into(),
        ]
    }
    fn move_pointer(&mut self, p: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.clone() else {
            return;
        };
        let p = self.local(p);
        match drag {
            Drag::Pan { pointer, camera } => {
                self.layout.camera.pan = [
                    camera.pan[0] + p[0] - pointer[0],
                    camera.pan[1] + p[1] - pointer[1],
                ]
            }
            Drag::Card {
                id,
                pointer,
                rect,
                resize,
            } => {
                let delta = [
                    (p[0] - pointer[0]) / self.layout.camera.zoom,
                    (p[1] - pointer[1]) / self.layout.camera.zoom,
                ];
                if let Some(c) = self.layout.diff.iter_mut().find(|c| c.lane_id == id) {
                    c.rect = if resize {
                        rect.resized(delta)
                    } else {
                        rect.moved(delta)
                    };
                }
            }
        }
        self.changed(cx);
    }
    fn begin(&mut self, id: String, p: Point<Pixels>, resize: bool, cx: &mut Context<Self>) {
        if let Some(c) = self.layout.diff.iter().find(|c| c.lane_id == id) {
            self.drag = Some(Drag::Card {
                id,
                pointer: self.local(p),
                rect: c.rect,
                resize,
            });
        }
        cx.stop_propagation();
    }
    fn card(&self, card: &Card, cx: &mut Context<Self>) -> AnyElement {
        let id = card.lane_id.clone();
        let raise = id.clone();
        let close = id.clone();
        let resize = id.clone();
        let move_id = id.clone();
        let p = self.layout.camera.to_window([card.rect.x, card.rect.y]);
        let zoom = self.layout.camera.zoom;
        div()
            .id(SharedString::from(format!("canvas-card-{id}")))
            .debug_selector({
                let id = id.clone();
                move || format!("canvas-card-{id}")
            })
            .absolute()
            .left(px(p[0]))
            .top(px(p[1]))
            .w(px(card.rect.w * zoom))
            .h(px(card.rect.h * zoom))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface)
            .occlude()
            .capture_any_mouse_down(cx.listener(move |this, _, window, cx| {
                if let Some(diff) = this.diffs.get(&raise) {
                    diff.read(cx).focus(window);
                }
                this.layout.raise(&raise);
                this.changed(cx);
            }))
            .child(
                div()
                    .id(SharedString::from(format!("canvas-header-{id}")))
                    .debug_selector({
                        let id = id.clone();
                        move || format!("canvas-header-{id}")
                    })
                    .h(px(28.))
                    .flex_shrink_0()
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .cursor(gpui::CursorStyle::OpenHand)
                    .text_size(px(12.))
                    .font_weight(FontWeight::LIGHT)
                    .text_color(theme().text_muted)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            this.begin(move_id.clone(), e.position, false, cx)
                        }),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(card.title.clone()),
                    )
                    .child(
                        control(format!("canvas-close-{id}"), "×")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.layout.diff.retain(|c| c.lane_id != close);
                                this.diffs.remove(&close);
                                if let Some(diff) = this
                                    .layout
                                    .diff
                                    .last()
                                    .and_then(|c| this.diffs.get(&c.lane_id))
                                {
                                    diff.read(cx).focus(window);
                                } else {
                                    this.focus.focus(window);
                                }
                                this.changed(cx);
                                cx.stop_propagation();
                            })),
                    ),
            )
            // Reuse the native diff entity. Its virtualized rows reflow to the card's
            // current viewport; the canvas owns geometry, never diff parsing/painting.
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .children(self.diffs.get(&id).cloned()),
            )
            .child(
                div()
                    .id(SharedString::from(format!("canvas-resize-{id}")))
                    .debug_selector(move || format!("canvas-resize-{id}"))
                    .absolute()
                    .bottom_0()
                    .right_0()
                    .size(px(16.))
                    .cursor(CursorStyle::ResizeUpLeftDownRight)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            this.begin(resize.clone(), e.position, true, cx)
                        }),
                    ),
            )
            .into_any_element()
    }
}
fn control(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Stateful<Div> {
    let id = id.into();
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .px(px(8.))
        .h(px(24.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .cursor_pointer()
        .hover(|v| v.bg(theme().hover))
        .text_size(px(12.))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .child(label.into())
}
impl Render for View {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for card in &self.layout.diff {
            if !self.diffs.contains_key(&card.lane_id) {
                let client = self.client.clone();
                let target = Target::Packet(card.lane_id.clone());
                self.diffs.insert(
                    card.lane_id.clone(),
                    cx.new(|cx| DiffSurface::new(client, target, window, cx)),
                );
            }
        }
        let cards = self
            .layout
            .diff
            .iter()
            .map(|c| self.card(c, cx))
            .collect::<Vec<_>>();
        let entity = cx.entity();
        let stage = div()
            .id("canvas-surface")
            .debug_selector(|| "canvas-surface".into())
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(
                div().absolute().size_full().child(
                    canvas(
                        move |bounds, _, _| bounds,
                        move |bounds, _, window, cx| {
                            entity.update(cx, |this, _| this.bounds = bounds);
                            let view = entity.clone();
                            window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                                if phase == DispatchPhase::Capture {
                                    view.update(cx, |this, cx| {
                                        if e.pressed_button == Some(MouseButton::Left) {
                                            this.move_pointer(e.position, cx);
                                        } else {
                                            this.drag = None;
                                        }
                                    });
                                }
                            });
                            let view = entity.clone();
                            window.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                                if phase == DispatchPhase::Capture && e.button == MouseButton::Left
                                {
                                    view.update(cx, |this, cx| {
                                        if this.drag.is_some() {
                                            this.move_pointer(e.position, cx);
                                            this.drag = None;
                                        }
                                    });
                                }
                            });
                            let view = entity.clone();
                            window.on_mouse_event(move |e: &ScrollWheelEvent, phase, _, cx| {
                                if phase == DispatchPhase::Capture
                                    && bounds.contains(&e.position)
                                    && (e.modifiers.control
                                        || e.modifiers.platform
                                        || matches!(e.delta, ScrollDelta::Magnification(_)))
                                {
                                    view.update(cx, |this, cx| {
                                        if this.drag.is_none() {
                                            let dy = match e.delta {
                                                ScrollDelta::Magnification(delta) => delta,
                                                _ => f32::from(e.delta.pixel_delta(px(20.)).y),
                                            };
                                            let pointer = this.local(e.position);
                                            this.layout.camera.zoom_at(
                                                this.layout.camera.zoom
                                                    * (dy * 0.01).clamp(-10., 10.).exp(),
                                                pointer,
                                            );
                                            this.changed(cx);
                                            cx.stop_propagation();
                                        }
                                    });
                                }
                            });
                        },
                    )
                    .size_full(),
                ),
            )
            .child(
                div()
                    .id("canvas-background")
                    .debug_selector(|| "canvas-background".into())
                    .absolute()
                    .size_full()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, e: &MouseDownEvent, window, cx| {
                            this.focus.focus(window);
                            this.drag = Some(Drag::Pan {
                                pointer: this.local(e.position),
                                camera: this.layout.camera,
                            });
                            cx.stop_propagation();
                        }),
                    )
                    .on_scroll_wheel(cx.listener(|this, e: &ScrollWheelEvent, _, cx| {
                        if this.drag.is_none() {
                            let d = e.delta.pixel_delta(px(20.));
                            this.layout.camera.pan[0] += f32::from(d.x);
                            this.layout.camera.pan[1] += f32::from(d.y);
                            this.changed(cx);
                            cx.stop_propagation();
                        }
                    })),
            )
            .when(self.layout.diff.is_empty(), |v| {
                v.child(
                    div()
                        .absolute()
                        .top(px(60.))
                        .left(px(32.))
                        .text_size(px(13.))
                        .text_color(theme().text_muted)
                        .child("Add a packet diff to begin."),
                )
            })
            .children(cards);
        div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .child(
                div()
                    .h(px(36.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .child(
                        control("canvas-add-diff", "Add packet diff").on_click(cx.listener(
                            |this, _, _, cx| {
                                this.choosing = !this.choosing;
                                if this.choosing {
                                    this.load(cx);
                                }
                                cx.notify();
                            },
                        )),
                    )
                    .child(
                        control(
                            "canvas-reset-zoom",
                            format!("{}% · Reset zoom", (self.layout.camera.zoom * 100.).round()),
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.reset(cx))),
                    )
                    .child(
                        control("canvas-fit-all", "Fit all cards")
                            .on_click(cx.listener(|this, _, _, cx| this.fit(cx))),
                    ),
            )
            .when(self.choosing, |v| {
                v.child(
                    div()
                        .id("canvas-packets")
                        .max_h(px(180.))
                        .overflow_y_scroll()
                        .children(self.choices.iter().map(|(id, title)| {
                            let (id, title) = (id.clone(), title.clone());
                            control(format!("canvas-packet-{id}"), title.clone()).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.add(id.clone(), title.clone(), cx)
                                }),
                            )
                        }))
                        .child(self.notice.clone()),
                )
            })
            .child(stage)
    }
}
