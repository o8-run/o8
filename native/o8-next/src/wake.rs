//! Coalesced event wakeups and one retained maintenance timer per app window.
use async_channel::Receiver;
use gpui::Task;
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    task::Poll,
};

/// The shell's wake channel, so work arriving outside the server stream
/// (stdin frames, opened files) runs the shell's hooks now rather than at the
/// next maintenance tick.
static SHELL: std::sync::OnceLock<async_channel::Sender<()>> = std::sync::OnceLock::new();
pub(crate) fn install(sender: async_channel::Sender<()>) {
    let _ = SHELL.set(sender);
}
pub(crate) fn poke() {
    if let Some(sender) = SHELL.get() {
        let _ = sender.try_send(());
    }
}
/// The maintenance tick. With no thread running and no input in the last
/// minute, nothing it checks changes faster than every 2 s.
pub(crate) fn maintenance() -> std::time::Duration {
    std::time::Duration::from_secs(if crate::changes::lively() { 1 } else { 2 })
}

pub(crate) async fn next(receiver: &Receiver<()>, timer: &mut Task<()>) -> bool {
    let received = receiver.recv();
    let mut received = std::pin::pin!(received);
    poll_fn(|cx| {
        // Maintenance cannot starve behind an uninterrupted stream.
        if Pin::new(&mut *timer).poll(cx).is_ready() {
            return Poll::Ready(true);
        }
        if received.as_mut().poll(cx).is_ready() {
            return Poll::Ready(false);
        }
        Poll::Pending
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[gpui::test]
    fn data_wakes_immediately_without_restarting_maintenance(cx: &mut TestAppContext) {
        let (sender, receiver) = async_channel::bounded(1);
        let results = Arc::new(Mutex::new(Vec::new()));
        let received = results.clone();
        let executor = cx.executor();
        let timer_executor = executor.clone();
        executor
            .spawn(async move {
                let mut timer = timer_executor.timer(Duration::from_secs(1));
                for _ in 0..2 {
                    let maintenance = next(&receiver, &mut timer).await;
                    received.lock().unwrap().push(maintenance);
                }
            })
            .detach();
        cx.run_until_parked();
        assert!(results.lock().unwrap().is_empty());
        cx.executor().advance_clock(Duration::from_millis(900));
        sender.try_send(()).unwrap();
        cx.run_until_parked();
        assert_eq!(*results.lock().unwrap(), [false]);
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
        assert_eq!(*results.lock().unwrap(), [false, true]);
    }

    #[gpui::test]
    fn due_maintenance_wins_over_a_continuous_data_stream(cx: &mut TestAppContext) {
        let (sender, receiver) = async_channel::bounded(1);
        sender.try_send(()).unwrap();
        let executor = cx.executor();
        let task = executor.spawn(async move {
            assert!(next(&receiver, &mut Task::ready(())).await);
            assert_eq!(receiver.len(), 1, "maintenance leaves the data wake queued");
        });
        cx.run_until_parked();
        drop(task);
    }
}
