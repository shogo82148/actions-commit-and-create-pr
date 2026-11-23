import { jest } from "@jest/globals";
import { GitHubClient } from "../src/github.js";

function fakeFetch(status: number, body: unknown) {
  return jest.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

describe("GitHubClient", () => {
  it("sends a GraphQL request", async () => {
    const fetch = fakeFetch(200, {
      data: {
        createCommitOnBranch: {
          commit: {
            oid: "abc",
            url: "https://example.com/abc",
            signature: { isValid: true },
          },
        },
      },
    });
    const client = new GitHubClient("token", {
      graphqlUrl: "https://api.example.com/graphql",
      apiUrl: "https://api.example.com/",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const commit = await client.createCommitOnBranch({
      branch: { repositoryNameWithOwner: "o/r", branchName: "main" },
      expectedHeadOid: "0123",
      fileChanges: { additions: [], deletions: [] },
      message: { headline: "hello" },
    });

    expect(commit).toEqual({
      oid: "abc",
      url: "https://example.com/abc",
      verified: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/graphql");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "bearer token",
    );
    const body = JSON.parse(init?.body as string);
    expect(body.variables.input.expectedHeadOid).toBe("0123");
  });

  it("throws GraphQL errors", async () => {
    const fetch = fakeFetch(200, {
      data: null,
      errors: [{ message: "something wrong" }],
    });
    const client = new GitHubClient("token", {
      graphqlUrl: "https://api.example.com/graphql",
      apiUrl: "https://api.example.com/",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(client.getRepositoryId("o/r")).rejects.toThrow(
      /something wrong/,
    );
  });

  it("throws HTTP errors", async () => {
    const fetch = fakeFetch(401, { message: "Bad credentials" });
    const client = new GitHubClient("token", {
      graphqlUrl: "https://api.example.com/graphql",
      apiUrl: "https://api.example.com/",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(client.createBranch("R_1", "topic", "0123")).rejects.toThrow(
      /401/,
    );
  });

  it("creates a commit via the REST API", async () => {
    const fetch = fakeFetch(201, {
      sha: "abc",
      html_url: "https://example.com/abc",
      verification: { verified: false },
    });
    const client = new GitHubClient("token", {
      graphqlUrl: "https://api.example.com/graphql",
      apiUrl: "https://api.example.com/",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const commit = await client.createCommit("o/r", "msg", "tree", ["p"]);

    expect(commit).toEqual({
      oid: "abc",
      url: "https://example.com/abc",
      verified: false,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/repos/o/r/git/commits");
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string>)["X-GitHub-Api-Version"],
    ).toBe("2026-03-10");
    // author and committer must not be set, so that GitHub signs the commit.
    expect(JSON.parse(init?.body as string)).toEqual({
      message: "msg",
      tree: "tree",
      parents: ["p"],
    });
  });

  it("updates a ref without force", async () => {
    const fetch = fakeFetch(200, {});
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await client.updateRef("o/r", "feature/foo bar", "abc");

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://api.example.com/repos/o/r/git/refs/heads/feature/foo%20bar",
    );
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({
      sha: "abc",
      force: false,
    });
  });

  it("creates a pull request", async () => {
    const fetch = fakeFetch(201, {
      number: 42,
      html_url: "https://example.com/o/r/pull/42",
    });
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const pr = await client.createPullRequest("o/r", {
      title: "title",
      body: "body",
      base: "main",
      head: "topic",
    });

    expect(pr).toEqual({ number: 42, url: "https://example.com/o/r/pull/42" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/repos/o/r/pulls");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "title",
      body: "body",
      base: "main",
      head: "topic",
    });
  });

  it("throws an error if the pull request can't be created", async () => {
    const fetch = fakeFetch(422, {
      message: "Validation Failed",
      errors: [{ message: "A pull request already exists for o:topic." }],
    });
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(
      client.createPullRequest("o/r", {
        title: "title",
        body: "body",
        base: "main",
        head: "topic",
      }),
    ).rejects.toThrow(/422.*A pull request already exists/);
  });

  it("lists all open pull requests with pagination", async () => {
    const pull = (n: number, repo: { full_name: string } | null) => ({
      number: n,
      html_url: `https://example.com/o/r/pull/${n}`,
      body: n === 1 ? null : `body ${n}`,
      head: { ref: `topic-${n}`, sha: `sha-${n}`, repo },
    });
    const pages = [
      Array.from({ length: 100 }, (_, i) => pull(i + 1, { full_name: "o/r" })),
      [pull(101, null)],
    ];
    const fetch = jest.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(JSON.stringify(pages.shift() ?? []), { status: 200 }),
    );
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const pulls = await client.listOpenPullRequests("o/r", "feature/a b");

    expect(pulls).toHaveLength(101);
    expect(pulls[0]).toEqual({
      number: 1,
      url: "https://example.com/o/r/pull/1",
      body: "",
      headBranch: "topic-1",
      headSha: "sha-1",
      headRepository: "o/r",
    });
    expect(pulls[100]).toEqual({
      number: 101,
      url: "https://example.com/o/r/pull/101",
      body: "body 101",
      headBranch: "topic-101",
      headSha: "sha-101",
      headRepository: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].pathname).toBe("/repos/o/r/pulls");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      state: "open",
      base: "feature/a b",
      per_page: "100",
      page: "1",
    });
    expect(urls[1].searchParams.get("page")).toBe("2");
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
  });

  it("closes a pull request with a comment, and deletes the branch", async () => {
    const fetch = jest.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async (_input, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response("{}", { status: 200 }),
    );
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await client.createIssueComment("o/r", 3, "superseded");
    await client.closePullRequest("o/r", 3);
    await client.deleteRef("o/r", "feature/foo bar");

    const calls = fetch.mock.calls.map(([url, init]) => [
      init?.method,
      url,
      init?.body === undefined ? undefined : JSON.parse(init.body as string),
    ]);
    expect(calls).toEqual([
      [
        "POST",
        "https://api.example.com/repos/o/r/issues/3/comments",
        { body: "superseded" },
      ],
      [
        "PATCH",
        "https://api.example.com/repos/o/r/pulls/3",
        { state: "closed" },
      ],
      [
        "DELETE",
        "https://api.example.com/repos/o/r/git/refs/heads/feature/foo%20bar",
        undefined,
      ],
    ]);
  });

  it("adds labels to a pull request", async () => {
    const fetch = fakeFetch(200, []);
    const client = new GitHubClient("token", {
      apiUrl: "https://api.example.com",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await client.addLabels("o/r", 3, ["bug", "good first issue"]);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/repos/o/r/issues/3/labels");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      labels: ["bug", "good first issue"],
    });
  });
});
