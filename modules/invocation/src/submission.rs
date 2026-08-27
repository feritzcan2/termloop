use crate::Provenance;

/// One immutable invocation-composed terminal submission. Platform framing and
/// the submit key are fixed before this value leaves invocation; delivery
/// coordinators may sequence these two parts but cannot append or recompose
/// generated content.
#[derive(Clone)]
pub struct GeneratedTerminalSubmission {
    provenance: Provenance,
    paste_input: Vec<u8>,
    submit_input: Vec<u8>,
}

impl GeneratedTerminalSubmission {
    pub(crate) fn from_sequence(provenance: Provenance, sequence: &[Vec<u8>]) -> Self {
        let [paste_input, submit_input] = sequence else {
            unreachable!("invocation terminal submissions always have paste and submit parts")
        };
        debug_assert!(!paste_input.is_empty());
        debug_assert_eq!(submit_input.as_slice(), b"\r");
        Self {
            provenance,
            paste_input: paste_input.clone(),
            submit_input: submit_input.clone(),
        }
    }

    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    pub fn paste_input(&self) -> &[u8] {
        &self.paste_input
    }

    pub fn submit_input(&self) -> &[u8] {
        &self.submit_input
    }

    pub fn input_parts(&self) -> [&[u8]; 2] {
        [&self.paste_input, &self.submit_input]
    }

    pub fn delivered_byte_count(&self) -> usize {
        self.paste_input
            .len()
            .saturating_add(self.submit_input.len())
    }
}

impl std::fmt::Debug for GeneratedTerminalSubmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GeneratedTerminalSubmission")
            .field("provenance", &self.provenance)
            .field("delivered_byte_count", &self.delivered_byte_count())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_contains_provenance_but_not_prompt_content() {
        let submission = GeneratedTerminalSubmission::from_sequence(
            Provenance {
                template_ref: "builtin.test".into(),
                template_version: 1,
            },
            &[b"private prompt".to_vec(), b"\r".to_vec()],
        );

        let debug = format!("{submission:?}");
        assert!(debug.contains("builtin.test"));
        assert!(!debug.contains("private prompt"));
    }
}
