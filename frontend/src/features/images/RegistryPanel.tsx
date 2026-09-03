import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import {
  useRegistries,
  useRegistryDelete,
  useRegistryPing,
  useRegistryRepos,
  useRegistrySave,
  useRegistryTags,
} from "@/lib/queries";
import { invoke } from "@/lib/api";
import type { RegistryConfig, RegistryRepo } from "@/lib/types";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const emptyForm = () => ({
  name: "",
  url: "",
  username: "",
  password: "",
  insecure: false,
  isDockerHub: false,
  namespace: "",
});

/** 去掉 scheme，得到 docker 可用的镜像前缀 */
function hostOf(url: string) {
  return url.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 镜像完整引用：host/repo:tag */
function imageRef(cfg: RegistryConfig, repo: string, tag: string) {
  const host = hostOf(cfg.url);
  return `${host}/${repo}:${tag}`;
}

/**
 * 镜像仓库（Registry）管理：
 * - 配置多个私有仓库（如 UCloud），凭据存 Keychain
 * - 登录校验（registry.ping）
 * - 浏览仓库列表（registry.repos）与每个仓库的 tag（registry.tags）
 * - 复制 pull 命令 / 镜像引用，供本地引擎拉取
 */
export default function RegistryPanel() {
  const queryClient = useQueryClient();
  const { data: registries, isLoading } = useRegistries();
  const saveRegistry = useRegistrySave();
  const deleteRegistry = useRegistryDelete();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  const selected = useMemo(
    () => registries?.find((r) => r.id === selectedId) ?? null,
    [registries, selectedId]
  );

  // ---- 新增/编辑对话框 ----
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowPw(false);
    setOpen(true);
  };

  const openEdit = (r: RegistryConfig) => {
    setEditingId(r.id);
    setForm({
      name: r.name,
      url: r.url,
      username: r.username,
      password: "",
      insecure: r.insecure ?? false,
      isDockerHub: r.isDockerHub ?? false,
      namespace: r.namespace ?? "",
    });
    setShowPw(false);
    setOpen(true);
  };

  const submitSave = () => {
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) {
      toast.error("请填写名称与仓库地址");
      return;
    }
    setSaving(true);
    saveRegistry.mutate(
      {
        registry: {
          id: editingId ?? `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          url,
          username: form.username.trim(),
          credentialRef: null,
          insecure: form.insecure,
          isDockerHub: form.isDockerHub,
          namespace: form.namespace.trim() || null,
          createdAt: new Date().toISOString(),
        },
        password: form.password || null,
      },
      {
        onSuccess: () => {
          toast.success(editingId ? "仓库已更新" : "仓库已添加");
          setOpen(false);
        },
        onError: (e) => toast.error("保存失败", { description: String(e) }),
        onSettled: () => setSaving(false),
      }
    );
  };

  const remove = (r: RegistryConfig) => {
    deleteRegistry.mutate(r.id, {
      onSuccess: () => {
        toast.success(`已删除仓库「${r.name}」`);
        if (selectedId === r.id) setSelectedId(null);
      },
      onError: (e) => toast.error("删除失败", { description: String(e) }),
    });
  };

  const testConnection = (r: RegistryConfig) => {
    invoke<string>("registry_ping", { id: r.id })
      .then(() => toast.success(`连接成功：${r.name} (Registry API v2)`))
      .catch((e) => toast.error(`连接失败：${r.name}`, { description: String(e) }));
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${label}`);
    } catch {
      toast.error("复制失败");
    }
  };

  // ---- 浏览模式：仓库列表 + tags ----
  const {
    data: repos,
    isFetching: reposLoading,
    isError: reposError,
    error: reposErr,
    refetch: refetchRepos,
  } = useRegistryRepos(selectedId);
  const { data: tags, isFetching: tagsLoading } = useRegistryTags(
    selectedId,
    expandedRepo
  );
  const { data: pingOk } = useRegistryPing(selectedId);

  const copyRepoRef = (repo: RegistryRepo, tag: string) => {
    if (!selected) return;
    copyText(imageRef(selected, repo.name, tag), "镜像引用");
  };

  const copyPull = (repo: RegistryRepo, tag: string) => {
    if (!selected) return;
    copyText(`docker pull ${imageRef(selected, repo.name, tag)}`, "pull 命令");
  };

  if (isLoading) {
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            ← 返回
          </Button>
          <span className="text-[13px] font-medium">{selected.name}</span>
          <Badge variant="secondary" className="font-mono text-[11px]">
            {hostOf(selected.url)}
          </Badge>
          {selected.namespace ? (
            <Badge variant="secondary" className="text-[11px] text-indigo-600">
              ns / {selected.namespace}
            </Badge>
          ) : null}
          {pingOk ? (
            <Badge variant="outline" className="text-[11px] text-emerald-600">
              <Wifi className="mr-1 h-3 w-3" /> 已连接
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[11px] text-muted">未连接</Badge>
          )}
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => testConnection(selected)}>
            <Wifi className="mr-1.5 h-3.5 w-3.5" /> 测试连接
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {reposError ? (
            <EmptyState
              icon={Wifi}
              title="加载仓库列表失败"
              description={`${String((reposErr as Error | null)?.message ?? reposErr ?? "")}。请检查凭据与仓库地址，或确认该仓库允许 _catalog 列举。`}
              action={
                <Button size="sm" onClick={() => refetchRepos()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> 重试
                </Button>
              }
            />
          ) : reposLoading && repos === undefined ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !repos?.length ? (
            <EmptyState
              icon={KeyRound}
              title="仓库列表为空"
              description="该 registry 下暂无仓库（repositories），或没有访问权限。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8" />
                  <TableHead>仓库</TableHead>
                  <TableHead>标签 (tags)</TableHead>
                  <TableHead className="w-56 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repos.map((repo) => {
                  const expanded = expandedRepo === repo.name;
                  const repoTags = expanded ? tags ?? [] : repo.tags;
                  return (
                    <React.Fragment key={repo.name}>
                      <TableRow className="cursor-pointer" onClick={() => setExpandedRepo(expanded ? null : repo.name)}>
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-secondary" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-secondary" />
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="mono text-[13px]">{repo.name}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-[12px] text-secondary">
                            {repoTags.length > 0 ? `${repoTags.length} 个 tag` : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="复制镜像引用"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (repoTags[0]) copyRepoRef(repo, repoTags[0]);
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="复制 docker pull 命令"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (repoTags[0]) copyPull(repo, repoTags[0]);
                              }}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={3}>
                            <div className="py-2">
                              <div className="mb-2 flex items-center gap-2">
                                <RefreshCw
                                  className={`h-3.5 w-3.5 text-secondary ${tagsLoading ? "animate-spin" : ""}`}
                                />
                                <span className="text-[11px] font-medium text-secondary">Tags</span>
                              </div>
                              {tagsLoading && tags === undefined ? (
                                <Skeleton className="h-6 w-40" />
                              ) : repoTags.length === 0 ? (
                                <span className="text-[12px] text-muted">暂无 tag</span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {repoTags.map((tag) => (
                                    <span
                                      key={tag}
                                      className="group inline-flex cursor-pointer items-center gap-1 rounded-md border border-border-subtle bg-background px-2 py-0.5 text-[12px] transition hover:border-accent"
                                      title={imageRef(selected, repo.name, tag)}
                                    >
                                      <span className="mono text-secondary">{tag}</span>
                                      <button
                                        className="hidden text-muted hover:text-foreground group-hover:inline-flex"
                                        title="复制镜像引用"
                                        onClick={() => copyRepoRef(repo, tag)}
                                      >
                                        <Copy className="h-3 w-3" />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    );
  }

  // ---- 配置列表 ----
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <span className="text-[13px] font-medium">镜像仓库</span>
        <span className="text-[11px] text-muted">私有仓库 / Docker Hub 浏览</span>
        <div className="flex-1" />
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" /> 添加仓库
        </Button>
      </div>

      {!registries?.length ? (
        <EmptyState
          icon={KeyRound}
          title="还没有配置镜像仓库"
          description="添加你的私有仓库（如 UCloud），配置登录凭据后即可浏览其中的镜像。"
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" /> 添加仓库
            </Button>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>用户名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-64 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registries.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelectedId(r.id)}>
                  <TableCell>
                    <span className="text-[13px] font-medium">{r.name}</span>
                    {r.isDockerHub && (
                      <Badge variant="secondary" className="ml-2 text-[10px]">
                        Docker Hub
                      </Badge>
                    )}
                    {r.insecure && (
                      <Badge variant="outline" className="ml-1 text-[10px] text-amber-600">
                        http
                      </Badge>
                    )}
                    {r.namespace && (
                      <Badge variant="secondary" className="ml-1 text-[10px] text-indigo-600">
                        ns / {r.namespace}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="mono-caption text-secondary">{hostOf(r.url)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-[12px] text-secondary">{r.username || "匿名"}</span>
                  </TableCell>
                  <TableCell>
                    <ConnectionDot registryId={r.id} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon-sm" title="测试连接" onClick={() => testConnection(r)}>
                        <Wifi className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => openEdit(r)}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon-sm" title="删除" className="text-danger hover:text-danger">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>删除镜像仓库「{r.name}」？</AlertDialogTitle>
                            <AlertDialogDescription>
                              将移除该配置及 Keychain 中的登录凭据。不影响已拉取的本地镜像。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={() => remove(r)}>删除</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 新增 / 编辑对话框 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑镜像仓库" : "添加镜像仓库"}</DialogTitle>
            <DialogDescription>
              支持 Docker Registry API v2（私有仓库 / Docker Hub）。密码仅保存在 macOS 钥匙串。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reg-name">名称</Label>
                <Input id="reg-name" placeholder="UCloud 镜像仓库" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reg-url">仓库地址</Label>
                <Input id="reg-url" placeholder="uhub.service.ucloud.cn 或 https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reg-user">用户名</Label>
                <Input id="reg-user" placeholder="登录账号（可空=匿名）" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reg-pw">密码 / Token</Label>
                <div className="relative">
                  <Input
                    id="reg-pw"
                    type={showPw ? "text" : "password"}
                    placeholder={editingId ? "留空保持不变" : "登录密码"}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="pr-8"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                    onClick={() => setShowPw(!showPw)}
                  >
                    {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-ns">
                私有命名空间 <span className="text-muted">（可选）</span>
              </Label>
              <Input
                id="reg-ns"
                placeholder="如 variety 或 variety,ceph0618。填了只显示这些命名空间下的镜像，留空显示全部"
                value={form.namespace}
                onChange={(e) => setForm({ ...form, namespace: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="reg-insecure" className="cursor-pointer">
                  允许 HTTP / 跳过 TLS 校验（本地或内网仓库）
                </Label>
                <Switch id="reg-insecure" checked={form.insecure} onCheckedChange={(v) => setForm({ ...form, insecure: !!v })} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="reg-hub" className="cursor-pointer">
                  这是 Docker Hub（官方仓库，走 token 认证）
                </Label>
                <Switch id="reg-hub" checked={form.isDockerHub} onCheckedChange={(v) => setForm({ ...form, isDockerHub: !!v })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={submitSave} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionDot({ registryId }: { registryId: string }) {
  const { data, isError } = useRegistryPing(registryId);
  if (isError) return <Badge variant="outline" className="text-[11px] text-danger">认证失败</Badge>;
  if (data) return <Badge variant="outline" className="text-[11px] text-emerald-600">已连接</Badge>;
  return <Badge variant="outline" className="text-[11px] text-muted">未知</Badge>;
}
