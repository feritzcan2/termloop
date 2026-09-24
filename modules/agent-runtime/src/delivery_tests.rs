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
fn claude_readiness_waits_for_the_unix_paste_handshake() {
    let not_ready = termloop_terminal::InputReadinessFacts::default();
    let ready = termloop_terminal::InputReadinessFacts {
        bracketed_paste_enabled: true,
        ..not_ready
    };

    assert_eq!(
        composer_is_ready(GeneratedInputSettlement::ComposerRender, not_ready),
        !termloop_platform::host_uses_bracketed_paste_framing()
    );
    assert!(composer_is_ready(
        GeneratedInputSettlement::ComposerRender,
        ready
    ));
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::AwaitingProviderAck,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: true,
            settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
            submit_receipted_signal: Arc::new(AtomicBool::new(true)),
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
fn provider_queue_confirms_only_from_progress_after_submit_receipt() {
    let mut runtime = GeneratedInputDeliveryRuntime::default();
    runtime.deliveries.insert(
        "session".into(),
        GeneratedInputDelivery {
            id: 1,
            runtime_epoch: 7,
            provider_sequence_baseline: 10,
            settlement: GeneratedInputSettlement::ProviderQueue,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::WritingPaste,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: false,
            settlement_evidence: None,
            submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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

    assert!(
        !runtime.confirm_provider_queue_progress("session", 7, 11),
        "progress racing before the submit receipt is not delivery evidence"
    );
    assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
        session_id: "session".into(),
        runtime_epoch: 7,
        delivery_id: 1,
        outcome: GeneratedInputTransportOutcome::Submitted,
        diagnostics: GeneratedInputTransportDiagnostics {
            paste_receipted: true,
            submit_receipted: true,
            submit_attempts: 1,
            ..GeneratedInputTransportDiagnostics::default()
        },
    }));
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::AwaitingProviderAck)
    );
    assert!(!runtime.confirm_provider_queue_progress("session", 8, 11));
    assert!(!runtime.confirm_provider_queue_progress("session", 7, 10));

    runtime.deliveries.get_mut("session").unwrap().settlement =
        GeneratedInputSettlement::ComposerRender;
    assert!(
        !runtime.confirm_provider_queue_progress("session", 7, 11),
        "ordinary composer delivery keeps its exact PromptSubmitted acknowledgement"
    );
    runtime.deliveries.get_mut("session").unwrap().settlement =
        GeneratedInputSettlement::ProviderQueue;

    assert!(runtime.confirm_provider_queue_progress("session", 7, 11));
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::Confirmed)
    );
}

#[test]
fn provider_queue_retains_progress_racing_the_transport_event_after_submit_receipt() {
    let mut runtime = GeneratedInputDeliveryRuntime::default();
    let submit_receipted_signal = Arc::new(AtomicBool::new(false));
    runtime.deliveries.insert(
        "session".into(),
        GeneratedInputDelivery {
            id: 1,
            runtime_epoch: 7,
            provider_sequence_baseline: 10,
            settlement: GeneratedInputSettlement::ProviderQueue,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::WritingPaste,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: false,
            settlement_evidence: None,
            submit_receipted_signal: Arc::clone(&submit_receipted_signal),
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

    assert!(!runtime.confirm_provider_queue_progress("session", 7, 11));
    assert_eq!(runtime.deliveries["session"].provider_confirmation, None);

    // The terminal worker publishes this receipt before its runtime event
    // can contend for Core's lock with the provider progress event.
    submit_receipted_signal.store(true, Ordering::Release);
    assert!(!runtime.confirm_provider_queue_progress("session", 7, 11));
    assert_eq!(
        runtime.deliveries["session"].provider_confirmation,
        Some((11, None))
    );
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::WritingPaste)
    );

    assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
        session_id: "session".into(),
        runtime_epoch: 7,
        delivery_id: 1,
        outcome: GeneratedInputTransportOutcome::Submitted,
        diagnostics: GeneratedInputTransportDiagnostics {
            paste_receipted: true,
            submit_receipted: true,
            submit_attempts: 1,
            ..GeneratedInputTransportDiagnostics::default()
        },
    }));
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::WritingPaste,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: false,
            settlement_evidence: None,
            submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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
fn manual_turn_before_paste_does_not_confirm_an_undelivered_submission() {
    let mut runtime = GeneratedInputDeliveryRuntime::default();
    runtime.deliveries.insert(
        "session".into(),
        GeneratedInputDelivery {
            id: 3,
            runtime_epoch: 7,
            provider_sequence_baseline: 10,
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::WritingPaste,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(false)),
            paste_receipted: false,
            settlement_evidence: None,
            submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::WritingPaste)
    );
    assert!(runtime.apply_transport_event(GeneratedInputRuntimeEvent {
        session_id: "session".into(),
        runtime_epoch: 7,
        delivery_id: 3,
        outcome: GeneratedInputTransportOutcome::Blocked(
            GeneratedInputDeliveryFailure::ComposerNotReady,
        ),
        diagnostics: GeneratedInputTransportDiagnostics::default(),
    }));
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::Blocked)
    );
    assert_eq!(
        runtime.failure("session", 7),
        Some(GeneratedInputDeliveryFailure::ComposerNotReady)
    );
    assert!(!runtime.confirm_provider_submission("session", 7, 12, Some(activity(6, 5))));
    assert!(!runtime.confirm_provider_progress("session", 7, 13));
    assert_eq!(
        runtime.state("session", 7),
        Some(GeneratedInputDeliveryState::Blocked)
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::AwaitingProviderAck,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: true,
            settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
            submit_receipted_signal: Arc::new(AtomicBool::new(true)),
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::AwaitingProviderAck,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: true,
            settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
            submit_receipted_signal: Arc::new(AtomicBool::new(true)),
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::WritingPaste,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: false,
            settlement_evidence: None,
            submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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
                settlement: GeneratedInputSettlement::ComposerRender,
                submission: test_submission(),
                state,
                failure: Some(failure),
                original_failure: Some(failure),
                cancel_cause: None,
                cancel_notification_type: None,
                paste_started: Arc::new(AtomicBool::new(true)),
                paste_receipted: true,
                settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
                submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::Blocked,
            failure: Some(GeneratedInputDeliveryFailure::OutputDidNotSettle),
            original_failure: Some(GeneratedInputDeliveryFailure::OutputDidNotSettle),
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: true,
            settlement_evidence: None,
            submit_receipted_signal: Arc::new(AtomicBool::new(false)),
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
            settlement: GeneratedInputSettlement::ComposerRender,
            submission: test_submission(),
            state: GeneratedInputDeliveryState::AwaitingProviderAck,
            failure: None,
            original_failure: None,
            cancel_cause: None,
            cancel_notification_type: None,
            paste_started: Arc::new(AtomicBool::new(true)),
            paste_receipted: true,
            settlement_evidence: Some(OutputSettlementEvidence::ComposerRenderQuiescence),
            submit_receipted_signal: Arc::new(AtomicBool::new(true)),
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

#[test]
fn removing_a_session_cancels_only_its_submission_and_releases_its_slot() {
    let mut runtime = GeneratedInputDeliveryRuntime::default();
    let terminal = TerminalService::default();
    for session_id in ["retiring", "survivor"] {
        assert!(runtime.begin(
            &terminal,
            session_id,
            1,
            0,
            test_submission(),
            GeneratedInputSettlement::ComposerRender,
        ));
    }
    let retiring = Arc::clone(&runtime.deliveries["retiring"].cancel_submit);
    let survivor = Arc::clone(&runtime.deliveries["survivor"].cancel_submit);
    runtime.remove_session("retiring");
    assert!(retiring.load(Ordering::Acquire));
    assert!(!survivor.load(Ordering::Acquire));
    assert!(runtime.state("retiring", 1).is_none());
    assert!(runtime.state("survivor", 1).is_some());
    assert_eq!(runtime.order, ["survivor"]);
    runtime.remove_session("retiring");
    assert!(!survivor.load(Ordering::Acquire));
}

fn activity(sequence: u64, mutation_sequence: u64) -> UserInputActivitySnapshot {
    UserInputActivitySnapshot {
        sequence,
        mutation_sequence,
    }
}

fn test_submission() -> GeneratedTerminalSubmission {
    termloop_launch::generated_submission(
        &termloop_launch::PromptTemplate {
            id: "builtin.quick-action.free-prompt",
            version: 2,
            authored_body: "fixture",
        },
        "test prompt",
    )
    .unwrap()
}
