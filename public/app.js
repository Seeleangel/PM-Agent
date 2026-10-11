const appBasePath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
let deploymentFeatures = { lark: true, plugins: true };
const $ = (selector) => document.querySelector(selector);
const elements = {
  guestButton: $("#guest-button"), guestNotice: $("#guest-notice"), guestLogin: $("#guest-login-button"),
  authScreen: $("#auth-screen"), appShell: $("#app-shell"), authForm: $("#auth-form"), authError: $("#auth-error"),
  loginTab: $("#login-tab"), registerTab: $("#register-tab"), displayField: $("#display-name-field"), displayName: $("#display-name"),
  username: $("#username"), password: $("#password"), authSubmit: $("#auth-submit"), authFootnote: $("#auth-footnote"),
  privateList: $("#private-conversations"), teamList: $("#team-conversations"), sessionSearch: $("#session-search"), newButton: $("#new-conversation-button"),
  newForm: $("#new-conversation-form"), newTitle: $("#new-title"), newModel: $("#new-model"), cancelNew: $("#cancel-new"),
  title: $("#conversation-title"), meta: $("#conversation-meta"), visibility: $("#visibility-badge"), larkRoute: $("#lark-route-badge"), sessionTokenUsage: $("#session-token-usage"), conversationModel: $("#conversation-model"), list: $("#message-list"),
  form: $("#composer"), message: $("#message-input"), send: $("#send-button"), formError: $("#form-error"),
  attachmentButton: $("#attachment-button"), attachmentInput: $("#attachment-input"), attachmentTray: $("#attachment-tray"),
  messageDropZone: $("#message-drop-zone"), dropHint: $("#drop-hint"),
  interruptButton: $("#interrupt-button"), interruptLabel: $("#interrupt-label"),
  commandMenu: $("#command-menu"), commandOptions: $("#command-options"),
  rename: $("#rename-button"), archive: $("#archive-button"), larkButton: $("#lark-button"), manage: $("#manage-button"), accountSecurityButton: $("#account-security-button"), logout: $("#logout-button"), accountName: $("#account-name"),
  accountRole: $("#account-role"), accountAvatar: $("#account-avatar"), connection: $("#connection-state"),
  agentStatus: $("#agent-status"), statusLabel: $("#status-label"), onlineCount: $("#online-count"), onlineMemberList: $("#online-member-list"),
  runningCount: $("#running-count"), queueCount: $("#queue-count"), currentTaskLabel: $("#current-task-label"),
  currentTask: $("#current-task-content"),
  sessionPanel: $("#session-panel"), capabilityPanel: $("#capability-panel"), scrim: $("#drawer-scrim"),
  openSessions: $("#open-sessions"), closeSessions: $("#close-sessions"), openCapabilities: $("#open-capabilities"), closeCapabilities: $("#close-capabilities"),
  managementScreen: $("#management-screen"), closeManagement: $("#close-management"),
  refreshAccounts: $("#refresh-accounts"), accountCount: $("#account-count"), pendingAccountCount: $("#pending-account-count"),
  pendingAccountList: $("#pending-account-list"), managedAccountList: $("#managed-account-list"), accountsStatus: $("#accounts-status"),
  modelCount: $("#model-count"), modelList: $("#model-profile-list"), modelCreateForm: $("#model-create-form"), modelCreateStatus: $("#model-create-status"),
  modelEditForm: $("#model-edit-form"), modelEditStatus: $("#model-edit-status"), cancelModelEdit: $("#cancel-model-edit"),
  memoryStateBadge: $("#memory-state-badge"), claudeMdPath: $("#claude-md-path"), memoryDirectory: $("#memory-directory"), memoryBudget: $("#memory-budget"),
  memoryForm: $("#memory-form"), memoryEditor: $("#claude-md-editor"), memoryPreview: $("#claude-md-preview"), memoryEditMode: $("#memory-edit-mode"), memoryPreviewMode: $("#memory-preview-mode"),
  claudeMdUpdated: $("#claude-md-updated"), claudeMdCount: $("#claude-md-count"), reloadMemory: $("#reload-memory"), memoryStatus: $("#memory-status"), memoryFileCount: $("#memory-file-count"), memoryFileList: $("#memory-file-list"),
  skillCount: $("#skill-count"), managedSkillList: $("#managed-skill-list"), skillCreateForm: $("#skill-create-form"), skillGithubForm: $("#skill-github-form"),
  marketplaceForm: $("#marketplace-form"), marketplaceStatus: $("#marketplace-status"), marketplaceList: $("#marketplace-list"),
  refreshPlugins: $("#refresh-plugins"), installedPluginList: $("#installed-plugin-list"), availablePluginList: $("#available-plugin-list"),
  settingsMcpList: $("#settings-mcp-list"), settingsAgentList: $("#settings-agent-list"),
  larkScreen: $("#lark-screen"), closeLark: $("#close-lark"), refreshLark: $("#refresh-lark"),
  personalLarkBadge: $("#personal-lark-badge"), personalLarkDetail: $("#personal-lark-detail"), teamLarkBadge: $("#team-lark-badge"), teamLarkDetail: $("#team-lark-detail"),
  startLarkAuth: $("#start-lark-auth"), logoutLarkAuth: $("#logout-lark-auth"), larkAuthFlow: $("#lark-auth-flow"), larkAuthLink: $("#lark-auth-link"), larkAuthQr: $("#lark-auth-qr"),
  completeLarkAuth: $("#complete-lark-auth"), larkAuthExpiry: $("#lark-auth-expiry"), larkStatus: $("#lark-status"),
  choicePanel: $("#choice-panel"), choiceForm: $("#choice-form"), choiceQuestion: $("#choice-question"), choiceOptions: $("#choice-options"), choiceError: $("#choice-error"),
  cancelChoice: $("#cancel-choice"), deferChoice: $("#defer-choice"),
  accountSecurityDialog: $("#account-security-dialog"), accountSecurityForm: $("#account-security-form"), accountSecurityStatus: $("#account-security-status"),
  closeAccountSecurity: $("#close-account-security"), logoutOtherDevices: $("#logout-other-devices"),
};

let authMode = "login";
let csrfToken = "";
let user = null;
let conversations = [];
let selectedId = null;
let eventSource = null;
// A conversation selection creates a new render generation.  Async fetches and
// reconnecting EventSources from an older generation must never paint into it.
let conversationGeneration = 0;
let eventSequence = 0;
let messageCache = new Map();
const deferredMessageUpdates = new Map();
let lastMessageId = null;
let availableCommands = [];
let filteredCommands = [];
let commandIndex = 0;
let modelProfiles = [];
let adminModelProfiles = [];
let capabilitySnapshot = null;
let larkStatusSnapshot = null;
let memorySnapshot = null;
let memoryDirty = false;
let activeChoiceMessage = null;
let lastPromptedChoiceId = null;
let pendingAttachments = [];
let pendingConversationId = null;
let isSubmitting = false;
let dragDepth = 0;
let latestRuntime = {};
let interruptPending = false;
let renderedConversationId = null;
const isGuest = () => user?.role === "guest";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

async function api(url, options = {}) {
  if (isGuest() && options.method && options.method !== "GET" && !url.startsWith("/api/auth/")) throw new Error("游客只能浏览演示界面，请登录获授权账号后使用。");
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (options.method && options.method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`${appBasePath}${url}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.includes("/auth/")) showAuth();
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试。");
  return payload;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  elements.loginTab.setAttribute("aria-selected", String(!registering));
  elements.registerTab.setAttribute("aria-selected", String(registering));
  elements.displayField.hidden = !registering;
  elements.displayName.required = registering;
  elements.password.autocomplete = registering ? "new-password" : "current-password";
  elements.authSubmit.textContent = registering ? "提交注册申请" : "进入工作台";
  elements.authFootnote.textContent = registering
    ? "提交后需要管理员审批。审批通过前账号不能登录，密码不会展示给管理员。"
    : "账号仅供管理员授权的成员使用。不要在会话中提交密码、令牌或不应共享的资料。";
  elements.authError.textContent = "";
  elements.authError.dataset.state = "";
}

function showAuth() {
  conversationGeneration += 1;
  eventSequence = 0;
  eventSource?.close();
  eventSource = null;
  deferredMessageUpdates.clear();
  closeChoiceDialog();
  if (elements.accountSecurityDialog.open) elements.accountSecurityDialog.close();
  pendingAttachments = [];
  pendingConversationId = null;
  isSubmitting = false;
  elements.attachmentInput.value = "";
  renderAttachments();
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
  elements.managementScreen.hidden = true;
  elements.larkScreen.hidden = true;
  user = null;
  csrfToken = "";
  selectedId = null;
  conversations = [];
  modelProfiles = [];
  messageCache.clear();
  elements.sessionSearch.value = "";
}

function showApp() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  elements.managementScreen.hidden = true;
  elements.larkScreen.hidden = true;
  elements.accountName.textContent = user.displayName;
  elements.accountRole.textContent = isGuest() ? "演示内容 · 只读" : user.role === "admin" ? "管理员" : `@${user.username}`;
  elements.accountAvatar.textContent = user.displayName.slice(0, 1).toUpperCase();
  elements.manage.hidden = user.role !== "admin";
  elements.guestNotice.hidden = !isGuest();
  elements.newButton.disabled = isGuest();
  elements.newButton.title = isGuest() ? "游客不能创建会话" : "";
  elements.newForm.hidden = true;
  elements.accountSecurityButton.hidden = isGuest();
  elements.larkButton.hidden = isGuest() || !deploymentFeatures.lark;
  elements.larkRoute.hidden = isGuest() || !deploymentFeatures.lark;
  elements.logout.textContent = isGuest() ? "退出游客浏览" : "退出登录";
  elements.message.placeholder = isGuest() ? "游客模式仅供浏览，登录获授权账号后开始工作" : "给 Agent 发消息… 输入 / 查看命令";
}

function renderIdentityBadge(element, ready) {
  element.textContent = ready ? "已授权" : "未授权";
  element.className = `row-badge ${ready ? "default" : "disabled"}`;
}

function renderLarkStatus(data) {
  larkStatusSnapshot = data;
  renderIdentityBadge(elements.personalLarkBadge, data.personal.ready);
  renderIdentityBadge(elements.teamLarkBadge, data.team.ready);
  elements.personalLarkDetail.textContent = data.personal.ready
    ? `${data.personal.userName || "飞书用户"} · Token 有效${data.personalSharesTeamCredential ? " · 与团队会话共用" : ""}`
    : data.personal.configured ? "应用已配置，尚未完成个人授权或授权已过期。" : "尚未创建你的个人飞书配置。";
  elements.teamLarkDetail.textContent = data.team.ready
    ? `${data.team.userName || "管理员"} · 团队会话固定使用此身份`
    : "团队管理员授权不可用，请联系管理员重新授权。";
  elements.startLarkAuth.textContent = data.personal.ready ? "重新授权" : "开始授权";
  elements.logoutLarkAuth.hidden = data.personalSharesTeamCredential || !data.personal.ready;
}

async function loadLarkStatus() {
  elements.refreshLark.disabled = true;
  setInlineStatus(elements.larkStatus, "正在核验飞书身份…");
  try {
    renderLarkStatus(await api("/api/lark/status"));
    setInlineStatus(elements.larkStatus, "身份状态已更新", "success");
  } catch (error) { setInlineStatus(elements.larkStatus, error.message, "error"); }
  finally { elements.refreshLark.disabled = false; }
}

async function openLarkScreen() {
  closeDrawers();
  elements.appShell.hidden = true;
  elements.managementScreen.hidden = true;
  elements.larkScreen.hidden = false;
  elements.larkAuthFlow.hidden = true;
  await loadLarkStatus();
}

function closeLarkScreen() {
  elements.larkScreen.hidden = true;
  elements.appShell.hidden = false;
}

function timeLabel(iso) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function tokenLabel(value, { compact = false } = {}) {
  const tokens = Number(value || 0);
  if (!compact || tokens < 1000) return tokens.toLocaleString("zh-CN");
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function usageParts(metrics = {}) {
  const direct = Number(metrics.inputTokens || 0) + Number(metrics.outputTokens || 0);
  const cache = Number(metrics.cacheReadInputTokens || 0);
  const cacheWrite = Number(metrics.cacheCreationInputTokens || 0);
  return { direct, cache, cacheWrite, processed: direct + cache + cacheWrite };
}

function durationLabel(value) {
  const milliseconds = Number(value || 0);
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function fileSizeLabel(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function screenshotName(type, index = 0) {
  const extension = ({ "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" })[type] || "png";
  const stamp = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(/\D/g, "");
  return `截图-${stamp}${index ? `-${index + 1}` : ""}.${extension}`;
}

function normalizeClipboardFile(file, index) {
  if (file.name && !/^(?:image|clipboard|pasted[-_ ]?image)\.(png|jpe?g|webp|gif)$/i.test(file.name)) return file;
  return new File([file], screenshotName(file.type, index), { type: file.type || "image/png", lastModified: file.lastModified || Date.now() });
}

function setComposerStatus(message = "", state = "") {
  elements.formError.textContent = message;
  elements.formError.dataset.state = state;
}

function setDropActive(active) {
  elements.messageDropZone.dataset.dropActive = String(active);
  elements.dropHint.hidden = !active;
}

function resetDropState() {
  dragDepth = 0;
  setDropActive(false);
}

function dragHasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function addPendingFiles(files, { source = "picker" } = {}) {
  const errors = [];
  let added = 0;
  if (!selectedId) return 0;
  if (!pendingConversationId) pendingConversationId = selectedId;
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      errors.push(`每轮最多添加 ${MAX_ATTACHMENTS} 个文件。`);
      break;
    }
    if (!file.size) { errors.push(`${file.name || "这个文件"} 是空文件，未添加。`); continue; }
    if (file.size > MAX_ATTACHMENT_BYTES) { errors.push(`${file.name || "这个文件"} 超过 25 MB，未添加。`); continue; }
    pendingAttachments.push({ key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, remote: null, uploading: false });
    added += 1;
  }
  const successMessage = source === "clipboard"
    ? `已从剪贴板添加 ${added} 个附件。`
    : source === "drop" ? `已通过拖拽添加 ${added} 个附件。` : "";
  setComposerStatus(errors.join(" ") || (added ? successMessage : ""), errors.length ? "" : added ? "success" : "");
  renderAttachments();
  return added;
}

function renderAttachments() {
  elements.attachmentTray.replaceChildren();
  elements.attachmentTray.hidden = !pendingAttachments.length;
  for (const item of pendingAttachments) {
    const row = document.createElement("div"); row.className = "attachment-row";
    const icon = document.createElement("span"); icon.textContent = "↥"; icon.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div"); copy.className = "attachment-copy";
    const name = document.createElement("strong"); name.textContent = item.file.name;
    const size = document.createElement("small"); size.textContent = fileSizeLabel(item.file.size); copy.append(name, size);
    const state = document.createElement("span"); state.className = "attachment-state";
    state.dataset.state = item.uploading ? "uploading" : item.remote ? "ready" : "pending";
    state.textContent = item.uploading ? "上传中" : item.remote ? "已上传" : "待发送";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.textContent = "移除";
    remove.disabled = isSubmitting || item.uploading;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      if (item.remote && pendingConversationId) {
        await api(`/api/conversations/${pendingConversationId}/attachments/${item.remote.id}`, { method: "DELETE" }).catch(() => {});
      }
      pendingAttachments = pendingAttachments.filter((candidate) => candidate.key !== item.key);
      if (!pendingAttachments.length) pendingConversationId = null;
      renderAttachments();
    });
    row.append(icon, copy, state, remove); elements.attachmentTray.append(row);
  }
}

async function discardPendingAttachments() {
  const conversationId = pendingConversationId;
  const remote = pendingAttachments.filter((item) => item.remote);
  pendingAttachments = [];
  pendingConversationId = null;
  elements.attachmentInput.value = "";
  renderAttachments();
  if (conversationId) await Promise.allSettled(remote.map((item) => api(`/api/conversations/${conversationId}/attachments/${item.remote.id}`, { method: "DELETE" })));
}

function closeChoiceDialog() {
  elements.choicePanel.hidden = true;
  activeChoiceMessage = null;
  elements.choiceError.textContent = "";
}

function openChoiceDialog(message) {
  if (!message?.choice || message.choice.answeredAt) return;
  activeChoiceMessage = message;
  elements.choiceQuestion.textContent = message.choice.question;
  elements.choiceOptions.replaceChildren();
  elements.choiceError.textContent = "";
  const inputType = message.choice.multiple ? "checkbox" : "radio";
  for (const option of [...message.choice.options, { label: "其他回答", description: "也可以直接输入自己的回答。", custom: true }]) {
    const label = document.createElement("label"); label.className = "choice-option";
    const input = document.createElement("input"); input.type = inputType; input.name = "agent-choice"; input.value = option.label;
    if (option.custom) input.dataset.custom = "true";
    const copy = document.createElement("span");
    const strong = document.createElement("strong"); strong.textContent = option.label; copy.append(strong);
    if (option.description) { const small = document.createElement("small"); small.textContent = option.description; copy.append(small); }
    if (option.custom) {
      label.classList.add("choice-option-custom");
      const custom = document.createElement("textarea"); custom.name = "custom-answer"; custom.maxLength = 4000; custom.rows = 2; custom.placeholder = "输入你的回答…"; custom.setAttribute("aria-label", "输入自己的回答");
      custom.addEventListener("input", () => { if (custom.value.trim()) input.checked = true; });
      copy.append(custom);
    }
    label.append(input, copy); elements.choiceOptions.append(label);
  }
  elements.choicePanel.hidden = false;
}

function conversationButton(conversation) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "conversation-item";
  button.dataset.active = String(conversation.id === selectedId);
  const title = document.createElement("strong");
  title.textContent = conversation.title;
  const detail = document.createElement("span");
  detail.textContent = conversation.visibility === "team" ? `${conversation.ownerName} · ${timeLabel(conversation.updatedAt)}` : timeLabel(conversation.updatedAt);
  button.append(title, detail);
  button.addEventListener("click", () => selectConversation(conversation.id));
  return button;
}

function renderConversationLists() {
  elements.privateList.replaceChildren();
  elements.teamList.replaceChildren();
  const query = elements.sessionSearch.value.trim().toLocaleLowerCase();
  for (const conversation of conversations) {
    if (query && !`${conversation.title} ${conversation.ownerName || ""}`.toLocaleLowerCase().includes(query)) continue;
    const target = conversation.visibility === "team" ? elements.teamList : elements.privateList;
    target.append(conversationButton(conversation));
  }
  if (!elements.privateList.children.length) elements.privateList.append(emptyLabel(query ? "无匹配会话" : "还没有私有会话"));
  if (!elements.teamList.children.length) elements.teamList.append(emptyLabel(query ? "无匹配会话" : "还没有团队会话"));
}

function emptyLabel(text) {
  const p = document.createElement("p");
  p.className = "list-empty";
  p.textContent = text;
  return p;
}

function renderModelOptions(select, selected = null) {
  select.replaceChildren();
  for (const profile of modelProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.model}${profile.isDefault ? "（默认）" : ""}`;
    option.selected = profile.id === selected;
    select.append(option);
  }
  if (!modelProfiles.length) {
    const option = document.createElement("option"); option.textContent = "暂无可用模型"; option.value = ""; select.append(option);
  }
}

async function loadModelProfiles() {
  const data = await api("/api/model-profiles");
  modelProfiles = data.profiles || [];
  const newSelected = elements.newModel.value || modelProfiles.find((item) => item.isDefault)?.id;
  renderModelOptions(elements.newModel, newSelected);
  const conversation = conversations.find((item) => item.id === selectedId);
  renderModelOptions(elements.conversationModel, conversation?.modelProfileId);
}

async function loadConversations() {
  const data = await api("/api/conversations");
  conversations = data.conversations;
  if (selectedId && !conversations.some((item) => item.id === selectedId)) selectedId = null;
  renderConversationLists();
  renderRuntime(data.runtime);
  if (!selectedId && conversations.length) await selectConversation(conversations[0].id);
  else if (!selectedId) { renderNoConversation(); connectEvents(); }
}

function renderNoConversation() {
  resetDropState();
  elements.title.textContent = "选择一个会话";
  elements.meta.textContent = "创建会话后开始工作";
  elements.visibility.textContent = "—";
  elements.visibility.dataset.scope = "none";
  elements.larkRoute.textContent = "飞书：—";
  elements.sessionTokenUsage.textContent = "本会话用量 · 待记录";
  elements.sessionTokenUsage.title = "本会话累计用量，包含缓存；输入、输出、缓存读取和缓存写入明细";
  closeChoiceDialog();
  elements.message.disabled = true;
  elements.send.disabled = true;
  elements.attachmentButton.disabled = true;
  elements.rename.disabled = true;
  elements.archive.disabled = true;
  elements.conversationModel.disabled = true;
  renderModelOptions(elements.conversationModel);
  elements.list.replaceChildren();
  const wrap = document.createElement("div"); wrap.className = "empty-state";
  const index = document.createElement("div"); index.className = "empty-index"; index.textContent = "00";
  const copy = document.createElement("div"); const heading = document.createElement("h2"); heading.textContent = "还没有选中会话";
  const p = document.createElement("p"); p.textContent = "从会话列表打开已有会话，或新建一条会话。";
  copy.append(heading, p); wrap.append(index, copy); elements.list.append(wrap);
}

async function selectConversation(id) {
  const generation = ++conversationGeneration;
  if (selectedId && selectedId !== id && pendingAttachments.length) await discardPendingAttachments();
  selectedId = id;
  eventSequence = 0;
  messageCache = new Map();
  deferredMessageUpdates.clear();
  eventSource?.close();
  eventSource = null;
  localStorage.setItem(isGuest() ? "agent-guest-conversation" : "agent-selected-conversation", id);
  renderConversationLists();
  closeDrawers();
  const data = await api(`/api/conversations/${id}`);
  if (selectedId !== id || generation !== conversationGeneration) return;
  renderState(data);
  connectEvents(generation);
}

function appendInlineMarkup(target, value) {
  const text = String(value ?? "");
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[\w#/])/g;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      target.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      target.append(strong);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      target.append(emphasis);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (parts) {
        const link = document.createElement("a");
        link.href = parts[2];
        link.textContent = parts[1];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        target.append(link);
      } else if (/^https?:\/\//i.test(token)) {
        const link = document.createElement("a");
        link.href = token;
        link.textContent = token;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        target.append(link);
      } else target.append(document.createTextNode(token));
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isResponseBlockStart(lines, index) {
  const line = lines[index] || "";
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,3}\s+/.test(line)
    || /^\s*([-*+]\s+|\d+\.\s+|>\s?)/.test(line)
    || /^\s*(---+|___+|\*\*\*+)\s*$/.test(line)
    || (line.includes("|") && isTableDivider(lines[index + 1] || ""));
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function appendCodeBlock(target, codeText, language) {
  const figure = document.createElement("figure");
  figure.className = "response-code";
  const head = document.createElement("figcaption");
  head.className = "response-code-head";
  const label = document.createElement("span");
  label.textContent = language || "代码";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-code-button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", async () => {
    try {
      await copyText(codeText);
      copyButton.textContent = "已复制";
      window.setTimeout(() => { copyButton.textContent = "复制"; }, 1400);
    } catch {
      copyButton.textContent = "复制失败";
      window.setTimeout(() => { copyButton.textContent = "复制"; }, 1400);
    }
  });
  head.append(label, copyButton);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = codeText;
  pre.append(code);
  figure.append(head, pre);
  target.append(figure);
}

function renderAssistantContent(target, source) {
  target.classList.add("rich-response");
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      appendCodeBlock(target, codeLines.join("\n"), fence[1]);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      const title = document.createElement(`h${Math.min(heading[1].length + 1, 4)}`);
      appendInlineMarkup(title, heading[2]);
      target.append(title);
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[index + 1] || "")) {
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      const wrap = document.createElement("div");
      wrap.className = "response-table-wrap";
      wrap.tabIndex = 0;
      wrap.setAttribute("aria-label", "可横向滚动的数据表格");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const cell of headers) {
        const th = document.createElement("th");
        appendInlineMarkup(th, cell);
        headerRow.append(th);
      }
      thead.append(headerRow);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
          const td = document.createElement("td");
          appendInlineMarkup(td, row[cellIndex] || "");
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      target.append(wrap);
      continue;
    }

    const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+)$/);
        if (!itemMatch || /\d+\./.test(itemMatch[1]) !== ordered) break;
        const item = document.createElement("li");
        if (itemMatch[2]) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = itemMatch[2].toLowerCase() === "x";
          checkbox.disabled = true;
          checkbox.setAttribute("aria-label", checkbox.checked ? "已完成" : "未完成");
          item.append(checkbox, document.createTextNode(" "));
        }
        appendInlineMarkup(item, itemMatch[3]);
        list.append(item);
        index += 1;
      }
      target.append(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        if (quote.childNodes.length) quote.append(document.createElement("br"));
        appendInlineMarkup(quote, lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      target.append(quote);
      continue;
    }

    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      target.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    const paragraph = document.createElement("p");
    while (index < lines.length && lines[index].trim() && !isResponseBlockStart(lines, index)) {
      if (paragraph.childNodes.length) paragraph.append(document.createElement("br"));
      appendInlineMarkup(paragraph, lines[index]);
      index += 1;
    }
    if (!paragraph.childNodes.length) {
      appendInlineMarkup(paragraph, line);
      index += 1;
    }
    target.append(paragraph);
  }
}

function makeEntry(message) {
  const row = document.createElement("article");
  row.className = "ledger-entry";
  row.dataset.role = message.role;
  row.dataset.messageId = message.id;
  const interrupted = message.status === "failed" && message.metrics?.cancelled;
  row.dataset.status = interrupted ? "cancelled" : message.status;
  const time = document.createElement("time"); time.className = "entry-time"; time.dateTime = message.createdAt; time.textContent = timeLabel(message.createdAt);
  const author = document.createElement("div"); author.className = "entry-author";
  const dot = document.createElement("span"); dot.className = "entry-dot"; dot.setAttribute("aria-hidden", "true");
  const name = document.createElement("span"); name.textContent = message.name; author.append(dot, name);
  const body = document.createElement("div"); body.className = "entry-body";
  const payload = document.createElement("div"); payload.className = "entry-payload";
  const content = document.createElement("div"); content.className = "entry-content";
  if (message.role === "assistant") renderAssistantContent(content, message.content);
  else content.textContent = message.content;
  payload.append(content);
  if (message.attachments?.length) {
    const list = document.createElement("div"); list.className = "entry-attachments";
    for (const attachment of message.attachments) {
      const link = document.createElement("a"); link.className = "entry-attachment";
      link.href = `${appBasePath}/api/conversations/${message.conversationId}/attachments/${attachment.id}/download`;
      const icon = document.createElement("span"); icon.className = "entry-attachment-icon"; icon.textContent = "↧"; icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("strong"); name.textContent = attachment.name;
      const size = document.createElement("small"); size.textContent = fileSizeLabel(attachment.size);
      link.append(icon, name, size); list.append(link);
    }
    payload.append(list);
  }
  if (message.role === "assistant" && message.activity?.some((item) => item.kind === "Subagent")) {
    const progress = document.createElement("details"); progress.className = "subagent-progress";
    if (message.status === "running") progress.open = true;
    const subagents = message.activity.filter((item) => item.kind === "Subagent");
    const completed = subagents.filter((item) => item.status === "completed").length;
    const summary = document.createElement("summary");
    summary.textContent = message.status === "running"
      ? `子 Agent 执行中 · ${completed}/${subagents.length} 完成`
      : message.status === "completed"
        ? `子 Agent 任务 · ${completed}/${subagents.length} 完成`
        : `子 Agent 任务 · ${completed}/${subagents.length} 完成 · 运行未完成`;
    const list = document.createElement("ol");
    for (const item of subagents) {
      const row = document.createElement("li"); row.dataset.status = item.status || "completed";
      const title = document.createElement("strong"); title.textContent = item.description || "子任务";
      const state = document.createElement("span"); state.textContent = item.status === "completed" ? "已完成" : message.status === "running" ? "执行中" : "未完成";
      row.append(title, state); list.append(row);
    }
    progress.append(summary, list); payload.append(progress);
  }
  if (message.role === "assistant" && message.choice) {
    const prompt = document.createElement("div"); prompt.className = `choice-inline ${message.choice.answeredAt ? "answered" : ""}`;
    const copy = document.createElement("div");
    const strong = document.createElement("strong"); strong.textContent = message.choice.answeredAt ? "已提交选择" : "等待你的选择"; copy.append(strong);
    const detail = document.createElement("span"); detail.textContent = message.choice.answeredAt ? [...(message.choice.values || []), message.choice.customAnswer].filter(Boolean).join("、") : message.choice.question; copy.append(detail);
    prompt.append(copy);
    if (!message.choice.answeredAt) { const button = document.createElement("button"); button.type = "button"; button.textContent = "选择"; button.addEventListener("click", () => openChoiceDialog(message)); prompt.append(button); }
    payload.append(prompt);
  }
  body.append(payload);
  const footer = document.createElement("div"); footer.className = "entry-footer";
  footer.append(time);
  const status = document.createElement("span"); status.className = "entry-status";
  status.textContent = interrupted ? "已中断" : ({ queued: "等待中", running: "正在处理", completed: "已完成", failed: "失败" })[message.status] || message.status;
  footer.append(status);
  if (message.role === "assistant" && message.metrics?.durationMs) {
    const duration = document.createElement("span"); duration.className = "entry-duration"; duration.textContent = `耗时 ${durationLabel(message.metrics.durationMs)}`; footer.append(duration);
    const usage = usageParts(message.metrics);
    if (usage.processed) {
      const breakdown = document.createElement("span"); breakdown.className = "token-breakdown";
      breakdown.textContent = `输入 ${tokenLabel(message.metrics.inputTokens)} · 输出 ${tokenLabel(message.metrics.outputTokens)}${usage.cache ? ` · 缓存 ${tokenLabel(usage.cache)}` : ""}${usage.cacheWrite ? ` · 写缓存 ${tokenLabel(usage.cacheWrite)}` : ""}`;
      breakdown.title = "包含本轮所有模型与 Subagent 调用；缓存量计入总量";
      footer.append(breakdown);
    }
  }
  body.append(footer);
  row.append(author, body);
  return row;
}

function renderState(data) {
  renderRuntime(data.runtime);
  if (!data.conversation) return renderNoConversation();
  const conversation = data.conversation;
  elements.title.textContent = conversation.title;
  elements.meta.textContent = isGuest() ? "预置演示会话 · 不会调用模型或展示真实数据" : `${conversation.ownerName} 创建 · ${timeLabel(conversation.updatedAt)} 更新`;
  elements.visibility.textContent = conversation.visibility === "team" ? "团队共享" : "仅自己";
  elements.visibility.dataset.scope = conversation.visibility;
  elements.larkRoute.textContent = conversation.visibility === "team" ? "飞书：管理员" : "飞书：所有者";
  elements.larkRoute.dataset.scope = conversation.visibility;
  const sessionUsage = usageParts(data.usage);
  elements.sessionTokenUsage.textContent = data.usage?.measuredRequests
    ? `本会话用量 · ${tokenLabel(sessionUsage.processed, { compact: true })} tokens`
    : "本会话用量 · 待记录";
  elements.sessionTokenUsage.title = data.usage?.measuredRequests
    ? `本会话累计，包含缓存 · 输入 ${tokenLabel(data.usage.inputTokens)} · 输出 ${tokenLabel(data.usage.outputTokens)} · 缓存读取 ${tokenLabel(data.usage.cacheReadInputTokens)} · 缓存写入 ${tokenLabel(data.usage.cacheCreationInputTokens)}`
    : "";
  const editable = !isGuest() && (conversation.ownerId === user.id || user.role === "admin");
  elements.rename.disabled = !editable;
  elements.archive.disabled = !editable;
  renderModelOptions(elements.conversationModel, conversation.modelProfileId);
  elements.conversationModel.disabled = !editable || !modelProfiles.length;
  elements.message.disabled = isGuest();
  autosizeMessage();
  elements.send.disabled = isGuest() || isSubmitting;
  elements.attachmentButton.disabled = isGuest() || isSubmitting;
  const messages = data.messages || [];
  const nextLast = messages.at(-1)?.id || null;
  const switchedConversation = renderedConversationId !== conversation.id;
  const nearBottom = elements.list.scrollHeight - elements.list.scrollTop - elements.list.clientHeight < 140;
  const preservingSelection = !switchedConversation && selectionTouches(elements.list);
  if (preservingSelection) {
    for (const message of messages) deferredMessageUpdates.set(message.id, message);
  } else {
    deferredMessageUpdates.clear();
    messageCache = new Map(messages.map((message) => [message.id, message]));
    elements.list.replaceChildren();
  }
  if (!messages.length && !preservingSelection) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const index = document.createElement("div"); index.className = "empty-index"; index.textContent = "01";
    const copy = document.createElement("div"); const heading = document.createElement("h2"); heading.textContent = "这条会话准备好了";
    const p = document.createElement("p"); p.textContent = conversation.visibility === "team" ? "团队成员都能看到这里的任务与回复。" : "消息仅你可见，但服务器文件工作区仍与团队共用。";
    copy.append(heading, p); empty.append(index, copy); elements.list.append(empty);
  } else if (!preservingSelection) for (const message of messages) elements.list.append(makeEntry(message));
  const pendingChoice = [...messages].reverse().find((message) => message.choice && !message.choice.answeredAt);
  if (activeChoiceMessage) {
    const refreshedChoice = messages.find((message) => message.id === activeChoiceMessage.id);
    if (activeChoiceMessage.conversationId !== conversation.id || !refreshedChoice || refreshedChoice.choice?.answeredAt) closeChoiceDialog();
  }
  if (!isGuest() && pendingChoice && pendingChoice.id !== lastPromptedChoiceId) {
    lastPromptedChoiceId = pendingChoice.id;
    requestAnimationFrame(() => openChoiceDialog(pendingChoice));
  }
  if (!preservingSelection && (switchedConversation || nearBottom || nextLast !== lastMessageId)) elements.list.scrollTop = elements.list.scrollHeight;
  renderedConversationId = conversation.id;
  if (!preservingSelection) lastMessageId = nextLast;
}

function renderRuntime(runtime = {}) {
  latestRuntime = runtime;
  const running = runtime.status === "running";
  const runningCount = runtime.runningCount ?? (running ? 1 : 0);
  elements.agentStatus.dataset.state = running ? "running" : "idle";
  elements.statusLabel.textContent = runningCount > 1 ? "Agent 并行工作中" : running ? "Agent 工作中" : "Agent 空闲";
  elements.runningCount.textContent = runningCount;
  elements.queueCount.textContent = runtime.queueCount ?? 0;
  elements.currentTaskLabel.textContent = !runtime.current ? ""
    : runtime.currentIsSelected
      ? (runtime.currentQueued ? "当前会话排队中" : "当前会话正在处理")
      : "运行中的一项任务";
  const canInterrupt = Boolean(runtime.currentIsSelected && runtime.currentCanInterrupt);
  elements.interruptButton.hidden = !canInterrupt;
  elements.interruptButton.disabled = interruptPending || Boolean(runtime.currentStopping);
  elements.interruptLabel.textContent = runtime.currentStopping || interruptPending
    ? (runtime.currentQueued ? "正在取消" : "正在停止")
    : (runtime.currentQueued ? "取消排队" : "停止运行");
  elements.currentTask.replaceChildren();
  if (runtime.current) {
    const strong = document.createElement("strong"); strong.textContent = runtime.current.title;
    const span = document.createElement("span"); span.textContent = `${runtime.current.name} · ${runtime.current.visibility === "team" ? "团队" : "私有"}`;
    elements.currentTask.className = "current-task-active"; elements.currentTask.append(strong, span);
  } else { elements.currentTask.className = "current-task-empty"; elements.currentTask.textContent = "暂无任务"; }
  elements.currentTask.parentElement.hidden = !runtime.current;
  renderOnlineMembers(runtime.onlineMembers || []);
  if (isGuest()) {
    elements.statusLabel.textContent = "演示模式 · 未运行任务";
    elements.onlineCount.textContent = "演示";
    elements.onlineMemberList.replaceChildren(emptyLabel("真实在线成员仅对获授权账号可见"));
  }
}

async function interruptCurrentTask() {
  if (!selectedId || interruptPending || !latestRuntime.currentIsSelected || !latestRuntime.currentCanInterrupt) return;
  interruptPending = true;
  elements.interruptButton.disabled = true;
  elements.interruptLabel.textContent = latestRuntime.currentQueued ? "正在取消" : "正在停止";
  setComposerStatus(latestRuntime.currentQueued ? "正在取消排队任务…" : "正在中断 Agent…");
  try {
    await api(`/api/conversations/${selectedId}/interrupt`, { method: "POST" });
    setComposerStatus(latestRuntime.currentQueued ? "排队任务已取消。" : "已发送中断请求。", "success");
  } catch (error) {
    setComposerStatus(error.message);
  } finally {
    interruptPending = false;
    elements.interruptButton.disabled = Boolean(latestRuntime.currentStopping);
    elements.interruptLabel.textContent = latestRuntime.currentStopping
      ? "正在停止"
      : (latestRuntime.currentQueued ? "取消排队" : "停止运行");
  }
}

function renderOnlineMembers(members) {
  elements.onlineCount.textContent = `${members.length} 人`;
  elements.onlineMemberList.replaceChildren();
  if (!members.length) {
    const empty = document.createElement("p"); empty.className = "presence-empty"; empty.textContent = "暂无在线成员";
    elements.onlineMemberList.append(empty);
    return;
  }
  for (const member of members) {
    const row = document.createElement("article"); row.className = "presence-row";
    const avatar = document.createElement("div"); avatar.className = "presence-avatar"; avatar.textContent = member.displayName.slice(0, 1).toUpperCase(); avatar.setAttribute("aria-hidden", "true");
    const identity = document.createElement("div"); identity.className = "presence-identity";
    const title = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = member.displayName; title.append(name);
    if (member.current) { const badge = document.createElement("span"); badge.textContent = "你"; title.append(badge); }
    const detail = document.createElement("small"); detail.textContent = `@${member.username}${member.role === "admin" ? " · 管理员" : ""}`;
    identity.append(title, detail);
    const state = document.createElement("span"); state.className = `presence-state ${member.activeTasks ? "busy" : ""}`; state.textContent = member.activeTasks ? "使用中" : "在线";
    row.append(avatar, identity, state);
    elements.onlineMemberList.append(row);
  }
}

function patchSequence(payload) {
  const value = payload?.sequence ?? payload?.seq ?? payload?.version ?? payload?.revision;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function eventSequenceValue(event, payload) {
  const payloadSequence = patchSequence(payload);
  if (payloadSequence !== null) return payloadSequence;
  const id = Number(event?.lastEventId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function selectionTouches(node) {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && (
    node.contains(selection.anchorNode) || node.contains(selection.focusNode)
  ));
}

function applyMessagePatch(payload) {
  const id = payload.messageId || payload.id || payload.message?.id || payload.messagePatch?.id;
  const incoming = payload.message || payload.messagePatch || payload.changes || payload.patch;
  if (!id || !incoming || typeof incoming !== "object") return false;
  const current = deferredMessageUpdates.get(id) || messageCache.get(id);
  if (!current && !incoming.role) return false;
  const next = { ...(current || {}), ...incoming, id };
  if (incoming.metrics && current?.metrics) next.metrics = { ...current.metrics, ...incoming.metrics };
  if (incoming.choice && current?.choice) next.choice = { ...current.choice, ...incoming.choice };
  const row = [...elements.list.querySelectorAll("[data-message-id]")].find((candidate) => candidate.dataset.messageId === id);
  if (row && selectionTouches(row)) {
    deferredMessageUpdates.set(id, next);
    return true;
  }
  deferredMessageUpdates.delete(id);
  messageCache.set(id, next);
  if (!row) {
    elements.list.querySelector(".empty-state")?.remove();
    elements.list.append(makeEntry(next));
    lastMessageId = id;
    elements.list.scrollTop = elements.list.scrollHeight;
    return true;
  }
  const nearBottom = elements.list.scrollHeight - elements.list.scrollTop - elements.list.clientHeight < 140;
  const details = row.querySelector("details");
  const replacement = makeEntry(next);
  if (details) replacement.querySelector("details")?.toggleAttribute("open", details.open);
  row.replaceWith(replacement);
  lastMessageId = id;
  if (nearBottom) elements.list.scrollTop = elements.list.scrollHeight;
  return true;
}

function applyPatch(payload, sequenceOverride = null) {
  if (!payload || (payload.conversationId && payload.conversationId !== selectedId)) return;
  const sequence = sequenceOverride ?? patchSequence(payload);
  if (sequence !== null && sequence <= eventSequence) return;
  if (sequence !== null) eventSequence = sequence;
  if (payload.state) return renderState(payload.state);
  if (payload.messages && Array.isArray(payload.messages)) {
    for (const message of payload.messages) messageCache.set(message.id, message);
    const last = payload.messages.at(-1);
    if (last) return applyMessagePatch({ message: last, messageId: last.id });
  }
  const patched = applyMessagePatch(payload);
  if (patched) return;
  if (payload.runtime) renderRuntime({ ...latestRuntime, ...payload.runtime });
}

function connectEvents(generation = conversationGeneration) {
  eventSource?.close();
  if (isGuest()) {
    eventSource = null;
    elements.connection.textContent = "游客演示 · 只读";
    return;
  }
  elements.connection.textContent = "连接中"; elements.connection.classList.remove("connected");
  const query = selectedId ? `?conversationId=${encodeURIComponent(selectedId)}` : "";
  const source = new EventSource(`${appBasePath}/api/events${query}`);
  eventSource = source;
  eventSource.onmessage = (event) => {
    if (generation !== conversationGeneration || source !== eventSource) return;
    elements.connection.textContent = "已连接"; elements.connection.classList.add("connected");
    const payload = JSON.parse(event.data);
    const sequence = eventSequenceValue(event, payload);
    if (sequence !== null && sequence <= eventSequence) return;
    if (sequence !== null) eventSequence = sequence;
    renderState(payload);
  };
  source.addEventListener("patch", (event) => {
    if (generation !== conversationGeneration || source !== eventSource) return;
    try {
      const payload = JSON.parse(event.data);
      const sequence = eventSequenceValue(event, payload);
      applyPatch(payload, sequence);
    } catch { /* ignore malformed incremental updates; full state will recover */ }
  });
  source.addEventListener("revoked", (event) => {
    if (generation !== conversationGeneration || source !== eventSource) return;
    user = null; csrfToken = ""; selectedId = null;
    showAuth();
    elements.authError.textContent = JSON.parse(event.data).message || "账号已被管理员注销。";
  });
  source.onerror = () => {
    if (generation !== conversationGeneration || source !== eventSource) return;
    elements.connection.textContent = "重连中"; elements.connection.classList.remove("connected");
  };
}

function renderTags(container, values, emptyText) {
  container.replaceChildren();
  if (!values.length) { const span = document.createElement("span"); span.className = "muted-tag"; span.textContent = emptyText; container.append(span); return; }
  for (const value of values) { const span = document.createElement("span"); span.textContent = value; container.append(span); }
}

function slashRange() {
  const cursor = elements.message.selectionStart;
  const before = elements.message.value.slice(0, cursor);
  const match = before.match(/(^|\s)(\/[^\s]*)$/);
  if (!match) return null;
  const token = match[2];
  return { start: cursor - token.length, end: cursor, query: token.toLowerCase() };
}

function closeCommandMenu() {
  elements.commandMenu.hidden = true;
  elements.message.setAttribute("aria-expanded", "false");
  elements.message.removeAttribute("aria-activedescendant");
}

function positionCommandMenu() {
  if (elements.commandMenu.hidden) return;
  const rect = elements.message.getBoundingClientRect();
  const width = Math.min(rect.width, 560, window.innerWidth - 20);
  const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
  elements.commandMenu.style.width = `${width}px`;
  elements.commandMenu.style.left = `${left}px`;
  elements.commandMenu.style.top = "auto";
  elements.commandMenu.style.bottom = `${Math.max(10, window.innerHeight - rect.top + 7)}px`;
}

function setCommandIndex(next) {
  if (!filteredCommands.length) return;
  commandIndex = (next + filteredCommands.length) % filteredCommands.length;
  const options = [...elements.commandOptions.querySelectorAll(".command-option")];
  options.forEach((option, index) => { option.dataset.active = String(index === commandIndex); });
  const active = options[commandIndex];
  if (active) {
    elements.message.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
}

function completeCommand(command = filteredCommands[commandIndex]) {
  const range = slashRange();
  if (!range || !command) return;
  const value = elements.message.value;
  elements.message.value = `${value.slice(0, range.start)}${command.value} ${value.slice(range.end)}`;
  autosizeMessage();
  const cursor = range.start + command.value.length + 1;
  elements.message.setSelectionRange(cursor, cursor);
  closeCommandMenu();
  elements.message.focus();
}

function autosizeMessage() {
  const field = elements.message;
  field.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(field).maxHeight);
  const nextHeight = Math.min(field.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : field.scrollHeight);
  field.style.height = `${nextHeight}px`;
  field.style.overflowY = field.scrollHeight > nextHeight ? "auto" : "hidden";
}

function renderCommandMenu() {
  const range = slashRange();
  if (!range || elements.message.disabled) return closeCommandMenu();
  filteredCommands = availableCommands.filter((command) => {
    const haystack = `${command.value} ${command.description} ${command.category}`.toLowerCase();
    return haystack.includes(range.query);
  });
  commandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));
  elements.commandOptions.replaceChildren();
  if (!filteredCommands.length) {
    const empty = document.createElement("p");
    empty.className = "command-empty";
    empty.textContent = availableCommands.length ? "没有匹配的命令，继续输入可缩小范围。" : "命令列表正在读取，请稍候。";
    elements.commandOptions.append(empty);
  } else {
    filteredCommands.forEach((command, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `command-option-${index}`;
      option.className = "command-option";
      option.setAttribute("role", "option");
      option.dataset.active = String(index === commandIndex);
      const code = document.createElement("code"); code.textContent = command.value;
      const description = document.createElement("span"); description.textContent = command.description;
      const category = document.createElement("small"); category.textContent = command.category;
      option.append(code, description, category);
      option.addEventListener("mousemove", () => setCommandIndex(index));
      option.addEventListener("mousedown", (event) => { event.preventDefault(); completeCommand(command); });
      elements.commandOptions.append(option);
    });
  }
  elements.commandMenu.hidden = false;
  elements.message.setAttribute("aria-expanded", "true");
  positionCommandMenu();
  setCommandIndex(commandIndex);
}

async function loadCapabilities() {
  try {
    const data = await api("/api/capabilities");
    capabilitySnapshot = data;
    availableCommands = data.commands || [];
    renderCommandMenu();
    renderTags(elements.settingsMcpList, data.mcp || [], "尚未配置 MCP");
    renderTags(elements.settingsAgentList, data.subagents || [], "尚未配置 Subagent");
  } catch { availableCommands = []; }
}

function setInlineStatus(element, text = "", state = "") {
  element.textContent = text;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function actionButton(label, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(button); } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}

function settingsRow({ title, description, badges = [], meta = [], actions = [] }) {
  const row = document.createElement("article"); row.className = "settings-row";
  const main = document.createElement("div"); main.className = "settings-row-main";
  const titleLine = document.createElement("div"); titleLine.className = "settings-row-title";
  const strong = document.createElement("strong"); strong.textContent = title; titleLine.append(strong);
  for (const badge of badges) { const span = document.createElement("span"); span.className = `row-badge ${badge.kind || ""}`; span.textContent = badge.text; titleLine.append(span); }
  main.append(titleLine);
  if (description) { const p = document.createElement("p"); p.textContent = description; main.append(p); }
  if (meta.length) { const wrap = document.createElement("div"); wrap.className = "settings-row-meta"; for (const value of meta) { const span = document.createElement("span"); span.textContent = value; wrap.append(span); } main.append(wrap); }
  const controls = document.createElement("div"); controls.className = "row-actions"; controls.append(...actions);
  row.append(main, controls);
  return row;
}

function emptySettings(text) {
  const p = document.createElement("p"); p.className = "empty-settings"; p.textContent = text; return p;
}

function openModelEditor(profile) {
  const form = elements.modelEditForm;
  form.elements.id.value = profile.id;
  form.elements.name.value = profile.name;
  form.elements.baseUrl.value = profile.baseUrl;
  form.elements.model.value = profile.model;
  form.elements.smallModel.value = profile.smallModel;
  form.elements.authToken.value = "";
  setInlineStatus(elements.modelEditStatus);
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function patchModel(profile, patch) {
  await api(`/api/admin/model-profiles/${profile.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  await Promise.all([loadAdminModels(), loadModelProfiles(), loadConversations()]);
}

function renderAdminModels() {
  elements.modelCount.textContent = `${adminModelProfiles.length} 个`;
  elements.modelList.replaceChildren();
  if (!adminModelProfiles.length) return elements.modelList.append(emptySettings("尚未配置模型。"));
  for (const profile of adminModelProfiles) {
    const actions = [actionButton("测试", async (button) => {
      button.textContent = "测试中…";
      try { const result = await api(`/api/admin/model-profiles/${profile.id}/test`, { method: "POST" }); button.textContent = result.message; }
      finally { setTimeout(() => { button.textContent = "测试"; }, 1800); }
    }), actionButton("编辑", () => openModelEditor(profile))];
    if (!profile.isDefault && profile.enabled) actions.push(actionButton("设为默认", () => patchModel(profile, { isDefault: true })));
    actions.push(actionButton(profile.enabled ? "停用" : "启用", () => patchModel(profile, { enabled: !profile.enabled }), profile.enabled ? "danger" : ""));
    elements.modelList.append(settingsRow({
      title: profile.name,
      description: `${profile.baseUrl} · ${profile.model}`,
      badges: [
        ...(profile.isDefault ? [{ text: "默认", kind: "default" }] : []),
        ...(!profile.enabled ? [{ text: "已停用", kind: "disabled" }] : []),
      ],
      meta: [`轻量模型 ${profile.smallModel}`, profile.credentialMode === "system" ? "沿用服务器密钥" : "独立密钥已保存"],
      actions,
    }));
  }
}

async function loadAdminModels() {
  const data = await api("/api/admin/model-profiles");
  adminModelProfiles = data.profiles || [];
  renderAdminModels();
}

async function mutateAccount(userId, patch) {
  await api(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  await loadAdminAccounts();
}

function renderAdminAccounts(data) {
  const pending = data.pendingRequests || [];
  const users = data.users || [];
  elements.pendingAccountCount.textContent = `${pending.length} 个`;
  elements.pendingAccountCount.className = `count-badge ${pending.length ? "warning" : "success"}`;
  elements.accountCount.textContent = `${users.length} 个`;
  elements.pendingAccountList.replaceChildren();
  elements.managedAccountList.replaceChildren();

  if (!pending.length) elements.pendingAccountList.append(emptySettings("暂无待审批的注册申请。"));
  for (const request of pending) {
    const approve = actionButton("批准注册", async () => {
      await api(`/api/admin/registration-requests/${request.id}`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
      await loadAdminAccounts();
    });
    const reject = actionButton("拒绝", async () => {
      if (!confirm(`拒绝 @${request.username} 的注册申请？对方可以修改资料后重新提交。`)) return;
      await api(`/api/admin/registration-requests/${request.id}`, { method: "POST", body: JSON.stringify({ action: "reject" }) });
      await loadAdminAccounts();
    }, "danger");
    elements.pendingAccountList.append(settingsRow({
      title: request.displayName,
      description: `@${request.username}`,
      badges: [{ text: "待审批", kind: "warning" }],
      meta: [`${timeLabel(request.createdAt)} 提交`, "密码已加密保存"],
      actions: [approve, reject],
    }));
  }

  if (!users.length) elements.managedAccountList.append(emptySettings("尚无已注册账号。"));
  for (const account of users) {
    const isCurrent = account.id === user.id;
    const isProtected = account.id === data.protectedUserId;
    const badges = [
      { text: account.role === "admin" ? "管理员" : "成员", kind: account.role === "admin" ? "default" : "" },
      ...(account.disabled ? [{ text: "已注销", kind: "disabled" }] : []),
      ...(isCurrent ? [{ text: "当前账号" }] : []),
      ...(isProtected ? [{ text: "团队身份所有者" }] : []),
    ];
    const actions = [];
    if (!isCurrent && !isProtected) {
      if (account.disabled) {
        actions.push(actionButton("恢复账号", () => mutateAccount(account.id, { disabled: false })));
      } else {
        const nextRole = account.role === "admin" ? "member" : "admin";
        actions.push(actionButton(account.role === "admin" ? "移除管理员" : "设为管理员", async () => {
          const prompt = nextRole === "admin"
            ? `将 ${account.displayName} 设为管理员？对方将能管理模型、记忆、能力和账号。`
            : `移除 ${account.displayName} 的管理员权限？`;
          if (confirm(prompt)) await mutateAccount(account.id, { role: nextRole });
        }));
        actions.push(actionButton("注销账号", async () => {
          if (confirm(`注销 ${account.displayName}（@${account.username}）？该账号会立即退出，历史会话和审计记录会保留。`)) {
            await mutateAccount(account.id, { disabled: true });
          }
        }, "danger"));
      }
    }
    elements.managedAccountList.append(settingsRow({
      title: account.displayName,
      description: `@${account.username}`,
      badges,
      meta: [
        `${account.conversationCount} 条会话`,
        account.lastLoginAt ? `${timeLabel(account.lastLoginAt)} 最近登录` : "尚未登录",
        `${timeLabel(account.createdAt)} 注册`,
      ],
      actions,
    }));
  }
}

async function loadAdminAccounts() {
  elements.refreshAccounts.disabled = true;
  setInlineStatus(elements.accountsStatus, "正在读取账号…");
  try {
    renderAdminAccounts(await api("/api/admin/accounts"));
    setInlineStatus(elements.accountsStatus);
  } catch (error) { setInlineStatus(elements.accountsStatus, error.message, "error"); }
  finally { elements.refreshAccounts.disabled = false; }
}

function byteLabel(value) {
  const bytes = Number(value || 0);
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function setMemoryView(mode) {
  const previewing = mode === "preview";
  elements.memoryEditor.hidden = previewing;
  elements.memoryPreview.hidden = !previewing;
  elements.memoryEditMode.setAttribute("aria-pressed", String(!previewing));
  elements.memoryPreviewMode.setAttribute("aria-pressed", String(previewing));
  if (previewing) {
    elements.memoryPreview.replaceChildren();
    renderAssistantContent(elements.memoryPreview, elements.memoryEditor.value);
  }
}

function renderMemoryConfiguration(data) {
  memorySnapshot = data;
  memoryDirty = false;
  elements.memoryStateBadge.textContent = data.autoMemory.enabled ? "自动记忆已启用" : "自动记忆已停用";
  elements.memoryStateBadge.className = `count-badge ${data.autoMemory.enabled ? "success" : "warning"}`;
  elements.claudeMdPath.textContent = data.claudeMd.path;
  elements.memoryDirectory.textContent = data.autoMemory.directory;
  elements.memoryBudget.textContent = `${data.autoMemory.indexBudget} · ${data.autoMemory.files.length} 个 Markdown 文件`;
  elements.memoryEditor.value = data.claudeMd.content;
  elements.claudeMdCount.textContent = String(data.claudeMd.content.length);
  elements.claudeMdUpdated.textContent = data.claudeMd.updatedAt ? `${timeLabel(data.claudeMd.updatedAt)} 保存 · ${byteLabel(data.claudeMd.bytes)}` : "尚未创建";
  elements.memoryFileCount.textContent = `${data.autoMemory.files.length} 个`;
  elements.memoryFileList.replaceChildren();
  if (!data.autoMemory.files.length) elements.memoryFileList.append(emptySettings("尚未生成记忆文件。"));
  for (const file of data.autoMemory.files) {
    const category = data.autoMemory.categories.find((item) => item.name === file.category);
    elements.memoryFileList.append(settingsRow({
      title: file.path,
      description: category?.description || "自动加载的记忆索引",
      badges: [{ text: file.category === "index" ? "索引" : file.category }],
      meta: [byteLabel(file.bytes), `${timeLabel(file.updatedAt)} 更新`],
    }));
  }
  setMemoryView("edit");
}

async function loadMemoryConfiguration({ confirmDiscard = false } = {}) {
  if (confirmDiscard && memoryDirty && !confirm("放弃尚未保存的 CLAUDE.md 修改并重新载入？")) return;
  setInlineStatus(elements.memoryStatus, "正在读取服务器配置…");
  try {
    renderMemoryConfiguration(await api("/api/admin/memory"));
    setInlineStatus(elements.memoryStatus);
  } catch (error) { setInlineStatus(elements.memoryStatus, error.message, "error"); }
}

async function loadAdminSkills() {
  const data = await api("/api/admin/skills");
  const skills = data.skills || [];
  elements.skillCount.textContent = `${skills.length} 个`;
  elements.managedSkillList.replaceChildren();
  if (!skills.length) return elements.managedSkillList.append(emptySettings("尚未安装服务器 Skill。"));
  for (const skill of skills) {
    const actions = skill.removable ? [actionButton("删除", async () => {
      if (!confirm(`删除 Skill “${skill.name}”？这个动作不可撤销。`)) return;
      await api(`/api/admin/skills/${encodeURIComponent(skill.slug)}`, { method: "DELETE" });
      await Promise.all([loadAdminSkills(), loadCapabilities()]);
    }, "danger")] : [];
    elements.managedSkillList.append(settingsRow({
      title: skill.name, description: skill.description,
      badges: [{ text: skill.scope }], meta: [`/${skill.slug}`, skill.removable ? "管理员安装" : "项目内置"], actions,
    }));
  }
}

function pluginName(plugin) {
  if (typeof plugin === "string") return plugin;
  return plugin.id || plugin.plugin || plugin.name || plugin.fullName || "unknown-plugin";
}

function pluginDescription(plugin) {
  if (typeof plugin === "string") return "Claude Code Plugin";
  return plugin.description || plugin.summary || [plugin.version && `v${plugin.version}`, plugin.marketplace].filter(Boolean).join(" · ") || "Claude Code Plugin";
}

function marketplaceNames(values) {
  return (values || []).map((item) => typeof item === "string" ? item : item.name || item.id || item.source).filter(Boolean);
}

function renderPluginRows(container, plugins, { installed = false } = {}) {
  container.replaceChildren();
  if (!plugins.length) return container.append(emptySettings(installed ? "尚未安装 Plugin。" : "添加 Marketplace 后，这里会显示可安装的 Plugin。"));
  for (const plugin of plugins) {
    const id = pluginName(plugin);
    const enabled = typeof plugin === "object" ? plugin.enabled !== false && plugin.status !== "disabled" : true;
    const actions = installed
      ? [
          actionButton(enabled ? "停用" : "启用", () => runPluginAction(enabled ? "disable" : "enable", id)),
          actionButton("更新", () => runPluginAction("update", id)),
          actionButton("卸载", async () => { if (confirm(`卸载 Plugin “${id}”？`)) await runPluginAction("uninstall", id); }, "danger"),
        ]
      : [actionButton("安装", () => runPluginAction("install", id))];
    container.append(settingsRow({
      title: id, description: pluginDescription(plugin),
      badges: installed ? [{ text: enabled ? "已启用" : "已停用", kind: enabled ? "default" : "disabled" }] : [],
      meta: typeof plugin === "object" ? [plugin.marketplace, plugin.version].filter(Boolean) : [], actions,
    }));
  }
}

function renderPlugins(data) {
  const installed = Array.isArray(data.installed) ? data.installed : data.installed?.plugins || [];
  const availableRaw = Array.isArray(data.available) ? data.available : data.available?.plugins || [];
  const installedNames = new Set(installed.map(pluginName));
  const available = availableRaw.filter((item) => !installedNames.has(pluginName(item)));
  renderTags(elements.marketplaceList, marketplaceNames(data.marketplaces), "尚未添加 Marketplace");
  renderPluginRows(elements.installedPluginList, installed, { installed: true });
  renderPluginRows(elements.availablePluginList, available);
}

async function loadPlugins() {
  elements.refreshPlugins.disabled = true;
  elements.installedPluginList.replaceChildren(emptySettings("正在读取 Plugin…"));
  try { renderPlugins(await api("/api/admin/plugins")); }
  catch (error) { elements.installedPluginList.replaceChildren(emptySettings(error.message)); }
  finally { elements.refreshPlugins.disabled = false; }
}

async function runPluginAction(action, plugin) {
  renderPlugins(await api("/api/admin/plugins/actions", { method: "POST", body: JSON.stringify({ action, plugin }) }));
  await loadCapabilities();
}

async function openManagement() {
  if (user?.role !== "admin") return;
  closeDrawers();
  elements.appShell.hidden = true;
  elements.managementScreen.hidden = false;
  await Promise.all([loadAdminAccounts(), loadAdminModels(), loadMemoryConfiguration(), loadAdminSkills(), ...(deploymentFeatures.plugins ? [loadPlugins()] : []), loadCapabilities()]);
}

function closeManagement() {
  if (memoryDirty && !confirm("CLAUDE.md 还有未保存的修改，仍要返回会话吗？")) return;
  elements.managementScreen.hidden = true;
  elements.appShell.hidden = false;
}

function selectSettingsTab(name) {
  for (const button of document.querySelectorAll("[data-settings-tab]")) button.setAttribute("aria-current", button.dataset.settingsTab === name ? "page" : "false");
  for (const panel of document.querySelectorAll("[data-settings-panel]")) panel.hidden = panel.dataset.settingsPanel !== name;
}

async function initialize() {
  const data = await api("/api/bootstrap");
  if (!data.allowRegistration) elements.registerTab.hidden = true;
  elements.guestButton.hidden = data.allowGuest !== true;
  deploymentFeatures = data.features || deploymentFeatures;
  if (!deploymentFeatures.lark) {
    document.querySelector("#lark-button").hidden = true;
    elements.larkRoute.hidden = true;
  }
  if (!deploymentFeatures.plugins) document.querySelector('[data-settings-tab="plugins"]').hidden = true;
  if (!data.authenticated) return showAuth();
  user = data.user; csrfToken = data.csrfToken; showApp();
  selectedId = localStorage.getItem(isGuest() ? "agent-guest-conversation" : "agent-selected-conversation");
  await Promise.all([loadConversations(), loadCapabilities(), loadModelProfiles()]);
  if (selectedId) await selectConversation(selectedId).catch(() => { selectedId = null; renderNoConversation(); });
}

elements.loginTab.addEventListener("click", () => setAuthMode("login"));
elements.registerTab.addEventListener("click", () => setAuthMode("register"));
elements.guestButton.addEventListener("click", async () => {
  elements.guestButton.disabled = true;
  elements.authError.textContent = "";
  elements.authError.dataset.state = "";
  try {
    const data = await api("/api/auth/guest", { method: "POST" });
    user = data.user;
    csrfToken = data.csrfToken;
    selectedId = null;
    elements.password.value = "";
    showApp();
    await Promise.all([loadConversations(), loadCapabilities(), loadModelProfiles()]);
  } catch (error) {
    if (isGuest()) showAuth();
    elements.authError.textContent = error.message;
  } finally { elements.guestButton.disabled = false; }
});
elements.guestLogin.addEventListener("click", async () => {
  elements.guestLogin.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    showAuth();
    setAuthMode("login");
    elements.username.focus();
  } catch (error) { elements.formError.textContent = error.message; }
  finally { elements.guestLogin.disabled = false; }
});
elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); elements.authError.textContent = ""; elements.authError.dataset.state = ""; elements.authSubmit.disabled = true;
  try {
    const data = await api(`/api/auth/${authMode}`, { method: "POST", body: JSON.stringify({ username: elements.username.value, password: elements.password.value, displayName: elements.displayName.value }) });
    if (authMode === "register") {
      elements.password.value = "";
      elements.authError.textContent = data.message;
      elements.authError.dataset.state = "success";
      return;
    }
    user = data.user; csrfToken = data.csrfToken; elements.password.value = ""; showApp(); await Promise.all([loadConversations(), loadCapabilities(), loadModelProfiles()]);
  } catch (error) { elements.authError.textContent = error.message; }
  finally { elements.authSubmit.disabled = false; }
});
elements.newButton.addEventListener("click", () => { elements.newForm.hidden = !elements.newForm.hidden; if (!elements.newForm.hidden) elements.newTitle.focus(); });
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll(".account-menu, .conversation-actions")) {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  }
});
elements.sessionSearch.addEventListener("input", renderConversationLists);
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.altKey) return;
  if (elements.appShell.hidden || !elements.managementScreen.hidden || !elements.larkScreen.hidden) return;
  event.preventDefault();
  if (window.innerWidth <= 900) openDrawer(elements.sessionPanel);
  elements.sessionSearch.focus();
  elements.sessionSearch.select();
});
elements.cancelNew.addEventListener("click", () => { elements.newForm.hidden = true; });
elements.newForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const visibility = new FormData(elements.newForm).get("visibility");
  const modelProfileId = elements.newModel.value;
  try { const data = await api("/api/conversations", { method: "POST", body: JSON.stringify({ title: elements.newTitle.value, visibility, modelProfileId }) }); elements.newForm.hidden = true; elements.newTitle.value = "新会话"; await loadConversations(); await selectConversation(data.conversation.id); }
  catch (error) { setComposerStatus(error.message); }
});
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedId || isSubmitting) return;
  closeCommandMenu();
  const text = elements.message.value.trim(); if (!text && !pendingAttachments.length) return;
  isSubmitting = true; elements.send.disabled = true; elements.attachmentButton.disabled = true; setComposerStatus(); renderAttachments();
  const conversationId = selectedId;
  try {
    for (const item of pendingAttachments) {
      if (item.remote) continue;
      item.uploading = true; renderAttachments();
      const result = await api(`/api/conversations/${conversationId}/attachments?filename=${encodeURIComponent(item.file.name)}`, {
        method: "POST", body: item.file, headers: { "Content-Type": item.file.type || "application/octet-stream" },
      });
      item.remote = result.attachment; item.uploading = false; renderAttachments();
    }
    const attachmentIds = pendingAttachments.map((item) => item.remote.id);
    await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text, attachmentIds }) });
    elements.message.value = ""; autosizeMessage(); pendingAttachments = []; pendingConversationId = null; elements.attachmentInput.value = ""; renderAttachments();
    await loadConversations();
  }
  catch (error) { setComposerStatus(error.message); }
  finally {
    isSubmitting = false;
    for (const item of pendingAttachments) item.uploading = false;
    elements.send.disabled = !selectedId; elements.attachmentButton.disabled = !selectedId; renderAttachments(); elements.message.focus();
  }
});
elements.attachmentButton.addEventListener("click", () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener("change", () => {
  const files = [...elements.attachmentInput.files];
  addPendingFiles(files);
  elements.attachmentInput.value = "";
});
elements.messageDropZone.addEventListener("dragenter", (event) => {
  if (isSubmitting || elements.message.disabled || !dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  setDropActive(true);
});
elements.messageDropZone.addEventListener("dragover", (event) => {
  if (isSubmitting || elements.message.disabled || !dragHasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
elements.messageDropZone.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDropActive(false);
});
elements.messageDropZone.addEventListener("drop", (event) => {
  if (isSubmitting || elements.message.disabled || !dragHasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const files = [...(event.dataTransfer?.files || [])];
  resetDropState();
  if (files.length) addPendingFiles(files, { source: "drop" });
});
document.addEventListener("dragend", resetDropState);
window.addEventListener("blur", resetDropState);
elements.message.addEventListener("paste", (event) => {
  if (isSubmitting || elements.message.disabled) return;
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const rawFiles = itemFiles.length ? itemFiles : [...(event.clipboardData?.files || [])];
  if (!rawFiles.length) return;
  event.preventDefault();
  const files = rawFiles.map((file, index) => normalizeClipboardFile(file, index));
  addPendingFiles(files, { source: "clipboard" });
});
elements.message.addEventListener("input", () => { autosizeMessage(); renderCommandMenu(); });
elements.message.addEventListener("click", renderCommandMenu);
elements.message.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  const menuOpen = !elements.commandMenu.hidden;
  if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    setCommandIndex(commandIndex + (event.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && filteredCommands.length) {
    event.preventDefault();
    completeCommand();
    return;
  }
  if (menuOpen && event.key === "Escape") {
    event.preventDefault();
    closeCommandMenu();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  elements.form.requestSubmit();
});
elements.interruptButton.addEventListener("click", interruptCurrentTask);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
  if (!elements.choicePanel.hidden) {
    event.preventDefault();
    closeChoiceDialog();
    return;
  }
  if (!elements.managementScreen.hidden || !elements.larkScreen.hidden) return;
  if (elements.messageDropZone.dataset.dropActive === "true") {
    event.preventDefault();
    resetDropState();
    return;
  }
  if (elements.interruptButton.hidden || elements.interruptButton.disabled) return;
  event.preventDefault();
  void interruptCurrentTask();
});
elements.message.addEventListener("blur", () => setTimeout(closeCommandMenu, 120));
window.addEventListener("resize", positionCommandMenu);
window.addEventListener("resize", autosizeMessage);
window.addEventListener("scroll", positionCommandMenu, true);
elements.rename.addEventListener("click", async () => {
  elements.rename.closest("details").open = false;
  const conversation = conversations.find((item) => item.id === selectedId); if (!conversation) return;
  const title = prompt("新的会话名称", conversation.title); if (!title?.trim()) return;
  try { await api(`/api/conversations/${selectedId}`, { method: "PATCH", body: JSON.stringify({ title }) }); await loadConversations(); await selectConversation(selectedId); }
  catch (error) { setComposerStatus(error.message); }
});
elements.archive.addEventListener("click", async () => {
  elements.archive.closest("details").open = false;
  if (!selectedId || !confirm("归档这条会话？记录会保留在服务器数据库中，但不再显示。")) return;
  try { await discardPendingAttachments(); await api(`/api/conversations/${selectedId}`, { method: "DELETE" }); selectedId = null; localStorage.removeItem("agent-selected-conversation"); await loadConversations(); }
  catch (error) { setComposerStatus(error.message); }
});
elements.conversationModel.addEventListener("change", async () => {
  if (!selectedId || !elements.conversationModel.value) return;
  elements.conversationModel.disabled = true;
  try {
    await api(`/api/conversations/${selectedId}`, { method: "PATCH", body: JSON.stringify({ modelProfileId: elements.conversationModel.value }) });
    await loadConversations();
    await selectConversation(selectedId);
  } catch (error) { setComposerStatus(error.message); }
});
elements.manage.addEventListener("click", () => openManagement().catch((error) => alert(error.message)));
elements.larkButton.addEventListener("click", () => openLarkScreen().catch((error) => alert(error.message)));
elements.closeManagement.addEventListener("click", closeManagement);
elements.closeLark.addEventListener("click", closeLarkScreen);
elements.refreshLark.addEventListener("click", loadLarkStatus);
elements.startLarkAuth.addEventListener("click", async () => {
  elements.startLarkAuth.disabled = true;
  setInlineStatus(elements.larkStatus, "正在创建飞书授权请求…");
  try {
    const data = await api("/api/lark/auth/start", { method: "POST" });
    elements.larkAuthLink.href = data.verificationUrl;
    elements.larkAuthLink.textContent = data.verificationUrl;
    elements.larkAuthQr.src = data.qrDataUrl;
    const minutes = Math.max(1, Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 60_000));
    elements.larkAuthExpiry.textContent = `约 ${minutes} 分钟内有效`;
    elements.larkAuthFlow.hidden = false;
    setInlineStatus(elements.larkStatus, "请在飞书完成授权后点击确认", "success");
    elements.larkAuthFlow.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) { setInlineStatus(elements.larkStatus, error.message, "error"); }
  finally { elements.startLarkAuth.disabled = false; }
});
elements.completeLarkAuth.addEventListener("click", async () => {
  elements.completeLarkAuth.disabled = true;
  setInlineStatus(elements.larkStatus, "正在接收并验证授权…");
  try {
    renderLarkStatus(await api("/api/lark/auth/complete", { method: "POST" }));
    elements.larkAuthFlow.hidden = true;
    setInlineStatus(elements.larkStatus, "飞书个人授权已生效", "success");
  } catch (error) { setInlineStatus(elements.larkStatus, error.message, "error"); }
  finally { elements.completeLarkAuth.disabled = false; }
});
elements.logoutLarkAuth.addEventListener("click", async () => {
  if (!confirm("注销你的飞书个人授权？私有会话将无法访问你的飞书资源。")) return;
  elements.logoutLarkAuth.disabled = true;
  try { renderLarkStatus(await api("/api/lark/auth/logout", { method: "POST" })); setInlineStatus(elements.larkStatus, "个人授权已注销", "success"); }
  catch (error) { setInlineStatus(elements.larkStatus, error.message, "error"); }
  finally { elements.logoutLarkAuth.disabled = false; }
});
for (const button of document.querySelectorAll("[data-settings-tab]")) button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
elements.refreshAccounts.addEventListener("click", loadAdminAccounts);
elements.cancelChoice.addEventListener("click", closeChoiceDialog);
elements.deferChoice.addEventListener("click", closeChoiceDialog);
elements.choiceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeChoiceMessage) return;
  const customInput = elements.choiceOptions.querySelector('input[data-custom="true"]');
  const customText = elements.choiceOptions.querySelector('[name="custom-answer"]').value.trim();
  const customAnswer = customInput.checked ? customText : "";
  const values = [...elements.choiceOptions.querySelectorAll("input:checked")].filter((input) => input !== customInput).map((input) => input.value);
  if (customInput.checked && !customAnswer) { elements.choiceError.textContent = "请填写自己的回答，或选择其他选项。"; elements.choiceOptions.querySelector('[name="custom-answer"]').focus(); return; }
  if (!values.length && !customAnswer) { elements.choiceError.textContent = "请选择一项，或填写自己的回答。"; return; }
  const button = elements.choiceForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/conversations/${activeChoiceMessage.conversationId}/choices/${activeChoiceMessage.id}`, { method: "POST", body: JSON.stringify({ values, customAnswer }) });
    closeChoiceDialog();
  } catch (error) { elements.choiceError.textContent = error.message; }
  finally { button.disabled = false; }
});

elements.memoryEditor.addEventListener("input", () => {
  memoryDirty = elements.memoryEditor.value !== (memorySnapshot?.claudeMd.content || "");
  elements.claudeMdCount.textContent = String(elements.memoryEditor.value.length);
  setInlineStatus(elements.memoryStatus, memoryDirty ? "有尚未保存的修改" : "");
});
elements.memoryEditMode.addEventListener("click", () => setMemoryView("edit"));
elements.memoryPreviewMode.addEventListener("click", () => setMemoryView("preview"));
elements.reloadMemory.addEventListener("click", () => loadMemoryConfiguration({ confirmDiscard: true }));
elements.memoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.memoryForm.querySelector("button[type='submit']");
  button.disabled = true;
  setInlineStatus(elements.memoryStatus, "正在保存并生成上一版备份…");
  try {
    renderMemoryConfiguration(await api("/api/admin/memory/claude-md", { method: "PUT", body: JSON.stringify({ content: elements.memoryEditor.value }) }));
    setInlineStatus(elements.memoryStatus, "已保存；新任务将读取这个版本", "success");
  } catch (error) { setInlineStatus(elements.memoryStatus, error.message, "error"); }
  finally { button.disabled = false; }
});

elements.modelCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.modelCreateForm.querySelector("button[type='submit']");
  const data = Object.fromEntries(new FormData(elements.modelCreateForm));
  data.isDefault = new FormData(elements.modelCreateForm).has("isDefault");
  button.disabled = true; setInlineStatus(elements.modelCreateStatus, "正在保存…");
  try {
    await api("/api/admin/model-profiles", { method: "POST", body: JSON.stringify(data) });
    elements.modelCreateForm.reset();
    elements.modelCreateForm.closest("details").open = false;
    setInlineStatus(elements.modelCreateStatus, "已保存", "success");
    await Promise.all([loadAdminModels(), loadModelProfiles()]);
  } catch (error) { setInlineStatus(elements.modelCreateStatus, error.message, "error"); }
  finally { button.disabled = false; }
});
elements.modelEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.modelEditForm.querySelector("button[type='submit']");
  const data = Object.fromEntries(new FormData(elements.modelEditForm));
  const id = data.id; delete data.id;
  if (!data.authToken) delete data.authToken;
  button.disabled = true; setInlineStatus(elements.modelEditStatus, "正在保存…");
  try {
    await api(`/api/admin/model-profiles/${id}`, { method: "PATCH", body: JSON.stringify(data) });
    setInlineStatus(elements.modelEditStatus, "修改已保存", "success");
    await Promise.all([loadAdminModels(), loadModelProfiles(), loadConversations()]);
  } catch (error) { setInlineStatus(elements.modelEditStatus, error.message, "error"); }
  finally { button.disabled = false; }
});
elements.cancelModelEdit.addEventListener("click", () => { elements.modelEditForm.hidden = true; setInlineStatus(elements.modelEditStatus); });

async function submitSkillForm(form, source) {
  const status = form.querySelector(".inline-status");
  const button = form.querySelector("button[type='submit']");
  const data = { ...Object.fromEntries(new FormData(form)), source };
  button.disabled = true; setInlineStatus(status, source === "github" ? "正在下载并检查…" : "正在创建…");
  try {
    await api("/api/admin/skills", { method: "POST", body: JSON.stringify(data) });
    form.reset(); form.closest("details").open = false;
    setInlineStatus(status, "已安装", "success");
    await Promise.all([loadAdminSkills(), loadCapabilities()]);
  } catch (error) { setInlineStatus(status, error.message, "error"); }
  finally { button.disabled = false; }
}
elements.skillCreateForm.addEventListener("submit", (event) => { event.preventDefault(); submitSkillForm(elements.skillCreateForm, "manual"); });
elements.skillGithubForm.addEventListener("submit", (event) => { event.preventDefault(); submitSkillForm(elements.skillGithubForm, "github"); });
elements.marketplaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.marketplaceForm.querySelector("button[type='submit']");
  const source = new FormData(elements.marketplaceForm).get("source");
  button.disabled = true; setInlineStatus(elements.marketplaceStatus, "正在同步来源…");
  try {
    renderPlugins(await api("/api/admin/plugin-marketplaces", { method: "POST", body: JSON.stringify({ source }) }));
    elements.marketplaceForm.reset(); setInlineStatus(elements.marketplaceStatus, "Marketplace 已添加", "success");
  } catch (error) { setInlineStatus(elements.marketplaceStatus, error.message, "error"); }
  finally { button.disabled = false; }
});
elements.refreshPlugins.addEventListener("click", loadPlugins);
elements.accountSecurityButton.addEventListener("click", () => {
  elements.accountSecurityForm.reset();
  elements.accountSecurityStatus.textContent = "";
  elements.accountSecurityStatus.dataset.state = "";
  elements.accountSecurityDialog.showModal();
});
elements.closeAccountSecurity.addEventListener("click", () => elements.accountSecurityDialog.close());
elements.accountSecurityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(elements.accountSecurityForm));
  if (values.newPassword !== values.confirmPassword) {
    elements.accountSecurityStatus.textContent = "两次输入的新密码不一致。";
    elements.accountSecurityStatus.dataset.state = "error";
    return;
  }
  const button = elements.accountSecurityForm.querySelector('button[type="submit"]');
  button.disabled = true;
  elements.accountSecurityStatus.textContent = "正在修改密码…";
  try {
    await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
    elements.accountSecurityForm.reset();
    elements.accountSecurityStatus.textContent = "密码已修改，其他设备已退出登录。";
    elements.accountSecurityStatus.dataset.state = "success";
  } catch (error) {
    elements.accountSecurityStatus.textContent = error.message;
    elements.accountSecurityStatus.dataset.state = "error";
  } finally { button.disabled = false; }
});
elements.logoutOtherDevices.addEventListener("click", async () => {
  elements.logoutOtherDevices.disabled = true;
  elements.accountSecurityStatus.textContent = "正在撤销其他登录…";
  try {
    await api("/api/auth/logout-all", { method: "POST" });
    elements.accountSecurityStatus.textContent = "其他设备已退出登录，当前设备保持登录。";
    elements.accountSecurityStatus.dataset.state = "success";
  } catch (error) {
    elements.accountSecurityStatus.textContent = error.message;
    elements.accountSecurityStatus.dataset.state = "error";
  } finally { elements.logoutOtherDevices.disabled = false; }
});
elements.logout.addEventListener("click", async () => { try { await discardPendingAttachments(); await api("/api/auth/logout", { method: "POST" }); } finally { user = null; csrfToken = ""; selectedId = null; showAuth(); } });

document.addEventListener("selectionchange", () => {
  const selection = window.getSelection?.();
  if (!selection?.isCollapsed || !deferredMessageUpdates.size) return;
  requestAnimationFrame(() => {
    for (const message of [...deferredMessageUpdates.values()]) applyMessagePatch({ messageId: message.id, message });
  });
});

function openDrawer(which) { closeDrawers(); which.classList.add("open"); elements.scrim.hidden = false; }
function closeDrawers() { elements.sessionPanel.classList.remove("open"); elements.capabilityPanel.classList.remove("open"); elements.scrim.hidden = true; }
elements.openSessions.addEventListener("click", () => openDrawer(elements.sessionPanel));
elements.openCapabilities.addEventListener("click", () => openDrawer(elements.capabilityPanel));
elements.closeSessions.addEventListener("click", closeDrawers); elements.closeCapabilities.addEventListener("click", closeDrawers); elements.scrim.addEventListener("click", closeDrawers);

setAuthMode("login");
initialize().catch((error) => { showAuth(); elements.authError.textContent = error.message; });
