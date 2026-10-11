import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function directoryNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function markdownNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

async function jsonFile(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
}

function frontmatterDescription(content) {
  const match = content.match(/^---\s*[\s\S]*?^description:\s*["']?([^\r\n"']+)["']?\s*$[\s\S]*?^---/m);
  return match?.[1]?.trim() || "自定义工作流程";
}

async function skillCommands(dir, category = "Skill") {
  const names = await directoryNames(dir);
  const result = [];
  for (const name of names) {
    try {
      const content = await readFile(path.join(dir, name, "SKILL.md"), "utf8");
      result.push({ value: `/${name}`, name, description: frontmatterDescription(content), category });
    } catch {
      // A folder without SKILL.md is not an invocable skill.
    }
  }
  return result;
}

async function legacyCommands(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
      const name = entry.name.slice(0, -3);
      const content = await readFile(path.join(dir, entry.name), "utf8");
      result.push({ value: `/${name}`, name, description: frontmatterDescription(content), category: "Command" });
    }
    return result;
  } catch {
    return [];
  }
}

const bundledCommands = [
  { value: "/batch", name: "batch", description: "并行处理一批相互独立的任务", category: "内置 Skill" },
  { value: "/claude-api", name: "claude-api", description: "构建调用 Claude API 的应用", category: "内置 Skill" },
  { value: "/clear", name: "clear", description: "清空当前 Claude 上下文并开始一个新 session", category: "会话控制" },
  { value: "/compact", name: "compact", description: "将当前上下文压缩为摘要，可在后面附加保留要求", category: "会话控制" },
  { value: "/debug", name: "debug", description: "根据当前会话日志排查问题", category: "内置 Skill" },
  { value: "/loop", name: "loop", description: "按间隔重复执行提示或斜杠命令", category: "内置 Skill" },
  { value: "/simplify", name: "simplify", description: "审查近期改动并改进代码质量", category: "内置 Skill" },
];

export async function inspectCapabilities({ homeDir, workspaceDir }) {
  const claudeDir = path.join(homeDir, ".claude");
  const skills = [...new Set([
    ...(await directoryNames(path.join(claudeDir, "skills"))),
    ...(await directoryNames(path.join(workspaceDir, ".claude", "skills"))),
  ])].sort();
  const agents = [...new Set([
    "Explore", "Plan", "general-purpose",
    ...(await markdownNames(path.join(claudeDir, "agents"))),
    ...(await markdownNames(path.join(workspaceDir, ".claude", "agents"))),
  ])];
  const userConfig = await jsonFile(path.join(homeDir, ".claude.json"));
  const projectConfig = await jsonFile(path.join(workspaceDir, ".mcp.json"));
  const mcpNames = [...new Set([
    ...Object.keys(userConfig.mcpServers || {}),
    ...Object.keys(projectConfig.mcpServers || {}),
  ])].sort();
  const discoveredCommands = [
    ...(await skillCommands(path.join(claudeDir, "skills"))),
    ...(await skillCommands(path.join(workspaceDir, ".claude", "skills"), "项目 Skill")),
    ...(await legacyCommands(path.join(claudeDir, "commands"))),
    ...(await legacyCommands(path.join(workspaceDir, ".claude", "commands"))),
  ];
  const commandsByValue = new Map(bundledCommands.map((item) => [item.value, item]));
  for (const command of discoveredCommands) commandsByValue.set(command.value, command);
  return {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Web"],
    skills,
    mcp: mcpNames,
    subagents: agents,
    commands: [...commandsByValue.values()].sort((a, b) => a.value.localeCompare(b.value)),
    note: "能力由服务器统一配置；同一会话严格串行，不同私有会话可并行，执行仍受专用系统用户权限约束。",
  };
}
