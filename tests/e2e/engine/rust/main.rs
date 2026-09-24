use termloop_launch::{LaunchRequest, PromptTemplate};
fn main() {
    let template = PromptTemplate { id: "consumer.welcome", version: 1, authored_body: "Reply ENGINE_READY." };
    let cwd = std::env::current_dir().unwrap();
    let mut request = LaunchRequest::interactive("claude", cwd.to_str().unwrap(), &template);
    request.prompt = Some(template.authored_body);
    let payload = termloop_launch::resolve(request).unwrap().into_payload();
    assert!(payload.initial_input_submission().is_some());
    assert_eq!(payload.provenance().template_ref, "consumer.welcome");
    let terminal = termloop_terminal::TerminalService::default();
    let runtime = termloop_agent_runtime::ObservedSession::new("consumer".into(), 1, "claude".into(), terminal);
    assert!(runtime.observation().is_none());
    println!("EXTERNAL_ENGINE_CONSUMER_PASS");
}
