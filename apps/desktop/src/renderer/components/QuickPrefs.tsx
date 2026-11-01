// Language and theme in the top corner of every window: the same choices as Settings, kept per device.
import { useEffect, useState } from 'react';
import { LANGS, langChoice, setLangChoice, t, type Lang, type LangChoice } from '../i18n.ts';
import { THEMES, onThemeChange, setThemeChoice, themeChoice, type ThemeChoice } from '../theme.ts';

const GLOBE = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18';
const CONTRAST = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3v18';

function Glyph({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function QuickPrefs({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState(themeChoice);
  useEffect(() => onThemeChange(() => setTheme(themeChoice())), []);
  return (
    <div className={`quick-prefs ${className}`}>
      <label className="qp" title={t('Language')}>
        <Glyph d={GLOBE} />
        <select aria-label={t('Language')} value={langChoice()} onChange={(e) => void setLangChoice(e.target.value as LangChoice)}>
          <option value="system">{t('System')}</option>
          {(Object.keys(LANGS) as Lang[]).map((l) => (
            <option key={l} value={l} lang={l}>
              {LANGS[l]}
            </option>
          ))}
        </select>
      </label>
      <label className="qp" title={t('Theme')}>
        <Glyph d={CONTRAST} />
        <select aria-label={t('Theme')} value={theme} onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)}>
          {THEMES.map(([v, label]) => (
            <option key={v} value={v}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
