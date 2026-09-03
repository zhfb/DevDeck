/**
 * Snippets 变量替换工具 — 把 {{变量名}} 占位从命令中提取 / 替换。
 * 纯函数，便于单元测试。
 */

/** 提取命令中的变量名（去重、去空白），如 `docker exec -it {{container}} bash` → ["container"] */
export function extractVars(cmd: string): string[] {
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 用变量表替换命令中的 {{变量名}}；未提供的变量保留原占位 */
export function applyVars(cmd: string, values: Record<string, string>): string {
  return cmd.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, raw: string) => {
    const name = raw.trim();
    return values[name] ?? `{{${name}}}`;
  });
}
