#!/bin/sh
# Builds the firmware encoder harness (from the firmware sources, read-only) and runs the
# encoder / decoder tests. Usage: test/run-tests.sh <firmware's examples/companion_radio/ui-minitel>
# (or FW_DIR=... in the environment)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
FW=${1:-$FW_DIR}
if [ -z "$FW" ] || [ ! -f "$FW/MinitelScreen.cpp" ]; then
  echo "usage: $0 <path to the firmware's ui-minitel directory>" >&2
  exit 2
fi
mkdir -p "$HERE/.build"
g++ -O1 -std=c++17 -I"$FW" -o "$HERE/.build/fw_harness" "$HERE/fw_harness.cpp" \
  "$FW/MinitelScreen.cpp" "$FW/MinitelCharset.cpp" "$FW/MinitelEmoji.cpp"
node "$HERE/encoder-test.js" "$HERE/.build/fw_harness"
