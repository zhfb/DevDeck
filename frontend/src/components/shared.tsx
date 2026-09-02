import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared empty state — used across panels (no containers, no hosts, …) */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-2 p-8 text-center", className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-hover-fill">
        <Icon className="h-5 w-5 text-muted" />
      </div>
      <div className="text-[13px] font-medium text-secondary">{title}</div>
      {description && <div className="max-w-[260px] text-[12px] leading-relaxed text-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Engine source badge — OrbStack / Docker Desktop / Colima / Podman / 内置 / SSH:host */
export function EngineBadge({ kind, hostName }: { kind: string; hostName?: string }) {
  const label =
    kind === "orbstack"
      ? "OrbStack"
      : kind === "docker-desktop"
        ? "Docker Desktop"
        : kind === "colima"
          ? "Colima"
          : kind === "podman"
            ? "Podman"
            : kind === "embedded"
              ? "内置引擎"
              : kind === "ssh-remote"
                ? `SSH: ${hostName ?? "remote"}`
                : kind;
  const cls =
    kind === "orbstack"
      ? "text-accent bg-accent-tint border-accent/20"
      : kind === "docker-desktop"
        ? "text-success bg-success-tint border-success/20"
        : kind === "embedded"
          ? "text-primary bg-accent-tint border-primary/20"
          : kind === "ssh-remote"
            ? "text-warning bg-warning-tint border-warning/20"
            : "text-muted bg-hover-fill border-border-subtle";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-px mono-caption leading-4",
        cls
      )}
    >
      {label}
    </span>
  );
}

/** Environment color rail + label (Dev/Staging/Prod) */
export function EnvTag({ env }: { env: "dev" | "staging" | "prod" | "none" }) {
  if (env === "none") return null;
  const color =
    env === "dev" ? "var(--env-dev)" : env === "staging" ? "var(--env-staging)" : "var(--env-prod)";
  const label = env === "dev" ? "Dev" : env === "staging" ? "Staging" : "Prod";
  return (
    <span
      className="inline-flex items-center gap-1 mono-caption"
      style={{ color }}
    >
      <span className="dot" style={{ background: color, boxShadow: "none" }} />
      {label}
    </span>
  );
}
