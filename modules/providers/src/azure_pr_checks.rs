//! Azure DevOps pull-request check status from blocking build and status
//! policy evaluations. Each active matched pull request costs at most one
//! fixed-shape `az repos pr policy list` call inside the scan deadline; a failed
//! call only degrades that pull request's checks to `Unknown` and never the
//! scan.

use super::*;

/// The well-known Azure DevOps "Build" (build validation) policy type id.
const AZURE_BUILD_POLICY_TYPE_ID: &str = "0609b952-1397-4640-95ec-e00a01b2c241";
/// The well-known Azure DevOps "Status" (external status check) policy type id.
const AZURE_STATUS_POLICY_TYPE_ID: &str = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
const AZURE_POLICY_MAX_ROWS: usize = 64;
const AZURE_POLICY_QUERY_ROWS: usize = AZURE_POLICY_MAX_ROWS + 1;
const AZURE_POLICY_CONCURRENCY: usize = 4;
const AZURE_POLICY_QUERY: &str = "[].{status:status,isBlocking:configuration.isBlocking,isEnabled:configuration.isEnabled,isDeleted:configuration.isDeleted,typeId:configuration.type.id,typeName:configuration.type.displayName}";

impl AzureDevOpsClient {
    /// Replaces the default `Unsupported` checks of every active (open or
    /// draft) pull request with its policy rollup. Merged and abandoned pull
    /// requests keep `Unsupported` and cost no call.
    pub(crate) fn attach_azure_policy_checks(
        &self,
        organization: &str,
        scan: &mut AzurePullRequestScan,
        deadline: termloop_platform::MonotonicDeadline,
    ) {
        let suppression_key = azure_policy_suppression_key(organization);
        attach_policy_checks_with(organization, scan, |arguments| {
            // Checked per call so a denial seen by one pull request stops the
            // remaining calls of the same scan.
            if let Some(failure) = self.azure_suppressed(&suppression_key) {
                return Err(failure);
            }
            let generation = self.credential.generation();
            let outcome = termloop_platform::run_command(
                self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                    .args(arguments),
            )
            .map_err(|_| ProviderFailure::ProviderUnavailable)?;
            classify_azure_outcome(&outcome).inspect_err(|&failure| {
                if matches!(
                    failure,
                    ProviderFailure::Unauthorized | ProviderFailure::RateLimited
                ) {
                    self.record_azure_suppression(&suppression_key, failure, generation);
                }
            })?;
            Ok(outcome.stdout)
        });
    }
}

/// Distinct from the project and alias keys the pull-request scan checks, so
/// a policy-read denial never suppresses pull-request discovery itself.
fn azure_policy_suppression_key(organization: &str) -> String {
    format!("azureDevOpsPolicy|{AZURE_HOST}|{organization}")
}

fn attach_policy_checks_with<F>(organization: &str, scan: &mut AzurePullRequestScan, run: F)
where
    F: Fn(Vec<String>) -> Result<Vec<u8>, ProviderFailure> + Sync,
{
    let mut active = scan
        .pull_requests
        .iter_mut()
        .filter(|summary| {
            matches!(
                summary.state,
                PullRequestState::Open | PullRequestState::Draft
            )
        })
        .take(AZURE_MAX_MATCHES)
        .collect::<Vec<_>>();
    for chunk in active.chunks_mut(AZURE_POLICY_CONCURRENCY) {
        std::thread::scope(|scope| {
            let run = &run;
            let handles = chunk
                .iter()
                .map(|summary| {
                    let arguments = azure_policy_arguments(organization, summary.number);
                    scope.spawn(move || match run(arguments) {
                        Ok(stdout) => parse_azure_policy_rollup(&stdout),
                        Err(_) => CheckState::Unknown,
                    })
                })
                .collect::<Vec<_>>();
            for (summary, handle) in chunk.iter_mut().zip(handles) {
                summary.checks = handle.join().unwrap_or(CheckState::Unknown);
            }
        });
    }
}

pub(crate) fn azure_policy_arguments(organization: &str, number: u64) -> Vec<String> {
    vec![
        "repos".into(),
        "pr".into(),
        "policy".into(),
        "list".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{organization}"),
        "--id".into(),
        number.to_string(),
        "--top".into(),
        AZURE_POLICY_QUERY_ROWS.to_string(),
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_POLICY_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]
}

/// Rollup over enabled, non-deleted, blocking build and status policies: any
/// rejected or broken evaluation fails; otherwise any queued or running one is
/// pending; otherwise any unreadable one is unknown; otherwise at least one
/// approved evaluation passes. No applicable policy is `NotReported`.
pub(crate) fn parse_azure_policy_rollup(bytes: &[u8]) -> CheckState {
    let Ok(Value::Array(rows)) = serde_json::from_slice::<Value>(bytes) else {
        return CheckState::Unknown;
    };
    if rows.len() > AZURE_POLICY_MAX_ROWS {
        return CheckState::Unknown;
    }
    let (mut failing, mut pending, mut unknown, mut approved) = (false, false, false, false);
    for row in &rows {
        let type_id = row.get("typeId").and_then(Value::as_str);
        let type_name = row.get("typeName").and_then(Value::as_str);
        let is_check = type_id.is_some_and(|id| {
            id.eq_ignore_ascii_case(AZURE_BUILD_POLICY_TYPE_ID)
                || id.eq_ignore_ascii_case(AZURE_STATUS_POLICY_TYPE_ID)
        }) || matches!(type_name, Some("Build" | "Status"));
        if !is_check {
            continue;
        }
        let flag = |name: &str| row.get(name).and_then(Value::as_bool);
        if flag("isEnabled") == Some(false)
            || flag("isDeleted") == Some(true)
            || flag("isBlocking") == Some(false)
        {
            continue;
        }
        if flag("isEnabled").is_none() || flag("isBlocking").is_none() {
            unknown = true;
            continue;
        }
        match row.get("status").and_then(Value::as_str) {
            Some("rejected" | "broken") => failing = true,
            Some("queued" | "running") => pending = true,
            Some("approved") => approved = true,
            Some("notApplicable") => {}
            _ => unknown = true,
        }
    }
    if failing {
        CheckState::Failing
    } else if pending {
        CheckState::Pending
    } else if unknown {
        CheckState::Unknown
    } else if approved {
        CheckState::Passing
    } else {
        CheckState::NotReported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn evaluation(status: &str) -> Value {
        json!({
            "status": status,
            "isBlocking": true,
            "isEnabled": true,
            "isDeleted": false,
            "typeId": AZURE_BUILD_POLICY_TYPE_ID,
            "typeName": "Build"
        })
    }

    fn reviewer_policy(status: &str) -> Value {
        json!({
            "status": status,
            "isBlocking": true,
            "isEnabled": true,
            "isDeleted": false,
            "typeId": "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
            "typeName": "Minimum number of reviewers"
        })
    }

    fn rollup(rows: Vec<Value>) -> CheckState {
        parse_azure_policy_rollup(&serde_json::to_vec(&rows).unwrap())
    }

    fn summary(number: u64, state: PullRequestState) -> PullRequestSummary {
        PullRequestSummary {
            provider: GitHostProvider::AzureDevOps,
            host: AZURE_HOST.into(),
            repository_owner: "fiber-teams".into(),
            repository_project: Some("Fiber Tests".into()),
            repository_name: "Widget".into(),
            number,
            title: "Azure PR".into(),
            url: format!(
                "https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget/pullrequest/{number}"
            ),
            state,
            merge_commit_oid: None,
            base_branch: "main".into(),
            head_branch: "feature".into(),
            head_repository_owner: "fiber-teams".into(),
            head_repository_project: Some("Fiber Tests".into()),
            head_repository_name: "Widget".into(),
            checks: CheckState::Unsupported,
            review: ReviewState::NotReported,
            mergeability: Mergeability::Mergeable,
            updated_at_epoch_ms: number,
        }
    }

    fn scan(summaries: Vec<PullRequestSummary>) -> AzurePullRequestScan {
        AzurePullRequestScan {
            pull_requests: summaries,
            truncated: false,
            incomplete: false,
            parent_resolved: true,
        }
    }

    #[test]
    fn blocking_build_policies_roll_up_to_passing_failing_and_pending() {
        assert_eq!(rollup(vec![evaluation("approved")]), CheckState::Passing);
        assert_eq!(
            rollup(vec![evaluation("approved"), evaluation("notApplicable")]),
            CheckState::Passing
        );
        assert_eq!(
            rollup(vec![evaluation("approved"), evaluation("rejected")]),
            CheckState::Failing
        );
        assert_eq!(
            rollup(vec![evaluation("running"), evaluation("broken")]),
            CheckState::Failing
        );
        assert_eq!(
            rollup(vec![evaluation("approved"), evaluation("queued")]),
            CheckState::Pending
        );
        assert_eq!(rollup(vec![evaluation("running")]), CheckState::Pending);
        let mut by_name_only = evaluation("rejected");
        by_name_only["typeId"] = Value::Null;
        assert_eq!(rollup(vec![by_name_only]), CheckState::Failing);
    }

    #[test]
    fn blocking_status_policies_count_as_checks() {
        let mut status = evaluation("rejected");
        status["typeId"] = json!(AZURE_STATUS_POLICY_TYPE_ID);
        status["typeName"] = json!("Status");
        assert_eq!(
            rollup(vec![evaluation("approved"), status]),
            CheckState::Failing
        );
    }

    #[test]
    fn missing_or_non_blocking_build_policies_are_not_reported() {
        assert_eq!(rollup(Vec::new()), CheckState::NotReported);
        assert_eq!(
            rollup(vec![reviewer_policy("rejected")]),
            CheckState::NotReported
        );
        assert_eq!(
            rollup(vec![evaluation("notApplicable")]),
            CheckState::NotReported
        );
        let mut optional = evaluation("rejected");
        optional["isBlocking"] = json!(false);
        let mut disabled = evaluation("rejected");
        disabled["isEnabled"] = json!(false);
        let mut deleted = evaluation("rejected");
        deleted["isDeleted"] = json!(true);
        assert_eq!(
            rollup(vec![optional, disabled, deleted, evaluation("approved")]),
            CheckState::Passing
        );
    }

    #[test]
    fn unreadable_policy_responses_are_unknown() {
        assert_eq!(parse_azure_policy_rollup(b"not json"), CheckState::Unknown);
        assert_eq!(parse_azure_policy_rollup(b"{}"), CheckState::Unknown);
        assert_eq!(
            rollup(vec![evaluation("approved"), evaluation("somethingNew")]),
            CheckState::Unknown
        );
        let mut unflagged = evaluation("approved");
        unflagged["isBlocking"] = Value::Null;
        assert_eq!(rollup(vec![unflagged]), CheckState::Unknown);
        let overflow = (0..=AZURE_POLICY_MAX_ROWS)
            .map(|_| evaluation("approved"))
            .collect::<Vec<_>>();
        assert_eq!(rollup(overflow), CheckState::Unknown);
    }

    #[test]
    fn policy_command_shape_is_fixed_and_bounded() {
        let arguments = azure_policy_arguments("fiber-teams", 42);
        assert_eq!(&arguments[0..4], ["repos", "pr", "policy", "list"]);
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--organization", "https://dev.azure.com/fiber-teams"])
        );
        assert!(arguments.windows(2).any(|pair| pair == ["--id", "42"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--top", "65"]));
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--detect", "false"])
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--output", "json"])
        );
        assert!(arguments.windows(2).any(|pair| pair[0] == "--query"
            && pair[1].contains("typeId:configuration.type.id")
            && pair[1].contains("isBlocking:configuration.isBlocking")));
        assert_eq!(
            arguments.last().map(String::as_str),
            Some("--only-show-errors")
        );
        assert!(!arguments.iter().any(|value| value == "--project"));
    }

    #[test]
    fn only_active_pull_requests_read_policies_and_failures_degrade_only_checks() {
        let calls = AtomicUsize::new(0);
        let observed = Mutex::new(Vec::new());
        let mut result = scan(vec![
            summary(1, PullRequestState::Open),
            summary(2, PullRequestState::Draft),
            summary(3, PullRequestState::Merged),
            summary(4, PullRequestState::Closed),
            summary(5, PullRequestState::Open),
        ]);
        attach_policy_checks_with("fiber-teams", &mut result, |arguments| {
            calls.fetch_add(1, Ordering::Relaxed);
            let id = arguments
                .windows(2)
                .find(|pair| pair[0] == "--id")
                .map(|pair| pair[1].clone())
                .unwrap();
            observed.lock().unwrap().push(id.clone());
            match id.as_str() {
                "1" => Ok(serde_json::to_vec(&vec![evaluation("approved")]).unwrap()),
                "2" => Ok(serde_json::to_vec(&vec![evaluation("running")]).unwrap()),
                _ => Err(ProviderFailure::Unauthorized),
            }
        });
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        let mut observed = observed.into_inner().unwrap();
        observed.sort();
        assert_eq!(observed, ["1", "2", "5"]);
        let checks = result
            .pull_requests
            .iter()
            .map(|summary| (summary.number, summary.checks))
            .collect::<Vec<_>>();
        assert_eq!(
            checks,
            [
                (1, CheckState::Passing),
                (2, CheckState::Pending),
                (3, CheckState::Unsupported),
                (4, CheckState::Unsupported),
                (5, CheckState::Unknown),
            ]
        );
        assert_eq!(result.pull_requests.len(), 5);
        assert!(!result.incomplete && !result.truncated && result.parent_resolved);
    }

    #[test]
    fn policy_denial_is_suppressed_separately_from_pull_request_discovery() {
        let client = AzureDevOpsClient::new(std::path::Path::new("/private/provider-processes"));
        let key = azure_policy_suppression_key("fiber-teams");
        client.record_azure_suppression(&key, ProviderFailure::Unauthorized, 0);
        assert!(client.azure_suppressed(&key).is_some());
        let query = AzurePullRequestQuery {
            repository: AzureRepository {
                organization: "fiber-teams".into(),
                project: "Fiber Tests".into(),
                name: "Widget".into(),
            },
            head_branch: "feature".into(),
        };
        assert!(
            client
                .check_suppression(&query.repository.project_key(), &query.alias_key())
                .is_ok()
        );
        let mut result = scan(vec![summary(1, PullRequestState::Open)]);
        let deadline = termloop_platform::MonotonicDeadline::after(Duration::from_secs(1)).unwrap();
        client.attach_azure_policy_checks("fiber-teams", &mut result, deadline);
        assert_eq!(result.pull_requests[0].checks, CheckState::Unknown);
    }

    #[test]
    fn replacing_the_credential_clears_recorded_suppression() {
        let credential = crate::AzureDevOpsCredential::default();
        let client = AzureDevOpsClient::new(std::path::Path::new("/private/provider-processes"))
            .with_credential(credential.clone());
        let key = azure_policy_suppression_key("fiber-teams");
        client.record_azure_suppression(&key, ProviderFailure::Unauthorized, 0);
        assert!(client.azure_suppressed(&key).is_some());
        credential.replace(None).unwrap();
        assert!(client.azure_suppressed(&key).is_none());
    }

    #[test]
    fn a_denial_observed_under_a_replaced_credential_is_not_recorded() {
        let credential = crate::AzureDevOpsCredential::default();
        let client = AzureDevOpsClient::new(std::path::Path::new("/private/provider-processes"))
            .with_credential(credential.clone());
        let key = azure_policy_suppression_key("fiber-teams");
        let stale = credential.generation();
        credential.replace(None).unwrap();
        client.record_azure_suppression(&key, ProviderFailure::Unauthorized, stale);
        assert!(client.azure_suppressed(&key).is_none());
    }

    #[test]
    fn failing_policy_outcomes_are_classified_without_touching_the_scan() {
        let denied = termloop_platform::CommandOutcome {
            termination: CommandTermination::Exited { code: 1 },
            stdout: Vec::new(),
            stderr: b"ERROR: TF400813: The user is not authorized".to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        assert_eq!(
            classify_azure_outcome(&denied),
            Err(ProviderFailure::Unauthorized)
        );
        let truncated = termloop_platform::CommandOutcome {
            termination: CommandTermination::Exited { code: 0 },
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_truncated: true,
            stderr_truncated: false,
        };
        assert_eq!(
            classify_azure_outcome(&truncated),
            Err(ProviderFailure::OutputLimit)
        );
    }
}
