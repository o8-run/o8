//! This surface has only authenticated GET requests.
use super::{guard, source::Source};
use crate::client::Client;
use serde_json::Value;
pub(crate) struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}
pub(crate) enum ReadError {
    TooLarge,
    Unavailable,
}
pub(crate) fn read(client: &Client, workspace: &str, path: &str) -> Result<Source, ReadError> {
    let url = client
        .url("/api/panel/file-content")
        .map_err(|_| ReadError::Unavailable)?;
    let response = client
        .request("GET", &url)
        .query("path", path)
        .query("workspace", workspace)
        .query("preview", "1")
        .call();
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(413, _)) => return Err(ReadError::TooLarge),
        Err(_) => return Err(ReadError::Unavailable),
    };
    let data: Value = Client::read(response).map_err(|_| ReadError::Unavailable)?;
    let content = data["content"].as_str().ok_or(ReadError::Unavailable)?;
    Ok(Source::new(
        path,
        content,
        data["binary"] == true,
        data["truncated"] == true,
    ))
}
pub(crate) fn entries(
    client: &Client,
    workspace: &str,
    directory: &str,
) -> Result<Vec<Entry>, String> {
    let data = client.get::<Value>(
        "/api/panel/files",
        &[("workspace", workspace), ("directory", directory)],
    )?;
    let values = data["entries"].as_array().ok_or("Could not read folder")?;
    Ok(values
        .iter()
        .take(10_000)
        .filter_map(|entry| {
            let name = entry["name"].as_str()?;
            let path = entry["path"].as_str()?;
            if guard::sensitive(name) || guard::sensitive(path) {
                return None;
            }
            Some(Entry {
                name: name.into(),
                path: path.into(),
                directory: entry["kind"] == "directory",
            })
        })
        .collect())
}
