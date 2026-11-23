import { jest } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git, type StagedChange } from "../src/git.js";
import type {
  Commit,
  CreateCommitOnBranchInput,
  PullRequestSummary,
  TreeEntry,
} from "../src/github.js";
import {
  Client,
  changesHash,
  checkout,
  collectChanges,
  commit,
  closeSupersededPullRequests,
  createPullRequest,
  defaultGroup,
  defaultHeadBranch,
  extractMarkers,
  findDuplicatePullRequest,
  findSupersededPullRequests,
  marker,
  parseLabels,
  pullRequestBody,
  run,
  splitCommitMessage,
} from "../src/main.js";

const gitConfig = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

async function setupRepository(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "actions-commit-"));
  await git(["init", "--quiet", "--initial-branch=main"], dir);
  await fs.writeFile(path.join(dir, '"please delete me".txt'), "delete\n");
  await fs.writeFile(path.join(dir, "rename-me.txt"), "rename\n");
  await fs.writeFile(path.join(dir, "update-me.txt"), "please update me!\n");
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "sub", "keep.txt"), "keep\n");
  await git(["add", "."], dir);
  await git([...gitConfig, "commit", "--quiet", "-m", "initial"], dir);
  return dir;
}

function fakeClient() {
  const calls: CreateCommitOnBranchInput[] = [];
  const blobs = new Map<string, string>();
  const client = {
    getRepositoryId: jest.fn(async () => "R_123"),
    createBranch: jest.fn(async () => {}),
    createCommitOnBranch: jest.fn(async (input: CreateCommitOnBranchInput) => {
      calls.push(input);
      return {
        oid: "c0ffee",
        url: "https://github.com/o/r/commit/c0ffee",
        verified: true,
      };
    }),
    createBlob: jest.fn(async (_repo: string, contents: Buffer) => {
      const sha = `blob${blobs.size}`;
      blobs.set(sha, contents.toString("utf8"));
      return sha;
    }),
    createTree: jest.fn<
      (repo: string, base: string, tree: TreeEntry[]) => Promise<string>
    >(async () => "tree0"),
    createCommit: jest.fn<
      (
        repo: string,
        message: string,
        tree: string,
        parents: string[],
      ) => Promise<Commit>
    >(async () => ({
      oid: "beef",
      url: "https://github.com/o/r/commit/beef",
      verified: true,
    })),
    createRef: jest.fn(async () => {}),
    updateRef: jest.fn(async () => {}),
  };
  return { client: client as Client & typeof client, calls, blobs };
}

const decode = (s: string) => Buffer.from(s, "base64").toString("utf8");

describe("splitCommitMessage", () => {
  it("returns the headline only", () => {
    expect(splitCommitMessage("hello\n")).toEqual({ headline: "hello" });
  });

  it("splits the headline and the body", () => {
    expect(splitCommitMessage("hello\r\n\r\nworld\nfoo")).toEqual({
      headline: "hello",
      body: "world\nfoo",
    });
  });
});

describe("commit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await setupRepository();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does nothing if there are no changes", async () => {
    const { client } = fakeClient();
    const result = await commit(
      {
        repository: "o/r",
        baseBranch: "main",
        headBranch: "main",
        commitMessage: "msg",
        workingDirectory: dir,
      },
      client,
    );
    expect(result).toBeUndefined();
    expect(client.createCommitOnBranch).not.toHaveBeenCalled();
    expect(client.createBranch).not.toHaveBeenCalled();
  });

  it("commits all changes", async () => {
    await fs.rm(path.join(dir, '"please delete me".txt'));
    await fs.rename(
      path.join(dir, "rename-me.txt"),
      path.join(dir, "renamed!.txt"),
    );
    await fs.appendFile(path.join(dir, "update-me.txt"), "UPDATED!!\n");
    await fs.writeFile(path.join(dir, '"new file".txt'), "brand new\n");
    const head = (await git(["rev-parse", "HEAD"], dir)).toString().trim();

    const { client, calls } = fakeClient();
    const result = await commit(
      {
        repository: "o/r",
        baseBranch: "main",
        headBranch: "main",
        commitMessage: "headline\n\nbody",
        workingDirectory: dir,
      },
      client,
    );

    expect(result).toEqual({
      oid: "c0ffee",
      url: "https://github.com/o/r/commit/c0ffee",
      verified: true,
    });
    expect(client.createBranch).not.toHaveBeenCalled();
    expect(client.createTree).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const input = calls[0];
    expect(input.branch).toEqual({
      repositoryNameWithOwner: "o/r",
      branchName: "main",
    });
    expect(input.expectedHeadOid).toBe(head);
    expect(input.message).toEqual({ headline: "headline", body: "body" });

    const additions = Object.fromEntries(
      input.fileChanges.additions.map((a) => [a.path, decode(a.contents)]),
    );
    expect(additions).toEqual({
      '"new file".txt': "brand new\n",
      "renamed!.txt": "rename\n",
      "update-me.txt": "please update me!\nUPDATED!!\n",
    });
    expect(input.fileChanges.deletions.map((d) => d.path).sort()).toEqual([
      '"please delete me".txt',
      "rename-me.txt",
    ]);

    // the index should be restored.
    const staged = await git(["diff", "--cached", "--name-only"], dir);
    expect(staged.toString()).toBe("");
  });

  it("creates a new branch", async () => {
    await fs.writeFile(path.join(dir, "new.txt"), "new\n");
    const head = (await git(["rev-parse", "HEAD"], dir)).toString().trim();

    const { client, calls } = fakeClient();
    await commit(
      {
        repository: "o/r",
        baseBranch: "main",
        headBranch: "topic",
        commitMessage: "msg",
        workingDirectory: dir,
      },
      client,
    );

    expect(client.getRepositoryId).toHaveBeenCalledWith("o/r");
    expect(client.createBranch).toHaveBeenCalledWith("R_123", "topic", head);
    expect(calls[0].branch.branchName).toBe("topic");
  });

  it("commits only changes under the working directory", async () => {
    await fs.writeFile(path.join(dir, "outside.txt"), "outside\n");
    await fs.writeFile(path.join(dir, "sub", "inside.txt"), "inside\n");

    const { client, calls } = fakeClient();
    await commit(
      {
        repository: "o/r",
        baseBranch: "main",
        headBranch: "main",
        commitMessage: "msg",
        workingDirectory: path.join(dir, "sub"),
      },
      client,
    );

    // paths are relative to the repository root.
    expect(calls[0].fileChanges.additions.map((a) => a.path)).toEqual([
      "sub/inside.txt",
    ]);
    expect(calls[0].fileChanges.deletions).toEqual([]);
  });

  it("unstages changes even if the API fails", async () => {
    await fs.writeFile(path.join(dir, "new.txt"), "new\n");

    const { client } = fakeClient();
    client.createCommitOnBranch.mockRejectedValueOnce(new Error("boom"));
    await expect(
      commit(
        {
          repository: "o/r",
          baseBranch: "main",
          headBranch: "main",
          commitMessage: "msg",
          workingDirectory: dir,
        },
        client,
      ),
    ).rejects.toThrow("boom");

    const staged = await git(["diff", "--cached", "--name-only"], dir);
    expect(staged.toString()).toBe("");
  });

  describe("file modes", () => {
    // replaces the path in the tree entries with the contents of uploaded blobs.
    function summarize(tree: TreeEntry[], blobs: Map<string, string>) {
      return Object.fromEntries(
        tree.map((e) => [
          e.path,
          {
            mode: e.mode,
            type: e.type,
            contents: e.sha === null ? null : (blobs.get(e.sha) ?? e.sha),
          },
        ]),
      );
    }

    it("commits executable files, symbolic links and submodules", async () => {
      // make an existing file executable
      await fs.chmod(path.join(dir, "update-me.txt"), 0o755);
      // add a new executable file
      await fs.writeFile(path.join(dir, "run.sh"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      // add a symbolic link
      await fs.symlink("update-me.txt", path.join(dir, "link"));
      // add a submodule
      const sub = path.join(dir, "submodule");
      await fs.mkdir(sub);
      await git(["init", "--quiet"], sub);
      await git(
        [...gitConfig, "commit", "--quiet", "--allow-empty", "-m", "init"],
        sub,
      );
      const subSha = (await git(["rev-parse", "HEAD"], sub)).toString().trim();
      // delete a regular file
      await fs.rm(path.join(dir, "rename-me.txt"));

      const head = (await git(["rev-parse", "HEAD"], dir)).toString().trim();
      const headTree = (await git(["rev-parse", "HEAD^{tree}"], dir))
        .toString()
        .trim();

      const { client, blobs } = fakeClient();
      const result = await commit(
        {
          repository: "o/r",
          baseBranch: "main",
          headBranch: "main",
          commitMessage: "headline\n\nbody",
          workingDirectory: dir,
        },
        client,
      );

      expect(result?.oid).toBe("beef");
      expect(client.createCommitOnBranch).not.toHaveBeenCalled();
      expect(client.createTree).toHaveBeenCalledTimes(1);
      const [repo, baseTree, tree] = client.createTree.mock.calls[0];
      expect(repo).toBe("o/r");
      expect(baseTree).toBe(headTree);
      expect(summarize(tree, blobs)).toEqual({
        "update-me.txt": {
          mode: "100755",
          type: "blob",
          contents: "please update me!\n",
        },
        "run.sh": { mode: "100755", type: "blob", contents: "#!/bin/sh\n" },
        link: { mode: "120000", type: "blob", contents: "update-me.txt" },
        submodule: { mode: "160000", type: "commit", contents: subSha },
        "rename-me.txt": { mode: "100644", type: "blob", contents: null },
      });
      expect(client.createCommit).toHaveBeenCalledWith(
        "o/r",
        "headline\n\nbody",
        "tree0",
        [head],
      );
      expect(client.updateRef).toHaveBeenCalledWith("o/r", "main", "beef");
      expect(client.createRef).not.toHaveBeenCalled();
    });

    it("deletes symbolic links and submodules", async () => {
      // prepare a symbolic link and a submodule in HEAD
      await fs.symlink("update-me.txt", path.join(dir, "link"));
      const sub = path.join(dir, "submodule");
      await fs.mkdir(sub);
      await git(["init", "--quiet"], sub);
      await git(
        [...gitConfig, "commit", "--quiet", "--allow-empty", "-m", "init"],
        sub,
      );
      await git(["add", "."], dir);
      await git([...gitConfig, "commit", "--quiet", "-m", "prepare"], dir);

      await fs.rm(path.join(dir, "link"));
      await fs.rm(sub, { recursive: true, force: true });

      const { client, blobs } = fakeClient();
      await commit(
        {
          repository: "o/r",
          baseBranch: "main",
          headBranch: "topic",
          commitMessage: "msg",
          workingDirectory: dir,
        },
        client,
      );

      const tree = client.createTree.mock.calls[0][2];
      expect(summarize(tree, blobs)).toEqual({
        link: { mode: "120000", type: "blob", contents: null },
        submodule: { mode: "160000", type: "commit", contents: null },
      });
      expect(client.createBlob).not.toHaveBeenCalled();
      // a new branch is created at the new commit.
      expect(client.createRef).toHaveBeenCalledWith("o/r", "topic", "beef");
      expect(client.updateRef).not.toHaveBeenCalled();
      expect(client.createBranch).not.toHaveBeenCalled();
    });
  });
});

describe("checkout", () => {
  let dir: string;
  let remote: string;
  let work: string;

  // simulates the GitHub API: creates a commit in another clone, and pushes it to the remote.
  // so the local repository doesn't have the commit object until it fetches.
  async function createRemoteCommit(
    branch: string,
    apply: (dir: string) => Promise<void>,
  ): Promise<string> {
    await git(["fetch", "--quiet", "origin"], work);
    await git(["checkout", "--quiet", "--detach", "origin/main"], work);
    await apply(work);
    await git(["add", "--all", "."], work);
    await git([...gitConfig, "commit", "--quiet", "-m", "remote"], work);
    await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], work);
    return (await git(["rev-parse", "HEAD"], work)).toString().trim();
  }

  async function rev(ref: string): Promise<string> {
    return (await git(["rev-parse", ref], dir)).toString().trim();
  }

  async function status(): Promise<string> {
    return (await git(["status", "--porcelain"], dir)).toString();
  }

  const changes = async (d: string) => {
    await fs.appendFile(path.join(d, "update-me.txt"), "UPDATED!!\n");
    await fs.writeFile(path.join(d, "new.sh"), "#!/bin/sh\n", { mode: 0o755 });
  };

  beforeEach(async () => {
    dir = await setupRepository();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-commit-"));
    remote = path.join(tmp, "remote.git");
    work = path.join(tmp, "work");
    await git(["clone", "--quiet", "--bare", dir, remote], tmp);
    await git(["clone", "--quiet", remote, work], tmp);
    await git(["remote", "add", "origin", remote], dir);
    await git(["fetch", "--quiet", "origin"], dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.dirname(remote), { recursive: true, force: true });
  });

  it("moves the current branch to the commit", async () => {
    await changes(dir);
    const sha = await createRemoteCommit("main", changes);

    await checkout(
      { workingDirectory: dir, headBranch: "main", remoteUrl: remote },
      sha,
    );

    expect(await rev("HEAD")).toBe(sha);
    expect(await rev("refs/heads/main")).toBe(sha);
    expect(await rev("refs/remotes/origin/main")).toBe(sha);
    expect(await currentBranch()).toBe("main");
    expect(await upstream("main")).toBe("origin/main");
    expect(await status()).toBe("");
  });

  async function currentBranch(): Promise<string> {
    return (await git(["symbolic-ref", "--short", "HEAD"], dir))
      .toString()
      .trim();
  }

  async function upstream(branch: string): Promise<string> {
    return (
      await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], dir)
    )
      .toString()
      .trim();
  }

  it("switches to the head branch if the commit is on another branch", async () => {
    const base = await rev("HEAD");
    await changes(dir);
    const sha = await createRemoteCommit("topic", changes);

    await checkout(
      { workingDirectory: dir, headBranch: "topic", remoteUrl: remote },
      sha,
    );

    expect(await currentBranch()).toBe("topic");
    expect(await rev("HEAD")).toBe(sha);
    expect(await rev("refs/heads/topic")).toBe(sha);
    expect(await rev("refs/remotes/origin/topic")).toBe(sha);
    expect(await upstream("topic")).toBe("origin/topic");
    // the base branch is not changed.
    expect(await rev("refs/heads/main")).toBe(base);
    expect(await status()).toBe("");
  });

  it("moves the existing head branch to the commit", async () => {
    const base = await rev("HEAD");
    // the local head branch exists, but it is not checked out.
    await git(["branch", "topic", base], dir);
    await changes(dir);
    const sha = await createRemoteCommit("topic", changes);

    await checkout(
      { workingDirectory: dir, headBranch: "topic", remoteUrl: remote },
      sha,
    );

    expect(await currentBranch()).toBe("topic");
    expect(await rev("refs/heads/topic")).toBe(sha);
    expect(await rev("refs/heads/main")).toBe(base);
    expect(await status()).toBe("");
  });

  it("switches from a detached HEAD", async () => {
    await git(["checkout", "--quiet", "--detach"], dir);
    await changes(dir);
    const sha = await createRemoteCommit("main", changes);

    await checkout(
      { workingDirectory: dir, headBranch: "main", remoteUrl: remote },
      sha,
    );

    expect(await currentBranch()).toBe("main");
    expect(await rev("refs/heads/main")).toBe(sha);
    expect(await status()).toBe("");
  });

  it("keeps changes that are not committed", async () => {
    await changes(dir);
    // this change is not included in the commit.
    await fs.writeFile(path.join(dir, "sub", "keep.txt"), "modified\n");
    const sha = await createRemoteCommit("main", changes);

    await checkout(
      { workingDirectory: dir, headBranch: "main", remoteUrl: remote },
      sha,
    );

    expect(await rev("HEAD")).toBe(sha);
    expect(await status()).toBe(" M sub/keep.txt\n");
    expect(await fs.readFile(path.join(dir, "sub", "keep.txt"), "utf8")).toBe(
      "modified\n",
    );
  });
});

describe("defaultHeadBranch", () => {
  it("contains the date in UTC, the run id and the run attempt", () => {
    expect(
      defaultHeadBranch(
        "actions-commit-and-create-pr/",
        { runId: "1234567890", runAttempt: "2" },
        // 2022-01-03 08:00 in JST
        new Date("2022-01-02T23:00:00Z"),
      ),
    ).toBe("actions-commit-and-create-pr/2022-01-02-1234567890-2");
  });
});

describe("pullRequestBody", () => {
  const run = {
    workflow: "auto update",
    serverUrl: "https://github.com",
    repository: "o/r",
    runId: "123",
    runAttempt: "1",
  };

  it("appends a link to the workflow run and the markers", () => {
    const body = pullRequestBody("hello\n\nworld\n", run, {
      changes: "sha256:abc",
      group: ".github/workflows/update.yml:update",
      commit: "c0ffee",
    });
    expect(body).toBe(
      "hello\n\nworld\n\n-----\n\n" +
        "This pull request is generated by the auto update workflow. " +
        "[See the log](https://github.com/o/r/actions/runs/123/attempts/1).\n\n" +
        "<!-- actions-commit-and-create-pr:changes=sha256:abc -->\n" +
        "<!-- actions-commit-and-create-pr:group=.github/workflows/update.yml:update -->\n" +
        "<!-- actions-commit-and-create-pr:commit=c0ffee -->\n",
    );
    expect(extractMarkers(body, "changes")).toEqual(["sha256:abc"]);
    expect(extractMarkers(body, "group")).toEqual([
      ".github/workflows/update.yml:update",
    ]);
    expect(extractMarkers(body, "commit")).toEqual(["c0ffee"]);
  });

  it("omits the group if it is empty", () => {
    const body = pullRequestBody("hello", run, {
      changes: "sha256:abc",
      group: "",
      commit: "c0ffee",
    });
    expect(body).not.toContain(":group=");
  });
});

describe("marker", () => {
  it("escapes characters that end the comment", () => {
    const value = "a-->b --!> 100%\r\n<c>";
    const m = marker("group", value);
    expect(m).toBe(
      "<!-- actions-commit-and-create-pr:group=a--%3Eb --!%3E 100%25%0D%0A%3Cc%3E -->",
    );
    expect(extractMarkers(`body\n${m}\n`, "group")).toEqual([value]);
  });
});

describe("extractMarkers", () => {
  it("returns an empty list if there are no markers", () => {
    expect(extractMarkers("", "changes")).toEqual([]);
    expect(
      extractMarkers(
        "<!-- actions-commit-and-create-pr:changes=broken",
        "changes",
      ),
    ).toEqual([]);
  });

  it("returns all markers of the key", () => {
    expect(
      extractMarkers(
        "<!-- actions-commit-and-create-pr:changes=sha256:a -->\r\n" +
          "<!-- actions-commit-and-create-pr:group=g -->\r\n" +
          "edited by a human\r\n" +
          "<!-- actions-commit-and-create-pr:changes=sha256:b -->",
        "changes",
      ),
    ).toEqual(["sha256:a", "sha256:b"]);
  });

  it("ignores broken escapes", () => {
    expect(
      extractMarkers(
        "<!-- actions-commit-and-create-pr:group=%E3 -->\n" +
          "<!-- actions-commit-and-create-pr:group=ok -->",
        "group",
      ),
    ).toEqual(["ok"]);
  });
});

describe("defaultGroup", () => {
  it("returns the path of the workflow file and the job id", () => {
    expect(
      defaultGroup({
        GITHUB_REPOSITORY: "o/r",
        GITHUB_WORKFLOW_REF: "o/r/.github/workflows/update.yml@refs/heads/main",
        GITHUB_JOB: "update",
      }),
    ).toBe(".github/workflows/update.yml:update");
  });

  it("keeps @ in the path", () => {
    expect(
      defaultGroup({
        GITHUB_REPOSITORY: "o/r",
        GITHUB_WORKFLOW_REF: "o/r/.github/workflows/a@b.yml@refs/tags/v1",
        GITHUB_JOB: "job",
      }),
    ).toBe(".github/workflows/a@b.yml:job");
  });

  it("returns undefined outside of GitHub Actions", () => {
    expect(defaultGroup({})).toBeUndefined();
  });
});

describe("changesHash", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const z = "0".repeat(40);
  const changes: StagedChange[] = [
    {
      path: "a.txt",
      oldMode: "100644",
      newMode: "100644",
      newSha: a,
      status: "M",
    },
    {
      path: "b.txt",
      oldMode: "000000",
      newMode: "100644",
      newSha: b,
      status: "A",
    },
    {
      path: "c.txt",
      oldMode: "100644",
      newMode: "000000",
      newSha: z,
      status: "D",
    },
  ];

  it("doesn't depend on the order of the changes", () => {
    expect(changesHash([...changes].reverse())).toBe(changesHash(changes));
    expect(changesHash(changes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("depends on the paths, the modes and the contents", () => {
    const hash = changesHash(changes);
    const modify = (patch: Partial<StagedChange>) =>
      changesHash([{ ...changes[0], ...patch }, ...changes.slice(1)]);
    expect(modify({ path: "x.txt" })).not.toBe(hash);
    expect(modify({ newMode: "100755" })).not.toBe(hash);
    expect(modify({ newSha: b })).not.toBe(hash);
    // the old mode doesn't matter, because the result is same.
    expect(modify({ oldMode: "100755" })).toBe(hash);
  });

  it("is same for the same changes on different base commits", async () => {
    const dir = await setupRepository();
    try {
      await fs.appendFile(path.join(dir, "update-me.txt"), "UPDATED!!\n");
      const before = await collectChanges(dir);

      // move the base commit forward with an unrelated change.
      await git(["stash", "--quiet"], dir);
      await fs.writeFile(path.join(dir, "unrelated.txt"), "unrelated\n");
      await git(["add", "unrelated.txt"], dir);
      await git([...gitConfig, "commit", "--quiet", "-m", "unrelated"], dir);
      await git(["stash", "pop", "--quiet"], dir);
      const after = await collectChanges(dir);

      expect(after).toEqual(before);
      expect(changesHash(after)).toBe(changesHash(before));
      // the changes are not staged.
      const staged = await git(["diff", "--cached", "--name-only"], dir);
      expect(staged.toString()).toBe("");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function summary(
  number: number,
  markers: { changes?: string; group?: string; commit?: string },
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  const lines = ["body", ""];
  for (const [key, value] of Object.entries(markers)) {
    lines.push(marker(key, value));
  }
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    body: lines.join("\n"),
    headBranch: `topic-${number}`,
    headSha: `sha-${number}`,
    headRepository: "o/r",
    ...overrides,
  };
}

describe("findDuplicatePullRequest", () => {
  const options = { repository: "o/r", hash: "sha256:same" };

  it("finds a pull request with the same changes", () => {
    const found = findDuplicatePullRequest(
      [
        summary(1, { changes: "sha256:other" }),
        summary(2, { changes: "sha256:same" }),
        summary(3, { changes: "sha256:same" }),
      ],
      options,
    );
    expect(found?.number).toBe(2);
  });

  it("returns undefined if there are no pull requests with the same changes", () => {
    expect(
      findDuplicatePullRequest(
        [
          summary(1, { changes: "sha256:other" }),
          summary(2, {}, { body: "the marker is removed" }),
        ],
        options,
      ),
    ).toBeUndefined();
  });

  it("ignores pull requests from forks", () => {
    expect(
      findDuplicatePullRequest(
        [
          summary(1, { changes: "sha256:same" }, { headRepository: "fork/r" }),
          summary(2, { changes: "sha256:same" }, { headRepository: null }),
        ],
        options,
      ),
    ).toBeUndefined();
  });
});

describe("findSupersededPullRequests", () => {
  const options = { repository: "o/r", group: "g", number: 10 };
  const old = (number: number, overrides: Partial<PullRequestSummary> = {}) =>
    summary(number, { group: "g", commit: `sha-${number}` }, overrides);

  it("finds older pull requests in the same group", () => {
    const result = findSupersededPullRequests(
      [
        old(1),
        old(2),
        // another group
        summary(3, { group: "other", commit: "sha-3" }),
        // without the group marker, e.g. created by older versions
        summary(4, { commit: "sha-4" }),
        // from a fork
        old(5, { headRepository: "fork/r" }),
        // the new pull request itself, and newer ones by concurrent runs
        old(10),
        old(11),
      ],
      options,
    );
    expect(result.superseded.map((pr) => pr.number)).toEqual([1, 2]);
    expect(result.modified).toEqual([]);
  });

  it("doesn't close pull requests modified by humans", () => {
    const result = findSupersededPullRequests(
      [old(1), old(2, { headSha: "pushed-by-human" })],
      options,
    );
    expect(result.superseded.map((pr) => pr.number)).toEqual([1]);
    expect(result.modified.map((pr) => pr.number)).toEqual([2]);
  });
});

describe("closeSupersededPullRequests", () => {
  function fakeCloseClient() {
    return {
      createIssueComment: jest.fn<
        (repo: string, number: number, body: string) => Promise<void>
      >(async () => {}),
      closePullRequest: jest.fn<
        (repo: string, number: number) => Promise<void>
      >(async () => {}),
      deleteRef: jest.fn<(repo: string, branch: string) => Promise<void>>(
        async () => {},
      ),
    };
  }
  const newPullRequest = { number: 10, url: "https://github.com/o/r/pull/10" };

  beforeEach(() => {
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("comments, closes and deletes the branch", async () => {
    const client = fakeCloseClient();
    const closed = await closeSupersededPullRequests(
      "o/r",
      [summary(1, {}), summary(2, {})],
      newPullRequest,
      client,
    );

    expect(closed).toEqual([1, 2]);
    expect(client.createIssueComment).toHaveBeenCalledWith(
      "o/r",
      1,
      "This pull request is superseded by #10.",
    );
    expect(client.closePullRequest.mock.calls).toEqual([
      ["o/r", 1],
      ["o/r", 2],
    ]);
    expect(client.deleteRef.mock.calls).toEqual([
      ["o/r", "topic-1"],
      ["o/r", "topic-2"],
    ]);
  });

  it("continues on errors", async () => {
    const client = fakeCloseClient();
    client.closePullRequest.mockRejectedValueOnce(new Error("boom"));
    client.deleteRef.mockRejectedValueOnce(new Error("boom"));
    const closed = await closeSupersededPullRequests(
      "o/r",
      [summary(1, {}), summary(2, {}), summary(3, {})],
      newPullRequest,
      client,
    );

    // #1 is not closed, #2 is closed but its branch is not deleted.
    expect(closed).toEqual([2, 3]);
    expect(client.deleteRef.mock.calls).toEqual([
      ["o/r", "topic-2"],
      ["o/r", "topic-3"],
    ]);
  });
});

describe("parseLabels", () => {
  it("splits labels by commas and newlines", () => {
    expect(parseLabels(" a, b \r\n\nc\n a ,,")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels(" ,\n")).toEqual([]);
  });
});

describe("createPullRequest", () => {
  it("creates a pull request from the head branch to the base branch", async () => {
    const client = {
      createPullRequest: jest.fn(async () => ({
        number: 42,
        url: "https://github.com/o/r/pull/42",
      })),
    };
    const pr = await createPullRequest(
      {
        repository: "o/r",
        baseBranch: "main",
        headBranch: "topic",
        title: "title",
        body: "body",
      },
      client,
    );

    expect(pr).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    expect(client.createPullRequest).toHaveBeenCalledWith("o/r", {
      title: "title",
      body: "body",
      base: "main",
      head: "topic",
    });
  });
});

describe("run", () => {
  const saved = { ...process.env };
  let written: string[];

  beforeEach(() => {
    written = [];
    jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...saved };
    process.exitCode = undefined;
  });

  it("fails if the head branch is same as the base branch", async () => {
    process.env["INPUT_GITHUB-TOKEN"] = "token";
    process.env["INPUT_BASE-BRANCH"] = "main";
    process.env["INPUT_HEAD-BRANCH"] = "main";
    process.env.GITHUB_REPOSITORY = "o/r";

    await run();

    expect(process.exitCode).toBe(1);
    expect(written.join("")).toContain(
      "::error::head-branch must be different from base-branch: main",
    );
  });

  it("fails if the group is unknown and close-superseded is true", async () => {
    process.env["INPUT_GITHUB-TOKEN"] = "token";
    process.env["INPUT_BASE-BRANCH"] = "main";
    process.env["INPUT_HEAD-BRANCH"] = "topic";
    process.env["INPUT_CLOSE-SUPERSEDED"] = "true";
    process.env.GITHUB_REPOSITORY = "o/r";
    delete process.env.GITHUB_WORKFLOW_REF;
    delete process.env.GITHUB_JOB;

    await run();

    expect(process.exitCode).toBe(1);
    expect(written.join("")).toContain(
      "::error::group is required to close superseded pull requests",
    );
  });

  describe("duplicate pull requests", () => {
    let dir: string;
    let tmp: string;
    let outputFile: string;
    let hash: string;

    // parses the file written by core.setOutput.
    async function outputs(): Promise<Record<string, string>> {
      const contents = await fs.readFile(outputFile, "utf8");
      const result: Record<string, string> = {};
      for (const m of contents.matchAll(/^(\S+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
        result[m[1]] = m[3];
      }
      return result;
    }

    function fakeFetch(pulls: unknown[]) {
      return jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) =>
          String(input).includes("/pulls?")
            ? new Response(JSON.stringify(pulls), { status: 200 })
            : new Response("{}", { status: 500 }),
        );
    }

    beforeEach(async () => {
      dir = await setupRepository();
      await fs.appendFile(path.join(dir, "update-me.txt"), "UPDATED!!\n");
      hash = changesHash(await collectChanges(dir));
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-commit-"));
      outputFile = path.join(tmp, "output");
      await fs.writeFile(outputFile, "");

      process.env["INPUT_GITHUB-TOKEN"] = "token";
      process.env["INPUT_BASE-BRANCH"] = "main";
      process.env["INPUT_HEAD-BRANCH"] = "topic";
      process.env["INPUT_WORKING-DIRECTORY"] = dir;
      process.env.GITHUB_REPOSITORY = "o/r";
      process.env.GITHUB_OUTPUT = outputFile;
      process.env.GITHUB_API_URL = "https://api.example.com";
      process.env.GITHUB_GRAPHQL_URL = "https://api.example.com/graphql";
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("skips creating a pull request", async () => {
      const fetch = fakeFetch([
        {
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          body: `body\n<!-- actions-commit-and-create-pr:changes=${hash} -->`,
          head: { ref: "existing", sha: "abc", repo: { full_name: "o/r" } },
        },
      ]);

      await run();

      expect(process.exitCode).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await outputs()).toEqual({
        "head-branch": "existing",
        "pr-url": "https://github.com/o/r/pull/7",
        "pr-number": "7",
        duplicated: "true",
      });
      // the changes are kept in the working tree.
      const status = await git(["status", "--porcelain"], dir);
      expect(status.toString()).toBe(" M update-me.txt\n");
    });

    it("doesn't search pull requests if skip-duplicate is false", async () => {
      process.env["INPUT_SKIP-DUPLICATE"] = "false";
      const fetch = fakeFetch([]);

      await run();

      // it tries to create a branch, and fails because of the fake API.
      expect(process.exitCode).toBe(1);
      const urls = fetch.mock.calls.map(([input]) => String(input));
      expect(urls).toEqual(["https://api.example.com/graphql"]);
    });

    it("closes superseded pull requests", async () => {
      process.env["INPUT_CLOSE-SUPERSEDED"] = "true";
      process.env.INPUT_GROUP = "g";
      // the checkout after creating the pull request fails quickly.
      process.env.GITHUB_SERVER_URL = `file://${tmp}/no-such-server`;
      const requests: { method: string; url: string; body: string }[] = [];
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const method = init?.method ?? "GET";
          const url = String(input);
          const body = String(init?.body ?? "");
          requests.push({ method, url, body });
          const json = (data: unknown, status = 200) =>
            new Response(JSON.stringify(data), { status });
          if (url.includes("/graphql")) {
            if (body.includes("createCommitOnBranch(")) {
              return json({
                data: {
                  createCommitOnBranch: {
                    commit: {
                      oid: "c0ffee",
                      url: "u",
                      signature: { isValid: true },
                    },
                  },
                },
              });
            }
            if (body.includes("createRef(")) {
              return json({ data: { createRef: { clientMutationId: null } } });
            }
            return json({ data: { repository: { id: "R_1" } } });
          }
          if (method === "GET" && url.includes("/pulls?")) {
            return json([
              {
                number: 3,
                html_url: "https://github.com/o/r/pull/3",
                body: `${marker("group", "g")}\n${marker("commit", "sha-3")}`,
                head: { ref: "old", sha: "sha-3", repo: { full_name: "o/r" } },
              },
            ]);
          }
          if (method === "POST" && url.endsWith("/pulls")) {
            return json(
              { number: 10, html_url: "https://github.com/o/r/pull/10" },
              201,
            );
          }
          if (method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          return json({});
        });

      await run();

      const summary = requests.map((r) => `${r.method} ${r.url}`);
      expect(summary.filter((r) => r.includes("/pulls?"))).toHaveLength(1);
      expect(summary.slice(-3)).toEqual([
        "POST https://api.example.com/repos/o/r/issues/3/comments",
        "PATCH https://api.example.com/repos/o/r/pulls/3",
        "DELETE https://api.example.com/repos/o/r/git/refs/heads/old",
      ]);
      const created = requests.find(
        (r) => r.method === "POST" && r.url.endsWith("/pulls"),
      );
      const body = JSON.parse(created?.body ?? "{}").body as string;
      expect(extractMarkers(body, "group")).toEqual(["g"]);
      expect(extractMarkers(body, "commit")).toEqual(["c0ffee"]);
      expect(await outputs()).toMatchObject({
        "pr-number": "10",
        duplicated: "false",
        "closed-pull-requests": "[3]",
      });
      // the checkout fails because of the fake server.
      expect(process.exitCode).toBe(1);
    });

    describe("labels", () => {
      let requests: { method: string; url: string; body: string }[];

      // fakes the API to create a commit and a pull request.
      function fakeApi(labelStatus: number, oid = "c0ffee") {
        requests = [];
        jest
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const method = init?.method ?? "GET";
            const url = String(input);
            const body = String(init?.body ?? "");
            requests.push({ method, url, body });
            const json = (data: unknown, status = 200) =>
              new Response(JSON.stringify(data), { status });
            if (url.includes("/graphql")) {
              if (body.includes("createCommitOnBranch(")) {
                return json({
                  data: {
                    createCommitOnBranch: {
                      commit: {
                        oid,
                        url: "u",
                        signature: { isValid: true },
                      },
                    },
                  },
                });
              }
              if (body.includes("createRef(")) {
                return json({
                  data: { createRef: { clientMutationId: null } },
                });
              }
              return json({ data: { repository: { id: "R_1" } } });
            }
            if (method === "GET" && url.includes("/pulls?")) {
              return json([]);
            }
            if (method === "POST" && url.endsWith("/pulls")) {
              return json(
                { number: 10, html_url: "https://github.com/o/r/pull/10" },
                201,
              );
            }
            if (url.endsWith("/issues/10/labels")) {
              return json({ message: "label error" }, labelStatus);
            }
            return json({});
          });
      }

      // makes the checkout succeed: the fake API returns HEAD as the created commit,
      // and the remote repository has it.
      async function setupRemote(): Promise<string> {
        const server = path.join(tmp, "server");
        const remote = path.join(server, "o", "r");
        await fs.mkdir(remote, { recursive: true });
        await git(["init", "--quiet", "--bare", remote], tmp);
        await git(["push", "--quiet", remote, "HEAD:refs/heads/topic"], dir);
        process.env.GITHUB_SERVER_URL = `file://${server}`;
        return (await git(["rev-parse", "HEAD"], dir)).toString().trim();
      }

      beforeEach(() => {
        process.env.INPUT_LABELS = "bug, enhancement\nbug";
      });

      it("adds labels to the new pull request", async () => {
        fakeApi(200);
        process.env.GITHUB_SERVER_URL = `file://${tmp}/no-such-server`;

        await run();

        const label = requests.find((r) => r.url.endsWith("/labels"));
        expect(label?.method).toBe("POST");
        expect(label?.url).toBe(
          "https://api.example.com/repos/o/r/issues/10/labels",
        );
        expect(JSON.parse(label?.body ?? "{}")).toEqual({
          labels: ["bug", "enhancement"],
        });
      });

      it("fails after finishing the rest if it can't add labels", async () => {
        const head = await setupRemote();
        fakeApi(403, head);

        await run();

        expect(process.exitCode).toBe(1);
        // the checkout is done.
        const branch = await git(["symbolic-ref", "--short", "HEAD"], dir);
        expect(branch.toString().trim()).toBe("topic");
        expect(written.join("")).toMatch(
          /::error::failed to add labels to https:\/\/github.com\/o\/r\/pull\/10: .*403/,
        );
        expect(await outputs()).toMatchObject({
          "pr-url": "https://github.com/o/r/pull/10",
          "pr-number": "10",
        });
      });

      it("suggests the issues: write permission on 422", async () => {
        const head = await setupRemote();
        fakeApi(422, head);

        await run();

        expect(process.exitCode).toBe(1);
        expect(written.join("")).toMatch(
          /::error::failed to add labels to .*422.* Labels that don't exist are created only if the token has the issues: write permission\./,
        );
      });

      it("doesn't add labels to a duplicate pull request", async () => {
        fakeFetch([
          {
            number: 7,
            html_url: "https://github.com/o/r/pull/7",
            body: marker("changes", hash),
            head: { ref: "existing", sha: "abc", repo: { full_name: "o/r" } },
          },
        ]);

        await run();

        expect(process.exitCode).toBeUndefined();
        expect((await outputs()).duplicated).toBe("true");
      });
    });
  });
});
