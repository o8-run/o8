use std::collections::VecDeque;
#[derive(Clone, Copy)]
pub struct RestartPolicy {
    pub max_restarts: usize,
    pub window: std::time::Duration,
    pub delay: std::time::Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartDecision {
    Restart {
        attempt: usize,
        delay: std::time::Duration,
    },
    Exhausted {
        attempts: usize,
    },
}

pub struct RestartTracker {
    policy: RestartPolicy,
    restarts: VecDeque<std::time::Instant>,
}

impl RestartTracker {
    pub fn new(policy: RestartPolicy) -> Self {
        Self {
            policy,
            restarts: VecDeque::new(),
        }
    }

    pub fn record_failure(&mut self, now: std::time::Instant) -> RestartDecision {
        while self
            .restarts
            .front()
            .is_some_and(|started| now.saturating_duration_since(*started) >= self.policy.window)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= self.policy.max_restarts {
            return RestartDecision::Exhausted {
                attempts: self.restarts.len(),
            };
        }
        self.restarts.push_back(now);
        RestartDecision::Restart {
            attempt: self.restarts.len(),
            delay: self.policy.delay,
        }
    }
}

pub const NEXT_RESTART_POLICY: RestartPolicy = RestartPolicy {
    max_restarts: 3,
    window: std::time::Duration::from_secs(5 * 60),
    delay: std::time::Duration::from_millis(750),
};
