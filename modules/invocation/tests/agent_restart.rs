use termloop_invocation::{
    agent_restart_continue_prompt, agent_restart_continue_template, prompt_templates,
};

#[test]
fn restart_continuation_delivers_the_visible_cataloged_asset() {
    let template = agent_restart_continue_template();
    assert!(
        prompt_templates()
            .iter()
            .any(|candidate| candidate.id == template.id && candidate.version == template.version)
    );
    let prompt = agent_restart_continue_prompt().unwrap();
    assert_eq!(
        prompt.provenance().template_ref,
        "builtin.agent.restart-continue"
    );
    assert_eq!(prompt.provenance().template_version, template.version);
    assert_eq!(prompt.bindings().count(), 0);
    assert_eq!(prompt.delivered_prompt(), template.authored_body.trim_end());
    assert!(
        prompt
            .delivered_prompt()
            .contains("Continue the interrupted work")
    );
    let submission = prompt.terminal_submission();
    assert_eq!(
        submission.provenance().template_ref,
        "builtin.agent.restart-continue"
    );
    assert!(!prompt.terminal_input_sequence().is_empty());
}
