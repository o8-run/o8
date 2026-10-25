//! Opt-in native terminal pane. Original GPUI rendering over the published
//! Apache-2.0 Alacritty grid; no Zed application crates or WebView changes.
use crate::theme::current as theme;
use crate::{
    client::Client,
    terminal_grid::{Grid, Size},
    terminal_transport::{self, Event, Link},
};
use alacritty_terminal::{
    grid::Scroll,
    term::{TermMode, cell::Flags},
    vte::ansi::CursorShape,
};
use gpui::{
    App, Application, Bounds, Context, ElementInputHandler, EntityInputHandler, FocusHandle,
    KeyDownEvent, Keystroke, MouseButton, Pixels, Point, Render, TextRun, UTF16Selection, Window,
    WindowBounds, WindowOptions, canvas, div, fill, font, point, prelude::*, px, rgb, size,
};
use std::{
    cell::Cell,
    ops::Range,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CELL_WIDTH: f32 = 8.;
const CELL_HEIGHT: f32 = 18.;
pub struct Pane {
    pub grid: Arc<Mutex<Grid>>,
    link: Link,
    focus: FocusHandle,
    pub ready: bool,
    pub notice: &'static str,
    pub painted: Rc<Cell<u64>>,
    pub painted_bytes: Rc<Cell<u64>>,
    pub painted_cells: Rc<Cell<usize>>,
    pub painted_cursor: Rc<Cell<bool>>,
    #[cfg(test)]
    painted_bounds: Rc<Cell<Bounds<Pixels>>>,
    pub paints: Rc<Cell<usize>>,
    composition: String,
}
impl Pane {
    pub fn new(
        client: Client,
        session: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let pane = Self::attached(client, session, cx);
        pane.focus.focus(window);
        pane
    }
    /// Grid attachment never takes focus from another slot.
    pub fn attached(client: Client, session: String, cx: &mut Context<Self>) -> Self {
        let dimensions = Size(80, 24);
        let grid = Arc::new(Mutex::new(Grid::new(dimensions)));
        let focus = cx.focus_handle();
        Self {
            grid: grid.clone(),
            link: terminal_transport::connect(client, session, dimensions, grid),
            focus,
            ready: false,
            notice: "Connecting terminal…",
            painted: Rc::new(Cell::new(0)),
            painted_bytes: Rc::new(Cell::new(0)),
            painted_cells: Rc::new(Cell::new(0)),
            painted_cursor: Rc::new(Cell::new(false)),
            #[cfg(test)]
            painted_bounds: Rc::new(Cell::new(Bounds::default())),
            paints: Rc::new(Cell::new(0)),
            composition: String::new(),
        }
    }
    pub fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }
    pub fn poll(&mut self, cx: &mut Context<Self>) {
        self.poll_visible(true, cx);
    }
    pub fn poll_visible(&mut self, visible: bool, cx: &mut Context<Self>) -> bool {
        let started = Instant::now();
        let mut changed = false;
        // Consume coalesced notifications; parsing stays on the socket thread.
        for _ in 0..8 {
            let Ok(event) = self.link.receiver.try_recv() else {
                break;
            };
            changed = true;
            match event {
                Event::Reconnecting => {
                    self.ready = false;
                    self.notice = "Reconnecting terminal…";
                }
                Event::Changed => {}
                Event::Ready => {
                    self.ready = true;
                    self.notice = "Terminal · connected";
                }
                Event::Exited => {
                    self.ready = false;
                    self.notice = "Terminal exited";
                }
                Event::Failed => {
                    self.ready = false;
                    self.notice = "Terminal attachment failed · reopen to retry";
                }
            }
            if started.elapsed() >= Duration::from_millis(2) {
                break;
            }
        }
        if changed && visible {
            cx.notify();
        }
        changed
    }
    fn input(&mut self, text: String, cx: &mut Context<Self>) {
        if !self.ready {
            return;
        }
        if !self.link.input(text) {
            self.notice = "Terminal input unavailable · retry after reconnect";
        } else {
            self.grid.lock().unwrap().bottom();
        }
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if !self.composition.is_empty() {
            return;
        }
        if key.modifiers.shift && matches!(key.key.as_str(), "pageup" | "pagedown" | "home" | "end")
        {
            let mut grid = self.grid.lock().unwrap();
            let rows = grid.size().1 as i32;
            grid.term.scroll_display(match key.key.as_str() {
                "home" => Scroll::Top,
                "end" => Scroll::Bottom,
                "pageup" => Scroll::Delta(rows),
                _ => Scroll::Delta(-rows),
            });
            grid.revision += 1;
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if (key.modifiers.platform || key.modifiers.control && key.modifiers.shift)
            && key.key == "v"
        {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                self.replace_text_in_range(None, &text, window, cx);
            }
            cx.stop_propagation();
            return;
        }
        let mode = *self.grid.lock().unwrap().term.mode();
        if let Some(text) = encode_key(key, mode) {
            self.input(text, cx);
            cx.stop_propagation();
        } else if key.modifiers.alt {
            if let Some(text) = &key.key_char {
                self.input(format!("\x1b{text}"), cx);
                cx.stop_propagation();
            }
        }
    }
}
fn encode_key(key: &Keystroke, mode: TermMode) -> Option<String> {
    let modifiers = key.modifiers;
    if modifiers.platform {
        return None;
    }
    let modifier =
        1 + modifiers.shift as u8 + 2 * modifiers.alt as u8 + 4 * modifiers.control as u8;
    let text = match key.key.as_str() {
        "enter" => "\r".into(),
        "backspace" => "\x7f".into(),
        "escape" => "\x1b".into(),
        "tab" if modifiers.shift => "\x1b[Z".into(),
        "tab" => "\t".into(),
        "up" | "down" | "right" | "left" | "home" | "end" => {
            let suffix = match key.key.as_str() {
                "up" => "A",
                "down" => "B",
                "right" => "C",
                "left" => "D",
                "home" => "H",
                _ => "F",
            };
            if modifier != 1 {
                format!("\x1b[1;{modifier}{suffix}")
            } else {
                format!(
                    "\x1b{}{suffix}",
                    if mode.contains(TermMode::APP_CURSOR) {
                        "O"
                    } else {
                        "["
                    }
                )
            }
        }
        "insert" | "delete" | "pageup" | "pagedown" => {
            let code = match key.key.as_str() {
                "insert" => 2,
                "delete" => 3,
                "pageup" => 5,
                _ => 6,
            };
            if modifier == 1 {
                format!("\x1b[{code}~")
            } else {
                format!("\x1b[{code};{modifier}~")
            }
        }
        "f1" | "f2" | "f3" | "f4" => {
            let suffix = ["P", "Q", "R", "S"][key.key[1..].parse::<usize>().ok()? - 1];
            if modifier == 1 {
                format!("\x1bO{suffix}")
            } else {
                format!("\x1b[1;{modifier}{suffix}")
            }
        }
        "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12" => {
            let code = [15, 17, 18, 19, 20, 21, 23, 24][key.key[1..].parse::<usize>().ok()? - 5];
            if modifier == 1 {
                format!("\x1b[{code}~")
            } else {
                format!("\x1b[{code};{modifier}~")
            }
        }
        _ if modifiers.control => {
            let c = match key.key.as_str() {
                "space" | "@" => 0,
                "[" => 27,
                "\\" => 28,
                "]" => 29,
                "^" => 30,
                "_" => 31,
                "?" => 127,
                s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic() => {
                    s.as_bytes()[0].to_ascii_uppercase() & 31
                }
                _ => return None,
            };
            (c as char).to_string()
        }
        // Text goes through GPUI's platform input handler, including IME.
        _ => return None,
    };
    Some(
        if modifiers.alt && modifier == 3 && !text.starts_with('\x1b') {
            format!("\x1b{text}")
        } else {
            text
        },
    )
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let measured = view.clone();
        let grid = self.grid.clone();
        let painted = self.painted.clone();
        let painted_bytes = self.painted_bytes.clone();
        let painted_cells = self.painted_cells.clone();
        let painted_cursor = self.painted_cursor.clone();
        #[cfg(test)]
        let painted_bounds = self.painted_bounds.clone();
        let paints = self.paints.clone();
        let focus = self.focus.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().code_background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .track_focus(&self.focus)
            .key_context("o8-editable")
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| this.focus.focus(window)),
            )
            .on_scroll_wheel(cx.listener(|this, event: &gpui::ScrollWheelEvent, _, cx| {
                let delta = event.delta.pixel_delta(px(CELL_HEIGHT)).y;
                this.grid
                    .lock()
                    .unwrap()
                    .scroll((f32::from(delta) / CELL_HEIGHT).round() as i32);
                cx.notify();
            }))
            .child(
                div()
                    .h(px(26.))
                    .px(px(8.))
                    .text_size(px(11.))
                    .child(self.notice),
            )
            .child(
                // Match WorkspaceTerminalPanels' 12px panel padding and
                // XtermPanel's additional 2px top/left content padding.
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .pt(px(14.))
                    .pl(px(14.))
                    .pr(px(12.))
                    .pb(px(12.))
                    .child(
                        canvas(
                            move |bounds, _, cx| {
                                measured.update(cx, |this, cx| {
                                    let columns = (f32::from(bounds.size.width) / CELL_WIDTH)
                                        .floor()
                                        as usize;
                                    let rows = (f32::from(bounds.size.height) / CELL_HEIGHT).floor()
                                        as usize;
                                    let dimensions =
                                        Size(columns.clamp(2, 500), rows.clamp(1, 300));
                                    if this.grid.lock().unwrap().resize(dimensions) {
                                        this.link.resize(dimensions);
                                        cx.notify();
                                    }
                                });
                            },
                            move |bounds, _, window, cx| {
                                #[cfg(test)]
                                painted_bounds.set(bounds);
                                window.handle_input(
                                    &focus,
                                    ElementInputHandler::new(bounds, view.clone()),
                                    cx,
                                );
                                let (cells, cursor, revision, bytes) = {
                                    let grid = grid.lock().unwrap();
                                    (grid.cells(), grid.cursor(), grid.revision, grid.bytes)
                                };
                                for cell in &cells {
                                    let origin = bounds.origin
                                        + point(
                                            px(cell.x as f32 * CELL_WIDTH),
                                            px(cell.y as f32 * CELL_HEIGHT),
                                        );
                                    if cell.background != u32::from(theme().code_background) >> 8 {
                                        window.paint_quad(fill(
                                            Bounds::new(
                                                origin,
                                                size(
                                                    px(cell.width as f32 * CELL_WIDTH),
                                                    px(CELL_HEIGHT),
                                                ),
                                            ),
                                            rgb(cell.background),
                                        ));
                                    }
                                    if cell.text == " " {
                                        continue;
                                    }
                                    let mut face = font(theme().font_mono);
                                    if cell.flags.contains(Flags::BOLD) {
                                        face.weight = gpui::FontWeight::BOLD;
                                    }
                                    if cell.flags.contains(Flags::ITALIC) {
                                        face.style = gpui::FontStyle::Italic;
                                    }
                                    let run = TextRun {
                                        len: cell.text.len(),
                                        font: face,
                                        color: rgb(cell.foreground).into(),
                                        background_color: None,
                                        underline: cell
                                            .flags
                                            .intersects(Flags::ALL_UNDERLINES)
                                            .then_some(gpui::UnderlineStyle {
                                                thickness: px(1.),
                                                color: None,
                                                wavy: false,
                                            }),
                                        strikethrough: cell
                                            .flags
                                            .contains(Flags::STRIKEOUT)
                                            .then_some(gpui::StrikethroughStyle {
                                                thickness: px(1.),
                                                color: None,
                                            }),
                                    };
                                    let line = window.text_system().shape_line(
                                        cell.text.clone().into(),
                                        px(13.),
                                        &[run],
                                        None,
                                    );
                                    line.paint(origin, px(CELL_HEIGHT), window, cx)
                                        .expect("terminal glyph paint");
                                }
                                if let Some((x, y, shape)) = cursor {
                                    let width = cells
                                        .iter()
                                        .find(|cell| cell.x == x && cell.y == y)
                                        .map(|cell| cell.width)
                                        .unwrap_or(1)
                                        as f32;
                                    let origin = bounds.origin
                                        + point(
                                            px(x as f32 * CELL_WIDTH),
                                            px(y as f32 * CELL_HEIGHT),
                                        );
                                    let (offset, dimensions) = match shape {
                                        CursorShape::Underline => (
                                            point(px(0.), px(CELL_HEIGHT - 2.)),
                                            size(px(CELL_WIDTH), px(2.)),
                                        ),
                                        CursorShape::Beam => {
                                            (point(px(0.), px(0.)), size(px(2.), px(CELL_HEIGHT)))
                                        }
                                        _ => (
                                            point(px(0.), px(0.)),
                                            size(px(CELL_WIDTH * width), px(CELL_HEIGHT)),
                                        ),
                                    };
                                    window.paint_quad(fill(
                                        Bounds::new(origin + offset, dimensions),
                                        theme().terminal_cursor,
                                    ));
                                }
                                painted_cells.set(cells.len());
                                painted_cursor.set(cursor.is_some());
                                painted.set(revision);
                                painted_bytes.set(bytes);
                                paints.set(paints.get() + 1);
                            },
                        )
                        .size_full()
                        .overflow_hidden(),
                    ),
            )
    }
}

// A terminal has no editable document. Keep only the active IME preedit locally;
// committed text is sent once, with bracketed paste for multiline input.
impl EntityInputHandler for Pane {
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        *adjusted = Some(0..self.composition.encode_utf16().count());
        Some(self.composition.clone())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.composition.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.composition.is_empty()).then_some(0..self.composition.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.composition.clear();
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition.clear();
        let multiline = text.contains(['\r', '\n']);
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let bracketed = multiline
            && self
                .grid
                .lock()
                .unwrap()
                .term
                .mode()
                .contains(TermMode::BRACKETED_PASTE);
        self.input(
            if bracketed {
                format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
            } else {
                text.replace('\n', "\r")
            },
            cx,
        );
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition = text.into();
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(bounds)
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }
}

pub fn launch(client: Client, session: String, offscreen: bool) {
    (if offscreen {
        Application::headless()
    } else {
        Application::new()
    })
    .run(move |cx: &mut App| {
        let handle = cx
            .open_window(
                WindowOptions {
                    focus: false,
                    show: !offscreen,
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(100.), px(100.)),
                        size(px(1000.), px(700.)),
                    ))),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("o8 next · terminal".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| Pane::new(client, session, window, cx)),
            )
            .expect("GPUI terminal window");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(4))
                    .await;
                if handle.update(cx, |pane, _, cx| pane.poll(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    });
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;
