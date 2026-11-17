//! Isolated classic installer for the launcher chain acceptance test.
//! Uses the fixture's exact updater dependency and mock application runtime.
#[cfg(target_os = "macos")]
fn main() {
    use tauri_plugin_updater::UpdaterExt;
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "manifest URL, public key, installed executable"
    );
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = "0.9.0".parse().unwrap();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": args[2], "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    tauri::async_runtime::block_on(async {
        let update = app
            .updater_builder()
            .endpoints(vec![args[1].parse().unwrap()])
            .unwrap()
            .pubkey(&args[2])
            .executable_path(std::path::Path::new(&args[3]))
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .expect("NEW available");
        update.download_and_install(|_, _| {}, || {}).await.unwrap();
    });
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("macOS only");
}
