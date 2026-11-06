// The pill that takes a player from a game back to the lobby at /. Same look in both games.
const Home = () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M3 11l9-8 9 8v10H3z" /><path d="M10 21v-6h4v6" />
</svg>;
export default function LobbyLink({ className = '' }) {
  return <a className={`lobby-link ${className}`} href="/" data-testid="lobby-link" data-header-item="lobby" title="Back to the lobby" aria-label="Back to the lobby"><Home /><span className="lobby-link-text">Lobby</span></a>;
}
