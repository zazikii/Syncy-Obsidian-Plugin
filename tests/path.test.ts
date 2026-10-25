import { describe, expect, it } from "vitest";
import { buildExcludePatterns, compileExcludes, globToRegExp } from "../src/util/glob";
import {
  conflictCopyPath,
  normalizeVaultPath,
  pathKey,
  replacePathPrefix,
  uniquePath,
} from "../src/util/path";

describe("paths", () => {
  it("normalizes separators and unicode", () => {
    expect(normalizeVaultPath("Notes\\Über/./hello.md")).toBe("Notes/Über/hello.md");
    expect(pathKey("Notes/Hello.MD")).toBe("notes/hello.md");
    expect(() => normalizeVaultPath("../outside.md")).toThrow();
  });

  it("creates unique conflict copy names", () => {
    const date = new Date(2026, 9, 25, 14, 35, 12);
    expect(conflictCopyPath("Notes/Hello.md", date)).toBe(
      "Notes/Hello (conflict 2026-10-25 143512).md",
    );
    const taken = new Set(["Notes/Hello (conflict 2026-10-25 143512).md"]);
    expect(
      uniquePath("Notes/Hello (conflict 2026-10-25 143512).md", (path) => taken.has(path)),
    ).toBe("Notes/Hello (conflict 2026-10-25 143512) 2.md");
  });

  it("replaces folder prefixes", () => {
    expect(replacePathPrefix("Old/Child/note.md", "Old", "New")).toBe("New/Child/note.md");
    expect(replacePathPrefix("Old", "Old", "New")).toBe("New");
  });
});

describe("exclusions", () => {
  const defaults = buildExcludePatterns({
    syncConfig: true,
    syncWorkspace: false,
    syncPluginData: false,
    extraPatterns: [],
  });
  const excluded = compileExcludes(defaults);

  it("always excludes Syncy's own folder and OS junk", () => {
    expect(excluded(".obsidian/plugins/syncy/data.json")).toBe(true);
    expect(excluded(".obsidian/plugins/syncy")).toBe(true);
    expect(excluded("Notes/.DS_Store")).toBe(true);
    expect(excluded("Thumbs.db")).toBe(true);
  });

  it("excludes workspace and plugin data by default", () => {
    expect(excluded(".obsidian/workspace.json")).toBe(true);
    expect(excluded(".obsidian/workspace-mobile.json")).toBe(true);
    expect(excluded(".obsidian/plugins/obsidian-git/data.json")).toBe(true);
    expect(excluded(".obsidian/plugins/obsidian-git/main.js")).toBe(false);
    expect(excluded(".obsidian/app.json")).toBe(false);
  });

  it("supports basename patterns and double-star globs", () => {
    expect(globToRegExp("*.tmp")!.test("Notes/deep/file.tmp")).toBe(true);
    expect(globToRegExp("**/*.tmp")!.test("Notes/deep/file.tmp")).toBe(true);
    expect(globToRegExp("Notes/**")!.test("Notes/deep/file.md")).toBe(true);
    expect(globToRegExp("Notes/**")!.test("Other/Notes.md")).toBe(false);
    expect(globToRegExp("*.tmp")!.test("file.tmp.txt")).toBe(false);
  });

  it("lets a user exclude config and plugin data entirely", () => {
    const allOff = compileExcludes(
      buildExcludePatterns({
        syncConfig: false,
        syncWorkspace: false,
        syncPluginData: false,
        extraPatterns: ["Private/**"],
      }),
    );
    expect(allOff(".obsidian/app.json")).toBe(true);
    expect(allOff("Private/secret.md")).toBe(true);
    expect(allOff("Notes/hello.md")).toBe(false);
  });
});
