#!/usr/bin/env bash

# delete the branch created by the test.
# usage: cleanup.sh BRANCH

set -ue

BRANCH=$1

ERRORS=$(mktemp)
trap 'rm -f "$ERRORS"' EXIT

# delete the branch in a single request, without checking its existence beforehand,
# so that there is no race between the check and the deletion.
if RESPONSE=$(gh api --include --method DELETE "repos/$GITHUB_REPOSITORY/git/refs/heads/$BRANCH" 2>"$ERRORS"); then
    echo "deleted the branch $BRANCH."
    exit 0
fi

# the first line of the response is the status line, e.g. "HTTP/2.0 422 Unprocessable Entity".
# it is empty if the request didn't reach GitHub (e.g. network errors).
STATUS=$(printf '%s\n' "$RESPONSE" | head -n 1 | awk '{ print $2 }')
# the body follows the headers and an empty line.
MESSAGE=$(printf '%s\n' "$RESPONSE" | sed '1,/^\r\{0,1\}$/d' | jq -r '.message // empty' 2>/dev/null || true)

# the branch may not exist if the test failed before creating it,
# or if someone else deleted it. GitHub returns 422 "Reference does not exist" in that case.
if [[ "$STATUS" = "422" && "$MESSAGE" = "Reference does not exist" ]]; then
    echo "the branch $BRANCH does not exist. nothing to do."
    exit 0
fi

echo "::error::failed to delete the branch $BRANCH (status: ${STATUS:-none})"
cat "$ERRORS" >&2
printf '%s\n' "$RESPONSE" >&2
exit 1
