//! Apache-2.0 Alacritty parser and bounded grid; no PTY, clipboard or app discovery.
use crate::theme::current as theme;
use alacritty_terminal::{
    Term,
    event::{Event, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    index::{Column, Line},
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
    /// Live feeds, not replays: what a command typed now can have printed.
    live: u64,
    /// Exit statuses the shell reported live (OSC 133;D), and the last one.
    exits: u64,
    last_exit: Option<i32>,
    /// The end of the last feed when it may begin an exit report.
    osc_tail: Vec<u8>,
}
/// Where a terminal stands for one command line: its live feeds, the echoes
/// of that line still in reach, and the exit reports seen so far.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mark {
    pub live: u64,
    pub echoes: usize,
    pub exits: u64,
    pub exit: Option<i32>,
}
/// The shell-integration report that a command finished, as in OSC 133;D;0.
const EXIT_REPORT: &[u8] = b"\x1b]133;D";
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
            live: 0,
            exits: 0,
            last_exit: None,
            osc_tail: vec![],
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
        // A replay repeats old reports; only live ones count.
        if historical {
            self.osc_tail.clear();
        } else {
            self.live += 1;
            self.read_exits(bytes);
        }
        self.bytes += bytes.len() as u64;
        self.revision += 1;
        self.replies.lock().unwrap().drain(..).collect()
    }
    pub fn reset(&mut self) {
        let (revision, live, exits) = (self.revision, self.live, self.exits);
        *self = Self::new(self.size());
        self.revision = revision + 1;
        self.live = live;
        self.exits = exits;
    }
    pub fn mark(&self, command: &str) -> Mark {
        Mark {
            live: self.live,
            echoes: self
                .lines(LOOKBACK)
                .iter()
                .filter(|line| line.ends_with(command))
                .count(),
            exits: self.exits,
            exit: self.last_exit,
        }
    }
    /// Counts the exit statuses a shell with integration reports, which the
    /// parser itself ignores. A report split across feeds is kept until whole.
    fn read_exits(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.osc_tail);
        data.extend_from_slice(bytes);
        let (mut at, mut consumed) = (0, 0);
        // Scan for ESC first: a flood of plain output stays one byte compare.
        while let Some(found) = data[at..].iter().position(|&b| b == 0x1b) {
            if !data[at + found..].starts_with(EXIT_REPORT) {
                at += found + 1;
                continue;
            }
            let start = at + found + EXIT_REPORT.len();
            let Some(end) = data[start..].iter().position(|&b| b == 0x07 || b == 0x1b) else {
                if data.len() - start < 32 {
                    self.osc_tail = data[at + found..].to_vec();
                }
                return;
            };
            self.exits += 1;
            self.last_exit = std::str::from_utf8(&data[start..start + end])
                .ok()
                .and_then(|params| params.strip_prefix(';'))
                .and_then(|params| params.split(';').next())
                .and_then(|code| code.parse().ok());
            at = start + end;
            consumed = at;
        }
        if let Some(n) = (1..EXIT_REPORT.len())
            .rev()
            .find(|&n| data[consumed..].ends_with(&EXIT_REPORT[..n]))
        {
            self.osc_tail = data[data.len() - n..].to_vec();
        }
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
    /// The output of the last run of a command typed at this shell, read from
    /// the rows after its echo up to the prompt that followed it.
    pub fn command_output(&self, command: &str) -> Option<CommandOutput> {
        output_after(&self.lines(LOOKBACK), command)
    }
    /// The newest `count` lines up to the cursor, blank lines at the end left out.
    pub fn tail(&self, count: usize) -> Vec<String> {
        let mut lines = self.lines(LOOKBACK);
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        lines.split_off(lines.len().saturating_sub(count))
    }
    /// The last `limit` rows up to the cursor, wrapped rows joined into the
    /// lines a program printed.
    fn lines(&self, limit: usize) -> Vec<String> {
        let grid = self.term.grid();
        let columns = grid.columns();
        let end = grid.cursor.point.line.0;
        let start = (end + 1 - limit as i32).max(grid.topmost_line().0);
        let mut lines = vec![];
        let mut current = String::new();
        for line in start..=end {
            let row = &grid[Line(line)];
            for column in 0..columns {
                let cell = &row[Column(column)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                if cell.flags.contains(Flags::HIDDEN) {
                    current.push(' ');
                    continue;
                }
                current.push(cell.c);
                if let Some(extra) = cell.zerowidth() {
                    current.extend(extra);
                }
            }
            if columns == 0 || !row[Column(columns - 1)].flags.contains(Flags::WRAPLINE) {
                lines.push(current.trim_end().to_owned());
                current.clear();
            }
        }
        if !current.is_empty() {
            lines.push(current.trim_end().to_owned());
        }
        lines
    }
    #[cfg(test)]
    pub fn text(&self) -> String {
        self.cells().into_iter().map(|c| c.text).collect()
    }
}
/// How far back a command's echo is looked for.
const LOOKBACK: usize = 3_000;
/// The lines after the last echo of `command` (a prompt, then the command),
/// stopping at the next line that starts with the same prompt.
fn output_after(lines: &[String], command: &str) -> Option<CommandOutput> {
    let echo = lines.iter().rposition(|line| line.ends_with(command))?;
    let prompt = lines[echo].strip_suffix(command)?.trim_end();
    let mut output = vec![];
    let mut finished = false;
    for line in &lines[echo + 1..] {
        if !prompt.is_empty()
            && (line == prompt
                || line
                    .strip_prefix(prompt)
                    .is_some_and(|r| r.starts_with(' ')))
        {
            finished = true;
            break;
        }
        output.push(line.clone());
    }
    while output.last().is_some_and(|line| line.trim().is_empty()) {
        output.pop();
    }
    Some(CommandOutput {
        lines: output,
        finished,
    })
}
/// What a command printed after its echo, and whether the shell's prompt
/// came back after it.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandOutput {
    pub lines: Vec<String>,
    pub finished: bool,
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
