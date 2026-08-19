import { Toaster as Sonner, toast } from "sonner";
import { cn } from "@/lib/utils";

export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: cn(
            "!bg-elevated !border !border-border !text-foreground !rounded-lg !shadow-[0_8px_24px_rgba(0,0,0,0.4)] !text-[13px]"
          ),
          title: "!text-[13px] !font-medium",
          description: "!text-[12px] !text-muted",
          success: "[&_[data-icon]]:!text-success",
          error: "[&_[data-icon]]:!text-danger",
        },
      }}
    />
  );
}

export { toast };
