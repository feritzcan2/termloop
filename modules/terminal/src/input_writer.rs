use std::io::Write;
use std::sync::mpsc;
use std::time::Duration;

use crate::output_settlement::{OutputActivitySnapshot, OutputActivityTracker};

// Supported interactive TUIs can keep treating Enter as part of a detected
// paste burst for 120 ms after the last rapidly delivered character. Keep the
// submit key beyond that window, with enough margin for ordinary scheduling
// jitter, so a visible initial prompt is not left unsubmitted.
pub(crate) const INPUT_SEQUENCE_GAP: Duration = Duration::from_millis(200);
pub(crate) const MAX_INPUT_SEQUENCE_CHUNKS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputChunkReceipt {
    pub chunk_index: usize,
    pub byte_count: usize,
}

#[derive(Debug, Clone)]
pub struct InputWriteReceipt {
    pub runtime_epoch: u64,
    pub chunks: Vec<InputChunkReceipt>,
    pub output_after_write: OutputActivitySnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InputWriteFailure {
    #[error("terminal input write failed at chunk {chunk_index}")]
    Write {
        chunk_index: usize,
        flushed_chunks: Vec<InputChunkReceipt>,
    },
    #[error("terminal input flush failed at chunk {chunk_index}")]
    Flush {
        chunk_index: usize,
        flushed_chunks: Vec<InputChunkReceipt>,
    },
    #[error("terminal input receipt timed out")]
    ReceiptTimedOut {
        flushed_chunks: Vec<InputChunkReceipt>,
    },
    #[error("terminal input writer stopped before reporting completion")]
    WriterStopped {
        flushed_chunks: Vec<InputChunkReceipt>,
    },
    #[error("terminal output barrier was unavailable")]
    OutputBarrierUnavailable {
        flushed_chunks: Vec<InputChunkReceipt>,
    },
}

pub(crate) struct InputWriteCompletion {
    chunks: Vec<InputChunkReceipt>,
    output_after_write: OutputActivitySnapshot,
}

pub struct PendingInputWrite {
    runtime_epoch: u64,
    receipt: mpsc::Receiver<Result<InputWriteCompletion, InputWriteFailure>>,
}

impl std::fmt::Debug for PendingInputWrite {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingInputWrite")
            .field("runtime_epoch", &self.runtime_epoch)
            .finish_non_exhaustive()
    }
}

impl PendingInputWrite {
    pub fn wait(self, timeout: Duration) -> Result<InputWriteReceipt, InputWriteFailure> {
        match self.receipt.recv_timeout(timeout) {
            Ok(Ok(completion)) => Ok(InputWriteReceipt {
                runtime_epoch: self.runtime_epoch,
                chunks: completion.chunks,
                output_after_write: completion.output_after_write,
            }),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(InputWriteFailure::ReceiptTimedOut {
                flushed_chunks: Vec::new(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(InputWriteFailure::WriterStopped {
                flushed_chunks: Vec::new(),
            }),
        }
    }
}

type InputReceiptSender = mpsc::SyncSender<Result<InputWriteCompletion, InputWriteFailure>>;

pub(crate) enum InputRequest {
    Bytes {
        bytes: Vec<u8>,
        receipt: Option<InputReceiptSender>,
    },
    Sequence {
        chunks: Vec<Vec<u8>>,
        receipt: Option<InputReceiptSender>,
    },
}

impl InputRequest {
    pub(crate) fn bytes(bytes: Vec<u8>) -> Self {
        Self::Bytes {
            bytes,
            receipt: None,
        }
    }

    pub(crate) fn sequence(chunks: Vec<Vec<u8>>) -> Self {
        Self::Sequence {
            chunks,
            receipt: None,
        }
    }

    pub(crate) fn receipted_bytes(bytes: Vec<u8>, runtime_epoch: u64) -> (Self, PendingInputWrite) {
        let (sender, receipt) = mpsc::sync_channel(1);
        (
            Self::Bytes {
                bytes,
                receipt: Some(sender),
            },
            PendingInputWrite {
                runtime_epoch,
                receipt,
            },
        )
    }

    pub(crate) fn receipted_sequence(
        chunks: Vec<Vec<u8>>,
        runtime_epoch: u64,
    ) -> (Self, PendingInputWrite) {
        let (sender, receipt) = mpsc::sync_channel(1);
        (
            Self::Sequence {
                chunks,
                receipt: Some(sender),
            },
            PendingInputWrite {
                runtime_epoch,
                receipt,
            },
        )
    }

    fn into_parts(self) -> (Vec<Vec<u8>>, Option<InputReceiptSender>) {
        match self {
            Self::Bytes { bytes, receipt } => (vec![bytes], receipt),
            Self::Sequence { chunks, receipt } => (chunks, receipt),
        }
    }
}

pub(crate) fn spawn(
    mut writer: Box<dyn Write + Send>,
    output_activity: OutputActivityTracker,
    session_id: String,
    runtime_epoch: u64,
) -> mpsc::SyncSender<InputRequest> {
    let (writer_tx, writer_rx) = mpsc::sync_channel::<InputRequest>(256);
    std::thread::spawn(move || {
        while let Ok(request) = writer_rx.recv() {
            let (chunks, receipt) = request.into_parts();
            let outcome = output_activity
                .capture_after_input_write(session_id.clone(), runtime_epoch, || {
                    write_chunks(writer.as_mut(), chunks)
                })
                .map(|(outcome, output_after_write)| {
                    outcome.map(|chunks| InputWriteCompletion {
                        chunks,
                        output_after_write,
                    })
                })
                .unwrap_or_else(|_| {
                    Err(InputWriteFailure::OutputBarrierUnavailable {
                        flushed_chunks: Vec::new(),
                    })
                });
            let failed = outcome.is_err();
            if let Some(receipt) = receipt {
                let _ = receipt.send(outcome);
            }
            if failed {
                break;
            }
        }
    });
    writer_tx
}

fn write_chunks(
    writer: &mut dyn Write,
    chunks: Vec<Vec<u8>>,
) -> Result<Vec<InputChunkReceipt>, InputWriteFailure> {
    let chunk_count = chunks.len();
    let mut receipts = Vec::with_capacity(chunk_count);
    for (chunk_index, bytes) in chunks.into_iter().enumerate() {
        if writer.write_all(&bytes).is_err() {
            return Err(InputWriteFailure::Write {
                chunk_index,
                flushed_chunks: receipts,
            });
        }
        if writer.flush().is_err() {
            return Err(InputWriteFailure::Flush {
                chunk_index,
                flushed_chunks: receipts,
            });
        }
        receipts.push(InputChunkReceipt {
            chunk_index,
            byte_count: bytes.len(),
        });
        if chunk_index + 1 < chunk_count {
            std::thread::sleep(INPUT_SEQUENCE_GAP);
        }
    }
    Ok(receipts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct RecordingWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        fail_flush: bool,
    }

    fn test_writer(writer: RecordingWriter) -> mpsc::SyncSender<InputRequest> {
        spawn(
            Box::new(writer),
            OutputActivityTracker::default(),
            "session".into(),
            77,
        )
    }

    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            if self.fail_flush {
                Err(std::io::Error::other("fixture flush failure"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn receipted_write_reports_each_flushed_chunk_without_content() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let sender = test_writer(RecordingWriter {
            bytes: bytes.clone(),
            fail_flush: false,
        });
        let (request, pending) =
            InputRequest::receipted_sequence(vec![b"first".to_vec(), b"second".to_vec()], 77);

        sender.send(request).unwrap();
        let receipt = pending.wait(Duration::from_secs(1)).unwrap();

        assert_eq!(receipt.runtime_epoch, 77);
        assert_eq!(
            receipt.chunks,
            vec![
                InputChunkReceipt {
                    chunk_index: 0,
                    byte_count: 5,
                },
                InputChunkReceipt {
                    chunk_index: 1,
                    byte_count: 6,
                },
            ]
        );
        assert_eq!(*bytes.lock().unwrap(), b"firstsecond");
        assert!(!format!("{receipt:?}").contains("first"));
    }

    #[test]
    fn post_enqueue_flush_failure_is_typed_and_redacted() {
        let sender = test_writer(RecordingWriter {
            bytes: Arc::new(Mutex::new(Vec::new())),
            fail_flush: true,
        });
        let (request, pending) = InputRequest::receipted_bytes(b"secret payload".to_vec(), 77);

        sender.send(request).unwrap();
        let error = pending.wait(Duration::from_secs(1)).unwrap_err();

        assert_eq!(
            error,
            InputWriteFailure::Flush {
                chunk_index: 0,
                flushed_chunks: Vec::new(),
            }
        );
        assert!(!error.to_string().contains("secret payload"));
    }
}
