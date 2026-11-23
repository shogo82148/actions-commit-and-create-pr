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
export declare function git(args: string[], cwd: string, options?: GitOptions): Promise<Buffer>;
/** File modes of git objects. */
export declare const FileMode: {
    readonly Regular: "100644";
    readonly Executable: "100755";
    readonly Symlink: "120000";
    readonly Submodule: "160000";
    readonly Missing: "000000";
};
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
export declare function parseRawDiff(output: string): StagedChange[];
/**
 * Stages all changes under the working directory.
 *
 * @param cwd The working directory.
 */
export declare function stageAll(cwd: string): Promise<void>;
/**
 * Unstages all changes.
 *
 * @param cwd The working directory.
 */
export declare function unstageAll(cwd: string): Promise<void>;
/**
 * Lists the staged changes.
 *
 * @param cwd The working directory.
 * @returns The list of the staged changes.
 */
export declare function getStagedChanges(cwd: string): Promise<StagedChange[]>;
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
export declare function readBlob(sha: string, cwd: string): Promise<Buffer>;
/**
 * Resolves the commit SHA of HEAD.
 *
 * @param cwd The working directory.
 * @returns The SHA of HEAD.
 */
export declare function getHeadSha(cwd: string): Promise<string>;
/**
 * Resolves the tree SHA of HEAD.
 *
 * @param cwd The working directory.
 * @returns The SHA of the tree of HEAD.
 */
export declare function getHeadTreeSha(cwd: string): Promise<string>;
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
export declare function authEnv(serverUrl: string, token: string): Record<string, string>;
/**
 * Fetches a commit from the remote repository.
 *
 * @param cwd The working directory.
 * @param url The URL of the remote repository.
 * @param sha The SHA of the commit.
 * @param ref The local ref that will point to the commit, e.g. "refs/remotes/origin/main".
 * @param env Additional environment variables, e.g. authEnv().
 */
export declare function fetchCommit(cwd: string, url: string, sha: string, ref: string, env?: Record<string, string>): Promise<void>;
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
export declare function checkoutCommit(cwd: string, sha: string, branch: string): Promise<void>;
