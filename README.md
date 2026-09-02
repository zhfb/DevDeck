# DevDeck

> 暂定代号：~~MacCloud Workspace~~ → **DevDeck**

macOS 原生高效远程连接与容器管理工具 —— SSH 远程终端 / SFTP 文件管理 / Docker·Podman 容器生态 / 端口隧道 / Compose，一体化工作台。

基于 **Tauri v2 + Rust 异步生态** 构建，媲美原生应用的性能与低功耗，全面剥离 Electron 的高功耗负担。

## 技术栈

```
UI 层      Tauri v2 Web · React 18 · TypeScript · Tailwind CSS · Shadcn UI · xterm.js (WebGL) · Zustand · TanStack Query · i18next
核心层     Rust · Tokio · russh / russh-sftp · bollard (Docker/Podman) · rusqlite (SQLite WAL) · zmodem2
系统层     macOS Keychain · Dispatch QoS · NSProcessInfo App Nap 豁免 · Tauri 托盘 · tauri-plugin-updater · Sentry
CI/发布    GitHub Actions · 公证 (notarytool) · 签名更新源 (minisign feed) · 能耗/体积基线
```

> 说明：K8s / VM 运行时不在当前范围（防蔓延决策，详见 `docs/` 技术评审）；Virtualization.fw 未使用。

## 功能清单

**已实现（V1.0 基础 + V1.1 全部规划项）**

**远程与终端**
- SSH 2.0（口令 / 私钥 / Keychain / ssh-agent）、**TOTP 二次验证（keyboard-interactive）**、PTY 分屏、known_hosts TOFU、keepalive 自动重连、会话级事件流
- **跳板机（Jump Host）**：连接时先连跳板，再经 direct-tcpip 通道转发到目标主机，复用 agent / 默认密钥认证
- **会话复用**：同一主机多会话共享一条 SSH 传输，最后一个会话断开才真正断开连接
- **会话录制**：会话录制为 asciinema `.cast`（TerminalView 导出）
- **广播终端**：一条输入同时扇出到多个选中会话
- **ZMODEM 传输**：经 `rz/sz` 的可靠文件收发（`zmodem_upload` / `zmodem_download`）

**文件传输**
- SFTP 双栏文件管理、目录操作、传输队列（并发 4–8）、断点续传、递归目录传输、取消与失败重试

**容器与编排**
- Docker/Podman 引擎探测（OrbStack / Docker Desktop / Colima / Podman）、容器生命周期与批量操作、一键容器 Exec 终端、镜像拉取进度、运行新容器表单（端口映射）、卷 / 网络创建删除
- **远程 Docker over SSH**：SSH 桥接远端 `docker.sock` → 本地 unix socket，以本地客户端身份管理远端引擎
- **Compose**：经 SSH 执行 `docker compose`（up / down / logs / build / restart / pull），`compose ps` 服务状态表
- **事件驱动端口转发**：监听 Docker 事件，容器启动时自动按端口映射暴露 localhost 隧道、停止时自动拆除
- Docker `/events` 自愈转发 + snapshot 补偿

**网络与隧道**
- Local / Remote 端口转发、**SOCKS5 动态代理**（RFC 1928，IPv4 / 域名 / IPv6）、隧道命名与启用状态、实时流量统计（每隧道入 / 出字节）

**主机能力**
- 主机分组与环境色卡、跳板机配置、无 Agent 监控（CPU/Disk/RAM，前端 + 后台采样）、主机进程查看（复用活跃 SSH 会话执行 `ps`）

**效率**
- Snippets 常用命令库（一键插入活动终端）、Cmd+K 命令面板、任务队列面板、事件流面板
- **i18n 中英双语**（i18next，导航 / 面板标题 / 通用文案，可在设置切换）

**更新与可观测性**
- **自动更新**：tauri-plugin-updater，设置页“检查更新 / 安装更新”，GitHub Release 签名 feed
- **Sentry 崩溃上报**：按 `DEVDDECK_SENTRY_DSN` 环境变量条件初始化
- **CI 质量门**：cargo test + 前端 tsc/build + **能耗 / 体积基线**（二进制大小 + max RSS 上报 GITHUB_STEP_SUMMARY）

**节能与系统**
- Active / Background / Idle 低功耗状态机 + 后端采样调度、Docker 事件低功耗批处理、SFTP 传输期间 App Nap 豁免、macOS 托盘菜单、Keychain 密钥保险箱、SQLite 持久化

**规划中（后续版本）**
- 卷挂载查看、Snippets 变量替换、配置导入导出、闲置自动锁、本地终端、sudo 密码提示、MCP Server

**明确不做**：K8s 全套、VM 运行时 / USB 透传 / x86 模拟、OrbStack UI 风格、团队协作（V2 再评估）

## 目录结构

```
DevDeck/
├── DESIGN.md       # 设计 token 规范（Google design.md）
├── src-tauri/      # Tauri v2 + Rust 核心层
│   ├── capabilities/
│   ├── .signing/   # 更新源签名密钥（已 gitignore，不入库）
│   └── src/
│       ├── commands.rs    # Tauri invoke 命令（前端契约，80+ 命令）
│       ├── services/      # ssh / docker / sftp / tunnel / stats / power / hostkey / macos_power
│       │                  #   + auto_forward / compose / remote_docker / zmodem
│       ├── infra/         # db (SQLite) / keychain
│       ├── models.rs      # serde 契约模型（camelCase）
│       └── tray.rs        # macOS 托盘
├── frontend/       # React 前端（导航栏 / 资源树 / Tab 画布 / 底部面板 / xterm）
│   └── src/
│       ├── app/          # 应用外壳（NavRail / ResourceTree / TabCanvas / BottomDock / Cmd+K / TerminalView）
│       ├── features/     # 管理面板（容器/镜像/卷/网络/主机/SFTP/隧道/监控/片段/任务/Compose/设置/Dashboard）
│       ├── stores/       # workspace / live / power（Zustand）
│       └── lib/          # API 双模层 / queries / types / terminalBus / i18n
├── docs/           # 内部设计/评审文档（本地维护，不入库）
└── .github/workflows/    # release.yml（公证+签名 feed） / quality.yml（测试+能耗基线）
```

## 开发状态

- [x] 技术方案评审与补全（`docs/`，本地维护不入库）
- [x] DESIGN.md 设计系统（token 规范，design-md lint 通过）
- [x] 前端骨架：布局框架 + 组件库 + API 双模层
- [x] 管理面板全量：容器 / 镜像 / 卷 / 网络 / 主机 / 监控 / 隧道 / 片段 / Compose / Dashboard / 设置 / 详情页（mock 可完整演示）
- [x] Rust 核心层：Docker 引擎探测 + 容器/镜像操作、SSH 会话（russh）、SQLite、Keychain
- [x] SSH PTY 事件桥接、TOFU、keepalive、自动重连、TOTP、跳板机、会话复用、广播、录制
- [x] Docker events 自愈转发、snapshot 补偿、镜像拉取任务进度
- [x] SFTP 双栏、传输队列、断点续传、递归目录
- [x] 隧道真实转发（Local/Remote/SOCKS5）+ 流量统计
- [x] 事件驱动端口转发（auto_forward）
- [x] 远程 Docker over SSH、Compose、ZMODEM
- [x] 自动更新（tauri-plugin-updater）+ Sentry + 公证/签名发布 CI + 能耗基线 CI
- [x] i18n 中英双语
- [x] 低功耗状态机、App Nap 豁免、托盘、Keychain、SQLite 持久化
- [ ] 发布（Universal Binary + 公证 + MVP 发布）需在具备 Apple Developer 证书环境执行 `pnpm tauri build --release` 触发

## 开发方式

```bash
# 前端（浏览器模式，mock 数据可预览全部面板）
cd frontend && pnpm install && pnpm dev

# 桌面应用（需要 Rust toolchain）
cd frontend && pnpm tauri dev
```

- 前端开发不依赖 Rust：`lib/api.ts` 检测不到 Tauri 环境时自动回退 mock 数据流
- 命令契约：前端 `lib/api.ts` ↔ Rust `src-tauri/src/commands.rs` 需同步修改
- 设计 token：仓库根 `DESIGN.md`（Google design.md 规范）
- i18n：`frontend/src/lib/i18n/locales/{zh,en}.json`，面板长文案逐步迁移
- 自动更新签名：`src-tauri/.signing/devdeck_updater.key`（本地生成，密码 `devdeck-updater-pass`），公钥在 `tauri.conf.json`
- Sentry：设置环境变量 `DEVDDECK_SENTRY_DSN` 后构建即可启用崩溃上报

## License

MIT（待定）
