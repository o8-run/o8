//! Older saved pages never hold up the worker's first page or a thread mention.
use crate::{client::Client, model::History};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, sync_channel},
};

pub(crate) struct Backfill {
    pub(crate) receiver: Receiver<Result<History, String>>,
    stop: Arc<AtomicBool>,
}
impl Drop for Backfill {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
impl Backfill {
    pub(crate) fn new(client: Client, history: &History) -> Option<Self> {
        if history.session_key.starts_with("llm-chat:") {
            return None;
        }
        let mut cursor = history
            .page
            .as_ref()
            .filter(|p| p.has_more)?
            .before_cursor
            .clone()?;
        let key = history.session_key.clone();
        let mut count = history.transcript.len();
        let (sender, receiver) = sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        std::thread::spawn(move || {
            let mut bytes = 0usize;
            while !stopped.load(Ordering::Acquire) {
                let page = client.saved_history_counted(&key, Some(&cursor));
                match page {
                    Ok((history, size)) => {
                        bytes = bytes.saturating_add(size);
                        count = count.saturating_add(history.transcript.len());
                        if bytes > 64 * 1024 * 1024 || count > 100_000 {
                            let _ = sender.send(Err(
                                "Older history readback limit reached · loaded history retained"
                                    .into(),
                            ));
                            break;
                        }
                        let next = history
                            .page
                            .as_ref()
                            .filter(|p| p.has_more)
                            .and_then(|p| p.before_cursor.clone());
                        if next.as_ref() == Some(&cursor) {
                            let _ = sender.send(Err(
                                "Older history cursor did not advance · loaded history retained"
                                    .into(),
                            ));
                            break;
                        }
                        if stopped.load(Ordering::Acquire) || sender.send(Ok(history)).is_err() {
                            break;
                        }
                        let Some(next) = next else { break };
                        cursor = next;
                    }
                    Err(error) => {
                        let _ = sender.send(Err(if error.ends_with("HTTP 409") {
                            "History changed · loaded history retained".into()
                        } else {
                            "Older history unavailable · loaded history retained".into()
                        }));
                        break;
                    }
                }
            }
        });
        Some(Self { receiver, stop })
    }
}
