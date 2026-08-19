import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  Cable,
  Info,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHostGroups, useHosts, useHostStats } from "@/lib/queries";
import { invoke } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useLive, useConnect } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { cn, formatPercent, timeAgo } from "@/lib/utils";
import type { Env, Host } from "@/lib/types";
import { EnvTag, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

/** Env → CSS var color (env color cards) */
function envColor(env: Env): string {
  if (env === "dev") return "var(--env-dev)";
  if (env === "staging") return "var(--env-staging)";
  if (env === "prod") return "var(--env-prod)";
  return "var(--muted)";
}

/** Mini CPU/内存 metrics per host row (own hook instance per row) */
function HostStatsCell({ hostId }: { hostId: string }) {
  const { data } = useHostStats(hostId);
  if (!data) {
    return <span className="mono-caption text-quaternary">—</span>;
  }
  const memPercent = data.memTotalBytes > 0 ? (data.memUsedBytes / data.memTotalBytes) * 100 : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="mono-caption text-secondary">CPU {formatPercent(data.cpuPercent)}</span>
      <span className="mono-caption text-secondary">内存 {formatPercent(memPercent)}</span>
    </div>
  );
}

interface HostForm {
  name: string;
  address: string;
  port: string;
  user: string;
  groupId: string;
  auth: string;
  password: string;
}

const emptyForm: HostForm = {
  name: "",
  address: "",
  port: "22",
  user: "root",
  groupId: "",
  auth: "password",
  password: "",
};

/**
 * SSH 主机管理面板 — 按分组展示主机，支持搜索、连接、详情、编辑/测试/删除。
 * 规格：docs/管理面板规划.md §4.2
 */
export default function HostsPanel(_props: PanelProps) {
  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { hostOnline } = useLive();
  const { openTab } = useWorkspace();
  const openConnect = useConnect((s) => s.openConnect);

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<HostForm>(emptyForm);
  const [deleteHost, setDeleteHost] = useState<Host | null>(null);
  const queryClient = useQueryClient();

  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (hosts ?? []).filter(
        (h) => !query || h.name.toLowerCase().includes(query) || h.address.toLowerCase().includes(query)
      ),
    [hosts, query]
  );

  const connect = (host: Host) => {
    openConnect({ hostId: host.id, hostName: host.name, address: host.address, user: host.user });
  };

  const openDetail = (host: Host) => {
    openTab({ kind: "host-detail", title: host.name, hostId: host.id, env: host.env });
  };

  const handleSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const group = groups?.find((g) => g.id === form.groupId);
      await invoke("hosts.save", {
        host: {
          id: `h-${Date.now().toString(36)}`,
          name: form.name.trim(),
          address: form.address.trim(),
          port: Number(form.port) || 22,
          user: form.user.trim() || "root",
          groupId: group?.id ?? "g-dev",
          env: group?.env ?? "dev",
          credentialRef: null,
          fingerprint: null,
          lastConnectedAt: null,
          createdAt: new Date().toISOString(),
        },
        password: form.auth === "password" && form.password ? form.password : null,
      });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast.success(`已保存主机「${form.name}」`);
      setAddOpen(false);
      setForm({ ...emptyForm });
    } catch (err) {
      toast.error("保存主机失败", { description: String(err) });
    }
  };

  const handleDelete = () => {
    if (!deleteHost) return;
    toast.success(`已删除主机「${deleteHost.name}」（演示模式）`);
    setDeleteHost(null);
  };

  const set = (field: keyof HostForm) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const grouped =
    groups?.map((g) => ({ group: g, items: filtered.filter((h) => h.groupId === g.id) })) ?? [];
  const orphans = filtered.filter((h) => !groups?.some((g) => g.id === h.groupId));

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-quaternary" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索主机名称 / 地址…"
            className="pl-7"
          />
        </div>
        <Button variant="primary" size="md" className="ml-auto" onClick={() => setAddOpen(true)}>
          <Plus /> 添加主机
        </Button>
      </div>

      {/* 主机列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {hosts?.length ? (
          filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
              <span className="text-[13px] text-secondary">没有匹配的主机</span>
              <span className="text-[12px] text-muted">试试其他关键词，或点击右上角添加主机</span>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {grouped.map(({ group, items }) =>
                items.length === 0 ? null : (
                  <section key={group.id}>
                    <div className="mb-1.5 flex items-center gap-2 px-1">
                      <EnvTag env={group.env} />
                      <span className="text-[13px] font-semibold" style={{ color: group.color }}>
                        {group.name}
                      </span>
                      <span className="mono-caption text-quaternary">{items.length}</span>
                    </div>
                    <HostTable hosts={items} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onDelete={setDeleteHost} />
                  </section>
                )
              )}
              {orphans.length > 0 && (
                <section>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <span className="dot" style={{ background: "var(--muted)", boxShadow: "none" }} />
                    <span className="text-[13px] font-semibold text-secondary">未分组</span>
                    <span className="mono-caption text-quaternary">{orphans.length}</span>
                  </div>
                  <HostTable hosts={orphans} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onDelete={setDeleteHost} />
                </section>
              )}
            </div>
          )
        ) : (
          <EmptyState
            icon={Server}
            title="暂无主机"
            description="添加你的第一台 SSH 主机，开始管理远程服务器。"
            action={
              <Button variant="primary" size="md" onClick={() => setAddOpen(true)}>
                <Plus /> 添加主机
              </Button>
            }
          />
        )}
      </div>

      {/* 添加主机 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加主机</DialogTitle>
            <DialogDescription>
              通过 SSH 连接远程服务器，支持密码 / 私钥文件 / Keychain 认证。
            </DialogDescription>
          </DialogHeader>
          <form id="add-host-form" onSubmit={handleSave} className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="host-name">名称</Label>
              <Input
                id="host-name"
                value={form.name}
                onChange={(e) => set("name")(e.target.value)}
                placeholder="香港 VPS"
                autoFocus
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="host-address">地址</Label>
              <Input
                id="host-address"
                value={form.address}
                onChange={(e) => set("address")(e.target.value)}
                placeholder="160.202.46.104 或 host.example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-port">端口</Label>
              <Input
                id="host-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => set("port")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-user">用户名</Label>
              <Input
                id="host-user"
                value={form.user}
                onChange={(e) => set("user")(e.target.value)}
                placeholder="root"
              />
            </div>
            <div className="space-y-1.5">
              <Label>分组</Label>
              <Select value={form.groupId || undefined} onValueChange={set("groupId")}>
                <SelectTrigger>
                  <SelectValue placeholder="选择分组" />
                </SelectTrigger>
                <SelectContent>
                  {(groups ?? []).map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>认证方式</Label>
              <Select value={form.auth} onValueChange={set("auth")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">密码</SelectItem>
                  <SelectItem value="private-key">私钥文件</SelectItem>
                  <SelectItem value="keychain">Keychain</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.auth === "password" && (
              <div className="space-y-1.5">
                <Label htmlFor="host-password">密码（存入 macOS Keychain）</Label>
                <Input
                  id="host-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password")(e.target.value)}
                  placeholder="留空则仅保存主机配置"
                  autoComplete="new-password"
                />
              </div>
            )}
          </form>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              form="add-host-form"
              disabled={!form.name.trim() || !form.address.trim()}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteHost} onOpenChange={(o) => !o && setDeleteHost(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除主机</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除主机「{deleteHost?.name}」吗？删除后其连接配置将被移除，此操作不可撤销（演示模式）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Host table (shared by grouped sections)
// ---------------------------------------------------------------------------

function HostTable({
  hosts,
  onlineOf,
  onConnect,
  onDetail,
  onDelete,
}: {
  hosts: Host[];
  onlineOf: Record<string, boolean>;
  onConnect: (host: Host) => void;
  onDetail: (host: Host) => void;
  onDelete: (host: Host) => void;
}) {
  const edit = (host: Host) => toast.info(`编辑「${host.name}」（演示模式）`);
  const test = (host: Host) =>
    toast.success(`连接测试通过：${host.user}@${host.address}:${host.port}（演示模式）`);

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[26%]">主机名</TableHead>
            <TableHead className="w-[24%]">地址</TableHead>
            <TableHead className="w-[14%]">状态</TableHead>
            <TableHead className="w-[18%]">指标</TableHead>
            <TableHead className="w-[12%]">最近连接</TableHead>
            <TableHead className="w-[6%] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => {
            const online = onlineOf[host.id] ?? true; // mock 默认在线
            return (
              <TableRow
                key={host.id}
                onDoubleClick={() => onConnect(host)}
                title="双击连接 SSH"
              >
                <TableCell
                  className="env-rail"
                  style={{ "--rail-color": envColor(host.env) } as CSSProperties}
                >
                  <div className="flex items-center gap-2 pl-2">
                    <span className={cn("dot", online ? "bg-success" : "bg-quaternary")} />
                    <span className="truncate font-medium text-foreground">{host.name}</span>
                    <EnvTag env={host.env} />
                  </div>
                </TableCell>
                <TableCell>
                  <span className="mono-caption text-secondary">
                    {host.user}@{host.address}:{host.port}
                  </span>
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-[13px]",
                      online ? "text-success" : "text-quaternary"
                    )}
                  >
                    <span className={cn("dot", online ? "bg-success" : "bg-quaternary")} />
                    {online ? "在线" : "离线"}
                  </span>
                </TableCell>
                <TableCell>
                  <HostStatsCell hostId={host.id} />
                </TableCell>
                <TableCell>
                  <span className="text-[12px] text-muted">{timeAgo(host.lastConnectedAt)}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={`连接 ${host.name}`}
                      onClick={() => onConnect(host)}
                    >
                      <Play />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="主机详情"
                      onClick={() => onDetail(host)}
                    >
                      <Info />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" title="更多">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>{host.name}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => edit(host)}>
                          <Pencil /> 编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => test(host)}>
                          <Cable /> 测试连接
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-danger" onClick={() => onDelete(host)}>
                          <Trash2 /> 删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
