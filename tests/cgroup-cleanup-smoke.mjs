import { runClaude } from "../lib/agent.mjs";
import { execFileSync } from "node:child_process";

const result = await runClaude({
  bin: "/opt/claude-agent-web/tests/fixtures/fake-claude-setsid.sh",
  cwd: "/srv/claude-agent/workspace",
  prompt: "cgroup cleanup smoke test",
  conversation: { sessionReady: false, claudeSessionId: "00000000-0000-4000-8000-000000000001" },
  modelProfile: null,
  extraEnv: {},
  systemPrompt: "test",
  timeoutMs: 10_000,
  signal: null,
  onUpdate() {},
});

if (!result.ok || result.content !== "CGROUP_TEST_OK") {
  console.error(result);
  process.exit(1);
}
try {
  execFileSync("pgrep", ["-af", "^claude-agent-escape-proof( |$)"], { stdio: "pipe" });
  console.error("setsid escape process survived task cleanup");
  process.exit(1);
} catch (error) {
  if (error.status !== 1) throw error;
}
console.log(JSON.stringify({ ok: result.ok, content: result.content }));
