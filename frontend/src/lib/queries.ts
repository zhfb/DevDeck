import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/api";
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
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => invoke<DockerEngine[]>("engines.list"),
    refetchInterval: 10_000,
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
  return useQuery({
    queryKey: ["containers", engineId ?? "all"],
    queryFn: () => invoke<Container[]>("containers.list", engineId ? { engineId } : {}),
    refetchInterval: 5000,
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
  return useQuery({
    queryKey: ["images", engineId ?? "all"],
    queryFn: () => invoke<DockerImage[]>("images.list", engineId ? { engineId } : {}),
  });
}

export function useTunnels() {
  return useQuery({
    queryKey: ["tunnels"],
    queryFn: () => invoke<Tunnel[]>("tunnels.list"),
    refetchInterval: 5000,
  });
}

export function useHostStats(hostId: string | null) {
  return useQuery({
    queryKey: ["host-stats", hostId],
    queryFn: () => invoke<HostStats | null>("hosts.stats", { hostId }),
    enabled: !!hostId,
    refetchInterval: 5000,
  });
}

export function useHostStatsHistory(hostId: string | null) {
  return useQuery({
    queryKey: ["host-stats-history", hostId],
    queryFn: () => invoke<HostStatsHistoryPoint[]>("hosts.stats_history", { hostId }),
    enabled: !!hostId,
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Mutations (write-through, invalidate on success)
// ---------------------------------------------------------------------------
const qc = () => useQueryClient();

export function useContainerAction() {
  const queryClient = qc();
  return useMutation({
    mutationFn: ({ action, id }: { action: "start" | "stop" | "restart" | "pause" | "remove"; id: string }) =>
      invoke(`containers.${action}`, { id }),
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
  return useMutation({
    mutationFn: ({ image, engineId }: { image: string; engineId?: string }) =>
      invoke("images.pull", { image, engineId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["images"] }),
  });
}
