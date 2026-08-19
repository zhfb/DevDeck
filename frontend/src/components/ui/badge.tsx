import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "bg-hover-fill text-secondary border border-border-subtle",
        running: "bg-success-tint text-success",
        paused: "bg-warning-tint text-warning",
        stopped: "bg-hover-fill text-muted",
        danger: "bg-danger-tint text-danger",
        accent: "bg-accent-tint text-accent",
        outline: "border border-border text-secondary",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

/** Status badge with leading state dot — the DevDeck container-state idiom */
export function StatusBadge({
  label,
  variant,
  dotClass,
}: {
  label: string;
  variant?: VariantProps<typeof badgeVariants>["variant"];
  dotClass?: string;
}) {
  return (
    <Badge variant={variant ?? "neutral"}>
      <span className={cn("dot", dotClass ?? "bg-current opacity-80")} />
      {label}
    </Badge>
  );
}
