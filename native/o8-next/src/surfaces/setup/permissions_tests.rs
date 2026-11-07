//! #5303 PR 2b: the optional voice step (OnboardingPermissionsStep), read and
//! asked for through an injected client, so no test reaches macOS.
use super::*;
use setup::view::permissions::{Client, Perm, Snapshot, Status, fix_label};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Fake {
    snapshot: Mutex<Option<Snapshot>>,
    reads: Mutex<usize>,
    requests: Mutex<Vec<(Perm, Status)>>,
}
impl Client for Fake {
    fn supported(&self) -> bool {
        true
    }
    fn read(&self) -> Snapshot {
        *self.reads.lock().unwrap() += 1;
        self.snapshot.lock().unwrap().unwrap()
    }
    fn request(&self, perm: Perm, status: Status) -> Result<(), String> {
        self.requests.lock().unwrap().push((perm, status));
        Ok(())
    }
}

fn setup_view(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<setup::view::Setup> {
    shell.read_with(cx, |s, _| s.surfaces.setup.view.clone().expect("setup open"))
}
fn tick(cx: &mut VisualTestContext) {
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(1_500));
    cx.run_until_parked();
    draw(cx);
}

#[test]
fn fix_labels_follow_the_desktop() {
    assert_eq!(fix_label(Perm::Microphone, Status::NotAsked), "Allow…");
    assert_eq!(fix_label(Perm::Microphone, Status::Denied), "Open Settings");
    assert_eq!(fix_label(Perm::InputMonitoring, Status::Denied), "Open Settings");
    assert_eq!(fix_label(Perm::Accessibility, Status::NotAsked), "Open Settings");
    assert_eq!(fix_label(Perm::ScreenRecording, Status::Unknown), "Open Settings");
}

#[gpui::test]
fn onboarding_permissions_read_poll_and_ask_through_the_client(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-tools --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("permissions.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let fake = Arc::new(Fake::default());
    *fake.snapshot.lock().unwrap() = Some([
        Status::NotAsked,
        Status::Denied,
        Status::Denied,
        Status::Denied,
    ]);
    let setup = setup_view(&shell, cx);
    setup.update(cx, |s, _| s.set_permission_client(fake.clone()));
    click(cx, "setup-permissions-open");
    assert!(cx.debug_bounds("setup-permissions").is_some());
    assert!(
        cx.debug_bounds("setup-back").is_none(),
        "the voice step has its own way back"
    );
    assert_eq!(
        shell
            .read_with(cx, |s, _| s.state.onboarding.clone())
            .unwrap()
            .step,
        "permissions"
    );
    // The first read answers at once; the microphone asks macOS first.
    assert!(cx.debug_bounds("setup-permission-microphone").is_some());
    click(cx, "setup-permission-microphone-fix");
    assert_eq!(
        *fake.requests.lock().unwrap(),
        [(Perm::Microphone, Status::NotAsked)]
    );
    // Granted elsewhere, it shows Ready on the next 1.5 s read.
    fake.snapshot.lock().unwrap().as_mut().unwrap()[0] = Status::Granted;
    tick(cx);
    assert!(cx.debug_bounds("setup-permission-microphone-ready").is_some());
    assert!(cx.debug_bounds("setup-permission-microphone-fix").is_none());
    // Desktop controls start collapsed.
    assert!(cx.debug_bounds("setup-permission-accessibility").is_none());
    click(cx, "setup-desktop-controls");
    for id in ["accessibility", "input-monitoring", "screen-recording"] {
        let row: &'static str = Box::leak(format!("setup-permission-{id}").into_boxed_str());
        assert!(cx.debug_bounds(row).is_some(), "{row}");
    }
    click(cx, "setup-permission-screen-recording-fix");
    assert_eq!(
        fake.requests.lock().unwrap().last(),
        Some(&(Perm::ScreenRecording, Status::Denied))
    );
    // Back to projects ends the checks.
    click(cx, "setup-permissions-done");
    assert!(cx.debug_bounds("setup-projects").is_some());
    let reads = *fake.reads.lock().unwrap();
    tick(cx);
    tick(cx);
    assert!(
        *fake.reads.lock().unwrap() <= reads + 1,
        "no reads after the step closes"
    );
}

#[gpui::test]
fn onboarding_permissions_without_macos_say_so(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-tools --transcript");
    let (_shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("permissions-off.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-permissions-open");
    assert!(cx.debug_bounds("setup-permissions-unsupported").is_some());
    assert!(cx.debug_bounds("setup-permission-microphone").is_none());
    click(cx, "setup-permissions-done");
    assert!(cx.debug_bounds("setup-projects").is_some());
}
