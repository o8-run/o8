//! The release version this shell runs as.
//!
//! A packaged macOS app reads it from its bundle's Info.plist, which the
//! bundler writes for every release. The release build cache can then reuse an
//! unchanged shell executable across releases instead of compiling it again
//! (`scripts/tauri-build.mjs`). Builds outside an app bundle use the Cargo
//! version they were compiled with.

use std::sync::OnceLock;

pub(crate) fn app_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| bundle_version().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()))
}

/// Give Tauri the runtime version, so the updater and the About panel compare
/// and show the release that is running, not the one the executable was
/// compiled for.
pub(crate) fn apply<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let version = app_version();
    match semver::Version::parse(version) {
        Ok(parsed) => {
            context.package_info_mut().version = parsed;
            context.config_mut().version = Some(version.to_string());
        }
        // Runs before the log plugin exists, so report on stderr.
        Err(error) => eprintln!("[app-version] {version} is not a release version: {error}"),
    }
}

#[cfg(target_os = "macos")]
fn bundle_version() -> Option<String> {
    let executable = std::env::current_exe().ok()?;
    if !executable.parent()?.ends_with("Contents/MacOS") {
        return None;
    }
    short_version(&objc2_foundation::NSBundle::mainBundle())
}

#[cfg(target_os = "macos")]
fn short_version(bundle: &objc2_foundation::NSBundle) -> Option<String> {
    use objc2_foundation::NSString;
    let key = NSString::from_str("CFBundleShortVersionString");
    let value = bundle.objectForInfoDictionaryKey(&key)?;
    let version = value.downcast::<NSString>().ok()?.to_string();
    (!version.is_empty()).then_some(version)
}

#[cfg(not(target_os = "macos"))]
fn bundle_version() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_tauri_context_reports_the_runtime_version() {
        let mut context: tauri::Context<tauri::test::MockRuntime> =
            tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = semver::Version::new(0, 0, 1);
        super::apply(&mut context);
        // A test binary runs outside an app bundle, so it uses the Cargo version.
        assert_eq!(
            context.package_info().version.to_string(),
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(
            context.config().version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_bundle_reports_the_version_its_info_plist_carries() {
        use objc2_foundation::{NSBundle, NSString};
        let root = std::env::temp_dir().join(format!("o8-app-version-{}", std::process::id()));
        let contents = root.join("o8.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::write(
            contents.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.o8.version-test</string>
<key>CFBundleShortVersionString</key><string>9.8.7</string>
</dict></plist>"#,
        )
        .unwrap();
        let path = NSString::from_str(&root.join("o8.app").to_string_lossy());
        let bundle = NSBundle::bundleWithPath(&path).expect("bundle opens");
        assert_eq!(super::short_version(&bundle).as_deref(), Some("9.8.7"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
