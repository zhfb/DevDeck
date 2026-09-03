import { describe, it, expect } from "vitest";
import { extractVars, applyVars } from "@/lib/snippets";

describe("snippets.extractVars", () => {
  it("extracts simple placeholder names", () => {
    expect(extractVars("docker exec -it {{container}} bash")).toEqual(["container"]);
  });

  it("deduplicates repeated variables", () => {
    expect(extractVars("echo {{name}} && whoami {{name}}")).toEqual(["name"]);
  });

  it("trims surrounding whitespace inside braces", () => {
    expect(extractVars("scp {{ host }}:/tmp/x ./")).toEqual(["host"]);
  });

  it("ignores commands without placeholders", () => {
    expect(extractVars("ls -la")).toEqual([]);
    expect(extractVars("")).toEqual([]);
  });

  it("extracts multiple distinct variables in order", () => {
    expect(extractVars("ssh {{user}}@{{host}} -p {{port}}")).toEqual([
      "user",
      "host",
      "port",
    ]);
  });
});

describe("snippets.applyVars", () => {
  it("replaces placeholders with provided values", () => {
    expect(
      applyVars("docker exec -it {{container}} bash", { container: "web" })
    ).toBe("docker exec -it web bash");
  });

  it("keeps placeholders that have no value", () => {
    expect(applyVars("echo {{missing}}", {})).toBe("echo {{missing}}");
  });

  it("replaces multiple variables at once", () => {
    expect(applyVars("ssh {{u}}@{{h}}", { u: "root", h: "10.0.0.1" })).toBe(
      "ssh root@10.0.0.1"
    );
  });

  it("handles mixed present and missing variables", () => {
    expect(applyVars("{{a}} and {{b}}", { a: "1" })).toBe("1 and {{b}}");
  });

  it("round-trips: extract then apply", () => {
    const cmd = "docker exec -it {{c}} sh -c 'cat /etc/{{file}}'";
    const values = { c: "app", file: "hostname" };
    expect(applyVars(cmd, values)).toBe("docker exec -it app sh -c 'cat /etc/hostname'");
  });
});
