import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Layers, Play, RefreshCw, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useContainerCreate, useEngines, useImages, usePullImage } from "@/lib/queries";
import { invoke } from "@/lib/api";
import { cn, formatBytes, formatDateTime, truncateId } from "@/lib/utils";
import type { DockerImage } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Image management panel — §4.3 of docs/管理面板规划.md */
export default function ImagesPanel(_props: PanelProps) {
  const { data: engines } = useEngines();
  const [engineFilter, setEngineFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DockerImage | null>(null);

  const { data: images, isLoading, isFetching, refetch } = useImages(
    engineFilter === "all" ? undefined : engineFilter
  );
  const pullImage = usePullImage();
  const containerCreate = useContainerCreate();
  const queryClient = useQueryClient();

  const [pullOpen, setPullOpen] = useState(false);
  const [pullImageName, setPullImageName] = useState("");
  const [pullEngine, setPullEngine] = useState<string>("all");

  const [runOpen, setRunOpen] = useState(false);
  const [runName, setRunName] = useState("");
  const [runImage, setRunImage] = useState("");
  const [runPorts, setRunPorts] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return images ?? [];
    return (images ?? []).filter(
      (i) => i.repoTag.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)
    );
  }, [images, search]);

  const submitPull = () => {
    const image = pullImageName.trim();
    if (!image) return;
    pullImage.mutate(
      { image, engineId: pullEngine === "all" ? undefined : pullEngine },
      {
        onSuccess: () => {
          toast.success(`开始拉取 ${image}`);
          setPullOpen(false);
          setPullImageName("");
        },
        onError: (e) => toast.error("拉取失败", { description: String(e) }),
      }
    );
  };

  const deleteImage = (img: DockerImage) => {
    invoke("images.remove", { engineId: img.engineId, id: img.id })
      .then(() => {
        toast.success(`已删除镜像 ${img.repoTag}`);
        void queryClient.invalidateQueries({ queryKey: ["images"] });
      })
      .catch((e: unknown) => toast.error("删除镜像失败", { description: String(e) }));
    setDeleteTarget(null);
  };

  const openRunDialog = (img?: DockerImage) => {
    if (img) setRunImage(img.repoTag);
    setRunOpen(true);
  };

  // P0: 运行新容器表单 — create + start a container from the selected image.
  const submitRun = () => {
    const engineId = engineFilter !== "all" ? engineFilter : engines?.[0]?.id;
    if (!engineId) {
      toast.error("没有可用 Docker 引擎", { description: "请先确认本地引擎（OrbStack/Docker/Colima/Podman）已启动" });
      return;
    }
    if (!runImage.trim()) return;
    containerCreate.mutate(
      {
        engineId,
        name: runName.trim() || `devdeck-${Date.now().toString(36)}`,
        image: runImage.trim(),
        ports: runPorts.trim() || undefined,
      },
      {
        onSuccess: (id) => {
          toast.success(`已启动容器 ${runName.trim() || id}`);
          setRunOpen(false);
          setRunName("");
          setRunImage("");
          setRunPorts("");
        },
        onError: (e) => toast.error("运行容器失败", { description: String(e) }),
      }
    );
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Select value={engineFilter} onValueChange={setEngineFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="全部引擎" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部引擎</SelectItem>
            {(engines ?? []).map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-56"
          placeholder="搜索仓库、标签或镜像 ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          刷新
        </Button>
        <Button variant="primary" size="sm" onClick={() => setPullOpen(true)}>
          <Download />
          拉取镜像
        </Button>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && !images ? (
          <div className="p-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border-subtle px-2.5 py-2">
                <Skeleton className="h-4 w-52" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="暂无镜像"
            description="本地引擎不可用或没有镜像"
            action={
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                <RefreshCw />
                刷新
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>仓库 / 标签</TableHead>
                <TableHead className="text-right">大小</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>镜像 ID</TableHead>
                <TableHead className="w-20 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((img) => (
                <TableRow key={img.id} className="group">
                  <TableCell>
                    <span className="mono block max-w-72 truncate text-foreground" title={img.repoTag}>
                      {img.repoTag}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="mono text-secondary">{formatBytes(img.size)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-secondary">{formatDateTime(img.created)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="mono-caption text-quaternary">{truncateId(img.id, 10, 6)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-sm" title="运行容器" onClick={() => openRunDialog(img)}>
                            <Play />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>运行容器</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="删除"
                            onClick={() => setDeleteTarget(img)}
                            className="text-muted hover:bg-danger-tint hover:text-danger"
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>删除</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除镜像</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除镜像 <span className="mono">{deleteTarget?.repoTag}</span>？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && deleteImage(deleteTarget)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pull image dialog */}
      <Dialog open={pullOpen} onOpenChange={setPullOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拉取镜像</DialogTitle>
            <DialogDescription>从镜像仓库拉取镜像到目标引擎。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>镜像名称</Label>
              <Input
                placeholder="例如 nginx:latest"
                value={pullImageName}
                onChange={(e) => setPullImageName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPull();
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>目标引擎</Label>
              <Select value={pullEngine} onValueChange={setPullEngine}>
                <SelectTrigger>
                  <SelectValue placeholder="全部引擎" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">默认引擎</SelectItem>
                  {(engines ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setPullOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!pullImageName.trim() || pullImage.isPending} onClick={submitPull}>
              <Download />
              {pullImage.isPending ? "拉取中…" : "拉取"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run container placeholder dialog */}
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行容器</DialogTitle>
            <DialogDescription>基于所选镜像创建新容器。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>镜像</Label>
              <Input value={runImage} onChange={(e) => setRunImage(e.target.value)} placeholder="例如 nginx:latest" />
            </div>
            <div className="grid gap-1.5">
              <Label>容器名称</Label>
              <Input placeholder="例如 my-app" value={runName} onChange={(e) => setRunName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>端口映射</Label>
              <Input
                placeholder="例如 8080:80（宿主机:容器）"
                value={runPorts}
                onChange={(e) => setRunPorts(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setRunOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!runImage.trim()} onClick={submitRun}>
              运行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
