import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function createTaskCgroup() {
  if (process.platform !== "linux") return null;
  try {
    const selfCgroup = await readFile("/proc/self/cgroup", "utf8");
    const relative = selfCgroup.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    if (!relative) return null;
    const taskPath = path.join("/sys/fs/cgroup", relative, `task-${randomUUID()}`);
    await mkdir(taskPath);
    return taskPath;
  } catch (error) {
    console.error(JSON.stringify({ event: "task_cgroup_unavailable", message: String(error?.message || error).slice(0, 300) }));
    return null;
  }
}

async function destroyTaskCgroup(taskPath) {
  if (!taskPath) return;
  try { await writeFile(path.join(taskPath, "cgroup.kill"), "1"); } catch { /* The cgroup may already be empty. */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rmdir(taskPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  console.error(JSON.stringify({ event: "task_cgroup_cleanup_failed", cgroup: path.basename(taskPath) }));
}

export function environmentForModelProfile(profile, extraEnv = {}) {
  const env = { ...process.env };
  if (profile) {
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
    if (profile.credentialMode === "profile" && profile.authToken) {
      env.ANTHROPIC_AUTH_TOKEN = profile.authToken;
      delete env.ANTHROPIC_API_KEY;
    }
    if (profile.model) {
      env.ANTHROPIC_MODEL = profile.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = profile.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = profile.model;
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = profile.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = profile.model;
    }
    if (profile.smallModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.smallModel;
  }
  Object.assign(env, extraEnv);
  return env;
}

export function validateModelCredential(profile) {
  if (!profile || profile.credentialMode !== "profile") return;
  const token = String(profile.authToken || "").trim();
  if (!token || /^https?:\/\//i.test(token) || /\s/.test(token)) {
    throw Object.assign(new Error("API 密钥无效：请填写模型平台创建的真实 API 密钥，不能填写网址；编辑配置时需重新输入密钥并保存。"), { status: 400 });
  }
}

export function claudeFailureDetail({ stdout = "", stderr = "", result, message = "" }, profile) {
  let structured = result;
  if (!structured) {
    for (const line of String(stdout).trim().split("\n").reverse()) {
      try { const event = JSON.parse(line); if (event.type === "result" || event.is_error) { structured = event; break; } } catch { /* Skip non-JSON diagnostics. */ }
    }
  }
  const errors = structured?.errors;
  let detail = (Array.isArray(errors) ? errors.map((error) => typeof error === "string" ? error : error.message || "").filter(Boolean).join("; ") : "")
    || structured?.error?.message
    || (structured?.is_error ? structured.result : "")
    || String(stderr).match(/(?:Error:|API Error:|MCP error:)[^\n]+/i)?.[0]
    || message
    || "Claude Code 未返回有效结果。";
  detail = String(detail);
  if (profile?.authToken) detail = detail.replaceAll(profile.authToken, "[密钥已隐藏]");
  return detail.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function hasPersistedSession(cwd, sessionId) {
  // A first run can persist its session before the upstream API rejects it.
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  try { await access(path.join(process.env.HOME || os.homedir(), ".claude", "projects", project, `${sessionId}.jsonl`)); return true; }
  catch { return false; }
}

function textFromEvent(event) {
  if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
    return event.event.delta?.text || "";
  }
  if (event.type === "assistant") {
    return (event.message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}

function activityFromEvent(event) {
  const parts = [];
  if (event.type === "stream_event" && event.event?.type === "content_block_start") parts.push(event.event.content_block);
  if (event.type === "assistant") parts.push(...(event.message?.content || []));
  return parts.filter(Boolean).flatMap((part) => {
    if (!["tool_use", "server_tool_use"].includes(part.type)) return [];
    const raw = String(part.name || "tool");
    let kind = "工具";
    if (raw === "Skill" || raw.toLowerCase().includes("skill")) kind = "Skill";
    if (["agent", "task"].includes(raw.toLowerCase()) || raw.toLowerCase().includes("subagent")) kind = "Subagent";
    if (raw.startsWith("mcp__")) kind = "MCP";
    const description = String(
      part.input?.description
      || part.input?.task
      || part.input?.name
      || part.input?.prompt
      || "",
    ).replace(/\s+/g, " ").trim().slice(0, 180);
    return [{
      id: part.id || `${raw}-${Date.now()}`,
      kind,
      name: raw.replace(/^mcp__/, "").replaceAll("__", " / "),
      description,
      status: "running",
    }];
  });
}

function completedActivityIds(event) {
  const parts = [];
  if (event.type === "user") parts.push(...(event.message?.content || []));
  if (event.type === "stream_event" && event.event?.type === "content_block_start") parts.push(event.event.content_block);
  return parts
    .filter((part) => part?.type === "tool_result" && part.tool_use_id)
    .map((part) => part.tool_use_id);
}

function normalizeChoice(value) {
  if (!value || typeof value !== "object") return null;
  const question = String(value.question || "").trim().slice(0, 400);
  const options = (Array.isArray(value.options) ? value.options : []).slice(0, 8).map((option) => ({
    label: String(typeof option === "string" ? option : option?.label || "").trim().slice(0, 80),
    description: String(typeof option === "string" ? "" : option?.description || "").trim().slice(0, 240),
  })).filter((option) => option.label);
  if (!question || options.length < 2) return null;
  return { question, options, multiple: Boolean(value.multiple ?? value.multiSelect) };
}

function choiceFromEvent(event) {
  const parts = [];
  if (event.type === "stream_event" && event.event?.type === "content_block_start") parts.push(event.event.content_block);
  if (event.type === "assistant") parts.push(...(event.message?.content || []));
  for (const part of parts) {
    if (part?.type !== "tool_use" || !["AskUserQuestion", "ask_user_question"].includes(part.name)) continue;
    const question = part.input?.questions?.[0] || part.input;
    const normalized = normalizeChoice(question);
    if (normalized) return normalized;
  }
  return null;
}

export function extractChoice(content) {
  const match = String(content || "").match(/<web_choice>\s*([\s\S]*?)\s*<\/web_choice>/i);
  if (!match) return { content: String(content || "").trim(), choice: null };
  let choice = null;
  try { choice = normalizeChoice(JSON.parse(match[1])); } catch { /* Invalid markers remain ordinary text. */ }
  if (!choice) return { content: String(content || "").trim(), choice: null };
  return { content: String(content || "").replace(match[0], "").trim(), choice };
}

function hideStreamingChoice(content) {
  const text = String(content || "");
  const markerIndex = text.toLowerCase().indexOf("<web_choice>");
  if (markerIndex >= 0) return text.slice(0, markerIndex).trimEnd();
  const lastOpen = text.lastIndexOf("<");
  if (lastOpen >= 0 && "<web_choice>".startsWith(text.slice(lastOpen).toLowerCase())) return text.slice(0, lastOpen).trimEnd();
  return text;
}

function signalProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* Process already exited. */ }
  }
}

export function metricsFromResult(event) {
  const modelUsages = Object.values(event?.modelUsage || {});
  const sources = modelUsages.length ? modelUsages : event?.usage ? [event.usage] : [];
  const metrics = sources.reduce((total, usage) => ({
    inputTokens: total.inputTokens + Number(usage.inputTokens ?? usage.input_tokens ?? 0),
    outputTokens: total.outputTokens + Number(usage.outputTokens ?? usage.output_tokens ?? 0),
    cacheReadInputTokens: total.cacheReadInputTokens + Number(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: total.cacheCreationInputTokens + Number(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  metrics.totalTokens = metrics.inputTokens + metrics.outputTokens + metrics.cacheReadInputTokens + metrics.cacheCreationInputTokens;
  metrics.apiDurationMs = Number(event?.duration_api_ms || 0);
  metrics.costUsd = Number(event?.total_cost_usd || 0);
  return metrics;
}

export async function runClaude({ bin, cwd, prompt, conversation, modelProfile, extraEnv, systemPrompt, timeoutMs, signal, onUpdate }) {
  const resume = conversation.sessionReady || await hasPersistedSession(cwd, conversation.claudeSessionId);
  const taskCgroup = await createTaskCgroup();
  let cleanupCgroupPromise = null;
  const cleanupTaskCgroup = () => {
    cleanupCgroupPromise ||= destroyTaskCgroup(taskCgroup);
    return cleanupCgroupPromise;
  };
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", process.env.CLAUDE_PERMISSION_MODE || "auto",
      "--permission-prompts", "none",
      "--append-system-prompt", systemPrompt,
      resume ? "--resume" : "--session-id", conversation.claudeSessionId,
    ];
    if (process.env.CLAUDE_ALLOWED_TOOLS) args.push("--allowedTools", process.env.CLAUDE_ALLOWED_TOOLS);
    if (process.env.DISABLE_EXTERNAL_INTEGRATIONS === "true") args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    const spawnBin = taskCgroup ? "/bin/sh" : bin;
    const spawnArgs = taskCgroup
      ? ["-c", "printf '%s' \"$$\" > \"$1/cgroup.procs\"; shift; exec \"$@\"", "claude-task", taskCgroup, bin, ...args]
      : args;
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: environmentForModelProfile(modelProfile, extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let resultText = "";
    let partialText = "";
    let stderr = "";
    let lineBuffer = "";
    let localCommand = null;
    let returnedSessionId = conversation.claudeSessionId;
    const activities = [];
    const activityIndexes = new Map();
    let detectedChoice = null;
    let metrics = {};
    let resultEvent = null;
    let settled = false;
    let stopReason = null;
    let forceStopTimer = null;

    const publish = () => onUpdate({ content: hideStreamingChoice(partialText || resultText) || "正在接手这项任务…", activities });
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const delta = textFromEvent(event);
        if (event.type === "stream_event" && delta) partialText += delta;
        if (event.type === "assistant" && delta) resultText = delta;
        if (event.type === "result" && typeof event.result === "string") resultText = event.result;
        if (event.type === "result" && event.local_command) localCommand = event.local_command;
        if (event.type === "result" && event.session_id) returnedSessionId = event.session_id;
        if (event.type === "result") { metrics = metricsFromResult(event); resultEvent = event; }
        detectedChoice ||= choiceFromEvent(event);
        for (const item of activityFromEvent(event)) {
          if (!activityIndexes.has(item.id)) {
            activityIndexes.set(item.id, activities.length);
            activities.push(item);
          } else {
            activities[activityIndexes.get(item.id)] = { ...activities[activityIndexes.get(item.id)], ...item };
          }
        }
        for (const id of completedActivityIds(event)) {
          const index = activityIndexes.get(id);
          if (index !== undefined) activities[index] = { ...activities[index], status: "completed" };
        }
        if (delta || activities.length) publish();
      } catch {
        // Only structured JSONL is user-visible; diagnostics stay in service logs.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) consume(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });

    const requestStop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      signalProcessTree(child, reason === "cancelled" ? "SIGINT" : "SIGTERM");
      forceStopTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        void cleanupTaskCgroup();
      }, 3_000);
      forceStopTimer.unref?.();
    };
    const timer = setTimeout(() => requestStop("timeout"), timeoutMs);
    const abort = () => requestStop("cancelled");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceStopTimer);
      signal?.removeEventListener("abort", abort);
      if (lineBuffer) consume(lineBuffer);
      await cleanupTaskCgroup();
      const extracted = extractChoice((resultText || partialText).trim());
      const choice = detectedChoice || extracted.choice;
      const content = extracted.content || choice?.question || "";
      metrics = { ...metrics, durationMs: Date.now() - startedAt };
      if (stopReason === "cancelled") {
        resolve({
          ok: false,
          errorKind: "cancelled",
          errorReason: "运行被用户中断。",
          cancelled: true,
          content: "已中断本次运行。中断前生成的内容未作为完整答案保留。",
          activities,
          choice: null,
          metrics: { ...metrics, cancelled: true },
          localCommand,
          sessionId: returnedSessionId,
        });
        return;
      }
      if (stopReason === "timeout") {
        resolve({
          ok: false,
          errorKind: "timeout",
          errorReason: `运行超过 ${Math.round(timeoutMs / 60_000)} 分钟后被服务器停止。`,
          content: `任务运行超过 ${Math.round(timeoutMs / 60_000)} 分钟，已由服务器停止。已产生的中间内容和文件可能仍保留；你可以继续当前会话，让 Agent 从现有进度接着执行。`,
          activities,
          choice: null,
          metrics: { ...metrics, timedOut: true },
          localCommand,
          sessionId: returnedSessionId,
        });
        return;
      }
      if (result.code === 0 && !resultEvent?.is_error && (content || localCommand || choice || activities.length)) {
        for (let index = 0; index < activities.length; index += 1) {
          if (activities[index].status === "running") activities[index] = { ...activities[index], status: "completed" };
        }
        const commandMessage = localCommand === "clear"
          ? "Claude 上下文已清空。此前网页记录仍保留用于团队审计，后续任务将从空上下文开始。"
          : localCommand === "compact"
            ? "Claude 上下文已压缩。后续任务会继续使用压缩后保留的关键上下文。"
            : localCommand ? `命令 /${localCommand} 已执行。` : "";
        resolve({
          ok: true,
          content: content || commandMessage || "任务已完成。Claude 已执行相关工具操作，但未返回文字说明。",
          activities,
          choice,
          metrics,
          localCommand,
          sessionId: returnedSessionId,
        });
      }
      else {
        const detail = claudeFailureDetail({ stderr, result: resultEvent, message: result.error?.message }, modelProfile);
        const errorKind = result.error
          ? "process_error"
          : result.signal
            ? "signal"
            : result.code === 0
              ? "empty_result"
              : "claude_exit";
        resolve({
          ok: false,
          errorKind,
          errorReason: detail,
          content: `任务执行失败：${detail}\n\n可以稍后重试；如果持续失败，请联系维护者查看服务日志。`,
          activities,
          choice,
          metrics,
          localCommand,
          sessionId: returnedSessionId,
        });
      }
    };
    child.once("error", (error) => { void finish({ code: -1, error }); });
    child.once("close", (code, signal) => { void finish({ code, signal }); });
  });
}
