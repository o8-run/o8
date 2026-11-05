import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "@/app/api/orchestrator/comparison-diff/route";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "cmpdiff-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-q", "-m", "one");
  git("branch", "base0");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git("add", "-A"); git("commit", "-q", "-m", "two");
});

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

function req(base: string): Request {
  const u = new URL("http://127.0.0.1/api/orchestrator/comparison-diff");
  u.searchParams.set("worktree", repo);
  u.searchParams.set("base", base);
  return new Request(u);
}

describe("comparison-diff base ref guard (#5570)", () => {
  it("refuses a leading-dash base read as a git option and writes no file", async () => {
    const victim = join(repo, "pwned");
    const res = await GET(req(`--output=${victim}`));
    expect(res.status).toBe(400);
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(`${victim}...HEAD`)).toBe(false);
  });

  it("refuses a base with unsafe characters", async () => {
    const res = await GET(req("main=x out.txt"));
    expect(res.status).toBe(400);
  });

  it("still returns the committed diff for a normal base", async () => {
    const res = await GET(req("base0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.base).toBe("base0");
    expect(body.changedFiles.map((f: { path: string }) => f.path)).toContain("a.txt");
  });
});
