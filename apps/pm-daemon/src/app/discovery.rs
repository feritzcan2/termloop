//! The private discovery file a local client reads to reach this daemon run.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use termloop_pm_contract::pm::{CAPABILITY_SCOPE, CONTRACT_IDENTITY};

pub(crate) const DISCOVERY_FILE: &str = "discovery.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryRecord<'a> {
    protocol_version: &'a str,
    control_url: String,
    terminal_url: String,
    /// The one bearer of this run, for the control and terminal planes.
    token: &'a str,
    scope: &'a str,
    /// The terminal epoch every PM agent session of this run carries.
    runtime_epoch: u64,
    pid: u32,
}

/// Writes `<daemon directory>/discovery.json` with owner-only permissions.
pub(crate) fn write(
    daemon_directory: &Path,
    address: SocketAddr,
    token: &str,
    runtime_epoch: u64,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = daemon_directory.join(DISCOVERY_FILE);
    let record = DiscoveryRecord {
        protocol_version: CONTRACT_IDENTITY,
        control_url: format!("ws://{address}/control"),
        terminal_url: format!("ws://{address}/terminal"),
        token,
        scope: CAPABILITY_SCOPE,
        runtime_epoch,
        pid: std::process::id(),
    };
    termloop_platform::write_private_file(&path, &serde_json::to_vec_pretty(&record)?)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_names_both_planes_and_the_single_bearer() {
        let root = std::env::temp_dir().join(format!(
            "termloop-pm-discovery-{}",
            termloop_platform::generate_uuid_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = write(&root, "127.0.0.1:4100".parse().unwrap(), &"a".repeat(64), 7).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["controlUrl"], "ws://127.0.0.1:4100/control");
        assert_eq!(value["terminalUrl"], "ws://127.0.0.1:4100/terminal");
        assert_eq!(value["token"], "a".repeat(64));
        assert_eq!(value["scope"], "pm.full");
        assert_eq!(value["runtimeEpoch"], 7);
        let _ = std::fs::remove_dir_all(root);
    }
}
