import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Chip } from './ChipView.jsx';
import { chipGroups, fmtMoney } from './chips.js';
import { winTier, celebrationTiming, particleBudget, countEase } from './winCelebration.js';
import { playCelebrationTick, playCelebrationHit, playChipLand } from './sound.js';

const visibleRect = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight ? r : null; };

// Casino-style win moment: light burst + rays, the amount racing up with
// rising chip clicks, a coin shower, then real chips flying into the balance
// while it counts up in lockstep. Only transform/opacity animate (compositor
// friendly); phones get a smaller particle budget. Tap anywhere to speed up.
export default function WinCelebration({ total, stake, phase, pace = 1, mobile, onSkip }) {
  const reduced = useReducedMotion();
  const tier = useMemo(() => winTier(total, stake), [total, stake]);
  const timing = celebrationTiming(tier, pace);
  const budget = particleBudget(tier, { mobile, reducedMotion: reduced });
  const amountRef = useRef(null), layerRef = useRef(null), stageRef = useRef(null);
  const [anchor, setAnchor] = useState(null);

  // Centre the banner over the felt so the wheel stays visible.
  useLayoutEffect(() => {
    const felt = document.querySelector('.felt-table');
    const r = felt && visibleRect(felt);
    setAnchor(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width } : { x: innerWidth / 2, y: innerHeight * 0.6, w: innerWidth });
  }, []);

  // Count-up with accelerating chip clicks, landing on the exact total.
  useEffect(() => {
    const el = amountRef.current; if (!el) return;
    if (phase !== 'totaling') { el.textContent = fmtMoney(total); return; }
    let raf, done = false; const start = performance.now();
    const step = now => {
      const t = Math.max(0, Math.min(1, (now - start) / Math.max(1, timing.countMs))); // rAF time can predate start
      el.textContent = fmtMoney(Math.round(total * countEase(t)));
      playCelebrationTick(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else if (!done) { done = true; playCelebrationHit(tier.id === 'big' || tier.id === 'mega'); stageRef.current?.classList.add('celebrate-landed'); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [phase, total, timing.countMs, tier.id, !!anchor]);

  // Chips fly from the banner into whichever balance readout is on screen.
  useEffect(() => {
    if (phase !== 'transferring' || !layerRef.current || !amountRef.current) return;
    const target = [...document.querySelectorAll('[data-balance-target]')].map(visibleRect).find(Boolean);
    const from = amountRef.current.getBoundingClientRect();
    if (!target) return;
    const tx = target.left + target.width / 2, ty = target.top + target.height / 2;
    const fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    const chips = [...layerRef.current.querySelectorAll('.fly-chip')];
    const animations = chips.map((node, i) => {
      const delay = (i / Math.max(1, chips.length)) * timing.flyMs * 0.55;
      const spread = (i % 2 ? 1 : -1) * (20 + (i * 37) % 70);
      const lift = 60 + (i * 53) % 90;
      node.style.left = `${fx - 14}px`; node.style.top = `${fy - 14}px`;
      const a = node.animate([
        { transform: 'translate(0,0) scale(0.6)', opacity: 0 },
        { transform: `translate(${spread}px, ${-lift}px) scale(1.15)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${(tx - fx) * 0.6 + spread * 0.4}px, ${(ty - fy) * 0.5 - lift}px) scale(0.95)`, opacity: 1, offset: 0.65 },
        { transform: `translate(${tx - fx}px, ${ty - fy}px) scale(0.45)`, opacity: 0.2 },
      ], { duration: timing.flyMs * 0.6, delay, easing: 'cubic-bezier(.35,.05,.4,1)', fill: 'both' });
      a.onfinish = () => playChipLand();
      return a;
    });
    const pop = document.querySelectorAll('[data-balance-target]');
    pop.forEach(el => el.classList.add('balance-celebrate'));
    return () => { animations.forEach(a => a.cancel()); pop.forEach(el => el.classList.remove('balance-celebrate')); };
  }, [phase, total, timing.flyMs, !!anchor]);

  const coins = useMemo(() => Array.from({ length: budget.coins }, (_, i) => ({
    x: ((i * 61) % 100) - 50, d: 0.9 + ((i * 17) % 10) / 12, delay: ((i * 29) % 20) / 40, r: ((i * 47) % 360), s: 0.7 + ((i * 13) % 6) / 10,
  })), [budget.coins]);
  const flyValues = useMemo(() => {
    const list = chipGroups(total).flatMap(g => Array(Math.min(g.count, 6)).fill(g.cents));
    return Array.from({ length: budget.flyingChips }, (_, i) => list[i % Math.max(1, list.length)] ?? 100);
  }, [total, budget.flyingChips]);
  const multiple = stake > 0 ? total / stake : 0;

  if (!anchor) return null;
  return <div className={`win-celebration tier-${tier.id}`} data-testid="win-celebration" data-tier={tier.id} data-phase={phase}
    onPointerDown={onSkip} role="status" aria-live="assertive">
    <div className="celebrate-flash"/>
    <div className="celebrate-coins" aria-hidden="true">
      {coins.map((c, i) => <span key={i} style={{ '--x': `${c.x}vw`, '--d': `${c.d}s`, '--delay': `${c.delay}s`, '--r': `${c.r}deg`, '--s': c.s }}/>)}
    </div>
    <div ref={stageRef} className="celebrate-stage" style={{ left: anchor.x, top: anchor.y, '--stage-w': `${Math.min(anchor.w, 520)}px` }}>
      {!reduced && <div className="celebrate-rays" aria-hidden="true"/>}
      <div className="celebrate-glow" aria-hidden="true"/>
      <div className="celebrate-banner">
        <div className="celebrate-label">{tier.label}</div>
        <div ref={amountRef} className="celebrate-amount" data-testid="celebrate-amount">{fmtMoney(phase === 'totaling' ? 0 : total)}</div>
        {multiple >= 2 && <div className="celebrate-multiple">×{multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)} your stake</div>}
      </div>
    </div>
    <div ref={layerRef} className="celebrate-fly-layer" aria-hidden="true">
      {phase === 'transferring' && flyValues.map((c, i) => <div key={i} className="fly-chip"><Chip cents={c} size={28}/></div>)}
    </div>
  </div>;
}
