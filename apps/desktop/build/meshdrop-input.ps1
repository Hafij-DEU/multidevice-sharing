# MeshDrop remote input on Windows (M10): the JSON lines of meshdrop-input.py, sent with SendInput.
#   {"t":"move","dx":1.5,"dy":-2}            relative pointer motion
#   {"t":"button","button":272,"down":true}  evdev button code (BTN_LEFT 272, RIGHT 273, MIDDLE 274)
#   {"t":"axis","dx":0,"dy":3}               smooth scroll (positive dy scrolls down, 10 = one notch)
#   {"t":"key","keysym":65293,"down":true}   X keysym
# Writes {"ready":true} once it can type. Windows asks nothing first; windows of apps run as
# administrator ignore it (Windows' UIPI), like they ignore any normal program.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public static class MeshDropInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char ch);

  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;

  // X keysyms of the keys the Remote page sends -> virtual-key codes (see src/main/keys.ts)
  static readonly Dictionary<long, ushort> VK = new Dictionary<long, ushort> {
    { 0xff0d, 0x0D }, { 0xff08, 0x08 }, { 0xff09, 0x09 }, { 0xff1b, 0x1B }, { 0xffff, 0x2E }, { 0x20, 0x20 },
    { 0xff51, 0x25 }, { 0xff52, 0x26 }, { 0xff53, 0x27 }, { 0xff54, 0x28 }, { 0xff55, 0x21 }, { 0xff56, 0x22 }, { 0xff50, 0x24 }, { 0xff57, 0x23 },
    { 0xffe1, 0xA0 }, { 0xffe3, 0xA2 }, { 0xffe9, 0xA4 }, { 0xffeb, 0x5B },
    { 0x1008ff14, 0xB3 }, { 0x1008ff15, 0xB2 }, { 0x1008ff16, 0xB1 }, { 0x1008ff17, 0xB0 },
    { 0x1008ff13, 0xAF }, { 0x1008ff11, 0xAE }, { 0x1008ff12, 0xAD },
  };
  static readonly HashSet<ushort> EXTENDED = new HashSet<ushort> { 0x2E, 0x25, 0x26, 0x27, 0x28, 0x21, 0x22, 0x24, 0x23, 0x5B };
  static readonly HashSet<ushort> MODS = new HashSet<ushort> { 0xA2, 0xA4, 0x5B }; // held: letters go as shortcuts
  static readonly HashSet<ushort> held = new HashSet<ushort>();
  static double fx, fy, sx, sy; // sub-pixel motion and sub-step scroll carried to the next event

  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, int dx, int dy, int data) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
    Send(i);
  }
  static void Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    Send(i);
  }

  static string Str(string line, string k) { var m = Regex.Match(line, "\"" + k + "\":\"([a-z]+)\""); return m.Success ? m.Groups[1].Value : ""; }
  static double Num(string line, string k) {
    var m = Regex.Match(line, "\"" + k + "\":(-?[0-9.eE+-]+)");
    double v;
    return m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v) ? v : 0;
  }
  static bool Down(string line) { return line.Contains("\"down\":true"); }

  static void KeySym(long sym, bool down) {
    ushort vk;
    if (VK.TryGetValue(sym, out vk)) {
      if (down) held.Add(vk); else held.Remove(vk);
      Key(vk, 0, (EXTENDED.Contains(vk) ? KEY_EXTENDED : 0) | (down ? 0 : KEY_UP));
      return;
    }
    if (sym >= 0xffbe && sym <= 0xffc9) { Key((ushort)(0x70 + sym - 0xffbe), 0, down ? 0 : KEY_UP); return; } // F1..F12
    long cp = sym >= 0x01000000 ? sym - 0x01000000 : sym < 0x100 ? sym : -1;
    if (cp < 0 || cp > 0x10FFFF) return;
    string s = char.ConvertFromUtf32((int)cp);
    bool shortcut = false;
    foreach (var m in MODS) if (held.Contains(m)) shortcut = true;
    if (shortcut && s.Length == 1) {
      short scan = VkKeyScanW(char.ToLowerInvariant(s[0]));
      if (scan != -1) { Key((ushort)(scan & 0xff), 0, down ? 0 : KEY_UP); return; } // Control+c, not the character
    }
    foreach (char c in s) Key(0, c, KEY_UNICODE | (down ? 0 : KEY_UP)); // types any character, whatever the layout
  }

  public static void Handle(string line) {
    switch (Str(line, "t")) {
      case "move": {
        fx += Num(line, "dx"); fy += Num(line, "dy");
        int x = (int)Math.Truncate(fx), y = (int)Math.Truncate(fy);
        fx -= x; fy -= y;
        if (x != 0 || y != 0) Mouse(MOVE, x, y, 0);
        break;
      }
      case "button": {
        bool d = Down(line);
        switch ((int)Num(line, "button")) {
          case 272: Mouse(d ? LEFTDOWN : LEFTUP, 0, 0, 0); break;
          case 273: Mouse(d ? RIGHTDOWN : RIGHTUP, 0, 0, 0); break;
          case 274: Mouse(d ? MIDDLEDOWN : MIDDLEUP, 0, 0, 0); break;
        }
        break;
      }
      case "axis": {
        sx += Num(line, "dx") * 12; sy += Num(line, "dy") * 12; // 10 units = one 120 wheel notch
        int h = (int)Math.Truncate(sx), v = (int)Math.Truncate(sy);
        sx -= h; sy -= v;
        if (v != 0) Mouse(WHEEL, 0, 0, -v);
        if (h != 0) Mouse(HWHEEL, 0, 0, h);
        break;
      }
      case "key": KeySym((long)Num(line, "keysym"), Down(line)); break;
    }
  }

  public static void Run() {
    Console.Out.WriteLine("{\"ready\":true}");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try { Handle(line); } catch (Exception) { /* one bad line: keep going */ }
    }
    foreach (var vk in new List<ushort>(held)) Key(vk, 0, (EXTENDED.Contains(vk) ? KEY_EXTENDED : 0) | KEY_UP); // nothing left stuck down
  }
}
'@
[MeshDropInput]::Run()
