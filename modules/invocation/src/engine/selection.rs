pub fn validate_quick_action(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
) -> Result<(), InvocationError> {
    if prompt.is_empty()
        || prompt.chars().count() > 32_768
        || prompt
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPrompt);
    }
    validate_agent_configuration(agent_id, model, permission, reasoning)
}

pub fn validate_quick_action_with_attachments(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
) -> Result<(), InvocationError> {
    validate_quick_action(agent_id, model, permission, reasoning, prompt)?;
    validate_image_attachments(attachments)
}

pub fn validate_image_attachments(
    attachments: &[QuickActionImageAttachment],
) -> Result<(), InvocationError> {
    if attachments.len() > 1 {
        return Err(InvocationError::InvalidImageAttachment);
    }
    for attachment in attachments {
        let path = Path::new(&attachment.file_path);
        let id = attachment.attachment_id.as_bytes();
        let valid_id = id.len() == 36
            && [8, 13, 18, 23].into_iter().all(|index| id[index] == b'-')
            && id[14] == b'4'
            && matches!(id[19], b'8' | b'9' | b'a' | b'b')
            && id.iter().enumerate().all(|(index, byte)| {
                [8, 13, 18, 23].contains(&index)
                    || (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            });
        let valid_digest = attachment.sha256.len() == 71
            && attachment.sha256.starts_with("sha256:")
            && attachment.sha256[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
        if !valid_id
            || attachment.media_type != "image/png"
            || attachment.byte_length == 0
            || attachment.byte_length > 10 * 1024 * 1024
            || attachment.width == 0
            || attachment.width > 16_384
            || attachment.height == 0
            || attachment.height > 16_384
            || !valid_digest
            || !path.is_absolute()
            || path.file_name().and_then(|name| name.to_str()) != Some("image.png")
            || path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some(attachment.attachment_id.as_str())
            || path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("termloop-quick-action-images")
        {
            return Err(InvocationError::InvalidImageAttachment);
        }
    }
    Ok(())
}

/// Encodes one user-initiated image paste as a provider-neutral remote file
/// reference without a submit key. The path is serialized as a JSON string so
/// spaces, quotes, and platform separators remain unambiguous to every Agent
/// composer while the user continues typing the accompanying instruction.
pub fn image_attachment_terminal_paste(
    attachment: &QuickActionImageAttachment,
) -> Result<Vec<u8>, InvocationError> {
    validate_image_attachments(std::slice::from_ref(attachment))?;
    let mut reference = serde_json::to_string(&attachment.file_path)
        .map_err(|_| InvocationError::InvalidImageAttachment)?;
    reference.push(' ');
    Ok(termloop_platform::terminal_paste_input(
        reference.as_bytes(),
    ))
}

/// TermLoop's own default permission mode for an unconfigured launch. Claude's
/// provider `default` mode asks before every edit, so a Session that nobody
/// configured used to open in manual permission mode and lost an in-session
/// switch on every resume. TermLoop launches Claude in auto (accept-edits)
/// mode instead, visibly and identically on fresh launch and resume.
pub fn default_permission(agent_id: &str) -> &'static str {
    match agent_id {
        "claude" => "acceptEdits",
        _ => "default",
    }
}
