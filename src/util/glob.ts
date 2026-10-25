import { normalizeVaultPath } from "./path";

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globBodyToRegExp(pattern: string): string {
  let output = "";
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index]!;

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const isDirectoryPrefix = pattern[index + 2] === "/";
        if (isDirectoryPrefix) {
          output += "(?:.*/)?";
          index += 3;
          continue;
        }
        output += ".*";
        index += 2;
        continue;
      }
      output += "[^/]*";
      index += 1;
      continue;
    }

    if (character === "?") {
      output += "[^/]";
      index += 1;
      continue;
    }

    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        let content = pattern.slice(index + 1, end);
        if (content.startsWith("!")) content = `^${content.slice(1)}`;
        output += `[${content}]`;
        index = end + 1;
        continue;
      }
    }

    output += escapeRegExp(character);
    index += 1;
  }

  return output;
}

export function globToRegExp(pattern: string): RegExp | null {
  let normalized = pattern.trim().replace(/\\/g, "/").normalize("NFC");
  if (!normalized) return null;
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  if (normalized.endsWith("/")) normalized += "**";

  const hasSlash = normalized.includes("/");
  const body = globBodyToRegExp(normalized);
  const prefix = hasSlash ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${body}$`, "i");
}

export interface PathMatcherOptions {
  syncConfig: boolean;
  syncWorkspace: boolean;
  syncPluginData: boolean;
  extraPatterns: string[];
}

export const HARD_EXCLUDED_PATTERNS = [
  ".obsidian/plugins/syncy/**",
  ".obsidian/syncy/**",
  "**/.syncy-tmp-*",
  ".trash/**",
  ".git/**",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
];

export function buildExcludePatterns(options: PathMatcherOptions): string[] {
  const patterns = [...HARD_EXCLUDED_PATTERNS];

  if (!options.syncConfig) patterns.push(".obsidian/**");
  if (!options.syncWorkspace) {
    patterns.push(".obsidian/workspace.json", "workspace.json");
    patterns.push(".obsidian/workspace-mobile.json", "workspace-mobile.json");
  }
  if (!options.syncPluginData) patterns.push(".obsidian/plugins/*/data.json");
  if (options.syncConfig) {
    patterns.push(".obsidian/plugins/syncy/**");
  }

  patterns.push(...options.extraPatterns);

  return patterns;
}

export function compileExcludes(patterns: string[]): (path: string) => boolean {
  const regexps = patterns
    .map((pattern) => globToRegExp(pattern))
    .filter((value): value is RegExp => value !== null);

  return (path: string): boolean => {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return true;
    return regexps.some((regexp) => regexp.test(normalized));
  };
}
