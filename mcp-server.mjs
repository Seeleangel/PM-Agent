import readline from "node:readline";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const workspace = process.env.WORKSPACE_DIR || "/srv/claude-agent/workspace";

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function workspaceSummary() {
  const entries = await readdir(workspace, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.name.startsWith(".")).slice(0, 100);
  let files = 0; let directories = 0; let bytes = 0;
  for (const entry of visible) {
    if (entry.isDirectory()) directories += 1;
    if (entry.isFile()) { files += 1; bytes += (await stat(path.join(workspace, entry.name))).size; }
  }
  return `工作区：${workspace}\n顶层可见文件：${files}\n顶层目录：${directories}\n顶层文件合计：${bytes} bytes`;
}

const tools = [
  { name: "server_time", description: "返回 Agent 服务器当前时间和时区，不读取任何凭证。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "workspace_summary", description: "只读统计共享工作区顶层文件与目录数量，不返回文件内容。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method } = request;
  try {
    if (method === "initialize") return reply(id, { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "team-workbench-safe", version: "1.0.0" } });
    if (method === "tools/list") return reply(id, { tools });
    if (method === "tools/call") {
      const name = request.params?.name;
      if (name === "server_time") return reply(id, { content: [{ type: "text", text: `${new Date().toString()}\nISO: ${new Date().toISOString()}` }] });
      if (name === "workspace_summary") return reply(id, { content: [{ type: "text", text: await workspaceSummary() }] });
      return fail(id, -32601, "Unknown tool");
    }
    if (id !== undefined && !String(method).startsWith("notifications/")) return fail(id, -32601, "Method not found");
  } catch (error) { if (id !== undefined) fail(id, -32000, error.message); }
});
