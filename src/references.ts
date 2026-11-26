// Blast radius: find where flags are used in the code, so reviewers see what a change affects.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface Reference {
  file: string; // relative to the search root, with forward slashes
  line: number;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", "vendor", ".next", ".venv", "venv", "__pycache__", "target",
]);

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".rb", ".php", ".java", ".kt", ".kts", ".swift", ".cs", ".rs", ".dart", ".ex", ".exs",
  ".c", ".h", ".cpp", ".hpp", ".html", ".json", ".yml", ".yaml", ".toml", ".env", ".properties",
]);

const MAX_FILE_BYTES = 1024 * 1024;

async function* walk(root: string, dir: string, skip: Set<string>): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !skip.has(rel)) yield* walk(root, full, skip);
    } else if (e.isFile() && CODE_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !skip.has(rel)) {
      yield full;
    }
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-word matches only, so "dark_mode" doesn't match "dark_mode_v2".
export async function findReferences(
  root: string,
  flagNames: string[],
  skipPaths: string[] = [],
): Promise<Map<string, Reference[]>> {
  const found = new Map<string, Reference[]>(flagNames.map((n) => [n, []]));
  if (flagNames.length === 0) return found;

  const patterns = flagNames.map((n) => [n, new RegExp(`(?<![A-Za-z0-9_])${escape(n)}(?![A-Za-z0-9_])`)] as const);
  const skip = new Set(skipPaths.map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/")));

  for await (const file of walk(root, root, skip)) {
    if ((await stat(file)).size > MAX_FILE_BYTES) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const rel = path.relative(root, file).split(path.sep).join("/");
    lines.forEach((text, i) => {
      for (const [name, re] of patterns) {
        if (re.test(text)) found.get(name)!.push({ file: rel, line: i + 1 });
      }
    });
  }
  for (const refs of found.values()) refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return found;
}

export function formatReferences(refs: Reference[], max = 5): string {
  if (refs.length === 0) return "not found in code";
  const shown = refs.slice(0, max).map((r) => `${r.file}:${r.line}`);
  return shown.join(", ") + (refs.length > max ? ` (+${refs.length - max} more)` : "");
}
