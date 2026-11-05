//! Debounced, single-flight picture lifecycle for a retained Linux card.
use super::{
    linux::{self, Job, Request},
    *,
};
use std::{sync::Arc, time::Duration};

#[derive(Clone, PartialEq)]
struct Key {
    width: u32,
    theme: Value,
}
impl Key {
    fn matches(&self, other: &Self) -> bool {
        self.width.abs_diff(other.width) <= 4 && self.theme == other.theme
    }
}
#[derive(Default)]
pub(super) struct Snapshot {
    pub picture: Option<Arc<gpui::Image>>,
    wanted: Option<(Key, Instant)>,
    rendered: Option<Key>,
    active: Option<(Key, Job)>,
}
impl Card {
    pub(super) fn prepare_picture(&mut self, width: f32, theme: Value, now: Instant) {
        if !width.is_finite() || width <= 0. {
            return;
        }
        let key = Key {
            width: (width.round() as u32).clamp(1, linux::MAX_WIDTH),
            theme,
        };
        if self
            .snapshot
            .wanted
            .as_ref()
            .is_none_or(|(wanted, _)| !wanted.matches(&key))
        {
            self.snapshot.wanted = Some((key, now));
        }
        self.start_picture(now);
    }
    fn start_picture(&mut self, now: Instant) {
        if self.error.is_some() || self.snapshot.active.is_some() || self.leases == 0 {
            return;
        }
        let Some(source) = &self.source else {
            return;
        };
        let Some((key, since)) = &self.snapshot.wanted else {
            return;
        };
        if self
            .snapshot
            .rendered
            .as_ref()
            .is_some_and(|rendered| rendered.matches(key))
            || now.duration_since(*since) < Duration::from_millis(180)
        {
            return;
        }
        let request = Request {
            document: source.clone(),
            nonce: self.nonce.clone(),
            width: key.width,
            height: self.height,
            theme: key.theme.clone(),
            state: self.state.clone(),
        };
        let client = self.client.clone();
        self.snapshot.active = Some((key.clone(), Job::start(request, move || client.wake())));
        self.started = Some(now);
    }
    pub(super) fn poll_picture(&mut self) -> bool {
        let mut changed = false;
        if let Some(result) = self
            .snapshot
            .active
            .as_ref()
            .and_then(|(_, job)| job.result.try_recv().ok())
        {
            let (key, _) = self.snapshot.active.take().unwrap();
            self.started = None;
            // A resize or theme change during a render schedules one successor.
            // Do not flash an obsolete picture or persist its obsolete state.
            let current = self
                .snapshot
                .wanted
                .as_ref()
                .is_some_and(|(wanted, _)| wanted.matches(&key));
            if current {
                let result = result
                    .and_then(|response| response.picture(key.width).map(|png| (response, png)));
                match result {
                    Ok((response, png)) => {
                        self.height = response.height;
                        self.snapshot.picture = Some(Arc::new(gpui::Image::from_bytes(
                            gpui::ImageFormat::Png,
                            png,
                        )));
                        self.snapshot.rendered = Some(key);
                        self.ready = true;
                        if let Some(state) = response.state.filter(|state| *state != self.state) {
                            self.state = state;
                            if let Some(file) = &self.state_file {
                                save_state(file, &self.state);
                            }
                        }
                    }
                    Err(error) => {
                        self.error = Some(error);
                        self.ready = false;
                    }
                }
                changed = true;
            }
        }
        self.start_picture(Instant::now());
        changed
    }
}
