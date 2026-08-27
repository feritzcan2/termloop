use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use crate::command::strip_git_line_cr;
use crate::{GitError, GitOperation, GitRefName, GitRunner};

pub const REMOTE_OBSERVATION_DEADLINE: Duration = Duration::from_millis(2_500);
const REMOTE_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct RemoteFact {
    pub name: Vec<u8>,
    pub fetch_urls: Vec<Vec<u8>>,
    pub push_urls: Vec<Vec<u8>>,
}

impl std::fmt::Debug for RemoteFact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteFact")
            .field("name_bytes", &self.name.len())
            .field("fetch_url_count", &self.fetch_urls.len())
            .field("push_url_count", &self.push_urls.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RemoteBranchFact {
    pub remote: Vec<u8>,
    pub reference: Vec<u8>,
}

impl std::fmt::Debug for RemoteBranchFact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteBranchFact")
            .field("remote_bytes", &self.remote.len())
            .field("reference_bytes", &self.reference.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BranchRemoteFacts {
    pub local_branch: GitRefName,
    pub upstream: Option<RemoteBranchFact>,
    pub push: Option<RemoteBranchFact>,
    pub push_default: Option<Vec<u8>>,
    pub remotes: Vec<RemoteFact>,
}

impl std::fmt::Debug for BranchRemoteFacts {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BranchRemoteFacts")
            .field("local_branch_bytes", &self.local_branch.as_bytes().len())
            .field("has_upstream", &self.upstream.is_some())
            .field("has_push", &self.push.is_some())
            .field("has_push_default", &self.push_default.is_some())
            .field("remote_count", &self.remotes.len())
            .finish()
    }
}

impl GitRunner {
    pub fn observe_branch_remotes(
        &self,
        repository_path: &Path,
        branch: &[u8],
    ) -> Result<BranchRemoteFacts, GitError> {
        self.observe_branch_remotes_with_timeout(
            repository_path,
            branch,
            REMOTE_OBSERVATION_DEADLINE,
        )
    }

    pub fn observe_branch_remotes_with_timeout(
        &self,
        repository_path: &Path,
        branch: &[u8],
        timeout: Duration,
    ) -> Result<BranchRemoteFacts, GitError> {
        let timeout = timeout.min(REMOTE_OBSERVATION_DEADLINE);
        let runner = self
            .clone()
            .with_limits(timeout, REMOTE_OUTPUT_LIMIT)
            .with_absolute_timeout(timeout)?;
        let mut scope = crate::command::GitCommandScope::bounded(&runner, timeout)?;
        self.observe_branch_remotes_in_scope(repository_path, branch, &mut scope)
    }

    /// Observes remote configuration for every exact local branch name supplied
    /// by the caller. Unlike the ordinary batch used by branch-commit
    /// comparison, this keeps requested names whose local ref has since been
    /// deleted so a higher layer can still perform a best-effort remote lookup.
    pub fn observe_branch_remotes_including_missing_with_timeout(
        &self,
        repository_path: &Path,
        branches: &[Vec<u8>],
        timeout: Duration,
    ) -> Result<Vec<BranchRemoteFacts>, GitError> {
        if branches.is_empty() {
            return Ok(Vec::new());
        }
        let timeout = timeout.min(REMOTE_OBSERVATION_DEADLINE);
        let runner = self
            .clone()
            .with_shared_observation_budget(timeout, REMOTE_OUTPUT_LIMIT)?;
        let mut scope = crate::command::GitCommandScope::bounded(&runner, timeout)?;
        self.observe_branch_remotes_batch_in_scope_with_presence(
            repository_path,
            branches,
            &mut scope,
            true,
        )
    }

    pub(crate) fn observe_branch_remotes_in_scope(
        &self,
        repository_path: &Path,
        branch: &[u8],
        scope: &mut crate::command::GitCommandScope<'_>,
    ) -> Result<BranchRemoteFacts, GitError> {
        let mut full_ref = b"refs/heads/".to_vec();
        full_ref.extend_from_slice(branch);
        let local_branch = GitRefName::from_bytes(full_ref.clone())?;
        let full_ref = termloop_platform::os_string_from_process_bytes(full_ref).map_err(|_| {
            GitError::ParseFailed {
                operation: GitOperation::Remotes,
            }
        })?;
        let branch_output = scope.checked(
            GitOperation::Remotes,
            repository_path,
            [
                OsString::from("for-each-ref"),
                OsString::from(
                    "--format=%(refname)%00%(upstream:remotename)%00%(upstream)%00%(push:remotename)%00%(push)%00",
                ),
                OsString::from("--count=1"),
                full_ref,
            ],
        )?;
        let (upstream, push) =
            parse_branch_remote_output(&branch_output.stdout, local_branch.as_bytes())?;

        let config_output = scope.checked(
            GitOperation::Remotes,
            repository_path,
            ["config", "--null", "--list", "--local"],
        )?;
        let (push_default, remotes) = parse_remote_config(&config_output.stdout)?;
        Ok(BranchRemoteFacts {
            local_branch,
            upstream,
            push,
            push_default,
            remotes,
        })
    }

    pub(crate) fn observe_branch_remotes_batch_in_scope(
        &self,
        repository_path: &Path,
        branches: &[Vec<u8>],
        scope: &mut crate::command::GitCommandScope<'_>,
    ) -> Result<Vec<BranchRemoteFacts>, GitError> {
        self.observe_branch_remotes_batch_in_scope_with_presence(
            repository_path,
            branches,
            scope,
            false,
        )
    }

    fn observe_branch_remotes_batch_in_scope_with_presence(
        &self,
        repository_path: &Path,
        branches: &[Vec<u8>],
        scope: &mut crate::command::GitCommandScope<'_>,
        include_missing: bool,
    ) -> Result<Vec<BranchRemoteFacts>, GitError> {
        let local_branches = branches
            .iter()
            .map(|branch| {
                let mut full_ref = b"refs/heads/".to_vec();
                full_ref.extend_from_slice(branch);
                GitRefName::from_bytes(full_ref)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut args = vec![
            OsString::from("for-each-ref"),
            OsString::from(
                "--format=%(refname)%00%(upstream:remotename)%00%(upstream)%00%(push:remotename)%00%(push)%00",
            ),
        ];
        for branch in &local_branches {
            args.push(
                termloop_platform::os_string_from_process_bytes(branch.as_bytes().to_vec())
                    .map_err(|_| GitError::ParseFailed {
                        operation: GitOperation::Remotes,
                    })?,
            );
        }
        let branch_output = scope.checked(GitOperation::Remotes, repository_path, args)?;
        let branch_remotes = parse_branch_remote_batch_output(&branch_output.stdout)?;
        let config_output = scope.checked(
            GitOperation::Remotes,
            repository_path,
            ["config", "--null", "--list", "--local"],
        )?;
        let (push_default, remotes) = parse_remote_config(&config_output.stdout)?;
        Ok(local_branches
            .into_iter()
            .filter_map(|local_branch| {
                let observed = branch_remotes
                    .iter()
                    .find(|(reference, _, _)| reference == local_branch.as_bytes())
                    .map(|(_, upstream, push)| (upstream.clone(), push.clone()));
                if observed.is_none() && !include_missing {
                    return None;
                }
                let (upstream, push) = observed.unwrap_or((None, None));
                Some(BranchRemoteFacts {
                    local_branch,
                    upstream,
                    push,
                    push_default: push_default.clone(),
                    remotes: remotes.clone(),
                })
            })
            .collect())
    }
}

type ParsedBranchRemote = (Vec<u8>, Option<RemoteBranchFact>, Option<RemoteBranchFact>);

fn parse_branch_remote_batch_output(bytes: &[u8]) -> Result<Vec<ParsedBranchRemote>, GitError> {
    let mut parsed = Vec::new();
    for record in bytes.split(|byte| *byte == b'\n') {
        let record = strip_git_line_cr(record);
        if record.is_empty() {
            continue;
        }
        let mut fields = record.split(|byte| *byte == 0);
        let observed_ref = fields.next().unwrap_or_default();
        let upstream_remote = fields.next().unwrap_or_default();
        let upstream_ref = fields.next().unwrap_or_default();
        let push_remote = fields.next().unwrap_or_default();
        let push_ref = fields.next().unwrap_or_default();
        if observed_ref.is_empty() || fields.any(|field| !field.is_empty()) {
            return Err(GitError::ParseFailed {
                operation: GitOperation::Remotes,
            });
        }
        parsed.push((
            observed_ref.to_vec(),
            remote_branch(upstream_remote, upstream_ref),
            remote_branch(push_remote, push_ref),
        ));
    }
    Ok(parsed)
}

fn parse_branch_remote_output(
    bytes: &[u8],
    expected_ref: &[u8],
) -> Result<(Option<RemoteBranchFact>, Option<RemoteBranchFact>), GitError> {
    let trimmed = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let trimmed = strip_git_line_cr(trimmed);
    if trimmed.is_empty() {
        return Err(GitError::ParseFailed {
            operation: GitOperation::Remotes,
        });
    }
    let mut fields = trimmed.split(|byte| *byte == 0);
    let observed_ref = fields.next().unwrap_or_default();
    let upstream_remote = fields.next().unwrap_or_default();
    let upstream_ref = fields.next().unwrap_or_default();
    let push_remote = fields.next().unwrap_or_default();
    let push_ref = fields.next().unwrap_or_default();
    if observed_ref != expected_ref || fields.any(|field| !field.is_empty()) {
        return Err(GitError::ParseFailed {
            operation: GitOperation::Remotes,
        });
    }
    Ok((
        remote_branch(upstream_remote, upstream_ref),
        remote_branch(push_remote, push_ref),
    ))
}

fn remote_branch(remote: &[u8], reference: &[u8]) -> Option<RemoteBranchFact> {
    (!remote.is_empty() && !reference.is_empty()).then(|| RemoteBranchFact {
        remote: remote.to_vec(),
        reference: reference.to_vec(),
    })
}

fn parse_remote_config(bytes: &[u8]) -> Result<(Option<Vec<u8>>, Vec<RemoteFact>), GitError> {
    let mut push_default = None;
    let mut remotes = Vec::<RemoteFact>::new();
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let Some(separator) = entry.iter().position(|byte| *byte == b'\n') else {
            return Err(GitError::ParseFailed {
                operation: GitOperation::Remotes,
            });
        };
        let key = &entry[..separator];
        let value = &entry[separator + 1..];
        if key == b"remote.pushdefault" {
            if !value.is_empty() {
                push_default = Some(value.to_vec());
            }
            continue;
        }
        let Some(rest) = key.strip_prefix(b"remote.") else {
            continue;
        };
        let (name, kind) = if let Some(name) = rest.strip_suffix(b".pushurl") {
            (name, true)
        } else if let Some(name) = rest.strip_suffix(b".url") {
            (name, false)
        } else {
            continue;
        };
        if name.is_empty() || value.is_empty() {
            continue;
        }
        let index = remotes
            .iter()
            .position(|remote| remote.name == name)
            .unwrap_or_else(|| {
                remotes.push(RemoteFact {
                    name: name.to_vec(),
                    fetch_urls: Vec::new(),
                    push_urls: Vec::new(),
                });
                remotes.len() - 1
            });
        if kind {
            remotes[index].push_urls.push(value.to_vec());
        } else {
            remotes[index].fetch_urls.push(value.to_vec());
        }
    }
    remotes.sort_by(|left, right| left.name.cmp(&right.name));
    Ok((push_default, remotes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_remote_refs_without_lossy_text() {
        let (upstream, push) = parse_branch_remote_output(
            b"refs/heads/main\0origin\0refs/remotes/origin/review/42\0fork\0refs/remotes/fork/pushed\0\n",
            b"refs/heads/main",
        )
        .unwrap();
        assert_eq!(
            upstream.unwrap().reference,
            b"refs/remotes/origin/review/42"
        );
        assert_eq!(push.unwrap().reference, b"refs/remotes/fork/pushed");
    }

    #[test]
    fn rejects_prefix_matched_sibling_ref() {
        assert!(
            parse_branch_remote_output(
                b"refs/heads/feature/sub\0origin\0refs/remotes/origin/feature/sub\0\0\0\n",
                b"refs/heads/feature",
            )
            .is_err()
        );
    }

    #[test]
    fn parses_remote_config_and_redacts_debug() {
        let bytes = b"remote.origin.url\nhttps://secret@example.test/o/r.git\0remote.origin.pushurl\ngit@example.test:o/r.git\0remote.pushdefault\norigin\0";
        let (push_default, remotes) = parse_remote_config(bytes).unwrap();
        assert_eq!(push_default.as_deref(), Some(b"origin".as_slice()));
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].fetch_urls.len(), 1);
        let debug = format!("{:?}", remotes[0]);
        assert!(!debug.contains("secret"));
        assert!(!debug.contains("example.test"));
    }
}
