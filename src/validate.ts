// Checks that need no Flagsmith connection, so they can run anywhere (including on
// pull requests from forks, which get no secrets).

import type { FlagFile } from "./flagfile.js";

export interface NamedFlagFile {
  source: string; // file name, for messages
  file: FlagFile;
}

// A Flagsmith flag always exists in every environment of the project. If a flag is listed
// in only some files, apply would create it everywhere and the other environments would
// then report it as drift. So every file must list the same flags.
export function checkSameFlags(files: NamedFlagFile[]): string[] {
  if (files.length < 2) return [];
  const all = new Set(files.flatMap((f) => Object.keys(f.file.flags)));
  const problems: string[] = [];
  for (const flag of [...all].sort()) {
    const missing = files.filter((f) => !(flag in f.file.flags)).map((f) => f.source);
    if (missing.length === 0) continue;
    const present = files.filter((f) => flag in f.file.flags).map((f) => f.source);
    problems.push(
      `"${flag}" is in ${present.join(", ")} but missing from ${missing.join(", ")}. ` +
        `Flagsmith creates a flag in every environment, so add it there too (enabled: false to keep it off).`,
    );
  }
  return problems;
}
