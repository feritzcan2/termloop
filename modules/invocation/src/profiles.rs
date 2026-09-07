use super::PromptTemplate;

pub(super) const SCATTERED_ORCHESTRATION_FINDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent-profile.scattered-orchestration-finder",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent-profile.scattered-orchestration-finder.md"
    ),
};

pub(super) const EDGE_CASE_HUNTER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent-profile.edge-case-hunter",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent-profile.edge-case-hunter.md"
    ),
};

pub(super) const TEST_GAP_FINDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent-profile.test-gap-finder",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent-profile.test-gap-finder.md"
    ),
};

pub(super) const ARCHITECTURE_BOUNDARY_REVIEWER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent-profile.architecture-boundary-reviewer",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent-profile.architecture-boundary-reviewer.md"
    ),
};

#[derive(Debug, Clone, Copy)]
pub struct AgentProfile {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub version: u32,
    pub permission: &'static str,
    pub read_only: bool,
    pub user_invocable: bool,
    pub supported_agent_ids: &'static [&'static str],
    template: PromptTemplate,
}

impl AgentProfile {
    pub fn instructions(&self) -> &'static str {
        self.template.authored_body
    }

    pub(super) fn template(&self) -> &PromptTemplate {
        &self.template
    }
}

const INSPECTABLE_AGENT_IDS: &[&str] = &["claude", "codex"];

static AGENT_PROFILES: [AgentProfile; 4] = [
    AgentProfile {
        id: SCATTERED_ORCHESTRATION_FINDER_TEMPLATE.id,
        name: "Scattered Orchestration Finder",
        description: "Find one workflow whose orchestration is spread across unrelated owners.",
        category: "Architecture",
        version: SCATTERED_ORCHESTRATION_FINDER_TEMPLATE.version,
        permission: "plan",
        read_only: true,
        user_invocable: true,
        supported_agent_ids: INSPECTABLE_AGENT_IDS,
        template: SCATTERED_ORCHESTRATION_FINDER_TEMPLATE,
    },
    AgentProfile {
        id: EDGE_CASE_HUNTER_TEMPLATE.id,
        name: "Edge Case Hunter",
        description: "Probe a behavior for boundary conditions, races, and failure-path gaps.",
        category: "Quality",
        version: EDGE_CASE_HUNTER_TEMPLATE.version,
        permission: "plan",
        read_only: true,
        user_invocable: true,
        supported_agent_ids: INSPECTABLE_AGENT_IDS,
        template: EDGE_CASE_HUNTER_TEMPLATE,
    },
    AgentProfile {
        id: TEST_GAP_FINDER_TEMPLATE.id,
        name: "Test Gap Finder",
        description: "Compare production behavior with tests and identify the highest-value gaps.",
        category: "Quality",
        version: TEST_GAP_FINDER_TEMPLATE.version,
        permission: "plan",
        read_only: true,
        user_invocable: true,
        supported_agent_ids: INSPECTABLE_AGENT_IDS,
        template: TEST_GAP_FINDER_TEMPLATE,
    },
    AgentProfile {
        id: ARCHITECTURE_BOUNDARY_REVIEWER_TEMPLATE.id,
        name: "Architecture Boundary Reviewer",
        description: "Review ownership and dependency boundaries against repository rules.",
        category: "Architecture",
        version: ARCHITECTURE_BOUNDARY_REVIEWER_TEMPLATE.version,
        permission: "plan",
        read_only: true,
        user_invocable: true,
        supported_agent_ids: INSPECTABLE_AGENT_IDS,
        template: ARCHITECTURE_BOUNDARY_REVIEWER_TEMPLATE,
    },
];

pub fn agent_profiles() -> &'static [AgentProfile] {
    &AGENT_PROFILES
}

pub fn agent_profile(profile_ref: &str) -> Option<&'static AgentProfile> {
    AGENT_PROFILES
        .iter()
        .find(|profile| profile.id == profile_ref)
}
