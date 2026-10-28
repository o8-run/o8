//! Local composer state, independent of the server's task and delivery stores.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

const LIMIT: u64 = 8 * 1024 * 1024;
const UNAVAILABLE: &str =
    "The adjustment could not be saved. Retry when local storage is available.";

pub struct Slot {
    file: PathBuf,
    key: String,
    packet: String,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    pub pending: Option<Value>,
}
#[derive(Serialize, Deserialize)]
struct Saved {
    version: u8,
    entries: BTreeMap<String, Draft>,
}
impl Slot {
    pub fn new(file: PathBuf, workspace: &str, packet: &str) -> Self {
        Self {
            file,
            key: serde_json::to_string(&(workspace, packet)).expect("string tuple"),
            packet: packet.to_owned(),
        }
    }
    fn read(&self) -> Result<Saved, String> {
        let data = match fs::File::open(&self.file) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = Vec::new();
                file.take(LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| UNAVAILABLE)?;
                if bytes.len() as u64 > LIMIT {
                    return Err(UNAVAILABLE.into());
                }
                bytes
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Saved {
                    version: 1,
                    entries: BTreeMap::new(),
                });
            }
            Err(_) => return Err(UNAVAILABLE.into()),
        };
        let saved: Saved = serde_json::from_slice(&data).map_err(|_| UNAVAILABLE)?;
        if saved.version != 1 {
            return Err(UNAVAILABLE.into());
        }
        Ok(saved)
    }
    pub fn load(&self) -> Result<Draft, String> {
        let draft = self.read()?.entries.remove(&self.key).unwrap_or_default();
        if let Some(body) = &draft.pending {
            if body["packetId"] != self.packet
                || body["source"] != "operator"
                || body["message"].as_str().is_none_or(|s| s.is_empty())
                || body["idempotencyKey"].as_str().is_none_or(|s| s.is_empty())
            {
                return Err(UNAVAILABLE.into());
            }
        }
        Ok(draft)
    }
    pub fn save(&self, text: String, pending: Option<Value>) -> Result<(), String> {
        // Merge the latest file so acknowledging one card preserves its peers.
        // An unreadable store fails closed instead of replacing an unknown key.
        let mut saved = self.read()?;
        if text.is_empty() && pending.is_none() {
            saved.entries.remove(&self.key);
        } else {
            saved
                .entries
                .insert(self.key.clone(), Draft { text, pending });
        }
        let bytes = serde_json::to_vec(&saved).map_err(|_| UNAVAILABLE)?;
        if bytes.len() as u64 > LIMIT {
            return Err(UNAVAILABLE.into());
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = self.file.with_extension(format!(
            "workers-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let write = || -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.file)?;
            #[cfg(unix)]
            if let Some(parent) = self.file.parent() {
                fs::File::open(parent)?.sync_all()?;
            }
            Ok(())
        };
        let result = write();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|_| UNAVAILABLE.into())
    }
}
