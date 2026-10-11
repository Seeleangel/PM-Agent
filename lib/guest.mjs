import { newToken } from "./security.mjs";

const user = Object.freeze({ id: "guest-preview", username: "guest", displayName: "游客", role: "guest", readOnly: true });
const stamp = "2026-10-11T02:00:00.000Z";
const conversations = [
  { id: "00000000-0000-4000-8000-000000000001", title: "产品需求梳理 · 演示", visibility: "private" },
  { id: "00000000-0000-4000-8000-000000000002", title: "团队任务交接 · 演示", visibility: "team" },
].map((item) => ({ ...item, ownerId: "demo-owner", ownerName: "演示成员", createdAt: stamp, updatedAt: stamp, modelProfileId: "demo-model" }));
const replies = [
  ["请帮我梳理一个需求，从用户问题到验收标准。", "这是预置的演示内容，不是实时生成结果。\n\n**工作方式**\n1. 明确谁遇到了什么问题。\n2. 整理使用场景与产品约束。\n3. 拆分任务，定义可以验证的验收标准。\n\n你可以切换左侧的演示会话，查看私有与团队两种界面。游客不能发送任务、上传文件或调用模型。"],
  ["这条团队会话如何交接任务？", "这是预置的演示内容。\n\n**团队会话**\n获授权成员可以在同一条会话中查看任务与回复；运行状态、队列和中断入口帮助团队协调使用。\n\n当前游客页面仅展示演示会话与示例状态，不展示真实成员、历史记录、附件或服务器配置。登录获授权账号后才能开始工作。"],
];

export function guestState(id) {
  const index = conversations.findIndex((item) => item.id === id);
  const conversation = conversations[index] || null;
  return {
    readOnly: true,
    conversation,
    messages: conversation ? replies[index].map((content, i) => ({
      id: `${conversation.id}-${i}`, conversationId: conversation.id, userId: "demo-owner",
      role: i ? "assistant" : "user", authorName: i ? "Agent · 演示" : "演示成员",
      content, status: "completed", activity: [], attachments: [], createdAt: stamp, updatedAt: stamp,
    })) : [],
    usage: { measuredRequests: 0, totalTokens: 0 },
    runtime: { status: "idle", runningCount: 0, queueCount: 0, current: null, currentCanInterrupt: false, onlineMembers: [] },
  };
}

export const guestConversations = conversations;
export const guestProfiles = [{ id: "demo-model", name: "演示模式", model: "未调用模型", isDefault: true }];

// Guests never enter the persistent user/session database or the live event bus.
// Keep short-lived tokens in a bounded, process-local registry; restarting revokes them.
export class GuestSessions {
  constructor({ ttlMs = 2 * 60 * 60_000, limit = 5000, now = Date.now } = {}) {
    this.sessions = new Map();
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.now = now;
  }
  cleanup() {
    for (const [token, session] of this.sessions) if (Date.parse(session.expiresAt) <= this.now()) this.sessions.delete(token);
  }
  create() {
    this.cleanup();
    if (this.sessions.size >= this.limit) return null;
    const token = `guest-${newToken()}`;
    const auth = { user, csrfToken: newToken(24), expiresAt: new Date(this.now() + this.ttlMs).toISOString() };
    this.sessions.set(token, auth);
    return { token, ...auth };
  }
  get(token) {
    const auth = this.sessions.get(token);
    if (auth && Date.parse(auth.expiresAt) > this.now()) return auth;
    this.sessions.delete(token);
    return null;
  }
  delete(token) { this.sessions.delete(token); }
}
