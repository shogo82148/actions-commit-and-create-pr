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

### commit-sha

The SHA of the commit created.
After the action, the head branch is checked out at the commit.

### head-branch

The name of the head branch created.

### pr-url

The URL of the pull request created.

### pr-number

The number of the pull request created.

## Related Works

- [Create Pull Request](https://github.com/marketplace/actions/create-pull-request) Action

## See Also

- [A simpler API for authoring commits](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- [GitHub GraphQL API で新しいブランチを作成する](https://int128.hatenablog.com/entry/2020/01/15/165432)
