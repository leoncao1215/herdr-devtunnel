# Agent 安装手册 / Agent installation runbook

仓库：https://github.com/leoncao1215/herdr-devtunnel

这是面向执行安装任务的 agent 的步骤清单。**先读 SECURITY.md，再操作。**
同一个包可安装在 client、server 或两者兼任的机器上。旧 herdr TUI 不等于 herdr-core (`hc`)。

## 用户可以直接复制的指令

### 安装 server

> 从 https://github.com/leoncao1215/herdr-devtunnel 安装服务端。先阅读 docs/AGENT-INSTALL.md
> 和 SECURITY.md。使用我的普通用户，检查依赖和 devtunnel 登录，选择一个独有私有 tunnel 名。
> 安装并在后台启动，不改 SSH、不启用匿名访问、不停止现有 agent。
> 缺少依赖、存在同名 tunnel/占用端口或需要调整现有安装时先确认。
> 完成后返回完整 tunnel 标识、port/session、版本、PID、日志和客户端命令。

### 安装 client

> 从 https://github.com/leoncao1215/herdr-devtunnel 安装客户端，阅读该仓库安装和安全文档。
> 机器名为 MACHINE，目标 tunnel 为 NAME.CLUSTER，端口为 43821，session 为 default。
> 使用与服务端相同账号/provider 登录 devtunnel，通过 hc --via 添加机器，而不是 SSH。
> 验证 connected、远端 whoami 和 Herdr App 的远端机器，不启动我的编码任务。

### 同时作为两端

> 以 both 角色安装，分别按服务端/客户端流程配置。每个服务端使用独立 tunnel，
> 不连接自身 core、不创建连接环。不要把一个角色配置成功误报成两个都成功。

把 MACHINE、NAME.CLUSTER、port/session 替换成真实参数。用户没给关键参数时只完成安装和
preflight，向用户要参数；不要猜测账号、隧道或连接目标。

## 0. 收集状态（只读）

```sh
node --version
hc --version
hc connect --help
hc machine add --help
devtunnel --version
devtunnel user show
```

要求：Node >=22；hc 支持 `connect --session`、客户端支持 `machine add --via`；
官方 devtunnel 已登录。**双方是同一账号、同一 provider**，不是仅显示名相同。
当前经过实际验证的是 hc 0.1.17 的启动格式。不要为了安装本工具擅自升级或降级已有 hc。

客户端使用桌面界面时还需要 Herdr App。Windows 客户端还需 `sh` 在 PATH 中（Git for Windows），
该路径是 hc 的要求；Windows server bridge 本身不依赖 sh。Windows client E2E 尚未实测。

缺少依赖时，确认用户是否授权安装，再用官方文档：
- Node：https://nodejs.org/en/download
- hc：https://github.com/herdrdev/herdr-core
- Herdr App：https://github.com/herdrdev/herdr-app
- devtunnel：https://learn.microsoft.com/azure/developer/dev-tunnels/get-started

登录由用户完成 `devtunnel user login` 的浏览器流程，不抓取 token、不向用户索要密码/私钥。
已有登录是错误账号时先确认切换，不擅自退出其他人的账号。

## 1. 获取并安装

```sh
git clone https://github.com/leoncao1215/herdr-devtunnel.git
cd herdr-devtunnel
```

已有 checkout 时先看 `git status`，保留用户修改。不要 reset/强行覆盖。建议记录 `git rev-parse HEAD`，
需要复现部署时 checkout 已审阅的 commit/tag，而不是无条件跟随 main。

统一安装命令（用用户要求的 role）：

```sh
node install.mjs --role server --check
# 或 --role client / --role both
```

`--json` 可返回结构化结果。安装器只写用户本地目录和 launcher，不自动配置认证/隧道/机器。
`--check` 失败时区分“文件已安装，依赖未就绪”和“安装失败”，不要反复安装掩盖问题。

默认路径：
- Unix：`~/.local/share/herdr-devtunnel`（尊重 XDG_DATA_HOME）、`~/.local/bin/herdr-devtunnel`。
- Windows：`%LOCALAPPDATA%\herdr-devtunnel`、其中 `bin\herdr-devtunnel.cmd`。

保存安装器输出的绝对 launcher 路径。未在 PATH 中时直接调用，不要自行改全局 PATH。
PowerShell 使用调用操作符：

```powershell
& "$env:LOCALAPPDATA\herdr-devtunnel\bin\herdr-devtunnel.cmd" doctor --role server
```

定制位置：`--dir PATH --bin-dir PATH`。预览：`--dry-run`。
旧手动 PoC 安装会被拒绝，只有确认目录和现有 wrapper 都属于本项目后才可 `--adopt`。
不要对任意非空目录使用接管，不要删除日志/用户数据来绕过保护。

## 2A. 配置 server

按 [SERVER-SETUP.md](../SERVER-SETUP.md) 执行。核心命令：

```sh
herdr-devtunnel serve --tunnel UNIQUE-NAME --create
```

默认 port 43821、hc session default。先确认端口未被其他程序占用；不要杀未知进程。
新 tunnel 只创建一次。只有确认存在的 tunnel 是本项目 owner-only 专用 tunnel 时才可以复用。
不允许 `--allow-anonymous`、共享 ACL、绑定公网地址、复用无关业务 tunnel。

需要后台运行时使用 SERVER-SETUP.md 的对应 OS 启动命令，检查进程和日志，
等待 `Ready to accept connections for tunnel: NAME.CLUSTER`。
不擅自注册 Windows Service/systemd/launchd/计划任务或提高权限。
不要把“进程启动了”当成“网络和 core 认证验收通过”。

## 2B. 配置 client

服务端已 ready 才继续：

```sh
herdr-devtunnel doctor --role client
hc machine ls
herdr-devtunnel add --name MACHINE --tunnel NAME.CLUSTER --port 43821 --session default
hc machine ls
hc exec --on MACHINE whoami
```

如果 MACHINE 已存在：先确认 target/session 是否正确；正确则复用、验证，不重复添加。
需要替换时说明影响并获得用户确认，再 `hc machine rm MACHINE` 和重新 add。
不要直接编辑 core 状态 JSON，不影响其他 machine。

Herdr App 使用同一用户/同一本地 core 时应能识别机器；`herdr-app ls` 可只读检查远端 spaces。
没有 space 时先问是否创建一个。不要通过 App 的 “SSH Add Machine” 重复添加。
不要代用户启动 Copilot/其他长任务或运行有副作用的代码。

## 3. 验收与汇报

报告：
1. role、OS、仓库 commit、工具版本。
2. 安装路径、launcher 路径、是否需要用户 PATH 配置。
3. doctor 各项结果。账号信息仅给当前用户，不发到公开 issue。
4. server：完整 tunnel 标识、port/session、就绪日志、PID、日志位置、启动方式。
5. client：machine 名、connected 状态、远端 whoami、App 是否能看到机器/space。
6. 哪些操作未测试或因缺少参数而等待；尤其不要夸大 Windows/Linux client 支持。

不在报告里放 token、密码、私钥或完整凭据输出。GitHub deploy key 仅用于维护源码仓库，
不参与 Dev Tunnels 登录，也不应安装到使用此工具的机器上。

## 4. 失败时停在哪里

| 现象 | 行动 |
|---|---|
| `Executable not found` | 查 PATH 或使用 `--hc` / `--devtunnel`；依赖安装需授权 |
| 登录检查失败 | 用户完成官方浏览器登录，不代填凭据 |
| `owner-only` / port 检查失败 | 检查专用 tunnel 的 ACL/端口；不要通过开放匿名来“修复” |
| `Unsupported hc bootstrap` | 记录版本与错误，报告兼容性问题，不扩大到执行任意 shell |
| `No matching devtunnel local port` | 确认 host ready、账号、端口、CLI 输出格式；不要猜本地端口 |
| 会话不匹配 | 对齐两端 session，不默认暴露所有 session |
| App 看不到 | 查相同用户/core、machine 状态和是否有 space，不改 SSH |
| 任务需要注销后持续 | 说明当前无服务化保证；另行设计经用户批准的运行方式 |

## 5. 更新/卸载

更新前确认活动连接；审阅新版本、运行离线测试、重跑 installer。协调重启 bridge，
不重启 core/agent。可执行路径改变时需重新登记对应 machine，先确认后操作。

卸载只移除本项目的 machine、已核实 PID 的 bridge、安装目录和 launcher。
不删除远端 agent、项目目录、其他 tunnel、SSH 配置或账号凭据。
删除不再使用的专用 tunnel 必须由用户明确确认，并使用其完整标识。
