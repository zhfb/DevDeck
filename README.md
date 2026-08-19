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
├── src/            # Rust 核心层（SSH/SFTP/Docker/K8s/Tunnel/Stats）
├── src-tauri/      # Tauri v2 配置与 capabilities
├── frontend/       # React 前端（三栏布局 / Tab / 分屏 / xterm）
├── docs/           # 内部设计/评审文档（本地维护，不入库）
└── scripts/        # 构建与 CI 辅助脚本
```

## 开发状态

- [x] 技术方案评审与补全（`docs/`）
- [ ] Phase 0: POC 验证（russh / bollard / xterm 三件套 spike）
- [ ] Phase 1: 骨架 + SSH 终端 + Keychain
- [ ] Phase 2: SFTP + Docker 容器管理
- [ ] Phase 3: 隧道 + 节能引擎 + 测试加固
- [ ] Phase 4: 托盘 + 打包公证 + MVP 发布

## License

MIT（待定）
