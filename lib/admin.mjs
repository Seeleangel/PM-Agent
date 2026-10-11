import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { claudeFailureDetail, environmentForModelProfile, validateModelCredential } from "./agent.mjs";

const execFileAsync = promisify(execFile);
const skillNamePattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const pluginIdPattern = /^[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?$/;
let pluginOperation = Promise.resolve();

const memoryCategories = {
  user: "稳定的团队偏好、角色和协作习惯",
  feedback: "被确认的工作方式与纠正规则",
  project: "持续项目的目标、决策、阻塞和下一步",
  reference: "外部系统入口、运维路径与可复用事实",
};

const defaultClaudeMd = `# 共用 Agent 项目指令

<!-- memory-schema: 2 -->

## 工作环境

- 这是团队共享的 Claude Code 工作区，所有网页会话共用文件系统，但消息历史彼此隔离。
- 优先给出可核验的结果；修改前先读取相关文件，修改后执行与风险相称的检查。
- 不输出或保存密码、API 密钥、Cookie、OAuth token 和其他凭证。

## 长期记忆

- 自动记忆目录由服务器配置为 \`/srv/claude-agent/memory\`。
- \`MEMORY.md\` 是短索引，只保留当前有效的摘要和主题文件链接；必须控制在 200 行、25KB 内。
- 详细记忆按类型放进 \`user/\`、\`feedback/\`、\`project/\`、\`reference/\`，需要时再读取，不把长正文塞进索引。
- 主题文件超过 3KB 时拆成 \`*_L1.md\` 快速参考卡和 \`*_L2.md\` 完整手册；索引默认只指向 L1。
- 只记录跨会话仍有价值且无法从代码、数据库或现有文档立即查到的信息；临时进度、命令输出和可重新发现的代码结构不进入记忆。
- 每个主题文件的 frontmatter 包含 \`name\`、\`description\`、\`metadata.type\`、\`last_verified\`、\`stale_after\`、\`status\`。偏好/反馈默认 90d，项目/外部引用默认 30d，稳定命令经验默认 60d。
- 读取超过 \`stale_after\` 的内容时先提示并核验；\`status: stale\` 的内容不得作为事实引用。发现冲突时更新，暂不能核实时标记过期并说明原因。
- 用户明确说“记住”时立即写入合适的主题文件并更新索引；明确说“忘记”时删除对应内容并修复索引和交叉引用。
- 私有会话中的个人信息、内容和决策默认不得写入这套共享记忆。只有用户明确说“保存到团队记忆”时才可写入，并先移除凭证和敏感信息。
- 团队会话也只保存明确、稳定、可复用的结论；写入主题文件后同步更新 \`MEMORY.md\` 指针。
- 每次任务结束前快速审查本次是否产生了值得跨会话保留的新规则、决策、踩坑或资源入口；没有则不为凑数写入。

## 配置边界

- \`CLAUDE.md\` 用于行为和项目约定；可执行的固定检查应使用 Hook，可复用流程应使用 Skill，外部能力使用 MCP。
- 本文件会影响服务器上的所有新任务。保持具体、简短，避免与更高优先级安全策略冲突。
`;

const defaultMemoryIndex = `# 团队共享记忆索引

> 自动加载预算：最多前 200 行或 25KB。这里只放摘要与链接，详细内容按需读取。
> 私有会话内容默认禁止写入；凭证、token、密码和 Cookie 永不写入。

## User

- 暂无。稳定的团队偏好与角色信息放在 [user/](user/)。

## Feedback

- 暂无。被确认的做事规则与纠正放在 [feedback/](feedback/)。

## Project

- 暂无。持续项目的目标、决策和阻塞放在 [project/](project/)。

## Reference

- 暂无。外部资源入口与可复用运维事实放在 [reference/](reference/)。
`;

function categoryGuide(category, description) {
  return `---
name: ${category}-memory-guide
description: ${JSON.stringify(description)}
metadata:
  type: ${category}
last_verified: 2026-09-15
stale_after: 90d
status: active
---

# ${category}

${description}。新增内容应写成独立 Markdown 文件，并在根目录 \`MEMORY.md\` 添加一行指针。
`;
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

async function writeIfMissing(file, content) {
  try { await writeFile(file, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

export async function ensureMemorySystem({ homeDir, workspaceDir, memoryDir }) {
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  for (const category of Object.keys(memoryCategories)) await mkdir(path.join(memoryDir, category), { recursive: true, mode: 0o700 });
  await writeIfMissing(path.join(workspaceDir, "CLAUDE.md"), defaultClaudeMd);
  await writeIfMissing(path.join(memoryDir, "MEMORY.md"), defaultMemoryIndex);
  for (const [category, description] of Object.entries(memoryCategories)) {
    const guidePath = path.join(memoryDir, category, "README.md");
    await writeIfMissing(guidePath, categoryGuide(category, description));
    const guide = await readFile(guidePath, "utf8");
    if (guide.includes(`name: ${category}-memory-guide`) && !guide.includes("metadata:\n")) await atomicWrite(guidePath, categoryGuide(category, description));
  }

  const claudeMdPath = path.join(workspaceDir, "CLAUDE.md");
  const existingClaudeMd = await readFile(claudeMdPath, "utf8");
  if (existingClaudeMd.startsWith("# 共用 Agent 项目指令") && !existingClaudeMd.includes("<!-- memory-schema: 2 -->")) {
    await atomicWrite(`${claudeMdPath}.backup`, existingClaudeMd);
    await atomicWrite(claudeMdPath, defaultClaudeMd);
  }

  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  let changed = false;
  if (settings.autoMemoryEnabled === undefined) { settings.autoMemoryEnabled = true; changed = true; }
  if (!settings.autoMemoryDirectory) { settings.autoMemoryDirectory = memoryDir; changed = true; }
  if (changed) await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

async function memoryFileRows(memoryDir) {
  const rows = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const details = await stat(full);
        const relative = path.relative(memoryDir, full).replaceAll(path.sep, "/");
        rows.push({ path: relative, category: relative.includes("/") ? relative.split("/")[0] : "index", bytes: details.size, updatedAt: details.mtime.toISOString() });
      }
      if (rows.length >= 200) return;
    }
  }
  await walk(memoryDir);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function memoryConfiguration({ homeDir, workspaceDir, memoryDir }) {
  const claudeMdPath = path.join(workspaceDir, "CLAUDE.md");
  const [content, details, files, settingsText] = await Promise.all([
    readFile(claudeMdPath, "utf8").catch(() => ""),
    stat(claudeMdPath).catch(() => null),
    memoryFileRows(memoryDir),
    readFile(path.join(homeDir, ".claude", "settings.json"), "utf8").catch(() => "{}"),
  ]);
  let settings = {};
  try { settings = JSON.parse(settingsText); } catch { /* Report disabled below. */ }
  return {
    claudeMd: { path: claudeMdPath, content, bytes: Buffer.byteLength(content), updatedAt: details?.mtime.toISOString() || null, maxBytes: 50_000 },
    autoMemory: {
      enabled: settings.autoMemoryEnabled !== false,
      directory: settings.autoMemoryDirectory || memoryDir,
      indexBudget: "前 200 行或 25KB",
      shared: true,
      files,
      categories: Object.entries(memoryCategories).map(([name, description]) => ({ name, description, count: files.filter((file) => file.category === name && file.path !== `${name}/README.md`).length })),
    },
  };
}

export async function updateClaudeMd({ homeDir, workspaceDir, memoryDir, content }) {
  const normalized = String(content ?? "").replaceAll("\r\n", "\n");
  if (!normalized.trim()) throw Object.assign(new Error("CLAUDE.md 不能为空。"), { status: 400 });
  if (Buffer.byteLength(normalized) > 50_000) throw Object.assign(new Error("CLAUDE.md 不能超过 50KB；请把详细内容拆到记忆主题文件或 Skill。"), { status: 413 });
  if (normalized.includes("\0")) throw Object.assign(new Error("CLAUDE.md 包含无效字符。"), { status: 400 });
  const target = path.join(workspaceDir, "CLAUDE.md");
  const previous = await readFile(target, "utf8").catch(() => "");
  if (previous && previous !== normalized) await atomicWrite(`${target}.backup`, previous);
  await atomicWrite(target, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
  return memoryConfiguration({ homeDir, workspaceDir, memoryDir });
}

function yamlText(value) {
  return JSON.stringify(String(value).replaceAll("\r", "").trim());
}

function frontmatter(content) {
  const block = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const pick = (key) => block?.[1].match(new RegExp(`^${key}:\\s*["']?([^\\r\\n"']+)["']?\\s*$`, "m"))?.[1]?.trim() || "";
  return { name: pick("name"), description: pick("description") };
}

async function skillRows(dir, scope, removable) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      try {
        const content = await readFile(path.join(dir, entry.name, "SKILL.md"), "utf8");
        const meta = frontmatter(content);
        rows.push({ name: meta.name || entry.name, slug: entry.name, description: meta.description || "自定义工作流程", scope, removable });
      } catch {
        // Ignore folders that are not valid skills.
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export async function listManagedSkills({ homeDir, workspaceDir }) {
  const rows = [
    ...(await skillRows(path.join(homeDir, ".claude", "skills"), "服务器", true)),
    ...(await skillRows(path.join(workspaceDir, ".claude", "skills"), "项目", false)),
  ];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createManagedSkill({ homeDir, name, description, instructions }) {
  const slug = String(name || "").trim().toLowerCase();
  if (!skillNamePattern.test(slug)) throw Object.assign(new Error("Skill 名称需为 2–64 位小写字母、数字或横线。"), { status: 400 });
  const summary = String(description || "").trim();
  const body = String(instructions || "").trim();
  if (!summary || summary.length > 240) throw Object.assign(new Error("请填写 1–240 字的 Skill 用途说明。"), { status: 400 });
  if (!body || body.length > 30_000) throw Object.assign(new Error("请填写 Skill 指令，且不要超过 30000 字。"), { status: 400 });
  const skillRoot = path.join(homeDir, ".claude", "skills");
  await mkdir(skillRoot, { recursive: true, mode: 0o700 });
  const target = path.join(skillRoot, slug);
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("同名 Skill 已存在。"), { status: 409 });
    throw error;
  }
  const content = `---\nname: ${slug}\ndescription: ${yamlText(summary)}\n---\n\n${body}\n`;
  await writeFile(path.join(target, "SKILL.md"), content, { mode: 0o600 });
  return { name: slug, slug, description: summary, scope: "服务器", removable: true };
}

async function inspectTree(dir) {
  let totalBytes = 0;
  let files = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw Object.assign(new Error("Skill 包含符号链接，已拒绝安装。"), { status: 400 });
      if (stat.isDirectory()) await walk(full);
      else {
        files += 1;
        totalBytes += stat.size;
        if (files > 200 || totalBytes > 10 * 1024 * 1024) throw Object.assign(new Error("Skill 超过 200 个文件或 10MB 限制。"), { status: 413 });
      }
    }
  }
  await walk(dir);
}

function githubSource(value) {
  const raw = String(value || "").trim();
  const url = raw.match(/^[\w.-]+\/[\w.-]+$/) ? `https://github.com/${raw}.git` : raw;
  let parsed;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error("请输入 GitHub 仓库地址或 owner/repo。"), { status: 400 }); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(parsed.pathname)) {
    throw Object.assign(new Error("目前只允许从公开 GitHub 仓库安装 Skill。"), { status: 400 });
  }
  return parsed.toString();
}

export async function installSkillFromGitHub({ homeDir, source, subdirectory = "", name = "" }) {
  const repoUrl = githubSource(source);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-skill-"));
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--", repoUrl, tempRoot], { timeout: 90_000, maxBuffer: 2_000_000 });
    const relative = String(subdirectory || "").trim().replaceAll("\\", "/");
    if (relative.startsWith("/") || relative.split("/").includes("..")) throw Object.assign(new Error("Skill 子目录不能跳出仓库。"), { status: 400 });
    const sourceDir = path.resolve(tempRoot, relative || ".");
    if (!sourceDir.startsWith(tempRoot)) throw Object.assign(new Error("Skill 子目录无效。"), { status: 400 });
    const content = await readFile(path.join(sourceDir, "SKILL.md"), "utf8").catch(() => null);
    if (!content) throw Object.assign(new Error("指定目录中没有 SKILL.md。"), { status: 400 });
    const meta = frontmatter(content);
    const slug = String(name || meta.name || path.basename(sourceDir)).trim().toLowerCase();
    if (!skillNamePattern.test(slug)) throw Object.assign(new Error("Skill 名称需为 2–64 位小写字母、数字或横线。"), { status: 400 });
    await inspectTree(sourceDir);
    const skillRoot = path.join(homeDir, ".claude", "skills");
    await mkdir(skillRoot, { recursive: true, mode: 0o700 });
    const target = path.join(skillRoot, slug);
    try {
      await cp(sourceDir, target, { recursive: true, errorOnExist: true, force: false, filter: (item) => path.basename(item) !== ".git" });
    } catch (error) {
      if (error.code === "ERR_FS_CP_EEXIST" || error.code === "EEXIST") throw Object.assign(new Error("同名 Skill 已存在。"), { status: 409 });
      throw error;
    }
    return { name: meta.name || slug, slug, description: meta.description || "从 GitHub 安装", scope: "服务器", removable: true };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function removeManagedSkill({ homeDir, slug }) {
  const safe = String(slug || "").trim().toLowerCase();
  if (!skillNamePattern.test(safe)) throw Object.assign(new Error("Skill 名称无效。"), { status: 400 });
  const target = path.join(homeDir, ".claude", "skills", safe);
  const content = await readFile(path.join(target, "SKILL.md"), "utf8").catch(() => null);
  if (!content) throw Object.assign(new Error("找不到这个服务器 Skill。"), { status: 404 });
  await rm(target, { recursive: true, force: false });
}

async function claudePlugin(bin, homeDir, args, timeout = 120_000) {
  try {
    const { stdout } = await execFileAsync(bin, ["plugin", ...args], {
      env: { ...process.env, HOME: homeDir }, timeout, maxBuffer: 4_000_000,
    });
    return stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "插件命令失败").trim().split("\n").slice(-2).join(" ");
    throw Object.assign(new Error(`Claude Plugin 操作失败：${detail.slice(0, 500)}`), { status: 400 });
  }
}

function parseJson(output, fallback) {
  try { return JSON.parse(output || JSON.stringify(fallback)); } catch { return fallback; }
}

export async function pluginInventory({ bin, homeDir }) {
  const [installed, available, marketplaces] = await Promise.all([
    claudePlugin(bin, homeDir, ["list", "--json"]),
    claudePlugin(bin, homeDir, ["list", "--json", "--available"]),
    claudePlugin(bin, homeDir, ["marketplace", "list", "--json"]),
  ]);
  const installedData = parseJson(installed, []);
  const availableData = parseJson(available, []);
  const marketplaceData = parseJson(marketplaces, []);
  return {
    installed: Array.isArray(installedData) ? installedData : installedData.installed || installedData.plugins || [],
    available: Array.isArray(availableData) ? availableData : availableData.available || availableData.plugins || [],
    marketplaces: Array.isArray(marketplaceData) ? marketplaceData : marketplaceData.marketplaces || [],
  };
}

function serializedPluginOperation(operation) {
  const next = pluginOperation.then(operation, operation);
  pluginOperation = next.catch(() => {});
  return next;
}

export function mutatePlugin({ bin, homeDir, action, plugin }) {
  const id = String(plugin || "").trim();
  if (!pluginIdPattern.test(id)) throw Object.assign(new Error("Plugin 标识无效。"), { status: 400 });
  const actionArgs = {
    install: ["install", id, "--scope", "user", "--yes", "--json"],
    uninstall: ["uninstall", id, "--scope", "user", "--yes", "--json"],
    enable: ["enable", id, "--scope", "user", "--json"],
    disable: ["disable", id, "--scope", "user", "--json"],
    update: ["update", id, "--scope", "user", "--yes", "--json"],
  }[action];
  if (!actionArgs) throw Object.assign(new Error("不支持这个 Plugin 操作。"), { status: 400 });
  return serializedPluginOperation(async () => {
    await claudePlugin(bin, homeDir, actionArgs);
    return pluginInventory({ bin, homeDir });
  });
}

export function addPluginMarketplace({ bin, homeDir, source }) {
  const raw = String(source || "").trim();
  if (!raw.match(/^[\w.-]+\/[\w.-]+$/) && !raw.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/)) {
    throw Object.assign(new Error("Marketplace 目前只接受 GitHub 的 owner/repo 或 HTTPS 地址。"), { status: 400 });
  }
  return serializedPluginOperation(async () => {
    await claudePlugin(bin, homeDir, ["marketplace", "add", raw, "--scope", "user"]);
    return pluginInventory({ bin, homeDir });
  });
}

export async function testModelProfile({ bin, cwd, profile }) {
  validateModelCredential(profile);
  try {
    const execution = execFileAsync(bin, [
      "-p", "只回复 MODEL_OK", "--output-format", "json", "--permission-mode", "dontAsk",
      "--permission-prompts", "none", "--no-session-persistence",
      ...(process.env.DISABLE_EXTERNAL_INTEGRATIONS === "true" ? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] : []),
    ], { cwd, env: environmentForModelProfile(profile), timeout: 90_000, maxBuffer: 2_000_000 });
    execution.child.stdin.end();
    const { stdout } = await execution;
    const result = parseJson(stdout, {});
    if (result.is_error || result.errors?.length) throw Object.assign(new Error("模型调用失败。"), { stdout });
    const text = String(result.result || result.content || stdout).trim();
    if (!text) throw new Error("模型没有返回文本。");
    return { ok: true, message: text.includes("MODEL_OK") ? "连接成功" : "模型已响应" };
  } catch (error) {
    const detail = claudeFailureDetail(error, profile);
    throw Object.assign(new Error(`模型验证失败：${detail}`), { status: 400 });
  }
}
