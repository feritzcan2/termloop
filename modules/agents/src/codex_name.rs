use serde_json::Value;
use termloop_domain::ResumeRef;

#[derive(Clone, PartialEq, Eq)]
pub struct CodexThreadNameObservation {
    pub native_thread_id: String,
    pub name: Option<String>,
}

impl std::fmt::Debug for CodexThreadNameObservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexThreadNameObservation")
            .field("native_thread_id", &"<private>")
            .field("name", &self.name)
            .finish()
    }
}

// Reuse the bridge's parsed notification. Ordinary output incurs only a method
// lookup, with no additional JSON parse, string scan, allocation, or event.
pub(crate) fn normalize_codex_thread_name(message: &Value) -> Option<CodexThreadNameObservation> {
    if message.get("method")?.as_str()? != "thread/name/updated" {
        return None;
    }
    let params = message.get("params")?;
    let native_thread_id = params.get("threadId")?.as_str()?;
    if native_thread_id.is_empty()
        || native_thread_id.len() > ResumeRef::MAX_NATIVE_ID_BYTES
        || native_thread_id.chars().any(char::is_control)
    {
        return None;
    }
    let name = match params.get("threadName") {
        // Codex omits the optional field when the thread name is cleared.
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => {
            if name.len() > 4096 {
                return None;
            }
            let name = name.trim();
            if name.chars().any(char::is_control) {
                return None;
            }
            (!name.is_empty()).then(|| {
                let mut bounded: String = name.chars().take(80).collect();
                bounded.truncate(bounded.trim_end().len());
                bounded
            })
        }
        _ => return None,
    };
    Some(CodexThreadNameObservation {
        native_thread_id: native_thread_id.to_owned(),
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn notification(name: Value) -> Value {
        json!({"method": "thread/name/updated", "params": {
            "threadId": "thread-a", "threadName": name
        }})
    }

    #[test]
    fn names_are_trimmed_and_bounded_without_splitting_unicode() {
        let observed =
            normalize_codex_thread_name(&notification(json!("  steward için 🦀  "))).unwrap();
        assert_eq!(observed.native_thread_id, "thread-a");
        assert_eq!(observed.name.as_deref(), Some("steward için 🦀"));
        assert_eq!(
            normalize_codex_thread_name(&notification(json!("🦀".repeat(81))))
                .unwrap()
                .name,
            Some("🦀".repeat(80))
        );
        assert_eq!(
            normalize_codex_thread_name(&notification(json!(format!("{} next", "x".repeat(79)))))
                .unwrap()
                .name,
            Some("x".repeat(79))
        );
    }

    #[test]
    fn optional_or_blank_names_clear_the_label() {
        for name in [Value::Null, json!(" \t ")] {
            assert_eq!(
                normalize_codex_thread_name(&notification(name))
                    .unwrap()
                    .name,
                None
            );
        }
        let mut message = notification(Value::Null);
        message["params"]
            .as_object_mut()
            .unwrap()
            .remove("threadName");
        assert_eq!(normalize_codex_thread_name(&message).unwrap().name, None);
    }

    #[test]
    fn unrelated_messages_and_invalid_names_or_identities_are_ignored() {
        for name in [
            json!(42),
            json!({}),
            json!("bad\nname"),
            json!("bad\u{1b}name"),
            json!("x".repeat(4097)),
        ] {
            assert!(normalize_codex_thread_name(&notification(name)).is_none());
        }
        for id in [
            json!(null),
            json!(""),
            json!("bad\nthread"),
            json!("x".repeat(ResumeRef::MAX_NATIVE_ID_BYTES + 1)),
        ] {
            let mut message = notification(json!("Build API"));
            message["params"]["threadId"] = id;
            assert!(normalize_codex_thread_name(&message).is_none());
        }
        let mut message = notification(json!("Build API"));
        message["method"] = json!("item/agentMessage/delta");
        assert!(normalize_codex_thread_name(&message).is_none());
        assert!(normalize_codex_thread_name(&json!({})).is_none());
    }
}
