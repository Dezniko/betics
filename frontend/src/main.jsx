import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { TermsPage } from './Terms.jsx';
import HowItWorksPage from './HowItWorks.jsx';
import { ensureAudioContext } from './sound.js';
import './index.css';
import { rememberFirstTouch } from './firstTouch.js';

// Remember where this visitor came from before anything else runs (the admin traffic reports use it).
rememberFirstTouch();

// Browsers keep audio locked until a user gesture. Unlock it on the very
// first tap/click/key anywhere so chip sounds work from the first chip, not
// only after the first spin.
['pointerdown', 'touchstart', 'keydown'].forEach((evt) =>
  window.addEventListener(evt, () => ensureAudioContext(), { passive: true })
);

// Deliberately not wrapped in React.StrictMode: this app drives
// timing-sensitive Framer Motion animations and setTimeout-scheduled sound
// effects from effects, and StrictMode's dev-mode double-invoke of effects
// (mount -> effect -> cleanup -> effect again) caused duplicate rotation
// increments and duplicate sound timers. Not needed for a local dev build.
const terms = /^\/terms\/?$/.test(window.location.pathname);
const how = /^\/how-it-works\/?$/.test(window.location.pathname);
ReactDOM.createRoot(document.getElementById('root')).render(terms ? <TermsPage /> : how ? <HowItWorksPage /> : <App />);
