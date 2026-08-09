// Opt-in error/feedback mailbox. Off by default — the promise that "nothing
// leaves your machine" stays true unless the user decides otherwise in
// Settings. When it is on:
//   - uncaught errors (window.onerror / unhandledrejection) and the specific
//     places in the code that call reportError() are sent to /proxy/report
//     (same origin, through the shared Elffuss proxy)
//   - sendFeedback() sends free text the user deliberately wrote
// Code and project content are NEVER sent — only the technical message, the
// stack, the URL and the user agent. No queue and no retries: if the send
// fails it is simply dropped (this keeps a network failure from turning into
// unbounded storage).
let appName = 'elffuss';
let enabled = false;
let hooked = false;

const storageKey = () => 'elffuss.telemetry.' + appName;

export function isEnabled() { return enabled; }

export function setEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem(storageKey(), enabled ? '1' : '0'); } catch { /* localStorage full/blocked */ }
  if (enabled) hookGlobalErrors();
}

async function post(kind, message, opts = {}) {
  if (!enabled) return;
  try {
    await fetch('/proxy/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: appName, kind, message: String(message ?? '').slice(0, 2000),
        stack: String(opts.stack || '').slice(0, 4000),
        url: location.href, userAgent: navigator.userAgent,
        extra: String(opts.extra || '').slice(0, 2000),
      }),
    });
  } catch { /* offline or proxy down: dropped, no retry */ }
}

export function reportError(message, opts = {}) { return post('error', message, opts); }
export function sendFeedback(text) { return post('feedback', text); }

function hookGlobalErrors() {
  if (hooked) return;
  hooked = true;
  window.addEventListener('error', e => {
    reportError(e.message || String(e.error) || 'error', { stack: e.error?.stack || '' });
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    reportError('unhandledrejection: ' + (r?.message || r), { stack: r?.stack || '' });
  });
}

// Call ONCE at startup with the name of the app (so elffuss-code and
// elffuss-claw can be told apart in the reports) — reads the stored preference.
export function init(name) {
  appName = name || appName;
  try { enabled = localStorage.getItem(storageKey()) === '1'; } catch { enabled = false; }
  if (enabled) hookGlobalErrors();
}
