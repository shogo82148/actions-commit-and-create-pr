#!/usr/bin/env bash

set -ue
set -o pipefail

if [[ ${RUNNER_DEBUG:-} = '1' ]]; then
    set -x
fi

# check whether there is any changes.
git add .
if git diff --cached --exit-code --quiet; then
    echo "No changes to commit." 2>&1
    exit
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# additions
git diff -z --name-only --cached --no-renames --diff-filter=d | \
    xargs -0 -n1 bash -c \
    "git show \":0:\$0\" | jq --arg path \"\$0\" --raw-input --slurp --compact-output '{ path: \$path, contents: @base64 }'" \
    > "$TMPDIR/additions.txt"

# deletions
git diff -z --name-only --cached --no-renames --diff-filter=D | \
    jq --raw-input --slurp 'split("\u0000")' \
    > "$TMPDIR/deletions.txt"

: "${INPUT_HEAD_BRANCH:=actions-commit-and-create-pr/$(date -u '+%Y-%m-%d')-${GITHUB_RUN_NUMBER}}"
export INPUT_HEAD_BRANCH

COMMIT_URL=$(jq --null-input \
    --slurpfile additions "$TMPDIR/additions.txt" \
    --slurpfile deletions "$TMPDIR/deletions.txt" \
    --arg expectedHeadOid "$(git rev-parse HEAD)" \
    --arg query 'mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
            commit { url }
        }
    }' \
    --arg message 'make temporary directory' \
    '{
        query: $query,
        variables: {
            input: {
                branch: {
                    repositoryNameWithOwner: env.GITHUB_REPOSITORY,
                    branchName: env.INPUT_HEAD_BRANCH,
                },
                fileChanges: {
                    additions: $additions,
                    deletions: $deletions[0]
                },
                expectedHeadOid: $expectedHeadOid,
                message: {
                    headline: $message
                }
            }
        }
    }' | \
    gh api graphql --input - --jq '.data.createCommitOnBranch.commit.url'
)

echo "::set-output name=commit-url::$COMMIT_URL"

git reset HEAD

PR_URL=$(gh pr create --title "The bug is fixed" --body "Everything works again" --base "$INPUT_BASE_BRANCH" --head "$INPUT_HEAD_BRANCH")
echo "::set-output name=pr-url::$PR_URL"
