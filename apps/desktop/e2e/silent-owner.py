# An X11 clipboard owner that never answers: what a hung app holding the clipboard looks like to
# MeshDrop. It owns CLIPBOARD and PRIMARY, prints "ready", then never reads its events, so every
# selection request to it goes unanswered.
import ctypes
import sys
import time

x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XCreateSimpleWindow.restype = ctypes.c_ulong
x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_int] * 2 + [ctypes.c_uint] * 3 + [ctypes.c_ulong] * 2
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
x.XGetSelectionOwner.restype = ctypes.c_ulong
x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]

d = x.XOpenDisplay(None)
if not d:
    sys.exit('silent-owner: cannot open the display')
w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, 1, 1, 0, 0, 0)
for name in (b'CLIPBOARD', b'PRIMARY'):
    sel = x.XInternAtom(d, name, 0)
    x.XSetSelectionOwner(d, sel, w, 0)
    if x.XGetSelectionOwner(d, sel) != w:
        sys.exit('silent-owner: could not own ' + name.decode())
x.XFlush(d)
print('ready', flush=True)
time.sleep(1e6)
