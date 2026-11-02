// "Need help?" link to the qu-BETICS Telegram support, for every player (guest, demo or connected).
export const SUPPORT_URL = 'https://t.me/Betics_casino';
export default function SupportLink({ className = '', testid = 'support-link', label = 'Contact support on Telegram' }) {
  return <a className={`profile-support ${className}`} href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" data-testid={testid}>
    <span className="profile-support-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.3 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.1.9.8.9.5 0 .7-.2 1-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.5-1.4zM8.6 14l9.9-6.3c.5-.3.9-.1.5.2l-8.4 7.6-.3 3.6L8.6 14z" /></svg>
    </span>
    <span className="profile-support-text"><strong>Need help?</strong><small>{label}</small></span>
    <svg className="profile-support-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
  </a>;
}
