#!/usr/bin/env python3
# IPv4-only HTTP proxy, for the PO-token sidecar.
#
# Two problems this solves at once (both measured 2026-08-20):
#   1. gost's egress goes over IPv6 whenever the name has AAAA records
#      (api64.ipify answered 2a09:bac5:... through http://, socks5:// and
#      socks5h:// alike from inside this container), but yt-dlp takes the IPv4
#      exit - and a GVS PO token is only honoured when minted from the SAME
#      address that later fetches the media. gost 2.12 (v2) cannot prefer v4.
#   2. The sidecar's HTTP client (axios) does NOT use CONNECT for https - it
#      sends the request in absolute-form over the plain proxy connection
#      ("POST https://... HTTP/1.1") and expects the proxy to do the TLS leg.
# So: CONNECT is tunnelled, absolute-form is replayed to the origin over TLS -
# and every upstream dial resolves A records only. Egress still rides the WARP
# tunnel like everything else in this container.

import os
import socket
import ssl
import threading

PORT = int(os.environ.get("CONNECT4_PORT", "1081"))
CONNECT_TIMEOUT = 15


def log(msg: str) -> None:
    print(f"[connect4] {msg}", flush=True)


def dial_v4(host: str, port: int):
    infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    err = None
    for info in infos:
        try:
            return socket.create_connection(info[4], CONNECT_TIMEOUT)
        except OSError as exc:
            err = exc
    raise OSError(f"no IPv4 route to {host}:{port}: {err}")


def pump(src, dst) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def read_head(client) -> tuple[bytes, bytes] | None:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = client.recv(65536)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > 1 << 20:
            return None
    head, rest = buf.split(b"\r\n\r\n", 1)
    return head, rest


def do_connect(client, target: str, rest: bytes) -> None:
    host, _, port_s = target.rpartition(":")
    host = host.strip("[]")
    peer = dial_v4(host, int(port_s))
    log(f"CONNECT {host}:{port_s} -> {peer.getpeername()[0]} ok")
    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    if rest:
        peer.sendall(rest)
    client.settimeout(None)
    peer.settimeout(None)
    try:
        t = threading.Thread(target=pump, args=(peer, client), daemon=True)
        t.start()
        pump(client, peer)
        t.join()
    finally:
        peer.close()


def do_absolute(client, method: str, url: str, version: str,
                header_lines: list[str], rest: bytes) -> None:
    scheme, _, hostpath = url.partition("://")
    hostport, slash, path = hostpath.partition("/")
    path = slash + path or "/"
    host, _, port_s = hostport.rpartition(":") if ":" in hostport else (hostport, "", "")
    port = int(port_s) if port_s else (443 if scheme == "https" else 80)

    headers = []
    body_len = 0
    have_host = False
    for line in header_lines:
        name = line.split(":", 1)[0].strip().lower()
        if name in ("proxy-connection", "connection", "proxy-authorization"):
            continue
        if name == "content-length":
            body_len = int(line.split(":", 1)[1].strip())
        if name == "host":
            have_host = True
        headers.append(line)
    if not have_host:
        headers.insert(0, f"Host: {hostport}")
    headers.append("Connection: close")

    body = rest
    while len(body) < body_len:
        chunk = client.recv(65536)
        if not chunk:
            raise OSError("client closed mid-body")
        body += chunk

    peer = dial_v4(host, port)
    try:
        if scheme == "https":
            ctx = ssl.create_default_context()
            peer = ctx.wrap_socket(peer, server_hostname=host)
        log(f"{method} {scheme}://{hostport}{path.split('?')[0]} -> {peer.getpeername()[0]} ok")
        req = f"{method} {path} {version}\r\n" + "\r\n".join(headers) + "\r\n\r\n"
        peer.sendall(req.encode("latin-1") + body)
        peer.settimeout(120)
        pump(peer, client)
    finally:
        peer.close()


def handle(client) -> None:
    try:
        client.settimeout(60)
        got = read_head(client)
        if got is None:
            return
        head, rest = got
        lines = head.decode("latin-1", "replace").split("\r\n")
        parts = lines[0].split()
        if len(parts) != 3:
            client.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        method, target, version = parts
        if method.upper() == "CONNECT":
            do_connect(client, target, rest)
        elif target.startswith(("http://", "https://")):
            do_absolute(client, method, target, version, lines[1:], rest)
        else:
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
    except socket.gaierror as exc:
        log(f"FAIL resolve: {exc}")
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
    except (OSError, ValueError) as exc:
        log(f"FAIL: {exc}")
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", PORT))
    srv.listen(64)
    log(f"listening on :{PORT}, IPv4-only dial, CONNECT + absolute-form")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
