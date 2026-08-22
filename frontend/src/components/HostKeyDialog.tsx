import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { invoke, onEvent } from "@/lib/api";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface HostKeyVerifyPayload {
  requestId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

interface HostKeyChangedPayload {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  recordedFingerprint: string;
}

/**
 * Global singleton for known_hosts TOFU prompts (G3):
 *  - `ssh:host-key-verify`  → first connection: 信任并连接 / 拒绝
 *  - `ssh:host-key-changed` → fingerprint mismatch: warn + offer to forget
 *
 * Mount once next to <ConnectionDialog /> in App.tsx; event listeners live
 * inside this component, so no wiring is needed elsewhere.
 */
export function HostKeyDialog() {
  const [verify, setVerify] = useState<HostKeyVerifyPayload | null>(null);
  const [changed, setChanged] = useState<HostKeyChangedPayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const un1 = onEvent<HostKeyVerifyPayload>("ssh:host-key-verify", setVerify);
    const un2 = onEvent<HostKeyChangedPayload>("ssh:host-key-changed", setChanged);
    return () => {
      void un1.then((u) => u());
      void un2.then((u) => u());
    };
  }, []);

  const decide = async (accept: boolean) => {
    if (!verify || busy) return;
    setBusy(true);
    try {
      await invoke("ssh_host_key_decide", { requestId: verify.requestId, accept });
      setVerify(null);
    } catch (e) {
      toast.error("主机密钥确认失败", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      const n = await invoke<number>("ssh_known_hosts_forget", {
        host: changed.host,
        port: changed.port,
      });
      toast.success(`已删除 ${n} 条主机密钥记录，下次连接将重新确认`);
      setChanged(null);
    } catch (e) {
      toast.error("删除失败", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* First-connect TOFU */}
      <Dialog open={!!verify} onOpenChange={(o) => !o && !busy && setVerify(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" />
              确认主机密钥
            </DialogTitle>
            <DialogDescription>首次连接，确认信任此主机密钥吗？</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-hover-fill p-3 text-[12px]">
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">主机</span>
              <span className="mono text-right text-foreground">
                {verify?.host}:{verify?.port}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">算法</span>
              <span className="mono text-right text-foreground">{verify?.keyType}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">指纹</span>
              <span className="mono break-all text-right text-foreground">
                {verify?.fingerprint}
              </span>
            </div>
          </div>

          <p className="text-[12px] leading-relaxed text-muted">
            确认后指纹将被记录，后续连接会自动校验。请核实这是你期望连接的主机。
          </p>

          <DialogFooter>
            <Button variant="ghost" onClick={() => void decide(false)} disabled={busy}>
              拒绝
            </Button>
            <Button variant="primary" onClick={() => void decide(true)} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              信任并连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Host key changed — possible MITM */}
      <Dialog open={!!changed} onOpenChange={(o) => !o && !busy && setChanged(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-danger" />
              主机密钥已变更
            </DialogTitle>
            <DialogDescription>
              主机密钥已变更，可能遭受中间人攻击，已在设置中删除记录？
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 p-3 text-[12px]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span className="leading-relaxed text-foreground">
              连接已被拒绝。如果这是你预期中的变更（例如服务器重装系统），请删除旧记录后重新连接。
            </span>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-hover-fill p-3 text-[12px]">
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">主机</span>
              <span className="mono text-right text-foreground">
                {changed?.host}:{changed?.port}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">当前指纹</span>
              <span className="mono break-all text-right text-foreground">{changed?.fingerprint}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">已记录指纹</span>
              <span className="mono break-all text-right text-foreground">
                {changed?.recordedFingerprint}
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setChanged(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void forget()} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              删除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
