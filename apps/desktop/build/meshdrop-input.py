#!/usr/bin/env python3
# MeshDrop remote input (M10): drives the XDG RemoteDesktop portal, which works on GNOME Wayland.
# Reads JSON lines on stdin:
#   {"t":"move","dx":1.5,"dy":-2}            relative pointer motion
#   {"t":"button","button":272,"down":true}  evdev button code (BTN_LEFT 272, RIGHT 273, MIDDLE 274)
#   {"t":"axis","dx":0,"dy":3}               smooth scroll (positive dy scrolls down)
#   {"t":"key","keysym":65293,"down":true}   X keysym
# Writes JSON lines: {"ready":true} once the session runs, {"error":"..."} on failure.
# The first start shows GNOME's "Allow remote interaction" dialog; the restore token in argv[1]
# (a file) lets later starts skip it.
import json
import os
import sys
import threading

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

BUS = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.RemoteDesktop"
TOKEN_FILE = sys.argv[1] if len(sys.argv) > 1 else None

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
session = None
counter = [0]


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(msg):
    out({"error": msg})
    os._exit(1)


def request(method, args, on_done):
    """Calls a portal method that answers with a Request; on_done(results) on success."""
    counter[0] += 1
    token = "meshdrop%d_%d" % (os.getpid(), counter[0])
    sender = bus.get_unique_name()[1:].replace(".", "_")
    req_path = "/org/freedesktop/portal/desktop/request/%s/%s" % (sender, token)

    def on_response(_c, _s, _p, _i, _sig, params):
        bus.signal_unsubscribe(sub[0])
        code, results = params.unpack()
        if code != 0:
            fail("the remote control request was declined" if code == 1 else "the portal refused (%d)" % code)
        on_done(results)

    sub = [bus.signal_subscribe(BUS, "org.freedesktop.portal.Request", "Response", req_path, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)]
    opts = dict(args[-1])
    opts["handle_token"] = GLib.Variant("s", token)
    params = args[:-1] + [opts]
    sig = {"CreateSession": "(a{sv})", "SelectDevices": "(oa{sv})", "Start": "(osa{sv})"}[method]
    try:
        bus.call_sync(BUS, PATH, IFACE, method, GLib.Variant(sig, tuple(params)), None, Gio.DBusCallFlags.NONE, -1, None)
    except GLib.Error as e:
        fail("portal: %s" % e.message)


def notify(method, sig, *args):
    try:
        bus.call_sync(BUS, PATH, IFACE, method, GLib.Variant(sig, (session, {}) + args), None, Gio.DBusCallFlags.NONE, -1, None)
    except GLib.Error as e:
        out({"error": "input: %s" % e.message})


def handle(line):
    try:
        m = json.loads(line)
    except ValueError:
        return False
    t = m.get("t")
    if t == "move":
        notify("NotifyPointerMotion", "(oa{sv}dd)", float(m.get("dx", 0)), float(m.get("dy", 0)))
    elif t == "button":
        notify("NotifyPointerButton", "(oa{sv}iu)", int(m["button"]), 1 if m.get("down") else 0)
    elif t == "axis":
        dx, dy = float(m.get("dx", 0)), float(m.get("dy", 0))
        try:
            bus.call_sync(BUS, PATH, IFACE, "NotifyPointerAxis", GLib.Variant("(oa{sv}dd)", (session, {"finish": GLib.Variant("b", True)}, dx, dy)), None, Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error as e:
            out({"error": "input: %s" % e.message})
    elif t == "key":
        notify("NotifyKeyboardKeysym", "(oa{sv}iu)", int(m["keysym"]), 1 if m.get("down") else 0)
    return False


def read_stdin():
    for line in sys.stdin:
        GLib.idle_add(handle, line)
    GLib.idle_add(loop.quit)


def started(results):
    token = results.get("restore_token")
    if TOKEN_FILE and token:
        with open(TOKEN_FILE, "w") as f:
            f.write(token)
    out({"ready": True})
    threading.Thread(target=read_stdin, daemon=True).start()


def selected(_results):
    request("Start", [session, "", {}], started)


def created(results):
    global session
    session = results["session_handle"]
    opts = {"types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
    if TOKEN_FILE and os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            opts["restore_token"] = GLib.Variant("s", tok)
    request("SelectDevices", [session, opts], selected)


request("CreateSession", [{"session_handle_token": GLib.Variant("s", "meshdropsession%d" % os.getpid())}], created)
loop.run()
