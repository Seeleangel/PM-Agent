# PM Agent

面向获授权团队成员的共享 Agent 工作台，把服务器上的 Claude Code 执行能力接入浏览器。支持账号审批、私有及团队会话、模型配置、附件、流式回复、任务排队和中断。

[打开 PM Agent](https://vviii.asia/agent/)：登录页面提供“游客登录 · 浏览界面”，无需账号即可查看只读演示。发送任务与使用工具需要获授权账号。

## 已实现

- 注册申请经管理员审批后生效，新账号为普通成员；管理员维护账号和模型配置。
- 游客使用独立的预置演示会话，不读取真实成员、消息、附件或模型配置。服务端接口白名单禁止任务执行、上传、修改与管理操作，不调用 Claude 或消耗模型额度。
- 每个会话绑定独立 Claude session，并可选择管理员启用的模型服务。
- 同一会话严格串行；全局、私人会话和单账号并发上限可配置。
- Markdown 回复、文件上传与下载、选择交互、在线成员和用量记录。
- 取消或超时清理执行进程；Linux 使用任务 cgroup 清理派生工具进程。
- 模型验证主动关闭输入流，显示结构化接口错误并隐藏密钥；密钥栏拒绝网址。
- 首次调用失败后生成的 Claude session 可续接，避免会话编号冲突。
- 显式配置 WebSearch、WebFetch 联网权限，以及公开网页的连接故障替代读取流程。
- 管理中心维护工作区指令、分类记忆与 Skill。飞书、插件及 MCP 适配源码保留，部署模板默认关闭这些外部集成。

网页服务使用 Node.js 内置 HTTP 和 SQLite，没有第三方运行依赖。实际 Agent 由单独安装的 Claude Code CLI 提供；仓库不包含其二进制或源码。

## 检查与部署

需要 Node.js 24 或更高版本。

```sh
npm run check
npm test
```

运行需单独安装 Claude Code。按 [部署说明](docs/deployment.md) 创建专用用户、配置 HTTPS 路由，并复制 [环境配置示例](deploy/server.env.example)，设置实际端口、路径和至少 12 位的管理员初始密码。模型服务地址、模型名和真实 API 密钥在管理中心填写。

已有环境文件的启动示例：

```sh
node --env-file=/path/to/server.env server.mjs
```

生产运行参考 [systemd 模板](deploy/shared-agent.service.example)。配置和数据库私有保存，不加入 Git。

## 已验证与边界

2026-10-11 部署验收验证了 HTTPS、注册审批、成员登录和管理员权限；原生 Claude Code 的连接验证、流式回复、工具执行、中断及续接均经过测试。真实 DeepSeek 调用验证了网页搜索，并实际读取公开网站取得页面标题。

原生 WebFetch 在部分网络下无法连接域名校验服务，公开网页的授权替代读取方式见 [联网说明](docs/network-access.md)。供应商限流、长上下文及其他工具兼容性需按实际模型验证。

私有会话隔离网页消息及下载权限，但成员的 Agent 仍共用一个系统用户和文件工作区，属于协作空间，不提供多租户文件隔离。获批成员可以消耗共享模型额度，适合可信团队使用。

源码不包含真实凭据、会话数据、上传文件、自动记忆或生产日志。测试中的密码及密钥都是虚构夹具。

游客会话只保存在受限的进程内注册表，2 小时失效，退出或服务重启后撤销，不写入用户数据库，也不订阅真实事件流。自动测试覆盖演示数据隔离、接口越权、会话过期、退出、普通登录恢复及执行程序零调用。

## 目录

```text
server.mjs        网页/API、认证、调度和流式更新
lib/agent.mjs     执行、取消、模型环境与结果解析
lib/database.mjs  SQLite、账号、模型、会话及消息
lib/guest.mjs     独立演示数据、游客会话和只读边界
lib/admin.mjs     模型验证和管理功能
public/           网页界面
tests/           自动检查及运维验证脚本
deploy/          无凭据的运行配置模板
docs/            部署及联网说明
```

权限规则参考 [Claude Code 官方文档](https://code.claude.com/docs/en/permissions)，DeepSeek 接入参考 [官方说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)。
