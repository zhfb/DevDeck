import { useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { invoke, onEvent } from "@/lib/api";
import { useTaskStore } from "@/features/tasks/taskStore";
import { powerInterval, usePower } from "@/stores/power";
import type {
  Container,
  DockerEngine,
  DockerImage,
  Host,
  HostGroup,
  HostStats,
  HostStatsHistoryPoint,
  Tunnel,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Queries (low-frequency, TanStack Query)
// ---------------------------------------------------------------------------
export function useEngines() {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => invoke<DockerEngine[]>("engines.list"),
    refetchInterval: powerInterval(mode, 10_000, 60_000),
    refetchIntervalInBackground: true,
  });
}

export function useHosts() {
  return useQuery({
    queryKey: ["hosts"],
    queryFn: () => invoke<Host[]>("hosts.list"),
  });
}

export function useHostGroups() {
  return useQuery({
    queryKey: ["host-groups"],
    queryFn: () => invoke<HostGroup[]>("hosts.groups"),
  });
}

export function useContainers(engineId?: string) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["containers", engineId ?? "all"],
    queryFn: () => invoke<Container[]>("containers.list", engineId ? { engineId } : {}),
    refetchInterval: powerInterval(mode, 5_000, 30_000),
    refetchIntervalInBackground: true,
  });
}

export function useContainer(id: string | null) {
  return useQuery({
    queryKey: ["container", id],
    queryFn: () => invoke<Container | null>("containers.get", { id }),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useImages(engineId?: string) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["images", engineId ?? "all"],
    queryFn: () => invoke<DockerImage[]>("images.list", engineId ? { engineId } : {}),
    refetchInterval: powerInterval(mode, 30_000, 120_000),
    refetchIntervalInBackground: true,
  });
}

export function useTunnels() {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["tunnels"],
    queryFn: () => invoke<Tunnel[]>("tunnels.list"),
    refetchInterval: powerInterval(mode, 5_000, 30_000),
    refetchIntervalInBackground: true,
  });
}

export function useHostStats(hostId: string | null) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["host-stats", hostId],
    queryFn: () => invoke<HostStats | null>("hosts.stats", { hostId }),
    enabled: !!hostId,
    refetchInterval: powerInterval(mode, 5_000, 30_000),
    refetchIntervalInBackground: true,
  });
}

export function useHostStatsHistory(hostId: string | null) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["host-stats-history", hostId],
    queryFn: () => invoke<HostStatsHistoryPoint[]>("hosts.stats_history", { hostId }),
    enabled: !!hostId,
    refetchInterval: powerInterval(mode, 30_000, 120_000),
    refetchIntervalInBackground: true,
  });
}

// ---------------------------------------------------------------------------
// Mutations (write-through, invalidate on success)
// ---------------------------------------------------------------------------
const qc = () => useQueryClient();

export function useContainerAction() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({
      action,
      id,
      engineId,
    }: {
      action: "start" | "stop" | "restart" | "pause" | "remove";
      id: string;
      engineId: string;
    }) => invoke(`containers.${action}`, { engineId, id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
}

export function useTunnelAction() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ action, id }: { action: "start" | "stop"; id: string }) => invoke(`tunnels.${action}`, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
  });
}

export function usePullImage() {
  const queryClient = qc();
  const addTask = useTaskStore((s) => s.addTask);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void onEvent<{
      taskId: string;
      image: string;
      percent?: number;
      status: string;
      detail?: string;
      state?: "done" | "error";
    }>("docker:pull-progress", (event) => {
      if (!active) return;
      const store = useTaskStore.getState();
      const task = store.tasks.find((item) => item.id === event.taskId);
      if (!task) return;
      store.updateTask(event.taskId, {
        progress: event.percent ?? task.progress,
        detail: event.detail ? `${event.status} · ${event.detail}` : event.status,
        status: event.state === "done" ? "done" : event.state === "error" ? "error" : "running",
      });
      if (event.state === "done") {
        void queryClient.invalidateQueries({ queryKey: ["images"] });
      }
    }).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [queryClient]);

  return useMutation({
    mutationFn: ({ image, engineId }: { image: string; engineId?: string }) =>
      invoke("images.pull", { image, engineId }),
    onSuccess: (taskId: unknown, variables) => {
      addTask({
        id: String(taskId),
        title: `拉取 ${variables.image}`,
        kind: "pull",
        status: "running",
        progress: 0,
        detail: "等待 Docker 返回进度…",
      });
    },
  });
}
