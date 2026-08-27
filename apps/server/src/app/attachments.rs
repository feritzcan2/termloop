use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use termloop_contract::current::{
    AttachmentBeginUploadParams, AttachmentBeginUploadResult, QuickActionImageAttachment,
};

use super::AppState;

const UPLOAD_TTL_MS: u64 = 60_000;
const ATTACHMENT_RETENTION_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_PENDING_UPLOADS: usize = 128;
const UPLOAD_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone)]
pub(in crate::app) struct AttachmentStore {
    inner: Arc<AttachmentStoreInner>,
}

struct AttachmentStoreInner {
    state_directory: PathBuf,
    tickets: Mutex<HashMap<String, UploadTicket>>,
}

#[derive(Clone)]
struct UploadTicket {
    metadata: AttachmentBeginUploadParams,
    expires_at_epoch_ms: u64,
}

impl AttachmentStore {
    pub(in crate::app) fn new(state_directory: PathBuf) -> Self {
        Self {
            inner: Arc::new(AttachmentStoreInner {
                state_directory,
                tickets: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(in crate::app) fn begin_upload(
        &self,
        metadata: AttachmentBeginUploadParams,
    ) -> Result<AttachmentBeginUploadResult, String> {
        validate_upload_metadata(&metadata)?;
        let now = termloop_platform::current_epoch_ms();
        let expires_at_epoch_ms = now.saturating_add(UPLOAD_TTL_MS);
        let mut tickets = self
            .inner
            .tickets
            .lock()
            .map_err(|_| "attachment upload state is unavailable".to_owned())?;
        tickets.retain(|_, ticket| ticket.expires_at_epoch_ms > now);
        if tickets.len() >= MAX_PENDING_UPLOADS {
            return Err("too many attachment uploads are pending".to_owned());
        }
        let upload_ticket = termloop_platform::generate_capability_token();
        tickets.insert(
            upload_ticket.clone(),
            UploadTicket {
                metadata,
                expires_at_epoch_ms,
            },
        );
        Ok(AttachmentBeginUploadResult {
            upload_ticket,
            expires_at_epoch_ms,
        })
    }

    fn take_upload_ticket(&self, ticket: &str) -> Result<UploadTicket, String> {
        let pending = {
            let mut tickets = self
                .inner
                .tickets
                .lock()
                .map_err(|_| "attachment upload state is unavailable".to_owned())?;
            tickets.remove(ticket)
        }
        .ok_or_else(|| "attachment upload ticket is invalid or already used".to_owned())?;
        if pending.expires_at_epoch_ms <= termloop_platform::current_epoch_ms() {
            return Err("attachment upload ticket expired".to_owned());
        }
        Ok(pending)
    }

    async fn upload(
        &self,
        pending: UploadTicket,
        bytes: Vec<u8>,
    ) -> Result<QuickActionImageAttachment, String> {
        let state_directory = self.inner.state_directory.clone();
        let attachment_id = termloop_platform::generate_uuid_v4();
        let metadata = termloop_platform::StagedImageAttachment {
            version: 1,
            attachment_id: attachment_id.clone(),
            media_type: pending.metadata.media_type.clone(),
            byte_length: pending.metadata.byte_length,
            sha256: pending.metadata.sha256.clone(),
            width: pending.metadata.width,
            height: pending.metadata.height,
            created_at_epoch_ms: termloop_platform::current_epoch_ms(),
        };
        let stored = tokio::task::spawn_blocking(move || {
            let cutoff =
                termloop_platform::current_epoch_ms().saturating_sub(ATTACHMENT_RETENTION_MS);
            termloop_platform::prune_staged_image_attachments(&state_directory, cutoff)?;
            termloop_platform::write_staged_image_attachment(&state_directory, &metadata, &bytes)
        })
        .await
        .map_err(|_| "attachment upload task failed".to_owned())?
        .map_err(|error| error.to_string())?;
        Ok(protocol_attachment(&stored.metadata))
    }

    pub(in crate::app) async fn hydrate_quick_action(
        &self,
        params: &mut serde_json::Value,
    ) -> Result<(), termloop_core::CoreError> {
        let Some(values) = params
            .get_mut("attachments")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return Err(termloop_core::CoreError::InvalidParams(
                "attachments".to_owned(),
            ));
        };
        for value in values {
            let requested = serde_json::from_value::<QuickActionImageAttachment>(value.clone())
                .map_err(|_| termloop_core::CoreError::InvalidParams("attachments".to_owned()))?;
            let state_directory = self.inner.state_directory.clone();
            let attachment_id = requested.attachment_id.clone();
            let cutoff =
                termloop_platform::current_epoch_ms().saturating_sub(ATTACHMENT_RETENTION_MS);
            let stored = tokio::task::spawn_blocking(move || {
                termloop_platform::prune_staged_image_attachments(&state_directory, cutoff)?;
                termloop_platform::read_staged_image_attachment(&state_directory, &attachment_id)
            })
            .await
            .map_err(|_| {
                termloop_core::CoreError::Terminal("attachment verification task failed".to_owned())
            })?
            .map_err(|_| termloop_core::CoreError::InvalidParams("attachmentId".to_owned()))?;
            if stored.metadata.created_at_epoch_ms
                < termloop_platform::current_epoch_ms().saturating_sub(ATTACHMENT_RETENTION_MS)
            {
                return Err(termloop_core::CoreError::InvalidParams(
                    "attachmentId".to_owned(),
                ));
            }
            if protocol_attachment(&stored.metadata) != requested {
                return Err(termloop_core::CoreError::InvalidParams(
                    "attachments".to_owned(),
                ));
            }
            value
                .as_object_mut()
                .expect("generated attachment DTO is an object")
                .insert(
                    "filePath".to_owned(),
                    serde_json::Value::String(stored.file_path.to_string_lossy().into_owned()),
                );
        }
        Ok(())
    }
}

pub(in crate::app) async fn attachment_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let Some(ticket) = bearer_ticket(&headers) else {
        return attachment_error(StatusCode::UNAUTHORIZED, "upload authorization is required");
    };
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if media_type != Some("image/png") {
        return attachment_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "only image/png is supported",
        );
    }
    let pending = match state.attachments.take_upload_ticket(ticket) {
        Ok(pending) => pending,
        Err(message) => return attachment_error(StatusCode::UNAUTHORIZED, &message),
    };
    let bytes =
        match tokio::time::timeout(UPLOAD_BODY_TIMEOUT, to_bytes(body, MAX_UPLOAD_BYTES + 1)).await
        {
            Ok(Ok(bytes)) if !bytes.is_empty() && bytes.len() <= MAX_UPLOAD_BYTES => bytes.to_vec(),
            Err(_) => {
                return attachment_error(
                    StatusCode::REQUEST_TIMEOUT,
                    "attachment upload timed out",
                );
            }
            _ => {
                return attachment_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "attachment payload is invalid",
                );
            }
        };
    match state.attachments.upload(pending, bytes).await {
        Ok(attachment) => (StatusCode::CREATED, Json(attachment)).into_response(),
        Err(message) => attachment_error(StatusCode::UNAUTHORIZED, &message),
    }
}

fn bearer_ticket(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|ticket| ticket.len() == 64 && ticket.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn attachment_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn protocol_attachment(
    metadata: &termloop_platform::StagedImageAttachment,
) -> QuickActionImageAttachment {
    QuickActionImageAttachment {
        attachment_id: metadata.attachment_id.clone(),
        media_type: metadata.media_type.clone(),
        byte_length: metadata.byte_length,
        sha256: metadata.sha256.clone(),
        width: metadata.width,
        height: metadata.height,
    }
}

fn validate_upload_metadata(metadata: &AttachmentBeginUploadParams) -> Result<(), String> {
    if metadata.media_type != "image/png"
        || metadata.byte_length == 0
        || metadata.byte_length > MAX_UPLOAD_BYTES as u64
        || metadata.width == 0
        || metadata.width > 16_384
        || metadata.height == 0
        || metadata.height > 16_384
        || metadata.sha256.len() != 71
        || !metadata.sha256.starts_with("sha256:")
        || !metadata.sha256[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("attachment upload metadata is invalid".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_tickets_are_bounded_and_not_durable() {
        let store = AttachmentStore::new(PathBuf::from("unused"));
        let result = store
            .begin_upload(AttachmentBeginUploadParams {
                media_type: "image/png".to_owned(),
                byte_length: 3,
                sha256: format!("sha256:{}", "a".repeat(64)),
                width: 1,
                height: 1,
            })
            .unwrap();
        assert_eq!(result.upload_ticket.len(), 64);
        assert!(result.expires_at_epoch_ms > termloop_platform::current_epoch_ms());
        assert!(store.take_upload_ticket(&result.upload_ticket).is_ok());
        assert!(store.take_upload_ticket(&result.upload_ticket).is_err());
    }

    #[tokio::test]
    async fn hydration_prunes_an_expired_attachment_before_preview_io() {
        let root = std::env::temp_dir().join(format!(
            "termloop-expired-attachment-{}",
            termloop_platform::generate_uuid_v4()
        ));
        let attachment_id = termloop_platform::generate_uuid_v4();
        let bytes = [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3,
            8, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        let metadata = termloop_platform::StagedImageAttachment {
            version: 1,
            attachment_id: attachment_id.clone(),
            media_type: "image/png".to_owned(),
            byte_length: bytes.len() as u64,
            sha256: "sha256:b63355f9a1f6274e48ef9c27ab6d683c460bf87cb4eefe3139711bcbea77c75c"
                .to_owned(),
            width: 2,
            height: 3,
            created_at_epoch_ms: termloop_platform::current_epoch_ms()
                .saturating_sub(ATTACHMENT_RETENTION_MS + 1),
        };
        termloop_platform::write_staged_image_attachment(&root, &metadata, &bytes).unwrap();
        let mut params = serde_json::json!({
            "attachments": [protocol_attachment(&metadata)],
        });
        let result = AttachmentStore::new(root.clone())
            .hydrate_quick_action(&mut params)
            .await;
        assert!(result.is_err());
        assert!(termloop_platform::read_staged_image_attachment(&root, &attachment_id).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
