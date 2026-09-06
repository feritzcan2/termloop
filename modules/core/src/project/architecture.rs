use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use termloop_gitio::{GitRunner, HeadState};
use termloop_platform::{
    CommandRequest, LaunchEnvironment, PathEntryState, PlatformError, path_entry_state,
    read_bounded_file_if_present, resolve_launch_target, run_command, state_directory,
    write_private_file,
};
use uuid::Uuid;

use crate::{CoreError, CoreRuntime};

const GRAPH_BYTES_LIMIT: usize = 128 * 1024 * 1024;
const SOURCE_NODE_LIMIT: usize = 100_000;
const SOURCE_EDGE_LIMIT: usize = 500_000;
const HOTSPOT_LIMIT: usize = 50;
const COMMUNITY_SUMMARY_LIMIT: usize = 2_000;
const GRAPH_EDGE_LIMIT: usize = 4_000;
const NODE_CONNECTION_LIMIT: usize = 256;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
pub struct ProjectArchitecturePlan {
    project_id: String,
    project_folder: PathBuf,
    cache_root: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
struct RawGraph {
    #[serde(default)]
    nodes: Vec<RawNode>,
    #[serde(default)]
    links: Vec<RawEdge>,
    #[serde(default)]
    built_at_commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawNode {
    id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "type")]
    node_type: Option<String>,
    #[serde(default)]
    file_type: Option<String>,
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default)]
    source_location: Option<String>,
    #[serde(default)]
    community: Option<Community>,
    #[serde(default)]
    community_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawEdge {
    source: String,
    target: String,
    #[serde(default)]
    relation: Option<String>,
    #[serde(default)]
    confidence: Option<String>,
    #[serde(default)]
    confidence_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(untagged)]
enum Community {
    Number(i64),
    Text(String),
}

#[derive(Debug, Clone, Serialize)]
struct ArchitectureNode {
    id: String,
    label: String,
    kind: String,
    file_type: Option<String>,
    source_file: Option<String>,
    source_location: Option<String>,
    community: Option<Community>,
    community_name: Option<String>,
    fan_in: u64,
    fan_out: u64,
    degree: u64,
    risk_score: f64,
    neighbor_community_count: u64,
}

#[derive(Debug, Clone, Serialize)]
struct ArchitectureEdge {
    source: String,
    target: String,
    relation: String,
    confidence: String,
    confidence_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct ArchitectureCommunitySummary {
    key: String,
    name: String,
    node_count: u64,
    risk_score: f64,
}

struct ArchitectureIndex {
    built_at_commit: Option<String>,
    nodes: Vec<ArchitectureNode>,
    edges: Vec<ArchitectureEdge>,
    warning: Option<String>,
}

impl CoreRuntime {
    pub fn plan_project_architecture(
        &self,
        project_id: &str,
    ) -> Result<ProjectArchitecturePlan, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        if Uuid::parse_str(&project.id).is_err() {
            return Err(CoreError::Store(
                "Project architecture cache identity is invalid".into(),
            ));
        }
        let cache_root = state_directory()
            .map_err(platform_error)?
            .join("architecture")
            .join(&project.id);
        Ok(ProjectArchitecturePlan {
            project_id: project.id.clone(),
            project_folder: PathBuf::from(&project.folder_path),
            cache_root,
        })
    }
}

impl ProjectArchitecturePlan {
    pub fn summary(&self) -> Result<Value, CoreError> {
        self.read().map(|observation| observation.summary)
    }

    pub fn graph(
        &self,
        center_node_id: Option<&str>,
        community_key: Option<&str>,
        depth: usize,
        limit: usize,
    ) -> Result<Value, CoreError> {
        if center_node_id.is_some() && community_key.is_some() {
            return Err(CoreError::InvalidParams(
                "Architecture graph accepts either a center node or a community, not both".into(),
            ));
        }
        let observation = self.read()?;
        let Some(index) = observation.index else {
            return Ok(json!({
                "summary": observation.summary,
                "nodes": [],
                "edges": [],
                "truncated": false,
            }));
        };
        index.graph_result(
            observation.summary,
            center_node_id,
            community_key,
            depth,
            limit,
        )
    }

    pub fn node(&self, node_id: &str) -> Result<Value, CoreError> {
        let observation = self.read()?;
        let index = observation.index.ok_or(CoreError::NotFound)?;
        index.node_result(observation.summary, node_id)
    }

    pub fn refresh(&self) -> Result<Value, CoreError> {
        let environment = LaunchEnvironment::os_baseline();
        let target = match resolve_launch_target("graphify", &environment) {
            Ok(target) => target,
            Err(PlatformError::LaunchTargetNotFound | PlatformError::LaunchTargetUnusable) => {
                return self.read_with_override(
                    "unavailable",
                    false,
                    Some("Graphify CLI is not installed. Install it with `uv tool install graphifyy`.".into()),
                );
            }
            Err(error) => return Err(platform_error(error)),
        };

        write_private_file(&self.cache_root.join(".termloop-cache"), b"graphify\n")
            .map_err(platform_error)?;
        let mut arguments = vec![
            OsString::from("extract"),
            self.project_folder.as_os_str().to_owned(),
            OsString::from("--code-only"),
            OsString::from("--out"),
            self.cache_root.as_os_str().to_owned(),
            OsString::from("--max-workers"),
            OsString::from("8"),
        ];
        if path_entry_state(&self.project_folder.join("Cargo.toml")).map_err(platform_error)?
            == PathEntryState::Present
        {
            arguments.push(OsString::from("--cargo"));
        }
        let (program, arguments) = target.command_line(arguments);
        let outcome = match run_command(
            CommandRequest::new(program)
                .args(arguments)
                .cwd(&self.project_folder)
                .launch_environment(environment)
                .environment("GRAPHIFY_VIZ_NODE_LIMIT", "0")
                .timeout(REFRESH_TIMEOUT)
                .output_limit(512 * 1024),
        ) {
            Ok(outcome) => outcome,
            Err(_) => {
                return self.read_with_override(
                    "failed",
                    true,
                    Some(
                        "Graphify could not refresh the architecture index; the previous index is shown when available."
                            .into(),
                    ),
                );
            }
        };
        if !outcome.success() {
            return self.read_with_override(
                "failed",
                true,
                Some("Graphify could not refresh the architecture index; the previous index is shown when available.".into()),
            );
        }
        let summary = self.summary()?;
        if summary.get("status").and_then(Value::as_str) == Some("missing") {
            return self.read_with_override(
                "failed",
                true,
                Some("Graphify finished without producing an architecture graph.".into()),
            );
        }
        Ok(summary)
    }

    fn read(&self) -> Result<ArchitectureObservation, CoreError> {
        let engine_available = architecture_engine_available();
        let current_commit = current_commit(&self.project_folder);
        let graph_path = self.cache_root.join("graphify-out").join("graph.json");
        let Some(bytes) =
            read_bounded_file_if_present(&graph_path, GRAPH_BYTES_LIMIT).map_err(platform_error)?
        else {
            return Ok(ArchitectureObservation {
                summary: empty_summary(
                    &self.project_id,
                    if engine_available {
                        "missing"
                    } else {
                        "unavailable"
                    },
                    engine_available,
                    current_commit,
                    None,
                ),
                index: None,
            });
        };
        match ArchitectureIndex::parse(&bytes) {
            Ok(index) => {
                let status = if index.built_at_commit.as_deref().is_some()
                    && current_commit.as_deref().is_some()
                    && index.built_at_commit != current_commit
                {
                    "stale"
                } else {
                    "ready"
                };
                let summary =
                    index.summary(&self.project_id, status, engine_available, current_commit);
                Ok(ArchitectureObservation {
                    summary,
                    index: Some(index),
                })
            }
            Err(()) => Ok(ArchitectureObservation {
                summary: empty_summary(
                    &self.project_id,
                    "invalid",
                    engine_available,
                    current_commit,
                    Some(
                        "The cached Graphify graph is invalid. Refresh it to rebuild the index."
                            .into(),
                    ),
                ),
                index: None,
            }),
        }
    }

    fn read_with_override(
        &self,
        status: &str,
        engine_available: bool,
        warning: Option<String>,
    ) -> Result<Value, CoreError> {
        let mut observation = self.read()?;
        observation.summary["status"] = Value::String(status.into());
        observation.summary["engine_available"] = Value::Bool(engine_available);
        observation.summary["warning"] = warning.map(Value::String).unwrap_or(Value::Null);
        Ok(observation.summary)
    }
}

struct ArchitectureObservation {
    summary: Value,
    index: Option<ArchitectureIndex>,
}

impl ArchitectureIndex {
    fn parse(bytes: &[u8]) -> Result<Self, ()> {
        let source = serde_json::from_slice::<RawGraph>(bytes).map_err(|_| ())?;
        if source.nodes.len() > SOURCE_NODE_LIMIT || source.links.len() > SOURCE_EDGE_LIMIT {
            return Err(());
        }
        let mut ids = HashMap::with_capacity(source.nodes.len());
        let mut seen_ids = HashSet::with_capacity(source.nodes.len());
        let mut excluded_ids = HashSet::new();
        let mut nodes = Vec::with_capacity(source.nodes.len());
        for raw in source.nodes {
            if !valid_required(&raw.id, 1024) || !seen_ids.insert(raw.id.clone()) {
                return Err(());
            }
            if excluded_source_path(raw.source_file.as_deref()) {
                excluded_ids.insert(raw.id);
                continue;
            }
            let label = raw.label.unwrap_or_else(|| raw.id.clone());
            if !valid_required(&label, 512)
                || raw
                    .node_type
                    .as_ref()
                    .is_some_and(|value| !valid_required(value, 64))
                || !valid_optional(&raw.file_type, 64)
                || !valid_optional(&raw.source_file, 4096)
                || !valid_optional(&raw.source_location, 1024)
                || !valid_optional(&raw.community_name, 256)
                || raw.community.as_ref().is_some_and(|community| {
                    matches!(community, Community::Text(value) if !valid_required(value, 128))
                })
            {
                return Err(());
            }
            let kind = raw
                .node_type
                .unwrap_or_else(|| infer_kind(&label, raw.source_file.as_deref()));
            let index = nodes.len();
            ids.insert(raw.id.clone(), index);
            nodes.push(ArchitectureNode {
                id: raw.id,
                label,
                kind,
                file_type: raw.file_type,
                source_file: raw.source_file,
                source_location: raw.source_location,
                community: raw.community,
                community_name: raw.community_name,
                fan_in: 0,
                fan_out: 0,
                degree: 0,
                risk_score: 0.0,
                neighbor_community_count: 0,
            });
        }

        let mut edges = Vec::with_capacity(source.links.len());
        let mut neighbor_communities = vec![HashSet::<Community>::new(); nodes.len()];
        let mut cross_community_degree = vec![0_u64; nodes.len()];
        let mut skipped_edges = 0_usize;
        for raw in source.links {
            if excluded_ids.contains(&raw.source) || excluded_ids.contains(&raw.target) {
                continue;
            }
            let (Some(&source_index), Some(&target_index)) =
                (ids.get(&raw.source), ids.get(&raw.target))
            else {
                skipped_edges += 1;
                continue;
            };
            let relation = raw.relation.unwrap_or_else(|| "depends_on".into());
            if !valid_required(&relation, 128) {
                skipped_edges += 1;
                continue;
            }
            if !ownership_relation(&relation) {
                nodes[source_index].fan_out += 1;
                nodes[target_index].fan_in += 1;
                if nodes[source_index].community != nodes[target_index].community {
                    cross_community_degree[source_index] += 1;
                    cross_community_degree[target_index] += 1;
                    if let Some(community) = nodes[target_index].community.clone() {
                        neighbor_communities[source_index].insert(community);
                    }
                    if let Some(community) = nodes[source_index].community.clone() {
                        neighbor_communities[target_index].insert(community);
                    }
                }
            }
            edges.push(ArchitectureEdge {
                source: raw.source,
                target: raw.target,
                relation,
                confidence: normalize_confidence(raw.confidence.as_deref()),
                confidence_score: raw
                    .confidence_score
                    .filter(|score| score.is_finite())
                    .map(|score| score.clamp(0.0, 1.0)),
            });
        }
        for node in &mut nodes {
            node.degree = node.fan_in + node.fan_out;
        }
        let max_fan_in = log_max(nodes.iter().map(|node| node.fan_in));
        let max_fan_out = log_max(nodes.iter().map(|node| node.fan_out));
        let max_cross = log_max(cross_community_degree.iter().copied());
        let max_reach = log_max(
            neighbor_communities
                .iter()
                .map(|communities| communities.len() as u64),
        );
        for (index, node) in nodes.iter_mut().enumerate() {
            node.neighbor_community_count = neighbor_communities[index].len() as u64;
            let score = 100.0
                * (0.35 * normalized_log(node.fan_in, max_fan_in)
                    + 0.25 * normalized_log(node.fan_out, max_fan_out)
                    + 0.25 * normalized_log(cross_community_degree[index], max_cross)
                    + 0.15 * normalized_log(node.neighbor_community_count, max_reach));
            node.risk_score = (score * 10.0).round() / 10.0;
        }
        Ok(Self {
            built_at_commit: source
                .built_at_commit
                .filter(|value| valid_required(value, 128)),
            nodes,
            edges,
            warning: (skipped_edges > 0)
                .then(|| format!("Skipped {skipped_edges} invalid or dangling graph edges.")),
        })
    }

    fn summary(
        &self,
        project_id: &str,
        status: &str,
        engine_available: bool,
        current_commit: Option<String>,
    ) -> Value {
        let mut hotspots = self.nodes.iter().collect::<Vec<_>>();
        hotspots.sort_by(|left, right| hotspot_order(left, right));
        let hotspots = hotspots.into_iter().take(HOTSPOT_LIMIT).collect::<Vec<_>>();
        let (community_count, communities) = self.community_summaries();
        let community_catalog_truncated = community_count > communities.len() as u64;
        json!({
            "project_id": project_id,
            "status": status,
            "engine_available": engine_available,
            "built_at_commit": self.built_at_commit,
            "current_commit": current_commit,
            "node_count": self.nodes.len() as u64,
            "edge_count": self.edges.len() as u64,
            "community_count": community_count,
            "communities": communities,
            "community_catalog_truncated": community_catalog_truncated,
            "hotspots": hotspots,
            "warning": self.warning,
        })
    }

    fn community_summaries(&self) -> (u64, Vec<ArchitectureCommunitySummary>) {
        let mut groups = BTreeMap::<String, (usize, Option<usize>, u64)>::new();
        for (index, node) in self.nodes.iter().enumerate() {
            groups
                .entry(community_key(node.community.as_ref()))
                .and_modify(|(representative, named, count)| {
                    *count += 1;
                    if hotspot_order(node, &self.nodes[*representative]).is_lt() {
                        *representative = index;
                    }
                    if node.community_name.is_some()
                        && named
                            .is_none_or(|current| hotspot_order(node, &self.nodes[current]).is_lt())
                    {
                        *named = Some(index);
                    }
                })
                .or_insert((index, node.community_name.as_ref().map(|_| index), 1));
        }
        let community_count = groups.len() as u64;
        let mut summaries = groups
            .into_iter()
            .map(|(key, (representative_index, named_index, node_count))| {
                let representative = &self.nodes[representative_index];
                let named = &self.nodes[named_index.unwrap_or(representative_index)];
                ArchitectureCommunitySummary {
                    key,
                    name: architecture_area_name(named),
                    node_count,
                    risk_score: representative.risk_score,
                }
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| {
            right
                .risk_score
                .total_cmp(&left.risk_score)
                .then_with(|| right.node_count.cmp(&left.node_count))
                .then_with(|| left.name.cmp(&right.name))
        });
        summaries.truncate(COMMUNITY_SUMMARY_LIMIT);
        (community_count, summaries)
    }

    fn graph_result(
        &self,
        summary: Value,
        center_node_id: Option<&str>,
        selected_community: Option<&str>,
        depth: usize,
        limit: usize,
    ) -> Result<Value, CoreError> {
        let limit = limit.clamp(20, 500);
        let selected = match (center_node_id, selected_community) {
            (Some(center), None) => self.neighborhood(center, depth.clamp(1, 3), limit)?,
            (None, Some(community)) => self.community_view(community, limit)?,
            (None, None) => self.overview(limit),
            (Some(_), Some(_)) => {
                return Err(CoreError::InvalidParams(
                    "Architecture graph accepts either a center node or a community, not both"
                        .into(),
                ));
            }
        };
        let nodes = self
            .nodes
            .iter()
            .filter(|node| selected.contains(&node.id))
            .collect::<Vec<_>>();
        let matching_edge_count = self
            .edges
            .iter()
            .filter(|edge| selected.contains(&edge.source) && selected.contains(&edge.target))
            .count();
        let edges = self
            .edges
            .iter()
            .filter(|edge| selected.contains(&edge.source) && selected.contains(&edge.target))
            .take(GRAPH_EDGE_LIMIT)
            .collect::<Vec<_>>();
        Ok(json!({
            "summary": summary,
            "nodes": nodes,
            "edges": edges,
            "truncated": selected.len() < self.nodes.len() || edges.len() < matching_edge_count,
        }))
    }

    fn node_result(&self, summary: Value, node_id: &str) -> Result<Value, CoreError> {
        let node = self
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(CoreError::NotFound)?;
        let matching = self
            .edges
            .iter()
            .filter(|edge| edge.source == node_id || edge.target == node_id)
            .collect::<Vec<_>>();
        let truncated = matching.len() > NODE_CONNECTION_LIMIT;
        Ok(json!({
            "summary": summary,
            "node": node,
            "connections": matching.into_iter().take(NODE_CONNECTION_LIMIT).collect::<Vec<_>>(),
            "truncated": truncated,
        }))
    }

    fn overview(&self, limit: usize) -> HashSet<String> {
        let mut by_community = BTreeMap::<String, &ArchitectureNode>::new();
        for node in &self.nodes {
            let key = community_key(node.community.as_ref());
            by_community
                .entry(key)
                .and_modify(|current| {
                    if hotspot_order(node, current).is_lt() {
                        *current = node;
                    }
                })
                .or_insert(node);
        }
        let mut representatives = by_community.values().copied().collect::<Vec<_>>();
        representatives.sort_by(|left, right| hotspot_order(left, right));
        let mut selected = representatives
            .into_iter()
            .take(limit)
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        let mut ranked = self.nodes.iter().collect::<Vec<_>>();
        ranked.sort_by(|left, right| hotspot_order(left, right));
        for node in ranked {
            if selected.len() >= limit {
                break;
            }
            selected.insert(node.id.clone());
        }
        selected
    }

    fn neighborhood(
        &self,
        center: &str,
        depth: usize,
        limit: usize,
    ) -> Result<HashSet<String>, CoreError> {
        if !self.nodes.iter().any(|node| node.id == center) {
            return Err(CoreError::NotFound);
        }
        let mut adjacency = HashMap::<&str, Vec<&str>>::new();
        for edge in self
            .edges
            .iter()
            .filter(|edge| !ownership_relation(&edge.relation))
        {
            adjacency
                .entry(&edge.source)
                .or_default()
                .push(&edge.target);
            adjacency
                .entry(&edge.target)
                .or_default()
                .push(&edge.source);
        }
        let mut selected = HashSet::from([center.to_owned()]);
        let mut queue = VecDeque::from([(center, 0_usize)]);
        while let Some((node, distance)) = queue.pop_front() {
            if distance >= depth || selected.len() >= limit {
                continue;
            }
            for neighbor in adjacency.get(node).into_iter().flatten() {
                if selected.len() >= limit {
                    break;
                }
                if selected.insert((*neighbor).to_owned()) {
                    queue.push_back((neighbor, distance + 1));
                }
            }
        }
        Ok(selected)
    }

    fn community_view(
        &self,
        selected_community: &str,
        limit: usize,
    ) -> Result<HashSet<String>, CoreError> {
        let mut members = self
            .nodes
            .iter()
            .filter(|node| community_key(node.community.as_ref()) == selected_community)
            .collect::<Vec<_>>();
        if members.is_empty() {
            return Err(CoreError::NotFound);
        }
        members.sort_by(|left, right| hotspot_order(left, right));

        let member_budget = members.len().min((limit * 4 / 5).max(1));
        let mut selected = members
            .iter()
            .take(member_budget)
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        let member_ids = members
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        let mut boundary_ids = HashSet::new();
        for edge in self
            .edges
            .iter()
            .filter(|edge| !ownership_relation(&edge.relation))
        {
            if selected.contains(&edge.source) && !member_ids.contains(edge.target.as_str()) {
                boundary_ids.insert(edge.target.as_str());
            }
            if selected.contains(&edge.target) && !member_ids.contains(edge.source.as_str()) {
                boundary_ids.insert(edge.source.as_str());
            }
        }
        let mut boundary = self
            .nodes
            .iter()
            .filter(|node| boundary_ids.contains(node.id.as_str()))
            .collect::<Vec<_>>();
        boundary.sort_by(|left, right| hotspot_order(left, right));
        for node in boundary.into_iter().take(limit / 5) {
            selected.insert(node.id.clone());
        }
        for node in members.into_iter().skip(member_budget) {
            if selected.len() >= limit {
                break;
            }
            selected.insert(node.id.clone());
        }
        Ok(selected)
    }
}

fn empty_summary(
    project_id: &str,
    status: &str,
    engine_available: bool,
    current_commit: Option<String>,
    warning: Option<String>,
) -> Value {
    json!({
        "project_id": project_id,
        "status": status,
        "engine_available": engine_available,
        "built_at_commit": null,
        "current_commit": current_commit,
        "node_count": 0,
        "edge_count": 0,
        "community_count": 0,
        "communities": [],
        "community_catalog_truncated": false,
        "hotspots": [],
        "warning": warning,
    })
}

fn architecture_engine_available() -> bool {
    resolve_launch_target("graphify", &LaunchEnvironment::os_baseline()).is_ok()
}

fn current_commit(project_folder: &Path) -> Option<String> {
    let facts = GitRunner::discover_with_timeout(Duration::from_secs(10))
        .ok()?
        .inspect_repository(project_folder)
        .ok()?;
    let oid = match facts.head {
        HeadState::Attached { oid, .. } | HeadState::Detached { oid } => oid,
        HeadState::Unborn { .. } => return None,
    };
    std::str::from_utf8(oid.as_bytes()).ok().map(str::to_owned)
}

fn platform_error(error: PlatformError) -> CoreError {
    CoreError::Store(format!(
        "Project architecture platform operation failed: {error}"
    ))
}

fn ownership_relation(relation: &str) -> bool {
    matches!(
        relation.to_ascii_lowercase().as_str(),
        "contains" | "method" | "has_method" | "defines" | "defined_in"
    )
}

fn normalize_confidence(confidence: Option<&str>) -> String {
    match confidence.map(str::to_ascii_lowercase).as_deref() {
        Some("extracted") | Some("high") => "extracted",
        Some("inferred") | Some("medium") => "inferred",
        Some("ambiguous") | Some("low") => "ambiguous",
        _ => "unknown",
    }
    .into()
}

fn infer_kind(label: &str, source_file: Option<&str>) -> String {
    let label_lower = label.to_ascii_lowercase();
    let source_basename = source_file
        .and_then(|source| source.rsplit(['/', '\\']).next())
        .map(str::to_ascii_lowercase);
    if [
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".kt", ".cs", ".cpp", ".c",
        ".h",
    ]
    .iter()
    .any(|extension| label_lower.ends_with(extension))
        || source_basename.as_deref() == Some(label_lower.as_str())
    {
        "file".into()
    } else if label.ends_with("()") {
        "function".into()
    } else if label.chars().next().is_some_and(char::is_uppercase) {
        "type".into()
    } else {
        "symbol".into()
    }
}

fn valid_required(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max
}

fn valid_optional(value: &Option<String>, max: usize) -> bool {
    value
        .as_ref()
        .is_none_or(|value| value.chars().count() <= max)
}

fn excluded_source_path(source_file: Option<&str>) -> bool {
    let Some(source_file) = source_file else {
        return false;
    };
    let normalized = source_file.replace('\\', "/").to_ascii_lowercase();
    let components = normalized
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    components.iter().any(|component| {
        matches!(
            *component,
            ".git" | ".zig-cache" | "node_modules" | "vendor" | "target" | "dist"
        )
    }) || components
        .windows(2)
        .any(|pair| pair == ["contract", "generated"])
}

fn log_max(values: impl Iterator<Item = u64>) -> f64 {
    values
        .map(|value| (value as f64 + 1.0).ln())
        .fold(0.0, f64::max)
}

fn normalized_log(value: u64, maximum: f64) -> f64 {
    if maximum <= f64::EPSILON {
        0.0
    } else {
        (value as f64 + 1.0).ln() / maximum
    }
}

fn hotspot_order(left: &ArchitectureNode, right: &ArchitectureNode) -> std::cmp::Ordering {
    right
        .risk_score
        .total_cmp(&left.risk_score)
        .then_with(|| right.degree.cmp(&left.degree))
        .then_with(|| left.label.cmp(&right.label))
}

fn community_key(community: Option<&Community>) -> String {
    match community {
        Some(Community::Number(value)) => format!("n:{value}"),
        Some(Community::Text(value)) => format!("s:{value}"),
        None => "z:".into(),
    }
}

fn architecture_area_name(node: &ArchitectureNode) -> String {
    if let Some(name) = &node.community_name {
        return name.clone();
    }
    if let Some(source_file) = &node.source_file {
        let normalized = source_file.replace('\\', "/");
        let parts = normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if let Some(file) = parts.last() {
            let parent = parts[..parts.len().saturating_sub(1)]
                .iter()
                .rev()
                .copied()
                .find(|part| {
                    !matches!(
                        part.to_ascii_lowercase().as_str(),
                        "src" | "source" | "lib" | "app"
                    )
                });
            let name =
                parent.map_or_else(|| (*file).to_owned(), |parent| format!("{parent} / {file}"));
            return name.chars().take(512).collect();
        }
    }
    node.label.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ArchitectureIndex {
        ArchitectureIndex::parse(
            br#"{
          "built_at_commit":"abc123",
          "nodes":[
            {"id":"a","label":"App","community":1},
            {"id":"b","label":"run()","community":2},
            {"id":"c","label":"src/lib.rs","community":1}
          ],
          "links":[
            {"source":"a","target":"b","relation":"calls","confidence":"extracted"},
            {"source":"a","target":"c","relation":"contains"},
            {"source":"missing","target":"a","relation":"calls"}
          ]
        }"#,
        )
        .unwrap()
    }

    #[test]
    fn metrics_ignore_ownership_edges_and_count_cross_community_risk() {
        let index = fixture();
        let app = index.nodes.iter().find(|node| node.id == "a").unwrap();
        let function = index.nodes.iter().find(|node| node.id == "b").unwrap();
        assert_eq!((app.fan_in, app.fan_out, app.degree), (0, 1, 1));
        assert_eq!((function.fan_in, function.fan_out), (1, 0));
        assert_eq!(app.neighbor_community_count, 1);
        assert!(app.risk_score > 0.0);
        assert_eq!(
            index.warning.as_deref(),
            Some("Skipped 1 invalid or dangling graph edges.")
        );
    }

    #[test]
    fn centered_graph_is_bounded_to_the_requested_depth() {
        let index = fixture();
        let selected = index.neighborhood("b", 1, 20).unwrap();
        assert_eq!(selected, HashSet::from(["a".into(), "b".into()]));
        assert!(matches!(
            index.neighborhood("absent", 2, 20),
            Err(CoreError::NotFound)
        ));
    }

    #[test]
    fn community_graph_includes_members_and_structural_boundary_context() {
        let index = fixture();

        assert_eq!(
            index.community_view("n:2", 20).unwrap(),
            HashSet::from(["a".into(), "b".into()])
        );
        assert!(matches!(
            index.community_view("n:missing", 20),
            Err(CoreError::NotFound)
        ));
    }

    #[test]
    fn duplicate_nodes_make_the_cache_invalid() {
        let duplicate = br#"{"nodes":[{"id":"a"},{"id":"a"}],"links":[]}"#;
        assert!(ArchitectureIndex::parse(duplicate).is_err());
    }

    #[test]
    fn kind_inference_does_not_turn_every_symbol_with_a_source_file_into_a_file() {
        assert_eq!(infer_kind("Shell.tsx", Some("ui/Shell.tsx")), "file");
        assert_eq!(infer_kind("render()", Some("ui/Shell.tsx")), "function");
        assert_eq!(infer_kind("Shell", Some("ui/Shell.tsx")), "type");
    }

    #[test]
    fn generated_and_vendored_nodes_do_not_pollute_owned_architecture() {
        let index = ArchitectureIndex::parse(
            br#"{
              "nodes":[
                {"id":"owned","source_file":"modules/core/src/lib.rs"},
                {"id":"vendored","source_file":"vendor/dependency/src/lib.rs"},
                {"id":"generated","source_file":"contract/generated/rust/src/current.rs"}
              ],
              "links":[
                {"source":"owned","target":"vendored","relation":"calls"},
                {"source":"generated","target":"owned","relation":"calls"}
              ]
            }"#,
        )
        .unwrap();

        assert_eq!(index.nodes.len(), 1);
        assert_eq!(index.nodes[0].id, "owned");
        assert!(index.edges.is_empty());
        assert!(index.warning.is_none());
    }

    #[test]
    fn overview_prioritizes_the_highest_risk_community_representatives() {
        let mut index = fixture();
        index.nodes[0].risk_score = 10.0;
        index.nodes[1].risk_score = 90.0;

        assert_eq!(index.overview(1), HashSet::from(["b".into()]));
    }

    #[test]
    fn community_catalog_is_counted_named_and_ranked() {
        let mut index = fixture();
        index.nodes[0].source_file = Some("clients/desktop/src/renderer/ui/Shell.tsx".into());
        let (count, summaries) = index.community_summaries();

        assert_eq!(count, 2);
        let application = summaries
            .iter()
            .find(|community| community.key == "n:1")
            .unwrap();
        assert_eq!(application.name, "ui / Shell.tsx");
        assert_eq!(application.node_count, 2);
    }
}
