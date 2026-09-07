// DevDeck AI 助手 — 共享服务层。
// 只做两件事：① 读写用户配置（OpenAI 兼容端点）；② 一次 chat completions 调用。
// 配置仅存 localStorage（本机），绝不上报；Key 只用于 Authorization 头。
// 供 AI 命令面板（自然语言 → 安全动作）与日志智能诊断复用。

export interface AiConfig {
  /** 如 https://api.openai.com/v1 或任意 OpenAI 兼容网关（DeepSeek/硅基流动/Ollama…） */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const CONFIG_KEY = "devdeck.ai.config.v1";

export function getAiConfig(): AiConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as AiConfig;
    if (!cfg.baseUrl || !cfg.model) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function isAiConfigured(): boolean {
  return getAiConfig() !== null;
}

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

/** 调用 OpenAI 兼容 /chat/completions，返回助手文本。失败抛出可读错误。 */
export async function aiChat(messages: AiMessage[], opts?: { maxTokens?: number }): Promise<string> {
  const cfg = getAiConfig();
  if (!cfg) {
    throw new Error("AI 未配置：请到 设置 → AI 助手 填写 Base URL / API Key / 模型");
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.2,
      max_tokens: opts?.maxTokens ?? 1024,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`AI 请求失败（${resp.status}）：${body.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("AI 返回为空，请重试或更换模型");
  }
  return content.trim();
}

/** 从 AI 文本中尽力提取 JSON（容错：去掉 ```json 围栏与前后杂讯）。 */
export function extractJson<T = unknown>(text: string): T | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
