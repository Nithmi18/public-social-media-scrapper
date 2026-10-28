const $ = (id) => document.getElementById(id);
const fmt = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
const prefs = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* per-browser convenience only */ } },
};

let data = null;
let active = prefs.get('channel', null);
let filter = prefs.get('filter', 'pending');
let captureTab = null;

async function loadSettings() {
  const { baseUrl = '', captureKey = '' } = await chrome.storage.local.get(['baseUrl', 'captureKey']);
  $('baseUrl').value = baseUrl;
  $('captureKey').value = captureKey;
  return Boolean(baseUrl && captureKey);
}

function schedule(ch) {
  if (!ch.every) return { text: 'Not scheduled', due: false };
  const label = ch.every === 'daily' ? 'Daily' : 'Weekly';
  if (ch.due) return { text: `${label} · due now`, due: true };
  return { text: `${label} · next ${fmt(ch.next_due_at)}`, due: false };
}

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren();
  for (const ch of data.channels) {
    const tab = document.createElement('button');
    tab.className = `tab${ch.channel_id === active ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', ch.channel_id === active);
    const name = document.createElement('span');
    name.textContent = ch.outlet;
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = `@${ch.handle}`;
    const count = document.createElement('span');
    count.className = `count${ch.pending_posts ? ' hot' : ''}`;
    count.textContent = ch.pending_posts;
    count.title = `${ch.pending_posts} posts with new comments`;
    tab.append(name, handle, count);
    if (schedule(ch).due) {
      const dot = document.createElement('span');
      dot.className = 'dot-due';
      dot.title = 'Capture due';
      tab.append(dot);
    }
    tab.addEventListener('click', () => { active = ch.channel_id; prefs.set('channel', active); render(); });
    nav.append(tab);
  }
}

function visiblePosts(ch) {
  const q = $('search').value.trim().toLowerCase();
  let posts = ch.posts.filter((p) => (filter === 'all' || p.pending) && (!q || (p.caption || '').toLowerCase().includes(q)));
  if ($('sort').value === 'recent') posts = [...posts].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return posts;
}

function postRow(p) {
  const li = document.createElement('li');
  li.className = `post${p.pending ? '' : ' done'}`;
  const state = document.createElement('span');
  state.className = 'state';
  state.title = p.pending ? 'New comments to read' : 'Captured';

  const body = document.createElement('div');
  const cap = document.createElement('div');
  cap.className = 'caption';
  cap.textContent = p.caption || '(no caption)';
  cap.title = p.caption || '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const type = document.createElement('span');
  type.className = 'type';
  type.textContent = (p.media_type || 'POST').replace('CAROUSEL_ALBUM', 'CAROUSEL');
  const posted = document.createElement('span');
  posted.textContent = `Posted ${ago(p.published_at)}`;
  posted.title = fmt(p.published_at);
  const captured = document.createElement('span');
  captured.textContent = p.last_captured_at ? `Captured ${ago(p.last_captured_at)}` : 'Not captured yet';
  captured.title = fmt(p.last_captured_at);
  meta.append(type, posted, captured);
  body.append(cap, meta);

  const numbers = document.createElement('div');
  numbers.className = 'numbers';
  const total = document.createElement('span');
  total.className = 'total';
  total.textContent = `${p.comments_now ?? 0} comments`;
  const pill = document.createElement('span');
  pill.className = `pill ${p.pending ? 'new' : 'ok'}`;
  pill.textContent = p.pending ? `+${p.new_comments} new` : 'Up to date';
  numbers.append(total, pill);

  const open = document.createElement('button');
  open.className = `open${p.pending ? ' primary' : ''}`;
  open.textContent = 'Open';
  open.addEventListener('click', () => openPost(p.url));

  li.append(state, body, numbers, open);
  return li;
}

function render() {
  if (!data?.channels.length) { $('view').hidden = true; return; }
  if (!data.channels.some((c) => c.channel_id === active)) active = data.channels[0].channel_id;
  renderTabs();
  const ch = data.channels.find((c) => c.channel_id === active);
  $('view').hidden = false;

  $('statPending').textContent = ch.pending_posts;
  $('statNew').textContent = `+${ch.new_comments}`;
  $('statLast').textContent = fmt(ch.last_capture_at);
  const s = schedule(ch);
  $('statSchedule').textContent = s.text;
  $('statSchedule').classList.toggle('due', s.due);

  for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('on', b.dataset.filter === filter);
  const posts = visiblePosts(ch);
  $('posts').replaceChildren(...posts.map(postRow));
  $('empty').hidden = posts.length > 0;
  $('empty').textContent = filter === 'pending' && !$('search').value
    ? 'All caught up. No posts with new comments in this window.'
    : 'No posts match.';
  $('openNext').disabled = !ch.posts.some((p) => p.pending);
}

// Open posts in one Instagram tab, in post view (/p/...): reels opened by their /reel/
// link show a pop-up comment panel instead of the comments beside the post.
async function openPost(url) {
  const code = /instagram\.com\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  const target = code ? `https://www.instagram.com/p/${code}/` : url;
  if (captureTab !== null) {
    try { await chrome.tabs.update(captureTab, { url: target, active: true }); return; } catch { captureTab = null; }
  }
  captureTab = (await chrome.tabs.create({ url: target })).id;
}

async function refresh() {
  if (!(await loadSettings())) {
    $('status').textContent = 'Add the project URL and capture key to start.';
    $('settings').showModal();
    return;
  }
  $('status').textContent = 'Loading…';
  $('refresh').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'queue', days: Number($('days').value) });
  $('refresh').disabled = false;
  if (!res.ok) { $('status').textContent = `Could not load: ${res.error}`; return; }
  data = res.data;
  $('status').textContent = `Updated ${fmt(data.generated_at)}. Comment counts come from the collector at 06:00 and 18:00 Sri Lanka time.`;
  render();
}

$('days').value = prefs.get('days', '7');
$('sort').value = prefs.get('sort', 'new');
$('refresh').addEventListener('click', refresh);
$('days').addEventListener('change', () => { prefs.set('days', $('days').value); refresh(); });
$('sort').addEventListener('change', () => { prefs.set('sort', $('sort').value); render(); });
$('search').addEventListener('input', () => data && render());
for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => { filter = b.dataset.filter; prefs.set('filter', filter); render(); });
}
$('openNext').addEventListener('click', () => {
  const ch = data?.channels.find((c) => c.channel_id === active);
  const next = ch && ch.posts.find((p) => p.pending);
  if (next) openPost(next.url);
});
$('openSettings').addEventListener('click', () => { loadSettings(); $('settings').showModal(); });
$('closeSettings').addEventListener('click', () => $('settings').close());
$('settingsForm').addEventListener('submit', async () => {
  await chrome.storage.local.set({ baseUrl: $('baseUrl').value.trim(), captureKey: $('captureKey').value.trim() });
  refresh();
});
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'captured') refresh(); });
refresh();
