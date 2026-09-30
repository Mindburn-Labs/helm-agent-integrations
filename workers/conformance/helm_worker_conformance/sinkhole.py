"""Evidence of network egress attempts.

The worker runs on a Docker network with no route out. Its DNS server is this sinkhole, which
answers every name it is asked about with its own address and logs the question; the TCP traps
on ports 80 and 443 log any connection that follows (with the Host header or TLS server name).
So a worker that tries to reach anything but the stub hostnames leaves a record, even though the
connection could not have left the network anyway.
"""

from __future__ import annotations

import socket
import struct
import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class SinkEvent:
    t: float
    kind: str  # dns | tcp
    detail: str

    def __str__(self) -> str:
        return f"{self.kind}: {self.detail}"


def _qname(data: bytes) -> tuple[str, int, int]:
    """(name, qtype, offset just past the question) of the first question in a DNS packet."""
    i, labels = 12, []
    while data[i] != 0:
        length = data[i]
        labels.append(data[i + 1 : i + 1 + length].decode("ascii", "replace"))
        i += length + 1
    qtype = struct.unpack(">H", data[i + 1 : i + 3])[0]
    return ".".join(labels), qtype, i + 5


def tls_server_name(data: bytes) -> str | None:
    """The SNI of a TLS ClientHello, or None when `data` is not one."""
    try:
        if data[0] != 0x16 or data[5] != 0x01:
            return None
        i = 43  # record(5) + handshake(4) + version(2) + random(32)
        i += 1 + data[i]  # session id
        i += 2 + struct.unpack(">H", data[i : i + 2])[0]  # cipher suites
        i += 1 + data[i]  # compression methods
        end = i + 2 + struct.unpack(">H", data[i : i + 2])[0]
        i += 2
        while i + 4 <= end:
            kind, length = struct.unpack(">HH", data[i : i + 4])
            if kind == 0:  # server_name
                name_length = struct.unpack(">H", data[i + 7 : i + 9])[0]
                return data[i + 9 : i + 9 + name_length].decode("ascii", "replace")
            i += 4 + length
    except (IndexError, struct.error):
        pass
    return None


def http_host(data: bytes) -> str | None:
    for line in data.split(b"\r\n")[1:]:
        if line.lower().startswith(b"host:"):
            return line[5:].strip().decode("ascii", "replace")
    return None


class Sinkhole:
    def __init__(
        self,
        answer_ip: str,
        bind: str = "0.0.0.0",  # noqa: S104 - the stub must be reachable from the worker
        dns_port: int = 53,
        tcp_ports: tuple[int, ...] = (80, 443),
    ) -> None:
        self.answer_ip = answer_ip
        self.bind = bind
        self.dns_port = dns_port
        self.tcp_ports = tcp_ports
        self.events: list[SinkEvent] = []
        self._lock = threading.Lock()
        self._sockets: list[socket.socket] = []
        self._closed = threading.Event()

    def _log(self, kind: str, detail: str) -> None:
        with self._lock:
            self.events.append(SinkEvent(time.monotonic(), kind, detail))

    def start(self) -> None:
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        udp.bind((self.bind, self.dns_port))
        self._sockets.append(udp)
        threading.Thread(target=self._dns_loop, args=(udp,), daemon=True, name="sink-dns").start()
        for port in self.tcp_ports:
            tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            tcp.bind((self.bind, port))
            tcp.listen(16)
            self._sockets.append(tcp)
            threading.Thread(
                target=self._tcp_loop, args=(tcp, port), daemon=True, name=f"sink-{port}"
            ).start()

    def stop(self) -> None:
        self._closed.set()
        for sock in self._sockets:
            try:
                sock.close()
            except OSError:
                pass

    def _dns_loop(self, sock: socket.socket) -> None:
        while not self._closed.is_set():
            try:
                data, peer = sock.recvfrom(512)
            except OSError:
                return
            try:
                name, qtype, end = _qname(data)
            except (IndexError, struct.error):
                continue
            self._log("dns", f"{name} type={qtype}")
            question = data[12:end]
            if qtype == 1:
                answer = (
                    b"\xc0\x0c"
                    + struct.pack(">HHIH", 1, 1, 5, 4)
                    + socket.inet_aton(self.answer_ip)
                )
                header = data[:2] + b"\x81\x80" + struct.pack(">HHHH", 1, 1, 0, 0)
                reply = header + question + answer
            else:  # NOERROR with no data, so AAAA lookups fall back to A
                reply = data[:2] + b"\x81\x80" + struct.pack(">HHHH", 1, 0, 0, 0) + question
            try:
                sock.sendto(reply, peer)
            except OSError:
                return

    def _tcp_loop(self, listener: socket.socket, port: int) -> None:
        while not self._closed.is_set():
            try:
                conn, peer = listener.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(1.0)
                try:
                    data = conn.recv(2048)
                except OSError:
                    data = b""
                target = tls_server_name(data) or http_host(data) or "no hostname"
                self._log("tcp", f"connection to port {port} from {peer[0]} ({target})")

    def offending(self) -> list[SinkEvent]:
        """Every logged attempt except reverse lookups, which resolvers make on their own."""
        with self._lock:
            return [
                e
                for e in self.events
                if not (e.kind == "dns" and (".arpa " in e.detail or e.detail.endswith("type=12")))
            ]
