import { useEffect, useRef, useState } from 'react';

// Header logo with the BETA pill on its top right corner. The pill is absolute, so the header
// layout never shifts; it hides when the logo is squeezed too small to carry it (very long balances
// on narrow phones), instead of spilling over the screen edge.
const MIN_LOGO_FOR_PILL = 60;

export default function BrandLogo() {
  const wrapRef = useRef(null);
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const check = () => setFits(el.getBoundingClientRect().width >= MIN_LOGO_FOR_PILL);
    check();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    window.addEventListener('resize', check);
    return () => { ro?.disconnect(); window.removeEventListener('resize', check); };
  }, []);
  return <h1 className="brand-logo"><span className="brand-logo-wrap" ref={wrapRef}><img src="/brand/logo-480.webp" srcSet="/brand/logo-480.webp 480w, /brand/logo-960.webp 960w" sizes="(max-width: 900px) 160px, 260px" width="480" height="179" alt="qu-BETICS" draggable="false" />
    {fits && <span className="brand-beta" data-testid="brand-beta">BETA</span>}</span></h1>;
}
