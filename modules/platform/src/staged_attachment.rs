use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{PlatformError, read_bounded_file, remove_file_if_present, write_private_file};

// Keep the launch-facing shape identical to the desktop draft store. Invocation
// accepts only this owned directory name plus UUID/image.png beneath it.
const ATTACHMENTS_DIRECTORY: &str = "termloop-quick-action-images";
const IMAGE_FILE: &str = "image.png";
const METADATA_FILE: &str = "attachment.json";
const METADATA_LIMIT: usize = 16 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedImageAttachment {
    pub version: u8,
    pub attachment_id: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub width: u64,
    pub height: u64,
    pub created_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStagedImageAttachment {
    pub metadata: StagedImageAttachment,
    pub file_path: PathBuf,
}

pub fn write_staged_image_attachment(
    state_directory: &Path,
    metadata: &StagedImageAttachment,
    bytes: &[u8],
) -> Result<ResolvedStagedImageAttachment, PlatformError> {
    validate_metadata(metadata)?;
    if !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
        || png_dimensions(bytes) != Some((metadata.width as u32, metadata.height as u32))
        || bytes.len() as u64 != metadata.byte_length
        || digest(bytes) != metadata.sha256
    {
        return Err(invalid_data(
            "uploaded attachment metadata does not match its bytes",
        ));
    }
    let root = attachments_root(state_directory, true)?;
    let directory = root.join(&metadata.attachment_id);
    fs::create_dir(&directory)?;
    let file_path = directory.join(IMAGE_FILE);
    let metadata_path = directory.join(METADATA_FILE);
    if fs::symlink_metadata(&file_path).is_ok() || fs::symlink_metadata(&metadata_path).is_ok() {
        return Err(invalid_data("attachment identifier already exists"));
    }
    if let Err(error) = write_private_file(&file_path, bytes) {
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    let metadata_bytes =
        serde_json::to_vec_pretty(metadata).map_err(|error| invalid_data(&error.to_string()))?;
    if let Err(error) = write_private_file(&metadata_path, &metadata_bytes) {
        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    Ok(ResolvedStagedImageAttachment {
        metadata: metadata.clone(),
        file_path,
    })
}

pub fn read_staged_image_attachment(
    state_directory: &Path,
    attachment_id: &str,
) -> Result<ResolvedStagedImageAttachment, PlatformError> {
    let (directory, metadata) = read_staged_attachment_metadata(state_directory, attachment_id)?;
    let file_path = directory.join(IMAGE_FILE);
    let file_metadata = fs::symlink_metadata(&file_path)?;
    if !file_metadata.is_file()
        || file_metadata.file_type().is_symlink()
        || file_metadata.len() != metadata.byte_length
    {
        return Err(invalid_data("attachment file changed"));
    }
    let bytes = fs::read(&file_path)?;
    if digest(&bytes) != metadata.sha256 {
        return Err(invalid_data("attachment digest changed"));
    }
    Ok(ResolvedStagedImageAttachment {
        metadata,
        file_path,
    })
}

pub fn prune_staged_image_attachments(
    state_directory: &Path,
    cutoff_epoch_ms: u64,
) -> Result<(), PlatformError> {
    let root = match attachments_root(state_directory, false) {
        Ok(root) => root,
        Err(PlatformError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let entries = fs::read_dir(&root)?;
    for entry in entries {
        let entry = entry?;
        if !valid_attachment_id(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let attachment_id = entry.file_name();
        let Some(attachment_id) = attachment_id.to_str() else {
            continue;
        };
        let Ok((directory, metadata)) =
            read_staged_attachment_metadata(state_directory, attachment_id)
        else {
            continue;
        };
        if metadata.created_at_epoch_ms >= cutoff_epoch_ms {
            continue;
        }
        remove_file_if_present(&directory.join(IMAGE_FILE))?;
        remove_file_if_present(&directory.join(METADATA_FILE))?;
        match fs::remove_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn read_staged_attachment_metadata(
    state_directory: &Path,
    attachment_id: &str,
) -> Result<(PathBuf, StagedImageAttachment), PlatformError> {
    let directory = attachment_directory(state_directory, attachment_id)?;
    attachments_root(state_directory, false)?;
    let directory_metadata = fs::symlink_metadata(&directory)?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err(invalid_data("attachment directory is invalid"));
    }
    let metadata_path = directory.join(METADATA_FILE);
    let metadata_file = fs::symlink_metadata(&metadata_path)?;
    if !metadata_file.is_file() || metadata_file.file_type().is_symlink() {
        return Err(invalid_data("attachment metadata file is invalid"));
    }
    let metadata: StagedImageAttachment =
        serde_json::from_slice(&read_bounded_file(&metadata_path, METADATA_LIMIT)?)
            .map_err(|error| invalid_data(&error.to_string()))?;
    validate_metadata(&metadata)?;
    if metadata.attachment_id != attachment_id {
        return Err(invalid_data("attachment metadata identity changed"));
    }
    Ok((directory, metadata))
}

fn attachment_directory(
    state_directory: &Path,
    attachment_id: &str,
) -> Result<PathBuf, PlatformError> {
    if !valid_attachment_id(attachment_id) {
        return Err(invalid_data("attachment identifier is invalid"));
    }
    Ok(state_directory
        .join(ATTACHMENTS_DIRECTORY)
        .join(attachment_id))
}

fn attachments_root(state_directory: &Path, create: bool) -> Result<PathBuf, PlatformError> {
    let root = state_directory.join(ATTACHMENTS_DIRECTORY);
    if create {
        fs::create_dir_all(state_directory)?;
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(&root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_data("attachment root is invalid"));
    }
    Ok(root)
}

fn validate_metadata(metadata: &StagedImageAttachment) -> Result<(), PlatformError> {
    if metadata.version != 1
        || !valid_attachment_id(&metadata.attachment_id)
        || metadata.media_type != "image/png"
        || metadata.byte_length == 0
        || metadata.byte_length > MAX_IMAGE_BYTES
        || !metadata.sha256.starts_with("sha256:")
        || metadata.sha256.len() != 71
        || !metadata.sha256[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || metadata.width == 0
        || metadata.width > 16_384
        || metadata.height == 0
        || metadata.height > 16_384
    {
        return Err(invalid_data("attachment metadata is invalid"));
    }
    Ok(())
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24
        || bytes.get(8..12)? != 13_u32.to_be_bytes()
        || bytes.get(12..16)? != b"IHDR"
    {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

fn valid_attachment_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn invalid_data(message: &str) -> PlatformError {
    PlatformError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    #[test]
    fn staged_attachment_round_trips_and_rejects_changed_bytes() {
        let root =
            std::env::temp_dir().join(format!("termloop-attachment-{}", uuid::Uuid::new_v4()));
        let bytes = fixture_png(10, 20);
        let attachment_id = uuid::Uuid::new_v4().to_string();
        let metadata = StagedImageAttachment {
            version: 1,
            attachment_id: attachment_id.clone(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: digest(&bytes),
            width: 10,
            height: 20,
            created_at_epoch_ms: 100,
        };
        write_staged_image_attachment(&root, &metadata, &bytes).unwrap();
        assert_eq!(
            read_staged_image_attachment(&root, &attachment_id)
                .unwrap()
                .metadata,
            metadata
        );
        fs::write(
            root.join(ATTACHMENTS_DIRECTORY)
                .join(&attachment_id)
                .join(IMAGE_FILE),
            b"changed",
        )
        .unwrap();
        assert!(read_staged_image_attachment(&root, &attachment_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staged_attachment_rejects_declared_dimensions_that_do_not_match_ihdr() {
        let root =
            std::env::temp_dir().join(format!("termloop-attachment-size-{}", uuid::Uuid::new_v4()));
        let bytes = fixture_png(10, 20);
        let metadata = StagedImageAttachment {
            version: 1,
            attachment_id: uuid::Uuid::new_v4().to_string(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: digest(&bytes),
            width: 20,
            height: 10,
            created_at_epoch_ms: 100,
        };
        assert!(write_staged_image_attachment(&root, &metadata, &bytes).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staged_attachment_pruning_removes_only_entries_older_than_the_cutoff() {
        let root = std::env::temp_dir().join(format!(
            "termloop-attachment-prune-{}",
            uuid::Uuid::new_v4()
        ));
        let bytes = fixture_png(10, 20);
        let make_metadata = |created_at_epoch_ms| StagedImageAttachment {
            version: 1,
            attachment_id: uuid::Uuid::new_v4().to_string(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: digest(&bytes),
            width: 10,
            height: 20,
            created_at_epoch_ms,
        };
        let expired = make_metadata(99);
        let retained = make_metadata(100);
        write_staged_image_attachment(&root, &expired, &bytes).unwrap();
        write_staged_image_attachment(&root, &retained, &bytes).unwrap();

        prune_staged_image_attachments(&root, 100).unwrap();

        assert!(read_staged_image_attachment(&root, &expired.attachment_id).is_err());
        assert!(read_staged_image_attachment(&root, &retained.attachment_id).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_attachment_rejects_a_symlinked_storage_root() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("termloop-attachment-link-{}", uuid::Uuid::new_v4()));
        let outside = root.with_extension("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(ATTACHMENTS_DIRECTORY)).unwrap();
        let bytes = fixture_png(10, 20);
        let metadata = StagedImageAttachment {
            version: 1,
            attachment_id: uuid::Uuid::new_v4().to_string(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: digest(&bytes),
            width: 10,
            height: 20,
            created_at_epoch_ms: 100,
        };
        assert!(write_staged_image_attachment(&root, &metadata, &bytes).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_attachment_rejects_symlinked_metadata() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "termloop-attachment-metadata-link-{}",
            uuid::Uuid::new_v4()
        ));
        let bytes = fixture_png(10, 20);
        let metadata = StagedImageAttachment {
            version: 1,
            attachment_id: uuid::Uuid::new_v4().to_string(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: digest(&bytes),
            width: 10,
            height: 20,
            created_at_epoch_ms: 100,
        };
        write_staged_image_attachment(&root, &metadata, &bytes).unwrap();
        let metadata_path = root
            .join(ATTACHMENTS_DIRECTORY)
            .join(&metadata.attachment_id)
            .join(METADATA_FILE);
        let outside = root.join("outside.json");
        fs::write(&outside, serde_json::to_vec(&metadata).unwrap()).unwrap();
        fs::remove_file(&metadata_path).unwrap();
        symlink(&outside, &metadata_path).unwrap();

        assert!(read_staged_image_attachment(&root, &metadata.attachment_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
