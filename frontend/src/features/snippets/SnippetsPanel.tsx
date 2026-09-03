import { useMemo, useState } from "react";
import { Braces, ClipboardCopy, Plus, Send, TerminalSquare, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useSnippets, useSnippetSave, useSnippetDelete } from "@/lib/queries";
import { emitTerminalInsert } from "@/lib/terminalBus";
import { extractVars as libExtractVars, applyVars as libApplyVars } from "@/lib/snippets";
import { useWorkspace } from "@/stores/workspace";
import type { Snippet } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
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

/** 提取命令中的 {{变量名}} 占位 */
function extractVars(cmd: string): string[] {
  return libExtractVars(cmd);
}

/** 用变量表替换命令中的 {{变量名}} */
function applyVars(cmd: string, values: Record<string, string>): string {
  return libApplyVars(cmd, values);
}

/** 常用命令库（P1: Snippets 快捷命令）— 功能清单 P1「Snippets」 */
export default function SnippetsPanel(_props: PanelProps) {
  const { data: snippets, isLoading } = useSnippets();
  const saveSnippet = useSnippetSave();
  const deleteSnippet = useSnippetDelete();

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [tags, setTags] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Snippet | null>(null);

  // 变量替换：pending 表示待执行的动作（发送/复制）
  const [pending, setPending] = useState<{ snippet: Snippet; mode: "send" | "copy" } | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  const { tabs, activeTabId } = useWorkspace();
  const activeSessionId = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || (tab.kind !== "ssh" && tab.kind !== "docker-exec")) return null;
    if (tab.panes.length > 0) {
      const pane = tab.panes.find((p) => p.id === tab.activePaneId);
      if (pane?.sessionId) return pane.sessionId;
    }
    return tab.sessionId ?? null;
  }, [tabs, activeTabId]);

  const submitCreate = () => {
    if (!title.trim() || !command.trim()) return;
    saveSnippet.mutate(
      {
        id: `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: title.trim(),
        command: command.trim(),
        tags: tags.trim(),
        createdAt: new Date().toISOString(),
      },
      {
        onSuccess: () => {
          toast.success("已保存命令片段");
          setCreateOpen(false);
          setTitle("");
          setCommand("");
          setTags("");
        },
        onError: (e) => toast.error("保存失败", { description: String(e) }),
      }
    );
  };

  const runDelete = (s: Snippet) => {
    deleteSnippet.mutate(s.id, {
      onSuccess: () => toast.success("已删除片段"),
      onError: (e) => toast.error("删除失败", { description: String(e) }),
    });
    setConfirmDelete(null);
  };

  const execute = (snippet: Snippet, mode: "send" | "copy", values: Record<string, string>) => {
    const final = applyVars(snippet.command, values);
    if (mode === "send") {
      if (!activeSessionId) {
        toast.error("没有活动终端", { description: "请先打开一个 SSH 终端再发送命令" });
        return;
      }
      emitTerminalInsert(activeSessionId, `${final}\r`);
      toast.success(`已发送到活动终端：${snippet.title}`);
    } else {
      void navigator.clipboard.writeText(final).then(
        () => toast.success("命令已复制到剪贴板"),
        () => toast.error("复制失败")
      );
    }
  };

  /** 发送前处理：有占位则弹填值框，否则直接发送 */
  const sendToTerminal = (s: Snippet) => {
    const vars = extractVars(s.command);
    if (vars.length > 0) {
      setPending({ snippet: s, mode: "send" });
      setVarValues(Object.fromEntries(vars.map((v) => [v, ""])));
    } else {
      execute(s, "send", {});
    }
  };

  const copy = (s: Snippet) => {
    const vars = extractVars(s.command);
    if (vars.length > 0) {
      setPending({ snippet: s, mode: "copy" });
      setVarValues(Object.fromEntries(vars.map((v) => [v, ""])));
    } else {
      execute(s, "copy", {});
    }
  };

  const confirmVars = () => {
    if (!pending) return;
    const missing = extractVars(pending.snippet.command).filter((v) => !(varValues[v] ?? "").trim());
    if (missing.length > 0) {
      toast.error(`请填写：${missing.join("、")}`);
      return;
    }
    execute(pending.snippet, pending.mode, varValues);
    setPending(null);
  };

  const pendingVars = pending ? extractVars(pending.snippet.command) : [];

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="text-[12px] text-secondary">
          {activeSessionId ? "将发送到活动终端" : "当前无活动终端，仅可复制"}
        </div>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          新建片段
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isLoading && !snippets ? (
          <div className="grid gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !snippets || snippets.length === 0 ? (
          <EmptyState
            icon={TerminalSquare}
            title="暂无命令片段"
            description="把常用命令存成片段，一键插入终端"
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建片段
              </Button>
            }
          />
        ) : (
          <div className="grid gap-2">
            {snippets.map((s) => (
              <div
                key={s.id}
                className="flex items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">{s.title}</span>
                    {extractVars(s.command).length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">
                        <Braces className="h-3 w-3" /> 含变量
                      </span>
                    )}
                    {s.tags &&
                      s.tags
                        .split(/[,，\s]+/)
                        .filter(Boolean)
                        .map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-accent/20 px-2 py-0.5 text-[11px] text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                  </div>
                  <pre className="mono mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-[12px] text-secondary">
                    {s.command}
                  </pre>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" title="发送到活动终端" onClick={() => sendToTerminal(s)}>
                    <Send />
                  </Button>
                  <Button variant="ghost" size="icon-sm" title="复制命令" onClick={() => copy(s)}>
                    <ClipboardCopy />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="删除"
                    className="text-muted hover:bg-danger-tint hover:text-danger"
                    onClick={() => setConfirmDelete(s)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除片段</AlertDialogTitle>
            <AlertDialogDescription>确定删除片段「{confirmDelete?.title}」？</AlertDialogDescription>
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
            <DialogTitle>新建命令片段</DialogTitle>
            <DialogDescription>保存一条常用命令，之后可一键插入终端。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>名称</Label>
              <Input placeholder="例如 查看磁盘占用" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>命令</Label>
              <textarea
                className="mono h-20 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
                placeholder="例如 df -h"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>标签（可选，空格分隔）</Label>
              <Input placeholder="例如 磁盘 运维" value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!title.trim() || !command.trim()} onClick={submitCreate}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 变量替换：发送 / 复制前填写 {{变量}} */}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>填写变量</DialogTitle>
            <DialogDescription>
              「{pending?.snippet.title}」包含 {pendingVars.length} 个变量，替换后
              {pending?.mode === "send" ? "发送到终端" : "复制"}。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            {pendingVars.map((v, vi) => (
              <div key={v} className="grid gap-1.5">
                <Label className="mono-caption text-secondary">{v}</Label>
                <Input
                  autoFocus={vi === 0}
                  value={varValues[v] ?? ""}
                  placeholder={`请输入 ${v}`}
                  onChange={(e) => setVarValues((prev) => ({ ...prev, [v]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={confirmVars}>
              {pending?.mode === "send" ? "发送" : "复制"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
