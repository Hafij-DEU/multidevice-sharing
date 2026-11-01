import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ClipboardPicker } from './components/ClipboardPicker.tsx';
import { lang, loadLang, onLangChange } from './i18n.ts';
import './styles.css';
import './theme.ts';

/** Remounts the app in the new language when it changes in Settings. */
function Root() {
  const [l, setL] = useState(lang);
  useEffect(() => onLangChange(() => setL(lang())), []);
  return location.hash === '#picker' ? <ClipboardPicker key={l} /> : <App key={l} />;
}

void loadLang().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  ),
);
