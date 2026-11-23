import { jest } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../src/git.js";
import type {
  Commit,
  CreateCommitOnBranchInput,
  TreeEntry,
} from "../src/github.js";
import { Client, checkout, commit, splitCommitMessage } from "../src/main.js";

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
