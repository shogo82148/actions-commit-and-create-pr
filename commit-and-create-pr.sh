#!/usr/bin/env bash

set -ue
set -o pipefail

if [[ ${RUNNER_DEBUG:-} = '1' ]]; then
    set -x
fi

# check whether there is any changes.
git add .
if git diff --cached --exit-code --quiet; then
    echo "No changes to commit." >&2
    exit
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# additions
git diff -z --name-only --cached --no-renames --diff-filter=d | \
    xargs -0 -n1 bash -c \
    "git show \":0:\$0\" | base64 -w 0 | jq --arg path \"\$0\" --raw-input --slurp --compact-output '{ path: \$path, contents: . }'" \
    > "$TMPDIR/additions.txt"

# deletions
git diff -z --name-only --cached --no-renames --diff-filter=D | \
    jq --raw-input --slurp 'split("\u0000") | .[] | { path: . }' \
    > "$TMPDIR/deletions.txt"

SHA_BEFORE=$(git rev-parse HEAD)

# set the default value if they are not configured.
: "${INPUT_HEAD_BRANCH:=${INPUT_HEAD_BRANCH_PREFIX:-actions-commit-and-create-pr/}$(date -u '+%Y-%m-%d')-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT}"
export INPUT_HEAD_BRANCH
: "${INPUT_COMMIT_MESSAGE:=Auto updates by the $GITHUB_WORKFLOW workflow}"

# create a branch
jq --null-input \
    --arg query 'mutation ($input: CreateRefInput!) {
        createRef(input: $input) {
            clientMutationId
        }
    }' \
    --arg branch "refs/heads/$INPUT_HEAD_BRANCH" \
    --arg repositoryId "$(gh repo view --json id --jq '.id')"\
    --arg oid "$SHA_BEFORE" \
    '{
        query: $query,
        variables: {
            input: {
                repositoryId: $repositoryId,
                name: $branch,
                oid: $oid
            }
        }
    }' \
    > "$TMPDIR/query-create-branch.txt"

: show the query for debugging
if [[ ${RUNNER_DEBUG:-} = '1' ]]; then
    cat "$TMPDIR/query-create-branch.txt" >&2
fi

: "$(gh api graphql --input "$TMPDIR/query-create-branch.txt")"

# create a commit
jq --null-input \
    --slurpfile additions "$TMPDIR/additions.txt" \
    --slurpfile deletions "$TMPDIR/deletions.txt" \
    --arg expectedHeadOid "$SHA_BEFORE" \
    --arg query 'mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
            commit { url }
        }
    }' \
    --arg message "${INPUT_COMMIT_MESSAGE}" \
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
                    deletions: $deletions
                },
                expectedHeadOid: $expectedHeadOid,
                message: {
                    headline: $message
                }
            }
        }
    }' \
    > "$TMPDIR/query-create-commit.txt"

: show the query for debugging
if [[ ${RUNNER_DEBUG:-} = '1' ]]; then
    cat "$TMPDIR/query-create-commit.txt" >&2
fi
COMMIT_URL=$(gh api graphql --input "$TMPDIR/query-create-commit.txt" --jq '.data.createCommitOnBranch.commit.url')

git reset HEAD > /dev/null 2>&1

cat <<__END_OF_BODY__ > "$TMPDIR/pr-body.txt"
${INPUT_BODY:-$INPUT_COMMIT_MESSAGE}

-----

This pull request is generated by the $GITHUB_WORKFLOW workflow. [See the log]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT).
__END_OF_BODY__

: the the pull request body for debugging
if [[ ${RUNNER_DEBUG:-} = '1' ]]; then
    cat "$TMPDIR/pr-body.txt" >&2
fi

PR_URL=$(gh pr create --title "${INPUT_TITLE:-$INPUT_COMMIT_MESSAGE}" --body-file "$TMPDIR/pr-body.txt" --base "$INPUT_BASE_BRANCH" --head "$INPUT_HEAD_BRANCH")

if [[ -f "${GITHUB_OUTPUT:-}" ]]; then
cat <<__END_OF_OUTPUT__ >> "$GITHUB_OUTPUT"
commit-url=$COMMIT_URL
pr-url=$PR_URL
__END_OF_OUTPUT__
else
echo "::set-output name=commit-url::$COMMIT_URL"
echo "::set-output name=pr-url::$PR_URL"
fi
