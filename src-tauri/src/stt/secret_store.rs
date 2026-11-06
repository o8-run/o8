//! Linux Secret Service storage for voice-provider keys.
//!
//! macOS keeps these keys in the login Keychain (`keys.rs`). On Linux the
//! freedesktop Secret Service (GNOME Keyring, KWallet's bridge, KeePassXC) is
//! the equivalent, reached through the `keyring` crate. Headless sessions and
//! desktops without a keyring daemon have no Secret Service; there the keys
//! stay in the 0600 `~/.o8/dictation.json` exactly as before, with one log line
//! saying so.
//!
//! The policy (when to fall back, when to fail, when a plaintext copy may be
//! dropped) is written against [`SecretBackend`] so it is testable without a
//! D-Bus session. A plaintext copy is removed only after the Secret Service
//! returns the identical value on a read-back (copy, then verify, then drop).

use std::sync::atomic::{AtomicBool, Ordering};

/// Why a Secret Service call did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No Secret Service is reachable (no D-Bus session, no keyring daemon).
    /// Callers fall back to the 0600 preferences file.
    Unavailable(String),
    /// The service is running but refused or failed the request (for example
    /// a locked collection whose unlock prompt was dismissed). Writes must not
    /// silently downgrade to plaintext in this case.
    Failed(String),
}

/// Minimal secret storage surface used by the voice-key resolver.
pub trait SecretBackend {
    /// `Ok(None)` when no item exists for `key`.
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, value: &str) -> Result<(), StoreError>;
    /// Deleting a missing item succeeds.
    fn delete(&self, key: &str) -> Result<(), StoreError>;
    /// Presence check that avoids returning the secret where the backend allows.
    fn present(&self, key: &str) -> bool {
        matches!(self.get(key), Ok(Some(_)))
    }
}

/// Where a provider-key write ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The Secret Service holds the value (or confirmed the delete); the
    /// preferences file must not keep a plaintext copy.
    Stored,
    /// No Secret Service is available; keep the value in the 0600 file.
    FileFallback,
}

static FALLBACK_LOGGED: AtomicBool = AtomicBool::new(false);

fn log_fallback(detail: &str) {
    if !FALLBACK_LOGGED.swap(true, Ordering::Relaxed) {
        log::warn!(
            "[voice-keys] Secret Service unavailable ({detail}); voice provider keys stay in \
             ~/.o8/dictation.json (mode 0600). Start a keyring daemon such as gnome-keyring to \
             store them in the Secret Service."
        );
    }
}

/// Store `secret` (or delete the item when `secret` is empty) and verify it.
pub fn write_secret(
    backend: &impl SecretBackend,
    key: &str,
    secret: &str,
) -> Result<WriteOutcome, String> {
    let result = if secret.is_empty() {
        backend.delete(key)
    } else {
        backend
            .set(key, secret)
            .and_then(|()| match backend.get(key)? {
                Some(read) if read == secret => Ok(()),
                _ => Err(StoreError::Failed("read-back did not match".to_string())),
            })
    };
    match result {
        Ok(()) => Ok(WriteOutcome::Stored),
        Err(StoreError::Unavailable(detail)) => {
            log_fallback(&detail);
            Ok(WriteOutcome::FileFallback)
        }
        Err(StoreError::Failed(detail)) => {
            Err(format!("store {key} in the Secret Service: {detail}"))
        }
    }
}

/// Copy a plaintext value from the preferences file into the Secret Service.
/// Returns true only when the read-back matched, which is the sole condition
/// under which the caller may remove the plaintext copy.
pub fn migrate_legacy(backend: &impl SecretBackend, key: &str, legacy: &str) -> bool {
    match write_secret(backend, key, legacy) {
        Ok(WriteOutcome::Stored) => {
            log::info!("[voice-keys] Moved {key} from dictation.json into the Secret Service");
            true
        }
        Ok(WriteOutcome::FileFallback) => false,
        Err(error) => {
            log::warn!("[voice-keys] Keeping {key} in dictation.json: {error}");
            false
        }
    }
}

/// Read a stored value; any backend error reads as "no stored value".
pub fn read_secret(backend: &impl SecretBackend, key: &str) -> Option<String> {
    match backend.get(key) {
        Ok(value) => value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        Err(StoreError::Unavailable(detail)) => {
            log_fallback(&detail);
            None
        }
        Err(StoreError::Failed(detail)) => {
            log::warn!("[voice-keys] Secret Service read of {key} failed: {detail}");
            None
        }
    }
}

#[cfg(target_os = "linux")]
pub use system::SystemSecretStore;

#[cfg(target_os = "linux")]
mod system {
    use super::{SecretBackend, StoreError};

    /// Same service name as the macOS Keychain items, so one name identifies
    /// o8 voice keys in every OS secret store.
    const SERVICE: &str = "ai.o8.desktop.voice-provider-keys";

    pub struct SystemSecretStore;

    fn classify(error: keyring::Error) -> StoreError {
        match error {
            // No D-Bus session, no org.freedesktop.secrets owner, or another
            // transport failure: there is no store to talk to.
            keyring::Error::PlatformFailure(e) => StoreError::Unavailable(e.to_string()),
            other => StoreError::Failed(other.to_string()),
        }
    }

    fn entry(key: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, key).map_err(classify)
    }

    impl SecretBackend for SystemSecretStore {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            match entry(key)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(classify(error)),
            }
        }

        fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
            entry(key)?.set_password(value).map_err(classify)
        }

        fn delete(&self, key: &str) -> Result<(), StoreError> {
            match entry(key)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(classify(error)),
            }
        }

        fn present(&self, key: &str) -> bool {
            entry(key).is_ok_and(|e| e.get_attributes().is_ok())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{classify, StoreError};

        #[test]
        fn transport_failures_fall_back_and_access_failures_do_not() {
            let io = || Box::new(std::io::Error::other("no session bus")) as Box<_>;
            assert!(matches!(
                classify(keyring::Error::PlatformFailure(io())),
                StoreError::Unavailable(_)
            ));
            assert!(matches!(
                classify(keyring::Error::NoStorageAccess(io())),
                StoreError::Failed(_)
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        items: RefCell<HashMap<String, String>>,
        error: Option<StoreError>,
        /// Simulates a store that accepts a write but returns something else.
        corrupt_reads: bool,
    }

    impl SecretBackend for Fake {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            if let Some(e) = &self.error {
                return Err(e.clone());
            }
            let value = self.items.borrow().get(key).cloned();
            Ok(if self.corrupt_reads {
                value.map(|v| format!("{v}x"))
            } else {
                value
            })
        }
        fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
            if let Some(e) = &self.error {
                return Err(e.clone());
            }
            self.items.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), StoreError> {
            if let Some(e) = &self.error {
                return Err(e.clone());
            }
            self.items.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn with_error(error: StoreError) -> Fake {
        Fake {
            error: Some(error),
            ..Fake::default()
        }
    }

    #[test]
    fn write_stores_and_verifies_then_reads_back() {
        let store = Fake::default();
        assert_eq!(
            write_secret(&store, "gemini_api_key", "k1"),
            Ok(WriteOutcome::Stored)
        );
        assert_eq!(read_secret(&store, "gemini_api_key").as_deref(), Some("k1"));
        assert!(store.present("gemini_api_key"));
        assert_eq!(
            write_secret(&store, "gemini_api_key", ""),
            Ok(WriteOutcome::Stored)
        );
        assert_eq!(read_secret(&store, "gemini_api_key"), None);
        // Clearing an item that never existed is not an error.
        assert_eq!(
            write_secret(&store, "groq_api_key", ""),
            Ok(WriteOutcome::Stored)
        );
    }

    #[test]
    fn missing_secret_service_falls_back_to_the_file() {
        let store = with_error(StoreError::Unavailable("no bus".into()));
        assert_eq!(
            write_secret(&store, "groq_api_key", "k"),
            Ok(WriteOutcome::FileFallback)
        );
        assert_eq!(
            write_secret(&store, "groq_api_key", ""),
            Ok(WriteOutcome::FileFallback)
        );
        assert_eq!(read_secret(&store, "groq_api_key"), None);
        assert!(!migrate_legacy(&store, "groq_api_key", "k"));
    }

    #[test]
    fn a_refusing_secret_service_never_downgrades_a_write_to_plaintext() {
        let store = with_error(StoreError::Failed("locked".into()));
        let error = write_secret(&store, "groq_api_key", "k").unwrap_err();
        assert!(error.contains("groq_api_key") && error.contains("locked"));
        assert!(write_secret(&store, "groq_api_key", "").is_err());
        assert!(!migrate_legacy(&store, "groq_api_key", "k"));
    }

    #[test]
    fn migration_reports_success_only_after_a_matching_read_back() {
        let store = Fake::default();
        assert!(migrate_legacy(&store, "elevenlabs_api_key", "legacy"));
        assert_eq!(
            store
                .items
                .borrow()
                .get("elevenlabs_api_key")
                .map(String::as_str),
            Some("legacy")
        );

        let corrupt = Fake {
            corrupt_reads: true,
            ..Fake::default()
        };
        assert!(!migrate_legacy(&corrupt, "elevenlabs_api_key", "legacy"));
        assert!(write_secret(&corrupt, "elevenlabs_api_key", "legacy").is_err());
    }
}
