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
 * Builds a hidden marker embedded into the pull request body.
 *
 * @param key The key of the marker, e.g. "changes".
 * @param value The value of the marker.
 * @returns The marker, e.g. "<!-- actions-commit-and-create-pr:changes=sha256:... -->".
 */
export declare function marker(key: string, value: string): string;
/**
 * Extracts the values of the markers from the pull request body.
 *
 * @param body The body of the pull request.
 * @param key The key of the markers.
 * @returns The values found.
 */
export declare function extractMarkers(body: string, key: string): string[];
/** The hidden markers embedded into the pull request body. */
export interface PullRequestMarkers {
    /** The hash of the changes, computed by changesHash(). It is used for detecting duplicates. */
    changes: string;
    /** The group of the pull request. It is used for detecting superseded pull requests. */
    group: string;
    /** The SHA of the commit created by the action. It is used for detecting modifications by humans. */
    commit: string;
}
/**
 * Builds the body of the pull request, with a link to the workflow run,
 * and hidden markers for detecting duplicates and superseded pull requests.
 *
 * @param body The body given by the user.
 * @param run The workflow run.
 * @param markers The values of the hidden markers.
 * @returns The body of the pull request.
 */
export declare function pullRequestBody(body: string, run: WorkflowRun, markers: PullRequestMarkers): string;
/**
 * Returns the default group of pull requests: the path of the workflow file and the job id,
 * e.g. ".github/workflows/update.yml:update".
 *
 * @param env The environment variables.
 * @returns The group, or undefined if the workflow is unknown.
 */
export declare function defaultGroup(env: Record<string, string | undefined>): string | undefined;
/**
 * Finds an open pull request that has the same changes.
 * Only pull requests from the same repository are considered,
 * so that pull requests from forks can't suppress new pull requests.
 *
 * @param pulls The open pull requests into the base branch.
 * @param options The repository and the hash of the changes.
 * @returns The pull request found, or undefined.
 */
export declare function findDuplicatePullRequest(pulls: PullRequestSummary[], options: {
    repository: string;
    hash: string;
}): PullRequestSummary | undefined;
/** The result of findSupersededPullRequests(). */
export interface SupersededPullRequests {
    /** The pull requests to be closed. */
    superseded: PullRequestSummary[];
    /** The pull requests in the same group, but they have commits not created by the action. */
    modified: PullRequestSummary[];
}
/**
 * Finds open pull requests superseded by the new pull request.
 * A pull request is superseded if it is in the same group, and it is older than the new one.
 * Pull requests that have commits not created by the action are not superseded,
 * because humans may have worked on them.
 *
 * @param pulls The open pull requests into the base branch.
 * @param options The repository, the group and the number of the new pull request.
 * @returns The superseded pull requests and the modified pull requests.
 */
export declare function findSupersededPullRequests(pulls: PullRequestSummary[], options: {
    repository: string;
    group: string;
    number: number;
}): SupersededPullRequests;
/** The subset of GitHubClient that closeSupersededPullRequests() uses. */
export type CloseClient = Pick<GitHubClient, "createIssueComment" | "closePullRequest" | "deleteRef">;
/**
 * Closes the superseded pull requests, and deletes their head branches.
 * Errors are reported as warnings, because the new pull request has already been created.
 *
 * @param repository The repository name with owner.
 * @param superseded The pull requests to be closed.
 * @param newPullRequest The new pull request.
 * @param client The GitHub API client.
 * @returns The numbers of the pull requests closed.
 */
export declare function closeSupersededPullRequests(repository: string, superseded: PullRequestSummary[], newPullRequest: PullRequest, client: CloseClient): Promise<number[]>;
/**
 * Parses the labels input. Labels are separated by commas or newlines.
 *
 * @param input The labels input.
 * @returns The names of the labels, without duplicates.
 */
export declare function parseLabels(input: string): string[];
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
