import { t } from '../i18n.ts';

export interface ToastItem {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

export function Toasts({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`toast ${i.kind}`}>
          <span>{i.text}</span>
          <button className="link" onClick={() => onClose(i.id)} aria-label={t('Dismiss')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
