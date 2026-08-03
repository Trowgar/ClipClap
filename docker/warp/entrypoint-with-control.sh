#!/bin/bash
# Start the control server beside the stock entrypoint.
#
# The base /entrypoint.sh ends with `gost` in the FOREGROUND - it is the
# container's main process and must stay that way, so the control server goes to
# the background and the original is exec'd. A control server that crashed must
# never take the proxy with it: losing rotation is an inconvenience, losing the
# proxy stops every download.
set -e

python3 -u /usr/local/bin/warp-control.py &

exec /entrypoint.sh
