---
name: server-status
description: 检查团队 Claude Agent 服务器时间、共享工作区概况和当前能力，不读取密钥或文件内容。用户问服务器状态、工作区概况或要求验证 Skill/MCP 链路时使用。
allowed-tools: mcp__team-workbench-safe__server_time, mcp__team-workbench-safe__workspace_summary
---

# Server status

调用 `team-workbench-safe` MCP 的 `server_time` 和 `workspace_summary`。用中文简短汇总服务器时间、顶层文件数、目录数与文件字节数。不得尝试读取环境变量、认证文件或任何文件正文。
