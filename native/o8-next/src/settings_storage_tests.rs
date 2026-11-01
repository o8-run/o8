use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_parity_storage_refresh_keeps_unknown_accounting(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply("GET", "/api/worktrees/retention-usage", 200, json!({"accountingStatus":"observed","totalAllocatedBytes":1024,"totalLogicalBytes":2048,"storageAdmission":{"physicalAvailableBytes":1000,"reservedBytes":300,"dispatchHeadroomBytes":700},"storagePressure":{"parkedWorkspaces":2,"eligibleRepositories":3,"optedOutRepositories":1,"repositories":[]},"categoryStorage":{"measuredAt":"2026-10-31T12:00:00Z","categories":{"source":{"allocatedBytes":1024,"logicalBytes":2048,"measurementMethod":"workspace-residual"},"transcript":{"allocatedBytes":null,"logicalBytes":null,"measurementMethod":"owned-session-artifact-sum"}}}}));
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-storage");
    wait(&view, cx, |s| !s.storage.busy && s.storage.usage.is_some());
    assert!(cx.debug_bounds("settings-storage-headroom").is_some());
    assert_eq!(
        view.read_with(cx, |s, _| s
            .storage
            .usage
            .as_ref()
            .unwrap()
            .storage_admission
            .as_ref()
            .unwrap()
            .dispatch_headroom_bytes),
        Some(700)
    );
    peer.reply("GET", "/api/worktrees/retention-usage", 503, json!({"accountingStatus":"partial","totalAllocatedBytes":null,"totalLogicalBytes":null,"storageAdmission":{"physicalAvailableBytes":null,"reservedBytes":null,"dispatchHeadroomBytes":null}}));
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(view.read_with(cx, |s, _| {
        s.storage.error.is_some()
            && s.storage
                .usage
                .as_ref()
                .unwrap()
                .total_allocated_bytes
                .is_none()
    }));
    assert!(cx.debug_bounds("settings-storage-error").is_some());
    peer.reply(
        "GET",
        "/api/worktrees/retention-usage",
        200,
        json!({"accountingStatus":"observed","totalAllocatedBytes":0,"totalLogicalBytes":0}),
    );
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(view.read_with(cx, |s, _| s.storage.error.is_none()
        && s.storage.usage.as_ref().unwrap().total_allocated_bytes == Some(0)));
    assert!(peer.calls().iter().all(|(method, _, _)| method == "GET"));
}
