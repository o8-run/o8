//! GTK-free snapshot wire types and display policy shared by both binaries.
use super::protocol::{MAX_HEIGHT, MIN_HEIGHT, Message, UNAVAILABLE, message, valid_state};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const TIMEOUT: Duration = Duration::from_secs(12);
pub const TIMEOUT_ERROR: &str = "The visualization did not finish loading. Try again.";
pub const MAX_INPUT: u64 = 16 * 1024 * 1024;
pub const MAX_OUTPUT: u64 = 32 * 1024 * 1024;
pub const MAX_WIDTH: u32 = 1600;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub document: String,
    pub nonce: String,
    pub width: u32,
    pub height: f64,
    pub theme: Value,
    pub state: Value,
}
impl Request {
    pub fn valid(&self) -> bool {
        !self.document.is_empty()
            && self.document.len() <= 12 * 1024 * 1024
            && (1..=MAX_WIDTH).contains(&self.width)
            && self.height.is_finite()
            && (MIN_HEIGHT..=MAX_HEIGHT).contains(&self.height)
            && (16..=128).contains(&self.nonce.len())
            && self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && self.theme.to_string().len() <= 16 * 1024
            && valid_state(&self.state)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub height: f64,
    pub state: Option<Value>,
    pub png: String,
}
impl Response {
    pub fn picture(&self, width: u32) -> Result<Vec<u8>, String> {
        if !self.height.is_finite()
            || self.height.fract() != 0.
            || !(MIN_HEIGHT..=MAX_HEIGHT).contains(&self.height)
            || self.state.as_ref().is_some_and(|s| !valid_state(s))
        {
            return Err(UNAVAILABLE.into());
        }
        let png = STANDARD.decode(&self.png).map_err(|_| UNAVAILABLE)?;
        if png.len() < 24
            || &png[..16] != b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"
            || u32::from_be_bytes(png[16..20].try_into().unwrap()) != width
            || u32::from_be_bytes(png[20..24].try_into().unwrap()) != self.height as u32
        {
            return Err(UNAVAILABLE.into());
        }
        Ok(png)
    }
}

#[derive(Default)]
pub(super) struct Navigation {
    initial: bool,
    bootstrap: bool,
    inner: bool,
}
impl Navigation {
    pub(super) fn new() -> Self {
        Self {
            initial: true,
            bootstrap: true,
            inner: true,
        }
    }
    pub(super) fn allow(&mut self, uri: &str, other: bool, redirect: bool) -> bool {
        if !other || redirect {
            return false;
        }
        if self.initial && uri == "about:blank" {
            self.initial = false;
            true
        } else if !self.initial && self.bootstrap && self.inner && uri == "about:blank" {
            self.bootstrap = false;
            true
        } else if !self.initial && self.inner && uri == "about:srcdoc" {
            self.inner = false;
            self.bootstrap = false;
            true
        } else {
            false
        }
    }
    pub(super) fn close(&mut self) {
        *self = Self::default();
    }
}
pub(super) fn parse(input: &str, nonce: &str) -> Option<Message> {
    if input.len() > 24 * 1024 {
        return None;
    }
    message(&serde_json::from_str::<Value>(input).ok()?, nonce)
}
