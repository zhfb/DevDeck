import { CheckCircle2, CircleDashed, ListTodo, Loader2, RotateCw, Trash2, XCircle } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useTaskStore, type TaskItem, type TaskKind, type TaskStatus } from "./taskStore";
import { invoke } from "@/lib/api";

const KIND_LABEL: Record<TaskKind, string> = {
  pull: "拉取",
  upload: "上传",
  download: "下载",
  deploy: "部署",
  generic: "任务",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "等待中",
  running: "进行中",
  done: "已完成",
  error: "失败",
};

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "error":
      return <XCircle className="h-4 w-4 text-danger" />;
    default:
      return <CircleDashed className="h-4 w-4 text-quaternary" />;
  }
}

function TaskCard({ task, onCancel, onRetry }: { task: TaskItem; onCancel: (task: TaskItem) => void; onRetry: (task: TaskItem) => void }) {
  const indicatorClass =
    task.status === "error"
      ? "bg-danger"
      : task.status === "done"
        ? "bg-success"
        : task.status === "pending"
          ? "bg-quaternary"
          : undefined;

  return (
    <div className="rounded-lg border border-border-subtle bg-elevated px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={task.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground" title={task.title}>
              {task.title}
            </span>
            <span className="mono-caption shrink-0 text-quaternary">{KIND_LABEL[task.kind]}</span>
            <span className="shrink-0 text-[11px] text-muted">{STATUS_LABEL[task.status]}</span>
          </div>
          {task.detail && (
            <div className="mt-0.5 truncate text-[12px] text-muted" title={task.detail}>
              {task.detail}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Progress value={task.progress} indicatorClassName={indicatorClass} className="flex-1" />
            <span className="mono-caption w-9 shrink-0 text-right text-quaternary">{task.progress}%</span>
          </div>
          {(task.status === "running" || task.status === "pending") && (task.kind === "upload" || task.kind === "download") && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => onCancel(task)}>取消传输</Button>
          )}
          {task.status === "error" && (task.meta?.command === "sftp_transfer" || task.meta?.command === "sftp_transfer_batch") && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => onRetry(task)}><RotateCw />重试</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 任务队列面板 — 传输 / 拉取 / 部署等操作的进度队列。 */
export default function TasksPanel(_props: PanelProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const clearFinished = useTaskStore((s) => s.clearFinished);
  const updateTask = useTaskStore((s) => s.updateTask);
  const addTask = useTaskStore((s) => s.addTask);

  const cancelTask = async (task: TaskItem) => {
    try {
      await invoke("sftp_transfer_cancel", { taskId: task.id });
      updateTask(task.id, { status: "error", detail: "传输已取消" });
    } catch (error) {
      updateTask(task.id, { status: "error", detail: String(error) });
    }
  };

  const retryTask = async (task: TaskItem) => {
    const meta = task.meta;
    if (!meta || (meta.command !== "sftp_transfer" && meta.command !== "sftp_transfer_batch")) return;
    try {
      const taskId = await invoke<string>(meta.command, meta.command === "sftp_transfer_batch"
        ? { input: { sessionId: meta.sessionId, localPath: meta.localPath, remotePath: meta.remotePath, direction: meta.direction, concurrency: 4 } }
        : { sessionId: meta.sessionId, localPath: meta.localPath, remotePath: meta.remotePath, direction: meta.direction, resume: true });
      addTask({ id: taskId, title: task.title, kind: task.kind, status: "running", progress: task.progress, detail: "重试中…", meta });
    } catch (error) {
      updateTask(task.id, { detail: `重试失败：${String(error)}` });
    }
  };

  const activeCount = tasks.filter((t) => t.status === "pending" || t.status === "running").length;
  const finishedCount = tasks.length - activeCount;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <ListTodo className="h-4 w-4 text-secondary" />
        <span className="text-[13px] font-medium text-foreground">任务队列</span>
        {activeCount > 0 && (
          <span className="text-[12px] text-muted">{activeCount} 个进行中</span>
        )}
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => clearFinished()}
          disabled={finishedCount === 0}
          title="移除所有已完成 / 失败的任务"
        >
          <Trash2 />
          清除已完成
        </Button>
      </div>

      {/* Task list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tasks.length === 0 ? (
          <EmptyState
            icon={ListTodo}
            title="暂无任务"
            description="拉取镜像、文件传输、部署等操作会显示在这里"
          />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} onCancel={cancelTask} onRetry={retryTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
