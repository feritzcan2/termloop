#[derive(Clone)]
pub struct TerminalPrompt {
    provenance: Provenance,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
    terminal_input_sequence: Vec<Vec<u8>>,
}

impl std::fmt::Debug for TerminalPrompt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalPrompt")
            .field("provenance", &self.provenance)
            .field(
                "binding_names",
                &self
                    .bindings
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("delivered_byte_count", &self.delivered_prompt.len())
            .finish()
    }
}

impl TerminalPrompt {
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    pub fn bindings(&self) -> impl Iterator<Item = (&str, &str)> {
        self.bindings
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    pub fn delivered_prompt(&self) -> &str {
        &self.delivered_prompt
    }

    pub fn terminal_input_sequence(&self) -> &[Vec<u8>] {
        &self.terminal_input_sequence
    }

    pub fn terminal_submission(&self) -> GeneratedTerminalSubmission {
        GeneratedTerminalSubmission::from_sequence(
            self.provenance.clone(),
            &self.terminal_input_sequence,
        )
    }
}

pub fn terminal_prompt(
    template: &PromptTemplate,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
) -> Result<TerminalPrompt, InvocationError> {
    if template.id.trim().is_empty() || template.version == 0 {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    // Agent TUIs can keep Return in multiline-edit mode when it arrives in the
    // same input burst as a paste. Preview and submitted bytes use the same
    // trimmed delivered form, while the submit key remains a delayed second
    // chunk inside one non-interleavable terminal request.
    let delivered_prompt = delivered_prompt.trim_end().to_owned();
    let terminal_input_sequence = termloop_platform::generated_terminal_paste_submission_sequence(
        delivered_prompt.as_bytes(),
    )
    .map_err(|_| InvocationError::InvalidPromptBinding)?;
    Ok(TerminalPrompt {
        provenance: Provenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
        },
        bindings,
        delivered_prompt,
        terminal_input_sequence,
    })
}

pub fn bind_ordered(authored: &str, bindings: &[(&str, &str)]) -> Result<String, InvocationError> {
    let mut remaining = authored;
    let mut delivered = String::with_capacity(
        authored.len() + bindings.iter().map(|(_, value)| value.len()).sum::<usize>(),
    );
    for (name, value) in bindings {
        let marker = format!("{{{{{name}}}}}");
        let (before, after) = remaining
            .split_once(&marker)
            .ok_or(InvocationError::InvalidPromptBinding)?;
        if before.contains("{{") || before.contains("}}") || after.contains(&marker) {
            return Err(InvocationError::InvalidPromptBinding);
        }
        delivered.push_str(before);
        delivered.push_str(value);
        remaining = after;
    }
    if remaining.contains("{{") || remaining.contains("}}") {
        return Err(InvocationError::InvalidPromptBinding);
    }
    delivered.push_str(remaining);
    Ok(delivered)
}

pub fn generated_submission(template: &PromptTemplate, content: &str) -> Result<GeneratedTerminalSubmission, InvocationError> {
    if template.id.trim().is_empty() || template.version == 0 {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    let sequence = termloop_platform::generated_terminal_paste_submission_sequence(content.as_bytes())
        .map_err(|_| InvocationError::InvalidPromptBinding)?;
    Ok(GeneratedTerminalSubmission::from_sequence(Provenance {
        template_ref: template.id.into(), template_version: template.version,
    }, &sequence))
}
