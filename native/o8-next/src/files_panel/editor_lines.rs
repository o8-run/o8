//! Line starts and their UTF-16 offsets, kept current by each edit, so large
//! files never rescan the whole buffer to find a line or an IME offset.
use std::ops::Range;

/// Files at or below this many lines measure every line's width exactly.
pub(in crate::files_panel) const EXACT_WIDTH_LINES: usize = 2_000;
/// Larger files estimate their width from this many of their longest lines.
const WIDEST_SAMPLE: usize = 64;

pub(in crate::files_panel) fn units(text: &str) -> usize {
    if text.is_ascii() {
        text.len()
    } else {
        text.encode_utf16().count()
    }
}

pub(in crate::files_panel) struct Lines {
    starts: Vec<usize>,
    utf16: Vec<usize>,
}
impl Lines {
    pub(in crate::files_panel) fn new(text: &str) -> Self {
        let (mut starts, mut utf16) = (vec![0], vec![0]);
        Self::scan(text, 0, 0, &mut starts, &mut utf16);
        Self { starts, utf16 }
    }
    /// Line starts after each newline of `text`, placed at byte `at` and UTF-16 `at16`.
    fn scan(text: &str, at: usize, at16: usize, starts: &mut Vec<usize>, utf16: &mut Vec<usize>) {
        let (mut previous, mut previous16) = (0, at16);
        for (i, _) in text.match_indices('\n') {
            previous16 += units(&text[previous..=i]);
            previous = i + 1;
            starts.push(at + previous);
            utf16.push(previous16);
        }
    }
    pub(in crate::files_panel) fn len(&self) -> usize {
        self.starts.len()
    }
    pub(in crate::files_panel) fn line_of(&self, byte: usize) -> usize {
        self.starts.partition_point(|start| *start <= byte) - 1
    }
    /// The line's bytes, without its newline.
    pub(in crate::files_panel) fn range(&self, line: usize, text_len: usize) -> Range<usize> {
        self.starts[line]
            ..self
                .starts
                .get(line + 1)
                .map(|next| next - 1)
                .unwrap_or(text_len)
    }
    pub(in crate::files_panel) fn to_utf16(&self, text: &str, byte: usize) -> usize {
        let line = self.line_of(byte);
        self.utf16[line] + units(&text[self.starts[line]..byte])
    }
    pub(in crate::files_panel) fn to_byte(&self, text: &str, utf16: usize) -> usize {
        let line = self.utf16.partition_point(|units| *units <= utf16) - 1;
        let start = self.starts[line];
        let mut units = self.utf16[line];
        for (index, ch) in text[start..].char_indices() {
            if units >= utf16 {
                return start + index;
            }
            units += ch.len_utf16();
        }
        text.len()
    }
    /// Applies `range` (old bytes, `removed16` UTF-16 units) replaced by `new`;
    /// `text` is the document after the edit.
    pub(in crate::files_panel) fn edit(
        &mut self,
        text: &str,
        range: Range<usize>,
        new: &str,
        removed16: usize,
    ) {
        let first = self.starts.partition_point(|start| *start <= range.start);
        let last = self.starts.partition_point(|start| *start <= range.end);
        let line = first - 1;
        let at16 = self.utf16[line] + units(&text[self.starts[line]..range.start]);
        let delta = new.len() as isize - range.len() as isize;
        let delta16 = units(new) as isize - removed16 as isize;
        for start in &mut self.starts[last..] {
            *start = start.checked_add_signed(delta).expect("line start");
        }
        for units in &mut self.utf16[last..] {
            *units = units.checked_add_signed(delta16).expect("line utf16");
        }
        let (mut starts, mut utf16) = (vec![], vec![]);
        Self::scan(new, range.start, at16, &mut starts, &mut utf16);
        self.starts.splice(first..last, starts);
        self.utf16.splice(first..last, utf16);
    }
    /// Lines whose width bounds the document: all of them for ordinary files,
    /// otherwise the longest by bytes (wide characters also take more bytes).
    pub(in crate::files_panel) fn widest(&self, text_len: usize) -> Vec<usize> {
        widest((0..self.len()).map(|line| self.range(line, text_len).len()))
    }
}

/// Indexes of the lines that decide a document's width, given each line's byte length.
pub(in crate::files_panel) fn widest(lengths: impl ExactSizeIterator<Item = usize>) -> Vec<usize> {
    if lengths.len() <= EXACT_WIDTH_LINES {
        return (0..lengths.len()).collect();
    }
    let mut heap = std::collections::BinaryHeap::with_capacity(WIDEST_SAMPLE + 1);
    for (line, length) in lengths.enumerate() {
        heap.push(std::cmp::Reverse((length, line)));
        if heap.len() > WIDEST_SAMPLE {
            heap.pop();
        }
    }
    heap.into_iter()
        .map(|std::cmp::Reverse((_, line))| line)
        .collect()
}
