import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const pendingAuthorizations = new Map();

function safeUserId(value) {
  const id = String(value || "");
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw Object.assign(new Error("用户标识无效。"), { status: 400 });
  return id;
}

function parseJson(value) {
  try { return JSON.parse(String(value || "").trim()); } catch { return null; }
}

function cliMessage(error) {
  const payload = parseJson(error?.stdout) || parseJson(error?.stderr);
  return payload?.error?.message || payload?.message || String(error?.stderr || error?.message || "飞书 CLI 执行失败。").trim().split("\n").at(-1);
}

function runCli(bin, home, args, { cwd = home, timeout = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: home,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error(cliMessage({ message: error.message, stdout, stderr })), { status: 400 }));
      resolve(String(stdout || "").trim());
    });
  });
}

function publicStatus(payload, configured = true) {
  const user = payload?.identities?.user || {};
  return {
    configured,
    ready: Boolean(payload?.verified && user.status === "ready" && user.tokenStatus === "valid"),
    identity: payload?.identity || "user",
    userName: user.userName || null,
    tokenStatus: user.tokenStatus || "missing",
    verified: Boolean(payload?.verified),
    appId: payload?.appId || null,
    brand: payload?.brand || "feishu",
  };
}

export class LarkManager {
  constructor({ bin = "lark-cli", rootDir, teamHome, teamAdminUserId }) {
    this.bin = bin;
    this.rootDir = rootDir;
    this.teamHome = teamHome;
    this.teamAdminUserId = teamAdminUserId;
  }

  privateHome(userId) {
    return path.join(this.rootDir, "users", safeUserId(userId));
  }

  homeForUser(user) {
    return user.id === this.teamAdminUserId ? this.teamHome : this.privateHome(user.id);
  }

  homeForConversation(conversation) {
    if (conversation.visibility === "team" || conversation.ownerId === this.teamAdminUserId) return this.teamHome;
    return this.privateHome(conversation.ownerId);
  }

  async ensurePrivateHome(userId) {
    const target = this.privateHome(userId);
    const targetConfigDir = path.join(target, ".lark-cli");
    const targetSecrets = path.join(target, ".local", "share", "lark-cli");
    await mkdir(targetConfigDir, { recursive: true, mode: 0o700 });
    await mkdir(targetSecrets, { recursive: true, mode: 0o700 });

    const sourceConfig = path.join(this.teamHome, ".lark-cli", "config.json");
    const config = JSON.parse(await readFile(sourceConfig, "utf8"));
    config.apps = (config.apps || []).map((app) => ({ ...app, users: [] }));
    await writeFile(path.join(targetConfigDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const sourceSecrets = path.join(this.teamHome, ".local", "share", "lark-cli");
    for (const name of await readdir(sourceSecrets)) {
      if (name !== "master.key" && !/^appsecret_.+\.enc$/.test(name)) continue;
      await copyFile(path.join(sourceSecrets, name), path.join(targetSecrets, name));
      await chmod(path.join(targetSecrets, name), 0o600);
    }
    return target;
  }

  async status(home) {
    try {
      const output = await runCli(this.bin, home, ["auth", "status", "--json", "--verify"]);
      return publicStatus(parseJson(output));
    } catch {
      try {
        await readFile(path.join(home, ".lark-cli", "config.json"));
        return publicStatus(null);
      } catch { return publicStatus(null, false); }
    }
  }

  async statusForUser(user) {
    const privateHome = this.homeForUser(user);
    const sharesTeam = privateHome === this.teamHome;
    const [personal, team] = sharesTeam
      ? await this.status(this.teamHome).then((status) => [status, status])
      : await Promise.all([this.status(privateHome), this.status(this.teamHome)]);
    return {
      personal,
      team,
      personalSharesTeamCredential: sharesTeam,
      routing: {
        private: sharesTeam ? "管理员个人授权" : "当前账号个人授权",
        team: "管理员个人授权",
      },
    };
  }

  async startAuthorization(user) {
    const home = user.id === this.teamAdminUserId ? this.teamHome : await this.ensurePrivateHome(user.id);
    const output = await runCli(this.bin, home, ["auth", "login", "--domain", "all", "--no-wait", "--json"]);
    const payload = parseJson(output);
    if (!payload?.verification_url || !payload?.device_code) throw Object.assign(new Error("飞书 CLI 未返回授权链接。"), { status: 502 });
    const expiresAt = Date.now() + Math.min(Number(payload.expires_in || 600), 600) * 1000;
    pendingAuthorizations.set(user.id, { deviceCode: payload.device_code, home, expiresAt });

    const qrName = `.lark-auth-${randomBytes(8).toString("hex")}.png`;
    const qrPath = path.join(home, qrName);
    try {
      await runCli(this.bin, home, ["auth", "qrcode", payload.verification_url, "--output", qrName], { cwd: home });
      const qr = await readFile(qrPath);
      return { verificationUrl: payload.verification_url, expiresAt: new Date(expiresAt).toISOString(), qrDataUrl: `data:image/png;base64,${qr.toString("base64")}` };
    } finally { await rm(qrPath, { force: true }); }
  }

  async completeAuthorization(user) {
    const pending = pendingAuthorizations.get(user.id);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingAuthorizations.delete(user.id);
      throw Object.assign(new Error("授权请求已过期，请重新发起。"), { status: 410 });
    }
    await runCli(this.bin, pending.home, ["auth", "login", "--device-code", pending.deviceCode], { timeout: 90_000 });
    pendingAuthorizations.delete(user.id);
    return this.statusForUser(user);
  }

  async logoutUser(user) {
    if (user.id === this.teamAdminUserId) throw Object.assign(new Error("团队身份所有者的授权供团队会话使用，请通过重新授权替换，不允许在成员页面直接注销。"), { status: 403 });
    const home = this.privateHome(user.id);
    await runCli(this.bin, home, ["auth", "logout", "--json"]);
    pendingAuthorizations.delete(user.id);
    return this.statusForUser(user);
  }
}
