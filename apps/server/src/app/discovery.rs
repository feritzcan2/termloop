use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use termloop_contract::current::CONTRACT_IDENTITY;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryRecord<'a> {
    protocol_version: &'a str,
    control_url: String,
    terminal_url: String,
    token: &'a str,
    terminal_token: &'a str,
    read_only_token: &'a str,
    pid: u32,
}

pub(super) fn write(
    runtime_directory: &Path,
    address: SocketAddr,
    token: &str,
    terminal_token: &str,
    read_only_token: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let discovery_path = runtime_directory.join("runtime.json");
    let record = DiscoveryRecord {
        protocol_version: CONTRACT_IDENTITY,
        control_url: format!("ws://{address}/control"),
        terminal_url: format!("ws://{address}/terminal"),
        token,
        terminal_token,
        read_only_token,
        pid: std::process::id(),
    };
    termloop_platform::write_private_file(&discovery_path, &serde_json::to_vec_pretty(&record)?)?;
    Ok(discovery_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_discovery_never_contains_the_companion_child_credential() {
        let root = std::env::temp_dir().join(format!(
            "termloop-discovery-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = write(
            &root,
            "127.0.0.1:1234".parse().unwrap(),
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
        )
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(value.get("companionToken").is_none());
        assert_eq!(value["token"], "a".repeat(64));
        let _ = std::fs::remove_dir_all(root);
    }
}
