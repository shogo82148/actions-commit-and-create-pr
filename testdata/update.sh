#!/usr/bin/env bash

set -uex

CURRENT=$(cd "$(dirname "$0")" && pwd)
cd "$CURRENT"

rm '"please delete me".txt'
mv 'rename-me.txt' 'renamed!.txt'
echo 'UPDATED!!' >> 'update-me.txt'
echo "it's a brand new file" > '"new file".txt'
