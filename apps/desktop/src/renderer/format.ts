export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function baseName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export const errorText = (x: unknown): string => {
  const m = x instanceof Error ? x.message : String(x);
  // ipcRenderer.invoke wraps main-process errors: "Error invoking remote method 'x': Error: msg"
  return m.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
