import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { siweFieldsProblem, SIWE_STATEMENT } from '../src/siweCheck.js';

const here = { host: 'www.betics.io', origin: 'https://www.betics.io', chainId: 1 };
const good = { nonce: 'aB3dE5gH9kLmN0pQ', chainId: 1, domain: 'www.betics.io', uri: 'https://www.betics.io', statement: SIWE_STATEMENT };

test('sign in: the server reply must name this site, this address, the pinned network and the known wording', () => {
  assert.equal(siweFieldsProblem(good, here), null);
  assert.equal(siweFieldsProblem({ ...good, domain: 'evil.example' }, here), 'site name');
  assert.equal(siweFieldsProblem({ ...good, uri: 'https://evil.example' }, here), 'site address');
  assert.equal(siweFieldsProblem({ ...good, chainId: 56 }, here), 'network');
  assert.equal(siweFieldsProblem({ ...good, chainId: '1' }, here), 'network');
  assert.equal(siweFieldsProblem({ ...good, nonce: 'short' }, here), 'nonce');
  assert.equal(siweFieldsProblem({ ...good, nonce: 'abc def ghi' }, here), 'nonce');
  assert.equal(siweFieldsProblem({ ...good, statement: 'Approve spending of all your tokens' }, here), 'wording');
  assert.equal(siweFieldsProblem(null, here), 'missing sign in details');
});

test('sign in wording is the same in the server and the page', () => {
  const worker = readFileSync(new URL('../../worker/index.js', import.meta.url), 'utf8');
  assert.ok(worker.includes(`statement: '${SIWE_STATEMENT}'`));
  const wc = readFileSync(new URL('../src/walletConnect.js', import.meta.url), 'utf8');
  assert.match(wc, /siweFieldsProblem\(n, \{ host: window\.location\.host, origin: window\.location\.origin, chainId: CHAIN_ID \}\)/);
});
