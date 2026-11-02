// Before the wallet is asked to sign in, check the fields the server sent (re-audit extra): the message
// must name this site, this page's address, the pinned network and the known wording. The server checks
// the same things when it verifies the signature; this check means the player is never shown a sign in
// request for another site or network, even if the server's reply was wrong.
export const SIWE_STATEMENT = 'Sign in to qu-BETICS. This does not cost anything or move any funds.';
export const SIWE_MISMATCH = 'The sign in request did not match this site, so nothing was signed. Please reload the page and try again.';

export function siweFieldsProblem(n, { host, origin, chainId }) {
  if (!n || typeof n !== 'object') return 'missing sign in details';
  if (n.domain !== host) return 'site name';
  if (n.uri !== origin) return 'site address';
  if (n.chainId !== chainId) return 'network';
  if (typeof n.nonce !== 'string' || !/^[A-Za-z0-9]{8,96}$/.test(n.nonce)) return 'nonce';
  if (n.statement !== SIWE_STATEMENT) return 'wording';
  return null;
}
