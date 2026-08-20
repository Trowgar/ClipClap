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

# The PO-token sidecar minted from the wrong egress family through gost, so it
# uses this IPv4-only CONNECT listener instead (see connect4.py). A crash here
# must never take gost down, but the sidecar depends on the listener - hence a
# supervised restart loop rather than a bare background job.
(while true; do
  python3 -u /usr/local/bin/connect4.py
  echo "[connect4] exited; restarting in 1s"
  sleep 1
done) &

exec /entrypoint.sh
