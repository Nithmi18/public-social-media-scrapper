// All calls to the backend go through here, so the capture key never reaches instagram.com pages.
const settings = () => chrome.storage.local.get(['baseUrl', 'captureKey']);

async function call(path, init = {}) {
  const { baseUrl, captureKey } = await settings();
  if (!baseUrl || !captureKey) throw new Error('not_configured');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/functions/v1/comment-capture/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-capture-key': captureKey, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `http_${res.status}`);
  return body;
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const [open] = await chrome.tabs.query({ url });
  if (open) await chrome.tabs.update(open.id, { active: true });
  else await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = async () => {
    if (msg.type === 'queue') return call(`queue?days=${msg.days || 7}`);
    if (msg.type === 'capture') {
      const result = await call('capture', { method: 'POST', body: JSON.stringify({ shortcode: msg.shortcode, comments: msg.comments }) });
      chrome.runtime.sendMessage({ type: 'captured', shortcode: msg.shortcode, result }).catch(() => {});
      return result;
    }
    throw new Error('unknown_message');
  };
  run().then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: e.message }));
  return true;
});
