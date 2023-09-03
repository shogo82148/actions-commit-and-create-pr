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
    steps:
      - uses: actions/checkout@v3
      - name: make some changes
        run: ": do something"

      - name: commit and create a pull request
        uses: shogo82148/actions-commit-and-create-pr@v1
```

## Limitation

Currently (on 2022-01-03), the [createCommitOnBranch](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch) mutation doesn't support file types (i.e. regular file, symlink, submodule, ...).
All files will be committed as regular files.
You can't create executable files, symlinks, submodules, and so on.

## Inputs

### github-token

The GitHub Token. The default is `${{ github.token }}`

### base-branch

The base branch. The default is the branch name that triggered the workflow run. ( `${{ github.ref_name }}` )

### head-branch

The head branch. The default is `actions-commit-and-create-pr/$(date -u '+%Y-%m-%d')-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`.

### head-branch-prefix

The prefix of the head branch.
If `head-branch` is set, `head-branch-prefix` is ignored.
The default is `actions-commit-and-create-pr/`.

### commit-message:

The commit message.
The default is "Auto updates by the $GITHUB_WORKFLOW workflow".

### title

The title of pull requests.
The default is same as the commit message.

### body

The body of a pull request.
The default is same as the commit message.

## Related Works

- [Create Pull Request](https://github.com/marketplace/actions/create-pull-request) Action

## See Also

- [A simpler API for authoring commits](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- [GitHub GraphQL API で新しいブランチを作成する](https://int128.hatenablog.com/entry/2020/01/15/165432)
