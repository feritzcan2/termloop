use serde_json::json;
use termloop_contract::current::{
    METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

fn configuration_fields() -> serde_json::Value {
    json!({
        "name":"Web dev server",
        "kind":"devServer",
        "command":"pnpm dev",
        "workingDirectory":".",
        "env":[{"name":"PORT","value":"5173"}],
        "setupCommand":"pnpm install",
        "setupPolicy":"oncePerWorktree",
        "urlAutoDetect":true,
        "fallbackUrls":["http://localhost:5173"],
        "autoOpenFirstUrl":true,
        "expectedRevision":4
    })
}

#[test]
fn run_configuration_and_launch_surface_is_strict_and_scoped() {
    for method in [
        "runConfiguration.list",
        "runConfiguration.create",
        "runConfiguration.update",
        "runConfiguration.delete",
        "run.runtimeList",
        "task.startRun",
        "task.restartRun",
        "project.startRun",
        "project.restartRun",
    ] {
        assert!(METHODS.contains(&method));
    }
    assert!(READ_ONLY_METHODS.contains(&"runConfiguration.list"));
    assert!(READ_ONLY_METHODS.contains(&"run.runtimeList"));
    assert!(!READ_ONLY_METHODS.contains(&"runConfiguration.create"));
    assert!(!READ_ONLY_METHODS.contains(&"task.startRun"));

    let mut create = configuration_fields();
    create["projectId"] = json!("project-1");
    assert!(validate_method_params("runConfiguration.create", &create));
    create["cwd"] = json!("/uncontracted/override");
    assert!(!validate_method_params("runConfiguration.create", &create));

    assert!(validate_method_params(
        "task.startRun",
        &json!({"taskId":"task-1", "configurationId":"run-1", "forceSetup":false})
    ));
    assert!(!validate_method_params(
        "task.startRun",
        &json!({"taskId":"task-1", "configurationId":"run-1"})
    ));

    // The Project's own checkout is named by Project, never by a Task.
    assert!(!READ_ONLY_METHODS.contains(&"project.startRun"));
    assert!(validate_method_params(
        "project.startRun",
        &json!({"projectId":"project-1", "configurationId":"run-1", "forceSetup":false})
    ));
    assert!(!validate_method_params(
        "project.startRun",
        &json!({"taskId":"task-1", "configurationId":"run-1", "forceSetup":false})
    ));
}

#[test]
fn run_configuration_and_runtime_results_are_current_and_bounded() {
    assert!(validate_method_result(
        "runConfiguration.list",
        &json!({
            "configurations":[{
                "id":"run-1", "projectId":"project-1", "name":"Web dev server",
                "kind":"devServer", "command":"pnpm dev", "workingDirectory":".",
                "env":[], "setupCommand":null, "setupPolicy":"never",
                "urlAutoDetect":true, "fallbackUrls":[], "autoOpenFirstUrl":false,
                "generation":1, "updatedAtEpochMs":1
            }],
            "stateRevision":4
        })
    ));
    assert!(validate_method_result(
        "run.runtimeList",
        &json!({
            "runs":[{
                "sessionId":"session-1", "taskId":"task-1",
                "configurationId":"run-1", "urls":["http://localhost:5173"],
                "exitCode":null
            }],
            "stateRevision":4
        })
    ));
    // A run started in the Project's own checkout has no Task to project.
    assert!(validate_method_result(
        "run.runtimeList",
        &json!({
            "runs":[{
                "sessionId":"session-1", "taskId":null,
                "configurationId":"run-1", "urls":[],
                "exitCode":0
            }],
            "stateRevision":4
        })
    ));
    assert!(!validate_method_result(
        "run.runtimeList",
        &json!({
            "runs":[{
                "sessionId":"session-1", "taskId":"task-1",
                "configurationId":"run-1", "urls":["ftp://localhost"],
                "exitCode":null
            }],
            "stateRevision":4
        })
    ));
}
