use super::*;

pub(super) struct RecoveryDiagnostics {
    log: Option<crate::BoundedPrivateLog>,
    started: std::time::Instant,
    started_at: u64,
    mode: &'static str,
}

impl RecoveryDiagnostics {
    pub(super) fn open(directory: &Path, mode: &'static str) -> Self {
        Self {
            log: crate::BoundedPrivateLog::open(
                &directory.join("recovery-diagnostics.jsonl"),
                512 * 1024,
            )
            .ok(),
            started: std::time::Instant::now(),
            started_at: crate::current_epoch_ms(),
            mode,
        }
    }

    pub(super) fn record(
        &self,
        phase: &str,
        path: Option<&Path>,
        process_id: Option<u32>,
        error: Option<&PlatformError>,
    ) {
        static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let Some(log) = &self.log else { return };
        let Ok(_guard) = WRITE_LOCK.lock() else {
            return;
        };
        let record_id = path
            .and_then(|path| path.file_stem())
            .and_then(|value| value.to_str())
            .filter(|value| validate_process_record_id(value).is_ok());
        let (error_kind, os_error) = match error {
            Some(PlatformError::Io(error)) => {
                (Some(format!("{:?}", error.kind())), error.raw_os_error())
            }
            Some(_) => (Some("platformError".to_owned()), None),
            None => (None, None),
        };
        let _ = log.append_line(
            &serde_json::json!({
                "timestampMs": crate::current_epoch_ms(),
                "recoveryStartedAtMs": self.started_at,
                "daemonPid": std::process::id(),
                "mode": self.mode,
                "phase": phase,
                "recordId": record_id,
                "processId": process_id,
                "elapsedMs": self.started.elapsed().as_millis(),
                "errorKind": error_kind,
                "osError": os_error,
            })
            .to_string(),
        );
    }

    pub(super) fn signal(
        &self,
        record: &TrackedProcessRecord,
        signal: ProcessTreeSignal,
    ) -> Result<SignalDelivery, PlatformError> {
        let result = signal_process_tree(record.process_id, signal);
        let phase = match signal {
            ProcessTreeSignal::Hangup => "hangupSignal",
            ProcessTreeSignal::Terminate => "terminateSignal",
            ProcessTreeSignal::Kill => "killSignal",
        };
        self.record(
            phase,
            Some(&record.path),
            Some(record.process_id),
            result.as_ref().err(),
        );
        if matches!(result, Ok(SignalDelivery::GracefulUnsupported)) {
            self.record(
                "gracefulUnsupported",
                Some(&record.path),
                Some(record.process_id),
                None,
            );
        }
        result
    }
}

impl Drop for RecoveryDiagnostics {
    fn drop(&mut self) {
        self.record("recoveryFinished", None, None, None);
    }
}
