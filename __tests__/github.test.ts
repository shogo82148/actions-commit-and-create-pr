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
});
