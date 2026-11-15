//! A fake speech helper for tests: a bash script speaking the helper's
//! stdin/stdout protocol. Environment variables shape what it says:
//! `FAKE_FINAL` (Apple's final text), `FAKE_AUDIO` (a WAV path it writes and
//! reports), `FAKE_BOOT` (a line before ready), `FAKE_LOG` (a file it appends
//! each stdin line to) and `FAKE_MODE`.
use super::Launch;
use std::path::PathBuf;

const FAKE_HELPER: &str = r#"
emit() { printf '%s\n' "$1"; }
[ -n "$FAKE_BOOT" ] && emit "$FAKE_BOOT"
if [ "$FAKE_MODE" = speech-denied ]; then exit 1; fi
if [ "$FAKE_MODE" = late-ready ]; then
  # The real helper refuses a start that arrives before it is ready.
  if IFS= read -r -t 1 early; then
    emit "{\"type\":\"error\",\"text\":\"Audio engine not prepared.\",\"session_id\":${early#start:}}"
  fi
fi
emit '{"type":"ready","text":""}'
while IFS= read -r line; do
  [ -n "$FAKE_LOG" ] && printf '%s\n' "$line" >> "$FAKE_LOG"
  case "$line" in
    start:*) id=${line#start:}
      if [ "$FAKE_MODE" = exit-once ] && [ ! -e "$FAKE_MARK" ]; then : > "$FAKE_MARK"; exit 3; fi
      emit "{\"type\":\"status\",\"text\":\"listening\",\"session_id\":$id}"
      emit "{\"type\":\"level\",\"text\":\"0.500\",\"session_id\":$id}"
      emit "{\"type\":\"partial\",\"text\":\"hello\",\"session_id\":$id}"
      emit "{\"type\":\"partial\",\"text\":\"hello\",\"session_id\":$id}"
      emit "{\"type\":\"partial\",\"text\":\"hello world\",\"session_id\":$id}"
      if [ "$FAKE_MODE" = early-complete ]; then
        emit "{\"type\":\"complete\",\"text\":\"\",\"session_id\":$id}"
      fi ;;
    stop:*) id=${line#stop:}
      [ "$FAKE_MODE" = silent-stop ] && continue
      emit '{"type":"ready","text":""}'
      [ -n "$FAKE_FINAL" ] && emit "{\"type\":\"final\",\"text\":\"$FAKE_FINAL\",\"session_id\":$id}"
      if [ -n "$FAKE_AUDIO" ]; then
        printf 'RIFF' > "$FAKE_AUDIO"
        emit "{\"type\":\"audio_file\",\"text\":\"$FAKE_AUDIO\",\"session_id\":$id}"
      fi
      emit "{\"type\":\"complete\",\"text\":\"\",\"session_id\":$id}" ;;
    quit) exit 0 ;;
  esac
done
"#;

/// A scratch directory holding the fake helper; removed on drop.
pub(crate) struct Fake {
    pub dir: PathBuf,
}

impl Fake {
    pub(crate) fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("o8-speech-{name}-{nanos:x}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("helper.sh"), FAKE_HELPER).unwrap();
        Self { dir }
    }
    pub(crate) fn wav(&self) -> PathBuf {
        self.dir.join("o8_dictation_1_test.wav")
    }
    pub(crate) fn launch(&self, env: &[(&str, &str)]) -> Launch {
        Launch {
            program: "bash".into(),
            args: vec![self.dir.join("helper.sh").into()],
            envs: env
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
            data: None,
        }
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
