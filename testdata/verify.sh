#!/usr/bin/env bash

# verify that the action checked out the commit, and the commit has the same tree as the local changes.
# usage: verify.sh COMMIT_SHA HEAD_BRANCH

set -ue

SHA=$1
BRANCH=$2

CURRENT=$(cd "$(dirname "$0")" && pwd)
cd "$CURRENT/.."

# the action should check out the commit.
HEAD_SHA=$(git rev-parse HEAD)
if [[ "$HEAD_SHA" != "$SHA" ]]; then
    echo "::error::HEAD is not the commit. expected: $SHA, actual: $HEAD_SHA"
    exit 1
fi
CURRENT_BRANCH=$(git symbolic-ref --quiet --short HEAD || true)
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    echo "::error::the current branch is not the head branch. expected: $BRANCH, actual: ${CURRENT_BRANCH:-(detached)}"
    exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
    echo "::error::the working tree is not clean after the checkout."
    git status
    exit 1
fi
echo "checkout is OK."

git add --all .
EXPECTED_TREE=$(git write-tree)
git reset --quiet HEAD

ACTUAL_TREE=$(gh api "repos/$GITHUB_REPOSITORY/git/commits/$SHA" --jq '.tree.sha')
if [[ "$EXPECTED_TREE" != "$ACTUAL_TREE" ]]; then
    echo "::error::tree is not matched. expected: $EXPECTED_TREE, actual: $ACTUAL_TREE"
    gh api "repos/$GITHUB_REPOSITORY/git/trees/$ACTUAL_TREE?recursive=1" --jq '.tree[] | "\(.mode) \(.type) \(.sha) \(.path)"'
    exit 1
fi
echo "tree is OK."

VERIFIED=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA" --jq '.commit.verification.verified')
if [[ "$VERIFIED" != "true" ]]; then
    echo "::error::the commit $SHA is not verified."
    exit 1
fi
echo "signature is OK."
