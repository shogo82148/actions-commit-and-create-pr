#!/usr/bin/env bash

set -ue

PR_URL=$1

CURRENT=$(cd "$(dirname "$0")" && pwd)
cd "$CURRENT"

if diff expected.diff <(gh pr diff "$PR_URL"); then
    echo "diff is OK."
else
    echo "::error::diff is not matched."
    exit 1
fi
