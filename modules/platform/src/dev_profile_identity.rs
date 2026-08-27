use std::path::Path;

pub(crate) fn development_profile_id(checkout: &Path) -> String {
    let label = checkout
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_label)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "checkout".to_owned());
    let identity = checkout.to_string_lossy();
    format!("{label}-{:016x}", fnv1a64(identity.as_bytes()))
}

fn sanitize_label(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

#[cfg(test)]
mod tests {
    use super::development_profile_id;
    use std::path::Path;

    #[test]
    fn profile_identity_is_branch_independent_and_path_specific() {
        assert_eq!(
            development_profile_id(Path::new("/workspace/.termloop-worktrees/Feature One")),
            "feature-one-d11a2c6789ce1964"
        );
        assert_ne!(
            development_profile_id(Path::new("/workspace/.termloop-worktrees/feature-one")),
            development_profile_id(Path::new("/other/.termloop-worktrees/feature-one"))
        );
    }
}
