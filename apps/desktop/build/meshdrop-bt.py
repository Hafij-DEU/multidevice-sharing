#!/usr/bin/env python3
# MeshDrop Bluetooth (M14): registers the MeshDrop RFCOMM profile with BlueZ and hands every
# connection to MeshDrop over a private unix socket (argv[1]). BlueZ does the pairing, the SDP
# record and the channel; MeshDrop authenticates the device itself (HELLO, then mTLS).
#
# Reads JSON lines on stdin:
#   {"t":"bonded","id":1}                    the paired phones and computers
#   {"t":"dial","id":2,"address":"AA:..."}   connect to that device's MeshDrop service
# Writes JSON lines:
#   {"ready":true}  or  {"error":"..."} (then exits)
#   {"id":1,"bonded":[{"address":"AA:...","name":"Pixel"}]}
#   {"id":2,"error":"..."}                   the dial failed (on success the connection arrives)
# Each connection opens the unix socket and starts with one JSON line, {"address":"AA:...","dial":2}
# ("dial" only for a connection this helper dialled), then carries the RFCOMM bytes both ways.
# Stops when stdin closes.
import json
import os
import socket
import sys
import threading

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

UUID = "6d657368-6472-6f70-0001-000000000001"
PROFILE_PATH = "/io/github/hafijbge/meshdrop/bt"
BRIDGE = sys.argv[1]
# Phones and PCs only: never poke headphones or keyboards.
KINDS = ("phone", "computer")

INTROSPECTION = """
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" name="device" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="properties" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" name="device" direction="in"/>
    </method>
  </interface>
</node>
"""

bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
loop = GLib.MainLoop()
out_lock = threading.Lock()
# address -> dial id, while a dial to that device is in flight
dialing = {}
# device path -> open sockets (closed on RequestDisconnection)
conns = {}


def out(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def fail(msg):
    out({"error": msg})
    os._exit(1)


def address_of(path):
    return path.rsplit("/", 1)[-1].replace("dev_", "").replace("_", ":")


def pump(src, dst):
    try:
        while True:
            b = src.recv(65536)
            if not b:
                break
            dst.sendall(b)
    except OSError:
        pass
    for s in (src, dst):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def bridge(rf, address, dial):
    try:
        u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        u.connect(BRIDGE)
        head = {"address": address}
        if dial is not None:
            head["dial"] = dial
        u.sendall((json.dumps(head) + "\n").encode())
    except OSError:
        rf.close()
        return
    a = threading.Thread(target=pump, args=(rf, u), daemon=True)
    b = threading.Thread(target=pump, args=(u, rf), daemon=True)
    a.start()
    b.start()
    a.join()
    b.join()
    rf.close()
    u.close()


def on_call(conn, sender, path, iface, method, params, invocation):
    if method == "NewConnection":
        device, index, _props = params.unpack()
        fds = invocation.get_message().get_unix_fd_list()
        try:
            fd = fds.get(index)
        except GLib.Error as e:
            invocation.return_dbus_error("org.bluez.Error.Rejected", e.message)
            return
        rf = socket.socket(fileno=fd)
        rf.setblocking(True)
        address = address_of(device)
        conns.setdefault(device, []).append(rf)
        dial = dialing.pop(address, None)
        threading.Thread(target=bridge, args=(rf, address, dial), daemon=True).start()
        invocation.return_value(None)
    elif method == "RequestDisconnection":
        (device,) = params.unpack()
        for s in conns.pop(device, []):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        invocation.return_value(None)
    else:  # Release
        invocation.return_value(None)


def objects():
    r = bus.call_sync("org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", None, None, Gio.DBusCallFlags.NONE, 10000, None)
    return r.unpack()[0]


def bonded(req):
    try:
        found = []
        for path, ifaces in objects().items():
            d = ifaces.get("org.bluez.Device1")
            if not d or not (d.get("Paired") or d.get("Bonded")):
                continue
            if UUID not in [u.lower() for u in d.get("UUIDs", [])] and d.get("Icon", "").split("-")[0] not in KINDS:
                continue
            found.append({"address": d.get("Address", address_of(path)), "name": d.get("Alias") or d.get("Name") or d.get("Address", "")})
        out({"id": req["id"], "bonded": found})
    except GLib.Error as e:
        out({"id": req["id"], "error": e.message})


def device_path(address):
    for path, ifaces in objects().items():
        d = ifaces.get("org.bluez.Device1")
        if d and d.get("Address", "").upper() == address.upper():
            return path
    return None


def dial(req):
    rid, address = req["id"], req["address"].upper()
    try:
        path = device_path(address)
    except GLib.Error as e:
        out({"id": rid, "error": e.message})
        return
    if not path:
        out({"id": rid, "error": "not paired"})
        return
    dialing[address] = rid

    def done(_bus, res):
        try:
            bus.call_finish(res)
        except GLib.Error as e:
            if dialing.get(address) == rid:
                del dialing[address]
            out({"id": rid, "error": e.message})

    # BlueZ knows the service only after it has read the phone's SDP record (at pairing, or whenever the
    # phone connects); until then the phone has to dial this PC, which always works.
    bus.call("org.bluez", path, "org.bluez.Device1", "ConnectProfile", GLib.Variant("(s)", (UUID,)), None, Gio.DBusCallFlags.NONE, 20000, None, done)


def on_line(line):
    try:
        req = json.loads(line)
    except ValueError:
        return
    if req.get("t") == "bonded":
        bonded(req)
    elif req.get("t") == "dial" and isinstance(req.get("address"), str):
        dial(req)


def read_stdin():
    for line in sys.stdin:
        GLib.idle_add(lambda l=line: on_line(l) or False)
    GLib.idle_add(lambda: loop.quit() or False)


def main():
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
    bus.register_object(PROFILE_PATH, node.interfaces[0], on_call, None, None)
    opts = {
        "Name": GLib.Variant("s", "MeshDrop"),
        "AutoConnect": GLib.Variant("b", False),
        "RequireAuthentication": GLib.Variant("b", True),
        "RequireAuthorization": GLib.Variant("b", False),
    }
    try:
        bus.call_sync("org.bluez", "/org/bluez", "org.bluez.ProfileManager1", "RegisterProfile",
                      GLib.Variant("(osa{sv})", (PROFILE_PATH, UUID, opts)), None, Gio.DBusCallFlags.NONE, 10000, None)
    except GLib.Error as e:
        fail("Bluetooth is not available: " + e.message)
    out({"ready": True})
    threading.Thread(target=read_stdin, daemon=True).start()
    loop.run()
    try:
        bus.call_sync("org.bluez", "/org/bluez", "org.bluez.ProfileManager1", "UnregisterProfile",
                      GLib.Variant("(o)", (PROFILE_PATH,)), None, Gio.DBusCallFlags.NONE, 2000, None)
    except GLib.Error:
        pass


main()
