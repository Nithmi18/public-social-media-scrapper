// Adds a "Save comments" button on Instagram post and reel pages. Nothing is scrolled,
// clicked or visited for you: the page is only read.
// Comments are collected while you browse the post (Instagram removes comments from the
// page as you scroll, and closes the reel comment panel on any outside click), so Save
// sends everything seen on this post, even if the panel has closed since.
(function () {
  const { parseComments, shortcodeFromPath } = window.CommentParser;
  const seen = new Map(); // shortcode -> Map(comment id -> comment)
  let host, button, note, current = null, dirty = true;

  function ensureUi() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .box { display:flex; flex-direction:column; align-items:flex-end; gap:6px; font:13px system-ui,sans-serif; }
        .note { max-width:280px; padding:8px 10px; border-radius:8px; background:#111; color:#fff; display:none; line-height:1.4; }
        .note a { color:#8ab4ff; cursor:pointer; text-decoration:underline; }
        button { padding:10px 14px; border:0; border-radius:8px; background:#0a66c2; color:#fff; font:600 13px system-ui,sans-serif; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.25); }
        button:disabled { opacity:.6; cursor:default; }
      </style>
      <div class="box"><div class="note"></div><button type="button">Save comments</button></div>`;
    note = shadow.querySelector('.note');
    button = shadow.querySelector('button');
    document.documentElement.append(host);
  }

  // Instagram closes the comment panel on any press outside it. Stop presses on our
  // button from reaching the page, before the page's own listeners see them.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click']) {
    window.addEventListener(type, (e) => {
      if (host && e.composedPath().includes(host)) {
        e.stopImmediatePropagation();
        if (type !== 'click') return;
        const path = e.composedPath();
        if (path.some((n) => n.dataset?.postView !== undefined)) location.href = `/p/${current}/`;
        else if (path.includes(button)) save();
      }
    }, true);
  }

  function say(html) {
    note.innerHTML = html;
    note.style.display = 'block';
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function collect() {
    if (!current) return;
    const bucket = seen.get(current) || new Map();
    seen.set(current, bucket);
    for (const c of parseComments(document, current)) bucket.set(c.external_id, c);
    button.textContent = bucket.size ? `Save ${bucket.size} comments` : 'Save comments';
  }

  let saving = false;
  async function save() {
    if (!current || saving) return;
    collect();
    const comments = [...(seen.get(current)?.values() || [])];
    if (!comments.length) {
      const onReel = /\/reels?\//.test(location.pathname);
      say('No comments found yet. Open the comments and let them load, then save.' +
        (onReel ? ` If they still aren't found, <a data-post-view>open this reel in post view</a>.` : ''));
      return;
    }
    saving = true;
    button.disabled = true;
    say(`Saving ${comments.length} comments…`);
    const res = await chrome.runtime.sendMessage({ type: 'capture', shortcode: current, comments })
      .catch(() => ({ ok: false, error: 'extension_reloaded_refresh_this_page' }));
    saving = false;
    button.disabled = false;
    if (res.ok) {
      const d = res.data;
      say(`Saved ${d.comments_saved} comments` +
        (d.comments_stored != null ? ` (${d.comments_stored} stored for this post).` : '.') +
        (d.comments_count_at_capture != null ? ` Instagram's count at the last collection run was ${d.comments_count_at_capture}.` : '') +
        ' Scroll or expand replies and save again to add more.');
    } else {
      const why = {
        post_not_collected: 'This post is not in the collector yet (only tracked channels are saved).',
        not_configured: 'Set the backend URL and capture key in the dashboard first.',
        invalid_capture_key: 'The capture key was rejected. Check it in the dashboard.',
        extension_reloaded_refresh_this_page: 'The extension was updated. Refresh this page and try again.',
      }[res.error];
      say(esc(why || `Could not save: ${res.error}`));
    }
  }

  new MutationObserver(() => { dirty = true; }).observe(document.documentElement, { childList: true, subtree: true });

  // Instagram is a single-page app, so watch for navigation to and from post pages.
  setInterval(() => {
    const code = shortcodeFromPath(location.pathname);
    if (code !== current) {
      current = code;
      dirty = true;
      ensureUi();
      host.style.display = code ? 'block' : 'none';
      note.style.display = 'none';
    }
    if (current && dirty) { dirty = false; collect(); }
  }, 500);
})();
