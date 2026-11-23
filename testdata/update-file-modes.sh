#!/usr/bin/env bash

set -uex

CURRENT=$(cd "$(dirname "$0")" && pwd)
cd "$CURRENT"

# make an existing file executable
chmod +x 'make-me-executable.txt'

# add a new executable file
printf '#!/bin/sh\necho hello\n' > 'new-executable.sh'
chmod +x 'new-executable.sh'

# add a symbolic link
ln -s 'update-me.txt' 'symlink'

# add a submodule
git init --quiet 'submodule'
git -C 'submodule' -c user.name=test -c user.email=test@example.com \
    commit --quiet --allow-empty -m 'init'
