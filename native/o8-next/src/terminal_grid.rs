//! Apache-2.0 Alacritty parser and bounded grid; no PTY, clipboard or app discovery.
use crate::theme::current as theme;
use alacritty_terminal::{
    Term,
    event::{Event, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    term::{Config, Osc52, cell::Flags},
    vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

pub const HISTORY: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size(pub usize, pub usize);
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.1
    }
    fn screen_lines(&self) -> usize {
        self.1
    }
    fn columns(&self) -> usize {
        self.0
    }
}

pub struct Events {
    historical: Arc<AtomicBool>,
    replies: Arc<Mutex<Vec<String>>>,
    size: Arc<Mutex<Size>>,
}
impl EventListener for Events {
    fn send_event(&self, event: Event) {
        if self.historical.load(Ordering::Relaxed) {
            return;
        }
        let response = match event {
            Event::PtyWrite(text) => text,
            Event::ColorRequest(index, format) => {
                let c = palette(index);
                format(Rgb {
                    r: (c >> 16) as u8,
                    g: (c >> 8) as u8,
                    b: c as u8,
                })
            }
            Event::TextAreaSizeRequest(format) => {
                let size = *self.size.lock().unwrap();
                format(WindowSize {
                    num_cols: size.0 as u16,
                    num_lines: size.1 as u16,
                    cell_width: 8,
                    cell_height: 18,
                })
            }
            // Terminal output never grants clipboard, URL or OS access.
            _ => return,
        };
        self.replies.lock().unwrap().push(response);
    }
}
pub struct Grid {
    pub term: Term<Events>,
    parser: Processor,
    historical: Arc<AtomicBool>,
    replies: Arc<Mutex<Vec<String>>>,
    size: Arc<Mutex<Size>>,
    pub revision: u64,
    pub bytes: u64,
}
impl Grid {
    pub fn new(size: Size) -> Self {
        let historical = Arc::new(AtomicBool::new(false));
        let replies = Arc::new(Mutex::new(vec![]));
        let size = Arc::new(Mutex::new(size));
        let term = Term::new(
            Config {
                scrolling_history: HISTORY,
                osc52: Osc52::Disabled,
                ..Config::default()
            },
            &size.lock().unwrap().clone(),
            Events {
                historical: historical.clone(),
                replies: replies.clone(),
                size: size.clone(),
            },
        );
        Self {
            term,
            parser: Processor::new(),
            historical,
            replies,
            size,
            revision: 0,
            bytes: 0,
        }
    }
    pub fn size(&self) -> Size {
        *self.size.lock().unwrap()
    }
    pub fn resize(&mut self, size: Size) -> bool {
        if *self.size.lock().unwrap() == size {
            return false;
        }
        self.term.resize(size);
        *self.size.lock().unwrap() = size;
        self.revision += 1;
        true
    }
    pub fn feed(&mut self, bytes: &[u8], historical: bool) -> Vec<String> {
        self.historical.store(historical, Ordering::Relaxed);
        self.parser.advance(&mut self.term, bytes);
        self.historical.store(false, Ordering::Relaxed);
        self.bytes += bytes.len() as u64;
        self.revision += 1;
        self.replies.lock().unwrap().drain(..).collect()
    }
    pub fn reset(&mut self) {
        let revision = self.revision;
        *self = Self::new(self.size());
        self.revision = revision + 1;
    }
    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
        self.revision += 1;
    }
    pub fn bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
        self.revision += 1;
    }
    pub fn cells(&self) -> Vec<PaintCell> {
        let content = self.term.renderable_content();
        content
            .display_iter
            .filter_map(|indexed| {
                let cell = indexed.cell;
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    return None;
                }
                let mut foreground = color(cell.fg, content.colors);
                let mut background = color(cell.bg, content.colors);
                if cell.flags.contains(Flags::INVERSE) {
                    std::mem::swap(&mut foreground, &mut background);
                }
                if cell.flags.contains(Flags::DIM) {
                    foreground = (foreground & 0xfefefe) >> 1;
                }
                let mut text = cell.c.to_string();
                if let Some(extra) = cell.zerowidth() {
                    text.extend(extra);
                }
                if cell.flags.contains(Flags::HIDDEN) {
                    text = " ".into();
                }
                Some(PaintCell {
                    x: indexed.point.column.0,
                    y: (indexed.point.line.0 + content.display_offset as i32) as usize,
                    width: if cell.flags.contains(Flags::WIDE_CHAR) {
                        2
                    } else {
                        1
                    },
                    text,
                    foreground,
                    background,
                    flags: cell.flags,
                })
            })
            .collect()
    }
    pub fn cursor(&self) -> Option<(usize, usize, CursorShape)> {
        let content = self.term.renderable_content();
        let row = content.cursor.point.line.0 + content.display_offset as i32;
        (row >= 0 && row < self.size().1 as i32 && content.cursor.shape != CursorShape::Hidden)
            .then_some((
                content.cursor.point.column.0,
                row as usize,
                content.cursor.shape,
            ))
    }
    #[cfg(test)]
    pub fn text(&self) -> String {
        self.cells().into_iter().map(|c| c.text).collect()
    }
}
#[derive(Clone, Debug)]
pub struct PaintCell {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub text: String,
    pub foreground: u32,
    pub background: u32,
    pub flags: Flags,
}
fn color(color: Color, colors: &alacritty_terminal::term::color::Colors) -> u32 {
    match color {
        Color::Spec(c) => ((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32,
        Color::Named(c) => colors[c]
            .map(|c| color_rgb(c))
            .unwrap_or_else(|| palette(c as usize)),
        Color::Indexed(i) => colors[i as usize]
            .map(|c| color_rgb(c))
            .unwrap_or_else(|| palette(i as usize)),
    }
}
fn color_rgb(c: Rgb) -> u32 {
    ((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32
}
pub fn palette(index: usize) -> u32 {
    match index {
        0..16 => theme().terminal_ansi[index],
        16..232 => {
            let n = index - 16;
            let level = |n: usize| if n == 0 { 0 } else { 55 + n as u32 * 40 };
            (level(n / 36) << 16) | (level((n / 6) % 6) << 8) | level(n % 6)
        }
        232..256 => (8 + (index as u32 - 232) * 10) * 0x010101,
        n if n == NamedColor::Background as usize => u32::from(theme().code_background) >> 8,
        _ => u32::from(theme().text) >> 8,
    }
}
