#!/usr/bin/env python3
# A stand-in for build/meshdrop-bt.py: the same stdin/stdout and bridge protocol, no BlueZ.
# Dials to "AA:AA:AA:AA:AA:AA" connect and echo; others fail. The first "bonded" request also opens
# an incoming connection from "CC:CC:CC:CC:CC:CC" that says "hi". "DD:DD:DD:DD:DD:DD" plays its sound here
# as Bluetooth audio until an "audio-stop" for it; an "audio-start" makes that address play here. The
# adapter searches for devices from the start.
import json
import socket
import sys
import threading

BRIDGE = sys.argv[1]


def out(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def connect(head):
    u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    u.connect(BRIDGE)
    u.sendall((json.dumps(head) + "\n").encode())
    return u


def echo(u):
    while True:
        b = u.recv(65536)
        if not b:
            break
        u.sendall(b)
    u.close()


out({"ready": True})
out({"audio": [{"address": "DD:DD:DD:DD:DD:DD", "name": "Phone"}]})
out({"scanning": True})
for line in sys.stdin:
    req = json.loads(line)
    if req["t"] == "bonded":
        out({"id": req["id"], "bonded": [{"address": "AA:AA:AA:AA:AA:AA", "name": "Phone"}]})
        u = connect({"address": "CC:CC:CC:CC:CC:CC"})
        u.sendall(b"hi")
        threading.Thread(target=echo, args=(u,), daemon=True).start()
    elif req["t"] == "dial":
        if req["address"] == "AA:AA:AA:AA:AA:AA":
            threading.Thread(target=echo, args=(connect({"address": req["address"], "dial": req["id"]}),), daemon=True).start()
        else:
            out({"id": req["id"], "error": "Host is down"})
    elif req["t"] == "audio-stop":
        out({"id": req["id"], "ok": True})
        out({"audio": []})
    elif req["t"] == "audio-start":
        out({"id": req["id"], "ok": True})
        out({"audio": [{"address": req["address"], "name": "Phone"}]})
