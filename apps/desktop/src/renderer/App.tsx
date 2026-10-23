import { useState } from 'react';

const PAGES = ['Devices', 'Transfers', 'Inbox', 'Mesh', 'Settings'] as const;
type Page = (typeof PAGES)[number];

export function App() {
  const [page, setPage] = useState<Page>('Devices');
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Pages">
        <div className="brand">MeshDrop</div>
        {PAGES.map((p) => (
          <button key={p} className={p === page ? 'nav active' : 'nav'} onClick={() => setPage(p)} aria-current={p === page ? 'page' : undefined}>
            {p}
          </button>
        ))}
      </nav>
      <main className="content">
        <h1>{page}</h1>
      </main>
    </div>
  );
}
