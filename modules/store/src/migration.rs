use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, ResumeFailureReason,
    ResumeProvider, SessionKind, TrackerKind,
};

use super::validation::validate_current_state;
use super::{CURRENT_SCHEMA_VERSION, CurrentState, StoreError};

pub(super) fn decode_and_migrate_state(bytes: &[u8]) -> Result<(CurrentState, bool), StoreError> {
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| StoreError::Io(error.to_string()))?;
    let removed_retired_session_topics = remove_retired_session_topics(&mut value)?;
    let schema_version = value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| StoreError::Io("state schema version is missing or invalid".into()))?;
    match schema_version {
        1 => {
            add_legacy_generation_fields(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v1_to_v2(&mut state);
            migrate_v2_to_v3(&mut state);
            migrate_v3_to_v4(&mut state);
            migrate_v4_to_v5(&mut state);
            migrate_v5_to_v6(&mut state);
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        2 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v2_to_v3(&mut state);
            migrate_v3_to_v4(&mut state);
            migrate_v4_to_v5(&mut state);
            migrate_v5_to_v6(&mut state);
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        3 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v3_to_v4(&mut state);
            migrate_v4_to_v5(&mut state);
            migrate_v5_to_v6(&mut state);
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        4 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v4_to_v5(&mut state);
            migrate_v5_to_v6(&mut state);
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        5 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v5_to_v6(&mut state);
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        6 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v6_to_v7(&mut state);
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        7 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v7_to_v8(&mut state);
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        8 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v8_to_v9(&mut state);
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        9 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v9_to_v10(&mut state);
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        10 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v10_to_v11(&mut state);
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        11 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v11_to_v12(&mut state);
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        12 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v12_to_v13(&mut state);
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        13 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v13_to_v14(&mut state);
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        14 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v14_to_v15(&mut state);
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        15 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v15_to_v16(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        16 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v16_to_v17(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        17 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v17_to_v18(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        18 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v18_to_v19(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        19 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v19_to_v20(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        20 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v20_to_v21(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        21 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v21_to_v22(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        22 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v22_to_v23(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        23 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v23_to_v24(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        24 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v24_to_v25(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        25 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v25_to_v26(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        26 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v26_to_v27(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        27 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v27_to_v28(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        28 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v28_to_v29(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        29 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v29_to_v30(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        30 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v30_to_v31(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        31 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v31_to_v32(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        32 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v32_to_v33(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        33 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v33_to_v34(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        34 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v34_to_v35(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        35 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v35_to_v36(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        36 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v36_to_v37(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        37 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v37_to_v38(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        38 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v38_to_v39(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        39 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v39_to_v40(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        40 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v40_to_v41(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        41 => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            migrate_v41_to_v42(&mut state);
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        42 => {
            migrate_v42_to_v43_value(&mut value)?;
            migrate_v43_to_v44_value(&mut value)?;
            migrate_v44_to_v45_value(&mut value)?;
            migrate_v45_to_v46_value(&mut value)?;
            migrate_v46_to_v47_value(&mut value)?;
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        43 => {
            migrate_v43_to_v44_value(&mut value)?;
            migrate_v44_to_v45_value(&mut value)?;
            migrate_v45_to_v46_value(&mut value)?;
            migrate_v46_to_v47_value(&mut value)?;
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        44 => {
            migrate_v44_to_v45_value(&mut value)?;
            migrate_v45_to_v46_value(&mut value)?;
            migrate_v46_to_v47_value(&mut value)?;
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        45 => {
            migrate_v45_to_v46_value(&mut value)?;
            migrate_v46_to_v47_value(&mut value)?;
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        46 => {
            migrate_v46_to_v47_value(&mut value)?;
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        47 => {
            migrate_v47_to_v48_value(&mut value)?;
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, true))
        }
        CURRENT_SCHEMA_VERSION => {
            let mut state: CurrentState =
                serde_json::from_value(value).map_err(|error| StoreError::Io(error.to_string()))?;
            let sanitized = removed_retired_session_topics || sanitize_resume_metadata(&mut state);
            validate_current_state(&state)?;
            Ok((state, sanitized))
        }
        unsupported => Err(StoreError::UnsupportedSchema(unsupported)),
    }
}

fn add_legacy_generation_fields(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    for field in ["tasks", "managed_worktrees"] {
        if let Some(records) = object
            .get_mut(field)
            .and_then(serde_json::Value::as_array_mut)
        {
            for record in records {
                record
                    .as_object_mut()
                    .ok_or_else(|| StoreError::Io(format!("{field} record must be an object")))?
                    .insert("worktree_generation".into(), serde_json::json!(0));
            }
        }
    }
    Ok(())
}

fn remove_retired_session_topics(value: &mut serde_json::Value) -> Result<bool, StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    let mut changed = false;
    if let Some(sessions) = object
        .get_mut("sessions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for session in sessions {
            if let Some(session) = session.as_object_mut() {
                changed |= session.remove("agent_topic").is_some();
            }
        }
    }
    if let Some(overrides) = object
        .get_mut("mcp_tool_description_overrides")
        .and_then(serde_json::Value::as_array_mut)
    {
        let previous_len = overrides.len();
        overrides.retain(|value| {
            value.get("tool").and_then(serde_json::Value::as_str) != Some("session_topic_update")
        });
        changed |= overrides.len() != previous_len;
    }
    Ok(changed)
}

fn migrate_v1_to_v2(state: &mut CurrentState) {
    state.schema_version = 2;
    for task in &mut state.tasks {
        task.worktree_generation = 0;
        let mut matching = state
            .managed_worktrees
            .iter()
            .enumerate()
            .filter(|(_, proof)| proof.task_id == task.id)
            .map(|(index, _)| index);
        let Some(proof_index) = matching.next() else {
            continue;
        };
        if matching.next().is_some() {
            continue;
        }
        drop(matching);
        let proof = &state.managed_worktrees[proof_index];
        let valid = task.worktree.as_ref().is_some_and(|worktree| {
            worktree.path == proof.registered_worktree_path
                && worktree.path == proof.normalized_spec.destination_path
        }) && task.branch.as_ref().is_some_and(|branch| {
            branch.repository_root == proof.normalized_spec.repository_root
                && branch.name == proof.normalized_spec.branch_name
                && proof.branch_ref == format!("refs/heads/{}", branch.name)
        }) && proof.repository_common_dir
            == proof.normalized_spec.repository_common_dir;
        if valid {
            task.worktree_generation = 1;
            state.managed_worktrees[proof_index].worktree_generation = 1;
        }
    }
}

fn migrate_v2_to_v3(state: &mut CurrentState) {
    state.schema_version = 3;
}

fn migrate_v3_to_v4(state: &mut CurrentState) {
    state.schema_version = 4;
}

fn migrate_v4_to_v5(state: &mut CurrentState) {
    state.schema_version = 5;
}

fn migrate_v5_to_v6(state: &mut CurrentState) {
    state.schema_version = 6;
}

fn migrate_v6_to_v7(state: &mut CurrentState) {
    state.schema_version = 7;
}

fn migrate_v7_to_v8(state: &mut CurrentState) {
    state.schema_version = 8;
}

fn migrate_v8_to_v9(state: &mut CurrentState) {
    state.schema_version = 9;
}

fn migrate_v9_to_v10(state: &mut CurrentState) {
    state.schema_version = 10;
}

fn migrate_v10_to_v11(state: &mut CurrentState) {
    state.schema_version = 11;
    // This pre-V1 migration resets superseded per-Tracker assistant state.
    // Ordinary Project, Task and Session data is
    // preserved; only Sessions launched from the retired Tracker templates are
    // removed.
    state.tracker_configurations.clear();
    state.worker_configurations.clear();
    state.sessions.retain(|session| {
        !session
            .process
            .template_ref
            .as_deref()
            .is_some_and(|template| template.starts_with("builtin.tracker."))
    });
}

fn migrate_v11_to_v12(state: &mut CurrentState) {
    state.schema_version = 12;
    // The prompt-authored assignment model replaces source-scoped Trackers.
    // Ferit explicitly approved disposal of pre-V1 assistant state; preserve
    // ordinary Sessions while removing only Worker/retired Tracker Sessions.
    state.tracker_configurations.clear();
    state.worker_configurations.clear();
    state.sessions.retain(|session| {
        !session
            .process
            .template_ref
            .as_deref()
            .is_some_and(|template| {
                template == "builtin.worker.executor" || template.starts_with("builtin.tracker.")
            })
    });
}

fn migrate_v12_to_v13(state: &mut CurrentState) {
    // Companion proposal rows are unknown fields after deserialization and are
    // therefore intentionally absent when schema 13 is persisted.
    state.schema_version = 13;
}

fn migrate_v13_to_v14(state: &mut CurrentState) {
    // `last_attempt_at_epoch_ms` deserializes as `None` for existing pre-V1
    // Worker Tasks. Persist the current-state shape at schema 14.
    state.schema_version = 14;
}

fn migrate_v14_to_v15(state: &mut CurrentState) {
    // Existing editable prompts survive the terminology change. Only retired
    // built-in tool names and exact user-facing phrases are rewritten.
    for task in &mut state.tracker_configurations {
        task.prompt = task
            .prompt
            .replace("`steward_report`", "`worker_complete_routine`")
            .replace("`report_problem`", "`worker_report_routine_problem`")
            .replace("this assignment", "this Routine")
            .replace(
                "Finish each check exactly once",
                "Finish this Worker Task exactly once",
            );
    }
    state.schema_version = 15;
}

fn migrate_v15_to_v16(state: &mut CurrentState) {
    // `system_prompt` deserializes as the empty built-in-default sentinel for
    // existing Steward rows. `launch_selection` deserializes to its safe default
    // for every legacy Session. No previous authority is inferred from client
    // or provider data, and no assistant or Project current state is discarded.
    // The default-empty MCP override collection is already present after
    // deserialization, so older versions can advance through both additive
    // shapes without synthesizing user-authored content.
    state.schema_version = 16;
    migrate_v16_to_v17(state);
}

fn migrate_v16_to_v17(state: &mut CurrentState) {
    // MCP description overrides deserialize to an empty current-state
    // collection. Migration never creates canonical-copy residue.
    state.schema_version = 17;
    migrate_v17_to_v18(state);
}

fn migrate_v17_to_v18(state: &mut CurrentState) {
    // Legacy Companion messages deserialize conservatively as `reply` with no
    // references, while IssueLink sidecars deserialize empty. Migration never
    // infers message semantics or external issue identity from text.
    state.schema_version = 18;
    migrate_v18_to_v19(state);
}

fn migrate_v18_to_v19(state: &mut CurrentState) {
    // No authority is inferred for an existing installation. The first
    // successful ordinary Agent launch records the exact user-selected
    // provider/model/permission/reasoning tuple as current launch preference.
    state.last_agent_launch_selection = None;
    state.schema_version = 19;
    migrate_v19_to_v20(state);
}

fn migrate_v19_to_v20(state: &mut CurrentState) {
    // Both additive sidecars default safely: legacy Sessions gain no inferred
    // Ask-To relationship/authority and existing Tasks gain no inferred issue
    // association.
    state.schema_version = 20;
    migrate_v20_to_v21(state);
}

fn migrate_v20_to_v21(state: &mut CurrentState) {
    // The removed wall-clock expiry field is ignored while decoding v20. The
    // exact current request ID remains current until reply or endpoint exit.
    // IssueLink rows deserialize empty when schema 20 came from the Ask-To
    // branch, while schema 20 from main already contains them.
    state.schema_version = 21;
    migrate_v21_to_v22(state);
}

fn migrate_v21_to_v22(state: &mut CurrentState) {
    // Schema 21 already has no Ask-To expiry. IssueLink sidecars default empty,
    // so integrating the independently assigned schema numbers infers nothing.
    state.schema_version = 22;
    migrate_v22_to_v23(state);
}

fn migrate_v22_to_v23(state: &mut CurrentState) {
    // Archive current state is additive and inference-free. Serde defaults the
    // Task marker and both sidecar collections to empty/null for every legacy
    // record; closed Tasks and existing Sessions are never inferred archived.
    state.schema_version = 23;
    migrate_v23_to_v24(state);
}

fn migrate_v23_to_v24(state: &mut CurrentState) {
    // Individual Session archive state is inference-free. Serde defaults every
    // existing Session marker to null; no exited or Task-suspended Session is
    // reclassified.
    state.schema_version = 24;
    migrate_v24_to_v25(state);
}

fn migrate_v24_to_v25(state: &mut CurrentState) {
    // Routine context is additive current state. Existing assignments start
    // with one empty visible context and no inferred source or Task links.
    migrate_routine_prompt_names(state);
    state.schema_version = 25;
    migrate_v25_to_v26(state);
}

fn migrate_v25_to_v26(state: &mut CurrentState) {
    // Schema 25 existed on the Routine branch while relocation was still
    // unmerged. Repeat the text-only Routine rewrite idempotently so local
    // pre-integration v25 state is accepted without guessing its origin.
    migrate_routine_prompt_names(state);
    // Relocation is a new bounded current-operation journal. Existing Sessions
    // are never inferred to be moving or attached to a Task.
    state.session_relocation_operations.clear();
    state.session_relocation_receipts.clear();
    state.schema_version = 26;
    migrate_v26_to_v27(state);
}

fn migrate_v26_to_v27(state: &mut CurrentState) {
    let retired_jira_prompt =
        include_str!("../../../resources/prompts/retired/builtin.tracker.jira.v3.md")
            .splitn(3, "\n\n")
            .nth(2)
            .expect("retired Jira prompt has metadata and instructions")
            .trim();
    let current_jira_prompt = include_str!("../../../resources/prompts/builtin.tracker.jira.md")
        .splitn(3, "\n\n")
        .nth(2)
        .expect("current Jira prompt has metadata and instructions")
        .trim();

    for routine in &mut state.tracker_configurations {
        if routine.kind != TrackerKind::Jira || routine.prompt != retired_jira_prompt {
            continue;
        }
        routine.prompt = current_jira_prompt.to_owned();
        routine.generation = routine.generation.saturating_add(1);
        routine.context_markdown.clear();
        routine.context_revision = routine.context_revision.saturating_add(1);
        routine.recent_source_keys.clear();
        routine.related_task_ids.clear();
        routine.last_check_started_at_epoch_ms = None;
        routine.last_attempt_at_epoch_ms = None;
        routine.last_successful_report_at_epoch_ms = None;
        routine.updated_at_epoch_ms = 0;
    }
    state.schema_version = 27;
    migrate_v27_to_v28(state);
}

fn migrate_v27_to_v28(state: &mut CurrentState) {
    // Structured agent plans are additive current Session state. Existing
    // Sessions gain no inferred plan; providers must have emitted one.
    state.agent_plans.clear();
    state.schema_version = 28;
    migrate_v28_to_v29(state);
}

fn migrate_v28_to_v29(state: &mut CurrentState) {
    // The retired Agent-authored topic and its MCP description override are
    // removed from raw state before decoding. User-authored Session names stay.
    state.schema_version = 29;
    migrate_v29_to_v30(state);
}

fn migrate_v29_to_v30(state: &mut CurrentState) {
    // A legacy ResumeRef proves only that TermLoop once learned a provider
    // identity. It does not prove the provider durably stored a conversation,
    // so preserve explicit attempt-and-report behavior without claiming the
    // stronger `resumable` state. Legacy Agents without a valid matching ref
    // begin conservatively as unconfirmed.
    state.agent_conversation_readiness = state
        .sessions
        .iter()
        .filter(|session| session.kind == SessionKind::Agent)
        .map(|session| AgentConversationReadinessRecord {
            session_id: session.id.clone(),
            readiness: if session.resume_ref.as_ref().is_some_and(|resume_ref| {
                resume_ref.validate()
                    && provider_matches_agent(
                        resume_ref.provider,
                        session.process.agent_id.as_deref(),
                    )
            }) {
                AgentConversationReadiness::LegacyUnknown
            } else {
                AgentConversationReadiness::Unconfirmed
            },
        })
        .collect();
    state.schema_version = 30;
    migrate_v30_to_v31(state);
}

fn migrate_v30_to_v31(state: &mut CurrentState) {
    // Version 31 only added the global keep-awake preference, which
    // deserializes to its own default (`Off`) when absent. Nothing is
    // rewritten here: the version still moves so an older binary refuses this
    // state instead of silently dropping the preference on its next write.
    state.schema_version = 31;
    migrate_v31_to_v32(state);
}

fn migrate_v31_to_v32(state: &mut CurrentState) {
    // Run configurations and setup marks are additive current-state
    // collections that deserialize empty, and every legacy Session's
    // `run_configuration_id` defaults to null. No run relationship is ever
    // inferred from existing Terminal Sessions.
    state.schema_version = 32;
    migrate_v32_to_v33(state);
}

fn migrate_v32_to_v33(state: &mut CurrentState) {
    // Two branches each shipped a version 32, so a file claiming 32 may hold
    // either set of additions. Both are additive collections and fields that
    // deserialize to their defaults when absent, so 33 simply means "has room
    // for both"; nothing is read, rewritten, or inferred here. The version
    // still moves so an older binary refuses this state instead of silently
    // dropping the records it does not know about on its next write.
    state.schema_version = 33;
    migrate_v33_to_v34(state);
}

fn migrate_v33_to_v34(state: &mut CurrentState) {
    // Playbook rules are gone: the Playbook is now the delivery pipeline
    // alone, and each step's policy lives on the Routine that answers it. A
    // version 33 document's `rules` array is simply not a field any more, so
    // decoding drops it and this rewrite persists the document without it.
    // Per-Task step verdicts arrive as an additive collection that
    // deserializes empty; no position is inferred for existing Tasks, so every
    // Task starts at the first question of the pipeline it is walking.
    state.schema_version = 34;
    migrate_v34_to_v35(state);
}

fn migrate_v34_to_v35(state: &mut CurrentState) {
    for configuration in &mut state.steward_configurations {
        configuration.permission = "bypassPermissions".into();
    }
    for configuration in &mut state.worker_configurations {
        configuration.permission = "bypassPermissions".into();
    }
    state.schema_version = 35;
    migrate_v35_to_v36(state);
}

fn migrate_v35_to_v36(state: &mut CurrentState) {
    // Early assistant descriptor cleanup removed retired Steward/Worker
    // Sessions without removing their conversation-readiness sidecars. Keep
    // each surviving Agent's exact readiness, discard orphan/duplicate rows,
    // and conservatively seed any missing row as unconfirmed.
    let readiness_by_session = state
        .agent_conversation_readiness
        .iter()
        .map(|record| (record.session_id.as_str(), record.readiness))
        .collect::<std::collections::HashMap<_, _>>();
    state.agent_conversation_readiness = state
        .sessions
        .iter()
        .filter(|session| session.kind == SessionKind::Agent)
        .map(|session| AgentConversationReadinessRecord {
            session_id: session.id.clone(),
            readiness: readiness_by_session
                .get(session.id.as_str())
                .copied()
                .unwrap_or(AgentConversationReadiness::Unconfirmed),
        })
        .collect();
    state.schema_version = 36;
    migrate_v36_to_v37(state);
}

fn migrate_v36_to_v37(state: &mut CurrentState) {
    // Action handling and its bounded current-state collections are additive
    // serde-default fields. Existing Routines start safely at `off` without
    // synthesizing actionable work from older findings.
    state.schema_version = 37;
    migrate_v37_to_v38(state);
}

fn migrate_v37_to_v38(state: &mut CurrentState) {
    for routine in &mut state.tracker_configurations {
        routine.steward_instructions = String::new();
        for finding in &routine.pending_routine_findings {
            if !routine.recent_source_keys.contains(&finding.source_key) {
                routine.recent_source_keys.push(finding.source_key.clone());
            }
        }
        if routine.recent_source_keys.len() > termloop_domain::ROUTINE_RECENT_SOURCE_KEYS_MAX {
            let excess = routine
                .recent_source_keys
                .len()
                .saturating_sub(termloop_domain::ROUTINE_RECENT_SOURCE_KEYS_MAX);
            routine.recent_source_keys.drain(..excess);
        }
    }
    state.schema_version = 38;
    migrate_v38_to_v39(state);
}

fn migrate_v38_to_v39(state: &mut CurrentState) {
    // Deleted Sessions are an additive serde-default sidecar. Existing state
    // contains no inferred deletions; only an explicit close can create one.
    state.schema_version = 39;
    migrate_v39_to_v40(state);
}

fn migrate_v39_to_v40(state: &mut CurrentState) {
    super::records::configuration_version::initialize_configuration_versions(state);
    state.schema_version = 40;
    migrate_v40_to_v41(state);
}

fn migrate_v40_to_v41(state: &mut CurrentState) {
    super::records::configuration_version::initialize_configuration_version_selections(state);
    state.schema_version = 41;
    migrate_v41_to_v42(state);
}

fn migrate_v41_to_v42(state: &mut CurrentState) {
    // Task Sources are an additive Project sidecar. A legacy Jira IssueLink
    // does not prove source scope or credentials, so migration infers none.
    state.schema_version = 42;
    migrate_v42_to_v43_without_sources(state);
}

fn migrate_v42_to_v43_without_sources(state: &mut CurrentState) {
    state.schema_version = 43;
    migrate_v43_to_v44_without_sources(state);
}

fn migrate_v43_to_v44_without_sources(state: &mut CurrentState) {
    debug_assert!(state.task_source_configurations.is_empty());
    state.schema_version = 44;
    migrate_v44_to_v45_without_automation(state);
}

fn migrate_v44_to_v45_without_automation(state: &mut CurrentState) {
    debug_assert!(state.project_task_automation_configurations.is_empty());
    state.schema_version = 45;
    migrate_v45_to_v46_without_automation(state);
}

fn migrate_v45_to_v46_without_automation(state: &mut CurrentState) {
    debug_assert!(state.project_task_automation_configurations.is_empty());
    state.schema_version = 46;
    migrate_v46_to_v47_without_automation(state);
}

fn migrate_v46_to_v47_without_automation(state: &mut CurrentState) {
    debug_assert!(state.project_task_automation_configurations.is_empty());
    state.schema_version = 47;
    migrate_v47_to_v48(state);
}

fn migrate_v47_to_v48(state: &mut CurrentState) {
    state.schema_version = CURRENT_SCHEMA_VERSION;
}

fn migrate_v42_to_v43_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    use std::collections::BTreeMap;

    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    let mut settings_by_project = BTreeMap::<String, Vec<(bool, Option<String>)>>::new();
    if let Some(sources) = object
        .get_mut("task_source_configurations")
        .and_then(serde_json::Value::as_array_mut)
    {
        for source in sources {
            let source = source.as_object_mut().ok_or_else(|| {
                StoreError::Io("task_source_configurations record must be an object".into())
            })?;
            let project_id = source
                .get("projectId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| StoreError::Io("Task Source projectId is missing".into()))?
                .to_owned();
            let create_worktree = match source.remove("createWorktree") {
                None => false,
                Some(serde_json::Value::Bool(value)) => value,
                Some(_) => {
                    return Err(StoreError::Io(
                        "Task Source createWorktree is invalid".into(),
                    ));
                }
            };
            let agent_id = match source.remove("agentId") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value)) => Some(value),
                _ => return Err(StoreError::Io("Task Source agentId is invalid".into())),
            };
            settings_by_project
                .entry(project_id)
                .or_default()
                .push((create_worktree, agent_id));
        }
    }
    let configurations = settings_by_project
        .into_iter()
        .filter_map(|(project_id, settings)| {
            let first = settings.first()?;
            settings
                .iter()
                .all(|candidate| candidate == first)
                .then(|| termloop_domain::ProjectTaskAutomationConfiguration {
                    project_id,
                    create_worktree: first.0,
                    worktree_prefix:
                        termloop_domain::PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT.into(),
                    agent_id: first.1.clone(),
                    model: first.1.as_ref().map(|_| "default".into()),
                    permission: first.1.as_ref().map(|_| "default".into()),
                    reasoning: first.1.as_ref().map(|_| "default".into()),
                    kickoff_message: None,
                })
                .filter(termloop_domain::ProjectTaskAutomationConfiguration::is_valid)
                .map(|configuration| {
                    serde_json::json!({
                        "projectId": configuration.project_id,
                        "createWorktree": configuration.create_worktree,
                        "agentId": configuration.agent_id,
                        "model": configuration.model,
                        "permission": configuration.permission,
                        "reasoning": configuration.reasoning,
                        "kickoffMessage": configuration.kickoff_message,
                    })
                })
        })
        .collect::<Vec<_>>();
    object.insert(
        "project_task_automation_configurations".into(),
        serde_json::Value::Array(configurations),
    );
    object.insert("schema_version".into(), serde_json::json!(43));
    Ok(())
}

fn migrate_v43_to_v44_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    if let Some(sources) = object
        .get_mut("task_source_configurations")
        .and_then(serde_json::Value::as_array_mut)
    {
        for source in sources {
            let source = source.as_object_mut().ok_or_else(|| {
                StoreError::Io("task_source_configurations record must be an object".into())
            })?;
            source.insert(
                "autoImportActiveTaskLimit".into(),
                serde_json::json!(
                    termloop_domain::TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT
                ),
            );
        }
    }
    object.insert("schema_version".into(), serde_json::json!(44));
    Ok(())
}

fn migrate_v44_to_v45_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    if let Some(configurations) = object
        .get_mut("project_task_automation_configurations")
        .and_then(serde_json::Value::as_array_mut)
    {
        for configuration in configurations {
            let configuration = configuration.as_object_mut().ok_or_else(|| {
                StoreError::Io(
                    "project_task_automation_configurations record must be an object".into(),
                )
            })?;
            let starts_agent = configuration
                .get("agentId")
                .is_some_and(serde_json::Value::is_string);
            configuration.insert(
                "model".into(),
                if starts_agent {
                    serde_json::json!("default")
                } else {
                    serde_json::Value::Null
                },
            );
            configuration.insert(
                "reasoning".into(),
                if starts_agent {
                    serde_json::json!("default")
                } else {
                    serde_json::Value::Null
                },
            );
            configuration.insert("kickoffMessage".into(), serde_json::Value::Null);
        }
    }
    object.insert("schema_version".into(), serde_json::json!(45));
    Ok(())
}

fn migrate_v45_to_v46_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    if let Some(configurations) = object
        .get_mut("project_task_automation_configurations")
        .and_then(serde_json::Value::as_array_mut)
    {
        for configuration in configurations {
            let configuration = configuration.as_object_mut().ok_or_else(|| {
                StoreError::Io(
                    "project_task_automation_configurations record must be an object".into(),
                )
            })?;
            let starts_agent = configuration
                .get("agentId")
                .is_some_and(serde_json::Value::is_string);
            configuration.insert(
                "permission".into(),
                if starts_agent {
                    serde_json::json!("default")
                } else {
                    serde_json::Value::Null
                },
            );
        }
    }
    object.insert("schema_version".into(), serde_json::json!(46));
    Ok(())
}

fn migrate_v46_to_v47_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    if let Some(configurations) = object
        .get_mut("project_task_automation_configurations")
        .and_then(serde_json::Value::as_array_mut)
    {
        for configuration in configurations {
            configuration
                .as_object_mut()
                .ok_or_else(|| {
                    StoreError::Io(
                        "project_task_automation_configurations record must be an object".into(),
                    )
                })?
                .insert(
                    "worktreePrefix".into(),
                    serde_json::json!(
                        termloop_domain::PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT
                    ),
                );
        }
    }
    object.insert("schema_version".into(), serde_json::json!(47));
    Ok(())
}

fn migrate_v47_to_v48_value(value: &mut serde_json::Value) -> Result<(), StoreError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Io("state root must be an object".into()))?;
    object.insert("task_branch_sets".into(), serde_json::json!([]));
    object.insert(
        "schema_version".into(),
        serde_json::json!(CURRENT_SCHEMA_VERSION),
    );
    Ok(())
}

fn migrate_routine_prompt_names(state: &mut CurrentState) {
    for routine in &mut state.tracker_configurations {
        routine.prompt = routine
            .prompt
            .replace("`worker_task_complete`", "`worker_complete_routine`")
            .replace("`worker_task_problem`", "`worker_report_routine_problem`")
            .replace("Worker Task", "Routine");
    }
}

fn sanitize_resume_metadata(state: &mut CurrentState) -> bool {
    let mut changed = false;
    for session in &mut state.sessions {
        let Some(value) = session.resume_ref.as_ref() else {
            continue;
        };
        if !value.validate() {
            session.resume_ref = None;
            session.lifecycle_state = "resumeFailed".into();
            session.resume_failure = Some(ResumeFailureReason::InvalidResumeRef);
            changed = true;
        } else if session.kind != SessionKind::Agent
            || !provider_matches_agent(value.provider, session.process.agent_id.as_deref())
        {
            session.lifecycle_state = "resumeFailed".into();
            session.resume_failure = Some(ResumeFailureReason::ProviderMismatch);
            changed = true;
        }
    }
    changed
}

pub(super) fn provider_matches_agent(provider: ResumeProvider, agent_id: Option<&str>) -> bool {
    matches!(
        (provider, agent_id),
        (ResumeProvider::Claude, Some("claude"))
            | (ResumeProvider::Codex, Some("codex"))
            | (ResumeProvider::Gemini, Some("gemini"))
    )
}
