#!/usr/bin/env bash

set -ue
set -o pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git add .

# addtions
git diff -z --name-only --cached --no-renames --diff-filter=d | \
    xargs -0 -n1 sh -c \
    "git show \":0:\$0\" | jq --arg path \"\$0\" --raw-input --slurp --compact-output '{ path: \$path, contents: @base64 }'" \
    > "$TMPDIR/additions.txt"

# deletions
git diff -z --name-only --cached --no-renames --diff-filter=D | \
    jq --raw-input --slurp 'split("\u0000")' \
    > "$TMPDIR.deletions.txt"

jq --null-input \
    --slurpfile additions "$TMPDIR/additions.txt" \
    --slurpfile deletions "$TMPDIR.deletions.txt" \
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
                    repositoryNameWithOwner: "shogo82148/actions-commit-and-create-pr",
                    branchName: "main"
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
