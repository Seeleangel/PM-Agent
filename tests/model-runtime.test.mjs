import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runClaude, validateModelCredential } from "../lib/agent.mjs";
import { testModelProfile } from "../lib/admin.mjs";

const profile = { credentialMode: "profile", authToken: "fixture-secret", model: "deepseek-flash[1m]", smallModel: "deepseek-flash" };
async function fixture(body, run) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-model-test-"));
  const bin = path.join(cwd, "mock-claude");
  await writeFile(bin, `#!${process.execPath}\n${body}\n`);
  await chmod(bin, 0o755);
  try { await run({ cwd, bin }); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("connection verification closes stdin before waiting for a model response", async () => {
  await fixture('process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({type:"result",result:"MODEL_OK"}))); setTimeout(() => process.exit(2), 2000).unref();', async ({ cwd, bin }) => {
    assert.deepEqual(await testModelProfile({ cwd, bin, profile }), { ok: true, message: "连接成功" });
  });
});

test("API failure takes precedence over unrelated model-name warnings and hides credentials", async () => {
  await fixture('console.error("[claude-code:unrecognized_model] deepseek-flash[1m]"); console.log(JSON.stringify({type:"result",is_error:true,errors:["401 invalid API key fixture-secret"]})); process.exitCode=1;', async ({ cwd, bin }) => {
    await assert.rejects(testModelProfile({ cwd, bin, profile }), (error) => error.message.includes("401 invalid API key [密钥已隐藏]") && !error.message.includes("unrecognized_model"));
  });
});

test("a URL in the credential field is rejected before launching Claude", async () => {
  assert.throws(() => validateModelCredential({ ...profile, authToken: "https://platform.deepseek.com" }), /不能填写网址/);
  await assert.rejects(testModelProfile({ bin: "/does-not-exist", cwd: os.tmpdir(), profile: { ...profile, authToken: "https://platform.deepseek.com" } }), /不能填写网址/);
});

test("a failed initial session can be retried with resume rather than reused as a new session", async () => {
  await fixture('console.log(JSON.stringify(process.argv.includes("--resume") ? {type:"result",result:"RESUMED"} : {type:"result",is_error:true,errors:["Session ID is already in use"]}));', async ({ cwd, bin }) => {
    const sessionId = randomUUID();
    const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionDir = path.join(os.homedir(), ".claude", "projects", project);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, `${sessionId}.jsonl`), "{}\n");
    try {
      const result = await runClaude({ bin, cwd, prompt: "test", conversation: { sessionReady: false, claudeSessionId: sessionId }, modelProfile: profile, systemPrompt: "test", timeoutMs: 5000, onUpdate() {} });
      assert.equal(result.ok, true);
      assert.equal(result.content, "RESUMED");
    } finally { await rm(sessionDir, { recursive: true, force: true }); }
  });
});

test("structured API errors are failures even when Claude exits with zero", async () => {
  await fixture('console.log(JSON.stringify({type:"result",is_error:true,errors:["401 invalid API key"],result:"API Error"}));', async ({ cwd, bin }) => {
    const result = await runClaude({ bin, cwd, prompt: "test", conversation: { sessionReady: false, claudeSessionId: randomUUID() }, modelProfile: profile, systemPrompt: "test", timeoutMs: 5000, onUpdate() {} });
    assert.equal(result.ok, false);
    assert.equal(result.errorReason, "401 invalid API key");
  });
});
