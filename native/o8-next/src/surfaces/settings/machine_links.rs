//! Keeps a tunnel open to each saved machine so one window can show them all.
//! Each machine has one background owner that connects, watches the tunnel and
//! reconnects with backoff. Being listed never claims a machine is reachable;
//! only a live tunnel gives it a client.
use super::machines::machine_window::{Link, Route};
use crate::client::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

const WATCH: Duration = Duration::from_secs(2);
const FIRST_RETRY: Duration = Duration::from_secs(5);
const LAST_RETRY: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) enum Reach {
    Connecting,
    Online(Client),
    Offline(String),
}

#[derive(Clone)]
pub(crate) struct Machine {
    pub id: String,
    pub label: String,
    pub reach: Reach,
}

#[derive(Clone, Default)]
pub(crate) struct Links {
    machines: Arc<Mutex<HashMap<String, Machine>>>,
    stops: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

/// A client whose every request fails.
pub(crate) fn dead_client() -> Client {
    Client::authenticated("http://127.0.0.1:1", None).expect("a fixed loopback origin is valid")
}

/// The wait before the next attempt, doubling up to a minute.
fn next_retry(wait: Duration) -> Duration {
    (wait * 2).min(LAST_RETRY)
}

impl Links {
    /// The machines right now, in a stable order for the sidebar.
    pub(crate) fn machines(&self) -> Vec<Machine> {
        let machines = self.machines.lock().unwrap_or_else(PoisonError::into_inner);
        let mut list: Vec<_> = machines.values().cloned().collect();
        list.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// The client for a machine, only while its tunnel is up.
    pub(crate) fn client(&self, id: &str) -> Option<Client> {
        let machines = self.machines.lock().unwrap_or_else(PoisonError::into_inner);
        match machines.get(id).map(|machine| &machine.reach) {
            Some(Reach::Online(client)) => Some(client.clone()),
            _ => None,
        }
    }

    /// A client that speaks for this machine, and only for it: while it's
    /// offline every request fails, so nothing falls back to this computer.
    pub(crate) fn client_or_offline(&self, id: &str) -> Client {
        self.client(id).unwrap_or_else(dead_client)
    }

    /// Follows the saved list: new machines start, removed ones close.
    pub(crate) fn sync(&self, routes: Vec<(Route, String)>) {
        let mut stops = self.stops.lock().unwrap_or_else(PoisonError::into_inner);
        stops.retain(|id, stop| {
            let kept = routes.iter().any(|(route, _)| route.id == *id);
            if !kept {
                stop.store(true, Ordering::Relaxed);
                self.machines
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(id);
            }
            kept
        });
        for (route, label) in routes {
            if stops.contains_key(&route.id) {
                continue;
            }
            let stop = Arc::new(AtomicBool::new(false));
            stops.insert(route.id.clone(), stop.clone());
            let links = self.clone();
            std::thread::spawn(move || links.keep(route, label, stop));
        }
    }

    /// Marks a machine online with the given client, without a tunnel.
    #[cfg(test)]
    pub(crate) fn online(&self, id: &str, label: &str, client: Client) {
        self.machines
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                id.to_owned(),
                Machine {
                    id: id.to_owned(),
                    label: label.to_owned(),
                    reach: Reach::Online(client),
                },
            );
    }

    fn set(&self, route: &Route, label: &str, reach: Reach) {
        self.machines
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                route.id.clone(),
                Machine {
                    id: route.id.clone(),
                    label: label.to_owned(),
                    reach,
                },
            );
    }

    fn keep(&self, route: Route, label: String, stop: Arc<AtomicBool>) {
        let mut wait = FIRST_RETRY;
        self.set(&route, &label, Reach::Connecting);
        while !stop.load(Ordering::Relaxed) {
            match route.connect().and_then(|link| Ok((link.client()?, link))) {
                Ok((client, link)) => {
                    wait = FIRST_RETRY;
                    self.set(&route, &label, Reach::Online(client));
                    watch(link, &stop);
                    self.set(&route, &label, Reach::Offline("Connection lost.".into()));
                }
                Err(error) => self.set(&route, &label, Reach::Offline(error)),
            }
            pause(wait, &stop);
            wait = next_retry(wait);
        }
    }
}

/// Returns when the tunnel dies or the machine is removed; dropping the link
/// closes the tunnel.
fn watch(mut link: Link, stop: &AtomicBool) {
    while link.alive() && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(WATCH);
    }
}

fn pause(wait: Duration, stop: &AtomicBool) {
    let mut left = wait;
    while !left.is_zero() && !stop.load(Ordering::Relaxed) {
        let step = left.min(Duration::from_millis(250));
        std::thread::sleep(step);
        left -= step;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_slow_down_and_stop_at_a_minute() {
        assert_eq!(next_retry(FIRST_RETRY), Duration::from_secs(10));
        assert_eq!(next_retry(Duration::from_secs(45)), LAST_RETRY);
        assert_eq!(next_retry(LAST_RETRY), LAST_RETRY);
    }

    #[test]
    fn a_listed_machine_has_no_client_until_its_tunnel_is_up() {
        let links = Links::default();
        let route = Route {
            id: "box".into(),
            target: "box".into(),
            port: 22,
            ssh_config: None,
        };
        links.set(&route, "Box", Reach::Connecting);
        assert!(links.client("box").is_none());
        links.set(&route, "Box", Reach::Offline("gone".into()));
        assert!(links.client("box").is_none());
        assert_eq!(links.machines()[0].label, "Box");
    }
}
