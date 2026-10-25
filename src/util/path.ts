export function normalizeVaultPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").normalize("NFC");
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Path must not contain parent directory segments");
  }
  return segments.join("/");
}

export function pathKey(path: string): string {
  return normalizeVaultPath(path).toLowerCase();
}

export function parentPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function baseName(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function pathExtension(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

export function pathStem(path: string): string {
  const name = baseName(path);
  const extension = pathExtension(name);
  return extension ? name.slice(0, -extension.length) : name;
}

export function joinPath(parent: string, child: string): string {
  if (!parent) return normalizeVaultPath(child);
  return normalizeVaultPath(`${parent}/${child}`);
}

export function isSubPath(path: string, parent: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedParent = normalizeVaultPath(parent);
  if (!normalizedParent) return normalizedPath.length > 0;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedOld = normalizeVaultPath(oldPrefix);
  const normalizedNew = normalizeVaultPath(newPrefix);
  if (normalizedPath === normalizedOld) return normalizedNew;
  return joinPath(normalizedNew, normalizedPath.slice(normalizedOld.length + 1));
}

export function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function conflictCopyPath(path: string, date = new Date()): string {
  const directory = parentPath(path);
  const name = baseName(path);
  const extension = pathExtension(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const copyName = `${stem} (conflict ${stamp})${extension}`;
  return directory ? `${directory}/${copyName}` : copyName;
}

export function uniquePath(
  candidate: string,
  exists: (path: string) => boolean,
  maxAttempts = 100,
): string {
  if (!exists(candidate)) return candidate;
  const directory = parentPath(candidate);
  const name = baseName(candidate);
  const extension = pathExtension(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const nextName = `${stem} ${attempt}${extension}`;
    const next = directory ? `${directory}/${nextName}` : nextName;
    if (!exists(next)) return next;
  }
  const fallback = `${stem} ${Date.now()}${extension}`;
  return directory ? `${directory}/${fallback}` : fallback;
}

export async function uniquePathAsync(
  candidate: string,
  exists: (path: string) => Promise<boolean>,
  maxAttempts = 100,
): Promise<string> {
  if (!(await exists(candidate))) return candidate;
  const directory = parentPath(candidate);
  const name = baseName(candidate);
  const extension = pathExtension(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const nextName = `${stem} ${attempt}${extension}`;
    const next = directory ? `${directory}/${nextName}` : nextName;
    if (!(await exists(next))) return next;
  }
  const fallback = `${stem} ${Date.now()}${extension}`;
  return directory ? `${directory}/${fallback}` : fallback;
}
