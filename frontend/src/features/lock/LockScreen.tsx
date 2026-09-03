import { useEffect, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useIdleLock } from "@/stores/idleLock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";

/**
 * 全屏锁屏遮罩：应用闲置超时后覆盖整个界面。
 * 输入 PIN 解锁；未设置 PIN 时提供"重置闲置锁"兜底。
 */
export default function LockScreen() {
  const locked = useIdleLock((s) => s.locked);
  const hasPin = useIdleLock((s) => s.config?.hasPin ?? false);
  const unlock = useIdleLock((s) => s.unlock);
  const forceUnlock = useIdleLock((s) => s.forceUnlock);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!locked) setPin("");
  }, [locked]);

  if (!locked) return null;

  const submit = async () => {
    if (!pin) return;
    setBusy(true);
    const ok = await unlock(pin);
    setBusy(false);
    if (!ok) {
      toast.error("PIN 不正确");
      setPin("");
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="flex w-80 flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/15">
          <Lock className="h-8 w-8 text-accent" />
        </div>
        <div className="text-center">
          <div className="text-[15px] font-semibold text-foreground">DevDeck 已锁定</div>
          <div className="mt-0.5 text-[12px] text-secondary">闲置超时，请输入解锁 PIN</div>
        </div>
        <div className="flex w-full gap-2">
          <Input
            autoFocus
            type="password"
            inputMode="numeric"
            placeholder="解锁 PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            className="h-10 flex-1 text-center text-lg tracking-[0.3em]"
          />
          <Button onClick={() => void submit()} disabled={busy || !pin} className="h-10">
            <ShieldCheck className="mr-1.5 h-4 w-4" /> 解锁
          </Button>
        </div>
        {!hasPin && (
          <Button variant="ghost" size="sm" onClick={forceUnlock}>
            未设置 PIN · 重置闲置锁
          </Button>
        )}
      </div>
    </div>
  );
}
