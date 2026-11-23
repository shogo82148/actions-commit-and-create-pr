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
/** A minimal client of GitHub GraphQL API and REST API. */
export declare class GitHubClient {
    private readonly token;
    private readonly graphqlUrl;
    private readonly apiUrl;
    private readonly fetch;
    constructor(token: string, options?: GitHubClientOptions);
    private headers;
    /**
     * Calls GitHub GraphQL API.
     *
     * @param query The GraphQL query.
     * @param variables The variables of the query.
     * @returns The data of the response.
     */
    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
    /**
     * Calls GitHub REST API.
     *
     * @param method The HTTP method.
     * @param path The path of the API, e.g. "/repos/octocat/hello-world/git/blobs".
     * @param body The request body.
     * @returns The response body.
     */
    rest<T>(method: string, path: string, body?: unknown): Promise<T>;
    /**
     * Gets the node ID of a repository.
     *
     * @param nameWithOwner The repository name with owner, e.g. "octocat/hello-world".
     * @returns The node ID of the repository.
     */
    getRepositoryId(nameWithOwner: string): Promise<string>;
    /**
     * Creates a new branch.
     *
     * @param repositoryId The node ID of the repository.
     * @param branch The name of the branch.
     * @param oid The SHA of the commit that the branch points to.
     */
    createBranch(repositoryId: string, branch: string, oid: string): Promise<void>;
    /**
     * Creates a new commit on a branch.
     *
     * @param input The input of the createCommitOnBranch mutation.
     * @returns The commit created.
     */
    createCommitOnBranch(input: CreateCommitOnBranchInput): Promise<Commit>;
    /**
     * Creates a blob.
     *
     * @param repository The repository name with owner.
     * @param contents The contents of the blob.
     * @returns The SHA of the blob.
     */
    createBlob(repository: string, contents: Buffer): Promise<string>;
    /**
     * Creates a tree.
     *
     * @param repository The repository name with owner.
     * @param baseTree The SHA of the base tree.
     * @param tree The entries to be updated.
     * @returns The SHA of the tree.
     */
    createTree(repository: string, baseTree: string, tree: TreeEntry[]): Promise<string>;
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
    createCommit(repository: string, message: string, tree: string, parents: string[]): Promise<Commit>;
    /**
     * Creates a new branch.
     *
     * @param repository The repository name with owner.
     * @param branch The name of the branch.
     * @param sha The SHA of the commit that the branch points to.
     */
    createRef(repository: string, branch: string, sha: string): Promise<void>;
    /**
     * Updates a branch. It fails if the update is not a fast-forward.
     *
     * @param repository The repository name with owner.
     * @param branch The name of the branch.
     * @param sha The SHA of the commit that the branch points to.
     */
    updateRef(repository: string, branch: string, sha: string): Promise<void>;
    /**
     * Creates a pull request.
     *
     * @param repository The repository name with owner.
     * @param input The title, the body, the base branch and the head branch.
     * @returns The pull request created.
     */
    createPullRequest(repository: string, input: CreatePullRequestInput): Promise<PullRequest>;
}
