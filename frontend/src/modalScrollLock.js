// One lock for the aggregate modal state, preserving the exact underlying page position.
// Reference counted: several modals (a page's aggregate lock plus a sheet that locks itself) may hold
// it at once, in any order; the page is restored only when the last holder lets go.
let holders = 0;
let saved = null;
export function lockBackgroundScroll(active) {
  if (!active || typeof document === 'undefined') return () => {};
  const html = document.documentElement, body = document.body;
  if (holders === 0) {
    const x = window.scrollX, y = window.scrollY;
    saved = { x, y, htmlOverflow: html.style.overflow, body: Object.fromEntries(['position','top','left','width','overflow'].map(k => [k, body.style[k]])) };
    html.style.overflow = 'hidden';
    Object.assign(body.style, {position:'fixed',top:`-${y}px`,left:`-${x}px`,width:'100%',overflow:'hidden'});
  }
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0 || !saved) return;
    const s = saved; saved = null;
    html.style.overflow = s.htmlOverflow;
    Object.assign(body.style, s.body);
    window.scrollTo(s.x, s.y);
  };
}
export const _scrollLockHolders = () => holders;
