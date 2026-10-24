use super::{process_identity::Identity, ReadResult};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingPublisher {
    pub(crate) generation: String,
    pub(super) identity: Identity,
}

#[derive(Default)]
pub(super) struct Bindings {
    verified: BTreeMap<String, Identity>,
}

impl Bindings {
    // The pending witness is returned to this request, never shared across an
    // await. A known generation can never acquire a different process witness.
    pub(super) fn check(
        &self,
        candidate: PendingPublisher,
    ) -> Result<(), Option<PendingPublisher>> {
        match self.verified.get(&candidate.generation) {
            Some(identity) if *identity == candidate.identity => Ok(()),
            Some(_) => Err(None),
            None if self.verified.len() < 64 => Err(Some(candidate)),
            None => Err(None), // Bound memory; saturation safely retains TS.
        }
    }

    pub(super) fn verify(&mut self, pending: PendingPublisher) -> ReadResult<()> {
        pending.identity.recheck()?;
        self.commit(pending)
    }

    fn commit(&mut self, pending: PendingPublisher) -> ReadResult<()> {
        match self.check(pending.clone()) {
            Ok(()) => Ok(()),
            Err(Some(_)) => {
                self.verified.insert(pending.generation, pending.identity);
                Ok(())
            }
            Err(None) => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn witness(generation: &str, micros: u64) -> PendingPublisher {
        PendingPublisher {
            generation: generation.into(),
            identity: Identity {
                pid: 123,
                start: (100, micros),
                legacy: json!({"version":1,
                "platform":"darwin","bootId":"boot","startId":"same-second"}),
            },
        }
    }

    #[test]
    fn same_second_pid_reuse_never_rebinds_a_verified_generation() {
        let mut bindings = Bindings::default();
        let original = witness("first", 1);
        bindings.commit(original.clone()).unwrap();
        assert!(bindings.check(original.clone()).is_ok());
        let reused = witness("first", 2);
        assert_eq!(bindings.check(reused.clone()), Err(None));
        assert!(bindings.commit(reused.clone()).is_err());
        bindings.commit(witness("second", 3)).unwrap();
        assert!(bindings.commit(reused).is_err());
        assert!(bindings.check(original).is_ok());
    }

    #[test]
    fn concurrent_pending_witness_cannot_replace_the_handshakes_process() {
        let mut bindings = Bindings::default();
        let first = witness("first", 1);
        let other = witness("first", 2);
        let captured = bindings.check(first.clone()).unwrap_err().unwrap();
        assert_eq!(bindings.check(other.clone()), Err(Some(other.clone())));
        bindings.commit(captured).unwrap();
        assert!(bindings.commit(other).is_err());
        assert!(bindings.check(first).is_ok());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn process_exit_between_handshake_and_promotion_cannot_bind() {
        let mut bindings = Bindings::default();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("10")
            .env_clear()
            .spawn()
            .unwrap();
        let identity = super::super::process_identity::identity(child.id() as u64).unwrap();
        let dead = PendingPublisher {
            generation: "gone".into(),
            identity,
        };
        let captured = bindings.check(dead.clone()).unwrap_err().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(bindings.verify(captured).is_err());
        assert_eq!(bindings.check(dead.clone()), Err(Some(dead)));
    }
}
