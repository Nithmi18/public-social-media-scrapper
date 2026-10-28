// Adds a "Save comments" button on Instagram post pages. Nothing runs until it is clicked:
// no scrolling, no clicking "View replies", no background visits.
(function () {
  const { parseComments, shortcodeFromPath } = window.CommentParser;
  let button, note, shownFor = null;

  function ensureUi() {
    if (button) return;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:13px system-ui,sans-serif';
    note = document.createElement('div');
    note.style.cssText = 'max-width:260px;padding:8px 10px;border-radius:8px;background:#111;color:#fff;display:none';
    button = document.createElement('button');
    button.textContent = 'Save comments';
    button.style.cssText = 'padding:10px 14px;border:0;border-radius:8px;background:#0a66c2;color:#fff;font-weight:600;cursor:pointer';
    button.addEventListener('click', save);
    box.append(note, button);
    document.documentElement.append(box);
  }

  function say(text) {
    note.textContent = text;
    note.style.display = 'block';
  }

  async function save() {
    const shortcode = shortcodeFromPath(location.pathname);
    if (!shortcode) return;
    const comments = parseComments(document, shortcode);
    if (!comments.length) {
      say('No comments found on the page. Open the comments and let them load, then try again.');
      return;
    }
    button.disabled = true;
    say(`Saving ${comments.length} comments…`);
    const res = await chrome.runtime.sendMessage({ type: 'capture', shortcode, comments });
    button.disabled = false;
    if (res.ok) {
      say(`Saved ${res.data.comments_saved} comments.` +
        (res.data.comments_count_at_capture != null ? ` Collector count: ${res.data.comments_count_at_capture}.` : '') +
        ' Load more or expand replies and save again to add them.');
    } else {
      const why = {
        post_not_collected: 'This post is not in the collector yet (only tracked channels are saved).',
        not_configured: 'Set the backend URL and capture key in the dashboard first.',
        invalid_capture_key: 'The capture key was rejected. Check it in the dashboard.',
      }[res.error];
      say(why || `Could not save: ${res.error}`);
    }
  }

  // Instagram is a single-page app, so watch for navigation to and from post pages.
  setInterval(() => {
    const code = shortcodeFromPath(location.pathname);
    if (code === shownFor) return;
    shownFor = code;
    ensureUi();
    button.parentElement.style.display = code ? 'flex' : 'none';
    note.style.display = 'none';
  }, 1000);
})();
