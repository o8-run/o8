//! Native child's bounded request to the same-user launcher control socket.
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::Duration,
};
pub fn receive(data: &Path) -> io::Result<Vec<PathBuf>> {
    let mut peer = UnixStream::connect(data.join("launcher.sock"))?;
    peer.set_read_timeout(Some(Duration::from_secs(1)))?;
    peer.set_write_timeout(Some(Duration::from_secs(1)))?;
    peer.write_all(b"{\"op\":\"take-open-files\"}")?;
    peer.shutdown(std::net::Shutdown::Write)?;
    let mut bytes = Vec::new();
    peer.take(262145).read_to_end(&mut bytes)?;
    if bytes.len() > 262144 {
        return Err(io::Error::other("Oversized document response"));
    }
    let frame: serde_json::Value = serde_json::from_slice(&bytes)?;
    let paths = frame["paths"]
        .as_array()
        .ok_or_else(|| io::Error::other("Invalid document response"))?;
    Ok(paths
        .iter()
        .take(32)
        .filter_map(|p| p.as_str().map(PathBuf::from))
        .collect())
}
