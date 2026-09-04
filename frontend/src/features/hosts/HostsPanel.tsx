import { useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Info,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Star,
  Trash2,
  Zap,
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
  jumpHost: string;
  jumpPort: string;
  jumpUser: string;
}

const emptyForm: HostForm = {
  name: "",
  address: "",
  port: "22",
  user: "root",
  groupId: "",
  auth: "password",
  password: "",
  jumpHost: "",
  jumpPort: "22",
  jumpUser: "",
};

/** 解析快速连接输入：root@host:2222 / host / 203.0.113.10:22 */
function parseQuick(input: string): { user: string; address: string; port: number } | null {
  let s = input.trim();
  if (!s) return null;
  let user = "root";
  let port = 22;
  const at = s.lastIndexOf("@");
  if (at > 0 && at < s.length - 1) {
    user = s.slice(0, at).trim();
    s = s.slice(at + 1).trim();
  }
  // 形如 [::1]:2222 或 host:port / ip:port
  const m = s.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (m) {
    s = m[1];
    port = Number(m[2]);
  }
  if (!s) return null;
  return { user, address: s, port };
}

/**
 * SSH 主机管理面板 — 快速连接 + 收藏/最近 + 分组表格。
 * 收藏/最近连接置顶，其余按分组展示；支持搜索、真实编辑/测试/删除。
 */
export default function HostsPanel(_props: PanelProps) {
  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { hostOnline } = useLive();
  const { openTab } = useWorkspace();
  const openConnect = useConnect((s) => s.openConnect);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState("");
  const [quickFocus, setQuickFocus] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [form, setForm] = useState<HostForm>(emptyForm);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleteHost, setDeleteHost] = useState<Host | null>(null);

  const query = search.trim().toLowerCase();
  const searching = query.length > 0;

  const filtered = useMemo(
    () =>
      (hosts ?? []).filter(
        (h) => !query || h.name.toLowerCase().includes(query) || h.address.toLowerCase().includes(query) || h.user.toLowerCase().includes(query)
      ),
    [hosts, query]
  );

  // 收藏 / 最近连接 / 其余分组
  const favorites = useMemo(
    () => (hosts ?? []).filter((h) => h.favorite),
    [hosts]
  );
  const recents = useMemo(
    () =>
      (hosts ?? [])
        .filter((h) => !h.favorite && h.lastConnectedAt)
        .sort((a, b) => (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? ""))
        .slice(0, 5),
    [hosts]
  );
  const pinnedIds = useMemo(() => {
    const s = new Set<string>();
    for (const h of favorites) s.add(h.id);
    for (const h of recents) s.add(h.id);
    return s;
  }, [favorites, recents]);

  const grouped = useMemo(
    () =>
      groups?.map((g) => ({
        group: g,
        items: filtered.filter((h) => h.groupId === g.id && !pinnedIds.has(h.id)),
      })) ?? [],
    [groups, filtered, pinnedIds]
  );
  const orphans = filtered.filter((h) => !groups?.some((g) => g.id === h.groupId) && !pinnedIds.has(h.id));

  const connect = (host: Host) => {
    openConnect({ hostId: host.id, hostName: host.name, address: host.address, user: host.user, port: host.port });
  };

  const openDetail = (host: Host) => {
    openTab({ kind: "host-detail", title: host.name, hostId: host.id, env: host.env });
  };

  // ---- 快速连接 ----
  const quickSuggestions = useMemo(() => {
    if (!quick.trim()) return [];
    const q = quick.trim().toLowerCase();
    const matches = (hosts ?? []).filter(
      (h) => h.name.toLowerCase().includes(q) || h.address.toLowerCase().includes(q)
    );
    return matches;
  }, [quick, hosts]);

  const runQuickConnect = (raw?: string) => {
    const input = raw ?? quick;
    const parsed = parseQuick(input);
    if (!parsed) return;
    const hasExplicitUser = input.includes("@");
    const saved = (hosts ?? []).find(
      (h) => h.address === parsed.address && h.port === parsed.port
    );
    if (saved) {
      openConnect({ hostId: saved.id, hostName: saved.name, address: saved.address, user: hasExplicitUser ? parsed.user : saved.user, port: saved.port });
    } else {
      openConnect({
        hostId: "",
        hostName: `${parsed.user}@${parsed.address}`,
        address: parsed.address,
        user: parsed.user,
        port: parsed.port,
        adhoc: true,
      });
    }
    setQuick("");
    quickRef.current?.blur();
  };

  // ---- 新增 / 编辑 ----
  const openAddDialog = () => {
    setEditing(null);
    setForm({ ...emptyForm, groupId: groups?.[0]?.id ?? "g-dev" });
    setShowAdvanced(false);
    setAddOpen(true);
  };

  const openEditDialog = (host: Host) => {
    setEditing(host);
    setForm({
      name: host.name,
      address: host.address,
      port: String(host.port),
      user: host.user,
      groupId: host.groupId,
      auth: host.credentialRef ? "keychain" : "password",
      password: "",
      jumpHost: host.jumpHost ?? "",
      jumpPort: String(host.jumpPort ?? 22),
      jumpUser: host.jumpUser ?? "",
    });
    setShowAdvanced(Boolean(host.jumpHost));
    setAddOpen(true);
  };

  const handleSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const editingHost = editing;
    try {
      const group = groups?.find((g) => g.id === form.groupId);
      const host: Host = {
        id: editingHost?.id ?? `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: form.name.trim(),
        address: form.address.trim(),
        port: Number(form.port) || 22,
        user: form.user.trim() || "root",
        groupId: group?.id ?? "g-dev",
        env: group?.env ?? "dev",
        credentialRef: editingHost?.credentialRef ?? "",
        fingerprint: editingHost?.fingerprint ?? undefined,
        lastConnectedAt: editingHost?.lastConnectedAt ?? undefined,
        jumpHost: form.jumpHost.trim() || undefined,
        jumpPort: form.jumpHost.trim() ? Number(form.jumpPort) || 22 : undefined,
        jumpUser: form.jumpHost.trim() ? form.jumpUser.trim() || undefined : undefined,
        favorite: editingHost?.favorite ?? false,
        createdAt: editingHost?.createdAt ?? new Date().toISOString(),
      };
      await invoke("hosts_save", {
        host,
        password: form.auth === "password" && form.password ? form.password : null,
      });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast.success(editingHost ? `已更新主机「${form.name}」` : `已保存主机「${form.name}」`);
      setAddOpen(false);
      setForm({ ...emptyForm });
    } catch (err) {
      toast.error(editingHost ? "更新主机失败" : "保存主机失败", { description: String(err) });
    }
  };

  const testForm = async () => {
    if (!form.address.trim()) return;
    setTesting(true);
    try {
      const session = await invoke<{ sessionId: string }>("ssh_connect_adhoc", {
        address: form.address.trim(),
        user: form.user.trim() || "root",
        port: Number(form.port) || 22,
        password: form.auth === "password" && form.password ? form.password : null,
        cols: 80,
        rows: 24,
      });
      void invoke("ssh_disconnect", { sessionId: session.sessionId }).catch(() => {});
      toast.success("连接测试通过");
    } catch (err) {
      toast.error("连接测试失败", { description: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const testHost = async (host: Host) => {
    try {
      const session = await invoke<{ sessionId: string }>("ssh_connect", {
        hostId: host.id,
        password: null,
        cols: 80,
        rows: 24,
      });
      void invoke("ssh_disconnect", { sessionId: session.sessionId }).catch(() => {});
      toast.success(`连接测试通过：${host.user}@${host.address}:${host.port}`);
    } catch (err) {
      toast.error("连接测试失败", { description: String(err) });
    }
  };

  const toggleFavorite = async (host: Host) => {
    try {
      await invoke("hosts_save", {
        host: { ...host, favorite: !host.favorite },
        password: null,
      });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast.success(!host.favorite ? `已将「${host.name}」加入收藏` : `已取消收藏「${host.name}」`);
    } catch (err) {
      toast.error("更新收藏失败", { description: String(err) });
    }
  };

  const handleDelete = async () => {
    if (!deleteHost) return;
    try {
      await invoke("hosts_delete", { id: deleteHost.id });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast.success(`已删除主机「${deleteHost.name}」`);
    } catch (err) {
      toast.error("删除主机失败", { description: String(err) });
    }
    setDeleteHost(null);
  };

  const set = (field: keyof HostForm) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：快速连接 + 搜索 + 添加 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <div className="relative w-72">
          <Zap className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-quaternary" />
          <Input
            ref={quickRef}
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onFocus={() => setQuickFocus(true)}
            onBlur={() => setTimeout(() => setQuickFocus(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runQuickConnect();
              if (e.key === "Escape") setQuick("");
            }}
            placeholder="root@host:22 快速连接…"
            className="pl-7"
          />
          {quickFocus && quick.trim() && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-elevated py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
              {quickSuggestions.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-hover-fill"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    connect(h);
                    setQuick("");
                    setQuickFocus(false);
                  }}
                >
                  <Star className={cn("h-3 w-3", h.favorite ? "fill-warning text-warning" : "text-quaternary")} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{h.name}</span>
                  <span className="mono-caption text-muted">
                    {h.user}@{h.address}:{h.port}
                  </span>
                </button>
              ))}
              {(() => {
                const p = parseQuick(quick);
                return p ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left text-[12px] text-accent hover:bg-hover-fill"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runQuickConnect();
                    }}
                  >
                    <Zap className="h-3 w-3" />
                    连接新主机 {p.user}@{p.address}:{p.port}（不落库）
                  </button>
                ) : null;
              })()}
            </div>
          )}
        </div>
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-quaternary" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索主机名称 / 地址…"
            className="pl-7"
          />
        </div>
        <Button variant="primary" size="md" className="ml-auto" onClick={openAddDialog}>
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
          ) : searching ? (
            <div className="flex flex-col gap-5">
              {grouped.map(({ group, items }) =>
                items.length === 0 ? null : (
                  <section key={group.id}>
                    <GroupHeader group={group} count={items.length} />
                    <HostTable hosts={items} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
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
                  <HostTable hosts={orphans} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
                </section>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {favorites.length > 0 && (
                <section>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                    <span className="text-[13px] font-semibold">收藏</span>
                    <span className="mono-caption text-quaternary">{favorites.length}</span>
                  </div>
                  <HostTable hosts={favorites} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
                </section>
              )}
              {recents.length > 0 && (
                <section>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <Play className="h-3 w-3 text-secondary" />
                    <span className="text-[13px] font-semibold">最近连接</span>
                    <span className="mono-caption text-quaternary">{recents.length}</span>
                  </div>
                  <HostTable hosts={recents} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
                </section>
              )}
              {grouped.map(({ group, items }) =>
                items.length === 0 ? null : (
                  <section key={group.id}>
                    <GroupHeader group={group} count={items.length} />
                    <HostTable hosts={items} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
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
                  <HostTable hosts={orphans} onlineOf={hostOnline} onConnect={connect} onDetail={openDetail} onEdit={openEditDialog} onTest={testHost} onFavorite={toggleFavorite} onDelete={setDeleteHost} />
                </section>
              )}
            </div>
          )
        ) : (
          <EmptyState
            icon={Server}
            title="暂无主机"
            description="用顶部快速连接栏输入 root@host:22 立即连接，或添加你的第一台 SSH 主机。"
            action={
              <Button variant="primary" size="md" onClick={openAddDialog}>
                <Plus /> 添加主机
              </Button>
            }
          />
        )}
      </div>

      {/* 添加 / 编辑主机 */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && setAddOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑主机「${editing.name}」` : "添加主机"}</DialogTitle>
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
                placeholder="203.0.113.10 或 host.example.com"
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
            <div className="col-span-2 space-y-1.5">
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

            {/* 高级选项（认证 / 跳板机）默认折叠 */}
            <div className="col-span-2">
              <button
                type="button"
                className="flex items-center gap-1 text-[12px] font-medium text-secondary hover:text-foreground"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                高级选项（认证与跳板机）
              </button>
            </div>
            {showAdvanced && (
              <>
                <div className="col-span-2 space-y-1.5">
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
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="host-password">
                      {editing ? "新密码（留空保留原凭据）" : "密码（存入 macOS Keychain）"}
                    </Label>
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
                <div className="col-span-2 space-y-1.5 rounded-md border border-border-subtle bg-hover-fill/50 p-2.5">
                  <Label htmlFor="host-jump" className="text-[12px]">
                    跳板机（可选 · ProxyJump）
                  </Label>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1">
                      <Input
                        id="host-jump"
                        value={form.jumpHost}
                        onChange={(e) => set("jumpHost")(e.target.value)}
                        placeholder="bastion.example.com"
                      />
                    </div>
                    <div className="space-y-1">
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={form.jumpPort}
                        onChange={(e) => set("jumpPort")(e.target.value)}
                        placeholder="22"
                      />
                    </div>
                  </div>
                  <Input
                    value={form.jumpUser}
                    onChange={(e) => set("jumpUser")(e.target.value)}
                    placeholder="跳板机用户名（默认同目标用户名）"
                    className="text-[12px]"
                  />
                </div>
              </>
            )}
          </form>
          <DialogFooter>
            <Button
              variant="ghost"
              size="md"
              onClick={() => void testForm()}
              disabled={testing || !form.address.trim()}
            >
              <Cable /> {testing ? "测试中…" : "测试连接"}
            </Button>
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
              确定要删除主机「{deleteHost?.name}」吗？删除后其连接配置将被移除，此操作不可撤销。
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
// 分组标题
// ---------------------------------------------------------------------------
function GroupHeader({ group, count }: { group: { id: string; name: string; env: Env; color: string }; count: number }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-1">
      <EnvTag env={group.env} />
      <span className="text-[13px] font-semibold" style={{ color: group.color }}>
        {group.name}
      </span>
      <span className="mono-caption text-quaternary">{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Host table (shared by grouped / pinned sections)
// ---------------------------------------------------------------------------
function HostTable({
  hosts,
  onlineOf,
  onConnect,
  onDetail,
  onEdit,
  onTest,
  onFavorite,
  onDelete,
}: {
  hosts: Host[];
  onlineOf: Record<string, boolean>;
  onConnect: (host: Host) => void;
  onDetail: (host: Host) => void;
  onEdit: (host: Host) => void;
  onTest: (host: Host) => void;
  onFavorite: (host: Host) => void;
  onDelete: (host: Host) => void;
}) {
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
              <TableRow key={host.id} onDoubleClick={() => onConnect(host)} title="双击连接 SSH">
                <TableCell
                  className="env-rail"
                  style={{ "--rail-color": envColor(host.env) } as CSSProperties}
                >
                  <div className="flex items-center gap-2 pl-2">
                    <span className={cn("dot", online ? "bg-success" : "bg-quaternary")} />
                    <span className="truncate font-medium text-foreground">{host.name}</span>
                    <EnvTag env={host.env} />
                    {host.favorite && (
                      <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />
                    )}
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
                      title={host.favorite ? "取消收藏" : "收藏"}
                      onClick={() => onFavorite(host)}
                    >
                      <Star className={cn("h-3.5 w-3.5", host.favorite ? "fill-warning text-warning" : "text-muted")} />
                    </Button>
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
                        <DropdownMenuItem onClick={() => onEdit(host)}>
                          <Pencil /> 编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onTest(host)}>
                          <Cable /> 测试连接
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onFavorite(host)}>
                          <Star className={cn(host.favorite && "fill-warning text-warning")} />
                          {host.favorite ? "取消收藏" : "加入收藏"}
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
