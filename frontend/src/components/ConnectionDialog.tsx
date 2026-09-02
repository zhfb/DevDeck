import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useConnect } from "@/stores/live";
import { invoke, isTauri, onEvent } from "@/lib/api";
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

interface TotpPrompt {
  promptId: string;
  hostId: string;
  name: string;
  instructions: string;
  prompts: string[];
  echo: boolean;
}

/**
 * SSH connect dialog — password entry (Keychain save) before opening a real
 * terminal session. In browser mock mode it simulates a connect.
 *
 * TOTP 2FA (P2): when the server answers password with keyboard-interactive,
 * the backend emits `ssh:auth-request`; this dialog shows a verification-code
 * field and resolves it via `ssh_auth_respond` without closing the dialog.
 */
export function ConnectionDialog() {
  const { connectTarget, closeConnect } = useConnect();
  const { data: hosts } = useHosts();
  const openTab = useWs((s) => s.openTab);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [totp, setTotp] = useState<TotpPrompt | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const totpRef = useRef<TotpPrompt | null>(null);
  const timerRef = useRef<number | null>(null);

  const setTotpState = (p: TotpPrompt | null) => {
    totpRef.current = p;
    setTotp(p);
  };

  const host = hosts?.find((h) => h.id === connectTarget?.hostId);
  const hasSavedPassword = !!host?.credentialRef;

  // 订阅后端键盘交互（TOTP）请求
  useEffect(() => {
    if (!isTauri || !connectTarget) return;
    let un: (() => void) | null = null;
    onEvent<TotpPrompt>("ssh:auth-request", (p) => {
      if (p?.hostId === connectTarget.hostId) {
        setTotpState(p);
        setTotpCode("");
        // TOTP 待输入时放宽连接超时（后端本身有 120s 等待上限）
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          toast.error("二次验证超时（150 秒），请重新连接");
          setTotpState(null);
        }, 150000);
      }
    }).then((u) => {
      un = u;
    });
    return () => {
      un?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [connectTarget]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const connect = async () => {
    if (!connectTarget) return;
    setConnecting(true);
    try {
      if (isTauri) {
        const invokePromise = invoke<{ sessionId: string; title: string }>("ssh_connect", {
          hostId: connectTarget.hostId,
          password: password || null,
          cols: 100,
          rows: 30,
        });
        // UI 超时安全网：无 TOTP 时 15s；有 TOTP 待输入时放宽到 150s
        const session = await Promise.race([
          invokePromise,
          new Promise<never>((_, reject) => {
            timerRef.current = window.setTimeout(
              () =>
                reject(
                  new Error(
                    totpRef.current
                      ? "二次验证超时（150 秒），请重新连接"
                      : "连接超时（15 秒），请检查主机地址、网络或防火墙"
                  )
                ),
              totpRef.current ? 150000 : 15000
            );
          }),
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
      setTotpState(null);
      closeConnect();
    } catch (e) {
      toast.error("连接失败", { description: String(e) });
      setTotpState(null);
    } finally {
      setConnecting(false);
    }
  };

  const submitTotp = async () => {
    if (!totp) return;
    try {
      await invoke("ssh_auth_respond", { promptId: totp.promptId, answers: [totpCode] });
      setTotpState(null);
      setTotpCode("");
      // 等待后端继续完成握手/认证
    } catch (e) {
      toast.error("验证码提交失败", { description: String(e) });
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

        {totp ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitTotp();
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="totp">
                二次验证码（TOTP）
                {totp.name && <span className="ml-1 text-[11px] font-normal text-muted">· {totp.name}</span>}
              </Label>
              {totp.instructions && (
                <p className="text-[11px] text-muted">{totp.instructions}</p>
              )}
              <Input
                id="totp"
                inputMode="numeric"
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder={totp.prompts[0] || "输入认证器 App 显示的 6 位动态码"}
                autoComplete="one-time-code"
              />
              <p className="text-[11px] text-muted">
                服务器要求键盘交互二次验证，请输入认证器（如 Google Authenticator）中的动态码。
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setTotpState(null)}>
                返回
              </Button>
              <Button type="submit" variant="primary" disabled={totpCode.trim().length === 0}>
                提交验证码
              </Button>
            </DialogFooter>
          </form>
        ) : (
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
        )}
      </DialogContent>
    </Dialog>
  );
}
