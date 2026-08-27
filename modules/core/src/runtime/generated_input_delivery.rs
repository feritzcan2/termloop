use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::Duration;

use termloop_invocation::GeneratedTerminalSubmission;
use termloop_terminal::{
    InputReadinessSnapshot, InputWriteFailure, OutputActivityDiagnostics, OutputSettlementEvidence,
    OutputSettlementFailure, TerminalError, TerminalService, UserInputActivitySnapshot,
};

const MAX_RUNTIME_DELIVERIES: usize = 256;
const WRITE_RECEIPT_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_ACTIVITY_SETTLEMENT_QUIET: Duration = Duration::from_millis(160);
const OUTPUT_ACTIVITY_SETTLEMENT_TIMEOUT: Duration = Duration::from_secs(3);
const COMPOSER_RENDER_SETTLEMENT_QUIET: Duration = Duration::from_millis(1_500);
const COMPOSER_RENDER_SETTLEMENT_TIMEOUT: Duration = Duration::from_secs(10);
const CODEX_COMPOSER_READY_TIMEOUT: Duration = Duration::from_secs(20);
const PROTOCOL_REPLY_SETTLEMENT_TIMEOUT: Duration = Duration::from_millis(125);
const MAX_PROTOCOL_REPLY_SETTLEMENT_WAITS: usize = 8;
const PROVIDER_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_ACK_AFTER_RETRY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeneratedInputDeliveryState {
    WritingPaste,
    AwaitingProviderAck,
    Confirmed,
    ConfirmedUnattributed,
    Stalled,
    Blocked,
    Failed,
    RequiresUserResubmit,
}

impl GeneratedInputDeliveryState {
    fn is_active(self) -> bool {
        matches!(self, Self::WritingPaste | Self::AwaitingProviderAck)
    }

    fn accepts_replacement(self) -> bool {
        matches!(
            self,
            Self::Confirmed | Self::ConfirmedUnattributed | Self::RequiresUserResubmit
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeneratedInputDeliveryFailure {
    TerminalUnavailable,
    PasteWriteFailed,
    OutputDidNotSettle,
    UserInputInterleaved,
    ProviderAckMissing,
    ComposerUnavailable,
    ComposerNotReady,
    RuntimeEpochChanged,
    TerminalClosed,
    SubmitWriteFailed,
    WorkerUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeneratedInputDeliveryCancelCause {
    PermissionRequested,
    Notification,
    ProviderAwaitingInput,
    ProviderBusy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedInputDeliveryDiagnostics {
    pub original_failure: Option<GeneratedInputDeliveryFailure>,
    pub cancel_cause: Option<GeneratedInputDeliveryCancelCause>,
    pub cancel_notification_type: Option<String>,
    pub paste_receipted: bool,
    pub settlement_evidence: Option<OutputSettlementEvidence>,
    pub submit_receipted: bool,
    pub submit_attempts: u8,
    pub protocol_reply_waits: u8,
    pub user_input_mutated: Option<bool>,
    pub output_activity: OutputActivityDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GeneratedInputSettlement {
    OutputActivity,
    ComposerRender,
    CodexComposerRender,
    ProviderQueue,
}

struct GeneratedInputDelivery {
    id: u64,
    runtime_epoch: u64,
    provider_sequence_baseline: u64,
    submission: GeneratedTerminalSubmission,
    state: GeneratedInputDeliveryState,
    failure: Option<GeneratedInputDeliveryFailure>,
    original_failure: Option<GeneratedInputDeliveryFailure>,
    cancel_cause: Option<GeneratedInputDeliveryCancelCause>,
    cancel_notification_type: Option<String>,
    paste_started: Arc<AtomicBool>,
    paste_receipted: bool,
    settlement_evidence: Option<OutputSettlementEvidence>,
    submit_receipted: bool,
    submit_attempts: u8,
    protocol_reply_waits: u8,
    user_input_mutated: Option<bool>,
    output_activity: OutputActivityDiagnostics,
    user_input_sequence_baseline: u64,
    user_input_mutation_sequence_baseline: u64,
    provider_confirmation: Option<(u64, Option<UserInputActivitySnapshot>)>,
    cancel_submit: Arc<AtomicBool>,
    provider_ack_signal: Option<Sender<()>>,
}

pub struct GeneratedInputDeliveryRuntime {
    next_id: u64,
    deliveries: HashMap<String, GeneratedInputDelivery>,
    order: VecDeque<String>,
    events: Option<Receiver<GeneratedInputRuntimeEvent>>,
    event_sender: Sender<GeneratedInputRuntimeEvent>,
}

impl Default for GeneratedInputDeliveryRuntime {
    fn default() -> Self {
        let (event_sender, events) = std::sync::mpsc::channel();
        Self {
            next_id: 1,
            deliveries: HashMap::new(),
            order: VecDeque::new(),
            events: Some(events),
            event_sender,
        }
    }
}

impl GeneratedInputDeliveryRuntime {
    pub fn take_events(&mut self) -> Option<Receiver<GeneratedInputRuntimeEvent>> {
        self.events.take()
    }

    pub(crate) fn remove_session(&mut self, session_id: &str) {
        if let Some(delivery) = self.deliveries.remove(session_id) {
            delivery.cancel_submit.store(true, Ordering::Release);
        }
        self.order.retain(|candidate| candidate != session_id);
    }

    pub fn state(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<GeneratedInputDeliveryState> {
        self.deliveries
            .get(session_id)
            .filter(|delivery| delivery.runtime_epoch == runtime_epoch)
            .map(|delivery| delivery.state)
    }

    pub fn failure(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<GeneratedInputDeliveryFailure> {
        self.deliveries
            .get(session_id)
            .filter(|delivery| delivery.runtime_epoch == runtime_epoch)
            .and_then(|delivery| delivery.failure)
    }

    pub fn diagnostics(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<GeneratedInputDeliveryDiagnostics> {
        self.deliveries
            .get(session_id)
            .filter(|delivery| delivery.runtime_epoch == runtime_epoch)
            .map(|delivery| GeneratedInputDeliveryDiagnostics {
                original_failure: delivery.original_failure,
                cancel_cause: delivery.cancel_cause,
                cancel_notification_type: delivery.cancel_notification_type.clone(),
                paste_receipted: delivery.paste_receipted,
                settlement_evidence: delivery.settlement_evidence,
                submit_receipted: delivery.submit_receipted,
                submit_attempts: delivery.submit_attempts,
                protocol_reply_waits: delivery.protocol_reply_waits,
                user_input_mutated: delivery.user_input_mutated,
                output_activity: delivery.output_activity,
            })
    }

    pub fn provenance(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<&termloop_invocation::Provenance> {
        self.deliveries
            .get(session_id)
            .filter(|delivery| delivery.runtime_epoch == runtime_epoch)
            .map(|delivery| delivery.submission.provenance())
    }

    pub fn accepts_new_submission(&self, session_id: &str, runtime_epoch: u64) -> bool {
        self.deliveries.get(session_id).is_none_or(|delivery| {
            delivery.runtime_epoch == runtime_epoch && delivery.state.accepts_replacement()
        })
    }

    /// Allows the same pending immutable submission to start after a provider
    /// modal has cleared only when no paste transport was ever started. A
    /// cancelled in-flight write remains ambiguous and can never enter this
    /// path, even if its receipt has not reached Core yet.
    pub(crate) fn can_begin_pending_submission(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        self.deliveries.get(session_id).is_none_or(|delivery| {
            delivery.runtime_epoch == runtime_epoch
                && (delivery.state.accepts_replacement()
                    || (delivery.state == GeneratedInputDeliveryState::Blocked
                        && matches!(
                            delivery.failure,
                            Some(
                                GeneratedInputDeliveryFailure::ComposerUnavailable
                                    | GeneratedInputDeliveryFailure::ComposerNotReady
                            )
                        )
                        && !delivery.paste_started.load(Ordering::Acquire)))
        })
    }

    pub(crate) fn begin(
        &mut self,
        terminal: &TerminalService,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence_baseline: u64,
        submission: GeneratedTerminalSubmission,
        settlement: GeneratedInputSettlement,
    ) -> bool {
        if !self.can_begin_pending_submission(session_id, runtime_epoch) {
            return false;
        }
        let inherited_unwritten_block = self.deliveries.get(session_id).and_then(|delivery| {
            (delivery.runtime_epoch == runtime_epoch
                && delivery.state == GeneratedInputDeliveryState::Blocked
                && matches!(
                    delivery.failure,
                    Some(
                        GeneratedInputDeliveryFailure::ComposerUnavailable
                            | GeneratedInputDeliveryFailure::ComposerNotReady
                    )
                )
                && !delivery.paste_started.load(Ordering::Acquire))
            .then(|| {
                (
                    delivery.original_failure,
                    delivery.cancel_cause,
                    delivery.cancel_notification_type.clone(),
                )
            })
        });
        let replacing = self.deliveries.contains_key(session_id);
        if !replacing && self.deliveries.len() >= MAX_RUNTIME_DELIVERIES {
            self.evict_oldest_terminal_delivery();
        }
        if !replacing && self.deliveries.len() >= MAX_RUNTIME_DELIVERIES {
            return false;
        }

        let delivery_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let user_input_activity = terminal.user_input_activity(session_id, runtime_epoch);
        let cancel_submit = Arc::new(AtomicBool::new(false));
        let paste_started = Arc::new(AtomicBool::new(false));
        let (provider_ack_signal, provider_ack_wait) = std::sync::mpsc::channel();
        self.order.retain(|candidate| candidate != session_id);
        self.order.push_back(session_id.to_owned());
        self.deliveries.insert(
            session_id.to_owned(),
            GeneratedInputDelivery {
                id: delivery_id,
                runtime_epoch,
                provider_sequence_baseline,
                submission: submission.clone(),
                state: GeneratedInputDeliveryState::WritingPaste,
                failure: None,
                original_failure: inherited_unwritten_block
                    .as_ref()
                    .and_then(|(failure, _, _)| *failure),
                cancel_cause: inherited_unwritten_block
                    .as_ref()
                    .and_then(|(_, cause, _)| *cause),
                cancel_notification_type: inherited_unwritten_block
                    .and_then(|(_, _, notification_type)| notification_type),
                paste_started: Arc::clone(&paste_started),
                paste_receipted: false,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: user_input_activity
                    .as_ref()
                    .map(|activity| activity.sequence)
                    .unwrap_or(0),
                user_input_mutation_sequence_baseline: user_input_activity
                    .as_ref()
                    .map(|activity| activity.mutation_sequence)
                    .unwrap_or(0),
                provider_confirmation: None,
                cancel_submit: Arc::clone(&cancel_submit),
                provider_ack_signal: Some(provider_ack_signal),
            },
        );

        if user_input_activity.is_err() {
            self.fail_immediately(
                session_id,
                GeneratedInputDeliveryFailure::TerminalUnavailable,
            );
            return true;
        }

        let input_readiness = match terminal.input_readiness_snapshot(session_id, runtime_epoch) {
            Ok(readiness) => readiness,
            Err(_) => {
                self.fail_immediately(
                    session_id,
                    GeneratedInputDeliveryFailure::TerminalUnavailable,
                );
                return true;
            }
        };
        let prepared_paste = if settlement == GeneratedInputSettlement::CodexComposerRender {
            None
        } else {
            let output_before_paste =
                match terminal.output_activity_snapshot(session_id, runtime_epoch) {
                    Ok(output) => output,
                    Err(_) => {
                        self.fail_immediately(
                            session_id,
                            GeneratedInputDeliveryFailure::TerminalUnavailable,
                        );
                        return true;
                    }
                };
            paste_started.store(true, Ordering::Release);
            let paste_write = match terminal.input_atomic_receipted(
                session_id,
                runtime_epoch,
                submission.paste_input(),
            ) {
                Ok(pending) => pending,
                Err(_) => {
                    self.fail_immediately(
                        session_id,
                        GeneratedInputDeliveryFailure::TerminalUnavailable,
                    );
                    return true;
                }
            };
            Some((paste_write, output_before_paste))
        };

        let event_sender = self.event_sender.clone();
        let terminal = terminal.clone();
        let retry_terminal = terminal.clone();
        let retry_submission = submission.clone();
        let retry_cancel_submit = Arc::clone(&cancel_submit);
        let session_id = session_id.to_owned();
        let worker_session_id = session_id.clone();
        let spawn = std::thread::Builder::new()
            .name("generated-input-delivery".into())
            .spawn(move || {
                let result = run_transport_delivery(GeneratedInputTransportPlan {
                    terminal,
                    session_id: worker_session_id.clone(),
                    runtime_epoch,
                    submission,
                    input_readiness,
                    prepared_paste,
                    settlement,
                    cancel_submit,
                    paste_started,
                });
                let GeneratedInputTransportResult {
                    outcome,
                    diagnostics,
                    retry_readiness_baseline,
                    retry_output_baseline,
                } = result;
                let awaiting_provider_ack =
                    matches!(&outcome, GeneratedInputTransportOutcome::Submitted);
                let _ = event_sender.send(GeneratedInputRuntimeEvent {
                    session_id: worker_session_id.clone(),
                    runtime_epoch,
                    delivery_id,
                    outcome,
                    diagnostics,
                });
                if !awaiting_provider_ack
                    || settlement == GeneratedInputSettlement::ProviderQueue
                    || !matches!(
                        provider_ack_wait.recv_timeout(PROVIDER_ACK_TIMEOUT),
                        Err(RecvTimeoutError::Timeout)
                    )
                {
                    return;
                }
                match provider_ack_wait.try_recv() {
                    Ok(()) | Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => {}
                }
                if retry_cancel_submit.load(Ordering::Acquire) {
                    return;
                }
                if !submit_retry_has_structural_evidence(
                    settlement,
                    retry_readiness_baseline.as_ref(),
                    retry_output_baseline.as_ref(),
                ) {
                    let _ = event_sender.send(GeneratedInputRuntimeEvent {
                        session_id: worker_session_id,
                        runtime_epoch,
                        delivery_id,
                        outcome: GeneratedInputTransportOutcome::ProviderAckTimedOut,
                        diagnostics: GeneratedInputTransportDiagnostics::default(),
                    });
                    return;
                }
                match provider_ack_wait.try_recv() {
                    Ok(()) | Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => {}
                }
                let mut retry_diagnostics = GeneratedInputTransportDiagnostics::default();
                let retry_outcome = match write_submit_attempt(
                    &retry_terminal,
                    &worker_session_id,
                    runtime_epoch,
                    retry_submission.submit_input(),
                    2,
                    &mut retry_diagnostics,
                ) {
                    Ok(_) => GeneratedInputTransportOutcome::SubmitRetried,
                    Err(
                        SubmitAttemptFailure::Blocked(failure)
                        | SubmitAttemptFailure::Failed(failure),
                    ) => GeneratedInputTransportOutcome::SubmitRetryFailed(failure),
                };
                let retry_submitted = matches!(
                    &retry_outcome,
                    GeneratedInputTransportOutcome::SubmitRetried
                );
                let _ = event_sender.send(GeneratedInputRuntimeEvent {
                    session_id: worker_session_id.clone(),
                    runtime_epoch,
                    delivery_id,
                    outcome: retry_outcome,
                    diagnostics: retry_diagnostics,
                });
                if retry_submitted
                    && matches!(
                        provider_ack_wait.recv_timeout(PROVIDER_ACK_AFTER_RETRY_TIMEOUT),
                        Err(RecvTimeoutError::Timeout)
                    )
                {
                    let _ = event_sender.send(GeneratedInputRuntimeEvent {
                        session_id: worker_session_id,
                        runtime_epoch,
                        delivery_id,
                        outcome: GeneratedInputTransportOutcome::ProviderAckTimedOut,
                        diagnostics: GeneratedInputTransportDiagnostics::default(),
                    });
                }
            });
        if spawn.is_err() {
            self.fail_immediately(
                session_id.as_str(),
                GeneratedInputDeliveryFailure::WorkerUnavailable,
            );
        }
        true
    }

    /// Fails closed when structured provider state proves that the composer is
    /// not available. Only a terminal delivery record that already permits an
    /// explicit replacement may be superseded by this newly queued payload.
    pub fn block_for_unavailable_composer(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence_baseline: u64,
        submission: GeneratedTerminalSubmission,
        cancel_cause: GeneratedInputDeliveryCancelCause,
        cancel_notification_type: Option<&str>,
    ) -> bool {
        let replacing = if let Some(delivery) = self.deliveries.get_mut(session_id) {
            if delivery.runtime_epoch != runtime_epoch {
                return false;
            }
            if delivery.state == GeneratedInputDeliveryState::WritingPaste {
                delivery.cancel_submit.store(true, Ordering::Release);
                delivery.provider_ack_signal.take();
                delivery.state = GeneratedInputDeliveryState::Blocked;
                record_delivery_failure(
                    delivery,
                    GeneratedInputDeliveryFailure::ComposerUnavailable,
                );
                delivery.cancel_cause = Some(cancel_cause);
                delivery.cancel_notification_type =
                    cancel_notification_type.map(bounded_notification_type);
                return true;
            }
            if !delivery.state.accepts_replacement() {
                return false;
            }
            delivery.cancel_submit.store(true, Ordering::Release);
            delivery.provider_ack_signal.take();
            true
        } else {
            false
        };
        if !replacing && self.deliveries.len() >= MAX_RUNTIME_DELIVERIES {
            self.evict_oldest_terminal_delivery();
        }
        if !replacing && self.deliveries.len() >= MAX_RUNTIME_DELIVERIES {
            return false;
        }
        let delivery_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.order.retain(|candidate| candidate != session_id);
        self.order.push_back(session_id.to_owned());
        self.deliveries.insert(
            session_id.to_owned(),
            GeneratedInputDelivery {
                id: delivery_id,
                runtime_epoch,
                provider_sequence_baseline,
                submission,
                state: GeneratedInputDeliveryState::Blocked,
                failure: Some(GeneratedInputDeliveryFailure::ComposerUnavailable),
                original_failure: Some(GeneratedInputDeliveryFailure::ComposerUnavailable),
                cancel_cause: Some(cancel_cause),
                cancel_notification_type: cancel_notification_type.map(bounded_notification_type),
                paste_started: Arc::new(AtomicBool::new(false)),
                paste_receipted: false,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 0,
                user_input_mutation_sequence_baseline: 0,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(true)),
                provider_ack_signal: None,
            },
        );
        true
    }

    /// Retires any unconfirmed input from an older PTY generation without
    /// replaying its content into the replacement runtime.
    pub fn transition_runtime_epoch(&mut self, session_id: &str, runtime_epoch: u64) -> bool {
        let Some(delivery) = self.deliveries.get_mut(session_id) else {
            return false;
        };
        if delivery.runtime_epoch == runtime_epoch {
            return false;
        }
        delivery.cancel_submit.store(true, Ordering::Release);
        delivery.provider_ack_signal.take();
        delivery.runtime_epoch = runtime_epoch;
        delivery.provider_confirmation = None;
        if delivery.state != GeneratedInputDeliveryState::Confirmed {
            delivery.state = GeneratedInputDeliveryState::RequiresUserResubmit;
            record_delivery_failure(delivery, GeneratedInputDeliveryFailure::RuntimeEpochChanged);
        }
        true
    }

    pub fn apply_transport_event(&mut self, event: GeneratedInputRuntimeEvent) -> bool {
        let GeneratedInputRuntimeEvent {
            session_id,
            runtime_epoch,
            delivery_id,
            outcome,
            diagnostics,
        } = event;
        let Some(delivery) = self.deliveries.get_mut(&session_id) else {
            return false;
        };
        if delivery.id != delivery_id || delivery.runtime_epoch != runtime_epoch {
            return false;
        }
        let diagnostics_changed = merge_transport_diagnostics(delivery, diagnostics);
        match outcome {
            GeneratedInputTransportOutcome::Submitted => {
                if delivery.state != GeneratedInputDeliveryState::WritingPaste {
                    return diagnostics_changed;
                }
                delivery.state = match delivery.provider_confirmation {
                    Some((provider_sequence, user_input_activity))
                        if provider_sequence > delivery.provider_sequence_baseline =>
                    {
                        record_confirmation_activity(delivery, user_input_activity);
                        GeneratedInputDeliveryState::Confirmed
                    }
                    _ => GeneratedInputDeliveryState::AwaitingProviderAck,
                };
                delivery.failure = None;
            }
            GeneratedInputTransportOutcome::SubmitRetried => {
                if delivery.state != GeneratedInputDeliveryState::AwaitingProviderAck {
                    return diagnostics_changed;
                }
            }
            GeneratedInputTransportOutcome::SubmitRetryFailed(failure) => {
                if delivery.state != GeneratedInputDeliveryState::AwaitingProviderAck {
                    return diagnostics_changed;
                }
                delivery.provider_ack_signal.take();
                delivery.state = GeneratedInputDeliveryState::Stalled;
                record_delivery_failure(delivery, failure);
            }
            GeneratedInputTransportOutcome::ProviderAckTimedOut => {
                if delivery.state != GeneratedInputDeliveryState::AwaitingProviderAck {
                    return diagnostics_changed;
                }
                delivery.provider_ack_signal.take();
                delivery.state = GeneratedInputDeliveryState::Stalled;
                record_delivery_failure(
                    delivery,
                    GeneratedInputDeliveryFailure::ProviderAckMissing,
                );
            }
            GeneratedInputTransportOutcome::Blocked(failure) => {
                if delivery.state != GeneratedInputDeliveryState::WritingPaste {
                    return diagnostics_changed;
                }
                delivery.provider_ack_signal.take();
                record_delivery_failure(delivery, failure);
                if let Some((_, user_input_activity)) = delivery.provider_confirmation {
                    record_confirmation_activity(delivery, user_input_activity);
                    delivery.state =
                        if manual_recovery_is_attributed(delivery, failure, user_input_activity) {
                            GeneratedInputDeliveryState::Confirmed
                        } else {
                            GeneratedInputDeliveryState::ConfirmedUnattributed
                        };
                    delivery.failure = None;
                } else {
                    delivery.state = GeneratedInputDeliveryState::Blocked;
                }
            }
            GeneratedInputTransportOutcome::Failed(failure) => {
                if delivery.state != GeneratedInputDeliveryState::WritingPaste {
                    return diagnostics_changed;
                }
                delivery.provider_ack_signal.take();
                record_delivery_failure(delivery, failure);
                if let Some((_, user_input_activity)) = delivery.provider_confirmation {
                    record_confirmation_activity(delivery, user_input_activity);
                    delivery.state =
                        if manual_recovery_is_attributed(delivery, failure, user_input_activity) {
                            GeneratedInputDeliveryState::Confirmed
                        } else {
                            GeneratedInputDeliveryState::ConfirmedUnattributed
                        };
                    delivery.failure = None;
                } else {
                    delivery.state = GeneratedInputDeliveryState::Failed;
                }
            }
        }
        true
    }

    pub fn confirm_provider_submission(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence: u64,
        user_input_activity: Option<UserInputActivitySnapshot>,
    ) -> bool {
        let Some(delivery) = self.deliveries.get_mut(session_id) else {
            return false;
        };
        if delivery.runtime_epoch != runtime_epoch
            || provider_sequence <= delivery.provider_sequence_baseline
        {
            return false;
        }
        if delivery.state == GeneratedInputDeliveryState::WritingPaste {
            delivery.provider_confirmation = Some(match delivery.provider_confirmation {
                Some((current, current_user_input)) if current > provider_sequence => {
                    (current, current_user_input)
                }
                _ => (provider_sequence, user_input_activity),
            });
            signal_provider_ack(delivery);
            return false;
        }
        let next_state = match delivery.state {
            GeneratedInputDeliveryState::AwaitingProviderAck
            | GeneratedInputDeliveryState::Stalled => GeneratedInputDeliveryState::Confirmed,
            GeneratedInputDeliveryState::Blocked | GeneratedInputDeliveryState::Failed => delivery
                .failure
                .filter(|failure| {
                    manual_recovery_is_attributed(delivery, *failure, user_input_activity)
                })
                .map_or(GeneratedInputDeliveryState::ConfirmedUnattributed, |_| {
                    GeneratedInputDeliveryState::Confirmed
                }),
            _ => return false,
        };
        delivery.provider_confirmation = Some((provider_sequence, user_input_activity));
        record_confirmation_activity(delivery, user_input_activity);
        delivery.state = next_state;
        delivery.failure = None;
        signal_provider_ack(delivery);
        true
    }

    /// A newer turn-lifecycle observation resolves the narrow attribution gap
    /// left when a provider submission raced with client input. The original
    /// transport failure and input-mutation diagnostics remain available, but
    /// a tool/permission/completion signal after the submitted turn proves the
    /// provider progressed beyond that exact confirmation boundary.
    pub fn confirm_provider_progress(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence: u64,
    ) -> bool {
        let Some(delivery) = self.deliveries.get_mut(session_id) else {
            return false;
        };
        if delivery.runtime_epoch != runtime_epoch
            || delivery.state != GeneratedInputDeliveryState::ConfirmedUnattributed
        {
            return false;
        }
        let Some((confirmation_sequence, _)) = delivery.provider_confirmation else {
            return false;
        };
        if provider_sequence <= confirmation_sequence {
            return false;
        }
        delivery.state = GeneratedInputDeliveryState::Confirmed;
        delivery.failure = None;
        signal_provider_ack(delivery);
        true
    }

    fn fail_immediately(&mut self, session_id: &str, failure: GeneratedInputDeliveryFailure) {
        if let Some(delivery) = self.deliveries.get_mut(session_id) {
            delivery.provider_ack_signal.take();
            delivery.state = GeneratedInputDeliveryState::Failed;
            record_delivery_failure(delivery, failure);
        }
    }

    fn evict_oldest_terminal_delivery(&mut self) {
        let Some(index) = self.order.iter().position(|session_id| {
            self.deliveries
                .get(session_id)
                .is_some_and(|delivery| !delivery.state.is_active())
        }) else {
            return;
        };
        if let Some(session_id) = self.order.remove(index) {
            self.deliveries.remove(&session_id);
        }
    }
}

fn signal_provider_ack(delivery: &mut GeneratedInputDelivery) {
    if let Some(signal) = delivery.provider_ack_signal.take() {
        let _ = signal.send(());
    }
}

fn record_delivery_failure(
    delivery: &mut GeneratedInputDelivery,
    failure: GeneratedInputDeliveryFailure,
) {
    delivery.original_failure.get_or_insert(failure);
    delivery.failure = Some(failure);
}

fn merge_transport_diagnostics(
    delivery: &mut GeneratedInputDelivery,
    diagnostics: GeneratedInputTransportDiagnostics,
) -> bool {
    let before = (
        delivery.paste_receipted,
        delivery.settlement_evidence,
        delivery.submit_receipted,
        delivery.submit_attempts,
        delivery.protocol_reply_waits,
        delivery.output_activity,
    );
    delivery.paste_receipted |= diagnostics.paste_receipted;
    if diagnostics.settlement_evidence.is_some() {
        delivery.settlement_evidence = diagnostics.settlement_evidence;
    }
    delivery.submit_receipted |= diagnostics.submit_receipted;
    delivery.submit_attempts = delivery.submit_attempts.max(diagnostics.submit_attempts);
    delivery.protocol_reply_waits = delivery
        .protocol_reply_waits
        .max(diagnostics.protocol_reply_waits);
    if diagnostics.output_activity != OutputActivityDiagnostics::default() {
        delivery.output_activity = diagnostics.output_activity;
    }
    before
        != (
            delivery.paste_receipted,
            delivery.settlement_evidence,
            delivery.submit_receipted,
            delivery.submit_attempts,
            delivery.protocol_reply_waits,
            delivery.output_activity,
        )
}

fn bounded_notification_type(value: &str) -> String {
    value.chars().take(64).collect()
}

fn record_confirmation_activity(
    delivery: &mut GeneratedInputDelivery,
    activity: Option<UserInputActivitySnapshot>,
) {
    delivery.user_input_mutated = activity.map(|activity| {
        activity.mutation_sequence != delivery.user_input_mutation_sequence_baseline
    });
}

fn submission_content_unchanged(
    delivery: &GeneratedInputDelivery,
    activity: Option<UserInputActivitySnapshot>,
) -> bool {
    activity.is_some_and(|activity| {
        activity.sequence >= delivery.user_input_sequence_baseline
            && activity.mutation_sequence == delivery.user_input_mutation_sequence_baseline
    })
}

fn manual_recovery_is_attributed(
    delivery: &GeneratedInputDelivery,
    failure: GeneratedInputDeliveryFailure,
    activity: Option<UserInputActivitySnapshot>,
) -> bool {
    matches!(
        failure,
        GeneratedInputDeliveryFailure::OutputDidNotSettle
            | GeneratedInputDeliveryFailure::UserInputInterleaved
            | GeneratedInputDeliveryFailure::SubmitWriteFailed
    ) && submission_content_unchanged(delivery, activity)
}

pub struct GeneratedInputRuntimeEvent {
    session_id: String,
    runtime_epoch: u64,
    delivery_id: u64,
    outcome: GeneratedInputTransportOutcome,
    diagnostics: GeneratedInputTransportDiagnostics,
}

impl GeneratedInputRuntimeEvent {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }
}

enum GeneratedInputTransportOutcome {
    Submitted,
    SubmitRetried,
    SubmitRetryFailed(GeneratedInputDeliveryFailure),
    ProviderAckTimedOut,
    Blocked(GeneratedInputDeliveryFailure),
    Failed(GeneratedInputDeliveryFailure),
}

enum SubmitAttemptFailure {
    Blocked(GeneratedInputDeliveryFailure),
    Failed(GeneratedInputDeliveryFailure),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct GeneratedInputTransportDiagnostics {
    paste_receipted: bool,
    settlement_evidence: Option<OutputSettlementEvidence>,
    submit_receipted: bool,
    submit_attempts: u8,
    protocol_reply_waits: u8,
    output_activity: OutputActivityDiagnostics,
}

struct GeneratedInputTransportResult {
    outcome: GeneratedInputTransportOutcome,
    diagnostics: GeneratedInputTransportDiagnostics,
    retry_readiness_baseline: Option<InputReadinessSnapshot>,
    retry_output_baseline: Option<termloop_terminal::OutputActivitySnapshot>,
}

struct GeneratedInputTransportPlan {
    terminal: TerminalService,
    session_id: String,
    runtime_epoch: u64,
    submission: GeneratedTerminalSubmission,
    input_readiness: InputReadinessSnapshot,
    prepared_paste: Option<(
        termloop_terminal::PendingInputWrite,
        termloop_terminal::OutputActivitySnapshot,
    )>,
    settlement: GeneratedInputSettlement,
    cancel_submit: Arc<AtomicBool>,
    paste_started: Arc<AtomicBool>,
}

fn run_transport_delivery(plan: GeneratedInputTransportPlan) -> GeneratedInputTransportResult {
    let GeneratedInputTransportPlan {
        terminal,
        session_id,
        runtime_epoch,
        submission,
        input_readiness,
        prepared_paste,
        settlement,
        cancel_submit,
        paste_started,
    } = plan;
    let mut diagnostics = GeneratedInputTransportDiagnostics::default();
    if settlement == GeneratedInputSettlement::CodexComposerRender {
        let readiness = wait_for_codex_composer_ready(input_readiness, &cancel_submit);
        if let Err(failure) = readiness {
            let outcome = if cancel_submit.load(Ordering::Acquire) {
                GeneratedInputTransportOutcome::Blocked(
                    GeneratedInputDeliveryFailure::ComposerUnavailable,
                )
            } else {
                match failure {
                    OutputSettlementFailure::TimedOut => GeneratedInputTransportOutcome::Blocked(
                        GeneratedInputDeliveryFailure::ComposerNotReady,
                    ),
                    OutputSettlementFailure::TerminalClosed => {
                        GeneratedInputTransportOutcome::Failed(
                            GeneratedInputDeliveryFailure::TerminalClosed,
                        )
                    }
                    OutputSettlementFailure::TrackerUnavailable
                    | OutputSettlementFailure::InvalidWindow => {
                        GeneratedInputTransportOutcome::Failed(
                            GeneratedInputDeliveryFailure::TerminalUnavailable,
                        )
                    }
                }
            };
            return transport_result(outcome, diagnostics, None);
        }
    }
    let (paste_write, output_before_paste) = match prepared_paste {
        Some(prepared) => prepared,
        None => {
            if cancel_submit.load(Ordering::Acquire) {
                return transport_result(
                    GeneratedInputTransportOutcome::Blocked(
                        GeneratedInputDeliveryFailure::ComposerUnavailable,
                    ),
                    diagnostics,
                    None,
                );
            }
            let output_before_paste =
                match terminal.output_activity_snapshot(&session_id, runtime_epoch) {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        return transport_result(
                            GeneratedInputTransportOutcome::Failed(
                                GeneratedInputDeliveryFailure::TerminalUnavailable,
                            ),
                            diagnostics,
                            None,
                        );
                    }
                };
            paste_started.store(true, Ordering::Release);
            let paste_write = match terminal.input_atomic_receipted(
                &session_id,
                runtime_epoch,
                submission.paste_input(),
            ) {
                Ok(pending) => pending,
                Err(TerminalError::SessionNotFound) => {
                    return transport_result(
                        GeneratedInputTransportOutcome::Failed(
                            GeneratedInputDeliveryFailure::TerminalClosed,
                        ),
                        diagnostics,
                        Some(&output_before_paste),
                    );
                }
                Err(_) => {
                    return transport_result(
                        GeneratedInputTransportOutcome::Failed(
                            GeneratedInputDeliveryFailure::TerminalUnavailable,
                        ),
                        diagnostics,
                        Some(&output_before_paste),
                    );
                }
            };
            (paste_write, output_before_paste)
        }
    };
    let paste_receipt = match paste_write.wait(WRITE_RECEIPT_TIMEOUT) {
        Ok(receipt) => receipt,
        Err(_) => {
            return transport_result(
                GeneratedInputTransportOutcome::Failed(
                    GeneratedInputDeliveryFailure::PasteWriteFailed,
                ),
                diagnostics,
                None,
            );
        }
    };
    diagnostics.paste_receipted = true;
    let output_after_flush = paste_receipt.output_after_write;
    if cancel_submit.load(Ordering::Acquire) {
        return transport_result(
            GeneratedInputTransportOutcome::Blocked(
                GeneratedInputDeliveryFailure::ComposerUnavailable,
            ),
            diagnostics,
            Some(&output_after_flush),
        );
    }
    // A PTY flush proves byte delivery, and an unchanged synchronized-output
    // frame proves only that one render frame ended. Neither proves that
    // Claude/Codex expanded the bracketed paste into a submit-ready composer.
    // A completed frame whose final composer cursor moved is causal evidence.
    // A multiline composer can keep that cursor fixed, so a structural
    // composer-surface rewrite instead settles independently of unrelated
    // status animation. TUIs without either proof retain show-cursor
    // quiescence. Every branch preserves one Enter and still refuses to splice
    // it into a half-written terminal-protocol reply. Client edits already
    // serialized after the paste no longer withhold that one submit.
    let output_observed_before_flush_receipt =
        output_after_flush.sequence() > output_before_paste.sequence();
    let settlement = match settlement {
        // A child can consume the paste and finish its composer render before
        // the PTY writer reports the later flush receipt, especially through
        // Windows ConPTY. Keep the render baseline causally before the paste;
        // the receipt above still independently proves write and flush.
        GeneratedInputSettlement::ComposerRender
        | GeneratedInputSettlement::CodexComposerRender => output_before_paste
            .wait_for_composer_render_settlement(
                COMPOSER_RENDER_SETTLEMENT_QUIET,
                COMPOSER_RENDER_SETTLEMENT_TIMEOUT,
            ),
        GeneratedInputSettlement::OutputActivity | GeneratedInputSettlement::ProviderQueue
            if output_observed_before_flush_receipt =>
        {
            output_after_flush.wait_for_settlement_after_observed_activity(
                OUTPUT_ACTIVITY_SETTLEMENT_QUIET,
                OUTPUT_ACTIVITY_SETTLEMENT_TIMEOUT,
            )
        }
        GeneratedInputSettlement::OutputActivity | GeneratedInputSettlement::ProviderQueue => {
            output_after_flush.wait_for_settlement(
                OUTPUT_ACTIVITY_SETTLEMENT_QUIET,
                OUTPUT_ACTIVITY_SETTLEMENT_TIMEOUT,
            )
        }
    };
    match settlement {
        Ok(receipt) => diagnostics.settlement_evidence = Some(receipt.evidence),
        Err(OutputSettlementFailure::TimedOut) => {
            return transport_result(
                GeneratedInputTransportOutcome::Blocked(
                    GeneratedInputDeliveryFailure::OutputDidNotSettle,
                ),
                diagnostics,
                Some(&output_after_flush),
            );
        }
        Err(OutputSettlementFailure::TerminalClosed) => {
            return transport_result(
                GeneratedInputTransportOutcome::Failed(
                    GeneratedInputDeliveryFailure::TerminalClosed,
                ),
                diagnostics,
                Some(&output_after_flush),
            );
        }
        Err(
            OutputSettlementFailure::TrackerUnavailable | OutputSettlementFailure::InvalidWindow,
        ) => {
            return transport_result(
                GeneratedInputTransportOutcome::Failed(
                    GeneratedInputDeliveryFailure::TerminalUnavailable,
                ),
                diagnostics,
                Some(&output_after_flush),
            );
        }
    }
    if cancel_submit.load(Ordering::Acquire) {
        return transport_result(
            GeneratedInputTransportOutcome::Blocked(
                GeneratedInputDeliveryFailure::ComposerUnavailable,
            ),
            diagnostics,
            Some(&output_after_flush),
        );
    }
    let retry_readiness_baseline = terminal
        .input_readiness_snapshot(&session_id, runtime_epoch)
        .ok();
    let (outcome, retry_output_baseline) = match write_submit_attempt(
        &terminal,
        &session_id,
        runtime_epoch,
        submission.submit_input(),
        1,
        &mut diagnostics,
    ) {
        Ok(output_after_submit) => (
            GeneratedInputTransportOutcome::Submitted,
            Some(output_after_submit),
        ),
        Err(SubmitAttemptFailure::Blocked(failure)) => {
            (GeneratedInputTransportOutcome::Blocked(failure), None)
        }
        Err(SubmitAttemptFailure::Failed(failure)) => {
            (GeneratedInputTransportOutcome::Failed(failure), None)
        }
    };
    let mut result = transport_result(outcome, diagnostics, Some(&output_after_flush));
    result.retry_readiness_baseline = retry_readiness_baseline;
    result.retry_output_baseline = retry_output_baseline;
    result
}

fn wait_for_codex_composer_ready(
    mut readiness: InputReadinessSnapshot,
    cancel_submit: &AtomicBool,
) -> Result<(), OutputSettlementFailure> {
    let deadline = termloop_platform::MonotonicDeadline::after(CODEX_COMPOSER_READY_TIMEOUT)
        .map_err(|_| OutputSettlementFailure::InvalidWindow)?;
    loop {
        if codex_composer_is_ready(readiness.facts()) {
            return Ok(());
        }
        if cancel_submit.load(Ordering::Acquire) {
            return Err(OutputSettlementFailure::TimedOut);
        }
        let remaining = deadline
            .remaining()
            .ok_or(OutputSettlementFailure::TimedOut)?;
        let wait_for = remaining.min(Duration::from_millis(100));
        match readiness.wait_for_change(wait_for) {
            Ok(_) => {}
            Err(OutputSettlementFailure::TimedOut) if deadline.remaining().is_some() => {}
            Err(failure) => return Err(failure),
        }
    }
}

fn codex_composer_is_ready(facts: termloop_terminal::InputReadinessFacts) -> bool {
    if termloop_platform::host_uses_bracketed_paste_framing() {
        facts.bracketed_paste_enabled && facts.composer_prompt_seen_after_bracketed_paste
    } else {
        facts.alternate_screen_active && facts.composer_prompt_seen_in_current_alternate_screen
    }
}

fn submit_retry_has_structural_evidence(
    settlement: GeneratedInputSettlement,
    readiness_baseline: Option<&InputReadinessSnapshot>,
    output_baseline: Option<&termloop_terminal::OutputActivitySnapshot>,
) -> bool {
    let composer_redrew = output_baseline
        .and_then(|snapshot| snapshot.diagnostics_since().ok())
        .is_some_and(|diagnostics| diagnostics.completed_composer_frames > 0);
    match settlement {
        GeneratedInputSettlement::CodexComposerRender => {
            let Some(readiness_baseline) = readiness_baseline else {
                return false;
            };
            let baseline = readiness_baseline.facts();
            readiness_baseline
                .current_facts()
                .ok()
                .is_some_and(|current| {
                    composer_redrew
                        && current.composer_prompt_ready_count
                            > baseline.composer_prompt_ready_count
                        && codex_composer_is_ready(current)
                })
        }
        GeneratedInputSettlement::ComposerRender => composer_redrew,
        GeneratedInputSettlement::OutputActivity | GeneratedInputSettlement::ProviderQueue => false,
    }
}

fn write_submit_attempt(
    terminal: &TerminalService,
    session_id: &str,
    runtime_epoch: u64,
    submit_input: &[u8],
    attempt: u8,
    diagnostics: &mut GeneratedInputTransportDiagnostics,
) -> Result<termloop_terminal::OutputActivitySnapshot, SubmitAttemptFailure> {
    diagnostics.submit_attempts = diagnostics.submit_attempts.max(attempt);
    let mut protocol_settlement_waits = 0;
    let submit_write = loop {
        match terminal.input_atomic_receipted_if_protocol_settled(
            session_id,
            runtime_epoch,
            submit_input,
        ) {
            Ok(pending) => break pending,
            Err(TerminalError::SessionNotFound) => {
                return Err(SubmitAttemptFailure::Failed(
                    GeneratedInputDeliveryFailure::TerminalClosed,
                ));
            }
            Err(TerminalError::ProtocolReplyPending)
                if protocol_settlement_waits < MAX_PROTOCOL_REPLY_SETTLEMENT_WAITS =>
            {
                protocol_settlement_waits += 1;
                diagnostics.protocol_reply_waits =
                    diagnostics.protocol_reply_waits.saturating_add(1);
                match terminal.wait_for_client_protocol_reply_settlement(
                    session_id,
                    runtime_epoch,
                    PROTOCOL_REPLY_SETTLEMENT_TIMEOUT,
                ) {
                    Ok(true) => continue,
                    Ok(false) => {
                        return Err(SubmitAttemptFailure::Blocked(
                            GeneratedInputDeliveryFailure::UserInputInterleaved,
                        ));
                    }
                    Err(TerminalError::SessionNotFound) => {
                        return Err(SubmitAttemptFailure::Failed(
                            GeneratedInputDeliveryFailure::TerminalClosed,
                        ));
                    }
                    Err(_) => {
                        return Err(SubmitAttemptFailure::Failed(
                            GeneratedInputDeliveryFailure::TerminalUnavailable,
                        ));
                    }
                }
            }
            Err(TerminalError::ProtocolReplyPending) => {
                return Err(SubmitAttemptFailure::Blocked(
                    GeneratedInputDeliveryFailure::UserInputInterleaved,
                ));
            }
            Err(_) => {
                return Err(SubmitAttemptFailure::Failed(
                    GeneratedInputDeliveryFailure::SubmitWriteFailed,
                ));
            }
        }
    };
    match submit_write.wait(WRITE_RECEIPT_TIMEOUT) {
        Ok(receipt) => {
            diagnostics.submit_receipted = true;
            Ok(receipt.output_after_write)
        }
        Err(
            InputWriteFailure::Write { .. }
            | InputWriteFailure::Flush { .. }
            | InputWriteFailure::ReceiptTimedOut { .. }
            | InputWriteFailure::WriterStopped { .. }
            | InputWriteFailure::OutputBarrierUnavailable { .. },
        ) => Err(SubmitAttemptFailure::Failed(
            GeneratedInputDeliveryFailure::SubmitWriteFailed,
        )),
    }
}

fn transport_result(
    outcome: GeneratedInputTransportOutcome,
    mut diagnostics: GeneratedInputTransportDiagnostics,
    output_after_flush: Option<&termloop_terminal::OutputActivitySnapshot>,
) -> GeneratedInputTransportResult {
    if let Some(output_after_flush) = output_after_flush
        && let Ok(activity) = output_after_flush.diagnostics_since()
    {
        diagnostics.output_activity = activity;
    }
    GeneratedInputTransportResult {
        outcome,
        diagnostics,
        retry_readiness_baseline: None,
        retry_output_baseline: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_readiness_requires_a_live_composer_and_the_host_paste_handshake() {
        let ready = termloop_terminal::InputReadinessFacts {
            sequence: 3,
            bracketed_paste_enabled: true,
            alternate_screen_active: true,
            composer_prompt_seen_in_current_alternate_screen: true,
            composer_prompt_render_count: 1,
            composer_prompt_seen_after_bracketed_paste: true,
            composer_prompt_ready_count: 1,
        };
        assert!(codex_composer_is_ready(ready));
        assert!(!codex_composer_is_ready(
            termloop_terminal::InputReadinessFacts {
                composer_prompt_seen_after_bracketed_paste: false,
                composer_prompt_seen_in_current_alternate_screen: false,
                alternate_screen_active: false,
                ..ready
            }
        ));
        assert_eq!(
            codex_composer_is_ready(termloop_terminal::InputReadinessFacts {
                bracketed_paste_enabled: false,
                ..ready
            }),
            !termloop_platform::host_uses_bracketed_paste_framing()
        );
    }

    #[test]
    fn confirmation_requires_newer_same_epoch_provider_evidence() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        let (provider_ack_signal, provider_ack_wait) = std::sync::mpsc::channel();
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::AwaitingProviderAck,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                submit_receipted: true,
                submit_attempts: 1,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(false)),
                provider_ack_signal: Some(provider_ack_signal),
            },
        );

        assert!(!runtime.confirm_provider_submission("session", 8, 11, Some(activity(4, 3))));
        assert!(!runtime.confirm_provider_submission("session", 7, 10, Some(activity(4, 3))));
        assert!(runtime.confirm_provider_submission("session", 7, 11, Some(activity(4, 3))));
        assert!(
            provider_ack_wait
                .recv_timeout(Duration::from_millis(20))
                .is_ok()
        );
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Confirmed)
        );
    }

    #[test]
    fn provider_ack_that_races_transport_receipt_is_not_lost() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 3,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::WritingPaste,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: false,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(false)),
                provider_ack_signal: None,
            },
        );

        assert!(!runtime.confirm_provider_submission("session", 7, 11, Some(activity(5, 4))));
        assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
            session_id: "session".into(),
            runtime_epoch: 7,
            delivery_id: 3,
            outcome: GeneratedInputTransportOutcome::Submitted,
            diagnostics: GeneratedInputTransportDiagnostics {
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence,),
                submit_receipted: true,
                ..GeneratedInputTransportDiagnostics::default()
            },
        }));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Confirmed)
        );
        assert_eq!(
            runtime
                .diagnostics("session", 7)
                .unwrap()
                .user_input_mutated,
            Some(true)
        );
    }

    #[test]
    fn newer_provider_ack_confirms_receipted_submit_after_user_input() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::AwaitingProviderAck,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                submit_receipted: true,
                submit_attempts: 1,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(false)),
                provider_ack_signal: None,
            },
        );

        assert!(runtime.confirm_provider_submission("session", 7, 11, Some(activity(5, 4))));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Confirmed)
        );
        assert_eq!(
            runtime
                .diagnostics("session", 7)
                .unwrap()
                .user_input_mutated,
            Some(true)
        );
        assert!(runtime.accepts_new_submission("session", 7));
    }

    #[test]
    fn missing_provider_ack_stalls_after_one_retry_and_late_ack_recovers() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::AwaitingProviderAck,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                submit_receipted: true,
                submit_attempts: 1,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(false)),
                provider_ack_signal: None,
            },
        );

        assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
            session_id: "session".into(),
            runtime_epoch: 7,
            delivery_id: 1,
            outcome: GeneratedInputTransportOutcome::SubmitRetried,
            diagnostics: GeneratedInputTransportDiagnostics {
                submit_receipted: true,
                submit_attempts: 2,
                ..GeneratedInputTransportDiagnostics::default()
            },
        }));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::AwaitingProviderAck)
        );
        assert_eq!(
            runtime.diagnostics("session", 7).unwrap().submit_attempts,
            2
        );

        assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
            session_id: "session".into(),
            runtime_epoch: 7,
            delivery_id: 1,
            outcome: GeneratedInputTransportOutcome::ProviderAckTimedOut,
            diagnostics: GeneratedInputTransportDiagnostics::default(),
        }));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Stalled)
        );
        assert_eq!(
            runtime.failure("session", 7),
            Some(GeneratedInputDeliveryFailure::ProviderAckMissing)
        );

        assert!(runtime.confirm_provider_submission("session", 7, 11, Some(activity(4, 3))));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Confirmed)
        );
        assert_eq!(
            runtime.diagnostics("session", 7).unwrap().original_failure,
            Some(GeneratedInputDeliveryFailure::ProviderAckMissing)
        );
    }

    #[test]
    fn unavailable_composer_cancels_submit_without_replaying_content() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        let cancel_submit = Arc::new(AtomicBool::new(false));
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::WritingPaste,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: false,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::clone(&cancel_submit),
                provider_ack_signal: None,
            },
        );

        assert!(runtime.block_for_unavailable_composer(
            "session",
            7,
            10,
            test_submission(),
            GeneratedInputDeliveryCancelCause::Notification,
            Some("permission_prompt"),
        ));
        assert!(cancel_submit.load(Ordering::Acquire));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Blocked)
        );
        assert_eq!(
            runtime.failure("session", 7),
            Some(GeneratedInputDeliveryFailure::ComposerUnavailable)
        );
        assert_eq!(
            runtime.diagnostics("session", 7).unwrap(),
            GeneratedInputDeliveryDiagnostics {
                original_failure: Some(GeneratedInputDeliveryFailure::ComposerUnavailable),
                cancel_cause: Some(GeneratedInputDeliveryCancelCause::Notification),
                cancel_notification_type: Some("permission_prompt".into()),
                paste_receipted: false,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
            }
        );
        assert!(!runtime.accepts_new_submission("session", 7));
        assert!(!runtime.can_begin_pending_submission("session", 7));
    }

    #[test]
    fn unavailable_composer_before_paste_can_start_same_pending_submission_once_idle() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();

        assert!(runtime.block_for_unavailable_composer(
            "session",
            7,
            10,
            test_submission(),
            GeneratedInputDeliveryCancelCause::Notification,
            Some("permission_prompt"),
        ));
        assert!(!runtime.accepts_new_submission("session", 7));
        assert!(runtime.can_begin_pending_submission("session", 7));

        // No terminal is registered in this unit seam, so the safe first
        // transport attempt fails immediately. Its retained evidence proves
        // that the pre-paste block was not erased or misreported as a replay.
        assert!(runtime.begin(
            &TerminalService::default(),
            "session",
            7,
            11,
            test_submission(),
            GeneratedInputSettlement::ComposerRender,
        ));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Failed)
        );
        assert_eq!(
            runtime.failure("session", 7),
            Some(GeneratedInputDeliveryFailure::TerminalUnavailable)
        );
        let diagnostics = runtime.diagnostics("session", 7).unwrap();
        assert_eq!(
            diagnostics.original_failure,
            Some(GeneratedInputDeliveryFailure::ComposerUnavailable)
        );
        assert_eq!(
            diagnostics.cancel_cause,
            Some(GeneratedInputDeliveryCancelCause::Notification)
        );
        assert_eq!(
            diagnostics.cancel_notification_type.as_deref(),
            Some("permission_prompt")
        );
        assert!(!diagnostics.paste_receipted);
    }

    #[test]
    fn submit_only_manual_recovery_confirms_blocked_or_failed_delivery() {
        for (state, failure) in [
            (
                GeneratedInputDeliveryState::Blocked,
                GeneratedInputDeliveryFailure::UserInputInterleaved,
            ),
            (
                GeneratedInputDeliveryState::Failed,
                GeneratedInputDeliveryFailure::SubmitWriteFailed,
            ),
        ] {
            let mut runtime = GeneratedInputDeliveryRuntime::default();
            runtime.deliveries.insert(
                "session".into(),
                GeneratedInputDelivery {
                    id: 1,
                    runtime_epoch: 7,
                    provider_sequence_baseline: 10,
                    submission: test_submission(),
                    state,
                    failure: Some(failure),
                    original_failure: Some(failure),
                    cancel_cause: None,
                    cancel_notification_type: None,
                    paste_started: Arc::new(AtomicBool::new(true)),
                    paste_receipted: true,
                    settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                    submit_receipted: false,
                    submit_attempts: 0,
                    protocol_reply_waits: 0,
                    user_input_mutated: None,
                    output_activity: OutputActivityDiagnostics::default(),
                    user_input_sequence_baseline: 4,
                    user_input_mutation_sequence_baseline: 3,
                    provider_confirmation: None,
                    cancel_submit: Arc::new(AtomicBool::new(true)),
                    provider_ack_signal: None,
                },
            );

            assert!(runtime.confirm_provider_submission("session", 7, 11, Some(activity(5, 3))));
            assert_eq!(
                runtime.state("session", 7),
                Some(GeneratedInputDeliveryState::Confirmed)
            );
            assert_eq!(runtime.failure("session", 7), None);
            assert_eq!(
                runtime.diagnostics("session", 7).unwrap().original_failure,
                Some(failure)
            );
            assert_eq!(
                runtime
                    .diagnostics("session", 7)
                    .unwrap()
                    .user_input_mutated,
                Some(false)
            );
            assert!(runtime.accepts_new_submission("session", 7));
        }
    }

    #[test]
    fn mutating_manual_recovery_confirms_after_later_provider_progress() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::Blocked,
                failure: Some(GeneratedInputDeliveryFailure::OutputDidNotSettle),
                original_failure: Some(GeneratedInputDeliveryFailure::OutputDidNotSettle),
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: None,
                submit_receipted: false,
                submit_attempts: 0,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::new(AtomicBool::new(true)),
                provider_ack_signal: None,
            },
        );

        assert!(runtime.confirm_provider_submission("session", 7, 11, Some(activity(5, 4))));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::ConfirmedUnattributed)
        );
        assert!(
            !runtime.confirm_provider_progress("session", 7, 11),
            "the same PromptSubmitted sequence is not additional progress"
        );
        assert_eq!(
            runtime.diagnostics("session", 7).unwrap().original_failure,
            Some(GeneratedInputDeliveryFailure::OutputDidNotSettle)
        );
        assert_eq!(
            runtime
                .diagnostics("session", 7)
                .unwrap()
                .user_input_mutated,
            Some(true)
        );
        assert!(runtime.confirm_provider_progress("session", 7, 12));
        assert_eq!(
            runtime.state("session", 7),
            Some(GeneratedInputDeliveryState::Confirmed)
        );
        assert_eq!(
            runtime.diagnostics("session", 7).unwrap().original_failure,
            Some(GeneratedInputDeliveryFailure::OutputDidNotSettle),
            "healing the live state must retain the first delivery failure"
        );
    }

    #[test]
    fn runtime_epoch_change_requires_explicit_resubmission() {
        let mut runtime = GeneratedInputDeliveryRuntime::default();
        let cancel_submit = Arc::new(AtomicBool::new(false));
        runtime.deliveries.insert(
            "session".into(),
            GeneratedInputDelivery {
                id: 1,
                runtime_epoch: 7,
                provider_sequence_baseline: 10,
                submission: test_submission(),
                state: GeneratedInputDeliveryState::AwaitingProviderAck,
                failure: None,
                original_failure: None,
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                submit_receipted: true,
                submit_attempts: 1,
                protocol_reply_waits: 0,
                user_input_mutated: None,
                output_activity: OutputActivityDiagnostics::default(),
                user_input_sequence_baseline: 4,
                user_input_mutation_sequence_baseline: 3,
                provider_confirmation: None,
                cancel_submit: Arc::clone(&cancel_submit),
                provider_ack_signal: None,
            },
        );

        assert!(runtime.transition_runtime_epoch("session", 8));
        assert!(cancel_submit.load(Ordering::Acquire));
        assert_eq!(runtime.state("session", 7), None);
        assert_eq!(
            runtime.state("session", 8),
            Some(GeneratedInputDeliveryState::RequiresUserResubmit)
        );
        assert_eq!(
            runtime.failure("session", 8),
            Some(GeneratedInputDeliveryFailure::RuntimeEpochChanged)
        );
        assert!(!runtime.confirm_provider_submission("session", 7, 11, Some(activity(4, 3))));
        assert!(runtime.accepts_new_submission("session", 8));
    }

    fn activity(sequence: u64, mutation_sequence: u64) -> UserInputActivitySnapshot {
        UserInputActivitySnapshot {
            sequence,
            mutation_sequence,
        }
    }

    fn test_submission() -> GeneratedTerminalSubmission {
        termloop_invocation::quick_action_agent_for_conversation(
            "codex",
            "/tmp",
            "default",
            "default",
            "default",
            "test prompt",
            termloop_invocation::AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap()
        .initial_input_submission()
        .unwrap()
    }
}
