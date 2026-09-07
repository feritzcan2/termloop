use serde_json::{Value, json};
use termloop_domain::{AgentLaunchSelection, PersonalAgent};

use crate::{CoreError, CoreRuntime, required_string, store_error};

impl CoreRuntime {
    pub(crate) fn agent_library_get(&self) -> Result<Value, CoreError> {
        let library = self.store.agent_library();
        let mut profiles: Vec<Value> = termloop_invocation::agent_profiles().iter().map(|profile| json!({
            "id": profile.id, "name": profile.name, "description": profile.description,
            "category": profile.category, "version": profile.version, "permission": profile.permission,
            "read_only": profile.read_only, "user_invocable": profile.user_invocable,
            "agent_ids": profile.supported_agent_ids, "instructions": profile.instructions(),
            "source": "builtIn", "favorite": library.favorites.iter().any(|id| id == profile.id),
            "default_agent_id": "codex", "default_model": "default", "default_reasoning": "default",
        })).collect();
        profiles.extend(library.agents.iter().map(|profile| json!({
            "id": profile.id, "name": profile.name, "description": profile.description,
            "category": profile.category, "version": profile.version, "permission": profile.selection.permission,
            "read_only": profile.selection.permission == "plan", "user_invocable": true,
            "agent_ids": ["claude", "codex"], "instructions": profile.instructions,
            "source": "personal", "favorite": library.favorites.contains(&profile.id),
            "default_agent_id": profile.agent_id, "default_model": profile.selection.model,
            "default_reasoning": profile.selection.reasoning,
        })));
        Ok(json!({"revision": library.revision, "profiles": profiles}))
    }

    pub(crate) fn create_agent_profile(&mut self, params: Value) -> Result<Value, CoreError> {
        let id = format!(
            "custom.agent-profile.agent-{}",
            termloop_platform::generate_capability_token()
        );
        let profile = personal_agent(&params, id, 1)?;
        self.store
            .update_personal_agent(&self.write_authority, profile, revision(&params)?)
            .map_err(store_error)?;
        self.agent_library_get()
    }

    pub(crate) fn update_agent_profile(&mut self, params: Value) -> Result<Value, CoreError> {
        let id = required_string(&params, "id")?;
        let current = self
            .store
            .agent_library()
            .agents
            .iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| {
                CoreError::InvalidParams(
                    "Only personal agents can be edited. Duplicate a built-in first.".into(),
                )
            })?;
        let version = current
            .version
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("version".into()))?;
        let profile = personal_agent(&params, id, version)?;
        self.store
            .update_personal_agent(&self.write_authority, profile, revision(&params)?)
            .map_err(store_error)?;
        self.agent_library_get()
    }

    pub(crate) fn delete_agent_profile(&mut self, params: Value) -> Result<Value, CoreError> {
        let id = required_string(&params, "id")?;
        self.store
            .delete_personal_agent(&self.write_authority, &id, revision(&params)?)
            .map_err(store_error)?;
        self.agent_library_get()
    }

    pub(crate) fn favorite_agent_profile(&mut self, params: Value) -> Result<Value, CoreError> {
        let id = required_string(&params, "id")?;
        if termloop_invocation::agent_profile(&id).is_none()
            && !self
                .store
                .agent_library()
                .agents
                .iter()
                .any(|profile| profile.id == id)
        {
            return Err(CoreError::InvalidParams("id".into()));
        }
        let favorite = params
            .get("favorite")
            .and_then(Value::as_bool)
            .ok_or_else(|| CoreError::InvalidParams("favorite".into()))?;
        self.store
            .favorite_agent_profile(&self.write_authority, &id, favorite, revision(&params)?)
            .map_err(store_error)?;
        self.agent_library_get()
    }
}

fn revision(params: &Value) -> Result<u64, CoreError> {
    params
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))
}

fn personal_agent(params: &Value, id: String, version: u32) -> Result<PersonalAgent, CoreError> {
    let agent = PersonalAgent {
        id,
        version,
        name: required_string(params, "name")?,
        description: required_string(params, "description")?,
        category: required_string(params, "category")?,
        instructions: required_string(params, "instructions")?,
        agent_id: required_string(params, "agentId")?,
        selection: AgentLaunchSelection::new(
            &required_string(params, "model")?,
            &required_string(params, "permission")?,
            &required_string(params, "reasoning")?,
        ),
    };
    if !agent.is_valid() {
        return Err(CoreError::InvalidParams("agent profile".into()));
    }
    termloop_invocation::validate_agent_configuration(
        &agent.agent_id,
        &agent.selection.model,
        &agent.selection.permission,
        &agent.selection.reasoning,
    )
    .map_err(super::invocation_error)?;
    Ok(agent)
}
