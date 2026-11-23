/** A file to be added or updated. */
export interface FileAddition {
  path: string;
  /** base64 encoded contents of the file. */
  contents: string;
}

/** A file to be deleted. */
export interface FileDeletion {
  path: string;
}

/** The input of the createCommitOnBranch mutation. */
export interface CreateCommitOnBranchInput {
  branch: {
    repositoryNameWithOwner: string;
    branchName: string;
  };
  expectedHeadOid: string;
  fileChanges: {
    additions: FileAddition[];
    deletions: FileDeletion[];
  };
  message: {
    headline: string;
    body?: string;
  };
}

/** A commit created. */
export interface Commit {
  oid: string;
  url: string;
  /** Whether GitHub marks the commit as verified. */
  verified: boolean;
}

/** An entry of a tree, used by the create tree API. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  /** The SHA of the object, or null to delete the entry. */
  sha: string | null;
}

/** The input of the create pull request API. */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  /** The name of the branch that the changes are pulled into. */
  base: string;
  /** The name of the branch where the changes are implemented. */
  head: string;
}

/** A pull request created. */
export interface PullRequest {
  number: number;
  url: string;
}

/** Options of GitHubClient. */
export interface GitHubClientOptions {
  /** The endpoint of GitHub GraphQL API. */
  graphqlUrl?: string;
  /** The base URL of GitHub REST API. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/** A minimal client of GitHub GraphQL API and REST API. */
export class GitHubClient {
  private readonly token: string;
  private readonly graphqlUrl: string;
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;

  constructor(token: string, options: GitHubClientOptions = {}) {
    this.token = token;
    this.graphqlUrl =
      options.graphqlUrl ||
      process.env.GITHUB_GRAPHQL_URL ||
      "https://api.github.com/graphql";
    this.apiUrl = (
      options.apiUrl ||
      process.env.GITHUB_API_URL ||
      "https://api.github.com"
    ).replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "shogo82148/actions-commit",
    };
  }

  /**
   * Calls GitHub GraphQL API.
   *
   * @param query The GraphQL query.
   * @param variables The variables of the query.
   * @returns The data of the response.
   */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.fetch(this.graphqlUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `GitHub GraphQL API returned ${res.status} ${res.statusText}: ${text}`,
      );
    }
    const json = JSON.parse(text) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL API returned errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (json.data === undefined || json.data === null) {
      throw new Error("GitHub GraphQL API returned no data");
    }
    return json.data;
  }

  /**
   * Calls GitHub REST API.
   *
   * @param method The HTTP method.
   * @param path The path of the API, e.g. "/repos/octocat/hello-world/git/blobs".
   * @param body The request body.
   * @returns The response body.
   */
  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        ...this.headers(),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `GitHub REST API ${method} ${path} returned ${res.status} ${res.statusText}: ${text}`,
      );
    }
    return JSON.parse(text) as T;
  }

  /**
   * Gets the node ID of a repository.
   *
   * @param nameWithOwner The repository name with owner, e.g. "octocat/hello-world".
   * @returns The node ID of the repository.
   */
  async getRepositoryId(nameWithOwner: string): Promise<string> {
    const [owner, name] = nameWithOwner.split("/", 2);
    const data = await this.graphql<{ repository: { id: string } | null }>(
      `query ($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { id }
      }`,
      { owner, name },
    );
    if (!data.repository) {
      throw new Error(`repository ${nameWithOwner} is not found`);
    }
    return data.repository.id;
  }

  /**
   * Creates a new branch.
   *
   * @param repositoryId The node ID of the repository.
   * @param branch The name of the branch.
   * @param oid The SHA of the commit that the branch points to.
   */
  async createBranch(
    repositoryId: string,
    branch: string,
    oid: string,
  ): Promise<void> {
    await this.graphql(
      `mutation ($input: CreateRefInput!) {
        createRef(input: $input) { clientMutationId }
      }`,
      {
        input: {
          repositoryId,
          name: `refs/heads/${branch}`,
          oid,
        },
      },
    );
  }

  /**
   * Creates a new commit on a branch.
   *
   * @param input The input of the createCommitOnBranch mutation.
   * @returns The commit created.
   */
  async createCommitOnBranch(
    input: CreateCommitOnBranchInput,
  ): Promise<Commit> {
    const data = await this.graphql<{
      createCommitOnBranch: {
        commit: {
          oid: string;
          url: string;
          signature: { isValid: boolean } | null;
        };
      };
    }>(
      `mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit { oid url signature { isValid } }
        }
      }`,
      { input },
    );
    const { oid, url, signature } = data.createCommitOnBranch.commit;
    return { oid, url, verified: signature?.isValid ?? false };
  }

  /**
   * Creates a blob.
   *
   * @param repository The repository name with owner.
   * @param contents The contents of the blob.
   * @returns The SHA of the blob.
   */
  async createBlob(repository: string, contents: Buffer): Promise<string> {
    const data = await this.rest<{ sha: string }>(
      "POST",
      `/repos/${repository}/git/blobs`,
      { content: contents.toString("base64"), encoding: "base64" },
    );
    return data.sha;
  }

  /**
   * Creates a tree.
   *
   * @param repository The repository name with owner.
   * @param baseTree The SHA of the base tree.
   * @param tree The entries to be updated.
   * @returns The SHA of the tree.
   */
  async createTree(
    repository: string,
    baseTree: string,
    tree: TreeEntry[],
  ): Promise<string> {
    const data = await this.rest<{ sha: string }>(
      "POST",
      `/repos/${repository}/git/trees`,
      { base_tree: baseTree, tree },
    );
    return data.sha;
  }

  /**
   * Creates a commit.
   * The author and the committer are not specified,
   * so that GitHub can sign the commit if the token belongs to a GitHub App.
   *
   * @param repository The repository name with owner.
   * @param message The commit message.
   * @param tree The SHA of the tree.
   * @param parents The SHAs of the parents.
   * @returns The commit created.
   */
  async createCommit(
    repository: string,
    message: string,
    tree: string,
    parents: string[],
  ): Promise<Commit> {
    const data = await this.rest<{
      sha: string;
      html_url: string;
      verification?: { verified: boolean };
    }>("POST", `/repos/${repository}/git/commits`, { message, tree, parents });
    return {
      oid: data.sha,
      url: data.html_url,
      verified: data.verification?.verified ?? false,
    };
  }

  /**
   * Creates a new branch.
   *
   * @param repository The repository name with owner.
   * @param branch The name of the branch.
   * @param sha The SHA of the commit that the branch points to.
   */
  async createRef(
    repository: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    await this.rest("POST", `/repos/${repository}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Updates a branch. It fails if the update is not a fast-forward.
   *
   * @param repository The repository name with owner.
   * @param branch The name of the branch.
   * @param sha The SHA of the commit that the branch points to.
   */
  async updateRef(
    repository: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    await this.rest("PATCH", `/repos/${repository}/git/refs/heads/${ref}`, {
      sha,
      force: false,
    });
  }

  /**
   * Creates a pull request.
   *
   * @param repository The repository name with owner.
   * @param input The title, the body, the base branch and the head branch.
   * @returns The pull request created.
   */
  async createPullRequest(
    repository: string,
    input: CreatePullRequestInput,
  ): Promise<PullRequest> {
    const data = await this.rest<{ number: number; html_url: string }>(
      "POST",
      `/repos/${repository}/pulls`,
      {
        title: input.title,
        body: input.body,
        base: input.base,
        head: input.head,
      },
    );
    return { number: data.number, url: data.html_url };
  }
}
