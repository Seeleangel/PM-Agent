import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { Store } from "../lib/database.mjs";
import { GuestSessions } from "../lib/guest.mjs";

test("guest sessions expire, revoke on logout, and stay bounded", () => {
  let now = 1000;
  const sessions = new GuestSessions({ ttlMs: 100, limit: 1, now: () => now });
  const first = sessions.create();
  assert.equal(sessions.get(first.token).user.role, "guest");
  assert.equal(sessions.create(), null);
  now += 100;
  assert.equal(sessions.get(first.token), null);
  const second = sessions.create();
  assert.ok(second);
  sessions.delete(second.token);
  assert.equal(sessions.get(second.token), null);
});

test("guest HTTP access is isolated and denies every execution/write path", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-agent-guest-"));
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir);
  const dbPath = path.join(dataDir, "agent-web.sqlite");
  const seed = new Store(dbPath);
  const admin = seed.createUser({ username: "testadmin", displayName: "PRIVATE-ADMIN", password: "test-password-123", role: "admin" });
  const privateConversation = seed.createConversation({ ownerId: admin.id, title: "PRIVATE-CONVERSATION", visibility: "private" });
  const teamConversation = seed.createConversation({ ownerId: admin.id, title: "REAL-TEAM-DATA", visibility: "team" });
  seed.addMessage({ conversationId: teamConversation.id, role: "user", authorName: "PRIVATE-ADMIN", content: "REAL-PRIVATE-MESSAGE", status: "completed" });
  seed.close();
  const marker = path.join(dir, "claude-invoked");
  const bin = path.join(dir, "claude-mock");
  await writeFile(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`, { mode: 0o700 });
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), BASE_PATH: "/agent", DATA_DIR: dataDir, WORKSPACE_DIR: path.join(dir, "workspace"), HOME: path.join(dir, "home"), MEMORY_DIR: path.join(dir, "memory"), LARK_ROOT_DIR: path.join(dir, "lark"), CLAUDE_BIN: bin, BOOTSTRAP_ADMIN_USER: "testadmin", REQUIRE_MODEL_CREDENTIAL: "true", SECURE_COOKIES: "true", DISABLE_EXTERNAL_INTEGRATIONS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/agent`;
  let cookie = "";
  let csrfToken = "";
  const request = async (route, { method = "GET", body, ...options } = {}) => {
    const response = await fetch(`${url}${route}`, { method, headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrfToken, "Content-Type": "application/json", ...(options.headers || {}) }, ...(body && !["GET", "HEAD"].includes(method) ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload, headers: response.headers, text };
  };
  const counts = () => {
    const db = new Store(dbPath);
    try { return ["users", "login_sessions", "conversations", "messages", "attachments", "model_profiles", "registration_requests"].map((table) => db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n); }
    finally { db.close(); }
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { ready = (await request("/healthz")).status === 200; } catch { /* not listening yet */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, logs);
    const before = counts();
    assert.equal((await request("/api/bootstrap")).payload.allowGuest, true);
    assert.equal((await request("/api/auth/guest", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
    const session = await request("/api/auth/guest", { method: "POST" });
    assert.equal(session.status, 200);
    assert.equal(session.payload.user.role, "guest");
    assert.equal(session.payload.user.readOnly, true);
    assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/agent; Max-Age=7200; Secure/);
    cookie = session.headers.get("set-cookie").split(";")[0];
    csrfToken = session.payload.csrfToken;
    const guestCookie = cookie;
    assert.equal((await request("/api/bootstrap")).payload.user.role, "guest");
    const list = await request("/api/conversations");
    assert.equal(list.payload.conversations.length, 2);
    const demoId = list.payload.conversations[0].id;
    for (const conversation of list.payload.conversations) {
      const state = await request(`/api/conversations/${conversation.id}`);
      assert.equal(state.status, 200);
      assert.equal(state.payload.readOnly, true);
      assert.equal(state.payload.messages.length, 2);
      assert.deepEqual(state.payload.runtime.onlineMembers, []);
      assert.doesNotMatch(state.text, /PRIVATE-ADMIN|REAL-PRIVATE|REAL-TEAM|PRIVATE-CONVERSATION/);
    }
    assert.equal((await request(`/api/conversations/${privateConversation.id}`)).status, 404);
    assert.equal((await request(`/api/conversations/${teamConversation.id}`)).status, 404);
    assert.equal((await request("/api/model-profiles")).payload.profiles[0].model, "未调用模型");
    assert.deepEqual((await request("/api/capabilities")).payload.commands, []);
    const events = await request(`/api/events?conversationId=${teamConversation.id}`);
    assert.equal(events.status, 200);
    assert.doesNotMatch(events.text, /PRIVATE-ADMIN|REAL-PRIVATE|REAL-TEAM/);
    assert.match(events.text, /"conversation":null/);
    const routes = [
      ["POST", "/api/conversations"], ["PATCH", `/api/conversations/${demoId}`], ["DELETE", `/api/conversations/${teamConversation.id}`],
      ["POST", `/api/conversations/${demoId}/messages`], ["POST", `/api/conversations/${teamConversation.id}/messages`],
      ["POST", `/api/conversations/${demoId}/attachments`], ["GET", `/api/conversations/${teamConversation.id}/attachments/${demoId}/download`],
      ["POST", `/api/conversations/${demoId}/interrupt`], ["POST", `/api/conversations/${demoId}/choices/${demoId}`],
      ["GET", "/api/admin/accounts"], ["POST", "/api/admin/model-profiles"], ["POST", `/api/admin/model-profiles/${demoId}/test`],
      ["GET", "/api/admin/model-profiles"], ["GET", "/api/admin/memory"], ["PUT", "/api/admin/memory/claude-md"],
      ["GET", "/api/admin/skills"], ["POST", "/api/admin/skills"], ["POST", "/api/admin/plugins/actions"],
      ["GET", "/api/lark/status"], ["POST", "/api/lark/auth/start"], ["POST", "/api/auth/password"], ["POST", "/api/auth/logout-all"],
      ["POST", "/api/future-endpoint"], ["GET", "/api/future-endpoint"],
    ];
    for (const [method, route] of routes) {
      const result = await request(route, { method, body: { content: "Start task", role: "admin" } });
      assert.equal(result.status, 403, `${method} ${route}`);
      assert.equal(result.payload.code, "guest_read_only");
    }
    assert.deepEqual(counts(), before, "Guest activity must never mutate live data");
    await assert.rejects(access(marker), { code: "ENOENT" });
    const adminSession = await request("/api/auth/login", { method: "POST", body: { username: "testadmin", password: "test-password-123" } });
    assert.equal(adminSession.status, 200);
    cookie = adminSession.headers.get("set-cookie").split(";")[0];
    csrfToken = adminSession.payload.csrfToken;
    assert.equal((await request("/api/admin/accounts")).status, 200);
    assert.equal((await request("/api/auth/guest", { method: "POST" })).status, 409);
    const created = await request("/api/conversations", { method: "POST", body: { title: "Normal authorized use" } });
    assert.equal(created.status, 201);
    const adminCookie = cookie;
    cookie = guestCookie;
    assert.equal((await request("/api/bootstrap")).payload.authenticated, false, "Login revokes the former guest token");
    cookie = adminCookie;
    await request("/api/auth/logout", { method: "POST" });
    cookie = "";
    const finalGuest = await request("/api/auth/guest", { method: "POST" });
    cookie = finalGuest.headers.get("set-cookie").split(";")[0];
    csrfToken = "incorrect";
    assert.equal((await request("/api/auth/logout", { method: "POST" })).status, 403);
    csrfToken = finalGuest.payload.csrfToken;
    assert.equal((await request("/api/auth/logout", { method: "POST" })).status, 200);
    assert.equal((await request("/api/bootstrap")).payload.authenticated, false);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    const exited = once(child, "exit");
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
