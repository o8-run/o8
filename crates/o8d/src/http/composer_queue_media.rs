//! The existing content-addressed composer image write, used only while
//! compacting an applied steer. Pending inline data remains in the ledger.
use super::composer_queue_store::Error;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

fn persist(images: &[Value], root: &Path) -> Result<String, Error> {
    if images.len() > 8 {
        return Err(Error::InvalidPayload);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)
            .map_err(|_| Error::InvalidPayload)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(root).map_err(|_| Error::InvalidPayload)?;
    let mut media = vec![];
    for image in images {
        let uri = image["dataUri"].as_str().ok_or(Error::InvalidPayload)?;
        if uri.len() >= 5_000_000 || image.get("name").is_some_and(|name| !name.is_string()) {
            return Err(Error::InvalidPayload);
        }
        let (header, encoded) = uri.split_once(',').ok_or(Error::InvalidPayload)?;
        let header = header.to_ascii_lowercase();
        let mime = header
            .strip_prefix("data:")
            .and_then(|s| s.strip_suffix(";base64"))
            .ok_or(Error::InvalidPayload)?
            .to_ascii_lowercase();
        let extension = match mime.as_str() {
            "image/png" => ".png",
            "image/jpeg" => ".jpg",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            _ => return Err(Error::InvalidPayload),
        };
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| Error::InvalidPayload)?;
        if bytes.is_empty() || STANDARD.encode(&bytes) != encoded {
            return Err(Error::InvalidPayload);
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let path = root.join(format!("{digest}{extension}"));
        if !path.exists() {
            let temporary = root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
            let mut created = false;
            let write = (|| {
                let mut options = fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options
                    .open(&temporary)
                    .map_err(|_| Error::InvalidPayload)?;
                created = true;
                file.write_all(&bytes).map_err(|_| Error::InvalidPayload)?;
                if fs::rename(&temporary, &path).is_err() && !path.exists() {
                    return Err(Error::InvalidPayload);
                }
                Ok(())
            })();
            // Only the unique temporary file created by this call is removed.
            if created {
                let _ = fs::remove_file(&temporary);
            }
            write?;
        }
        if !fs::symlink_metadata(&path)
            .map_err(|_| Error::InvalidPayload)?
            .is_file()
            || fs::read(&path).map_err(|_| Error::InvalidPayload)? != bytes
        {
            return Err(Error::InvalidPayload);
        }
        let name = image
            .get("name")
            .and_then(Value::as_str)
            .map(super::chat_context_json::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Image {}", &digest[..8]));
        let name = String::from_utf16(&name.encode_utf16().take(500).collect::<Vec<_>>())
            .map_err(|_| Error::InvalidPayload)?;
        let path = path.to_str().ok_or(Error::InvalidPayload)?;
        let quote = |s: &str| serde_json::to_string(s).map_err(|_| Error::InvalidPayload);
        media.push(format!(
            "{{\"kind\":\"image\",\"path\":{},\"name\":{},\"mimeType\":{}}}",
            quote(path)?,
            quote(&name)?,
            quote(&mime)?
        ));
    }
    Ok(format!("[{}]", media.join(",")))
}
pub(crate) fn compact(raw: &str, preserve_steer: bool, media_root: &Path) -> Result<String, Error> {
    let payload: Value = serde_json::from_str(raw).map_err(|_| Error::InvalidPayload)?;
    let media = if preserve_steer {
        let images = payload["images"].as_array().ok_or(Error::InvalidPayload)?;
        if images.is_empty() {
            None
        } else {
            Some(persist(images, &media_root.join("orchestrator-images"))?)
        }
    } else {
        None
    };
    super::composer_queue_payload::compact(raw, preserve_steer, media.as_deref())
        .map_err(|_| Error::InvalidPayload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_media_files_and_compacted_bytes_match_typescript() {
        let root = std::env::temp_dir().join(format!("o8-composer-media-{}", uuid::Uuid::new_v4()));
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let raw = vector["serialized"].as_str().unwrap();
            let actual = compact(raw, true, &root.join("media")).unwrap();
            assert_eq!(
                actual.replace(root.to_str().unwrap(), "<fixture-root>"),
                vector["compactSteer"]
            );
            if let Some(files) = vector["mediaFiles"].as_array() {
                for file in files {
                    let path = file["path"]
                        .as_str()
                        .unwrap()
                        .replace("<fixture-root>", root.to_str().unwrap());
                    assert_eq!(STANDARD.encode(fs::read(path).unwrap()), file["base64"]);
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod relative_tests {
    use super::*;
    #[test]
    fn relative_override_writes_against_cwd_and_keeps_the_relative_media_reference() {
        let root = std::path::PathBuf::from(format!(".o8-queue-relative-{}", uuid::Uuid::new_v4()));
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        let vector = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["mediaFiles"].as_array().is_some_and(|a| !a.is_empty()))
            .unwrap();
        let actual = compact(vector["serialized"].as_str().unwrap(), true, &root).unwrap();
        let parsed: Value = serde_json::from_str(&actual).unwrap();
        let path = Path::new(parsed["deliveredMedia"][0]["path"].as_str().unwrap());
        assert!(!path.is_absolute());
        assert!(path.starts_with(&root));
        assert_eq!(
            STANDARD.encode(fs::read(std::env::current_dir().unwrap().join(path)).unwrap()),
            vector["mediaFiles"][0]["base64"]
        );
        assert_eq!(
            actual,
            vector["compactSteer"]
                .as_str()
                .unwrap()
                .replace("<fixture-root>/media", root.to_str().unwrap())
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
