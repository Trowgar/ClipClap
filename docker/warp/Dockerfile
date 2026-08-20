# WARP SOCKS5 proxy for yt-dlp, plus a rotate/health control surface.
#
# The base image is unmodified: it registers a WARP client, connects, and ends
# with `gost` holding the SOCKS5 port in the foreground. We only add a small
# control server beside it (see control.py for why it has to live in HERE and
# not in the app containers).
FROM caomingjun/warp:latest

# --chmod on the COPY, not a RUN chmod: the base image drops to a non-root user
# (its own entrypoint reaches for sudo), so a build-time chmod fails with
# "Operation not permitted".
COPY --chmod=755 control.py /usr/local/bin/warp-control.py
COPY --chmod=755 connect4.py /usr/local/bin/connect4.py
COPY --chmod=755 entrypoint-with-control.sh /usr/local/bin/entrypoint-with-control.sh

ENTRYPOINT ["/usr/local/bin/entrypoint-with-control.sh"]
