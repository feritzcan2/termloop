/// Claude pastes each image ahead of the prompt where the host keeps
/// bracketed-paste framing, so the authored prompt is delivered unchanged.
/// Only an unframed host falls back to the visible additional-directory
/// instruction.
fn compose_quick_action_delivery(
    agent_id: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
) -> String {
    if agent_id != "claude"
        || attachments.is_empty()
        || termloop_launch::pastes_image_attachments_natively(agent_id, attachments)
    {
        return prompt.to_owned();
    }
    format!("{prompt}{QUICK_ACTION_IMAGE_DIRECTORY_INSTRUCTION}")
}

const QUICK_ACTION_IMAGE_DIRECTORY_INSTRUCTION: &str = "\n\nTermLoop Quick Action image attachments: inspect `image.png` in each additional directory supplied for this launch.";
