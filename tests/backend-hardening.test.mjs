import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../lib/database.mjs";

function makeStore() {
  return new Store(join(tmpdir(), `claude-agent-web-test-${randomUUID()}.db`));
}

function addPendingChoice(store, conversationId, options = {}) {
  return store.addMessage({
    conversationId,
    role: "assistant",
    authorName: "Agent",
    content: "请选择",
    status: "completed",
    choice: { question: "选择下一步", multiple: options.multiple || false, options: options.options || [{ label: "方案 A" }, { label: "方案 B" }] },
  });
}

function makeChoiceConversation(store) {
  const user = store.createUser({ username: "choice-user", displayName: "Choice User", password: "password-123" });
  const conversation = store.createConversation({ ownerId: user.id, title: "Choice", visibility: "private" });
  return { user, conversation };
}

test("listMessages returns the newest 400 in chronological order", () => {
  const store = makeStore();
  try {
    const user = store.createUser({ username: "alice", displayName: "Alice", password: "password-123" });
    const conversation = store.createConversation({ ownerId: user.id, title: "Test", visibility: "private" });
    for (let index = 1; index <= 401; index += 1) {
      const id = store.addMessage({ conversationId: conversation.id, role: "user", authorName: "Alice", content: `m${index}`, status: "completed" });
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
      store.db.prepare("UPDATE messages SET created_at=?,updated_at=? WHERE id=?").run(stamp, stamp, id);
    }
    const messages = store.listMessages(conversation.id);
    assert.equal(messages.length, 400);
    assert.equal(messages[0].content, "m2");
    assert.equal(messages.at(-1).content, "m401");
  } finally {
    store.close();
  }
});

test("listMessagesPage exposes an older-page cursor", () => {
  const store = makeStore();
  try {
    const user = store.createUser({ username: "alice", displayName: "Alice", password: "password-123" });
    const conversation = store.createConversation({ ownerId: user.id, title: "Test", visibility: "private" });
    for (let index = 1; index <= 5; index += 1) {
      const id = store.addMessage({ conversationId: conversation.id, role: "user", authorName: "Alice", content: `m${index}`, status: "completed" });
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
      store.db.prepare("UPDATE messages SET created_at=?,updated_at=? WHERE id=?").run(stamp, stamp, id);
    }
    const newest = store.listMessagesPage(conversation.id, { limit: 2 });
    assert.deepEqual(newest.messages.map((message) => message.content), ["m4", "m5"]);
    assert.equal(newest.hasMore, true);
    const older = store.listMessagesPage(conversation.id, { limit: 2, before: newest.nextCursor });
    assert.deepEqual(older.messages.map((message) => message.content), ["m2", "m3"]);
  } finally {
    store.close();
  }
});

test("unknown-user authentication still rejects without changing existing accounts", () => {
  const store = makeStore();
  try {
    store.createUser({ username: "alice", displayName: "Alice", password: "password-123" });
    assert.equal(store.authenticate("missing", "password-123"), null);
    assert.equal(store.authenticate("alice", "password-123").username, "alice");
  } finally {
    store.close();
  }
});

test("password changes revoke other sessions but keep the current session", () => {
  const store = makeStore();
  try {
    const user = store.createUser({ username: "alice", displayName: "Alice", password: "password-123" });
    store.createLoginSession(user.id, "current-token", "csrf-1", "2099-01-01T00:00:00.000Z");
    store.createLoginSession(user.id, "other-token", "csrf-2", "2099-01-01T00:00:00.000Z");
    assert.equal(store.changePassword(user.id, "password-123", "new-password-456"), true);
    assert.equal(store.authenticate("alice", "password-123"), null);
    assert.equal(store.authenticate("alice", "new-password-456").id, user.id);
    assert.equal(store.deleteLoginSessionsForUser(user.id, "current-token"), 1);
    assert.ok(store.getLoginSession("current-token"));
    assert.equal(store.getLoginSession("other-token"), null);
  } finally {
    store.close();
  }
});

test("answerChoice accepts a custom-only response", () => {
  const store = makeStore();
  try {
    const { user, conversation } = makeChoiceConversation(store);
    const messageId = addPendingChoice(store, conversation.id);
    const choice = store.answerChoice(messageId, conversation.id, user.id, [], "My own answer");
    assert.deepEqual(choice.values, []);
    assert.equal(choice.customAnswer, "My own answer");
    assert.ok(choice.answeredAt);
  } finally {
    store.close();
  }
});

test("answerChoice enforces single-choice exclusivity", () => {
  const store = makeStore();
  try {
    const { user, conversation } = makeChoiceConversation(store);
    const messageId = addPendingChoice(store, conversation.id);
    assert.equal(store.answerChoice(messageId, conversation.id, user.id, ["方案 A", "方案 B"]), null);
    assert.equal(store.answerChoice(messageId, conversation.id, user.id, ["方案 A"], "My own answer"), null);
    assert.deepEqual(store.answerChoice(messageId, conversation.id, user.id, ["方案 A"]).values, ["方案 A"]);
  } finally {
    store.close();
  }
});

test("answerChoice rejects custom answers over 4000 characters and accepts the limit", () => {
  const store = makeStore();
  try {
    const { user, conversation } = makeChoiceConversation(store);
    const messageId = addPendingChoice(store, conversation.id);
    assert.equal(store.answerChoice(messageId, conversation.id, user.id, [], "x".repeat(4001)), null);
    const choice = store.answerChoice(messageId, conversation.id, user.id, [], "x".repeat(4000));
    assert.equal(choice.customAnswer.length, 4000);
  } finally {
    store.close();
  }
});
