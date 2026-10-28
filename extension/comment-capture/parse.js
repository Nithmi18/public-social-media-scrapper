// Reads the comments currently loaded on an Instagram post page.
// Instagram's class names change often, so this keys on things that are stable:
// each comment's timestamp links to /p/<shortcode>/c/<comment id>/ (replies add
// /r/<reply id>/) and wraps a <time datetime>, and the author is a /<username>/ link.
// Only what is loaded is read: expand "View replies" and scroll first for more.
(function (root) {
  const COMMENT_LINK = /\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)\/c\/(\d+)(?:\/r\/(\d+))?/;
  const PROFILE_LINK = /^\/([A-Za-z0-9._]{1,30})\/?$/;
  // Button and label text that sits inside a comment's block but is not the comment.
  const NOISE = /^(reply|see translation|see original|hide (all )?replies|[-—–\s]*view (all )?(\d+ )?(more )?repl(y|ies).*|liked by.*|\d[\d,.]*\s*[kKmM]?\s*likes?|\d+\s*[smhdwy]|edited|verified|author|pinned|•)$/i;

  function shortcodeFromPath(path) {
    const m = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(path);
    return m ? m[1] : null;
  }

  function commentIdsIn(el) {
    const ids = new Set();
    for (const a of el.querySelectorAll('a[href*="/c/"]')) {
      const m = COMMENT_LINK.exec(a.getAttribute('href') || '');
      if (m) ids.add(m[3] || m[2]);
    }
    return ids;
  }

  function parseLikes(el) {
    for (const node of el.querySelectorAll('span, button, div[role="button"]')) {
      const m = /^([\d,.]+)\s*([kKmM]?)\s+likes?$/.exec(node.textContent.trim());
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        return Math.round(n * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
      }
    }
    return null;
  }

  function parseComments(doc, shortcode) {
    const out = new Map();
    for (const link of doc.querySelectorAll('a[href*="/c/"]')) {
      const m = COMMENT_LINK.exec(link.getAttribute('href') || '');
      if (!m || m[1] !== shortcode) continue;
      const id = m[3] || m[2];
      if (out.has(id)) continue;
      const time = link.querySelector('time[datetime]');
      if (!time) continue;

      // Widen from the timestamp link to the largest block holding only this comment.
      let box = link;
      while (box.parentElement && box.parentElement !== doc.body) {
        const ids = commentIdsIn(box.parentElement);
        if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
        box = box.parentElement;
      }

      let author = null;
      for (const a of box.querySelectorAll('a[href]')) {
        const p = PROFILE_LINK.exec(a.getAttribute('href'));
        if (p && a !== link) { author = p[1]; break; }
      }

      let text = '';
      for (const span of box.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
        if (span.closest('a') || span.querySelector('span[dir="auto"], div[dir="auto"]')) continue;
        const t = span.textContent.trim();
        if (!t || t === author || NOISE.test(t)) continue;
        if (t.length > text.length) text = t;
      }
      if (!text) continue;

      out.set(id, {
        external_id: id,
        parent_external_id: m[3] ? m[2] : null,
        author_display_name: author,
        text_content: text,
        likes: parseLikes(box),
        published_at: time.getAttribute('datetime'),
      });
    }
    return [...out.values()];
  }

  root.CommentParser = { parseComments, shortcodeFromPath };
})(typeof window !== 'undefined' ? window : globalThis);
