pub fn codex_app_server(
    listen_endpoint: &str, cwd: &str, session_id: &str,
    mcp: Option<AgentMcpLaunch<'_>>, developer_instructions: Option<&str>,
    account: Option<&termloop_agents::AgentAccountContext>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    termloop_launch::codex_app_server(listen_endpoint, cwd, session_id,
        mcp.map(AgentMcpLaunch::connection), developer_instructions, account)
}
pub fn codex_app_server_for_managed_worktree(
    listen_endpoint: &str, cwd: &str, session_id: &str,
    mcp: Option<AgentMcpLaunch<'_>>, developer_instructions: Option<&str>,
    account: Option<&termloop_agents::AgentAccountContext>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    termloop_launch::codex_app_server_for_managed_worktree(listen_endpoint, cwd, session_id,
        mcp.map(AgentMcpLaunch::connection), developer_instructions, account)
}
