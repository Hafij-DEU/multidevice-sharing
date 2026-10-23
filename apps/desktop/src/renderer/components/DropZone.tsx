import { useState, type DragEvent } from 'react';
import type { SendItemInput } from '../../shared/api.ts';

/** Accepts files and folders dragged from the file manager. */
export function DropZone({ onItems }: { onItems: (items: SendItemInput[]) => void }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const out: SendItemInput[] = [];
    const list = e.dataTransfer.items;
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i]!;
      const path = window.meshdrop.pathForFile(f);
      if (!path) continue;
      const entry = list[i]?.webkitGetAsEntry?.();
      out.push({ kind: entry?.isDirectory ? 'dir' : 'file', path });
    }
    if (out.length > 0) onItems(out);
  };
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      Drop files or folders here
    </div>
  );
}
