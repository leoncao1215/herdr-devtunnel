# herdr-devtunnel

**通过私有 Microsoft Dev Tunnels 远程使用 Herdr App，不需要 SSH Server。**

[English](README.md) · [给 Agent 的安装指引](docs/AGENT-INSTALL.md) · [服务端启动](SERVER-SETUP.md) · [安全边界](SECURITY.md)

保留 Herdr 的终端/会话管理和原生 Copilot CLI 等 agent，只替换连接层。不修改 agent 核心。
这是独立社区 PoC，不是微软或 Herdr 官方插件，也没有 App 设置界面。

## 两端共用一个安装包

前置：Node.js **22+**、[herdr-core (`hc`)](https://github.com/herdrdev/herdr-core)、
[官方 devtunnel CLI](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started)。
需要桌面界面的客户端另外安装 [Herdr App](https://github.com/herdrdev/herdr-app)。

```sh
git clone https://github.com/leoncao1215/herdr-devtunnel.git
cd herdr-devtunnel
node install.mjs --role both --check
```

`--role` 可选 `client`、`server`、`both`，只影响检查项目，不限制已安装功能。
零 npm 依赖，无需 `npm install`。也可下载 GitHub ZIP 后解压执行。
建议先审阅代码并固定到已验证的 commit/tag。

安装位置：
- macOS/Linux：运行时 `~/.local/share/herdr-devtunnel`（或 `$XDG_DATA_HOME` 下）；命令 `~/.local/bin/herdr-devtunnel`。
- Windows：运行时 `%LOCALAPPDATA%\herdr-devtunnel`；命令 `%LOCALAPPDATA%\herdr-devtunnel\bin\herdr-devtunnel.cmd`。

安装器打印绝对命令路径；可直接调用，也可自行添加到用户 PATH。
**不会自动安装依赖、改 PATH、登录、创建 tunnel、添加 machine、重启任务或注册开机服务。**
`--check` 检查失败会返回非零退出码，但已安装的文件保留。
旧手动 PoC 目录需先审阅，再显式用 `--adopt` 接管；其他不相关目录/命令不会被覆盖。

## 双端认证

```sh
devtunnel user login
devtunnel user show
herdr-devtunnel doctor --role both
```

双方必须用**相同身份提供方下的同一账号**。PoC 只允许 owner-only tunnel，不接受额外 ACL 授权。
不要启用匿名访问。浏览器认证需本人完成。GitHub deploy key 仅用于维护源码仓库，与此认证无关。

## 服务端

用拥有项目和 agent 登录状态的**普通用户**启动，选择独有 tunnel 名：

```sh
herdr-devtunnel serve --tunnel my-unique-agent-host --create
```

首次才加 `--create`，以后启动去掉。默认监听 `127.0.0.1:43821`，访问远端 hc 的 `default` session。
看到 `Ready to accept connections for tunnel: NAME.CLUSTER` 才算隧道就绪。
让进程持续运行；后台启动方法见 [SERVER-SETUP.md](SERVER-SETUP.md)。

## 客户端

拿到服务端完整 tunnel 标识后：

```sh
herdr-devtunnel add --name workbox --tunnel NAME.CLUSTER
hc machine ls
hc exec --on workbox whoami
```

Herdr App 使用同一本地 core 时会识别这台机器。没有远端 space 时，在该机器上创建一个。
不要再通过 App 的 SSH 设置添加；不需要 SSH key、不修改 `~/.ssh/config`。

Windows **客户端**还需要 `sh` 在 PATH 中（例如 Git for Windows 的 shell），因为 hc 的 `--via`
会使用它。Windows 服务端的 bridge 本身不依赖 sh。Windows 客户端完整流程尚未实测。

## 让你的 Agent 安装

把仓库链接交给 agent，并说：

> 阅读仓库的 docs/AGENT-INSTALL.md 和 SECURITY.md。用普通用户安装，角色为 CLIENT/SERVER/BOTH。
> 不改 SSH、不启用匿名访问，按我提供的 tunnel 和机器名完成配置及验收。
> 缺少依赖或需要修改现有连接时先确认，最后返回版本、安装路径、日志和结果。

准备好的机器只需一条安装命令；身份认证和系统依赖不能安全地无条件静默处理。

## 多机器与维护

- 一台机器可以同时是 client/server。每台 server 使用独立 tunnel；不要形成 core 自连接或连接环。
- 同一机器发布多个 session 时，每个使用独立端口、tunnel 和进程；双方 `--port`/`--session` 必须一致。
- 客户端是 hc 的持久 machine 配置，无需每次 add；断线由 hc 重连。
- 更新：切到审阅过的版本后重跑安装器；协调重启 bridge，不会自动重启 core/agent。
- Node/devtunnel 可执行路径改变后，需要重新登记对应 machine。不要手改 core 状态 JSON。
- 不要对本连接使用 App 的 SSH Login / Update Core；在远端手动维护 hc。
- 卸载先移除本工具创建的 machine、确认 PID 后停止 bridge，再删除安装目录与 launcher。
  tunnel 和 agent 不会自动删除。

## 验证状态

已实测 **Mac client → Windows server**：两端 hc 0.1.17，能执行命令、返回用户身份，
Herdr App 0.1.12 能显示远端 space。Mac 的真实隧道测试还验证了重连后远端进程 PID 不变。

完整交互式 agent 行为、中文/代码页、Windows/Linux client、Linux server、系统注销/重启后的恢复
尚未完整验收。旧 herdr TUI 0.8.x 不属于这个集成。CLI 协议/输出变动可能需要适配器更新。
本版尚无开机自启和完整服务管理。

```sh
npm test
npm run check
```

真实网络测试需显式执行 `python3 test/live-smoke.py`（macOS/Linux）：它会创建并清理一个私有、
1 小时过期的测试 tunnel，使用隔离 core/session，不操作已有工作连接。

## 安全提醒

能访问 bridge，基本等于拥有该用户的 shell/文件权限。Dev Tunnels 保护的是隧道，
**本机进程仍能直连 loopback 端口**；不可信多用户机器需要额外认证或隔离。
默认不以管理员/root 运行，不开放匿名权限。详见 [SECURITY.md](SECURITY.md)。

MIT License。
