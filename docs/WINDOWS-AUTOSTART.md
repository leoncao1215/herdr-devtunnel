# Windows 登录自启 / Login autostart

从 0.2.0 起可显式注册当前用户的计划任务，替代 agent 临时启动的后台进程。
**不是 Windows Service**：需登录后运行，不保存密码、不用 SYSTEM、不请求提升权限。
重启后需要先登录；锁屏和通常的 RDP 断开不等于注销。注销/重启仍可能结束用户任务。

Read [SECURITY.md](../SECURITY.md) first. macOS/Linux currently retain manual launch only.

## 前置条件

- 先运行 `node install.mjs --role server --check`，然后使用它打印的**已安装 launcher**。
  不要从 checkout 注册任务，以免移动/删除源码后自启失效。
- 现有 tunnel 已创建，owner-only，唯一发布端口与服务端配置一致。
- `hc`、Node、devtunnel 已安装，devtunnel 已用目标账号登录。
- 普通用户有创建自己计划任务的权限。公司策略拒绝时报告错误，不自动提权或绕过策略。
- Windows PowerShell 的 ScheduledTasks 模块可用。工具不更改 ExecutionPolicy，若脚本被策略阻止，
  让用户/IT 审核处理，不自动加 Bypass。

## 注册并启用

```powershell
$hdt = "$env:LOCALAPPDATA\herdr-devtunnel\bin\herdr-devtunnel.cmd"
& $hdt autostart install --name workbox --tunnel NAME.CLUSTER --port 43821 --session default
```

注册、启用**未来的登录自启**，默认不主动启动当前实例。既有手动 bridge 可继续运行。
profile 名称在本机用户内唯一；任务名包含当前用户 SID，避免不同用户的同名 profile 冲突。

准备好后启动：

```powershell
& $hdt autostart start --name workbox
& $hdt autostart status --name workbox
& $hdt autostart logs --name workbox --lines 80
```

没有旧实例时，可注册并立即启动：

```powershell
& $hdt autostart install --name workbox --tunnel NAME.CLUSTER --start
```

这里**不接受 `--create`**，不会在每次登录时重新创建 tunnel。
`--hc` / `--devtunnel` 指定绝对可执行路径。安装时会捕获 Node、hc、devtunnel 及脚本的路径，
避免任务计划程序不继承交互式终端 PATH 的问题。它不保存登录 token 或密码。

## 从当前手动后台进程迁移

1. 更新 checkout，安装 0.2.0；旧手动 PoC 目录需审阅后加 `--adopt`。
2. 执行 `autostart install`，**先不要 `--start`**。注册失败则旧进程仍不受影响。
3. 协调短暂断线，在 Windows 本地确认旧 PID、命令行、安装路径、端口确属本项目，
   再由操作者/本地 agent 停止旧 bridge。不要杀所有 node/devtunnel，不停止 hc 或 agent。
4. 旧官方 devtunnel host 如果残留，只核对并清理该 tunnel 对应进程，不按进程名批量终止。
5. 用 Windows **本地**终端/agent 执行 `autostart start`，检查 ready、日志与客户端重连。

不要通过即将被关闭的远程连接执行一串“停止自己再启动”的命令；连接关闭可能中断后续操作。
该工具不会自动接管/停止旧 PID。端口占用时 `start` 会拒绝，不会杀掉占用者。

## 日常管理

```powershell
& $hdt autostart status --name workbox --json
& $hdt autostart logs --name workbox --lines 100
& $hdt autostart stop --name workbox
& $hdt autostart start --name workbox
& $hdt autostart restart --name workbox
& $hdt autostart uninstall --name workbox
```

| 操作 | 行为 |
|---|---|
| `install` | 注册/更新自己的任务并启用登录触发；正在运行的任务拒绝覆盖 |
| `start` | 恢复自启并启动，等待 readiness；已有 ready 实例不重复启动 |
| `stop` | **先禁用登录触发和失败重试**，再请求当前实例优雅关闭；下次需 `start` 恢复 |
| `restart` | stop 后重新 enable/start |
| `status` | 任务注册/启用状态、运行记录、就绪标记和日志位置 |
| `logs` | 最近 N 行日志，不持续 follow |
| `uninstall` | stop 后注销计划任务；保留配置/日志，不删除 tunnel、core 或 agent |

默认管理等待时间 90 秒，可用 `--timeout 180`（logs 除外）。`--json` 可供 agent 解析。
如果 stop 超时，任务保持禁用，并报告错误，**不会自动强杀**。检查日志和任务状态后人工处理。
不要把 Task Scheduler 的强制 End 与本工具的优雅 stop 混为一谈。

## 计划任务配置

- 当前用户 SID；LogonType **Interactive**，RunLevel **Limited**。
- 该用户登录触发，延迟 15 秒；不要求用户密码。
- IgnoreNew，避免重复实例；不限运行时长，允许电池供电。
- 失败后间隔 1 分钟重试，最多 3 次；不做无限重启循环。
- Action 是 Node 前台运行管理 runner，不是 Start-Process 后立即退出。
- task runner 在同一 Node 进程中运行 bridge。停止只关闭 bridge 和它的隧道/IPC 子进程，
  不调用 `hc server stop`，不终止 hc 的进程树。
- 检查任务 Description、用户 SID、权限及 action 路径，不覆盖/控制不匹配的任务。

## 状态与日志

每个 profile 的文件位于：

```text
%LOCALAPPDATA%\herdr-devtunnel\autostart\PROFILE\
  config.json          # 程序路径和连接参数，无密码/token
  status.json          # 当前 runId、阶段、PID、心跳、错误
  stop-request.json    # 针对 runId 的停止请求，旧请求不会停掉新实例
  server.log           # 最多约 5 MiB，加最多 3 个轮转备份
```

`ready` 表示**当前任务进程的近期心跳 + 曾收到官方 host 就绪输出**，不是持续的端到端健康检查。
客户端仍应验证 `hc machine ls` 和远端短命令。硬终止留下的历史状态不会仅凭文件存在就当成 ready。

配置和控制文件继承用户目录的 Windows ACL，视同该用户其他可信程序；不是不可信多租户边界。
不要把此目录纳入公开仓库，不要共享日志中的账号/路径信息。

## 更新与排错

- 一般升级安装器不会重启正在运行的任务；协调 `stop`、更新、重新 `install`、`start`。
- Node/hc/devtunnel 路径变了，先停止，再重新注册任务以更新绝对路径。
- 登录过期：在该用户交互式会话执行官方登录，再 start/restart；不在后台弹登录 UI。
- 公司策略拒绝注册/PowerShell 脚本执行：停止并交给用户/IT，不更换为 SYSTEM/提权/S4U。
- 无人登录启动不是本功能范围；需单独设计经批准的服务账号方案。

## 验证范围

自动测试覆盖配置、任务归属校验、日志轮转、陈旧状态/停止请求、优雅停止和失败退出。
Windows CI 显式创建一个**独有、禁用**的临时任务，检查 Interactive/Limited、重试设置并删除，
不启动 bridge，不接触用户现有任务。真实登录触发、注销和公司设备策略仍需在部署机器验收。
