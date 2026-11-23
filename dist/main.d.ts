import { StagedChange } from "./git.js";
import { Commit, GitHubClient, PullRequest, PullRequestSummary } from "./github.js";
/** Options of the commit. */
export interface CommitOptions {
    /** The repository name with owner, e.g. "octocat/hello-world". */
    repository: string;
    baseBranch: string;
    headBranch: string;
    commitMessage: string;
    workingDirectory: string;
}
/** The subset of GitHubClient that commit() uses. */
export type Client = Pick<GitHubClient, "getRepositoryId" | "createBranch" | "createCommitOnBranch" | "createBlob" | "createTree" | "createCommit" | "createRef" | "updateRef">;
/**
 * Splits a commit message into its headline and body.
 *
 * @param message The commit message.
 * @returns The headline and body.
 */
export declare function splitCommitMessage(message: string): {
    headline: string;
    body?: string;
};
/**
 * Reports whether the change can be committed by the createCommitOnBranch mutation.
 * The mutation supports only regular files.
 *
 * @param change The change.
 * @returns true if the mutation supports the change.
 */
export declare function isRegularFileChange(change: StagedChange): boolean;
/**
 * Collects all changes under the working directory.
 *
 * The changes are staged to compute the SHAs of the new blobs, and unstaged soon.
 * The blobs are kept in the object database, so they can be read later.
 *
 * @param cwd The working directory.
 * @returns The changes.
 */
export declare function collectChanges(cwd: string): Promise<StagedChange[]>;
/**
 * Computes the hash of the changes.
 * It depends only on the paths, the modes and the contents of the changed files,
 * so the same changes have the same hash even if the base commit is different.
 *
 * @param changes The changes.
 * @returns The hash, e.g. "sha256:0123...".
 */
export declare function changesHash(changes: StagedChange[]): string;
/**
 * Commits all changes in the working directory via GitHub API.
 *
 * @param options The options.
 * @param client The GitHub API client.
 * @returns The commit created, or undefined if there are no changes.
 */
export declare function commit(options: CommitOptions, client: Client): Promise<Commit | undefined>;
/**
 * Commits the changes via GitHub API.
 *
 * If all changes are regular files, the commit is created by the
 * createCommitOnBranch GraphQL mutation. Otherwise (executable files,
 * symbolic links or submodules are involved), it is created by the Git
 * Database REST API, because the mutation doesn't support file modes.
 *
 * @param options The options.
 * @param client The GitHub API client.
 * @param changes The changes collected by collectChanges(). It must not be empty.
 * @returns The commit created.
 */
export declare function commitChanges(options: CommitOptions, client: Client, changes: StagedChange[]): Promise<Commit>;
/** Options of the checkout after the commit. */
export interface CheckoutOptions {
    workingDirectory: string;
    /** The branch that the commit was created on. */
    headBranch: string;
    /** The URL of the remote repository, e.g. "https://github.com/octocat/hello-world". */
    remoteUrl: string;
    /** Additional environment variables for git fetch, e.g. authEnv(). */
    env?: Record<string, string>;
}
/**
 * Fetches the commit created by the API, and checks out the head branch at the commit.
 * After that, HEAD points to the commit and the working tree is clean
 * (except changes that are not committed, e.g. outside of the working directory).
 *
 * @param options The options.
 * @param sha The SHA of the commit.
 */
export declare function checkout(options: CheckoutOptions, sha: string): Promise<void>;
/** The subset of GitHubClient that createPullRequest() uses. */
export type PullRequestClient = Pick<GitHubClient, "createPullRequest">;
/** Information about the workflow run, used for the head branch and the pull request body. */
export interface WorkflowRun {
    /** The name of the workflow. */
    workflow: string;
    /** The URL of the GitHub server, e.g. "https://github.com". */
    serverUrl: string;
    /** The repository name with owner, e.g. "octocat/hello-world". */
    repository: string;
    runId: string;
    runAttempt: string;
}
/**
 * Returns the default name of the head branch,
 * e.g. "actions-commit-and-create-pr/2022-01-03-1234567890-1".
 *
 * @param prefix The prefix of the branch.
 * @param run The workflow run.
 * @param now The current time.
 * @returns The name of the branch.
 */
export declare function defaultHeadBranch(prefix: string, run: Pick<WorkflowRun, "runId" | "runAttempt">, now?: Date): string;
/**
 * Builds the body of the pull request, with a link to the workflow run,
 * and a hidden marker of the hash of the changes for detecting duplicates.
 *
 * @param body The body given by the user.
 * @param run The workflow run.
 * @param hash The hash of the changes, computed by changesHash().
 * @returns The body of the pull request.
 */
export declare function pullRequestBody(body: string, run: WorkflowRun, hash: string): string;
/**
 * Extracts the hashes of the changes from the pull request body.
 *
 * @param body The body of the pull request.
 * @returns The hashes found.
 */
export declare function extractChangesHashes(body: string): string[];
/** The subset of GitHubClient that findDuplicatePullRequest() uses. */
export type ListPullRequestsClient = Pick<GitHubClient, "listOpenPullRequests">;
/**
 * Finds an open pull request that has the same changes.
 * Only pull requests from the same repository are considered,
 * so that pull requests from forks can't suppress new pull requests.
 *
 * @param options The repository, the base branch and the hash of the changes.
 * @param client The GitHub API client.
 * @returns The pull request found, or undefined.
 */
export declare function findDuplicatePullRequest(options: {
    repository: string;
    baseBranch: string;
    hash: string;
}, client: ListPullRequestsClient): Promise<PullRequestSummary | undefined>;
/** Options of the pull request. */
export interface PullRequestOptions {
    /** The repository name with owner, e.g. "octocat/hello-world". */
    repository: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
}
/**
 * Creates a pull request from the head branch to the base branch.
 *
 * @param options The options.
 * @param client The GitHub API client.
 * @returns The pull request created.
 */
export declare function createPullRequest(options: PullRequestOptions, client: PullRequestClient): Promise<PullRequest>;
/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export declare function run(): Promise<void>;
