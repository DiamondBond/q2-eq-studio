#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 the q2-filebrowser authors (internal/LICENSE)
# From q2-filebrowser's contrib/shanlingq2/build.sh (github.com/group-a-study/q2-filebrowser).
#
# EQ Studio for the Shanling Q2: static Go for 32-bit little-endian MIPS with soft float, staged with
# its card files in dist/.eq-studio and zipped as a release ships it, dist/eq-studio.zip, to unzip at
# the card's root (or for the App Store to install). Needs Go 1.22 or later and python3.
set -eu
cd "$(dirname "$0")"
R=dist/.eq-studio
rm -rf dist
mkdir -p "$R"
CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$R/q2-eq-studio" .
cp card/run card/q2app card/icon.png card/icon-40.png data/presets.json.gz data/AUTOEQ-LICENSE.txt "$R/"
chmod 755 "$R/q2-eq-studio" "$R/run"
chmod 644 "$R/q2app" "$R/icon.png" "$R/icon-40.png" "$R/presets.json.gz" "$R/AUTOEQ-LICENSE.txt"
python3 -I tools/package.py "$R" dist/eq-studio.zip
