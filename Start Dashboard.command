#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo 'Install Node.js 22 or newer from https://nodejs.org, then open Start Dashboard.command again.'
  exit 1
fi
node manage.mjs start
open 'http://127.0.0.1:47831/'
