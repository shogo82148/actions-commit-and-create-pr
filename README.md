# Commit and Create a Pull Request Action

## Synopsis

```yaml
name: auto update
on:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: make some changes
        run: ': do something'

      - id: commit and create a pull request
        uses: shogo82148/actions-commit-and-create-pr@v1
```

## Inputs

### github-token

The GitHub Token. The default is `${{ github.token }}`

### base-branch

The base branch. The default is the branch name that triggered the workflow run. ( `${{ github.ref_name }}` )

### head-branch:

The head branch.

### title

The title of pull requests.

### body

The body of a pull request.

### commit-message:

The commit message.

## Related Works

- [Create Pull Request](https://github.com/marketplace/actions/create-pull-request) Action

## See Also

- [A simpler API for authoring commits](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- [GitHub GraphQL APIで新しいブランチを作成する](https://int128.hatenablog.com/entry/2020/01/15/165432)
