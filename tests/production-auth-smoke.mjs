import assert from "node:assert/strict";

const baseUrl = process.env.AGENT_WEB_URL;
const username = process.env.AGENT_WEB_USER;
const password = process.env.AGENT_WEB_PASSWORD;
if (!baseUrl || !username || !password) throw new Error("Set AGENT_WEB_URL, AGENT_WEB_USER, and AGENT_WEB_PASSWORD.");

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200);
const setCookie = login.headers.get("set-cookie") || "";
assert.match(setCookie, /; Secure(?:;|$)/i);
assert.match(setCookie, /; HttpOnly(?:;|$)/i);
assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
const sessionCookie = setCookie.split(";", 1)[0];
const body = await login.json();
assert.ok(body.csrfToken);

const logout = await fetch(`${baseUrl}/api/auth/logout`, {
  method: "POST",
  headers: { Cookie: sessionCookie, "X-CSRF-Token": body.csrfToken },
});
assert.equal(logout.status, 200);

for (const route of ["/healthz", "/", "/app.js?v=20260920-4"]) {
  const response = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
  assert.equal(response.status, 200, `${route} should support HEAD`);
  if (route.includes("app.js")) assert.equal(response.headers.get("cache-control"), "no-cache");
}

console.log(JSON.stringify({ secureCookie: true, loginLogout: true, headRoutes: true, staticRevalidation: true }));
