//! Validation shared by the document receiver and the local read-only viewer.
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

fn permitted(path: &Path, data: &Path) -> bool {
    !path.starts_with(data)
        && !path.components().any(|part| {
            let name = part.as_os_str().to_string_lossy().to_ascii_lowercase();
            matches!(
                name.as_str(),
                ".git"
                    | ".docker"
                    | ".azure"
                    | ".kube"
                    | ".pypirc"
                    | ".o8"
                    | ".ssh"
                    | ".aws"
                    | ".gnupg"
                    | ".config"
                    | "keychains"
                    | "credentials"
                    | "credentials.json"
                    | ".git-credentials"
                    | ".netrc"
                    | ".npmrc"
                    | "auth.json"
                    | "tokens.json"
                    | "token"
                    | "authorized_keys"
                    | "o8.release.json"
                    | "ws-token"
                    | "id_rsa"
                    | "id_ed25519"
                    | "id_ecdsa"
                    | "id_dsa"
            ) || name == ".env"
                || name.starts_with(".env.")
                || name.ends_with(".pem")
                || name.ends_with(".key")
                || name.ends_with(".p12")
                || name.ends_with(".pfx")
                || name.ends_with(".jks")
        })
}
/// Canonicalize both boundaries, reject special files before opening (including
/// FIFOs), then use O_NOFOLLOW so a replaced final symlink cannot redirect a read.
pub fn open(path: &Path, data: &Path) -> io::Result<(PathBuf, File)> {
    let data = fs::canonicalize(data)?;
    if !permitted(path, &data) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let path = fs::canonicalize(path)?;
    if !permitted(&path, &data) || !fs::metadata(&path)?.is_file() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)?;
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    // A second name could hide a file from a denied directory.
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // Verify the descriptor's actual location too, including ancestor replacement.
    #[cfg(target_os = "macos")]
    {
        use std::{
            ffi::{CStr, OsStr},
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let mut actual = [0i8; libc::PATH_MAX as usize];
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, actual.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let actual = Path::new(OsStr::from_bytes(
            unsafe { CStr::from_ptr(actual.as_ptr()) }.to_bytes(),
        ));
        if actual != path || !permitted(actual, &data) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let actual = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        if actual != path || !permitted(&actual, &data) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok((path, file))
}

/// A folder to open as a project: an existing directory, outside the app's
/// data directory and the credential locations `permitted` refuses.
pub fn folder(path: &Path, data: &Path) -> io::Result<PathBuf> {
    let data = fs::canonicalize(data)?;
    if !permitted(path, &data) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let path = fs::canonicalize(path)?;
    if !permitted(&path, &data) || !fs::metadata(&path)?.is_dir() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_validation() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("open-folders-{}", std::process::id()));
        // Each level gets its mode explicitly: a test running beside this one
        // may change the process umask.
        for name in [
            "",
            "data",
            "data/inside",
            "repo",
            ".ssh",
            ".ssh/keys",
            "repo/.git",
        ] {
            let dir = root.join(name);
            let _ = fs::create_dir(&dir);
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(root.join("guide.md"), "# Guide").unwrap();
        let data = root.join("data");
        assert_eq!(
            folder(&root.join("repo"), &data).unwrap(),
            fs::canonicalize(root.join("repo")).unwrap()
        );
        for name in [
            "data",
            "data/inside",
            ".ssh",
            ".ssh/keys",
            "repo/.git",
            "guide.md",
            "missing",
        ] {
            assert!(folder(&root.join(name), &data).is_err(), "{name}");
        }
        std::os::unix::fs::symlink(root.join(".ssh"), root.join("alias")).unwrap();
        assert!(folder(&root.join("alias"), &data).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn document_validation() {
        let root = std::env::temp_dir().join(format!("open-documents-{}", std::process::id()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("guide.md"), "# Guide").unwrap();
        fs::write(root.join("data/private.md"), "private").unwrap();
        fs::write(root.join(".env"), "private").unwrap();
        assert!(open(&root.join("guide.md"), &root.join("data")).is_ok());
        for name in ["data", "data/private.md", ".env", "missing"] {
            assert!(open(&root.join(name), &root.join("data")).is_err());
        }
        std::os::unix::fs::symlink(root.join("data/private.md"), root.join("alias.md")).unwrap();
        assert!(open(&root.join("alias.md"), &root.join("data")).is_err());
        fs::hard_link(root.join("data/private.md"), root.join("hard-alias.md")).unwrap();
        assert!(open(&root.join("hard-alias.md"), &root.join("data")).is_err());
        use std::os::unix::fs::PermissionsExt;
        fs::write(root.join("unreadable.txt"), "private").unwrap();
        fs::set_permissions(root.join("unreadable.txt"), fs::Permissions::from_mode(0)).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert!(open(&root.join("unreadable.txt"), &root.join("data")).is_err());
        }
        let fifo = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(open(&root.join("pipe"), &root.join("data")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
