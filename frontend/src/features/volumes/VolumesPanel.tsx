import { useState, useMemo } from "react";
import { ArrowUpRight, Boxes, Container, Database, Eye, Info, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useVolumes, useVolumeAction, useContainers, useEngines } from "@/lib/queries";
import { formatBytes } from "@/lib/utils";
import type { DockerVolume } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Docker volumes panel (P1: 卷管理创建/删除) — 功能清单 P1「卷管理完整」 */
export default function VolumesPanel(_props: PanelProps) {
  const { data: volumes, isLoading, isFetching, refetch } = useVolumes();
  const { data: containers } = useContainers();
  const { data: engines } = useEngines();
  const volumeAction = useVolumeAction();
  const { requestRunWithVolumes, openTab } = useWorkspace();

  const targetEngineId = engines?.[0]?.id;

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDriver, setNewDriver] = useState("local");
  const [newOpts, setNewOpts] = useState<{ key: string; value: string }[]>([]);
  const [newLabels, setNewLabels] = useState<{ key: string; value: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DockerVolume | null>(null);
  const [detail, setDetail] = useState<DockerVolume | null>(null);

  // 反查：哪些容器挂载了该卷（mounts.type === "volume" 且 source === 卷名）
  const volumeUsers = useMemo(() => {
    if (!detail || !containers) return [];
    return containers
      .filter((c) =>
        (c.mounts ?? []).some(
          (m) => m.type === "volume" && m.source === detail.name
        )
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        engineId: c.engineId,
        mountPoint: (c.mounts ?? []).find(
          (m) => m.type === "volume" && m.source === detail.name
        )?.destination,
      }));
  }, [detail, containers]);

  const runDelete = (v: DockerVolume) => {
    volumeAction.mutate(
      { action: "remove", name: v.name },
      {
        onSuccess: () => toast.success(`已删除卷 ${v.name}`),
        onError: (e) => toast.error(`删除卷 ${v.name} 失败`, { description: String(e) }),
      }
    );
    setConfirmDelete(null);
  };

  const submitCreate = () => {
    if (!newName.trim()) return;
    const driverOpts = newOpts
      .filter((o) => o.key.trim())
      .reduce<Record<string, string>>((acc, o) => {
        acc[o.key.trim()] = o.value.trim();
        return acc;
      }, {});
    const labels = newLabels
      .filter((l) => l.key.trim())
      .reduce<Record<string, string>>((acc, l) => {
        acc[l.key.trim()] = l.value.trim();
        return acc;
      }, {});
    volumeAction.mutate(
      {
        action: "create",
        name: newName.trim(),
        driver: newDriver.trim() || undefined,
        engineId: targetEngineId,
        driverOpts: Object.keys(driverOpts).length ? driverOpts : undefined,
        labels: Object.keys(labels).length ? labels : undefined,
      },
      {
        onSuccess: () => {
          toast.success(`已创建卷 ${newName.trim()}`);
          setCreateOpen(false);
          setNewName("");
          setNewOpts([]);
          setNewLabels([]);
        },
        onError: (e) => toast.error("创建卷失败", { description: String(e) }),
      }
    );
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "animate-spin" : ""} />
          刷新
        </Button>
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          新建卷
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && !volumes ? (
          <div className="p-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border-subtle px-2.5 py-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        ) : !volumes || volumes.length === 0 ? (
          <EmptyState
            icon={Database}
            title="暂无卷"
            description="本地引擎没有命名卷"
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建卷
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead>驱动</TableHead>
                <TableHead>挂载点</TableHead>
                <TableHead>范围</TableHead>
                <TableHead className="w-20 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {volumes.map((v) => (
                <TableRow key={v.id || v.name}>
                  <TableCell>
                    <span className="mono text-[13px]">{v.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-secondary">{v.driver}</span>
                  </TableCell>
                  <TableCell>
                    <span className="mono-caption block max-w-72 truncate text-secondary" title={v.mountpoint}>
                      {v.mountpoint || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-secondary">{v.scope}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="用此卷运行容器"
                        className="text-muted hover:bg-active-fill hover:text-foreground"
                        onClick={() => requestRunWithVolumes([{ name: v.name }])}
                      >
                        <Container />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="详情"
                        className="text-muted hover:bg-active-fill hover:text-foreground"
                        onClick={() => setDetail(v)}
                      >
                        <Eye />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="删除"
                        className="text-muted hover:bg-danger-tint hover:text-danger"
                        onClick={() => setConfirmDelete(v)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 卷详情：被哪些容器挂载 */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-accent" />
              {detail?.name}
            </DialogTitle>
            <DialogDescription>卷详情与挂载关系</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-border-subtle bg-surface p-3 text-[12.5px]">
                <div className="flex flex-col gap-1">
                  <span className="text-muted">驱动</span>
                  <span className="font-medium text-foreground">{detail.driver || "—"}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted">范围</span>
                  <span className="font-medium text-foreground">{detail.scope || "—"}</span>
                </div>
                <div className="col-span-2 flex flex-col gap-1">
                  <span className="text-muted">挂载点</span>
                  <span className="mono break-all text-[12px] text-foreground">
                    {detail.mountpoint || "—"}
                  </span>
                </div>
                {detail.created && (
                  <div className="col-span-2 flex flex-col gap-1">
                    <span className="text-muted">创建时间</span>
                    <span className="font-medium text-foreground">{detail.created}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <Boxes className="h-3.5 w-3.5 text-accent" />
                  被以下容器挂载
                  <Badge variant="secondary" className="ml-auto">
                    {volumeUsers.length}
                  </Badge>
                </div>
                {volumeUsers.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-muted">
                    暂无容器挂载此卷
                  </div>
                ) : (
                  <div className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                    {volumeUsers.map((u) => (
                      <div key={u.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${u.state === "running" ? "bg-[#34c759]" : "bg-muted"}`} />
                        <button
                          type="button"
                          className="mono inline-flex max-w-44 items-center gap-1 truncate font-medium text-foreground hover:text-accent"
                          onClick={() => {
                            openTab({
                              kind: "container-detail",
                              title: u.name,
                              containerId: u.id,
                              engineId: u.engineId,
                              env: "none",
                            });
                          }}
                        >
                          {u.name}
                          <ArrowUpRight className="h-3 w-3 shrink-0" />
                        </button>
                        <Badge variant="outline" className="ml-auto shrink-0 text-[10.5px]">
                          {u.state}
                        </Badge>
                        <span className="mono-caption max-w-40 truncate text-muted" title={u.mountPoint}>
                          {u.mountPoint || ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除卷</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除卷 {confirmDelete?.name}？卷内数据将永久丢失，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-danger hover:bg-danger" onClick={() => confirmDelete && runDelete(confirmDelete)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建卷</DialogTitle>
            <DialogDescription>
              命名卷由 Docker 引擎统一管理，数据保存在引擎虚拟机的 /var/lib/docker/volumes 下。卷大小由底层磁盘决定，Docker 不在创建时指定大小。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>卷名称</Label>
              <Input placeholder="例如 postgres-data" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>驱动（可选，默认 local）</Label>
              <Input placeholder="local" value={newDriver} onChange={(e) => setNewDriver(e.target.value)} />
              <p className="text-[11.5px] leading-relaxed text-muted">
                需要限制大小的场景可换驱动或加选项，如 local 配合 tmpfs：类型填 tmpfs、选项填 size=1g（内存盘）。
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>驱动选项 driver-opts（可选）</Label>
              <div className="grid gap-1.5">
                {newOpts.map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      placeholder="type"
                      className="w-28 font-mono text-[12px]"
                      value={o.key}
                      onChange={(e) =>
                        setNewOpts(newOpts.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                      }
                    />
                    <Input
                      placeholder="值，如 tmpfs"
                      value={o.value}
                      onChange={(e) =>
                        setNewOpts(newOpts.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                      }
                    />
                    <Button variant="ghost" size="icon-sm" onClick={() => setNewOpts(newOpts.filter((_, j) => j !== i))}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={() => setNewOpts([...newOpts, { key: "", value: "" }])}
                >
                  <Plus className="h-3.5 w-3.5" /> 添加选项
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>标签 labels（可选）</Label>
              <div className="grid gap-1.5">
                {newLabels.map((l, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      placeholder="key"
                      className="w-28 font-mono text-[12px]"
                      value={l.key}
                      onChange={(e) =>
                        setNewLabels(newLabels.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                      }
                    />
                    <Input
                      placeholder="value"
                      value={l.value}
                      onChange={(e) =>
                        setNewLabels(newLabels.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                      }
                    />
                    <Button variant="ghost" size="icon-sm" onClick={() => setNewLabels(newLabels.filter((_, j) => j !== i))}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={() => setNewLabels([...newLabels, { key: "", value: "" }])}
                >
                  <Plus className="h-3.5 w-3.5" /> 添加标签
                </Button>
              </div>
            </div>

            <div className="flex gap-2 rounded-lg border border-border-subtle bg-surface p-2.5 text-[11.5px] leading-relaxed text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                为什么没有「大小 / 位置」：Docker 命名卷的大小由引擎所在磁盘决定，位置固定在引擎卷目录——这是 Docker 的安全与隔离设计，桌面工具（Docker Desktop 等）同样不提供。需要限制容量时，请改用挂载宿主机目录（自定义路径），或在选项里用 tmpfs + size 创建内存盘。
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!newName.trim()} onClick={submitCreate}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
