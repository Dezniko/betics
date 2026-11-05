import { motion, AnimatePresence } from 'framer-motion';

// One style for every in-game message: a floating card under the header with an icon,
// a short title and the full message. Nothing is hidden, nothing shifts the table.
const ICONS = {
  info: <path d="M12 8h.01M11 12h1v5h1" />,
  error: <path d="M12 7v6M12 16.5h.01" />,
  closed: <path d="M9 9v6M15 9v6" />,
};

export function toastTitle(kind, text, blocked) {
  const t = String(text || '');
  if (kind === 'closed') return 'Game paused';
  if (blocked) return 'Betting paused';
  if (/table was cleared/i.test(t)) return 'Table cleared';
  if (/casino can cover|casino wallet is checked|one spin can pay|bet on one number|Several big bets/i.test(t)) return 'Table limit';
  if (/most you can bet|can be at most|max/i.test(t)) return 'Bet limit reached';
  if (/not enough balance|can't cover|insufficient/i.test(t)) return 'Not enough balance';
  if (/wallet|connect|sign/i.test(t)) return 'Wallet';
  if (/real tics|demo/i.test(t)) return 'Play mode';
  if (/verif|lock|commitment|proof/i.test(t)) return 'Fairness check';
  return kind === 'error' ? 'Something went wrong' : 'Heads up';
}

export default function GameToast({ toasts, onDismiss }) {
  return <div className="game-toasts" aria-live="polite">
    <AnimatePresence initial={false}>
      {toasts.map((t) => <motion.div key={t.kind} layout
        initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 520, damping: 36 }}
        className={`game-toast game-toast-${t.kind} ${t.className || ''}`} role={t.kind === 'error' ? 'alert' : 'status'} data-testid={t.testid}>
        <span className="game-toast-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9.5" />{ICONS[t.kind] || ICONS.info}
          </svg>
        </span>
        <div className="game-toast-text">
          <strong>{t.title}</strong>
          <span className="game-toast-message">{t.text}</span>
          {t.action && <button type="button" className="game-toast-action" data-testid={t.action.testid} onClick={t.action.onClick}>{t.action.label}</button>}
        </div>
        {t.dismissible && <button type="button" className="game-toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.kind)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>}
      </motion.div>)}
    </AnimatePresence>
  </div>;
}
