import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { inboxLink } from './inboxLink.js';

// Messages sent from the admin panel: a popup for the newest unread one, and the list behind the
// Messages row of the profile sheet. Player copy: plain words, no emoji, no dashes.
const API = '/api';
const post = (path) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});

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

// Loads the inbox while `ready`, refreshes every minute, shows the newest unread message once as a
// popup (never mid-round: `quiet`); the other unread ones stay unread behind the header bell, which
// shows `unseen`, instead of popping up one after another. A message that arrives later pops up in
// turn. `markSeen()` is called when the bell is tapped or the Messages row is opened.
export function useInbox({ ready, quiet }) {
  const [box, setBox] = useState({ messages: [], unseen: 0 });
  const [popup, setPopup] = useState(null);
  const offeredRef = useRef(new Set()); // ids already offered as a popup, or waiting behind the bell
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/inbox`); if (r.ok) setBox(await r.json()); } catch { /* offline: keep what we have */ }
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [ready, load]);
  useEffect(() => {
    if (popup || quiet) return;
    const unseen = box.messages.filter((m) => !m.seen);
    const next = unseen.find((m) => !offeredRef.current.has(m.id));
    if (!next) return;
    unseen.forEach((m) => offeredRef.current.add(m.id)); // one popup per batch; the rest wait behind the bell
    setPopup(next); post(`/inbox/${next.id}/seen`); setBox((b) => ({ messages: b.messages.map((m) => m.id === next.id ? { ...m, seen: true } : m), unseen: Math.max(0, b.unseen - 1) }));
  }, [box, popup, quiet]);
  const clicked = (m) => { post(`/inbox/${m.id}/click`); setPopup(null); };
  const dismiss = (m) => { post(`/inbox/${m.id}/dismiss`); setBox((b) => ({ ...b, messages: b.messages.filter((x) => x.id !== m.id) })); };
  const markSeen = () => {
    const unseen = box.messages.filter((m) => !m.seen);
    unseen.forEach((m) => post(`/inbox/${m.id}/seen`));
    if (unseen.length) setBox((b) => ({ messages: b.messages.map((m) => ({ ...m, seen: true })), unseen: 0 }));
  };
  const popupNode = popup ? createPortal(<div className="inbox-overlay" role="dialog" aria-modal="true" aria-label={popup.title} data-testid="inbox-popup" onClick={(e) => { if (e.target === e.currentTarget) setPopup(null); }}>
    <MessageCard m={popup} onOpen={clicked} onClose={() => setPopup(null)} />
  </div>, document.body) : null;
  return { messages: box.messages, unseen: box.unseen, popupNode, markSeen, clicked, dismiss };
}

// The list inside the Messages row.
export function InboxList({ inbox }) {
  return <div className="inbox-list" data-testid="inbox-list">
    {inbox.messages.length === 0 ? <p className="inbox-empty">No messages yet.</p>
      : inbox.messages.map((m) => <div key={m.id} className="inbox-item"><MessageCard m={m} onOpen={inbox.clicked} />
        <button type="button" className="inbox-remove" onClick={() => inbox.dismiss(m)}>Remove</button></div>)}
  </div>;
}
