#!/usr/bin/env python3
"""Rotate/health control surface for the WARP SOCKS5 proxy.

WHY THIS EXISTS. WARP exit addresses are shared Cloudflare IPs. Ours is not a
residential address and YouTube knows it - it is simply treated far better than
the Hetzner range the host sits in. That means an exit CAN pick up the "Sign in
to confirm you're not a bot" check through no fault of ours, when enough other
people hammer YouTube from the same address. The cure takes about a second, but
only `warp-cli` inside this container can apply it, and the callers that need it
(bot, worker-download) must not be handed a docker socket to reach it.

FOUR PROPERTIES, none of them decoration:

  SERIALIZED - rotation is a global side effect. It drops every connection
  through the proxy, including other jobs' downloads. Two callers failing at the
  same moment must cause ONE rotation, not two.

  COALESCED - a caller arriving while a rotation is already running waits for it
  and is told about THAT rotation rather than starting a second one. By the time
  it wakes up its own request is already satisfied.

  COOLDOWN - a blocked exit produces a BURST of failures, so a naive "rotate on
  failure" turns one bad address into a rotation storm and takes every running
  download down with it. Inside the cooldown the answer is "no, and here is the
  address you already have"; the caller retries against it.

  VERIFIED - `disconnect && connect` very often hands back the SAME exit. A
  rotation that did not move the address is worse than no rotation at all: the
  caller retries into the identical block while believing it got a fresh IP. So
  the address is read before and after, and if it did not move we escalate to a
  full re-registration, which does move it.

The port is never published to the host - only the compose network reaches it.
"""

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WARP_CONTROL_PORT", "8080"))
# Measured THROUGH the proxy, not from the container: what matters is the
# address yt-dlp gets. Reading it any other way can report a healthy tunnel
# while the proxy path itself is broken.
SOCKS = os.environ.get("WARP_SOCKS", "127.0.0.1:1080")
COOLDOWN_SEC = float(os.environ.get("WARP_ROTATE_COOLDOWN_SEC", "30"))
# Generous enough for the reconnect attempts AND the re-registration behind
# them. A bot user is waiting on this, so the cheap path is tried first and
# usually answers in seconds; the deadline only bounds the worst case.
ROTATE_DEADLINE_SEC = float(os.environ.get("WARP_ROTATE_DEADLINE_SEC", "75"))
RECONNECT_ATTEMPTS = int(os.environ.get("WARP_RECONNECT_ATTEMPTS", "3"))
IP_CHECK_URL = os.environ.get("WARP_IP_CHECK_URL", "https://api.ipify.org")

_lock = threading.Lock()
_last_rotation_at = 0.0
_last_result: dict | None = None


def egress_ip(timeout: int = 10) -> str | None:
    """The address a CLIENT of this proxy currently gets, or None."""
    try:
        out = subprocess.run(
            [
                "curl", "-s", "--max-time", str(timeout),
                "--socks5-hostname", SOCKS, IP_CHECK_URL,
            ],
            capture_output=True, text=True, timeout=timeout + 5,
        )
    except Exception:
        return None
    ip = out.stdout.strip()
    # An error page or an HTML body is not an address. 45 chars covers IPv6.
    return ip if ip and len(ip) <= 45 and " " not in ip else None


def warp(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["warp-cli", "--accept-tos", *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _await_change(previous: str | None, deadline: float) -> str | None:
    """Poll the proxy until it answers with an address that is not `previous`.

    Returns whatever it last saw when the deadline passes, so the caller can
    tell "did not move" from "cannot be read at all"."""
    last = None
    while time.monotonic() < deadline:
        last = egress_ip()
        if last and last != previous:
            return last
        time.sleep(1)
    return last


def _rotate_locked() -> dict:
    """Runs under _lock. Cheap reconnects first, re-registration only if needed.

    Both steps are shaped by what was actually measured against this image:

      A reconnect lands on a different Cloudflare edge only SOMETIMES - 1 of 3
      cycles in the first run - because the exit is anycast and usually resolves
      back to the same nearest PoP. So it is RETRIED, not attempted once. A
      single attempt reports "could not rotate" for something that works most of
      the time within a few seconds.

      `registration new` on its own FAILS: "Old registration is still around.
      Try running: warp-cli registration delete". The delete is not optional
      politeness, it is the difference between escalation working and escalation
      being a no-op that silently leaves the blocked exit in place.
    """
    previous = egress_ip()
    deadline = time.monotonic() + ROTATE_DEADLINE_SEC

    for _ in range(RECONNECT_ATTEMPTS):
        if time.monotonic() >= deadline:
            break
        warp("disconnect")
        time.sleep(1)
        warp("connect")
        current = _await_change(previous, min(deadline, time.monotonic() + 8))
        if current and current != previous:
            return {
                "rotated": True,
                "escalated": False,
                "previousIp": previous,
                "ip": current,
                "at": time.time(),
            }

    # Reconnecting kept landing on the same edge. A fresh registration moves it.
    warp("registration", "delete", timeout=30)
    warp("registration", "new", timeout=45)
    warp("connect")
    current = _await_change(previous, deadline)

    return {
        "rotated": bool(current and current != previous),
        "escalated": True,
        "previousIp": previous,
        "ip": current,
        "at": time.time(),
    }


def rotate() -> dict:
    global _last_rotation_at, _last_result
    requested_at = time.monotonic()

    with _lock:
        # Coalesce: a rotation finished while we queued, so it is already ours.
        if _last_result is not None and _last_rotation_at >= requested_at:
            return {**_last_result, "coalesced": True}

        since = time.monotonic() - _last_rotation_at
        if _last_rotation_at > 0 and since < COOLDOWN_SEC:
            return {
                "rotated": False,
                "reason": "cooldown",
                "cooldownRemainingSec": round(COOLDOWN_SEC - since, 1),
                "ip": egress_ip(),
            }

        result = _rotate_locked()
        _last_rotation_at = time.monotonic()
        _last_result = result
        return result


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("", "/health"):
            self._send(404, {"error": "not found"})
            return
        ip = egress_ip()
        # Unreachable proxy is a 503 so compose's healthcheck fails on it
        # rather than reporting a proxy that answers but cannot reach anything.
        self._send(200 if ip else 503, {"ok": bool(ip), "ip": ip})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/rotate":
            self._send(404, {"error": "not found"})
            return
        try:
            self._send(200, rotate())
        except Exception as exc:  # never take the proxy down over a rotation
            self._send(500, {"rotated": False, "error": str(exc)})

    def log_message(self, fmt: str, *args) -> None:
        print("[warp-control] " + (fmt % args), flush=True)


if __name__ == "__main__":
    print(f"[warp-control] listening on :{PORT}, socks {SOCKS}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
