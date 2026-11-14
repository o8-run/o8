//! Existing shell identity and port-file formats.
pub fn random_uuid_v4() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes[..8].copy_from_slice(&(now as u64).to_be_bytes());
        bytes[8..12].copy_from_slice(&std::process::id().to_be_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

#[derive(Clone, Debug)]
pub struct BootIdentity {
    pub boot_id: String,
    pub instance_id: String,
}

pub fn read_or_create_boot_identity(dir: &str) -> BootIdentity {
    let _ = std::fs::create_dir_all(&dir);
    let instance_path = format!("{}/instance-id", dir);
    let instance_id = std::fs::read_to_string(&instance_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let id = random_uuid_v4();
            let _ = std::fs::write(&instance_path, &id);
            id
        });
    let boot_id = random_uuid_v4();
    let _ = std::fs::write(format!("{}/boot-id", dir), &boot_id);
    BootIdentity {
        boot_id,
        instance_id,
    }
}

pub fn write_port_file(dir: &str, name: &str, port: u16) -> std::io::Result<()> {
    let _ = std::fs::create_dir_all(&dir);
    let path = format!("{}/{}", dir, name);
    std::fs::write(path, port.to_string())
}
