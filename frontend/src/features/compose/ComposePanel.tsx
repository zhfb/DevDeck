import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, Play, Square, RotateCw, Download, Hammer, RefreshCw, Trash2 } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHosts } from "@/lib/queries";
import { usePalette } from "@/stores/live";
import { invoke } from "@/lib/api";
import type { ComposeService } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";

/**
 * Docker Compose 面板（P2）— 经目标主机的 SSH exec 执行 docker compose。
 * 命令：compose_run / compose_ps（后端 services/compose.rs）
 */
export default function ComposePanel(_props: PanelProps) {
  const { data: hosts } = useHosts();
  const registerAction = usePalette((s) => s.registerAction);

  const [hostId, setHostId] = useState("");
  const [dir, setDir] = useState("");
  const [file, setFile] = useState("");
  const [services, setServices] = useState<ComposeService[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const defaultHost = useMemo(() => (hosts ?? [])[0]?.id ?? "", [hosts]);
  const effectiveHostId = hostId || defaultHost;

  const run = useCallback(
    async (args: string[], label: string) => {
      if (!effectiveHostId) {
        toast.error("请先选择目标主机");
        return;
      }
      setBusy(label);
      try {
        const res = await invoke<string>("compose_run", {
          hostId: effectiveHostId,
          dir: dir.trim() || null,
          file: file.trim() || null,
          args,
        });
        setOutput(res);
        if (args[0] === "ps") {
          const ps = await invoke<ComposeService[]>("compose_ps", {
            hostId: effectiveHostId,
            dir: dir.trim() || null,
            file: file.trim() || null,
          });
          setServices(ps);
        }
        toast.success(`${label} 完成`);
      } catch (e) {
        setOutput(String(e));
        toast.error(`${label} 失败`, { description: String(e) });
      } finally {
        setBusy(null);
      }
    },
    [effectiveHostId, dir, file]
  );

  // 命令面板入口（副作用注册，不能用 useMemo）
  useEffect(() => {
    return registerAction({
      id: "compose.up",
      title: "Compose：up -d",
      keywords: "compose docker 编排 up",
      group: "Compose",
      run: () => void run(["up", "-d"], "compose up"),
    });
  }, [registerAction, run]);

  const stateBadge = (state: string) => {
    const running = state === "running";
    return (
      <Badge variant="neutral" className={running ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}>
        {state}
      </Badge>
    );
  };

  const actionBtn = (
    label: string,
    icon: React.ReactNode,
    args: string[],
    tooltip: string,
    disabled?: boolean
  ) => (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy !== null || disabled}
      onClick={() => void run(args, tooltip)}
      title={tooltip}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：主机 + 目录 + 文件 + 动作 */}
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-border-subtle px-4 py-2">
        <div className="flex flex-col gap-1">
          <Label className="text-[11px]">目标主机</Label>
          <Select value={effectiveHostId} onValueChange={setHostId}>
            <SelectTrigger className="h-7 w-40">
              <SelectValue placeholder="选择主机" />
            </SelectTrigger>
            <SelectContent>
              {(hosts ?? []).length === 0 && (
                <SelectItem value="__none__" disabled>
                  无可用主机
                </SelectItem>
              )}
              {(hosts ?? []).map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[11px]">工作目录（可选）</Label>
          <Input
            className="h-7 w-44"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="/opt/myapp"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[11px]">文件（可选）</Label>
          <Input
            className="h-7 w-32"
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="docker-compose.yml"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {actionBtn("up", <Play />, ["up", "-d"], "启动服务")}
          {actionBtn("down", <Square />, ["down"], "停止并移除服务")}
          {actionBtn("ps", <RefreshCw />, ["ps"], "刷新状态")}
          {actionBtn("logs", <Hammer />, ["logs", "--tail=100"], "查看日志")}
          {actionBtn("build", <Download />, ["build"], "构建镜像")}
          {actionBtn("restart", <RotateCw />, ["restart"], "重启服务")}
          {actionBtn("pull", <Layers />, ["pull"], "拉取镜像")}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {services.length === 0 && !output && (
          <div className="h-full">
            <EmptyState
              icon={Layers}
              title="Docker Compose"
              description="选择主机后点击 up 启动服务，或 ps 查看服务状态；命令经 SSH 在远端执行"
              action={
                <Button variant="secondary" size="sm" onClick={() => void run(["ps"], "compose ps")}>
                  <RefreshCw /> 查看服务
                </Button>
              }
            />
          </div>
        )}

        {services.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>服务</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="font-medium text-foreground">{s.name}</TableCell>
                  <TableCell>{stateBadge(s.state)}</TableCell>
                  <TableCell>
                    <span className="mono-caption text-muted">{s.status}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {output && (
          <div className="mt-4 rounded-md border border-border-subtle bg-background-deep p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted">执行输出</span>
              <Button variant="ghost" size="icon-sm" title="清空" onClick={() => setOutput(null)}>
                <Trash2 />
              </Button>
            </div>
            <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-secondary">
              {output}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
