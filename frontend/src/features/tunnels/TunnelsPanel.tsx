import { useEffect, useMemo, useState } from "react";
import { Play, Plus, Square, Trash2, Waypoints } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHosts, useTunnelAction, useTunnels } from "@/lib/queries";
import { usePalette } from "@/stores/live";
import { invoke } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import type { Tunnel, TunnelType } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";

type TunnelFilter = "all" | "active" | "stopped";

const TYPE_BADGE: Record<TunnelType, { label: string; className?: string }> = {
  local: { label: "Local", className: "bg-accent-tint text-accent" },
  remote: { label: "Remote", className: "bg-warning-tint text-warning" },
  socks5: { label: "SOCKS5" },
};

const STATUS_META: Record<Tunnel["status"], { label: string; dot: string; text: string }> = {
  active: { label: "活跃", dot: "bg-success", text: "text-success" },
  stopped: { label: "已停止", dot: "bg-quaternary", text: "text-muted" },
  error: { label: "错误", dot: "bg-danger", text: "text-danger" },
};

/** 来源 → 目标 路由描述（mono） */
function tunnelRoute(t: Tunnel): string {
  const listen = `${t.listenAddr}:${t.listenPort}`;
  if (t.type === "socks5") return `${listen} → SOCKS5`;
  return `${listen} → ${t.remoteHost}:${t.remotePort}`;
}

/**
 * 隧道管理面板 — Local / Remote 端口转发与 SOCKS5 动态代理。
 * 规格：docs/管理面板规划.md §4.4
 */
export default function TunnelsPanel(_props: PanelProps) {
  const { data: tunnels } = useTunnels();
  const { data: hosts } = useHosts();
  const { mutate: tunnelAction, isPending: actionPending } = useTunnelAction();
  const registerAction = usePalette((s) => s.registerAction);
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<TunnelFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);

  // 新建隧道表单
  const [name, setName] = useState("");
  const [type, setType] = useState<TunnelType>("local");
  const [hostId, setHostId] = useState("");
  const [listenAddr, setListenAddr] = useState("127.0.0.1");
  const [listenPort, setListenPort] = useState("15432");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("5432");

  // 打开向导时重置表单（命令面板动作与工具栏按钮共用入口）
  useEffect(() => {
    if (createOpen) {
      setName("");
      setType("local");
      setListenAddr("127.0.0.1");
      setListenPort("15432");
      setRemoteHost("localhost");
      setRemotePort("5432");
      setHostId((hosts ?? [])[0]?.id ?? "");
    }
  }, [createOpen, hosts]);

  // 命令面板：新建隧道
  useEffect(() => {
    return registerAction({
      id: "tunnels.new",
      title: "新建隧道",
      keywords: "tunnel 隧道 端口转发 forward",
      group: "隧道",
      run: () => setCreateOpen(true),
    });
  }, [registerAction]);

  const filtered = useMemo(() => {
    const list = tunnels ?? [];
    if (filter === "active") return list.filter((t) => t.status === "active");
    if (filter === "stopped") return list.filter((t) => t.status === "stopped");
    return list;
  }, [tunnels, filter]);

  const toggle = (t: Tunnel) => {
    const action = t.status === "active" ? "stop" : "start";
    tunnelAction(
      { action, id: t.id },
      {
        onSuccess: () => toast.success(action === "start" ? `隧道「${t.name}」已启动` : `隧道「${t.name}」已停止`),
        onError: () => toast.error(`操作失败：${t.name}`),
      }
    );
  };

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostId) {
      toast.error("请选择目标主机");
      return;
    }
    if (!name.trim() || !listenPort) {
      toast.error("请填写名称与监听端口");
      return;
    }
    try {
      const tunnel: Tunnel = {
        id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim(),
        type,
        hostId,
        listenAddr: listenAddr.trim() || "127.0.0.1",
        listenPort: Number(listenPort) || 0,
        remoteHost: remoteHost.trim() || "localhost",
        remotePort: type === "socks5" ? 0 : Number(remotePort) || 0,
        status: "stopped",
      };
      await invoke("tunnels_save", { tunnel });
      await invoke("tunnels_start", { id: tunnel.id });
      await queryClient.invalidateQueries({ queryKey: ["tunnels"] });
      toast.success(`隧道「${name}」已创建并启动`);
      setCreateOpen(false);
    } catch (err) {
      toast.error("创建隧道失败", { description: String(err) });
    }
  };

  const removeTunnel = async (t: Tunnel) => {
    try {
      await invoke("tunnels_delete", { id: t.id });
      await queryClient.invalidateQueries({ queryKey: ["tunnels"] });
      toast.success(`隧道「${t.name}」已删除`);
    } catch (err) {
      toast.error("删除隧道失败", { description: String(err) });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-2">
        <Select value={filter} onValueChange={(v) => setFilter(v as TunnelFilter)}>
          <SelectTrigger className="h-7 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="active">活跃</SelectItem>
            <SelectItem value="stopped">已停止</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus /> 新建隧道
        </Button>
      </div>

      {/* 安全提示 */}
      <p className="shrink-0 px-4 pt-2 text-[11px] text-muted">默认仅监听 127.0.0.1，避免端口意外暴露</p>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!tunnels?.length ? (
          <div className="h-full">
            <EmptyState
              icon={Waypoints}
              title="暂无隧道"
              description="新建 Local/Remote 端口转发，或 SOCKS5 动态代理"
              action={
                <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> 新建隧道
                </Button>
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-quaternary">
            没有符合当前筛选条件的隧道
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>来源 → 目标</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>启动时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const meta = STATUS_META[t.status];
                const badge = TYPE_BADGE[t.type];
                const isActive = t.status === "active";
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Waypoints className="h-3.5 w-3.5 shrink-0 text-muted" />
                        <span className="max-w-[180px] truncate font-medium text-foreground">{t.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral" className={badge.className}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="mono text-secondary">{tunnelRoute(t)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5" title={t.error}>
                        <span className={cn("dot shrink-0", meta.dot)} />
                        <span className={cn("text-[12px]", meta.text)}>{meta.label}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {isActive ? (
                        <span className="mono-caption text-muted" title="入站 / 出站">
                          {formatBytes(t.bytesIn)} / {formatBytes(t.bytesOut)}
                        </span>
                      ) : (
                        <span className="mono-caption text-quaternary">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="mono-caption text-quaternary">{timeAgo(t.startedAt)}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={actionPending}
                          onClick={() => toggle(t)}
                          title={isActive ? "停止" : "启动"}
                        >
                          {isActive ? <Square /> : <Play />}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-quaternary hover:bg-danger/10 hover:text-danger"
                              title="删除"
                            >
                              <Trash2 />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除隧道「{t.name}」？</AlertDialogTitle>
                              <AlertDialogDescription>
                                删除后端口转发将立即断开，此操作不可恢复。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => void removeTunnel(t)}
                              >
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 新建隧道向导 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建隧道</DialogTitle>
            <DialogDescription>创建 Local/Remote 端口转发或 SOCKS5 动态代理。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCreate} className="flex flex-col gap-3.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label htmlFor="tunnel-name">名称</Label>
                <Input
                  id="tunnel-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 pg-15432"
                  autoFocus
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>类型</Label>
                <Select value={type} onValueChange={(v) => setType(v as TunnelType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local</SelectItem>
                    <SelectItem value="remote">Remote</SelectItem>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>主机</Label>
                <Select value={hostId} onValueChange={setHostId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择主机" />
                  </SelectTrigger>
                  <SelectContent>
                    {(hosts ?? []).length === 0 && (
                      <SelectItem value="__none__" disabled>
                        无可用主机
                      </SelectItem>
                    )}
                    {(hosts ?? []).map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>监听地址</Label>
                <Input
                  value={listenAddr}
                  onChange={(e) => setListenAddr(e.target.value)}
                  placeholder="127.0.0.1"
                />
                <p className="text-[11px] text-muted">安全默认 127.0.0.1</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>监听端口</Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={listenPort}
                  onChange={(e) => setListenPort(e.target.value)}
                  required
                />
              </div>
              {type !== "socks5" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label>目标主机</Label>
                    <Input
                      value={remoteHost}
                      onChange={(e) => setRemoteHost(e.target.value)}
                      placeholder="localhost"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>目标端口</Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={remotePort}
                      onChange={(e) => setRemotePort(e.target.value)}
                      required
                    />
                  </div>
                </>
              ) : (
                <div className="col-span-2 rounded-md border border-border-subtle bg-hover-fill px-3 py-2 text-[12px] leading-relaxed text-muted">
                  SOCKS5 动态代理：在本地监听端口提供 SOCKS5 代理，流量经所选主机转发。
                </div>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary" type="button">
                  取消
                </Button>
              </DialogClose>
              <Button variant="primary" type="submit">
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
