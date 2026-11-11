use super::geometry::{Camera, Rect};
use serde::{Deserialize, Serialize};

/// Diff geometry retains classic's x/y/w/h and laneId/title vocabulary. Classic's
/// v1 localStorage snapshot has no project isolation, order, pan or zoom to reuse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub lane_id: String,
    pub title: String,
    #[serde(flatten)]
    pub rect: Rect,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Layout {
    pub v: u32,
    pub camera: Camera,
    /// Back to front. Raising moves the card to the end, without growing a z index.
    pub diff: Vec<Card>,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            v: 1,
            camera: Camera::default(),
            diff: vec![],
        }
    }
}
impl Layout {
    pub fn restored(mut self) -> Self {
        if self.v != 1 {
            return Self::default();
        }
        self.camera = self.camera.bounded();
        let mut ids = std::collections::HashSet::new();
        self.diff
            .retain(|c| !c.lane_id.is_empty() && ids.insert(c.lane_id.clone()));
        self.diff.truncate(32);
        for c in &mut self.diff {
            c.rect = c.rect.bounded();
        }
        self
    }
    pub fn raise(&mut self, id: &str) {
        if let Some(i) = self.diff.iter().position(|c| c.lane_id == id) {
            let c = self.diff.remove(i);
            self.diff.push(c);
        }
    }
}
