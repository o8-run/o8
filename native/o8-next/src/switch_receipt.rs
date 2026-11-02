//! What opening a thread costs: the bytes and milliseconds of its history read.
//! Kept in memory for Settings › Diagnostics. Background refreshes are not switches.
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

const KEPT: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Switch {
    pub thread: String,
    pub bytes: usize,
    pub ms: u64,
}

static RECENT: Mutex<VecDeque<Switch>> = Mutex::new(VecDeque::new());

pub(crate) fn record(thread: &str, bytes: usize, took: Duration) {
    let Ok(mut recent) = RECENT.lock() else {
        return;
    };
    if recent.len() == KEPT {
        recent.pop_back();
    }
    recent.push_front(Switch {
        thread: thread.to_owned(),
        bytes,
        ms: took.as_millis().try_into().unwrap_or(u64::MAX),
    });
}

/// Newest first.
pub(crate) fn recent() -> Vec<Switch> {
    RECENT
        .lock()
        .map(|recent| recent.iter().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024. * 1024.))
    }
}

/// The middle switch by size and by time, or nothing before the first switch.
pub(crate) fn typical(switches: &[Switch]) -> Option<String> {
    let middle = switches.len() / 2;
    let mut bytes: Vec<_> = switches.iter().map(|switch| switch.bytes).collect();
    let mut ms: Vec<_> = switches.iter().map(|switch| switch.ms).collect();
    bytes.sort_unstable();
    ms.sort_unstable();
    Some(format!("{} · {} ms", size(*bytes.get(middle)?), ms.get(middle)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_switch_records_its_thread_bytes_and_time_newest_first() {
        record("receipt-first", 2048, Duration::from_millis(12));
        record("receipt-second", 512, Duration::from_millis(7));
        let recent = recent();
        let position = |id: &str| recent.iter().position(|switch| switch.thread == id);
        assert!(position("receipt-second") < position("receipt-first"));
        let first = &recent[position("receipt-first").unwrap()];
        assert_eq!((first.bytes, first.ms), (2048, 12));
    }

    #[test]
    fn the_typical_switch_is_the_middle_of_each_measure() {
        let switch = |bytes, ms| Switch {
            thread: "t".into(),
            bytes,
            ms,
        };
        let switches = [switch(100, 30), switch(4096, 10), switch(2048, 20)];
        assert_eq!(typical(&switches).as_deref(), Some("2.0 KB · 20 ms"));
        assert_eq!(typical(&[]), None);
    }

    #[test]
    fn sizes_read_in_the_unit_that_fits() {
        assert_eq!(size(900), "900 B");
        assert_eq!(size(1536), "1.5 KB");
        assert_eq!(size(3 * 1024 * 1024), "3.0 MB");
    }
}
