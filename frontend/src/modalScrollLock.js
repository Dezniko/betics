// One lock for the aggregate modal state, preserving the exact underlying page position.
export function lockBackgroundScroll(active) {
  if (!active || typeof document === 'undefined') return () => {};
  const html = document.documentElement, body = document.body;
  const x = window.scrollX, y = window.scrollY;
  const htmlOverflow = html.style.overflow;
  const old = Object.fromEntries(['position','top','left','width','overflow'].map(k => [k, body.style[k]]));
  html.style.overflow = 'hidden';
  Object.assign(body.style, {position:'fixed',top:`-${y}px`,left:`-${x}px`,width:'100%',overflow:'hidden'});
  return () => {
    html.style.overflow = htmlOverflow;
    Object.assign(body.style, old);
    window.scrollTo(x, y);
  };
}
