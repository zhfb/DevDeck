import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useConnect } from "@/stores/live";
import { invoke, isTauri } from "@/lib/api";
import { useHosts } from "@/lib/queries";
import { useWorkspace as useWs } from "@/stores/workspace";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SSH connect dialog — password entry (Keychain save) before opening a real
 * terminal session. In browser mock mode it simulates a connect.
 */
export function ConnectionDialog() {
  const { connectTarget, closeConnect } = useConnect();
  const { data: hosts } = useHosts();
  const openTab = useWs((s) => s.openTab);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const host = hosts?.find((h) => h.id === connectTarget?.hostId);
  const hasSavedPassword = !!host?.credentialRef;

  const connect = async () => {
    if (!connectTarget) return;
    setConnecting(true);
    try {
      if (isTauri) {
        // Bound the invoke — a hung SSH handshake must not leave the dialog
        // spinning forever (backend now also timeouts, this is a UI safety net).
        const session = await Promise.race([
          invoke<{ sessionId: string; title: string }>("ssh_connect", {
            hostId: connectTarget.hostId,
            password: password || null,
            cols: 100,
            rows: 30,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("连接超时（15 秒），请检查主机地址、网络或防火墙")),
              15000
            )
          ),
        ]);
        openTab({
          kind: "ssh",
          title: session.title || connectTarget.hostName,
          hostId: connectTarget.hostId,
          sessionId: session.sessionId,
          env: host?.env ?? "none",
        });
        toast.success(`已连接 ${connectTarget.hostName}`);
      } else {
        // browser mock — simulate a session
        await new Promise((r) => setTimeout(r, 600));
        openTab({
          kind: "ssh",
          title: connectTarget.hostName,
          hostId: connectTarget.hostId,
          env: host?.env ?? "none",
        });
        toast.success(`已连接 ${connectTarget.hostName}（演示）`);
      }
      setPassword("");
      closeConnect();
    } catch (e) {
      toast.error("连接失败", { description: String(e) });
    } finally {
      setConnecting(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void connect();
  };

  return (
    <Dialog open={!!connectTarget} onOpenChange={(o) => !o && !connecting && closeConnect()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent" />
            连接 {connectTarget?.hostName ?? ""}
          </DialogTitle>
          <DialogDescription className="mono">
            {connectTarget ? `${connectTarget.user}@${connectTarget.address}` : ""}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw">
              密码
              {hasSavedPassword && <span className="ml-1 text-[11px] font-normal text-success">（已存入 Keychain）</span>}
            </Label>
            <Input
              id="pw"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasSavedPassword ? "留空即可使用已保存的密码" : "输入 SSH 密码（留空尝试免密）"}
              autoComplete="off"
            />
            {hasSavedPassword && (
              <p className="text-[11px] text-muted">此主机已保存密码，直接点击「连接」即可；输入新密码将覆盖旧密码。</p>
            )}
          </div>
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-hover-fill px-3 py-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-success" />
              <div className="flex flex-col">
                <span className="text-[12px] font-medium text-foreground">存入 macOS Keychain</span>
                <span className="text-[11px] text-muted">凭据不落盘，仅存系统钥匙串</span>
              </div>
            </div>
            <Switch checked={remember} onCheckedChange={setRemember} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeConnect} disabled={connecting}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={connecting}>
              {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {connecting ? "连接中…" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
