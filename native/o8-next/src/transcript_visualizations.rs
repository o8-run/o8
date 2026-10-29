//! Pane-local saved-reference polling. HTTP runs off the UI thread.
use super::*;
use crate::visualizations::{
    protocol::Reference,
    transcript::{self, Anchors},
};
use std::{sync::mpsc, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Scope {
    Thread { repo: String, thread: String },
    Packet(String),
}
impl Scope {
    pub(super) fn new(repo: Option<&str>, thread: &str, packet: Option<&str>) -> Option<Self> {
        if let Some(packet) = packet.filter(|p| !p.is_empty()) {
            Some(Self::Packet(packet.into()))
        } else if thread.starts_with("thoughts-") {
            Some(Self::Thread {
                repo: repo.filter(|p| !p.is_empty())?.into(),
                thread: thread.into(),
            })
        } else {
            None
        }
    }
    fn load(&self, client: &Client) -> Result<Vec<Reference>, String> {
        let query = match self {
            Self::Thread { repo, thread } => {
                vec![("repoPath", repo.as_str()), ("threadId", thread.as_str())]
            }
            Self::Packet(packet) => vec![("packetId", packet.as_str())],
        };
        let body: Value = client.get("/api/visualizations", &query)?;
        let values = body["result"]["visualizations"]
            .as_array()
            .ok_or("Invalid visualization list")?;
        Ok(values.iter().filter_map(Reference::parse).collect())
    }
}

type Response = (Scope, Result<Vec<Reference>, String>);
#[derive(Default)]
pub(super) struct Saved {
    scope: Option<Scope>,
    refs: Vec<Reference>,
    anchors: Anchors,
    last: Option<Instant>,
    loading: Option<mpsc::Receiver<Response>>,
    pub(super) visible: Rc<Cell<usize>>,
}
impl Saved {
    pub(super) fn select(&mut self, scope: Option<Scope>) {
        if self.scope != scope {
            self.scope = scope;
            self.refs.clear();
            self.anchors.clear();
            // Keep the in-flight request and deadline: switching tabs cannot
            // overlap requests or increase the poll rate. Its scope fences results.
        }
    }
    pub(super) fn attach(&mut self, rows: &mut [Row], messages: &[crate::model::Entry]) {
        let (buckets, anchors) = transcript::place(&self.refs, messages, &self.anchors);
        self.anchors = anchors;
        transcript::attach(rows, &buckets);
    }
    fn poll(&mut self, client: &Client, now: Instant) -> bool {
        if self.visible.get() == 0 {
            return false;
        }
        let mut changed = false;
        if let Some((scope, result)) = self.loading.as_ref().and_then(|r| r.try_recv().ok()) {
            self.loading = None;
            if self.scope.as_ref() == Some(&scope)
                && let Ok(refs) = result
                && self.refs != refs
            {
                self.refs = refs;
                changed = true;
            }
        }
        if self.loading.is_none()
            && self
                .last
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(5))
            && let Some(scope) = self.scope.clone()
        {
            self.last = Some(now);
            let client = client.clone();
            let (send, receive) = mpsc::channel();
            self.loading = Some(receive);
            std::thread::spawn(move || {
                let result = scope.load(&client);
                let _ = send.send((scope, result));
                client.wake();
            });
        }
        changed
    }
}
impl Surface {
    pub(super) fn poll_saved_visualizations(&mut self, cx: &mut Context<Self>) {
        if self.saved_visualizations.poll(&self.client, Instant::now())
            && let Some(transcript) = &self.transcript
        {
            self.install_rows(transcript.rows.clone(), cx);
            cx.notify();
        }
    }
}

// Like the card lease, this marker survives cached scenes and drops when the
// pane leaves the rendered tree. Hidden retained tabs still receive shell ticks.
pub(super) struct Visible(pub Rc<Cell<usize>>);
struct Lease(Rc<Cell<usize>>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}
impl gpui::IntoElement for Visible {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl gpui::Element for Visible {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<gpui::ElementId> {
        Some("saved-visualizations-visible".into())
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&gpui::GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (gpui::LayoutId, ()) {
        (window.request_layout(gpui::Style::default(), [], cx), ())
    }
    fn prepaint(
        &mut self,
        id: Option<&gpui::GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<gpui::Pixels>,
        _: &mut (),
        window: &mut Window,
        _: &mut App,
    ) {
        window.with_element_state::<Lease, _>(id.unwrap(), |lease, _| {
            let lease = lease.unwrap_or_else(|| {
                self.0.set(self.0.get() + 1);
                Lease(self.0.clone())
            });
            ((), lease)
        });
    }
    fn paint(
        &mut self,
        _: Option<&gpui::GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<gpui::Pixels>,
        _: &mut (),
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    fn server(body: Value) -> (Client, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let n = stream.read(&mut request).unwrap();
            let body = body.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            send.send(String::from_utf8_lossy(&request[..n]).into_owned())
                .unwrap();
        });
        (client, receive)
    }
    fn valid() -> Value {
        json!({"kind":"o8-visualization", "id":"vis-00000000-0000-0000-0000-000000000001", "title":"Chart", "createdAt":"2026-10-01T00:00:00.000Z", "height":320})
    }
    #[test]
    fn saved_list_scopes_and_validates_every_reference_through_client() {
        let scope = Scope::new(Some("/repo with spaces"), "thoughts-test", None).unwrap();
        let mut invalid = valid();
        invalid["height"] = json!(9000);
        let (client, request) = server(
            json!({"result":{"visualizations":[valid(), invalid, {"kind":"o8-visualization"}]}}),
        );
        assert_eq!(scope.load(&client).unwrap().len(), 1);
        let request = request.recv().unwrap();
        assert!(request.starts_with(
            "GET /api/visualizations?repoPath=%2Frepo+with+spaces&threadId=thoughts-test "
        ));
        assert!(Scope::new(Some("/repo"), "runtime:worker", None).is_none());
        assert!(Scope::new(None, "thoughts-test", None).is_none());
        let (client, request) = server(json!({"result":{"visualizations":[]}}));
        assert!(
            Scope::new(None, "runtime:worker", Some("packet-one"))
                .unwrap()
                .load(&client)
                .unwrap()
                .is_empty()
        );
        assert!(
            request
                .recv()
                .unwrap()
                .starts_with("GET /api/visualizations?packetId=packet-one ")
        );
    }
    #[test]
    fn saved_poll_is_background_visible_only_throttled_and_scope_fenced() {
        let (client, request) = server(json!({"result":{"visualizations":[valid()]}}));
        let mut saved = Saved::default();
        let scope = Scope::new(Some("/repo"), "thoughts-test", None);
        saved.select(scope.clone());
        let now = Instant::now();
        assert!(!saved.poll(&client, now));
        assert!(
            saved.loading.is_none(),
            "hidden panes must not start requests"
        );
        saved.visible.set(1);
        assert!(!saved.poll(&client, now));
        assert!(saved.loading.is_some());
        request.recv_timeout(Duration::from_secs(3)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while saved.loading.is_some() && Instant::now() < deadline {
            saved.poll(&client, now + Duration::from_secs(1));
            std::thread::yield_now();
        }
        assert_eq!(saved.refs.len(), 1);
        assert!(saved.loading.is_none());
        saved.poll(&client, now + Duration::from_millis(4999));
        assert!(saved.loading.is_none(), "no poll before five seconds");
        let previous = saved.refs.clone();
        let (send, receive) = mpsc::channel();
        send.send((scope.unwrap(), Err("missed poll".into())))
            .unwrap();
        saved.loading = Some(receive);
        saved.poll(&client, now + Duration::from_secs(2));
        assert_eq!(saved.refs, previous, "a missed poll retains saved cards");
        let (send, receive) = mpsc::channel();
        saved.loading = Some(receive);
        saved.select(Scope::new(Some("/other"), "thoughts-other", None));
        send.send((
            Scope::new(Some("/repo"), "thoughts-test", None).unwrap(),
            Ok(previous),
        ))
        .unwrap();
        saved.poll(&client, now + Duration::from_secs(3));
        assert!(
            saved.refs.is_empty(),
            "old scope cannot populate the new chat"
        );
        saved.visible.set(0);
        saved.poll(&client, now + Duration::from_secs(10));
        assert!(saved.loading.is_none());
        let (client, request) = server(json!({"result":{"visualizations":[]}}));
        saved.visible.set(1);
        saved.poll(&client, now + Duration::from_secs(5));
        assert!(
            saved.loading.is_some(),
            "visible panes may poll at five seconds"
        );
        assert!(
            request
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .contains("threadId=thoughts-other")
        );
    }

    struct VisibilityView {
        visible: bool,
        leases: Rc<Cell<usize>>,
    }
    impl Render for VisibilityView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .when(self.visible, |d| d.child(Visible(self.leases.clone())))
        }
    }
    #[gpui::test]
    fn pane_visibility_lease_drops_when_pane_is_hidden(cx: &mut gpui::TestAppContext) {
        let leases = Rc::new(Cell::new(0));
        let (view, cx) = cx.add_window_view(|_, _| VisibilityView {
            visible: true,
            leases: leases.clone(),
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert_eq!(leases.get(), 1);
        view.update(cx, |view, cx| {
            view.visible = false;
            cx.notify();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert_eq!(leases.get(), 0);
        view.update(cx, |view, cx| {
            view.visible = true;
            cx.notify();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert_eq!(leases.get(), 1);
    }
}
