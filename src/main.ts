import * as core from "@actions/core";
import { createHash } from "node:crypto";
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
  PullRequestSummary,
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
 * Collects all changes under the working directory.
 *
 * The changes are staged to compute the SHAs of the new blobs, and unstaged soon.
 * The blobs are kept in the object database, so they can be read later.
 *
 * @param cwd The working directory.
 * @returns The changes.
 */
export async function collectChanges(cwd: string): Promise<StagedChange[]> {
  await stageAll(cwd);
  try {
    return await getStagedChanges(cwd);
  } finally {
    await unstageAll(cwd);
  }
}

/**
 * Computes the hash of the changes.
 * It depends only on the paths, the modes and the contents of the changed files,
 * so the same changes have the same hash even if the base commit is different.
 *
 * @param changes The changes.
 * @returns The hash, e.g. "sha256:0123...".
 */
export function changesHash(changes: StagedChange[]): string {
  const entries = changes
    .map((c) => ({ path: c.path, line: `${c.newMode} ${c.newSha} ${c.path}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => e.line);
  const hash = createHash("sha256");
  for (const entry of entries) {
    // paths may contain line separators, so NUL is used as a separator.
    hash.update(entry);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Commits all changes in the working directory via GitHub API.
 *
 * @param options The options.
 * @param client The GitHub API client.
 * @returns The commit created, or undefined if there are no changes.
 */
export async function commit(
  options: CommitOptions,
  client: Client,
): Promise<Commit | undefined> {
  const changes = await collectChanges(options.workingDirectory);
  if (changes.length === 0) {
    core.info("No changes to commit.");
    return undefined;
  }
  return commitChanges(options, client, changes);
}

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
export async function commitChanges(
  options: CommitOptions,
  client: Client,
  changes: StagedChange[],
): Promise<Commit> {
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

/** The prefix of the hidden markers in the pull request body. */
const MARKER_PREFIX = "<!-- actions-commit-and-create-pr:";
const MARKER_SUFFIX = " -->";

/**
 * Escapes characters that may end the HTML comment or break the line.
 *
 * @param value The value of the marker.
 * @returns The escaped value.
 */
function escapeMarkerValue(value: string): string {
  return value.replace(
    /[%<>\r\n]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * Builds a hidden marker embedded into the pull request body.
 *
 * @param key The key of the marker, e.g. "changes".
 * @param value The value of the marker.
 * @returns The marker, e.g. "<!-- actions-commit-and-create-pr:changes=sha256:... -->".
 */
export function marker(key: string, value: string): string {
  return `${MARKER_PREFIX}${key}=${escapeMarkerValue(value)}${MARKER_SUFFIX}`;
}

/**
 * Extracts the values of the markers from the pull request body.
 *
 * @param body The body of the pull request.
 * @param key The key of the markers.
 * @returns The values found.
 */
export function extractMarkers(body: string, key: string): string[] {
  const prefix = `${MARKER_PREFIX}${key}=`;
  const values: string[] = [];
  let idx = body.indexOf(prefix);
  while (idx >= 0) {
    const start = idx + prefix.length;
    const end = body.indexOf(MARKER_SUFFIX, start);
    if (end < 0) {
      break;
    }
    try {
      values.push(decodeURIComponent(body.slice(start, end)));
    } catch {
      // ignore broken markers.
    }
    idx = body.indexOf(prefix, end);
  }
  return values;
}

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
export function pullRequestBody(
  body: string,
  run: WorkflowRun,
  markers: PullRequestMarkers,
): string {
  const logUrl = `${run.serverUrl}/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`;
  return [
    body.trim(),
    "",
    "-----",
    "",
    `This pull request is generated by the ${run.workflow} workflow. [See the log](${logUrl}).`,
    "",
    marker("changes", markers.changes),
    // the group is unknown when the action runs outside of GitHub Actions.
    ...(markers.group === "" ? [] : [marker("group", markers.group)]),
    marker("commit", markers.commit),
    "",
  ].join("\n");
}

/**
 * Returns the default group of pull requests: the path of the workflow file and the job id,
 * e.g. ".github/workflows/update.yml:update".
 *
 * @param env The environment variables.
 * @returns The group, or undefined if the workflow is unknown.
 */
export function defaultGroup(
  env: Record<string, string | undefined>,
): string | undefined {
  // e.g. "octocat/hello-world/.github/workflows/update.yml@refs/heads/main"
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  const job = env.GITHUB_JOB;
  if (!workflowRef || !job) {
    return undefined;
  }
  let workflowPath = workflowRef.replace(/@[^@]*$/, "");
  const repository = env.GITHUB_REPOSITORY;
  if (repository && workflowPath.startsWith(`${repository}/`)) {
    workflowPath = workflowPath.slice(repository.length + 1);
  }
  return `${workflowPath}:${job}`;
}

/**
 * Finds an open pull request that has the same changes.
 * Only pull requests from the same repository are considered,
 * so that pull requests from forks can't suppress new pull requests.
 *
 * @param pulls The open pull requests into the base branch.
 * @param options The repository and the hash of the changes.
 * @returns The pull request found, or undefined.
 */
export function findDuplicatePullRequest(
  pulls: PullRequestSummary[],
  options: { repository: string; hash: string },
): PullRequestSummary | undefined {
  return pulls.find(
    (pr) =>
      pr.headRepository === options.repository &&
      extractMarkers(pr.body, "changes").includes(options.hash),
  );
}

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
export function findSupersededPullRequests(
  pulls: PullRequestSummary[],
  options: { repository: string; group: string; number: number },
): SupersededPullRequests {
  const result: SupersededPullRequests = { superseded: [], modified: [] };
  for (const pr of pulls) {
    if (
      pr.headRepository !== options.repository ||
      pr.number >= options.number ||
      !extractMarkers(pr.body, "group").includes(options.group)
    ) {
      continue;
    }
    if (extractMarkers(pr.body, "commit").includes(pr.headSha)) {
      result.superseded.push(pr);
    } else {
      result.modified.push(pr);
    }
  }
  return result;
}

/** The subset of GitHubClient that closeSupersededPullRequests() uses. */
export type CloseClient = Pick<
  GitHubClient,
  "createIssueComment" | "closePullRequest" | "deleteRef"
>;

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
export async function closeSupersededPullRequests(
  repository: string,
  superseded: PullRequestSummary[],
  newPullRequest: PullRequest,
  client: CloseClient,
): Promise<number[]> {
  const closed: number[] = [];
  for (const pr of superseded) {
    try {
      core.info(`closing ${pr.url}, superseded by ${newPullRequest.url}`);
      await client.createIssueComment(
        repository,
        pr.number,
        `This pull request is superseded by #${newPullRequest.number}.`,
      );
      await client.closePullRequest(repository, pr.number);
      closed.push(pr.number);
    } catch (error) {
      core.warning(`failed to close ${pr.url}: ${errorMessage(error)}`);
      continue;
    }
    try {
      core.info(`deleting the branch ${pr.headBranch}`);
      await client.deleteRef(repository, pr.headBranch);
    } catch (error) {
      core.warning(
        `failed to delete the branch ${pr.headBranch}: ${errorMessage(error)}`,
      );
    }
  }
  return closed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses the labels input. Labels are separated by commas or newlines.
 *
 * @param input The labels input.
 * @returns The names of the labels, without duplicates.
 */
export function parseLabels(input: string): string[] {
  const labels = input
    .split(/[,\r\n]/)
    .map((label) => label.trim())
    .filter((label) => label !== "");
  return [...new Set(labels)];
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
    const labels = parseLabels(core.getInput("labels"));
    const workingDirectory = path.resolve(
      core.getInput("working-directory") || ".",
    );
    const skipDuplicate = getBooleanInput("skip-duplicate", true);
    const closeSuperseded = getBooleanInput("close-superseded", false);
    const group = core.getInput("group") || defaultGroup(process.env) || "";
    if (closeSuperseded && group === "") {
      throw new Error(
        "group is required to close superseded pull requests, because the workflow is unknown",
      );
    }

    const changes = await collectChanges(workingDirectory);
    if (changes.length === 0) {
      core.info("No changes to commit.");
      return;
    }
    const hash = changesHash(changes);

    const client = new GitHubClient(token);
    let pulls: PullRequestSummary[] = [];
    if (skipDuplicate || closeSuperseded) {
      core.info(`listing open pull requests into ${baseBranch}`);
      pulls = await client.listOpenPullRequests(repository, baseBranch);
    }
    if (skipDuplicate) {
      const duplicate = findDuplicatePullRequest(pulls, { repository, hash });
      if (duplicate) {
        core.info(
          `skipped: the pull request ${duplicate.url} has the same changes (${hash}).`,
        );
        core.setOutput("head-branch", duplicate.headBranch);
        core.setOutput("pr-url", duplicate.url);
        core.setOutput("pr-number", duplicate.number);
        core.setOutput("duplicated", true);
        return;
      }
    }

    const created = await commitChanges(
      { repository, baseBranch, headBranch, commitMessage, workingDirectory },
      client,
      changes,
    );
    core.setOutput("commit-url", created.url);
    core.setOutput("commit-sha", created.oid);
    core.setOutput("head-branch", headBranch);

    const pr = await createPullRequest(
      {
        repository,
        baseBranch,
        headBranch,
        title,
        body: pullRequestBody(body, workflowRun, {
          changes: hash,
          group,
          commit: created.oid,
        }),
      },
      client,
    );
    core.setOutput("pr-url", pr.url);
    core.setOutput("pr-number", pr.number);
    core.setOutput("duplicated", false);

    if (labels.length > 0) {
      try {
        core.info(`adding labels to ${pr.url}: ${labels.join(", ")}`);
        await client.addLabels(repository, pr.number, labels);
      } catch (error) {
        // the action fails, but it continues the rest,
        // because the pull request has already been created.
        const message = errorMessage(error);
        // GitHub returns 422 if a label doesn't exist and the token can't create it.
        const hint = message.includes(" 422 ")
          ? " Labels that don't exist are created only if the token has the issues: write permission."
          : "";
        core.setFailed(`failed to add labels to ${pr.url}: ${message}${hint}`);
      }
    }

    if (closeSuperseded) {
      const { superseded, modified } = findSupersededPullRequests(pulls, {
        repository,
        group,
        number: pr.number,
      });
      for (const m of modified) {
        core.warning(
          `${m.url} is not closed, because it has commits not created by the action.`,
        );
      }
      const closed = await closeSupersededPullRequests(
        repository,
        superseded,
        pr,
        client,
      );
      core.setOutput("closed-pull-requests", JSON.stringify(closed));
    }

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
    core.setFailed(errorMessage(error));
  }
}

/**
 * Gets a boolean input. Unlike core.getBooleanInput, it returns the default value if the input is empty.
 *
 * @param name The name of the input.
 * @param defaultValue The value used if the input is empty.
 * @returns The value of the input.
 */
function getBooleanInput(name: string, defaultValue: boolean): boolean {
  if (core.getInput(name) === "") {
    return defaultValue;
  }
  return core.getBooleanInput(name);
}
