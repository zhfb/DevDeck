import { useState } from "react";
import { Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useNetworks, useNetworkAction } from "@/lib/queries";
import type { DockerNetwork } from "@/lib/types";
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

/** Docker networks panel (P2: 网络创建/删除) — 功能清单 P2「网络管理完整」 */
export default function NetworksPanel(_props: PanelProps) {
  const { data: networks, isLoading, isFetching, refetch } = useNetworks();
  const networkAction = useNetworkAction();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDriver, setNewDriver] = useState("bridge");
  const [confirmDelete, setConfirmDelete] = useState<DockerNetwork | null>(null);

  const runDelete = (n: DockerNetwork) => {
    networkAction.mutate(
      { action: "remove", id: n.id },
      {
        onSuccess: () => toast.success(`已删除网络 ${n.name}`),
        onError: (e) => toast.error(`删除网络 ${n.name} 失败`, { description: String(e) }),
      }
    );
    setConfirmDelete(null);
  };

  const submitCreate = () => {
    if (!newName.trim()) return;
    networkAction.mutate(
      { action: "create", name: newName.trim() },
      {
        onSuccess: () => {
          toast.success(`已创建网络 ${newName.trim()}`);
          setCreateOpen(false);
          setNewName("");
        },
        onError: (e) => toast.error("创建网络失败", { description: String(e) }),
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
          新建网络
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && !networks ? (
          <div className="p-2">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border-subtle px-2.5 py-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        ) : !networks || networks.length === 0 ? (
          <EmptyState
            icon={Network}
            title="暂无网络"
            description="本地引擎没有自定义网络"
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建网络
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead>驱动</TableHead>
                <TableHead>范围</TableHead>
                <TableHead className="text-right">容器数</TableHead>
                <TableHead className="w-20 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {networks.map((n) => (
                <TableRow key={n.id}>
                  <TableCell>
                    <span className="mono text-[13px]">{n.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-secondary">{n.driver}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-secondary">{n.scope}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="mono text-secondary">{n.containers ?? 0}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="删除"
                        className="text-muted hover:bg-danger-tint hover:text-danger"
                        onClick={() => setConfirmDelete(n)}
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
            <AlertDialogTitle>删除网络</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除网络 {confirmDelete?.name}？此操作不可撤销。
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
            <DialogTitle>新建网络</DialogTitle>
            <DialogDescription>在本地引擎创建 Docker 网络。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>网络名称</Label>
              <Input placeholder="例如 app-net" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>驱动（可选，默认 bridge）</Label>
              <Input placeholder="bridge" value={newDriver} onChange={(e) => setNewDriver(e.target.value)} />
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
