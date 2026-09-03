import { useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { invoke, onEvent } from "@/lib/api";
import { useTaskStore } from "@/features/tasks/taskStore";
import { powerInterval, usePower } from "@/stores/power";
import type {
  Container,
  DockerEngine,
  DockerImage,
  DockerNetwork,
  DockerVolume,
  Host,
  HostGroup,
  HostProcess,
  HostStats,
  HostStatsHistoryPoint,
  IdleLockConfig,
  RegistryConfig,
  RegistryRepo,
  Snippet,
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

// ---------------------------------------------------------------------------
// Volumes / Networks (P1/P2)
// ---------------------------------------------------------------------------
export function useVolumes(engineId?: string) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["volumes", engineId ?? "all"],
    queryFn: () => invoke<DockerVolume[]>("volumes.list", engineId ? { engineId } : {}),
    refetchInterval: powerInterval(mode, 15_000, 60_000),
    refetchIntervalInBackground: true,
  });
}

export function useNetworks(engineId?: string) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["networks", engineId ?? "all"],
    queryFn: () => invoke<DockerNetwork[]>("networks.list", engineId ? { engineId } : {}),
    refetchInterval: powerInterval(mode, 15_000, 60_000),
    refetchIntervalInBackground: true,
  });
}

export function useVolumeAction() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ action, name, engineId }: { action: "create" | "remove"; name: string; engineId?: string }) =>
      invoke(action === "create" ? "volumes.create" : "volumes.remove", { name, engineId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["volumes"] }),
  });
}

export function useNetworkAction() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ action, id, name, engineId }: { action: "create" | "remove"; id?: string; name?: string; engineId?: string }) =>
      invoke(action === "create" ? "networks.create" : "networks.remove", action === "create" ? { name, engineId } : { id, engineId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["networks"] }),
  });
}

// ---------------------------------------------------------------------------
// Container create (P0: 运行新容器表单)
// ---------------------------------------------------------------------------
export function useContainerCreate() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ engineId, name, image, ports }: { engineId: string; name: string; image: string; ports?: string }) =>
      invoke("containers.create", { engineId, name, image, ports }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      void queryClient.invalidateQueries({ queryKey: ["images"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Host processes (P2)
// ---------------------------------------------------------------------------
export function useHostProcesses(hostId: string | null) {
  const mode = usePower((s) => s.mode);
  return useQuery({
    queryKey: ["host-processes", hostId],
    queryFn: () => invoke<HostProcess[]>("host.processes", { hostId }),
    enabled: !!hostId,
    refetchInterval: powerInterval(mode, 10_000, 60_000),
    refetchIntervalInBackground: true,
  });
}

// ---------------------------------------------------------------------------
// Registries (镜像仓库：配置 + 浏览仓库/tags)
// ---------------------------------------------------------------------------
export function useRegistries() {
  return useQuery({
    queryKey: ["registries"],
    queryFn: () => invoke<RegistryConfig[]>("registries.list"),
    refetchIntervalInBackground: true,
  });
}

export function useRegistryPing(id: string | null) {
  return useQuery({
    queryKey: ["registry-ping", id],
    queryFn: () => invoke<string>("registry.ping", { id: id! }),
    enabled: !!id,
    retry: false,
    staleTime: 60_000,
  });
}

export function useRegistryRepos(id: string | null) {
  return useQuery({
    queryKey: ["registry-repos", id],
    queryFn: () => invoke<RegistryRepo[]>("registry.repos", { id: id! }),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useRegistryTags(id: string | null, repo: string | null) {
  return useQuery({
    queryKey: ["registry-tags", id, repo],
    queryFn: () => invoke<string[]>("registry.tags", { id: id!, repo: repo! }),
    enabled: !!id && !!repo,
    staleTime: 15_000,
  });
}

export function useRegistrySave() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ registry, password }: { registry: RegistryConfig; password?: string | null }) =>
      invoke("registries.save", { registry, password: password ?? null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["registries"] }),
  });
}

export function useRegistryDelete() {
  const queryClient = qc();
  return useMutation({
    mutationFn: (id: string) => invoke("registries.delete", { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registries"] });
      queryClient.invalidateQueries({ queryKey: ["registry-repos"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Idle auto-lock
// ---------------------------------------------------------------------------
export function useIdleLockConfig() {
  return useQuery({
    queryKey: ["idle-lock-config"],
    queryFn: () => invoke<IdleLockConfig>("idle_lock_config.get"),
    refetchIntervalInBackground: true,
  });
}

export function useIdleLockConfigSet() {
  const queryClient = qc();
  return useMutation({
    mutationFn: (args: {
      enabled: boolean;
      timeoutMinutes?: number;
      useTouchId?: boolean;
      pin?: string | null;
    }) => invoke("idle_lock_config.set", args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["idle-lock-config"] }),
  });
}

export function useIdleLockUnlock() {
  return useMutation({
    mutationFn: (pin: string) => invoke<boolean>("idle_lock.unlock", { pin }),
  });
}

// ---------------------------------------------------------------------------
// sudo 自动填充（SSH 会话）
// ---------------------------------------------------------------------------
export function useSudoConfig() {
  return useQuery({
    queryKey: ["sudo-config"],
    queryFn: () => invoke<boolean>("sudo_config.get"),
  });
}

export function useSudoConfigSet() {
  const queryClient = qc();
  return useMutation({
    mutationFn: (enabled: boolean) => invoke("sudo_config.set", { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sudo-config"] }),
  });
}

// ---------------------------------------------------------------------------
// Snippets (P1)
// ---------------------------------------------------------------------------
export function useSnippets() {  return useQuery({
    queryKey: ["snippets"],
    queryFn: () => invoke<Snippet[]>("snippets.list"),
  });
}

export function useSnippetSave() {
  const queryClient = qc();
  return useMutation({
    mutationFn: (snippet: Snippet) => invoke("snippets.save", { snippet }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snippets"] }),
  });
}

export function useSnippetDelete() {
  const queryClient = qc();
  return useMutation({
    mutationFn: (id: string) => invoke("snippets.delete", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snippets"] }),
  });
}
