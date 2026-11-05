// The pill that takes a player from a game back to the lobby at /. Same look in both games.
const Grid = () => <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
</svg>;
export default function LobbyLink({ className = '' }) {
  return <a className={`lobby-link ${className}`} href="/" data-testid="lobby-link" title="Back to the lobby"><Grid />Lobby</a>;
}
