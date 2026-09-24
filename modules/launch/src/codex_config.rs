#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexProjectTrust {
    Inherit,
    ManagedWorkspace,
}

pub(super) fn project_trust_override(
    cwd: &str,
    trust: CodexProjectTrust,
) -> Result<Option<String>, serde_json::Error> {
    if trust == CodexProjectTrust::Inherit {
        return Ok(None);
    }

    let quoted_path = serde_json::to_string(cwd)?;
    Ok(Some(
        ["projects={", &quoted_path, "={trust_level=\"trusted\"}}"].concat(),
    ))
}
