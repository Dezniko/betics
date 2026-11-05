import { useCallback, useEffect, useRef, useState } from 'react';
import { createPlayGuard, coverRemainingMs, COVER_TEXT } from './playGuard.js';

// Hook: announces this tab's spins and raises `covered` when another tab of a game announced a spin
// within the last 8 s. The cover drops by itself when the window passes, or when the player taps it.
export function usePlayGuard({ game, tabId }) {
  const guardRef = useRef(null);
  const [covered, setCovered] = useState(false);
  const [foreign, setForeign] = useState(null);
  const timerRef = useRef(0);
  useEffect(() => {
    if (!tabId) return undefined;
    const guard = createPlayGuard({ game, tab: tabId });
    guardRef.current = guard;
    const off = guard.onForeign((m) => {
      setForeign(m); setCovered(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCovered(false), coverRemainingMs(m.at));
    });
    return () => { off(); guard.stop(); guardRef.current = null; clearTimeout(timerRef.current); };
  }, [game, tabId]);
  const announce = useCallback(() => guardRef.current?.announce(), []);
  const dismiss = useCallback(() => { clearTimeout(timerRef.current); setCovered(false); }, []);
  return { announce, covered, foreign, dismiss };
}

// The cover itself: sits over the reels or the felt (the parent is position: relative).
export function PlayCover({ covered, onDismiss }) {
  if (!covered) return null;
  return <button type="button" className="play-cover" data-testid="play-cover" onClick={onDismiss} aria-label={COVER_TEXT}>
    <span className="play-cover-card">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></svg>
      <strong>Playing in another tab</strong>
      <span>Tap to play here.</span>
    </span>
  </button>;
}
