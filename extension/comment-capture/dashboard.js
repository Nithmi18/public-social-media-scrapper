const $ = (id) => document.getElementById(id);
const fmt = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

async function loadSettings() {
  const { baseUrl = '', captureKey = '' } = await chrome.storage.local.get(['baseUrl', 'captureKey']);
  $('baseUrl').value = baseUrl;
  $('captureKey').value = captureKey;
  if (!baseUrl || !captureKey) $('settings').open = true;
  return Boolean(baseUrl && captureKey);
}

function badge(ch) {
  if (!ch.every) return ['Not scheduled', false];
  const label = ch.every === 'daily' ? 'Daily' : 'Weekly';
  if (ch.due) return [`${label} · due now`, true];
  return [`${label} · next ${fmt(ch.next_due_at)}`, false];
}

function render(data) {
  const pendingOnly = $('pendingOnly').checked;
  const root = $('channels');
  root.replaceChildren();
  for (const ch of data.channels) {
    const node = $('channelTpl').content.cloneNode(true);
    node.querySelector('h2').textContent = `${ch.outlet} · @${ch.handle}`;
    const [label, due] = badge(ch);
    const b = node.querySelector('.badge');
    b.textContent = label;
    b.classList.toggle('due', due);
    node.querySelector('.summary').textContent =
      `${ch.pending_posts} ${ch.pending_posts === 1 ? 'post' : 'posts'} with new comments (+${ch.new_comments}). Last capture: ${fmt(ch.last_capture_at)}.`;
    const tbody = node.querySelector('tbody');
    const posts = pendingOnly ? ch.posts.filter((p) => p.pending) : ch.posts;
    for (const p of posts) {
      const tr = document.createElement('tr');
      const state = document.createElement('td');
      state.className = `state ${p.pending ? 'pending' : 'done'}`;
      state.textContent = p.pending ? '●' : '✓';
      state.title = p.pending ? 'New comments to read' : 'Captured';
      const post = document.createElement('td');
      post.className = 'caption';
      const cap = document.createElement('div');
      cap.textContent = p.caption || '(no caption)';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${p.media_type || ''} · ${fmt(p.published_at)}`;
      post.append(cap, meta);
      const now = document.createElement('td');
      now.className = 'num';
      now.textContent = p.comments_now ?? '—';
      const fresh = document.createElement('td');
      fresh.className = 'num';
      fresh.textContent = p.new_comments ? `+${p.new_comments}` : '0';
      const last = document.createElement('td');
      last.className = 'meta';
      last.textContent = fmt(p.last_captured_at);
      const open = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = 'Open';
      btn.addEventListener('click', () => chrome.tabs.create({ url: p.url }));
      open.append(btn);
      tr.append(state, post, now, fresh, last, open);
      tbody.append(tr);
    }
    if (!posts.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'meta';
      td.textContent = pendingOnly ? 'Nothing new to read.' : 'No posts with comments in this window.';
      tr.append(td);
      tbody.append(tr);
    }
    root.append(node);
  }
}

let last = null;
async function refresh() {
  if (!(await loadSettings())) { $('status').textContent = 'Add the project URL and capture key to start.'; return; }
  $('status').textContent = 'Loading…';
  const res = await chrome.runtime.sendMessage({ type: 'queue', days: Number($('days').value) });
  if (!res.ok) { $('status').textContent = `Could not load: ${res.error}`; return; }
  last = res.data;
  $('status').textContent = `Updated ${fmt(res.data.generated_at)}. Counts come from the collector, which runs at 06:00 and 18:00 Sri Lanka time.`;
  render(last);
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ baseUrl: $('baseUrl').value.trim(), captureKey: $('captureKey').value.trim() });
  $('settings').open = false;
  refresh();
});
$('refresh').addEventListener('click', refresh);
$('days').addEventListener('change', refresh);
$('pendingOnly').addEventListener('change', () => last && render(last));
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'captured') refresh(); });
refresh();
