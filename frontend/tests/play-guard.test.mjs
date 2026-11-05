import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAY_CHANNEL, OTHER_TAB_WINDOW_MS, COVER_TEXT, makeAnnouncement, isAnnouncement, isForeignRecent, createPlayGuard, coverRemainingMs } from '../src/playGuard.js';
import { classifySpinRefusal, budgetFor, OTHER_TAB_MESSAGE } from '../src/spinRefusal.js';
import { ApiError, isSignedInElsewhere, SIGNED_IN_ELSEWHERE, walletApi } from '../src/walletApi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

// ---- one tab at a time: the BroadcastChannel guard ----
test('an announcement carries game, tab and time and is validated on receipt', () => {
  const m = makeAnnouncement('roulette', 'tab-a', 1000);
  assert.deepEqual(m, { game: 'roulette', tab: 'tab-a', at: 1000 });
  assert.ok(isAnnouncement(m));
  assert.ok(isAnnouncement(makeAnnouncement('godsofpower', 'x', 5)));
  assert.ok(!isAnnouncement(null));
  assert.ok(!isAnnouncement({ game: 'blackjack', tab: 'x', at: 1 }), 'unknown game');
  assert.ok(!isAnnouncement({ game: 'roulette', tab: '', at: 1 }), 'empty tab');
  assert.ok(!isAnnouncement({ game: 'roulette', tab: 'x'.repeat(65), at: 1 }), 'tab id too long');
  assert.ok(!isAnnouncement({ game: 'roulette', tab: 'x', at: 'now' }), 'time not a number');
});

test('only a recent announcement from ANOTHER tab counts as foreign', () => {
  const now = 100_000;
  assert.ok(isForeignRecent(makeAnnouncement('roulette', 'b', now - 1000), 'a', now));
  assert.ok(isForeignRecent(makeAnnouncement('godsofpower', 'b', now - OTHER_TAB_WINDOW_MS), 'a', now), 'exactly at the window edge still counts');
  assert.ok(!isForeignRecent(makeAnnouncement('roulette', 'b', now - OTHER_TAB_WINDOW_MS - 1), 'a', now), 'older than 8 s is ignored');
  assert.ok(!isForeignRecent(makeAnnouncement('roulette', 'a', now), 'a', now), 'own tab is never foreign');
  assert.ok(!isForeignRecent(makeAnnouncement('roulette', 'b', now + 120_000), 'a', now), 'a far future stamp (wrong clock) is ignored');
  assert.ok(!isForeignRecent({ game: 'roulette', tab: 'b' }, 'a', now), 'missing time');
  assert.equal(OTHER_TAB_WINDOW_MS, 8000, 'matches the server window');
});

// A fake channel pair: what one posts, the other receives.
function fakeChannels() {
  const members = [];
  const factory = (name) => {
    assert.equal(name, PLAY_CHANNEL);
    const ch = { onmessage: null, closed: false, postMessage(data) { for (const m of members) if (m !== ch && !m.closed) m.onmessage?.({ data }); }, close() { ch.closed = true; } };
    members.push(ch);
    return ch;
  };
  return { factory, members };
}

test('a spin announced in one tab reaches the other game tab, never itself, and stops after stop()', () => {
  let now = 50_000;
  const { factory } = fakeChannels();
  const a = createPlayGuard({ game: 'roulette', tab: 'A', now: () => now, channelFactory: factory });
  const b = createPlayGuard({ game: 'godsofpower', tab: 'B', now: () => now, channelFactory: factory });
  const seenA = [], seenB = [];
  a.onForeign((m) => seenA.push(m)); b.onForeign((m) => seenB.push(m));
  const sent = a.announce();
  assert.deepEqual(sent, { game: 'roulette', tab: 'A', at: 50_000 });
  assert.deepEqual(seenB, [sent], 'the other game tab hears the spin');
  assert.deepEqual(seenA, [], 'the announcing tab does not cover itself');
  b.announce();
  assert.equal(seenA.length, 1, 'and the other way round');
  // A stale replay (older than the window) is dropped.
  now += OTHER_TAB_WINDOW_MS + 1;
  factory(PLAY_CHANNEL).postMessage(makeAnnouncement('roulette', 'C', 50_000));
  assert.equal(seenB.length, 1);
  b.stop();
  a.announce();
  assert.equal(seenB.length, 1, 'a stopped guard hears nothing more');
  assert.doesNotThrow(() => b.announce(), 'announcing after stop is a no-op');
});

test('without BroadcastChannel the guard is a harmless no-op', () => {
  const g = createPlayGuard({ game: 'roulette', tab: 'A', channelFactory: () => null });
  assert.equal(g.announce().game, 'roulette');
  const off = g.onForeign(() => {}); off(); g.stop();
  const g2 = createPlayGuard({ game: 'roulette', tab: 'A', channelFactory: () => { throw new Error('blocked'); } });
  assert.doesNotThrow(() => g2.announce());
});

test('the cover stays up only for the rest of the 8 s window', () => {
  assert.equal(coverRemainingMs(10_000, 10_000), 8000);
  assert.equal(coverRemainingMs(10_000, 15_000), 3000);
  assert.equal(coverRemainingMs(10_000, 20_000), 0);
  assert.equal(coverRemainingMs(null, 20_000), 0);
  assert.equal(COVER_TEXT, 'Playing in another tab. Tap to play here.');
});

test('the games render the cover over the reels and the felt and announce every spin', () => {
  const slot = src('slots/SlotsApp.jsx'), app = src('App.jsx'), guard = src('PlayGuard.jsx');
  for (const text of [slot, app]) {
    assert.match(text, /usePlayGuard\(\{ game: '(roulette|godsofpower)', tabId/);
    assert.match(text, /guard\.announce\(\)/);
    assert.match(text, /<PlayCover covered=\{guard\.covered\} onDismiss=\{guard\.dismiss\} \/>/);
  }
  assert.ok(slot.indexOf('<PlayCover') > slot.indexOf('</Reels>') && slot.indexOf('<PlayCover') < slot.indexOf('data-testid="slot-vault"') + 5000, 'slot cover sits inside the vault frame');
  assert.ok(app.indexOf('<PlayCover') > app.indexOf('className={`felt-table brand-felt'), 'roulette cover sits inside the felt');
  assert.match(guard, /data-testid="play-cover"/);
  assert.match(guard, /Playing in another tab/);
  assert.match(guard, /Tap to play here\./);
  assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(guard), 'no emoji or long dashes in player copy');
});

// ---- other_tab refusal: predicted, not counted, lock untouched ----
test('a 409 other_tab refusal is its own class, counts against no budget and the roulette page keeps the lock', () => {
  assert.equal(classifySpinRefusal(409, OTHER_TAB_MESSAGE, 'other_tab'), 'other_tab');
  assert.equal(budgetFor('other_tab'), null, 'nothing consumed: not counted');
  assert.equal(classifySpinRefusal(409, 'something else', null), 'unpredicted', 'a 409 without the code stays strict');
  assert.equal(OTHER_TAB_MESSAGE, 'You are playing in another tab or game. Finish that round first.');
  const app = src('App.jsx');
  const branch = app.slice(app.indexOf("if (kind === 'other_tab')"), app.indexOf("if (kind === 'other_tab')") + 400);
  assert.match(branch, /forgetOpenLock\(entry\.serverSeedHash\)/, 'the lock is not retired through the reveal');
  assert.match(branch, /setNotice\(reason \|\| OTHER_TAB_MESSAGE\)/, 'the server text goes in a notice, not an error');
  assert.ok(!/recordRefusal/.test(branch), 'no budget is touched');
  const slot = src('slots/SlotsApp.jsx');
  assert.match(slot, /if \(kind === 'other_tab'\) \{ setNotice\(data\?\.error \|\| OTHER_TAB_MESSAGE\); return; \}/);
});

// ---- signed in elsewhere ----
test('walletApi.me surfaces a 401 signed_in_elsewhere and still returns null for a plain 401', async () => {
  const e = new ApiError('closed', 401, SIGNED_IN_ELSEWHERE);
  assert.ok(isSignedInElsewhere(e));
  assert.ok(!isSignedInElsewhere(new ApiError('nope', 401)));
  assert.ok(!isSignedInElsewhere(new ApiError('closed', 403, SIGNED_IN_ELSEWHERE)));
  assert.ok(!isSignedInElsewhere(null));
  const original = globalThis.fetch;
  const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  try {
    globalThis.fetch = reply(401, { error: 'Connect your wallet first.' });
    assert.equal(await walletApi.me(), null, 'a guest is null');
    globalThis.fetch = reply(200, { address: '0xabc' });
    assert.deepEqual(await walletApi.me(), { address: '0xabc' });
    globalThis.fetch = reply(401, { error: 'You connected this wallet in another browser or device. Connect again to play here.', code: 'signed_in_elsewhere' });
    await assert.rejects(walletApi.me(), (err) => isSignedInElsewhere(err) && /another browser or device/.test(err.message));
    globalThis.fetch = reply(500, { error: 'internal error' });
    await assert.rejects(walletApi.me(), (err) => err.status === 500 && err.code === null);
  } finally { globalThis.fetch = original; }
});

test('the lobby, the slot and the roulette page poll the profile and show the server text with Connect again', () => {
  const hook = src('useSession.js');
  assert.match(hook, /ME_POLL_MS = 10 \* 1000/, 'noticed within about 15 s');
  assert.match(hook, /setInterval\(\(\) => \{ refreshProfile\(\); \}, ME_POLL_MS\)/);
  assert.match(hook, /isSignedInElsewhere\(e\)/);
  for (const f of ['Lobby.jsx', 'slots/SlotsApp.jsx', 'App.jsx']) {
    const text = src(f);
    assert.match(text, /testid: 'signed-in-elsewhere'/, `${f} shows the toast`);
    assert.match(text, /label: 'Connect again', testid: 'connect-again'/, `${f} offers Connect again`);
  }
  const app = src('App.jsx');
  assert.match(app, /setInterval\(\(\) => \{ refreshProfile\(\); \}, 10000\)/, 'roulette polls every 10 s while connected');
  assert.match(app, /const signedOutElsewhere = useCallback/);
  assert.match(src('slots/SlotsApp.jsx'), /autoRef\.current = false; setAutoSpin\(false\)/, 'slot stops Auto');
  assert.match(src('GameToast.jsx'), /game-toast-action/);
});
