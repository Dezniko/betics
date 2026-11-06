import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_ORDER, PAGES, headerItems, phoneRows, headerLayout, profilePill, balanceLabel, bellBadge, sameOrder } from '../src/headerModel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

// ---- the header model: which items show where, in which order ----
test('one header order for every page: logo, Lobby, Next lock, balance, Real/Demo, mute, bell, profile', () => {
  assert.deepEqual([...HEADER_ORDER], ['logo', 'lobby', 'lock', 'balance', 'mode', 'mute', 'bell', 'profile']);
  assert.deepEqual([...PAGES], ['lobby', 'roulette', 'slot']);
});

test('the lobby has no Lobby pill and no lock; the games have both; the Real/Demo switch and the bell show for everyone', () => {
  assert.deepEqual(headerItems({ page: 'lobby' }), ['logo', 'balance', 'mode', 'mute', 'bell', 'profile'], 'a guest sees the switch (Real starts the connect flow)');
  assert.deepEqual(headerItems({ page: 'lobby', connected: true }), headerItems({ page: 'lobby' }), 'connected changes nothing');
  assert.deepEqual(headerItems({ page: 'roulette' }), ['logo', 'lobby', 'lock', 'balance', 'mode', 'mute', 'bell', 'profile']);
  assert.deepEqual(headerItems({ page: 'slot', connected: true }), ['logo', 'lobby', 'lock', 'balance', 'mode', 'mute', 'bell', 'profile']);
  assert.deepEqual(headerItems({ page: 'slot', connected: true }), headerItems({ page: 'roulette', connected: true }), 'both games show the same items');
  assert.deepEqual(headerItems({ page: 'roulette', lock: false }), ['logo', 'lobby', 'balance', 'mode', 'mute', 'bell', 'profile'], 'a game without a lock yet');
  assert.throws(() => headerItems({ page: 'terms' }), /unknown page/);
});

test('the common items keep the same order across the three pages, connected or not', () => {
  for (const connected of [false, true]) {
    const l = headerItems({ page: 'lobby', connected }), r = headerItems({ page: 'roulette', connected }), s = headerItems({ page: 'slot', connected });
    assert.ok(sameOrder(l, r) && sameOrder(l, s) && sameOrder(r, s), `connected=${connected}`);
  }
  assert.ok(!sameOrder(['logo', 'balance', 'profile'], ['balance', 'logo', 'profile']));
});

test('portrait phones: row one is logo, balance and profile; row two Lobby, lock, Real/Demo, mute and the bell', () => {
  const rows = phoneRows(headerItems({ page: 'roulette', connected: true }));
  assert.deepEqual(rows.row1, ['logo', 'balance', 'profile']);
  assert.deepEqual(rows.row2, ['lobby', 'lock', 'mode', 'mute', 'bell'], 'the bell sits beside the mute: on row one it clipped the amount at 320 px');
  const lobby = phoneRows(headerItems({ page: 'lobby' }));
  assert.deepEqual(lobby.row1, ['logo', 'balance', 'profile']);
  assert.deepEqual(lobby.row2, ['mode', 'mute', 'bell'], 'a guest in the lobby gets the switch, the mute and the bell on row two');
});

test('the balance label names the balance: DEMO BALANCE or REAL BALANCE (a guest is always on Demo)', () => {
  assert.equal(balanceLabel('demo'), 'DEMO BALANCE');
  assert.equal(balanceLabel('real'), 'REAL BALANCE');
  assert.equal(balanceLabel(undefined), 'DEMO BALANCE');
});

test('the bell badge is the unread count, capped at 99+, nothing for zero', () => {
  assert.equal(bellBadge(0), null); assert.equal(bellBadge(undefined), null); assert.equal(bellBadge(-2), null);
  assert.equal(bellBadge(1), '1'); assert.equal(bellBadge(3), '3'); assert.equal(bellBadge(99), '99'); assert.equal(bellBadge(100), '99+'); assert.equal(bellBadge(1234), '99+');
});

test('layout from the viewport: landscape phones, portrait phones and tablets, desktop from 1000 px', () => {
  assert.equal(headerLayout(844, 390), 'landscape');
  assert.equal(headerLayout(874, 298), 'landscape');
  assert.equal(headerLayout(390, 844), 'portrait');
  assert.equal(headerLayout(320, 740), 'portrait');
  assert.equal(headerLayout(768, 1024), 'portrait');
  assert.equal(headerLayout(1024, 768), 'desktop');
  assert.equal(headerLayout(1280, 800), 'desktop');
  assert.equal(headerLayout(1280, 500), 'landscape', 'a short wide window is treated as landscape');
});

test('the profile pill reads the short address when connected, Connect wallet when not', () => {
  const shortAddress = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
  assert.deepEqual(profilePill({ address: '0x13bd1483a1b2c3d4e5f60718293a4b5c5421b784', shortAddress }), { kind: 'connected', text: '0x13bd...b784' });
  assert.deepEqual(profilePill({}), { kind: 'guest', text: 'Connect wallet' });
  assert.deepEqual(profilePill({ connecting: true }), { kind: 'guest', text: 'Connecting...' });
});

// ---- the three pages use the shared header and the shared profile sheet, and nothing else ----
test('lobby, roulette and Gods of Power render GameHeader and ProfileSheet with the same hooks', () => {
  for (const f of ['Lobby.jsx', 'App.jsx', 'slots/SlotsApp.jsx']) {
    const text = src(f);
    assert.match(text, /<GameHeader page="(lobby|roulette|slot)" layout=\{/, `${f} renders the shared header`);
    assert.match(text, /<ProfileSheet key="profile" page="(lobby|roulette|slot)" mobile=\{/, `${f} renders the shared profile sheet`);
    assert.match(text, /useInbox\(\{ ready: !!user/, `${f} loads the inbox for the Messages row and the bell`);
    assert.match(text, /\{inbox\.popupNode\}/, `${f} shows the newest unread message`);
    assert.match(text, /inbox=\{inbox\} onBell=\{openMessages\}>/, `${f} hands the inbox and the bell handler to the header`);
    assert.match(text, /expand: 'messages' \}\); inbox\.markSeen\(\); \}/, `${f}: the bell opens the Messages row and marks them seen`);
    assert.match(text, /initialExpanded=\{sheet\.expand \|\| null\}/, `${f} passes the row to expand to the sheet`);
    assert.ok(!text.includes('showSwitch='), `${f}: the switch is not gated on a connection any more`);
    assert.match(text, /historyContent=\{/, `${f} passes History content`);
    assert.match(text, /fairnessContent=\{/, `${f} passes Fairness content`);
    for (const gone of ['SoundQuickControls', 'SoundSettingsDialog', '<WalletPanel', 'mobile-history-trigger', 'demo-refill"', 'inbox-bell', '<Inbox ', 'fairness-label', '<LobbyLink', '<BrandLogo']) {
      assert.ok(!text.includes(gone), `${f} still has the old header piece ${gone}`);
    }
  }
  const app = src('App.jsx');
  assert.match(app, /balanceText=\{user \? \(portraitPhone \? fmtShort\(displayBalanceCents\) : fmt\(displayBalanceCents\)\) : '-'\}/, 'roulette keeps the count-up balance in the header');
  assert.match(src('ProfileSheet.jsx'), /onResetDemo && wallet && mode === 'demo' && \{ key: 'reset'/, 'Reset demo is a built in sheet row, shown in Demo on every page');
  for (const f of ['App.jsx', 'slots/SlotsApp.jsx', 'Lobby.jsx']) assert.match(src(f), /onResetDemo=\{/, `${f} passes onResetDemo`);
  assert.match(app, /onTap: \(\) => openProfile\('fairness'\)/, 'the roulette lock pill opens the Fairness tab');
  assert.match(app, /data-testid="how-fair"/, 'the How we keep it fair content stays reachable');
  assert.match(app, /data-testid="rotate-lock"/);
  assert.match(app, /<RefusedSpins entries=\{readRefusedLog\(\)\} \/>/);
  assert.match(app, /historyRows = history\.filter\(\(r\) => r\.outcome_json && \(!r\.game \|\| r\.game === 'roulette'\)\)/, 'slot rounds never show in the roulette history');
  const slot = src('slots/SlotsApp.jsx');
  assert.match(slot, /onTap: \(\) => setSheet\(\{ tab: 'fairness' \}\)/, 'the slot lock pill opens the Fairness tab');
  assert.match(slot, /<SlotHistory refreshKey=/);
  assert.match(slot, /<SlotFairnessBody round=\{lastRound\} receipt=\{lastReceipt\} verdict=\{lastVerdict\}/);
  assert.match(slot, /label: 'Rules and pays'/);
  assert.match(slot, /data-testid="slot-paytable-btn"/, 'the bottom Rules button stays');
  assert.match(slot, /data-testid="slot-fairness-btn"/, 'the bottom Fairness button stays');
});

test('GameHeader: the wallet chip when connected; a separate gold Connect wallet pill and a round neon person icon when not; the bell; the switch for everyone', () => {
  const header = src('GameHeader.jsx');
  assert.match(header, /data-testid="wallet-chip"/);
  assert.match(header, /<span className="wallet-chip-text">\{pill\.text\}<\/span>/, 'wallet-chip textContent is the short address');
  assert.match(header, /data-testid="profile-button"/);
  assert.match(header, /data-testid="wallet-connect"/);
  assert.ok(header.indexOf('data-testid="wallet-connect"') < header.indexOf('data-testid="profile-button"'), 'the Connect pill comes before the person icon, so the icon is the last item on the right');
  assert.match(header, /className="gh-icon gh-person" data-testid="profile-button"/, 'the person icon is a round gh-icon like the mute');
  assert.ok(!header.includes('gh-guest'), 'the guest controls are no longer one pill');
  assert.match(header, /<small className="balance-word" data-testid="header-balance-label">\{balanceLabel\(mode\)\}<\/small>/, 'DEMO BALANCE or REAL BALANCE over the amount');
  assert.match(header, /mode: <div key="mode" className="mode-switch gh-mode"/, 'the switch is not gated on showSwitch');
  assert.match(header, /const pickMode = \(m\) => \{ if \(m === 'real' && !connected\) onConnect\?\.\(\); else onMode\?\.\(m\); \};/, 'a guest tapping Real starts the connect flow');
  assert.match(header, /aria-disabled=\{connected && !modeInfo\?\.realAvailable \? true : undefined\}/, 'Real never looks disabled for a guest');
  assert.match(header, /className=\{`gh-icon gh-bell\$\{badge \? ' lit' : ''\}`\} data-testid="header-bell"/, 'the bell is a round gh-icon like the mute');
  assert.match(header, /\{badge && <span className="gh-bell-count" data-testid="bell-count">\{badge\}<\/span>\}/, 'the red count only while unread');
  assert.match(header, /onClick=\{onBell \|\| onProfile\}/);
  assert.match(header, /data-testid="header-balance" data-mode=\{mode\}/);
  assert.match(header, /data-balance-target="header"/, 'the win count-up still finds the header balance');
  assert.match(src('SoundControls.jsx'), /data-testid="header-mute"/); assert.match(header, /<MuteButton className="gh-icon"/);
  assert.match(header, /className=\{`commitment-button gh-pill gh-lock/);
  assert.match(header, /<span className="commitment-label">Next lock<\/span>/);
  assert.match(header, /<a key="logo" className="gh-logo" href="\/"/, 'the logo links to the lobby');
  for (const id of HEADER_ORDER) assert.ok(header.includes(`data-header-item="${id}"`) || (id === 'lobby' && src('LobbyLink.jsx').includes('data-header-item="lobby"')), `item ${id} is measurable`);
  for (const f of ['GameHeader.jsx', 'ProfileSheet.jsx', 'headerModel.js', 'gameHeader.css', 'profileSheet.css', 'slots/SlotHistory.jsx', 'slots/slotHistory.js']) {
    const text = src(f);
    assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(text), `${f} has an emoji or long dash`);
    assert.ok(!/guaranteed|trustless|fully provably fair/i.test(text), `${f} has a banned phrase`);
  }
  assert.ok(!/\$\s?\d/.test(src('ProfileSheet.jsx')), 'amounts read $TICS, never dollars');
});

test('ProfileSheet: tabs Wallet | History | Fairness, Sound and Messages rows, Disconnect, foot links', () => {
  const sheet = src('ProfileSheet.jsx');
  for (const t of ['wallet', 'history', 'fairness']) assert.match(sheet, new RegExp(`\\['${t}', '[A-Z][a-z]+'\\]`));
  assert.match(sheet, /data-testid=\{`tab-\$\{key\}`\}/);
  assert.match(sheet, /key: 'sound', label: 'Sound'/);
  assert.match(sheet, /key: 'messages', label: 'Messages'/);
  assert.match(sheet, /testid: 'wallet-disconnect'/);
  assert.match(sheet, /data-testid="sheet-connect"/, 'a guest can connect from the sheet');
  assert.match(sheet, /data-testid="wallet-address"/);
  assert.match(sheet, /lockBackgroundScroll\(open\)/, 'locks the page behind it');
  assert.match(sheet, /e\.key === 'Escape'/);
  assert.match(sheet, /href="\/how-it-works"/); assert.match(sheet, /href="\/terms"/); assert.match(sheet, /testid="profile-support"/);
  assert.match(src('WalletPanel.jsx'), /export function WalletContent\(/);
  assert.match(src('WalletPanel.jsx'), /export function useAnchor\(enabled, selector = '\[data-testid=header-profile\]'\)/);
  assert.ok(!/wallet-disconnect/.test(src('WalletPanel.jsx')), 'Disconnect is the sheet row only');
});

test('the background scroll lock is reference counted, so a page lock and a sheet lock can overlap in any order', async () => {
  const calls = [];
  globalThis.window = { scrollX: 0, scrollY: 120, scrollTo: (x, y) => calls.push(['scrollTo', x, y]) };
  globalThis.document = { documentElement: { style: {} }, body: { style: { position: '', top: '', left: '', width: '', overflow: '' } } };
  try {
    const { lockBackgroundScroll, _scrollLockHolders } = await import('../src/modalScrollLock.js');
    const a = lockBackgroundScroll(true);
    assert.equal(document.body.style.position, 'fixed'); assert.equal(document.body.style.top, '-120px');
    const b = lockBackgroundScroll(true);
    assert.equal(_scrollLockHolders(), 2);
    a();
    assert.equal(document.body.style.position, 'fixed', 'still held by the second lock');
    a();
    assert.equal(_scrollLockHolders(), 1, 'releasing twice counts once');
    b();
    assert.equal(document.body.style.position, '', 'restored when the last holder lets go');
    assert.deepEqual(calls, [['scrollTo', 0, 120]]);
    assert.equal(typeof lockBackgroundScroll(false), 'function');
  } finally { delete globalThis.window; delete globalThis.document; }
});
