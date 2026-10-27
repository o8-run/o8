//! PCM helpers: the 16 kHz mono format every o8 speech path uses.

use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: u32 = 16_000;

/// Decode little-endian `f32` PCM (the `--audio-fifo` and recorder format).
/// A trailing partial sample is returned so the caller can prepend it to the
/// next read.
pub fn decode_f32le(bytes: &[u8]) -> (Vec<f32>, &[u8]) {
    let whole = bytes.len() / 4 * 4;
    let samples = bytes[..whole]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .map(|s| {
            if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        })
        .collect();
    (samples, &bytes[whole..])
}

/// Meter level in 0..=1, using the Swift helper's scale (`rms / 0.12`).
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    ((sum / samples.len() as f32).sqrt() / 0.12).min(1.0)
}

/// Write 16 kHz mono 16-bit PCM, the format the Swift helper emits as
/// `audio_file` and that the Whisper and polish passes consume.
pub fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        writer
            .write_sample(v)
            .map_err(|e| format!("write wav: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("finalize wav: {e}"))
}

/// The per-session WAV path, named like the Swift helper's
/// (`o8_dictation_<session>_<unique>.wav` in the temp dir).
pub fn session_wav_path(dir: &Path, session_id: u64) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    dir.join(format!(
        "o8_dictation_{session_id}_{}-{nanos}.wav",
        std::process::id()
    ))
}

/// Read any PCM WAV and convert it to 16 kHz mono `f32`.
pub fn read_wav_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read wav: {e}"))?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample.max(1) - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|e| format!("read wav: {e}"))?
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok(resample_linear(&mono, spec.sample_rate, SAMPLE_RATE))
}

/// Linear-interpolation resampler. Adequate for speech recognition input.
pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos as usize;
            let frac = (pos - idx as f64) as f32;
            let a = input[idx];
            let b = *input.get(idx + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::TempDir;

    #[test]
    fn decodes_f32le_and_keeps_the_partial_tail() {
        let mut bytes = Vec::new();
        for s in [0.5f32, -0.25, 2.0] {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        bytes.extend_from_slice(&[1, 2]);
        let (samples, tail) = decode_f32le(&bytes);
        assert_eq!(samples, vec![0.5, -0.25, 1.0]);
        assert_eq!(tail, &[1, 2]);
    }

    #[test]
    fn level_matches_the_swift_scale() {
        assert_eq!(level(&[]), 0.0);
        assert!((level(&[0.06; 160]) - 0.5).abs() < 1e-4);
        assert_eq!(level(&[0.9; 160]), 1.0);
    }

    #[test]
    fn wav_round_trips_at_16k_mono() {
        let dir = TempDir::new("wav");
        let path = dir.path().join("a.wav");
        let samples: Vec<f32> = (0..1600).map(|i| (i as f32 / 50.0).sin() * 0.5).collect();
        write_wav(&path, &samples).unwrap();
        let spec = hound::WavReader::open(&path).unwrap().spec();
        assert_eq!(
            (spec.channels, spec.sample_rate, spec.bits_per_sample),
            (1, 16_000, 16)
        );
        let back = read_wav_16k_mono(&path).unwrap();
        assert_eq!(back.len(), samples.len());
        assert!(back.iter().zip(&samples).all(|(a, b)| (a - b).abs() < 1e-3));
    }

    #[test]
    fn resamples_and_downmixes_other_formats() {
        let dir = TempDir::new("wav-22k");
        let path = dir.path().join("b.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 22_050,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..22_050 {
            w.write_sample(i16::MAX / 2).unwrap();
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
        let out = read_wav_16k_mono(&path).unwrap();
        assert_eq!(out.len(), 16_000);
        assert!((out[100] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn session_wav_names_follow_the_swift_pattern() {
        let p = session_wav_path(Path::new("/tmp"), 9);
        let name = p.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("o8_dictation_9_") && name.ends_with(".wav"));
    }
}
