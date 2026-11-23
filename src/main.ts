import * as core from "@actions/core";
import * as path from "node:path";
import {
  FileMode,
  StagedChange,
  authEnv,
  checkoutCommit,
  fetchCommit,
  getHeadSha,
  getHeadTreeSha,
  getStagedChanges,
  readBlob,
  stageAll,
  unstageAll,
} from "./git.js";
import {
  Commit,
  FileAddition,
  FileDeletion,
  GitHubClient,
  PullRequest,
  TreeEntry,
} from "./github.js";

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
export type Client = Pick<
  GitHubClient,
  | "getRepositoryId"
  | "createBranch"
  | "createCommitOnBranch"
  | "createBlob"
  | "createTree"
  | "createCommit"
  | "createRef"
  | "updateRef"
>;

/** The number of blobs uploaded concurrently. */
const BLOB_UPLOAD_CONCURRENCY = 4;

/**
 * Splits a commit message into its headline and body.
 *
 * @param message The commit message.
 * @returns The headline and body.
 */
export function splitCommitMessage(message: string): {
  headline: string;
  body?: string;
} {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  const idx = normalized.indexOf("\n");
  if (idx < 0) {
    return { headline: normalized };
  }
  const headline = normalized.slice(0, idx).trim();
  const body = normalized.slice(idx + 1).trim();
  return body === "" ? { headline } : { headline, body };
}

function isDeletion(change: StagedChange): boolean {
  return change.status === "D" || change.newMode === FileMode.Missing;
}

/**
 * Reports whether the change can be committed by the createCommitOnBranch mutation.
 * The mutation supports only regular files.
 *
 * @param change The change.
 * @returns true if the mutation supports the change.
 */
export function isRegularFileChange(change: StagedChange): boolean {
  const regular = (mode: string) =>
    mode === FileMode.Regular || mode === FileMode.Missing;
  return regular(change.oldMode) && regular(change.newMode);
}

/**
 * Commits all changes in the working directory via GitHub API.
 *
 * If all changes are regular files, the commit is created by the
 * createCommitOnBranch GraphQL mutation. Otherwise (executable files,
 * symbolic links or submodules are involved), it is created by the Git
 * Database REST API, because the mutation doesn't support file modes.
 *
 * @param options The options.
 * @param client The GitHub API client.
 * @returns The commit created, or undefined if there are no changes.
 */
export async function commit(
  options: CommitOptions,
  client: Client,
): Promise<Commit | undefined> {
  const cwd = options.workingDirectory;

  await stageAll(cwd);
  try {
    const changes = await getStagedChanges(cwd);
    if (changes.length === 0) {
      core.info("No changes to commit.");
      return undefined;
    }

    const created = changes.every(isRegularFileChange)
      ? await commitWithGraphQL(options, client, changes)
      : await commitWithGitDatabase(options, client, changes);
    core.info(`created: ${created.url}`);
    if (!created.verified) {
      core.warning(
        `the commit ${created.oid} is not verified. ` +
          "If the change includes executable files, symbolic links or submodules, " +
          "the commit is not signed when the token authenticates as a user (e.g. a personal access token). Use GITHUB_TOKEN or a GitHub App token instead.",
      );
    }
    return created;
  } finally {
    await unstageAll(cwd);
  }
}

async function commitWithGraphQL(
  options: CommitOptions,
  client: Client,
  changes: StagedChange[],
): Promise<Commit> {
  const cwd = options.workingDirectory;
  const additions: FileAddition[] = [];
  const deletions: FileDeletion[] = [];
  for (const change of changes) {
    if (isDeletion(change)) {
      core.info(`delete: ${change.path}`);
      deletions.push({ path: change.path });
      continue;
    }
    core.info(`add: ${change.path}`);
    const contents = await readBlob(change.newSha, cwd);
    additions.push({
      path: change.path,
      contents: contents.toString("base64"),
    });
  }

  const headSha = await getHeadSha(cwd);
  if (options.headBranch !== options.baseBranch) {
    core.info(`creating a new branch ${options.headBranch} from ${headSha}`);
    const repositoryId = await client.getRepositoryId(options.repository);
    await client.createBranch(repositoryId, options.headBranch, headSha);
  }

  core.info(
    `creating a commit on ${options.headBranch} using the createCommitOnBranch mutation`,
  );
  return client.createCommitOnBranch({
    branch: {
      repositoryNameWithOwner: options.repository,
      branchName: options.headBranch,
    },
    expectedHeadOid: headSha,
    fileChanges: { additions, deletions },
    message: splitCommitMessage(options.commitMessage),
  });
}

async function commitWithGitDatabase(
  options: CommitOptions,
  client: Client,
  changes: StagedChange[],
): Promise<Commit> {
  const cwd = options.workingDirectory;
  const repository = options.repository;

  const tree: TreeEntry[] = [];
  const uploads: { entry: TreeEntry; sha: string }[] = [];
  for (const change of changes) {
    if (isDeletion(change)) {
      core.info(`delete: ${change.path}`);
      tree.push({
        path: change.path,
        mode: change.oldMode,
        type: change.oldMode === FileMode.Submodule ? "commit" : "blob",
        sha: null,
      });
      continue;
    }

    if (change.newMode === FileMode.Submodule) {
      // the sha of a submodule is the commit in the submodule repository.
      core.info(`add submodule: ${change.path} (${change.newSha})`);
      tree.push({
        path: change.path,
        mode: change.newMode,
        type: "commit",
        sha: change.newSha,
      });
      continue;
    }

    core.info(`add: ${change.path} (mode ${change.newMode})`);
    const entry: TreeEntry = {
      path: change.path,
      mode: change.newMode,
      type: "blob",
      sha: null,
    };
    tree.push(entry);
    uploads.push({ entry, sha: change.newSha });
  }

  // upload blobs
  let next = 0;
  const worker = async () => {
    while (next < uploads.length) {
      const upload = uploads[next++];
      const contents = await readBlob(upload.sha, cwd);
      upload.entry.sha = await client.createBlob(repository, contents);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BLOB_UPLOAD_CONCURRENCY, uploads.length) },
      worker,
    ),
  );

  const headSha = await getHeadSha(cwd);
  const baseTree = await getHeadTreeSha(cwd);
  const treeSha = await client.createTree(repository, baseTree, tree);

  const { headline, body } = splitCommitMessage(options.commitMessage);
  const message = body === undefined ? headline : `${headline}\n\n${body}`;
  core.info(
    `creating a commit on ${options.headBranch} using the Git Database API`,
  );
  const created = await client.createCommit(repository, message, treeSha, [
    headSha,
  ]);

  if (options.headBranch !== options.baseBranch) {
    core.info(`creating a new branch ${options.headBranch}`);
    await client.createRef(repository, options.headBranch, created.oid);
  } else {
    await client.updateRef(repository, options.headBranch, created.oid);
  }
  return created;
}

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
export async function checkout(
  options: CheckoutOptions,
  sha: string,
): Promise<void> {
  const cwd = options.workingDirectory;
  core.info(`fetching ${sha}`);
  await fetchCommit(
    cwd,
    options.remoteUrl,
    sha,
    `refs/remotes/origin/${options.headBranch}`,
    options.env,
  );
  await checkoutCommit(cwd, sha, options.headBranch);
  core.info(`checked out ${sha}`);
}

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
export function defaultHeadBranch(
  prefix: string,
  run: Pick<WorkflowRun, "runId" | "runAttempt">,
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  return `${prefix}${date}-${run.runId}-${run.runAttempt}`;
}

/**
 * Builds the body of the pull request, with a link to the workflow run.
 *
 * @param body The body given by the user.
 * @param run The workflow run.
 * @returns The body of the pull request.
 */
export function pullRequestBody(body: string, run: WorkflowRun): string {
  const logUrl = `${run.serverUrl}/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`;
  return [
    body.trim(),
    "",
    "-----",
    "",
    `This pull request is generated by the ${run.workflow} workflow. [See the log](${logUrl}).`,
    "",
  ].join("\n");
}

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
export async function createPullRequest(
  options: PullRequestOptions,
  client: PullRequestClient,
): Promise<PullRequest> {
  core.info(
    `creating a pull request from ${options.headBranch} to ${options.baseBranch}`,
  );
  const pr = await client.createPullRequest(options.repository, {
    title: options.title,
    body: options.body,
    base: options.baseBranch,
    head: options.headBranch,
  });
  core.info(`created: ${pr.url}`);
  return pr;
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    core.setSecret(token);
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error("GITHUB_REPOSITORY is not set");
    }
    const workflowRun: WorkflowRun = {
      workflow: process.env.GITHUB_WORKFLOW ?? "",
      serverUrl: (
        process.env.GITHUB_SERVER_URL || "https://github.com"
      ).replace(/\/+$/, ""),
      repository,
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    };

    const baseBranch = core.getInput("base-branch", { required: true });
    const headBranch =
      core.getInput("head-branch") ||
      defaultHeadBranch(core.getInput("head-branch-prefix"), workflowRun);
    if (headBranch === baseBranch) {
      throw new Error(
        `head-branch must be different from base-branch: ${baseBranch}`,
      );
    }
    const commitMessage =
      core.getInput("commit-message") ||
      `Auto updates by the ${workflowRun.workflow} workflow`;
    const title =
      core.getInput("title") || splitCommitMessage(commitMessage).headline;
    const body = core.getInput("body") || commitMessage;
    const workingDirectory = path.resolve(
      core.getInput("working-directory") || ".",
    );

    const client = new GitHubClient(token);
    const created = await commit(
      { repository, baseBranch, headBranch, commitMessage, workingDirectory },
      client,
    );
    if (!created) {
      return;
    }
    core.setOutput("commit-url", created.url);
    core.setOutput("commit-sha", created.oid);
    core.setOutput("head-branch", headBranch);

    const pr = await createPullRequest(
      {
        repository,
        baseBranch,
        headBranch,
        title,
        body: pullRequestBody(body, workflowRun),
      },
      client,
    );
    core.setOutput("pr-url", pr.url);
    core.setOutput("pr-number", pr.number);

    await checkout(
      {
        workingDirectory,
        headBranch,
        remoteUrl: `${workflowRun.serverUrl}/${repository}`,
        env: authEnv(workflowRun.serverUrl, token),
      },
      created.oid,
    );
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}
