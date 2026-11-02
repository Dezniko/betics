import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { inboxLink } from './inboxLink.js';

// Messages sent from the admin panel: a popup for the newest unread one, and
// an inbox behind the bell. Player copy: plain words, no emoji, no dashes.
const API = '/api';
const post = (path) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});

function Bell() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>;
}

function MessageCard({ m, onOpen, onClose }) {
  const link = inboxLink(m.buttonUrl); // same site, or https only; other sites open in a new tab
  return <div className="inbox-card">
    <h3>{m.title}</h3>
    <p>{m.body}</p>
    <div className="inbox-actions">
      {link && <a className="inbox-btn primary" href={link.href} target={link.external ? '_blank' : undefined} rel={link.external ? 'noopener noreferrer' : undefined} onClick={() => onOpen(m)}>{m.buttonLabel || 'Open'}</a>}
      {onClose && <button type="button" className="inbox-btn" onClick={() => onClose(m)}>Close</button>}
    </div>
  </div>;
}

export default function Inbox({ ready, quiet }) {
  const [box, setBox] = useState({ messages: [], unseen: 0 });
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/inbox`); if (r.ok) setBox(await r.json()); } catch { /* offline: keep what we have */ }
  }, []);
  useEffect(() => {
    if (!ready) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [ready, load]);
  // Show the newest unread message once, only while the player is not mid-round.
  useEffect(() => {
    if (popup || quiet || open) return;
    const next = box.messages.find((m) => !m.seen);
    if (next) { setPopup(next); post(`/inbox/${next.id}/seen`); setBox((b) => ({ messages: b.messages.map((m) => m.id === next.id ? { ...m, seen: true } : m), unseen: Math.max(0, b.unseen - 1) })); }
  }, [box, popup, quiet, open]);
  const clicked = (m) => { post(`/inbox/${m.id}/click`); setPopup(null); setOpen(false); };
  const dismiss = (m) => { post(`/inbox/${m.id}/dismiss`); setBox((b) => ({ ...b, messages: b.messages.filter((x) => x.id !== m.id) })); };
  const openInbox = () => {
    setOpen(true);
    const unseen = box.messages.filter((m) => !m.seen);
    unseen.forEach((m) => post(`/inbox/${m.id}/seen`));
    if (unseen.length) setBox((b) => ({ messages: b.messages.map((m) => ({ ...m, seen: true })), unseen: 0 }));
  };
  return <>
    <button type="button" className="inbox-bell" aria-label={box.unseen ? `Messages, ${box.unseen} new` : 'Messages'} title="Messages" onClick={openInbox} data-testid="inbox-bell">
      <Bell />{box.unseen > 0 && <span className="inbox-dot">{box.unseen}</span>}
    </button>
    {popup && createPortal(<div className="inbox-overlay" role="dialog" aria-modal="true" aria-label={popup.title} data-testid="inbox-popup" onClick={(e) => { if (e.target === e.currentTarget) setPopup(null); }}>
      <MessageCard m={popup} onOpen={clicked} onClose={() => setPopup(null)} />
    </div>, document.body)}
    {open && createPortal(<div className="inbox-overlay" role="dialog" aria-modal="true" aria-label="Messages" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="inbox-panel">
        <div className="inbox-head"><h2>Messages</h2><button type="button" className="inbox-btn" onClick={() => setOpen(false)}>Close</button></div>
        {box.messages.length === 0 ? <p className="inbox-empty">No messages yet.</p>
          : box.messages.map((m) => <div key={m.id} className="inbox-item"><MessageCard m={m} onOpen={clicked} />
            <button type="button" className="inbox-remove" onClick={() => dismiss(m)}>Remove</button></div>)}
      </div>
    </div>, document.body)}
  </>;
}
