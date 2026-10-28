use std::fs;
use std::path::Path;

fn main() {
  // Tauri's `custom-protocol` feature belongs to the dependency, so this crate
  // cannot inspect it with `cfg!(feature = ...)`. Surface Tauri's own build-mode
  // decision for the pre-startup native test isolation guard.
  println!("cargo:rerun-if-env-changed=DEP_TAURI_DEV");
  println!("cargo:rustc-check-cfg=cfg(o8_custom_protocol)");
  if !tauri_build::is_dev() {
    println!("cargo:rustc-cfg=o8_custom_protocol");
  }

  // ── Voice STT Swift sidecar compile (lifted from aqua/Symon) ──
  // macOS: compile the Swift speech recognizer helper FIRST.
  // IMPORTANT: This must run BEFORE tauri_build::build() because Tauri's
  // build step validates that all externalBin sidecar files exist on disk.
  // We need the triple-suffixed copies in place before that validation runs.
  build_speech_recognizer();
  build_visual_capture_media();
  stage_linux_pi_write();

  // #932: tauri-plugin-mcp permissions are only registered when the
  // `dev-mcp-plugin` Cargo feature is on. Tauri's compile-time capability
  // resolver needs the permission identifier (`mcp:*`) to exist at build
  // time, so we materialize `capabilities/mcp.json` only when the feature
  // is active. Without the feature, the file is removed so the build
  // doesn't fail on an unknown permission.
  let cap_dir = Path::new("capabilities");
  let template = cap_dir.join("mcp.json.in");
  let target = cap_dir.join("mcp.json");
  let feature_on = std::env::var("CARGO_FEATURE_DEV_MCP_PLUGIN").is_ok();

  println!("cargo:rerun-if-changed={}", template.display());
  println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DEV_MCP_PLUGIN");

  if feature_on {
    if template.exists() {
      let contents = fs::read_to_string(&template).expect("read capabilities/mcp.json.in");
      let should_write = fs::read_to_string(&target)
        .map(|existing| existing != contents)
        .unwrap_or(true);

      if should_write {
        let _ = fs::write(&target, contents);
      }
    }
  } else if target.exists() {
    let _ = fs::remove_file(&target);
  }

  // #1734: the app page (http://127.0.0.1:<port>) is a REMOTE origin to Tauri,
  // and since Tauri 2.11 remote content can only invoke commands a capability
  // explicitly grants — which requires app commands to have grantable
  // permissions at all. Generate ONE permission (`allow-app-ipc`) covering
  // every command registered in `generate_handler![...]` by parsing src/lib.rs,
  // so the grant can never drift from the handler list. Capabilities reference
  // it per window (default / overlays / voice-settings / dictation).
  // NOTE: the mere existence of a file under permissions/ turns the app ACL
  // manifest ON, which makes app commands ACL-checked from LOCAL origins too —
  // that is why the generated permission must stay complete.
  generate_app_ipc_permission();

  bake_sentry_dsn();

  tauri_build::build()
}

/// Linux bundles `o8-pi-write` as an externalBin (it is both the approved-write
/// helper and the Pi command supervisor there), and tauri-build refuses to
/// compile in any profile when that sidecar is missing. Packaged builds stage
/// a fresh release binary through `scripts/build-pi-write.mjs` (tauri:prebuild)
/// before cargo runs, so an existing staged copy is always kept. A bare
/// `cargo check` or `cargo build` (CI compile gates, dev) builds the sidecar
/// crate here instead, in its own target directory under OUT_DIR.
fn stage_linux_pi_write() {
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
    return;
  }
  let target = std::env::var("TARGET").expect("TARGET");
  let staged = Path::new("helpers").join(format!("o8-pi-write-{target}"));
  println!("cargo:rerun-if-changed={}", staged.display());
  if staged.exists() {
    return;
  }

  let manifest = Path::new("sidecars/pi-write/Cargo.toml");
  let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
  let target_dir = out_dir.join("pi-write-target");
  let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
  let status = std::process::Command::new(cargo)
    .args(["build", "--release", "--locked", "--manifest-path"])
    .arg(manifest)
    .args(["--target", &target, "--target-dir"])
    .arg(&target_dir)
    // The outer build's flags and target dir belong to the Tauri crate.
    .env_remove("CARGO_ENCODED_RUSTFLAGS")
    .env_remove("RUSTFLAGS")
    .env_remove("CARGO_TARGET_DIR")
    .env_remove("CARGO_BUILD_TARGET")
    .status()
    .expect("run cargo for the o8-pi-write sidecar");
  assert!(
    status.success(),
    "o8-pi-write failed to build for {target}; run `node scripts/build-pi-write.mjs` to stage it"
  );
  let built = target_dir.join(&target).join("release").join("o8-pi-write");
  let _ = fs::create_dir_all("helpers");
  fs::copy(&built, &staged).unwrap_or_else(|error| {
    panic!("stage {} -> {}: {error}", built.display(), staged.display())
  });
}

fn build_visual_capture_media() {
  #[cfg(target_os = "macos")]
  {
    // The screen capture bridge links Swift. Resolve the OS runtime for both
    // installed apps and Rust tests without requiring an Xcode runtime path.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let source = Path::new("helpers/visual_capture_media.swift");
    println!("cargo:rerun-if-changed={}", source.display());
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
      .join("visual-capture-media");
    let target = std::env::var("TARGET").expect("TARGET");
    let arch = if target.starts_with("x86_64") { "x86_64" } else { "arm64" };
    let status = std::process::Command::new("swiftc")
      .args(["-O", "-parse-as-library", "-target", &format!("{arch}-apple-macosx14.0"), "-o"])
      .arg(&output).arg(source)
      .args(["-framework", "Speech", "-framework", "AVFoundation", "-framework", "ImageIO"])
      .status().expect("compile visual capture media helper");
    assert!(status.success(), "Visual capture media helper failed to compile");
    println!("cargo:rustc-env=O8_VISUAL_CAPTURE_MEDIA={}", output.display());
  }
}

fn generate_app_ipc_permission() {
  println!("cargo:rerun-if-changed=src/lib.rs");

  let lib = fs::read_to_string("src/lib.rs").expect("read src/lib.rs");
  let opener = "generate_handler![";
  let start = lib
    .find(opener)
    .expect("generate_handler! block not found in src/lib.rs")
    + opener.len();

  let mut commands: Vec<String> = Vec::new();
  for line in lib[start..].lines() {
    let trimmed = line.trim().trim_end_matches(',');
    if trimmed.starts_with("])") || trimmed == "]" {
      break;
    }
    // Skip #[cfg(...)] attribute lines and comments; keep bare identifiers
    // (module-qualified paths register under their final segment).
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
      continue;
    }
    let name = trimmed.rsplit("::").next().unwrap_or(trimmed);
    if !name.is_empty()
      && name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
      commands.push(name.to_string());
    }
  }
  commands.sort();
  commands.dedup();

  // Parser tripwire: if lib.rs is ever reshaped in a way this parser cannot
  // follow, fail the build loudly instead of shipping a silent ACL hole.
  assert!(
    commands.len() >= 90,
    "generate_app_ipc_permission parsed only {} commands from generate_handler! — parser drifted from src/lib.rs",
    commands.len()
  );

  let list = commands
    .iter()
    .map(|c| format!("  \"{c}\","))
    .collect::<Vec<_>>()
    .join("\n");
  let contents = format!(
    "# Generated by build.rs from the generate_handler! block in src/lib.rs — DO NOT EDIT.\n\
     # See #1734: grants every registered app command to the windows whose\n\
     # capabilities reference `allow-app-ipc`.\n\n\
     [[permission]]\n\
     identifier = \"allow-app-ipc\"\n\
     description = \"Every #[tauri::command] registered in generate_handler!, granted to the app's own windows and loopback page origin.\"\n\
     commands.allow = [\n{list}\n]\n"
  );

  let perm_dir = Path::new("permissions");
  let _ = fs::create_dir_all(perm_dir);
  let target = perm_dir.join("autogenerated-app-ipc.toml");
  let should_write = fs::read_to_string(&target)
    .map(|existing| existing != contents)
    .unwrap_or(true);
  if should_write {
    fs::write(&target, contents).expect("write permissions/autogenerated-app-ipc.toml");
  }
}

/// Bake the Sentry DSN into the binary as a compile-time env
/// (`option_env!("O8_SENTRY_DSN")`), RELEASE builds only — debug / `tauri dev`
/// stay dormant regardless of config. Source: `SENTRY_DSN` env var wins, else
/// the `sentryDsn` key in `../o8.release.json` (gitignored, main-checkout only —
/// the worktree has none, so worktree builds bake nothing). Absent → nothing is
/// emitted and `option_env!` resolves to None.
fn bake_sentry_dsn() {
  println!("cargo:rerun-if-changed=../o8.release.json");
  println!("cargo:rerun-if-env-changed=SENTRY_DSN");
  println!("cargo:rerun-if-env-changed=PROFILE");

  // RELEASE-only: dev builds must never carry a DSN.
  if std::env::var("PROFILE").as_deref() != Ok("release") {
    return;
  }

  let mut dsn = std::env::var("SENTRY_DSN").unwrap_or_default().trim().to_string();
  if dsn.is_empty() {
    if let Ok(raw) = fs::read_to_string("../o8.release.json") {
      if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(v) = parsed.get("sentryDsn").and_then(|v| v.as_str()) {
          dsn = v.trim().to_string();
        }
      }
    }
  }

  if !dsn.is_empty() {
    // Only emit when present so `option_env!` stays None (not Some("")) absent.
    println!("cargo:rustc-env=O8_SENTRY_DSN={dsn}");
    println!("cargo:warning=Sentry DSN baked into native shell (release)");
  }
}

/// Compile the Swift `speech_recognizer` helper into per-arch + universal
/// sidecar binaries (lifted from aqua/Symon's build.rs, de-Symonized helper
/// identifier). No-op on non-macOS and when the Swift source is absent.
fn build_speech_recognizer() {
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=ApplicationServices");

    // Always rerun — we must produce per-arch copies for universal builds.
    // A source-only rerun-if-changed causes Cargo to skip the second arch's
    // build.rs invocation during `--target universal-apple-darwin`, which means
    // the triple-suffixed copy for that arch is never created.
    println!("cargo:rerun-if-changed=helpers/speech_recognizer.swift");
    println!("cargo:rerun-if-changed=helpers/speech_recognizer_info.plist");
    println!("cargo:rerun-if-changed=build.rs");

    let helpers_dir = std::path::Path::new("helpers");
    let swift_src = helpers_dir.join("speech_recognizer.swift");
    let info_plist_src = helpers_dir.join("speech_recognizer_info.plist");

    if swift_src.exists() {
      // Use MACOSX_DEPLOYMENT_TARGET to ensure the binary runs on the current OS.
      let deployment_target =
        std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".to_string());

      let cargo_target =
        std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".to_string());
      let profile = std::env::var("PROFILE").unwrap_or_default();
      let target_dir = std::env::var("OUT_DIR").ok().and_then(|out_dir| {
        // OUT_DIR is like target/debug/build/o8-xxx/out — go up to target/debug/.
        std::path::PathBuf::from(out_dir)
          .ancestors()
          .nth(3)
          .map(|path| path.to_path_buf())
      });
      // Thin per-arch slices and the lipo'd fat binary are build INTERMEDIATES
      // and must never be generated into src-tauri/helpers: (a) Tauri dev
      // watches that directory and restarts whenever build.rs rewrites a
      // sidecar, and (b) in release the bundling copies below overwrite
      // helpers/speech_recognizer-<arch>-apple-darwin with the FAT binary —
      // when that same path was also lipo's thin input, the NEXT release build
      // reused it (needs_rebuild only checks the Swift source) and lipo failed
      // with "have the same architectures (arm64)" (the v0.1.596 ship failure).
      // helpers/ only ever receives finished copies for Tauri's bundler.
      let generated_dir = target_dir
        .clone()
        .unwrap_or_else(|| helpers_dir.to_path_buf());
      let _ = std::fs::create_dir_all(&generated_dir);
      let swift_bin = generated_dir.join("speech_recognizer");

      // Strategy: always compile BOTH aarch64 and x86_64 slices and copy
      // them to their respective triple-suffixed paths. This is idempotent
      // and ensures both sidecar paths exist regardless of which cargo
      // invocation (arch) we are currently in. Then lipo them into a fat
      // binary for the unsuffixed path used in dev mode.
      // Helper: skip work when output is newer than ALL inputs. The variadic
      // input list matters — the helper binary depends on BOTH the Swift
      // source and the embedded Info.plist, so we must rebuild when either
      // changes (otherwise the plist-less pre-cache-gets-shipped bug bites).
      fn needs_rebuild(out: &std::path::Path, sources: &[&std::path::Path]) -> bool {
        let Ok(out_meta) = out.metadata() else {
          return true;
        };
        let Ok(out_m) = out_meta.modified() else {
          return true;
        };
        sources.iter().any(|src| {
          let Ok(src_meta) = src.metadata() else {
            return true;
          };
          let Ok(src_m) = src_meta.modified() else {
            return true;
          };
          src_m > out_m
        })
      }

      fn copy_if_changed(
        src: &std::path::Path,
        dst: &std::path::Path,
      ) -> std::io::Result<bool> {
        let src_bytes = std::fs::read(src)?;
        if let Ok(dst_bytes) = std::fs::read(dst) {
          if dst_bytes == src_bytes {
            return Ok(false);
          }
        }

        std::fs::write(dst, &src_bytes)?;
        let permissions = std::fs::metadata(src)?.permissions();
        std::fs::set_permissions(dst, permissions)?;
        Ok(true)
      }

      fn has_codesign_identifier(path: &std::path::Path, identifier: &str) -> bool {
        let Ok(output) = std::process::Command::new("codesign")
          .args(["-dv", path.to_str().unwrap()])
          .output()
        else {
          return false;
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        output.status.success() && stderr.contains(&format!("Identifier={identifier}"))
      }

      fn codesign_if_needed(path: &std::path::Path, identifier: &str) {
        if has_codesign_identifier(path, identifier) {
          return;
        }

        let _ = std::process::Command::new("codesign")
          .args(["-s", "-", "-f", "-i", identifier, path.to_str().unwrap()])
          .status();
      }

      let arches = ["aarch64", "x86_64"];
      let mut arch_bins: Vec<std::path::PathBuf> = Vec::new();

      for arch in &arches {
        let swift_target = format!("{arch}-apple-macosx{deployment_target}");
        let arch_bin = generated_dir.join(format!("speech_recognizer-{arch}-apple-darwin"));

        if needs_rebuild(&arch_bin, &[&swift_src, &info_plist_src]) {
          let info_plist = &info_plist_src;
          let status = std::process::Command::new("swiftc")
            .args([
              "-O",
              "-target",
              &swift_target,
              "-o",
              arch_bin.to_str().unwrap(),
              swift_src.to_str().unwrap(),
              "-framework",
              "Speech",
              "-framework",
              "AVFoundation",
              "-Xlinker",
              "-sectcreate",
              "-Xlinker",
              "__TEXT",
              "-Xlinker",
              "__info_plist",
              "-Xlinker",
              info_plist.to_str().unwrap(),
            ])
            .status()
            .expect("Failed to run swiftc — is Xcode installed?");

          assert!(
            status.success(),
            "Swift helper compilation failed for {arch} (exit code: {:?})",
            status.code()
          );

          println!(
            "cargo:warning=Compiled speech_recognizer [{arch}] → {}",
            arch_bin.display()
          );
        }

        arch_bins.push(arch_bin);
      }

      // Lipo the two slices into a fat universal binary for the unsuffixed
      // path (used in dev mode and as the source for target-dir copy).
      let mut fat_sources: Vec<&std::path::Path> = vec![&swift_src, &info_plist_src];
      for arch_bin in &arch_bins {
        fat_sources.push(arch_bin.as_path());
      }

      if needs_rebuild(&swift_bin, &fat_sources) {
        let lipo_status = std::process::Command::new("lipo")
          .arg("-create")
          .args(arch_bins.iter().map(|p| p.to_str().unwrap()))
          .arg("-output")
          .arg(swift_bin.to_str().unwrap())
          .status()
          .expect("Failed to run lipo — is Xcode installed?");

        assert!(
          lipo_status.success(),
          "lipo universal merge failed (exit code: {:?})",
          lipo_status.code()
        );
      }

      // Ad-hoc sign the fat binary with a stable identifier so macOS TCC
      // permissions survive across recompilations.
      const HELPER_IDENTIFIER: &str = "ai.o8.desktop.speech-recognizer";
      codesign_if_needed(&swift_bin, HELPER_IDENTIFIER);
      for arch_bin in &arch_bins {
        codesign_if_needed(arch_bin, HELPER_IDENTIFIER);
      }

      // Tauri's externalBin validation runs in EVERY profile (debug check
      // included) and resolves `helpers/speech_recognizer` → the
      // current-target-triple suffix in `helpers/`. In dev/check, the per-arch
      // binaries were generated into the target dir, so ensure the
      // current-target triple copy is present in `helpers/` for the validator.
      // copy_if_changed is a no-op when the bytes already match, so this won't
      // trigger a dev-watch restart loop after the first build.
      {
        let arch_prefix = cargo_target.split('-').next().unwrap_or("aarch64");
        let source_arch_bin =
          generated_dir.join(format!("speech_recognizer-{arch_prefix}-apple-darwin"));
        let helpers_target_triple = helpers_dir.join(format!("speech_recognizer-{cargo_target}"));
        let helpers_arch_triple =
          helpers_dir.join(format!("speech_recognizer-{arch_prefix}-apple-darwin"));
        if source_arch_bin.exists() {
          let _ = copy_if_changed(&source_arch_bin, &helpers_arch_triple);
          if helpers_target_triple != helpers_arch_triple {
            let _ = copy_if_changed(&source_arch_bin, &helpers_target_triple);
          }
          codesign_if_needed(&helpers_arch_triple, HELPER_IDENTIFIER);
          if helpers_target_triple != helpers_arch_triple {
            codesign_if_needed(&helpers_target_triple, HELPER_IDENTIFIER);
          }
        }
      }

      if profile == "release" {
        // Tauri's bundler for `--target universal-apple-darwin` looks for a
        // sidecar named with the literal `universal-apple-darwin` triple when
        // assembling the .app.
        let universal_bin = helpers_dir.join("speech_recognizer-universal-apple-darwin");
        if let Err(e) = copy_if_changed(&swift_bin, &universal_bin) {
          println!(
            "cargo:warning=failed to copy universal sidecar {}: {e}",
            universal_bin.display()
          );
        }

        // In release mode the sidecar Tauri bundles for the CURRENT cargo
        // target is the UNIVERSAL fat binary, not the thin current-arch
        // slice. Stable macOS releases use one universal app, so both Intel
        // and Apple Silicon must select a native slice from this sidecar.
        let arch_prefix = cargo_target.split('-').next().unwrap_or("aarch64");
        let canonical_arch_bin =
          helpers_dir.join(format!("speech_recognizer-{arch_prefix}-apple-darwin"));
        let sidecar = helpers_dir.join(format!("speech_recognizer-{cargo_target}"));
        let _ = copy_if_changed(&swift_bin, &canonical_arch_bin);
        codesign_if_needed(&canonical_arch_bin, HELPER_IDENTIFIER);
        if canonical_arch_bin != sidecar {
          let _ = copy_if_changed(&swift_bin, &sidecar);
          codesign_if_needed(&sidecar, HELPER_IDENTIFIER);
        }
      }

      // Also copy fat binary to target dir so the helper_path() lookup
      // finds the correctly-built binary (Tauri/cargo may place a stale copy).
      if let Some(target_dir) = target_dir.as_deref() {
        let target_bin = target_dir.join("speech_recognizer");
        if target_bin != swift_bin {
          let _ = copy_if_changed(&swift_bin, &target_bin);
        }
      }

      println!(
        "cargo:warning=speech_recognizer universal binary → {}",
        swift_bin.display()
      );
    } else {
      println!(
        "cargo:warning=Swift helper source not found at {}",
        swift_src.display()
      );
    }
  }
}
