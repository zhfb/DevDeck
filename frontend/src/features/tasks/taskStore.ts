import { create } from "zustand";

/**
 * 任务队列 store — 独立 zustand store（不依赖 stores/workspace、stores/live）。
 * 由任务队列面板 (TasksPanel) 消费；parent 集成时通过导出的 actions / subscribe
 * 从外部事件（docker pull 进度、文件传输、部署等）向队列推送任务。
 */

export type TaskKind = "pull" | "upload" | "download" | "deploy" | "generic";
export type TaskStatus = "pending" | "running" | "done" | "error";

export interface TaskItem {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  /** 0-100 */
  progress: number;
  detail: string;
  meta?: Record<string, string>;
}

/** addTask 入参：不传 id 时自动生成 */
export type NewTask = Omit<TaskItem, "id"> & { id?: string };

export type TaskPatch = Partial<Omit<TaskItem, "id">>;

interface TaskStoreState {
  tasks: TaskItem[];
  addTask: (task: NewTask) => string;
  updateTask: (id: string, patch: TaskPatch) => void;
  removeTask: (id: string) => void;
  clearFinished: () => void;
}

let taskSeq = 0;
const nextTaskId = () => `task-${Date.now().toString(36)}-${++taskSeq}`;

const clampProgress = (p: number) => Math.max(0, Math.min(100, Math.round(p)));

export const useTaskStore = create<TaskStoreState>((set) => ({
  tasks: [],

  addTask: (task) => {
    const id = task.id ?? nextTaskId();
    set((s) => ({
      tasks: [...s.tasks, { ...task, id, progress: clampProgress(task.progress) }],
    }));
    return id;
  },

  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              ...patch,
              progress: patch.progress != null ? clampProgress(patch.progress) : t.progress,
            }
          : t
      ),
    })),

  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  clearFinished: () =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.status !== "done" && t.status !== "error") })),
}));

/**
 * 订阅任务列表变化（外部集成用）。
 * 例：mock 定时 push 演示、或 onEvent("docker:pull-progress") 桥接：
 *   subscribe((tasks) => { ... });   // 每次任务增删/更新触发，参数为最新 tasks
 * 返回取消订阅函数。
 */
export const subscribe = (listener: (tasks: TaskItem[]) => void): (() => void) =>
  useTaskStore.subscribe((state, prevState) => {
    if (state.tasks !== prevState.tasks) listener(state.tasks);
  });
