# Commit and Create a Pull Request Action

Commit all changes to a new branch, create a pull request.
The action uses the GraphQL API instead of the `git` command.
Commits authored using the action are automatically GPG signed and
are [marked as verified](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) on the GitHub UI.

## Synopsis

```yaml
name: auto update
on:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v3
      - name: make some changes
        run: ": do something"

      - name: commit and create a pull request
        uses: shogo82148/actions-commit-and-create-pr@v1
```

## Permissions

The token needs the `contents: write` permission to create a branch and a commit,
and the `pull-requests: write` permission to create a pull request.
If you use `GITHUB_TOKEN`, you also need to enable "Allow GitHub Actions to create and approve pull requests" in the repository settings.

## Duplicate Pull Requests

By default, the action doesn't create a new pull request
if an open pull request into the base branch has the same changes.
The changes are compared by the paths, the file modes and the contents of changed files,
so the pull request is considered as a duplicate even if the base branch has moved forward.
In that case, the action creates neither a branch nor a commit,
and the outputs point to the existing pull request.

The action embeds a hidden marker (`<!-- actions-commit-and-create-pr:changes=... -->`) into the pull request body to detect duplicates.
If you remove the marker from the body, the pull request is no longer considered.
Only pull requests whose head branch is in the same repository are considered.

If the workflow runs concurrently, both runs may create pull requests with the same changes.
Use [`concurrency`](https://docs.github.com/en/actions/using-jobs/using-concurrency) to avoid it.

## File Modes

If all changes are regular files, the action uses the [createCommitOnBranch](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch) mutation.
Otherwise (executable files, symbolic links or submodules are involved), it uses the [Git Database API](https://docs.github.com/en/rest/git), because the mutation doesn't support file modes.
In that case, the commit is signed only when the token belongs to a GitHub App (e.g. `GITHUB_TOKEN`), not a user (e.g. a personal access token).

## Inputs

### github-token

The GitHub Token. The default is `${{ github.token }}`

### base-branch

The base branch. The default is the branch name that triggered the workflow run. ( `${{ github.ref_name }}` )

### head-branch

The head branch. It must be different from `base-branch`. The default is `actions-commit-and-create-pr/$(date -u '+%Y-%m-%d')-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`.

### head-branch-prefix

The prefix of the head branch.
If `head-branch` is set, `head-branch-prefix` is ignored.
The default is `actions-commit-and-create-pr/`.

### commit-message:

The commit message.
The default is "Auto updates by the $GITHUB_WORKFLOW workflow".

### working-directory

The directory that contains changes to commit.
Only changes under the directory are committed.
The default is `.`.

### skip-duplicate

Skip creating a pull request if an open pull request into the base branch has the same changes.
The default is `true`.

### title

The title of pull requests.
The default is the first line of the commit message.

### body

The body of a pull request.
The default is same as the commit message.
A link to the workflow run is appended to the body.

## Outputs

If there are no changes, the action does nothing and the outputs are empty.

### commit-url

The URL of the commit created.
It is empty if creating a pull request is skipped.

### commit-sha

The SHA of the commit created.
After the action, the head branch is checked out at the commit.
It is empty if creating a pull request is skipped.

### head-branch

The name of the head branch created.
If creating a pull request is skipped, it is the head branch of the existing pull request.

### pr-url

The URL of the pull request created.
If creating a pull request is skipped, it is the URL of the existing pull request.

### pr-number

The number of the pull request created.
If creating a pull request is skipped, it is the number of the existing pull request.

### duplicated

`true` if creating a pull request is skipped because an open pull request has the same changes.
Otherwise, `false`.

## Related Works

- [Create Pull Request](https://github.com/marketplace/actions/create-pull-request) Action

## See Also

- [A simpler API for authoring commits](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- [GitHub GraphQL API で新しいブランチを作成する](https://int128.hatenablog.com/entry/2020/01/15/165432)
