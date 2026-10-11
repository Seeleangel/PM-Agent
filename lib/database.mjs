import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hashPassword, normalizeUsername, tokenDigest, verifyPassword } from "./security.mjs";

const now = () => new Date().toISOString();
const DUMMY_PASSWORD_SALT = "claude-agent-web-login-dummy-salt";
const DUMMY_PASSWORD_HASH = hashPassword("claude-agent-web-login-dummy-password", DUMMY_PASSWORD_SALT).hash;

export class Store {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registration_requests (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        small_model TEXT NOT NULL,
        auth_token TEXT,
        credential_mode TEXT NOT NULL DEFAULT 'profile' CHECK(credential_mode IN ('profile','system')),
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('private','team')),
        claude_session_id TEXT NOT NULL UNIQUE,
        session_ready INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        activity_json TEXT NOT NULL DEFAULT '[]',
        task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id),
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON login_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_registration_status ON registration_requests(status, created_at);
    `);
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all().map((column) => column.name);
    if (!conversationColumns.includes("model_profile_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN model_profile_id TEXT");
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
    if (!messageColumns.includes("metrics_json")) this.db.exec("ALTER TABLE messages ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'");
    if (!messageColumns.includes("choice_json")) this.db.exec("ALTER TABLE messages ADD COLUMN choice_json TEXT");
    this.db.prepare("UPDATE messages SET status='failed', content=content || ? WHERE status IN ('queued','running')")
      .run("\n\n服务曾在处理过程中重启，请重新发送这项任务。");
    this.cleanupExpiredLoginSessions();
  }

  userCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  }

  createUser({ username, displayName, password, role = "member" }) {
    const normalized = normalizeUsername(username);
    const { salt, hash } = hashPassword(password);
    const user = { id: randomUUID(), username: normalized, displayName, role, createdAt: now() };
    this.db.prepare("INSERT INTO users(id,username,display_name,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(user.id, user.username, user.displayName, hash, salt, user.role, user.createdAt);
    return user;
  }

  createRegistrationRequest({ username, displayName, password }) {
    const normalized = normalizeUsername(username);
    const { salt, hash } = hashPassword(password);
    const existing = this.db.prepare("SELECT * FROM registration_requests WHERE username=?").get(normalized);
    if (existing?.status === "pending") return null;
    const request = { id: existing?.id || randomUUID(), username: normalized, displayName, status: "pending", createdAt: now() };
    if (existing) {
      this.db.prepare(`UPDATE registration_requests SET display_name=?,password_hash=?,password_salt=?,status='pending',created_at=?,reviewed_at=NULL,reviewed_by=NULL WHERE id=?`)
        .run(displayName, hash, salt, request.createdAt, request.id);
    } else {
      this.db.prepare(`INSERT INTO registration_requests(id,username,display_name,password_hash,password_salt,status,created_at)
        VALUES(?,?,?,?,?,'pending',?)`).run(request.id, normalized, displayName, hash, salt, request.createdAt);
    }
    return request;
  }

  registrationStatus(username) {
    return this.db.prepare("SELECT status FROM registration_requests WHERE username=?").get(normalizeUsername(username))?.status || null;
  }

  listRegistrationRequests({ status = "pending" } = {}) {
    return this.db.prepare(`SELECT id,username,display_name,status,created_at,reviewed_at FROM registration_requests
      WHERE status=? ORDER BY created_at ASC`).all(status).map((row) => ({
      id: row.id, username: row.username, displayName: row.display_name, status: row.status,
      createdAt: row.created_at, reviewedAt: row.reviewed_at,
    }));
  }

  approveRegistrationRequest(id, reviewerId) {
    const request = this.db.prepare("SELECT * FROM registration_requests WHERE id=? AND status='pending'").get(id);
    if (!request || this.db.prepare("SELECT 1 FROM users WHERE username=?").get(request.username)) return null;
    const user = { id: randomUUID(), username: request.username, displayName: request.display_name, role: "member", createdAt: now() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO users(id,username,display_name,password_hash,password_salt,role,created_at)
        VALUES(?,?,?,?,?,'member',?)`).run(user.id, user.username, user.displayName, request.password_hash, request.password_salt, user.createdAt);
      this.db.prepare("UPDATE registration_requests SET status='approved',reviewed_at=?,reviewed_by=? WHERE id=?")
        .run(now(), reviewerId, id);
      this.db.exec("COMMIT");
      return user;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rejectRegistrationRequest(id, reviewerId) {
    const result = this.db.prepare("UPDATE registration_requests SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'")
      .run(now(), reviewerId, id);
    return result.changes > 0;
  }

  authenticate(username, password) {
    const row = this.db.prepare("SELECT * FROM users WHERE username=?").get(normalizeUsername(username));
    // Keep the expensive password check on the unknown-user path as well, so the
    // login endpoint does not disclose account existence through timing alone.
    const passwordMatches = row
      ? verifyPassword(password, row.password_salt, row.password_hash)
      : verifyPassword(password, DUMMY_PASSWORD_SALT, DUMMY_PASSWORD_HASH);
    if (!row || row.disabled || !passwordMatches) return null;
    return this.publicUser(row);
  }

  publicUser(row) {
    return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at } : null;
  }

  getUserByUsername(username) {
    return this.publicUser(this.db.prepare("SELECT * FROM users WHERE username=?").get(normalizeUsername(username)));
  }

  createLoginSession(userId, token, csrfToken, expiresAt) {
    this.db.prepare("INSERT INTO login_sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(tokenDigest(token), userId, csrfToken, expiresAt, now());
  }

  getLoginSession(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT s.csrf_token,s.expires_at,u.* FROM login_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(tokenDigest(token), now());
    return row ? { user: this.publicUser(row), csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
  }

  deleteLoginSession(token) {
    if (token) this.db.prepare("DELETE FROM login_sessions WHERE token_hash=?").run(tokenDigest(token));
  }

  cleanupExpiredLoginSessions() {
    return this.db.prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(now()).changes;
  }

  deleteLoginSessionsForUser(userId, exceptToken = null) {
    if (exceptToken) {
      return this.db.prepare("DELETE FROM login_sessions WHERE user_id=? AND token_hash<>?")
        .run(userId, tokenDigest(exceptToken)).changes;
    }
    return this.db.prepare("DELETE FROM login_sessions WHERE user_id=?").run(userId).changes;
  }

  changePassword(userId, currentPassword, newPassword) {
    const row = this.db.prepare("SELECT password_hash,password_salt FROM users WHERE id=? AND disabled=0").get(userId);
    if (!row || !verifyPassword(currentPassword, row.password_salt, row.password_hash) || String(newPassword).length < 10) return false;
    const { salt, hash } = hashPassword(newPassword);
    return this.db.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?")
      .run(hash, salt, userId).changes > 0;
  }

  listUsers() {
    return this.db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM conversations c WHERE c.owner_id=u.id) AS conversation_count,
      (SELECT MAX(created_at) FROM login_sessions s WHERE s.user_id=u.id) AS last_login_at
      FROM users u ORDER BY u.disabled ASC,u.role DESC,u.created_at ASC`).all().map((row) => ({
      ...this.publicUser(row), conversationCount: Number(row.conversation_count || 0), lastLoginAt: row.last_login_at || null,
    }));
  }

  getUserById(id) {
    return this.publicUser(this.db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }

  updateUserRole(id, role) {
    const result = this.db.prepare("UPDATE users SET role=? WHERE id=? AND disabled=0").run(role, id);
    return result.changes ? this.getUserById(id) : null;
  }

  setUserDisabled(id, disabled) {
    const result = this.db.prepare("UPDATE users SET disabled=? WHERE id=?").run(disabled ? 1 : 0, id);
    if (!result.changes) return null;
    if (disabled) this.db.prepare("DELETE FROM login_sessions WHERE user_id=?").run(id);
    return this.getUserById(id);
  }

  modelProfileRow(row, { includeSecret = false } = {}) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, smallModel: row.small_model,
      credentialMode: row.credential_mode, hasCredential: row.credential_mode === "system" || Boolean(row.auth_token),
      enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(includeSecret ? { authToken: row.auth_token || "" } : {}),
    };
  }

  modelProfileCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM model_profiles").get().count;
  }

  seedSystemModelProfile({ name, baseUrl, model, smallModel }) {
    if (this.modelProfileCount()) return this.defaultModelProfile();
    const stamp = now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO model_profiles(id,name,base_url,model,small_model,credential_mode,enabled,is_default,created_at,updated_at)
      VALUES(?,?,?,?,?,'system',1,1,?,?)`).run(id, name, baseUrl, model, smallModel, stamp, stamp);
    return this.getModelProfile(id);
  }

  listModelProfiles({ includeDisabled = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM model_profiles ${includeDisabled ? "" : "WHERE enabled=1"}
      ORDER BY is_default DESC, enabled DESC, name COLLATE NOCASE`).all();
    return rows.map((row) => this.modelProfileRow(row));
  }

  getModelProfile(id, { includeSecret = false } = {}) {
    return this.modelProfileRow(this.db.prepare("SELECT * FROM model_profiles WHERE id=?").get(id), { includeSecret });
  }

  defaultModelProfile({ includeSecret = false } = {}) {
    const row = this.db.prepare("SELECT * FROM model_profiles WHERE enabled=1 ORDER BY is_default DESC, created_at ASC LIMIT 1").get();
    return this.modelProfileRow(row, { includeSecret });
  }

  createModelProfile({ name, baseUrl, model, smallModel, authToken, createdBy, isDefault = false }) {
    const stamp = now();
    const id = randomUUID();
    if (isDefault) this.db.prepare("UPDATE model_profiles SET is_default=0,updated_at=?").run(stamp);
    this.db.prepare(`INSERT INTO model_profiles(id,name,base_url,model,small_model,auth_token,credential_mode,enabled,is_default,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'profile',1,?,?,?,?)`).run(id, name, baseUrl, model, smallModel, authToken, isDefault ? 1 : 0, createdBy, stamp, stamp);
    return this.getModelProfile(id);
  }

  updateModelProfile(id, patch) {
    const current = this.getModelProfile(id, { includeSecret: true });
    if (!current) return null;
    const stamp = now();
    const enabled = patch.enabled ?? current.enabled;
    const isDefault = patch.isDefault ?? current.isDefault;
    if (isDefault && enabled) this.db.prepare("UPDATE model_profiles SET is_default=0,updated_at=? WHERE id<>?").run(stamp, id);
    this.db.prepare(`UPDATE model_profiles SET name=?,base_url=?,model=?,small_model=?,auth_token=?,enabled=?,is_default=?,updated_at=? WHERE id=?`)
      .run(
        patch.name ?? current.name,
        patch.baseUrl ?? current.baseUrl,
        patch.model ?? current.model,
        patch.smallModel ?? current.smallModel,
        patch.authToken === undefined || patch.authToken === "" ? current.authToken : patch.authToken,
        enabled ? 1 : 0,
        enabled && isDefault ? 1 : 0,
        stamp,
        id,
      );
    if (!this.defaultModelProfile()) this.db.prepare("UPDATE model_profiles SET enabled=1,is_default=1,updated_at=? WHERE id=?").run(stamp, id);
    else if (!this.db.prepare("SELECT 1 FROM model_profiles WHERE enabled=1 AND is_default=1").get()) {
      const fallback = this.db.prepare("SELECT id FROM model_profiles WHERE enabled=1 ORDER BY created_at ASC LIMIT 1").get();
      if (fallback) this.db.prepare("UPDATE model_profiles SET is_default=1,updated_at=? WHERE id=?").run(stamp, fallback.id);
    }
    return this.getModelProfile(id);
  }

  resolveModelProfile(id, { includeSecret = false } = {}) {
    const selected = id ? this.getModelProfile(id, { includeSecret }) : null;
    return selected?.enabled ? selected : this.defaultModelProfile({ includeSecret });
  }

  createConversation({ ownerId, title, visibility, modelProfileId = null }) {
    const createdAt = now();
    const profile = this.resolveModelProfile(modelProfileId);
    const conversation = {
      id: randomUUID(), ownerId, title, visibility, claudeSessionId: randomUUID(), sessionReady: false,
      modelProfileId: profile?.id || null, modelProfileName: profile?.name || null, model: profile?.model || null,
      archivedAt: null, createdAt, updatedAt: createdAt,
    };
    this.db.prepare(`INSERT INTO conversations(id,owner_id,title,visibility,claude_session_id,session_ready,model_profile_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(conversation.id, ownerId, title, visibility, conversation.claudeSessionId, 0, conversation.modelProfileId, createdAt, createdAt);
    return conversation;
  }

  conversationRow(row) {
    return row ? {
      id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, title: row.title, visibility: row.visibility,
      claudeSessionId: row.claude_session_id, sessionReady: Boolean(row.session_ready), archivedAt: row.archived_at,
      modelProfileId: row.resolved_model_profile_id || row.model_profile_id || null,
      modelProfileName: row.model_profile_name || null, model: row.model_name || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  listConversations(user) {
    return this.db.prepare(`SELECT c.*,u.display_name AS owner_name,mp.id AS resolved_model_profile_id,mp.name AS model_profile_name,mp.model AS model_name FROM conversations c JOIN users u ON u.id=c.owner_id
      LEFT JOIN model_profiles mp ON mp.id=COALESCE((SELECT id FROM model_profiles WHERE id=c.model_profile_id AND enabled=1),(SELECT id FROM model_profiles WHERE enabled=1 ORDER BY is_default DESC,created_at ASC LIMIT 1))
      WHERE c.archived_at IS NULL AND (c.visibility='team' OR c.owner_id=?) ORDER BY c.updated_at DESC`)
      .all(user.id).map((row) => this.conversationRow(row));
  }

  getConversation(id, user) {
    const row = this.db.prepare(`SELECT c.*,u.display_name AS owner_name,mp.id AS resolved_model_profile_id,mp.name AS model_profile_name,mp.model AS model_name FROM conversations c JOIN users u ON u.id=c.owner_id
      LEFT JOIN model_profiles mp ON mp.id=COALESCE((SELECT id FROM model_profiles WHERE id=c.model_profile_id AND enabled=1),(SELECT id FROM model_profiles WHERE enabled=1 ORDER BY is_default DESC,created_at ASC LIMIT 1))
      WHERE c.id=? AND c.archived_at IS NULL AND (c.visibility='team' OR c.owner_id=? OR ?='admin')`).get(id, user.id, user.role);
    return this.conversationRow(row);
  }

  updateConversation(id, user, patch) {
    const current = this.getConversation(id, user);
    if (!current || (current.ownerId !== user.id && user.role !== "admin")) return null;
    const title = patch.title ?? current.title;
    const visibility = patch.visibility ?? current.visibility;
    const profile = patch.modelProfileId === undefined ? null : this.resolveModelProfile(patch.modelProfileId);
    if (patch.modelProfileId !== undefined && !profile) return null;
    const modelProfileId = patch.modelProfileId === undefined ? current.modelProfileId : profile.id;
    this.db.prepare("UPDATE conversations SET title=?,visibility=?,model_profile_id=?,updated_at=? WHERE id=?").run(title, visibility, modelProfileId, now(), id);
    return this.getConversation(id, user);
  }

  archiveConversation(id, user) {
    const current = this.getConversation(id, user);
    if (!current || (current.ownerId !== user.id && user.role !== "admin")) return false;
    this.db.prepare("UPDATE conversations SET archived_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
    return true;
  }

  listMessages(conversationId, limit = 400) {
    return this.listMessagesPage(conversationId, { limit }).messages;
  }

  listMessagesPage(conversationId, { limit = 400, before = null } = {}) {
    const pageSize = Math.max(1, Math.min(400, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 400));
    const beforeCreatedAt = before && typeof before === "object" ? before.createdAt : null;
    const beforeId = before && typeof before === "object" ? before.id : null;
    const where = beforeCreatedAt && beforeId
      ? "WHERE conversation_id=? AND (created_at < ? OR (created_at = ? AND id < ?))"
      : "WHERE conversation_id=?";
    const params = beforeCreatedAt && beforeId
      ? [conversationId, beforeCreatedAt, beforeCreatedAt, beforeId, pageSize + 1]
      : [conversationId, pageSize + 1];
    // Read newest-first to cap the result to the newest page, then restore
    // chronological order for the UI. The extra row is only used for paging.
    const rows = this.db.prepare(`SELECT id,conversation_id,user_id,role,author_name,content,status,activity_json,metrics_json,choice_json,task_id,created_at,updated_at
      FROM messages ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params);
    const hasMore = rows.length > pageSize;
    const selectedRows = rows.slice(0, pageSize).reverse();
    const messages = selectedRows.map((row) => ({
        id: row.id, conversationId: row.conversation_id, userId: row.user_id, role: row.role, name: row.author_name,
        content: row.content, status: row.status, activity: JSON.parse(row.activity_json || "[]"), taskId: row.task_id,
        metrics: JSON.parse(row.metrics_json || "{}"), choice: row.choice_json ? JSON.parse(row.choice_json) : null,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }));
    const oldest = messages[0];
    const attachments = this.db.prepare(`SELECT id,message_id,original_name,mime_type,size,created_at
      FROM attachments WHERE conversation_id=? AND message_id IS NOT NULL ORDER BY created_at ASC`).all(conversationId);
    const byMessage = new Map();
    for (const row of attachments) {
      const values = byMessage.get(row.message_id) || [];
      values.push({ id: row.id, name: row.original_name, mimeType: row.mime_type, size: row.size, createdAt: row.created_at });
      byMessage.set(row.message_id, values);
    }
    return {
      messages: messages.map((message) => ({ ...message, attachments: byMessage.get(message.id) || [] })),
      hasMore,
      nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
    };
  }

  createAttachment({ conversationId, uploaderId, originalName, storedPath, mimeType, size }) {
    const attachment = { id: randomUUID(), conversationId, uploaderId, originalName, storedPath, mimeType, size, createdAt: now() };
    this.db.prepare(`INSERT INTO attachments(id,conversation_id,uploader_id,message_id,original_name,stored_path,mime_type,size,created_at)
      VALUES(?,?,?,NULL,?,?,?,?,?)`).run(attachment.id, conversationId, uploaderId, originalName, storedPath, mimeType, size, attachment.createdAt);
    return attachment;
  }

  getAttachment(id, conversationId) {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=? AND conversation_id=?").get(id, conversationId);
    return row ? {
      id: row.id, conversationId: row.conversation_id, uploaderId: row.uploader_id, messageId: row.message_id,
      originalName: row.original_name, storedPath: row.stored_path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at,
    } : null;
  }

  getPendingAttachments(ids, conversationId, uploaderId) {
    const unique = [...new Set(ids.map(String))];
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders}) AND conversation_id=? AND uploader_id=? AND message_id IS NULL`)
      .all(...unique, conversationId, uploaderId);
    const order = new Map(unique.map((id, index) => [id, index]));
    return rows.map((row) => ({
      id: row.id, conversationId: row.conversation_id, uploaderId: row.uploader_id, messageId: row.message_id,
      originalName: row.original_name, storedPath: row.stored_path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at,
    })).sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  pendingAttachmentCount(conversationId, uploaderId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=? AND uploader_id=? AND message_id IS NULL")
      .get(conversationId, uploaderId).count;
  }

  listExpiredPendingAttachments(before) {
    return this.db.prepare("SELECT id,stored_path FROM attachments WHERE message_id IS NULL AND created_at < ?").all(before)
      .map((row) => ({ id: row.id, storedPath: row.stored_path }));
  }

  deletePendingAttachmentById(id) {
    this.db.prepare("DELETE FROM attachments WHERE id=? AND message_id IS NULL").run(id);
  }

  bindAttachments(ids, messageId) {
    const statement = this.db.prepare("UPDATE attachments SET message_id=? WHERE id=? AND message_id IS NULL");
    for (const id of ids) statement.run(messageId, id);
  }

  removePendingAttachment(id, conversationId, uploaderId, allowAnyUploader = false) {
    const attachment = this.getAttachment(id, conversationId);
    if (!attachment || attachment.messageId || (!allowAnyUploader && attachment.uploaderId !== uploaderId)) return null;
    this.db.prepare("DELETE FROM attachments WHERE id=?").run(id);
    return attachment;
  }

  addMessage({ conversationId, userId = null, role, authorName, content, status, taskId = null, activity = [], metrics = {}, choice = null }) {
    const stamp = now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO messages(id,conversation_id,user_id,role,author_name,content,status,activity_json,metrics_json,choice_json,task_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, conversationId, userId, role, authorName, content, status, JSON.stringify(activity), JSON.stringify(metrics), choice ? JSON.stringify(choice) : null, taskId, stamp, stamp);
    this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(stamp, conversationId);
    return id;
  }

  updateMessage(id, patch) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) return;
    this.db.prepare("UPDATE messages SET content=?,status=?,activity_json=?,metrics_json=?,choice_json=?,updated_at=? WHERE id=?")
      .run(
        patch.content ?? row.content,
        patch.status ?? row.status,
        JSON.stringify(patch.activity ?? JSON.parse(row.activity_json || "[]")),
        JSON.stringify(patch.metrics ?? JSON.parse(row.metrics_json || "{}")),
        patch.choice === undefined ? row.choice_json : patch.choice ? JSON.stringify(patch.choice) : null,
        now(),
        id,
      );
  }

  answerChoice(messageId, conversationId, userId, values, customAnswer = "") {
    const row = this.db.prepare("SELECT choice_json FROM messages WHERE id=? AND conversation_id=? AND role='assistant'").get(messageId, conversationId);
    if (!row?.choice_json) return null;
    const choice = JSON.parse(row.choice_json);
    if (choice.answeredAt) return null;
    const allowed = new Set((choice.options || []).map((option) => option.label));
    const selected = [...new Set((Array.isArray(values) ? values : []).map(String))].filter((value) => allowed.has(value));
    const custom = typeof customAnswer === "string" ? customAnswer.trim() : "";
    if (custom.length > 4000 || (!selected.length && !custom) || (!choice.multiple && (selected.length > 1 || (selected.length && custom)))) return null;
    const answered = { ...choice, values: selected, customAnswer: custom, answeredAt: now(), answeredBy: userId };
    this.db.prepare("UPDATE messages SET choice_json=?,updated_at=? WHERE id=?").run(JSON.stringify(answered), now(), messageId);
    return answered;
  }

  markConversationReady(id) {
    this.db.prepare("UPDATE conversations SET session_ready=1,updated_at=? WHERE id=?").run(now(), id);
  }

  setConversationSession(id, sessionId) {
    this.db.prepare("UPDATE conversations SET claude_session_id=?,session_ready=1,updated_at=? WHERE id=?").run(sessionId, now(), id);
  }

  close() {
    this.db.close();
  }
}
