#![forbid(unsafe_code)]
mod codex_config;
mod manifest;
mod submission;
pub use codex_config::CodexProjectTrust;
pub use manifest::{
    InspectableArgument, InspectableContentPart, InspectableEnvironmentEntry,
    InspectableGeneratedFile, InspectableLaunchManifest, InspectableLaunchTarget,
    InspectableLimitation, InspectableProvenance, InspectableTransport,
};
use manifest::{
    ResolvedArgument, content_part, finalize_digest, provider_limitations, redacted_generated_file,
    transport,
};
use std::path::Path;
pub use submission::GeneratedTerminalSubmission;
const CODEX_DISABLE_STARTUP_UPDATE_CHECK: &str = "check_for_update_on_startup=false";
pub const CODEX_APP_SERVER_RUNTIME_PLACEHOLDER: &str = "termloop-runtime-authority";
include!("types.rs");
include!("request.rs");
include!("payload.rs");
include!("provider.rs");
include!("selection.rs");
include!("resolve.rs");
include!("environment.rs");
include!("arguments.rs");
include!("prompt.rs");
include!("policy.rs");

#[cfg(test)]
mod tests;
pub use manifest::content_digest;
