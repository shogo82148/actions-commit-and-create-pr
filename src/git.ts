import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Options of git(). */
export interface GitOptions {
  /** Additional environment variables. */
  env?: Record<string, string>;
}

/**
 * Runs a git command and returns its standard output.
 * The output is returned as a Buffer, because it may be binary (e.g. contents of blobs).
 *
 * The command, its exit code and its outputs are written to the debug log.
 * The runner shows them only when the debug mode is enabled
 * (e.g. re-running a job with debug logging).
 * The environment variables are not logged, because they may contain credentials.
 *
 * @param args The arguments passed to git.
 * @param cwd The working directory.
 * @param options The options.
 * @returns The standard output of the command.
 */
export async function git(
  args: string[],
  cwd: string,
  options: GitOptions = {},
): Promise<Buffer> {
  core.debug(`[command] git ${args.map(quote).join(" ")} (cwd: ${cwd})`);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const code = await exec.exec("git", args, {
    cwd,
    // exec.exec replaces the environment variables entirely, so merge them.
    env: { ...(process.env as Record<string, string>), ...options.env },
    // don't print the command and its output to the log.
    // they are written to the debug log below instead.
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => stdout.push(data),
      stderr: (data: Buffer) => stderr.push(data),
    },
  });
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);

  core.debug(`[exit code] ${code}`);
  debugLines("[stdout]", out);
  debugLines("[stderr]", err);

  if (code !== 0) {
    const message = err.toString("utf8").trim();
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${code}: ${message}`,
    );
  }
  return out;
}

/**
 * Quotes an argument for logging, if needed.
 *
 * @param arg The argument.
 * @returns The quoted argument.
 */
function quote(arg: string): string {
  return /^[\w@%+=:,./^{}-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * Writes the output to the debug log, line by line.
 * NUL characters (e.g. `git diff -z`) are shown as "\\0".
 *
 * @param prefix The prefix of each line.
 * @param output The output.
 */
function debugLines(prefix: string, output: Buffer): void {
  const text = output.toString("utf8").replace(/\0/g, "\\0").trimEnd();
  if (text === "") {
    return;
  }
  for (const line of text.split("\n")) {
    core.debug(`${prefix} ${line}`);
  }
}

/** File modes of git objects. */
export const FileMode = {
  Regular: "100644",
  Executable: "100755",
  Symlink: "120000",
  Submodule: "160000",
  Missing: "000000",
} as const;

/** A change of a staged file. */
export interface StagedChange {
  /** The path of the file, relative to the repository root. */
  path: string;
  /** The status of the change, e.g. "A", "M", "D", "T". */
  status: string;
  /** The file mode before the change. */
  oldMode: string;
  /** The file mode after the change. */
  newMode: string;
  /** The blob SHA after the change. */
  newSha: string;
}

/**
 * Parses the output of `git diff --raw -z --no-renames`.
 *
 * @param output The output of the command.
 * @returns The list of the changes.
 */
export function parseRawDiff(output: string): StagedChange[] {
  const tokens = output.split("\0");
  const changes: StagedChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i];
    const path = tokens[i + 1];
    // e.g. ":100644 100644 <old sha> <new sha> M"
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(
      meta,
    );
    if (!m) {
      throw new Error(`unexpected output of git diff: ${JSON.stringify(meta)}`);
    }
    changes.push({
      path,
      oldMode: m[1],
      newMode: m[2],
      newSha: m[4],
      status: m[5],
    });
  }
  return changes;
}

/**
 * Stages all changes under the working directory.
 *
 * @param cwd The working directory.
 */
export async function stageAll(cwd: string): Promise<void> {
  await git(["add", "--all", "--", "."], cwd);
}

/**
 * Unstages all changes.
 *
 * @param cwd The working directory.
 */
export async function unstageAll(cwd: string): Promise<void> {
  await git(["reset", "--quiet", "HEAD"], cwd);
}

/**
 * Lists the staged changes.
 *
 * @param cwd The working directory.
 * @returns The list of the staged changes.
 */
export async function getStagedChanges(cwd: string): Promise<StagedChange[]> {
  const output = await git(
    ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"],
    cwd,
  );
  return parseRawDiff(output.toString("utf8"));
}

/**
 * Reads the contents of a blob.
 *
 * The contents are not read from the standard output of `git cat-file blob`,
 * because @actions/exec splits the standard output into lines, and it takes
 * quadratic time for large blobs without line separators.
 * Instead, `git unpack-file` writes the contents into a temporary file
 * at the top level of the working tree, and it is read and removed here.
 *
 * @param sha The SHA of the blob.
 * @param cwd The working directory.
 * @returns The contents of the blob.
 */
export async function readBlob(sha: string, cwd: string): Promise<Buffer> {
  const toplevel = (await git(["rev-parse", "--show-toplevel"], cwd))
    .toString("utf8")
    .trim();
  // the name of the temporary file, relative to the top level, e.g. ".merge_file_XXXXXX".
  const name = (await git(["unpack-file", sha], cwd)).toString("utf8").trim();
  const file = path.join(toplevel, name);
  try {
    return await fs.readFile(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/**
 * Resolves the commit SHA of HEAD.
 *
 * @param cwd The working directory.
 * @returns The SHA of HEAD.
 */
export async function getHeadSha(cwd: string): Promise<string> {
  const output = await git(["rev-parse", "HEAD"], cwd);
  return output.toString("utf8").trim();
}

/**
 * Resolves the tree SHA of HEAD.
 *
 * @param cwd The working directory.
 * @returns The SHA of the tree of HEAD.
 */
export async function getHeadTreeSha(cwd: string): Promise<string> {
  const output = await git(["rev-parse", "HEAD^{tree}"], cwd);
  return output.toString("utf8").trim();
}

/**
 * Builds environment variables that make git authenticate with the token.
 * They are passed via environment variables instead of command line arguments,
 * so that the token doesn't appear in the process list.
 * The existing extra headers (e.g. persisted by actions/checkout) are reset,
 * because duplicated Authorization headers are rejected.
 *
 * @param serverUrl The URL of the GitHub server, e.g. "https://github.com".
 * @param token The token.
 * @returns The environment variables.
 */
export function authEnv(
  serverUrl: string,
  token: string,
): Record<string, string> {
  const key = `http.${serverUrl.replace(/\/+$/, "")}/.extraheader`;
  const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: "", // an empty value resets the list of extra headers.
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${credential}`,
  };
}

/**
 * Fetches a commit from the remote repository.
 *
 * @param cwd The working directory.
 * @param url The URL of the remote repository.
 * @param sha The SHA of the commit.
 * @param ref The local ref that will point to the commit, e.g. "refs/remotes/origin/main".
 * @param env Additional environment variables, e.g. authEnv().
 */
export async function fetchCommit(
  cwd: string,
  url: string,
  sha: string,
  ref: string,
  env: Record<string, string> = {},
): Promise<void> {
  await git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      url,
      `+${sha}:${ref}`,
    ],
    cwd,
    { env },
  );
}

/**
 * Checks out the branch, and moves it to the commit, keeping the working tree as is.
 * The working tree already contains the changes of the commit,
 * so only the branch, HEAD and the index are updated.
 * Changes that are not included in the commit are kept in the working tree.
 *
 * The local branch is created if it doesn't exist, or reset to the commit if it exists.
 * The upstream of the branch is set to the remote-tracking branch `origin/<branch>`.
 *
 * @param cwd The working directory.
 * @param sha The SHA of the commit.
 * @param branch The branch that the commit was created on.
 */
export async function checkoutCommit(
  cwd: string,
  sha: string,
  branch: string,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  // unlike `git checkout -B`, these commands never touch the working tree.
  await git(
    ["update-ref", "-m", `actions-commit: moving to ${sha}`, ref, sha],
    cwd,
  );
  await git(["symbolic-ref", "HEAD", ref], cwd);
  await git(["reset", "--quiet", "--mixed", sha], cwd);
  await git(["config", `branch.${branch}.remote`, "origin"], cwd);
  await git(["config", `branch.${branch}.merge`, ref], cwd);
}
