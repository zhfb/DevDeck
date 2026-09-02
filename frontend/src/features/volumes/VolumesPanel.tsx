import { useState } from "react";
import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useVolumes, useVolumeAction } from "@/lib/queries";
import { formatBytes } from "@/lib/utils";
import type { DockerVolume } from "@/lib/types";
import { EmptyState } from "@/components/shared";
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
  const volumeAction = useVolumeAction();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDriver, setNewDriver] = useState("local");
  const [confirmDelete, setConfirmDelete] = useState<DockerVolume | null>(null);

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
      { action: "create", name: newName.trim() },
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
