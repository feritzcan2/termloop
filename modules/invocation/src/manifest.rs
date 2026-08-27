use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableLaunchManifest {
    pub digest: String,
    pub target: InspectableLaunchTarget,
    pub provenance: InspectableProvenance,
    pub content_parts: Vec<InspectableContentPart>,
    pub transport: InspectableTransport,
    pub arguments: Vec<InspectableArgument>,
    pub environment: Vec<InspectableEnvironmentEntry>,
    pub generated_files: Vec<InspectableGeneratedFile>,
    pub limitations: Vec<InspectableLimitation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableLaunchTarget {
    pub agent_id: String,
    pub executable: String,
    pub model: String,
    pub permission: String,
    pub reasoning: String,
    pub cwd: String,
    pub conversation: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableProvenance {
    pub template_ref: String,
    pub template_version: u32,
    pub authored_digest: String,
    pub delivered_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableContentPart {
    pub id: String,
    pub kind: &'static str,
    pub source: String,
    pub scope: &'static str,
    pub delivery: &'static str,
    pub content: String,
    pub byte_length: usize,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableTransport {
    pub kind: &'static str,
    pub delivered_content: String,
    pub byte_length: usize,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableArgument {
    pub position: usize,
    pub display: String,
    pub visibility: &'static str,
    pub classification: &'static str,
    pub purpose: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableEnvironmentEntry {
    pub key: String,
    pub display_value: String,
    pub visibility: &'static str,
    pub classification: &'static str,
    pub source: &'static str,
    pub purpose: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableGeneratedFile {
    pub purpose: String,
    pub delivery: String,
    pub lifecycle: String,
    pub content_visibility: &'static str,
    pub content_classification: &'static str,
    pub content: String,
    pub byte_length: usize,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InspectableLimitation {
    pub kind: &'static str,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArgumentVisibility {
    Exact,
    PrivateProviderIdentity,
    RuntimeAuthority,
    SensitivePath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedArgument {
    pub value: String,
    pub visibility: ArgumentVisibility,
    pub purpose: &'static str,
}

impl ResolvedArgument {
    pub(crate) fn exact(value: impl Into<String>, purpose: &'static str) -> Self {
        Self {
            value: value.into(),
            visibility: ArgumentVisibility::Exact,
            purpose,
        }
    }

    pub(crate) fn private(value: impl Into<String>, purpose: &'static str) -> Self {
        Self {
            value: value.into(),
            visibility: ArgumentVisibility::PrivateProviderIdentity,
            purpose,
        }
    }

    pub(crate) fn runtime_authority(value: impl Into<String>, purpose: &'static str) -> Self {
        Self {
            value: value.into(),
            visibility: ArgumentVisibility::RuntimeAuthority,
            purpose,
        }
    }

    pub(crate) fn sensitive_path(value: impl Into<String>, purpose: &'static str) -> Self {
        Self {
            value: value.into(),
            visibility: ArgumentVisibility::SensitivePath,
            purpose,
        }
    }

    pub(crate) fn inspect(&self, position: usize) -> InspectableArgument {
        let (display, visibility, classification) = match self.visibility {
            ArgumentVisibility::Exact => (self.value.clone(), "exact", "public"),
            ArgumentVisibility::PrivateProviderIdentity => (
                "<redacted private provider identity>".into(),
                "redacted",
                "privateProviderIdentity",
            ),
            ArgumentVisibility::RuntimeAuthority => (
                "<redacted runtime authority>".into(),
                "redacted",
                "runtimeAuthority",
            ),
            ArgumentVisibility::SensitivePath => (
                "<redacted Quick Action image path>".into(),
                "redacted",
                "sensitivePath",
            ),
        };
        InspectableArgument {
            position,
            display,
            visibility,
            classification,
            purpose: self.purpose,
        }
    }
}

pub(crate) fn content_part(
    id: impl Into<String>,
    kind: &'static str,
    source: impl Into<String>,
    delivery: &'static str,
    content: impl Into<String>,
) -> InspectableContentPart {
    let content = content.into();
    InspectableContentPart {
        id: id.into(),
        kind,
        source: source.into(),
        scope: "launch",
        delivery,
        byte_length: content.len(),
        digest: content_digest(&content),
        content,
    }
}

pub(crate) fn transport(kind: &'static str, content: impl Into<String>) -> InspectableTransport {
    let delivered_content = content.into();
    InspectableTransport {
        kind,
        byte_length: delivered_content.len(),
        digest: content_digest(&delivered_content),
        delivered_content,
    }
}

pub(crate) fn redacted_generated_file(
    purpose: impl Into<String>,
    delivery: impl Into<String>,
    lifecycle: impl Into<String>,
    inspectable_content: impl Into<String>,
    private_content: &str,
) -> InspectableGeneratedFile {
    let content = inspectable_content.into();
    InspectableGeneratedFile {
        purpose: purpose.into(),
        delivery: delivery.into(),
        lifecycle: lifecycle.into(),
        content_visibility: "redacted",
        content_classification: "sensitivePath",
        byte_length: private_content.len(),
        digest: content_digest(private_content),
        content,
    }
}

pub(crate) fn content_digest(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

pub(crate) fn finalize_digest(manifest: &mut InspectableLaunchManifest) {
    manifest.digest.clear();
    let canonical = serde_json::to_vec(manifest).expect("inspectable manifest serializes");
    manifest.digest = format!("sha256:{:x}", Sha256::digest(canonical));
}

pub(crate) fn provider_limitations(agent_id: &str) -> Vec<InspectableLimitation> {
    vec![
        InspectableLimitation {
            kind: "providerManaged",
            description: format!(
                "{agent_id} may apply a provider-managed system prompt that TermLoop cannot observe."
            ),
        },
        InspectableLimitation {
            kind: "providerDiscovered",
            description: format!(
                "{agent_id} may independently discover repository instructions after launch; those are not TermLoop-delivered content."
            ),
        },
    ]
}
