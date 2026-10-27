//! Explicit installation and verified loading of whisper.cpp models.
//!
//! Models are never bundled. Loading only uses an installed, verified file.
//! Installation requires approval of the model's advertised byte count and
//! checks its SHA-256 before renaming it into place atomically.

use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Hugging Face revision of `ggerganov/whisper.cpp` the hashes below match.
pub const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSpec {
    pub name: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

impl ModelSpec {
    pub fn file_name(&self) -> String {
        format!("ggml-{}.bin", self.name)
    }

    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_REVISION}/{}",
            self.file_name()
        )
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        name: "tiny.en",
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        size: 77_704_715,
    },
    ModelSpec {
        name: "tiny",
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        size: 77_691_713,
    },
    ModelSpec {
        name: "base.en",
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        size: 147_964_211,
    },
    ModelSpec {
        name: "base",
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        size: 147_951_465,
    },
    ModelSpec {
        name: "small.en",
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        size: 487_614_201,
    },
    ModelSpec {
        name: "small",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size: 487_601_967,
    },
];

pub fn spec(name: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.name == name)
}

/// Pick the default model for a whisper language: the English-only `base.en`
/// for English or unknown, the multilingual `base` otherwise.
pub fn default_for_language(language: Option<&str>) -> &'static ModelSpec {
    match language {
        None | Some("en") => spec("base.en").unwrap(),
        Some(_) => spec("base").unwrap(),
    }
}

/// `~/.o8`, honoring the same overrides as `src-tauri/src/stt/keys.rs`.
pub fn o8_data_dir() -> PathBuf {
    for var in ["O8_DATA_DIR", "CORTEX_IDE_DATA_DIR"] {
        if let Some(dir) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".o8")
}

pub fn default_model_dir() -> PathBuf {
    o8_data_dir().join("models").join("whisper")
}

/// What the helper should load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelChoice {
    /// A known model, installed only after explicit approval.
    Managed(&'static ModelSpec),
    /// A user-supplied ggml file, used as-is.
    Path(PathBuf),
}

/// Resolve `O8_WHISPER_MODEL`-style input: a known name, a file path, or
/// nothing (use the language default).
pub fn choose(requested: Option<&str>, language: Option<&str>) -> Result<ModelChoice, String> {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(ModelChoice::Managed(default_for_language(language))),
        Some(value) if value.contains('/') => Ok(ModelChoice::Path(PathBuf::from(value))),
        Some(value) => spec(value).map(ModelChoice::Managed).ok_or_else(|| {
            let known: Vec<_> = MODELS.iter().map(|m| m.name).collect();
            format!("model_unknown:{value} (known: {})", known.join(", "))
        }),
    }
}

/// Fetches a URL to a local file.
pub trait Downloader {
    fn fetch(&self, url: &str, dest: &Path) -> Result<(), String>;

    /// Ordinary daemon loaders have no download approval.
    fn approved_size(&self) -> Option<u64> {
        None
    }
}

/// Used only by the explicit install command after the size was acknowledged.
pub struct ApprovedDownload<'a> {
    pub downloader: &'a dyn Downloader,
    pub size: u64,
}

impl Downloader for ApprovedDownload<'_> {
    fn fetch(&self, url: &str, dest: &Path) -> Result<(), String> {
        self.downloader.fetch(url, dest)
    }

    fn approved_size(&self) -> Option<u64> {
        Some(self.size)
    }
}

/// Downloads with `curl` or `wget`, whichever is installed.
pub struct CommandDownloader {
    pub search_path: std::ffi::OsString,
}

impl Downloader for CommandDownloader {
    fn fetch(&self, url: &str, dest: &Path) -> Result<(), String> {
        let path: &OsStr = &self.search_path;
        let mut cmd = if let Some(curl) = crate::tools::find_in("curl", path) {
            let mut c = Command::new(curl);
            c.args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--retry",
                "2",
                "--output",
            ])
            .arg(dest)
            .arg(url);
            c
        } else if let Some(wget) = crate::tools::find_in("wget", path) {
            let mut c = Command::new(wget);
            c.args(["--quiet", "--tries=3", "-O"]).arg(dest).arg(url);
            c
        } else {
            return Err("no downloader found (install curl or wget)".into());
        };
        let out = cmd
            .output()
            .map_err(|e| format!("download failed to start: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "download failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Verify an installed model. Missing or corrupt files require an explicit
/// size-approved installer; the daemon's ordinary downloader cannot fetch.
/// `on_download` reports progress, and does not grant download approval.
pub fn ensure(
    choice: &ModelChoice,
    dir: &Path,
    downloader: &dyn Downloader,
    on_download: &dyn Fn(&ModelSpec),
) -> Result<PathBuf, String> {
    let spec = match choice {
        ModelChoice::Path(path) => {
            return path
                .is_file()
                .then(|| path.clone())
                .ok_or_else(|| format!("model_unavailable: {} does not exist", path.display()));
        }
        ModelChoice::Managed(spec) => *spec,
    };
    let target = dir.join(spec.file_name());
    let reason = match target.metadata() {
        Ok(metadata) if metadata.len() == spec.size => match sha256_file(&target) {
            Ok(digest) if digest == spec.sha256 => return Ok(target),
            Ok(_) => "checksum mismatch".to_string(),
            Err(error) => error,
        },
        Ok(_) => "size mismatch".to_string(),
        Err(error) => format!("not readable: {error}"),
    };
    if downloader.approved_size() != Some(spec.size) {
        return Err(format!(
            "model_unavailable: {} ({reason}); download requires approval of {} bytes. Run o8-speech-recognizer --download-model {} --model-dir {:?} to review the size first.",
            spec.name, spec.size, spec.name, dir
        ));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("model_unavailable: create {}: {e}", dir.display()))?;
    on_download(spec);
    let part = dir.join(format!("{}.part-{}", spec.file_name(), std::process::id()));
    let result = downloader
        .fetch(&spec.url(), &part)
        .and_then(|()| {
            let size = part
                .metadata()
                .map_err(|e| format!("download size: {e}"))?
                .len();
            if size != spec.size {
                return Err(format!("size mismatch (got {size} bytes)"));
            }
            sha256_file(&part)
        })
        .and_then(|digest| {
            if digest == spec.sha256 {
                Ok(())
            } else {
                Err(format!("checksum mismatch (got {digest})"))
            }
        })
        .and_then(|()| std::fs::rename(&part, &target).map_err(|e| format!("install model: {e}")));
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "model_unavailable: could not download {} ({e}). Place {} in {} to use it offline.",
            spec.name,
            spec.file_name(),
            dir.display()
        ));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::TempDir;
    use std::cell::Cell;

    struct FakeDownloader {
        bytes: Vec<u8>,
        calls: Cell<usize>,
    }

    impl Downloader for FakeDownloader {
        fn fetch(&self, url: &str, dest: &Path) -> Result<(), String> {
            assert!(url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/"));
            self.calls.set(self.calls.get() + 1);
            std::fs::write(dest, &self.bytes).map_err(|e| e.to_string())
        }
    }

    // sha256("hello") — a stand-in model so the test stays offline.
    const HELLO: ModelSpec = ModelSpec {
        name: "test",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        size: 5,
    };

    #[test]
    fn downloads_verifies_and_reuses_a_model() {
        let dir = TempDir::new("model");
        let dl = FakeDownloader {
            bytes: b"hello".to_vec(),
            calls: Cell::new(0),
        };
        let announced = Cell::new(0);
        let spec: &'static ModelSpec = Box::leak(Box::new(HELLO));
        let choice = ModelChoice::Managed(spec);
        let approved = ApprovedDownload {
            downloader: &dl,
            size: spec.size,
        };
        let path = ensure(&choice, dir.path(), &approved, &|_| {
            announced.set(announced.get() + 1)
        })
        .unwrap();
        assert_eq!(path, dir.path().join("ggml-test.bin"));
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        ensure(&choice, dir.path(), &dl, &|_| {
            announced.set(announced.get() + 1)
        })
        .unwrap();
        assert_eq!((dl.calls.get(), announced.get()), (1, 1));
    }

    #[test]
    fn rejects_a_corrupt_download_and_leaves_nothing_behind() {
        let dir = TempDir::new("model-bad");
        let dl = FakeDownloader {
            bytes: b"HELLO".to_vec(),
            calls: Cell::new(0),
        };
        let spec: &'static ModelSpec = Box::leak(Box::new(HELLO));
        let approved = ApprovedDownload {
            downloader: &dl,
            size: spec.size,
        };
        let err = ensure(&ModelChoice::Managed(spec), dir.path(), &approved, &|_| {}).unwrap_err();
        assert!(
            err.starts_with("model_unavailable: could not download test (checksum mismatch"),
            "{err}"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn chooses_models_by_language_name_or_path() {
        assert_eq!(
            choose(None, Some("en")).unwrap(),
            ModelChoice::Managed(spec("base.en").unwrap())
        );
        assert_eq!(
            choose(Some(""), Some("de")).unwrap(),
            ModelChoice::Managed(spec("base").unwrap())
        );
        assert_eq!(
            choose(Some("tiny.en"), None).unwrap(),
            ModelChoice::Managed(spec("tiny.en").unwrap())
        );
        assert_eq!(
            choose(Some("/m/x.bin"), None).unwrap(),
            ModelChoice::Path("/m/x.bin".into())
        );
        assert!(choose(Some("huge"), None)
            .unwrap_err()
            .starts_with("model_unknown:huge"));
    }

    #[test]
    fn a_missing_custom_path_is_reported() {
        let dl = FakeDownloader {
            bytes: vec![],
            calls: Cell::new(0),
        };
        let err = ensure(
            &ModelChoice::Path("/nonexistent/m.bin".into()),
            Path::new("/tmp"),
            &dl,
            &|_| {},
        )
        .unwrap_err();
        assert_eq!(err, "model_unavailable: /nonexistent/m.bin does not exist");
    }

    #[test]
    fn urls_are_pinned_to_a_revision() {
        assert_eq!(
            spec("base.en").unwrap().url(),
            format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_REVISION}/ggml-base.en.bin")
        );
    }
}
