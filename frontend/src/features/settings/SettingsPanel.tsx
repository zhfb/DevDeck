import { useState, useEffect, useRef } from "react";
import { Box, Copy, Database, Download, Play, RefreshCw, Settings, Shield, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n, { setLanguage, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { invoke } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useEngines, useIdleLockConfig, useIdleLockConfigSet, useSudoConfig, useSudoConfigSet } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/stores/workspace";
import { EngineBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { EmbeddedStatus } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";

/** 设置分节 Card：label-caps 标题 + 说明 + 控件区 */
function SettingSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-1 px-4 pt-3.5">
        <div className="label-caps flex items-center gap-1.5">
          <Icon className="h-3 w-3" />
          {title}
        </div>
        <p className="text-[12px] text-muted">{description}</p>
      </div>
      <div className="flex flex-col px-4 pb-4 pt-2">{children}</div>
    </Card>
  );
}

/** 设置行：左标题/说明 + 右控件 */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border-subtle py-2.5 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{title}</div>
        {description && <div className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** MCP Server 本地引擎 socket 路径（提示用） */
const mcpSocketPath = "~/.lima/devdeck/sock/docker.sock";

/**
 * 设置页 — 通用 / 容器引擎 / 安全 / 高级 / 危险区。
 * 规格：docs/管理面板规划.md §7
 */
export default function SettingsPanel(_props: PanelProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useUi();
  const { data: engines } = useEngines();
  const queryClient = useQueryClient();

  // 内置 Docker 引擎
  const [emb, setEmb] = useState<EmbeddedStatus | null>(null);
  const [embLoading, setEmbLoading] = useState(false);
  const refreshEmbedded = async () => {
    setEmbLoading(true);
    try {
      setEmb(await invoke<EmbeddedStatus>("embedded_status"));
    } catch (e) {
      toast.error("读取内置引擎状态失败", { description: String(e) });
    } finally {
      setEmbLoading(false);
    }
  };
  const startEmbedded = async () => {
    setEmbLoading(true);
    try {
      const st = await invoke<EmbeddedStatus>("embedded_start");
      setEmb(st);
      if (st.engineConnected) {
        toast.success("内置 Docker 引擎已就绪");
      } else {
        toast.warning(st.error ?? "内置引擎未就绪");
      }
    } catch (e) {
      toast.error("启动内置引擎失败", { description: String(e) });
    } finally {
      setEmbLoading(false);
    }
  };
  const stopEmbedded = async () => {
    setEmbLoading(true);
    try {
      setEmb(await invoke<EmbeddedStatus>("embedded_stop"));
      toast.success("内置引擎已停止");
    } catch (e) {
      toast.error("停止内置引擎失败", { description: String(e) });
    } finally {
      setEmbLoading(false);
    }
  };
  const resetEmbedded = async () => {
    setEmbLoading(true);
    try {
      setEmb(await invoke<EmbeddedStatus>("embedded_reset"));
      toast.success("内置引擎已重置");
    } catch (e) {
      toast.error("重置内置引擎失败", { description: String(e) });
    } finally {
      setEmbLoading(false);
    }
  };
  // 首次渲染后自动读取一次内置引擎状态
  useEffect(() => {
    void refreshEmbedded();
  }, []);

  // 自动更新
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean;
    currentVersion: string;
    version: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await invoke<{
        available: boolean;
        currentVersion: string;
        version: string;
      }>("updater_check");
      setUpdateInfo(info);
      toast.success(info.available ? `发现新版本 v${info.version}` : "已是最新版本");
    } catch (e) {
      toast.error("检查更新失败", { description: String(e) });
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    setInstalling(true);
    try {
      const msg = await invoke<string>("updater_install");
      toast.success(msg);
    } catch (e) {
      toast.error("安装更新失败", { description: String(e) });
    } finally {
      setInstalling(false);
    }
  };

  // 占位开关状态
  const [openDashboardOnLaunch, setOpenDashboardOnLaunch] = useState(false);
  const [tofuVerify, setTofuVerify] = useState(true);
  const [dangerConfirm, setDangerConfirm] = useState(true);
  const [eventForward, setEventForward] = useState(false);
  const [throttleState, setThrottleState] = useState(true);

  // ---- 配置导入 / 导出（不含密钥本体）----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // ---- 闲置自动锁 ----
  const { data: idleCfg } = useIdleLockConfig();
  const idleLockSave = useIdleLockConfigSet();
  const [idlePin, setIdlePin] = useState("");

  // ---- SSH sudo 自动填充 ----
  const { data: sudoCfg } = useSudoConfig();
  const sudoSave = useSudoConfigSet();

  const saveIdleLock = (patch: {
    enabled?: boolean;
    timeoutMinutes?: number;
    useTouchId?: boolean;
    pin?: string | null;
  }) => {
    idleLockSave.mutate(
      {
        enabled: patch.enabled ?? idleCfg?.enabled ?? false,
        timeoutMinutes: patch.timeoutMinutes ?? idleCfg?.timeoutMinutes ?? 10,
        useTouchId: patch.useTouchId ?? idleCfg?.useTouchId ?? false,
        pin: patch.pin,
      },
      {
        onSuccess: () => {
          if (patch.pin) toast.success("解锁 PIN 已更新");
          setIdlePin("");
        },
        onError: (e) => toast.error("保存失败", { description: String(e) }),
      }
    );
  };

  const doExport = async () => {
    try {
      const bundle = await invoke<Record<string, unknown>>("config.export");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `devdeck-config-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("配置已导出（不含密钥）", {
        description: "导入到新机器后需重新填写各凭据",
      });
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      setImporting(true);
      await invoke("config.import", { bundle });
      toast.success("配置导入成功", {
        description: "主机 / 分组 / 隧道 / 片段 / 镜像仓库已恢复",
      });
      // 刷新受影响的数据
      for (const key of [
        "host-groups",
        "hosts",
        "tunnels",
        "snippets",
        "registries",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    } catch (e) {
      toast.error("导入失败", { description: String(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-5">
        <header className="flex flex-col gap-0.5">
          <h1 className="text-[17px] font-semibold tracking-tight text-foreground">设置</h1>
          <p className="text-[12px] text-muted">偏好、引擎与安全配置</p>
        </header>

        {/* 通用 */}
        <SettingSection icon={Settings} title="通用" description="界面与启动偏好">
          <SettingRow title="主题" description="切换深色 / 浅色外观">
            <div className="w-40">
              <Select value={theme} onValueChange={(v) => setTheme(v as "dark" | "light")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">深色</SelectItem>
                  <SelectItem value="light">浅色</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingRow>
          <SettingRow title="语言" description={t("settings.languageHint")}>
            <div className="w-40">
              <Select
                value={i18n.language?.startsWith("en") ? "en" : "zh"}
                onValueChange={(v) => setLanguage(v as "zh" | "en")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingRow>
          <SettingRow title="启动时打开总览" description="应用启动后自动打开总览页">
            <Switch checked={openDashboardOnLaunch} onCheckedChange={setOpenDashboardOnLaunch} />
          </SettingRow>
        </SettingSection>

        {/* 容器引擎 */}
        <SettingSection
          icon={Database}
          title="容器引擎"
          description="自动探测 OrbStack / Docker Desktop / Colima / Podman"
        >
          <div className="flex flex-col gap-2">
            {engines?.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2"
              >
                <span
                  className={cn("dot shrink-0", e.reachable ? "bg-success" : "bg-danger")}
                  title={e.reachable ? "可达" : "不可达"}
                />
                <span className="truncate text-[13px] font-medium text-foreground">{e.name}</span>
                <EngineBadge kind={e.kind} />
                <span className="mono-caption ml-auto shrink-0 truncate text-quaternary">{e.endpoint}</span>
              </div>
            ))}
            {!engines?.length && (
              <div className="rounded-md border border-dashed border-border-subtle px-3 py-4 text-center text-[12px] text-quaternary">
                正在探测本地 Docker 引擎…
              </div>
            )}
          </div>
        </SettingSection>

        {/* 内置 Docker 引擎（DevDeck 自管 Lima vz + dockerd） */}
        <SettingSection
          icon={Box}
          title="内置 Docker 引擎"
          description="DevDeck 自管的 Linux 虚拟机（Apple 原生虚拟化 + 真 dockerd），不依赖 OrbStack / Docker Desktop / Colima"
        >
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2.5">
              <span
                className={cn(
                  "dot shrink-0",
                  emb?.engineConnected ? "bg-success" : emb?.running ? "bg-warning" : "bg-quaternary"
                )}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground">
                    内置引擎 · {emb?.machine ?? "devdeck"}
                  </span>
                  {emb?.dockerVersion && <EngineBadge kind="embedded" />}
                </div>
                <span className="mono-caption truncate text-quaternary">
                  {emb?.socket ?? "~/.lima/devdeck/sock/docker.sock"}
                </span>
              </div>
              {embLoading ? (
                <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted" />
              ) : emb?.engineConnected ? (
                <span className="shrink-0 text-[12px] text-success">已连接 · v{emb.dockerVersion}</span>
              ) : (
                <span className="shrink-0 text-[12px] text-muted">
                  {emb?.running
                    ? "运行中…"
                    : emb?.installed
                      ? emb.machineCreated
                        ? "已创建 · 未运行"
                        : "未创建"
                      : "未安装 limactl"}
                </span>
              )}
            </div>

            {emb?.error && (
              <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] leading-relaxed text-danger">
                {emb.error}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void startEmbedded()} disabled={embLoading}>
                <Play /> 启动
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void stopEmbedded()}
                disabled={embLoading || !emb?.running}
              >
                <Square /> 停止
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void refreshEmbedded()} disabled={embLoading}>
                <RefreshCw /> 刷新
              </Button>
              <div className="ml-auto" />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="danger" size="sm" disabled={embLoading}>
                    <Trash2 /> 重置
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>重置内置引擎？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将删除内置引擎的虚拟机与全部数据（镜像、容器、卷），需要重新初始化。此操作不可恢复。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void resetEmbedded()}>重置</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            <p className="text-[12px] leading-relaxed text-muted">
              首次启动会下载 Ubuntu 镜像并初始化 Docker（约 1-2 分钟），之后冷启动仅需数秒。引擎就绪后应用自动接管
              <code className="mx-1 rounded bg-hover-fill px-1 mono-caption">~/.lima/devdeck/sock/docker.sock</code>
              ，容器操作无需外部引擎。也可在终端使用：
              <code className="mx-1 rounded bg-hover-fill px-1 mono-caption">export DOCKER_HOST=unix://~/.lima/devdeck/sock/docker.sock</code>
            </p>
          </div>
        </SettingSection>

        {/* 安全 */}
        <SettingSection icon={Shield} title="安全" description="凭据仅存 macOS Keychain，数据库只存引用">
          <SettingRow title="known_hosts TOFU 校验" description="首次连接校验主机指纹，防止中间人攻击">
            <Switch checked={tofuVerify} onCheckedChange={setTofuVerify} />
          </SettingRow>
          <SettingRow title="闲置自动锁定" description="无操作 N 分钟自动锁定界面，需 PIN 解锁">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-secondary">{idleCfg?.timeoutMinutes ?? 10} 分钟</span>
              <Switch
                checked={idleCfg?.enabled ?? false}
                onCheckedChange={(v) => saveIdleLock({ enabled: !!v })}
              />
            </div>
          </SettingRow>
          {(idleCfg?.enabled ?? false) && (
            <>
              <SettingRow title="锁定等待时间" description="无操作多久后自动锁定">
                <Select
                  value={String(idleCfg?.timeoutMinutes ?? 10)}
                  onValueChange={(v) => saveIdleLock({ timeoutMinutes: Number(v) })}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 5, 10, 15, 30, 60].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} 分钟
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title="解锁 PIN"
                description={idleCfg?.hasPin ? "已设置 PIN，输入新 PIN 可修改" : "未设置 PIN（锁定后无法解锁）"}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="6-16 位 PIN"
                    value={idlePin}
                    onChange={(e) => setIdlePin(e.target.value)}
                    className="w-36"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={idlePin.length < 4}
                    onClick={() => saveIdleLock({ pin: idlePin })}
                  >
                    保存
                  </Button>
                </div>
              </SettingRow>
            </>
          )}
          <SettingRow title="危险操作二次确认" description="删除 / 清空等操作需二次确认">
            <Switch checked={dangerConfirm} onCheckedChange={setDangerConfirm} />
          </SettingRow>
          <SettingRow
            title="SSH sudo 密码自动填充"
            description="SSH 会话出现 sudo 密码提示时，自动填入连接时使用的密码（可关闭）"
          >
            <Switch
              checked={sudoCfg ?? true}
              onCheckedChange={(v) => sudoSave.mutate(!!v, { onError: (e) => toast.error("保存失败", { description: String(e) }) })}
            />
          </SettingRow>
        </SettingSection>

        {/* 高级 */}
        <SettingSection icon={SlidersHorizontal} title="高级" description="实验性行为与性能调优">
          <SettingRow
            title="事件驱动端口转发"
            description="监听容器端口自动暴露 localhost，默认关闭防意外暴露"
          >
            <Switch checked={eventForward} onCheckedChange={setEventForward} />
          </SettingRow>
          <SettingRow title="降载状态机" description="后台 Tab 零渲染 / 降采样">
            <Switch checked={throttleState} onCheckedChange={setThrottleState} />
          </SettingRow>
          <SettingRow
            title="MCP Server（AI 接入）"
            description="让 Claude Code / Cursor 等通过 MCP 连接本地 Docker 引擎"
          >
            <div className="flex flex-col items-end gap-2">
              <code className="mono-caption rounded bg-active-fill px-2 py-1 text-[11.5px] text-secondary">
                {mcpSocketPath}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  navigator.clipboard
                    .writeText(
                      `claude mcp add devdeck -- bash -lc 'DEVDeck_DOCKER_SOCKET=${mcpSocketPath} <devdeck-mcp可执行路径>'`
                    )
                    .then(() => toast.success("Claude Code 配置已复制"));
                }}
              >
                <Copy />
                复制 Claude Code 配置
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            title="自动更新"
            description={updateInfo ? `当前 v${updateInfo.currentVersion} · ${updateInfo.available ? `发现新版本 v${updateInfo.version}` : "已是最新版本"}` : "检查 GitHub Release 并安装"}
          >
            <div className="flex items-center gap-2">
              {updateInfo?.available && (
                <Button variant="secondary" size="sm" onClick={() => void installUpdate()} disabled={installing}>
                  {installing ? "安装中…" : "安装更新"}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => void checkUpdate()} disabled={checking || installing}>
                <RefreshCw className={cn(checking && "animate-spin")} />
                检查更新
              </Button>
            </div>
          </SettingRow>
        </SettingSection>

        {/* 危险区 */}
        <Card className="border-danger/30">
          <div className="flex flex-col gap-1 px-4 pt-3.5">
            <div className="label-caps text-danger">危险区</div>
            <p className="text-[12px] text-muted">以下操作影响本地数据，请谨慎执行</p>
          </div>
          <div className="flex flex-col px-4 pb-4 pt-2">
            <SettingRow title="导出配置 JSON" description="导出全部配置，不含密钥（凭据仅保留引用）">
              <Button variant="secondary" size="sm" onClick={doExport}>
                <Download /> 导出
              </Button>
            </SettingRow>
            <SettingRow title="导入配置 JSON" description="恢复主机 / 分组 / 隧道 / 片段 / 镜像仓库">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                  e.target.value = "";
                }}
              />
              <Button variant="secondary" size="sm" disabled={importing} onClick={() => fileInputRef.current?.click()}>
                {importing ? "导入中…" : "导入"}
              </Button>
            </SettingRow>
            <SettingRow title="清空本地数据" description="删除缓存与本地状态，不可恢复">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="danger" size="sm">
                    <Trash2 /> 清空
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认清空本地数据？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将删除缓存、会话历史与本地状态。此操作不可恢复。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => toast.success("已清空（演示）")}>清空</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </SettingRow>
          </div>
        </Card>
      </div>
    </div>
  );
}
