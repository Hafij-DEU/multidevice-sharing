// Key names the Remote page sends (M10 "input" events) and their X keysyms, for the RemoteDesktop portal.
export const KEYSYMS: Record<string, number> = {
  Return: 0xff0d, BackSpace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff, space: 0x20,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Page_Up: 0xff55, Page_Down: 0xff56, Home: 0xff50, End: 0xff57,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Super: 0xffeb,
  AudioPlay: 0x1008ff14, AudioStop: 0x1008ff15, AudioPrev: 0x1008ff16, AudioNext: 0x1008ff17,
  AudioRaiseVolume: 0x1008ff13, AudioLowerVolume: 0x1008ff11, AudioMute: 0x1008ff12,
};

/** The keysym that types `ch` (Latin-1 as is, the rest as Unicode keysyms); newline is Return. */
export function charKeysym(ch: string): number {
  if (ch === '\n') return KEYSYMS.Return!;
  if (ch === '\t') return KEYSYMS.Tab!;
  const cp = ch.codePointAt(0)!;
  return cp < 0x100 ? cp : 0x01000000 + cp;
}

export const BUTTONS: Record<string, number> = { left: 272, right: 273, middle: 274 };
