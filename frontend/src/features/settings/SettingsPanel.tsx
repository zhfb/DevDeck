import { useState } from "react";
import { Database, Download, RefreshCw, Settings, Shield, SlidersHorizontal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n, { setLanguage, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { invoke } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useEngines } from "@/lib/queries";
import { useUi } from "@/stores/workspace";
import { EngineBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

/**
 * 设置页 — 通用 / 容器引擎 / 安全 / 高级 / 危险区。
 * 规格：docs/管理面板规划.md §7
 */
export default function SettingsPanel(_props: PanelProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useUi();
  const { data: engines } = useEngines();

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
  const [idleLock, setIdleLock] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState(true);
  const [eventForward, setEventForward] = useState(false);
  const [throttleState, setThrottleState] = useState(true);

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

        {/* 安全 */}
        <SettingSection icon={Shield} title="安全" description="凭据仅存 macOS Keychain，数据库只存引用">
          <SettingRow title="known_hosts TOFU 校验" description="首次连接校验主机指纹，防止中间人攻击">
            <Switch checked={tofuVerify} onCheckedChange={setTofuVerify} />
          </SettingRow>
          <SettingRow title="闲置自动锁定" description="长时间无操作自动锁定界面（V1.1）">
            <Switch checked={idleLock} onCheckedChange={setIdleLock} />
          </SettingRow>
          <SettingRow title="危险操作二次确认" description="删除 / 清空等操作需二次确认">
            <Switch checked={dangerConfirm} onCheckedChange={setDangerConfirm} />
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
            <SettingRow title="导出配置 JSON" description="导出全部配置，不含密钥">
              <Button variant="secondary" size="sm" onClick={() => toast.success("配置已导出（不含密钥）")}>
                <Download /> 导出
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
