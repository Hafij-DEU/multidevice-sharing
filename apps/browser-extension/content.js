// MeshDrop Handoff: where this page is (scroll, a nearby line of text, the video's time), and taking a
// page back to that spot when it was opened from another device.
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;

  /** The video most likely being watched: playing first, then the largest on screen. */
  function mainVideo() {
    const vids = [...document.querySelectorAll('video')].filter((v) => v.duration > 0);
    vids.sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return vids[0] ?? null;
  }

  /** A few words of the first text block at the top of the screen (for scroll-to-text on the phone). */
  function topText() {
    const els = document.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, td');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 40 || r.top > innerHeight * 0.6 || r.height === 0) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 20) continue;
      return t.split(' ').slice(0, 8).join(' ').slice(0, 80);
    }
    return '';
  }

  function snapshot() {
    const v = mainVideo();
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    return {
      url: location.href,
      title: document.title.slice(0, 200),
      scroll: Math.min(1, Math.max(0, scrollY / max)),
      text: topText(),
      ...(v ? { time: Math.floor(v.currentTime), playing: !v.paused } : {}),
      at: Date.now(),
    };
  }

  api.runtime.onMessage.addListener((m, _s, reply) => {
    if (m?.type === 'snapshot') reply(snapshot());
    else if (m?.type === 'restore') {
      restore(m);
      reply(true);
    }
    return false;
  });

  /** Opened from another device: same scroll, same video second (a few tries while the page loads). */
  function restore(m) {
    let tries = 0;
    const go = () => {
      tries++;
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      if (typeof m.scroll === 'number' && m.scroll > 0) scrollTo({ top: m.scroll * max });
      const v = mainVideo();
      if (v && typeof m.time === 'number' && m.time > 0 && Math.abs(v.currentTime - m.time) > 2) v.currentTime = m.time;
      if (tries < 8 && (!v || (typeof m.scroll === 'number' && m.scroll > 0 && max < 2))) setTimeout(go, 700);
    };
    go();
  }

  // a playing video keeps MeshDrop's idea of "where you are" fresh
  setInterval(() => {
    if (document.visibilityState === 'visible' && mainVideo() && !mainVideo().paused) api.runtime.sendMessage({ type: 'state', state: snapshot() }).catch?.(() => {});
  }, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') api.runtime.sendMessage({ type: 'state', state: snapshot() }).catch?.(() => {});
  });
})();
