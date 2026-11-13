import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve shared local evidence inside this Git project's common workspace, including worktrees. */
export function projectOwnedPath(
  repositoryRoot: string,
  value: string,
): string {
  if (isAbsolute(value)) throw new Error("project paths must be relative");
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  ).trim();
  const projectRoot = dirname(realpathSync.native(commonDirectory));
  const target = resolve(projectRoot, value);
  const escapes = (path: string): boolean => {
    const offset = relative(projectRoot, path);
    return (
      isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)
    );
  };
  if (escapes(target)) throw new Error("project path escapes the workspace");
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  // IMPORTANT: reject cross-drive and real ancestor escapes before callers create evidence files.
  if (escapes(realpathSync.native(ancestor)))
    throw new Error("project path has an escaping ancestor");
  return target;
}
