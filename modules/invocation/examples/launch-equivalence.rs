use termloop_invocation::*;
fn main() {
    let mut rows = Vec::new();
    for provider in termloop_agents::agent_catalog() {
        for model in provider.models {
            for permission in provider.permissions {
                let launch = configured_interactive_agent_for_conversation(
                    provider.id,
                    "/tmp/engine-equivalence",
                    model,
                    permission,
                    "default",
                    AgentConversationLaunch::Fresh { resume_ref: None },
                    None,
                    None,
                )
                .unwrap();
                rows.push(serde_json::json!({"case":"selection","manifest":launch.inspectable_manifest(),"argv":launch.args(),"input":launch.initial_input_sequence()}));
            }
        }
        let launch = quick_action_agent_for_conversation(
            provider.id,
            "/tmp/engine-equivalence",
            "default",
            "default",
            "default",
            "Review this synthetic fixture. Preserve literal {{value}}.",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        rows.push(serde_json::json!({"case":"quick_action","manifest":launch.inspectable_manifest(),"argv":launch.args(),"input":launch.initial_input_sequence()}));
    }
    for template in prompt_templates() {
        rows.push(serde_json::json!({"case":"catalog","id":template.id,"version":template.version,"authored":template.authored_body}));
    }
    println!("{}", serde_json::to_string(&rows).unwrap());
}
