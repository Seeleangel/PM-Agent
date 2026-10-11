# 部署

要求：Linux、Node.js 24、Claude Code CLI、HTTPS 反向代理。网页源码无需安装 npm 运行依赖。

## 目录与运行身份

使用无 sudo 权限的专用系统用户 `shared-agent`。示例布局：

- `/opt/shared-agent/current`：源码发布目录或发布符号链接，管理员拥有，应用用户只读。
- `/opt/shared-agent/runtime/node`、`claude`：官方渠道安装的执行程序，路径可调整。
- `/var/lib/shared-agent/home`：设为专用系统用户的默认主目录。
- `/var/lib/shared-agent/data`、`workspace`、`memory`、`lark`：应用用户拥有，目录 700，敏感文件 600。
- `/etc/shared-agent/server.env`：root 管理，权限 600。

复制环境示例后设置实际端口、路径和初始密码。首次启动创建管理员；成功初始化后删除环境文件的 `BOOTSTRAP_ADMIN_PASSWORD`，后续启动使用数据库内的密码哈希。`BOOTSTRAP_ADMIN_USER` 应一直指向现有的团队管理员；不能直接更改已初始化实例的身份。

检查 systemd 模板的实际路径及资源限制。`PrivateTmp` 提供 Claude 可写临时目录；`Delegate` 用于任务 cgroup，停止任务时清理工具派生进程。

## HTTPS 路由

Node 只监听回环地址。`BASE_PATH=/agent` 时反向代理保留 URL 前缀，上游 `proxy_pass` 后不要加斜杠。将 `CHOSEN_PORT` 替换为配置中实际端口，再合入现有 HTTPS server 段，保留原路由。

```nginx
location = /agent { return 301 /agent/; }
location ^~ /agent/ {
    proxy_pass http://127.0.0.1:CHOSEN_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1800s;
    client_max_body_size 26m;
}
```

HTTPS 保持 `SECURE_COOKIES=true`。只在本机 HTTP 开发时关闭该选项，不将开发配置用于公网。

## 账号、模型与联网

`ALLOW_REGISTRATION=true` 开放注册申请，管理员审批通过后才可登录，新用户为普通成员。管理员添加 Anthropic 兼容服务地址、模型名和真实密钥。密钥不能是平台网址；编辑表单留空保留原密钥。先测试连接再发送任务。

游客入口默认提供只读演示，不需要模型凭据。游客会话最长 2 小时，退出或重启时撤销；只返回预置会话和示例状态，不能创建任务、读真实会话或下载附件。游客不进入真实用户数据库与事件流。

配置模板关闭飞书、插件及 MCP；适配代码保留，后续需独立配置。将 `deploy/claude-settings.example.json` 中的联网权限合入应用用户的 Claude 设置，保留其他既有配置。连接故障替代读取见 [联网说明](network-access.md)。

## 验收及备份

- 运行语法检查和测试，检查 `BASE_PATH` 下的 `/healthz`。
- 验证 HTTPS、登录、来源与 CSRF 校验、注册审批、普通成员权限及真实模型回复。
- 验证工具执行、中断与失败会话续接。
- 验证游客可切换演示会话，发送、上传、模型与管理操作均被服务端拒绝，真实成员与会话数据不可见。
- 通过 SQLite 在线备份接口生成一致性快照，同时备份工作区、记忆、用户目录、配置和当前源码。归档私有保存，不上传 GitHub。
- 升级保留回滚版本，仅在没有执行或排队任务时重启。重启不会自动恢复内存队列中的任务。

项目不提供独立容器或多租户文件沙箱，共享工作区只面向获审批的可信成员。
