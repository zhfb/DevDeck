import { useState, useMemo } from "react";
import { Boxes, Database, Eye, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useVolumes, useVolumeAction, useContainers } from "@/lib/queries";
import { formatBytes } from "@/lib/utils";
import type { DockerVolume } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
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
  const volumeAction = useVolumeAction();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDriver, setNewDriver] = useState("local");
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
        name: c.name,
        state: c.state,
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
    volumeAction.mutate(
      { action: "create", name: newName.trim(), driver: newDriver.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`已创建卷 ${newName.trim()}`);
          setCreateOpen(false);
          setNewName("");
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
                      <div key={u.name} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${u.state === "running" ? "bg-[#34c759]" : "bg-muted"}`} />
                        <span className="mono truncate font-medium text-foreground">{u.name}</span>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建卷</DialogTitle>
            <DialogDescription>在本地引擎创建 Docker 命名卷。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>卷名称</Label>
              <Input placeholder="例如 postgres-data" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>驱动（可选，默认 local）</Label>
              <Input placeholder="local" value={newDriver} onChange={(e) => setNewDriver(e.target.value)} />
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
