fn compose_quick_action_delivery(
    agent_id: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
) -> String {
    if agent_id != "claude" || attachments.is_empty() {
        return prompt.to_owned();
    }
    let mut delivered = String::with_capacity(
        prompt.len()
            + attachments
                .iter()
                .map(|attachment| attachment.file_path.len() + 4)
                .sum::<usize>()
            + 52,
    );
    delivered.push_str(prompt);
    delivered.push_str(
        "\n\nTermLoop Quick Action image attachment: inspect `image.png` in the additional directory supplied for this launch.",
    );
    delivered
}
