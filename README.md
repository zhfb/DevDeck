# DevDeck

> 暂定代号：~~MacCloud Workspace~~ → **DevDeck**

macOS 原生高效远程连接与容器管理工具 —— SSH 远程终端 / SFTP 文件管理 / Docker·Podman 容器生态 / K8s 集群管理 / 端口隧道，一体化工作台。

基于 **Tauri v2 + Rust 异步生态** 构建，媲美原生应用的性能与低功耗，全面剥离 Electron 的高功耗负担。

## 技术栈

```
UI 层      Tauri v2 Web · React 18 · TypeScript · Tailwind CSS · Shadcn UI · xterm.js (WebGL)
核心层     Rust · Tokio · russh / russh-sftp · bollard · kube-rs
系统层     macOS Keychain · Dispatch QoS · App Nap 豁免 · Virtualization.fw
```

## 功能规划

- **远程与终端**：SSH 2.0 / 分屏 / 广播终端；SFTP 双栏传输与在线编辑；端口转发（Local / Remote / SOCKS5）
- **资产管理**：主机分组与 Dev/Staging/Prod 环境色卡隔离；无 Agent 性能监控（CPU/Disk/RAM）；macOS Keychain 密钥保险箱
- **容器管理**：Docker/Podman 生命周期与镜像/卷控制；一键容器 Exec 终端；60FPS 高频日志追踪；K8s 多 Context 切换与 Pod Port-Forward
- **节能与系统**：App Nap & QoS 能效调度；Docker `/events` 增量事件驱动；Menu Bar 快捷连接与隧道控制

## 目录结构

```
DevDeck/
├── DESIGN.md       # 设计 token 规范（Google design.md）
├── src-tauri/      # Tauri v2 + Rust 核心层（SSH/Docker/Tunnel/Stats + SQLite/Keychain）
│   └── src/
│       ├── commands.rs    # Tauri invoke 命令（前端契约）
│       ├── services/      # DockerManager / SshManager / TunnelManager / StatsCollector
│       └── infra/         # SQLite / Keychain
├── frontend/       # React 前端（三栏布局 / Tab / 分屏 / xterm）
│   └── src/
│       ├── app/          # 应用外壳（NavRail / ResourceTree / TabCanvas / BottomDock / Cmd+K）
│       ├── features/     # 管理面板（容器/主机/镜像/隧道/监控/设置/Dashboard）
│       └── lib/          # API 双模层 / queries / types
├── docs/           # 内部设计/评审文档（本地维护，不入库）
└── scripts/        # 构建与 CI 辅助脚本
```

## 开发状态

- [x] 技术方案评审与补全（`docs/`，本地维护不入库）
- [x] DESIGN.md 设计系统（token 规范，design-md lint 通过）
- [x] 前端骨架：布局框架（导航栏/资源树/Tab 画布/底部面板/Cmd+K）+ 组件库 + API 双模层
- [x] 管理面板：容器 / 镜像 / 主机 / 监控 / 隧道 / Dashboard / 设置 / 详情页（mock 数据可完整演示）
- [x] Rust 核心层：Docker 引擎探测 + 容器/镜像操作（bollard）、SSH 会话（russh）、SQLite、Keychain 骨架
- [ ] Phase 1: SSH 终端 PTY 事件桥接 + known_hosts TOFU + Keychain 接入命令
- [ ] Phase 2: SFTP 双栏 + 远程 Docker over SSH + 容器 exec 终端
- [ ] Phase 3: 隧道真实转发 + 无 Agent 监控轮询 + 节能引擎 + 测试加固
- [ ] Phase 4: 托盘 + 打包公证 + MVP 发布

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
