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
      <svg className="drop-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4 4 0 0 1 0 9M12 12v8M9 15l3-3 3 3" />
      </svg>
      <span className="drop-title">Drop files or folders here</span>
      <span className="drop-sub">or choose an option below</span>
    </div>
  );
}
