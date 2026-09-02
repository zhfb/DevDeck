# DevDeck

> 暂定代号：~~MacCloud Workspace~~ → **DevDeck**

macOS 原生高效远程连接与容器管理工具 —— SSH 远程终端 / SFTP 文件管理 / Docker·Podman 容器生态 / 端口隧道，一体化工作台。

基于 **Tauri v2 + Rust 异步生态** 构建，媲美原生应用的性能与低功耗，全面剥离 Electron 的高功耗负担。

## 技术栈

```
UI 层      Tauri v2 Web · React 18 · TypeScript · Tailwind CSS · Shadcn UI · xterm.js (WebGL) · Zustand · TanStack Query
核心层     Rust · Tokio · russh / russh-sftp · bollard (Docker/Podman) · rusqlite (SQLite WAL)
系统层     macOS Keychain · Dispatch QoS · NSProcessInfo App Nap 豁免 · Tauri 托盘
```

> 说明：K8s / VM 运行时不在当前范围（防蔓延决策，详见 `docs/` 技术评审）；Virtualization.fw 未使用。

## 功能规划

**已实现（V1.0）**

- **远程与终端**：SSH 2.0（口令/私钥/Keychain/ssh-agent）、PTY 分屏、known_hosts TOFU、keepalive 自动重连、会话级事件流
- **SFTP**：双栏文件管理、目录操作、传输队列（并发 4–8）、断点续传、递归目录传输、取消与失败重试
- **隧道**：Local / Remote 端口转发、隧道命名与启用状态、实时流量统计（每隧道入/出字节）
- **容器管理**：Docker/Podman 引擎探测（OrbStack / Docker Desktop / Colima / Podman）、容器生命周期与批量操作、一键容器 Exec 终端、镜像拉取进度、**运行新容器表单**（端口映射）、卷/网络的创建与删除、Docker `/events` 自愈转发 + snapshot 补偿
- **主机能力**：主机分组与环境色卡、无 Agent 监控（CPU/Disk/RAM，前端 + 后台采样）、**主机进程查看**（复用活跃 SSH 会话执行 `ps`）
- **效率**：**Snippets 常用命令库**（一键插入活动终端）、Cmd+K 命令面板、任务队列面板、事件流面板
- **节能与系统**：Active / Background / Idle 低功耗状态机 + 后端采样调度、Docker 事件低功耗批处理、SFTP 传输期间 App Nap 豁免、macOS 托盘菜单、Keychain 密钥保险箱、SQLite 持久化

**规划中（V1.1 及以后）**

- 远程 Docker over SSH（SSH 隧道桥接 docker.sock）、跳板机、事件驱动端口转发、会话录制（asciinema）、广播终端、Compose 支持、卷挂载查看、Snippets 变量替换、配置导入导出、闲置自动锁
- 自动更新（tauri-plugin-updater）、崩溃上报（Sentry）、性能/能耗基线 CI、Universal Binary + 公证 + MVP 发布
- SOCKS5 动态转发、ZMODEM、会话复用、本地终端、TOTP 2FA、sudo 密码提示、MCP Server、i18n 中英双语

**明确不做**：K8s 全套、VM 运行时 / USB 透传 / x86 模拟、OrbStack UI 风格、团队协作（V2 再评估）

## 目录结构

```
DevDeck/
├── DESIGN.md       # 设计 token 规范（Google design.md）
├── src-tauri/      # Tauri v2 + Rust 核心层（SSH/Docker/Tunnel/Stats/Power + SQLite/Keychain）
│   ├── capabilities/
│   └── src/
│       ├── commands.rs    # Tauri invoke 命令（前端契约，48+ 命令）
│       ├── services/      # ssh / docker / sftp / tunnel / stats / power / hostkey / macos_power
│       ├── infra/         # db (SQLite) / keychain
│       ├── models.rs      # serde 契约模型（camelCase）
│       └── tray.rs        # macOS 托盘
├── frontend/       # React 前端（导航栏 / 资源树 / Tab 画布 / 底部面板 / xterm）
│   └── src/
│       ├── app/          # 应用外壳（NavRail / ResourceTree / TabCanvas / BottomDock / Cmd+K / TerminalView）
│       ├── features/     # 管理面板（容器/镜像/卷/网络/主机/SFTP/隧道/监控/片段/任务/设置/Dashboard）
│       ├── stores/       # workspace / live / power（Zustand）
│       └── lib/          # API 双模层 / queries / types / terminalBus
├── docs/           # 内部设计/评审文档（本地维护，不入库）
└── scripts/        # 构建与 CI 辅助脚本
```

## 开发状态

- [x] 技术方案评审与补全（`docs/`，本地维护不入库）
- [x] DESIGN.md 设计系统（token 规范，design-md lint 通过）
- [x] 前端骨架：布局框架（导航栏/资源树/Tab 画布/底部面板/Cmd+K）+ 组件库 + API 双模层
- [x] 管理面板：容器 / 镜像 / 卷 / 网络 / 主机 / 监控 / 隧道 / 片段 / Dashboard / 设置 / 详情页（mock 数据可完整演示）
- [x] Rust 核心层：Docker 引擎探测 + 容器/镜像操作（bollard）、SSH 会话（russh）、SQLite、Keychain
- [x] SSH PTY 事件桥接、known_hosts TOFU、keepalive、自动重连
- [x] Docker events 自愈转发、snapshot 补偿、镜像拉取任务进度
- [x] Phase 2: SFTP 双栏、目录操作、传输队列、进度和断点 offset
- [x] 本地容器 exec attach 和实时日志流基础链路
- [x] Phase 3: 隧道真实转发（Local/Remote）+ 无 Agent 监控后台采样
- [x] Phase 4（部分）: 低功耗后端调度 + 前端自适应刷新策略；App Nap 豁免（SFTP 传输）
- [x] Phase 5（部分）: 托盘菜单；release 工作流与 entitlements 已就绪
- [x] 运行新容器表单（containers.create）
- [x] 卷 / 网络创建删除（volumes.create/remove · networks.create/remove）
- [x] 主机进程查看（host.processes）
- [x] Snippets 常用命令库（snippets.list/save/delete + 插入活动终端）
- [x] 端口转发实时流量统计
- [ ] Phase 4（剩余）: 能耗基线、测试加固补全
- [ ] Phase 5（剩余）: Universal Binary + 公证 + MVP 发布（含自动更新）

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

## License

MIT（待定）
