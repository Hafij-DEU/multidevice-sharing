// The watch party page (M12), the same in the app and in any browser. No framework.
// Sync: the server keeps one state {source, position at updatedAt, playing, rate}; this page measures
// its clock offset to the server and keeps its player where the state says, correcting drift (see
// syncStep). What the viewer does on the player (play, pause, seek, speed) becomes a command, but only
// when it differs from the room's state, so applying the room's own changes never echoes back.

/**
 * One drift correction, run in the page (kept as source so tests run the same code). `drift` is
 * seconds the player is behind the room (negative: ahead). A video a little out of step plays up to
 * 10% faster or slower until it is back; far out (2 s) it jumps. YouTube's speeds come in big steps,
 * so it jumps past half a second. Paused, only the place matters.
 */
export const SYNC_STEP_JS = `function syncStep(drift, playing, kind) {
  const off = Math.abs(drift);
  if (!playing) return { seek: off > 0.4, rate: 1 };
  if (kind === 'video') {
    if (off > 2) return { seek: true, rate: 1 };
    return { seek: false, rate: off < 0.04 ? 1 : Math.round((1 + Math.max(-0.1, Math.min(0.1, drift * 0.4))) * 1000) / 1000 };
  }
  return { seek: off > 0.5, rate: 1 };
}`;

export const WATCH_PAGE = {
  html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch party · MeshDrop</title>
<link rel="stylesheet" href="/w/app.css">
</head>
<body>
<header>
  <span class="brand">Watch party</span>
  <span id="roomname"></span>
  <span class="grow"></span>
  <input id="me" aria-label="Your name" maxlength="40" placeholder="Your name">
  <button id="invite" hidden>Invite · <b id="code"></b></button>
</header>
<main>
  <section id="join" hidden>
    <h1>Join a watch party</h1>
    <p class="muted">Enter the 6-character code the host shared.</p>
    <form id="joinform">
      <input id="joincode" aria-label="Room code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123">
      <button class="primary">Join</button>
    </form>
    <p id="joinerr" class="err" role="alert"></p>
  </section>
  <section id="room" hidden>
    <div class="layout">
      <div class="watch">
        <div id="stage">
          <div id="yt"></div>
          <video id="vid" playsinline controls preload="auto"></video>
          <div id="empty"><p>Nothing playing yet.</p><p class="muted">Paste a YouTube, Google Drive or Dropbox link below, or a link to a video file.</p></div>
          <button id="tap" hidden>▶ Tap to watch together</button>
        </div>
        <form id="linkform" class="bar">
          <input id="link" aria-label="Video link" placeholder="YouTube, Google Drive, Dropbox or video link">
          <button class="primary">Play</button>
          <label id="uploadbtn" class="btn" hidden>Your video…<input id="file" type="file" accept="video/*,audio/*" hidden></label>
        </form>
        <p id="status" class="muted" role="status"></p>
      </div>
      <aside>
        <h2>People</h2>
        <ul id="members"></ul>
        <label id="lockrow" class="row" hidden><input type="checkbox" id="lock"> Only I control playback</label>
        <h2>Chat</h2>
        <ul id="chat"></ul>
        <form id="chatform" class="bar"><input id="msg" aria-label="Message" placeholder="Say something" maxlength="500"><button>Send</button></form>
      </aside>
    </div>
  </section>
  <section id="ended" hidden><h1>The watch party has ended.</h1><p><a href="/w/">Join another</a></p></section>
</main>
<script src="/w/app.js"></script>
</body>
</html>`,
  js: `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const code = (location.pathname.split('/')[2] || '').toUpperCase();
  // one viewer per tab or window (a reload keeps it); the name is remembered across them
  let me = null;
  try { me = sessionStorage.getItem('md-watch-id'); } catch (e) {}
  if (!me) { me = rand(16); try { sessionStorage.setItem('md-watch-id', me); } catch (e) {} }
  const nameBox = $('me');
  nameBox.value = store.get('md-watch-name') || 'Guest ' + rand(3).toUpperCase();
  nameBox.addEventListener('change', () => { store.set('md-watch-name', nameBox.value.trim() || 'Guest'); });

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    $('join').hidden = false;
    $('joincode').focus();
    $('joinform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = $('joincode').value.trim().toUpperCase();
      const r = await fetch('/w/api/' + encodeURIComponent(c)).catch(() => null);
      if (r && r.ok) location.href = '/w/' + c;
      else $('joinerr').textContent = r && r.status === 429 ? 'Too many tries: wait a minute.' : 'No watch party with that code here.';
    });
    return;
  }

  // the host's key arrives in the link's #h= (never sent to the server in the URL), and is kept here
  const hm = /[#&]h=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (hm) { store.set('md-watch-h-' + code, hm[1]); history.replaceState(null, '', location.pathname); }
  const hostKey = store.get('md-watch-h-' + code) || '';
  $('room').hidden = false;
  $('code').textContent = code;
  $('invite').hidden = false;
  $('invite').addEventListener('click', async () => {
    const link = location.origin + '/w/' + code;
    try { await navigator.clipboard.writeText(link); say('Invite link copied: ' + link + '  (code ' + code + ')'); }
    catch (e) { say('Invite: ' + link + '  ·  code ' + code); }
  });

  let offset = 0;
  const serverNow = () => Date.now() + offset;
  async function measureClock() {
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const r = await fetch('/w/api/time').then((x) => x.json()).catch(() => null);
      const t1 = Date.now();
      if (r && t1 - t0 < best) { best = t1 - t0; offset = r.now - (t0 + t1) / 2; }
    }
  }

  let room = null;
  let state = null;
  let isHost = false;
  let unlocked = false;
  const say = (t) => { $('status').textContent = t; };
  const nameOf = (id) => ((room && room.members.find((m) => m.id === id)) || { name: 'Someone' }).name;
  const expected = () => (state.playing ? state.position + ((serverNow() - state.updatedAt) / 1000) * state.rate : state.position);

  async function send(cmd) {
    const r = await fetch('/w/api/' + code + '/cmd', { method: 'POST', headers: { 'content-type': 'application/json', 'x-watch': '1' }, body: JSON.stringify(Object.assign({ m: me, h: hostKey }, cmd)) }).catch(() => null);
    if (!r) { say('Not connected.'); return; }
    if (r.status === 403) { say('Only the host controls playback in this room.'); apply(); }
    else if (r.status === 400) { const j = await r.json().catch(() => ({})); say(j.error === 'bad-link' ? 'That link cannot be played.' : 'That did not work.'); }
  }

  // ---- players: YouTube (IFrame API) or a <video> element, behind one small interface ----
  const vid = $('vid');
  let yt = null, ytReady = false, ytId = null, ytLoading = null;
  function loadYT() {
    if (ytLoading) return ytLoading;
    ytLoading = new Promise((ok) => {
      window.onYouTubeIframeAPIReady = ok;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return ytLoading;
  }
  const player = {
    kind: null,
    ready() { return this.kind === 'video' ? vid.readyState >= 1 : this.kind === 'youtube' ? ytReady : false; },
    time() { return this.kind === 'video' ? vid.currentTime : yt && ytReady ? yt.getCurrentTime() : 0; },
    paused() { return this.kind === 'video' ? vid.paused : !(yt && ytReady && [1, 3].includes(yt.getPlayerState())); },
    play() { if (this.kind === 'video') return vid.play(); if (yt && ytReady) yt.playVideo(); return Promise.resolve(); },
    pause() { if (this.kind === 'video') vid.pause(); else if (yt && ytReady) yt.pauseVideo(); },
    seek(t) { if (this.kind === 'video') vid.currentTime = t; else if (yt && ytReady) yt.seekTo(t, true); },
    rate(r) { if (this.kind === 'video') { if (vid.playbackRate !== r) vid.playbackRate = r; } else if (yt && ytReady && yt.getPlaybackRate() !== r) yt.setPlaybackRate(r); },
  };

  async function load(src) {
    $('empty').hidden = !!src;
    if (!src) { player.kind = null; vid.hidden = true; $('yt').hidden = true; vid.removeAttribute('src'); return; }
    if (src.kind === 'youtube') {
      vid.pause(); vid.hidden = true; vid.removeAttribute('src');
      $('yt').hidden = false;
      player.kind = 'youtube';
      if (ytId === src.id && yt) return;
      ytId = src.id; ytReady = false;
      await loadYT();
      if (yt) { yt.loadVideoById({ videoId: src.id, startSeconds: Math.max(0, expected()) }); if (!state.playing) setTimeout(() => yt.pauseVideo(), 300); ytReady = true; return; }
      yt = new YT.Player('yt', { videoId: src.id, playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin }, events: {
        onReady: () => { ytReady = true; apply(); },
        onStateChange: (e) => onLocal(e.data === 1 ? 'play' : e.data === 2 ? 'pause' : null),
      } });
    } else {
      if (yt && ytReady) yt.pauseVideo();
      $('yt').hidden = true; ytId = null;
      vid.hidden = false;
      player.kind = 'video';
      if (vid.getAttribute('src') !== src.url) { vid.src = src.url; vid.load(); }
    }
  }

  // what the viewer did on the player: a command, unless the room's state already says so.
  // A pause right after we asked the player to play is the browser refusing to autoplay (or a
  // background tab): it must not pause everyone; this viewer gets a "tap to watch" button instead.
  let playAskedAt = 0;
  function onLocal(what) {
    if (!state || !state.source || !player.ready() || document.hidden) return;
    if (what === 'pause' && state.playing && Date.now() - playAskedAt < 4000) { $('tap').hidden = false; return; }
    const t = player.time();
    if (what === 'play' && !(state.playing && Math.abs(t - expected()) < 1.5)) send({ type: 'play', position: t });
    else if (what === 'pause' && (state.playing || Math.abs(t - state.position) > 1)) send({ type: 'pause', position: t });
    else if (what === 'seek' && Math.abs(t - expected()) > 1.5) send({ type: 'seek', position: t });
    else if (what === 'rate' && Math.abs(vid.playbackRate - nudgedTo) > 1e-3 && vid.playbackRate !== state.rate) send({ type: 'rate', rate: vid.playbackRate });
  }
  vid.addEventListener('play', () => onLocal('play'));
  vid.addEventListener('pause', () => onLocal('pause'));
  vid.addEventListener('seeked', () => onLocal('seek'));
  vid.addEventListener('ratechange', () => onLocal('rate'));
  vid.addEventListener('loadedmetadata', () => apply());
  vid.addEventListener('error', () => { if (state && state.source && player.kind === 'video') say('This video cannot be played here (a private Drive or Dropbox file, or a format this browser does not play).'); });

  // keep the player where the room is
  ${SYNC_STEP_JS}
  // a YouTube jump takes a moment to play again: it learns how far ahead to jump
  let ytLead = 0, ytSeekAt = 0;
  let nudgedTo = 1;
  function apply() {
    if (!state || !state.source || !player.ready()) return;
    const want = expected();
    const drift = want - player.time();
    const running = state.playing && !player.paused();
    const step = syncStep(drift, running, player.kind);
    nudgedTo = state.rate * step.rate;
    player.rate(nudgedTo);
    if (step.seek && running && player.kind === 'youtube') {
      if (Date.now() - ytSeekAt < 6000) ytLead = Math.max(0, Math.min(2, ytLead + drift));
      ytSeekAt = Date.now();
      player.seek(want + ytLead);
    } else if (step.seek) player.seek(want);
    if (state.playing && player.paused()) {
      playAskedAt = Date.now();
      const p = player.play();
      if (p && p.catch) p.catch(() => { $('tap').hidden = false; });
      if (player.kind === 'youtube' && !unlocked) setTimeout(() => { if (player.paused() && state.playing) $('tap').hidden = false; }, 1500);
    } else if (!state.playing && !player.paused()) player.pause();
  }
  setInterval(apply, 500);
  // read-only view for tests and troubleshooting (where this player is, against the room)
  window.meshdropWatch = { time: () => player.time(), paused: () => player.paused(), kind: () => player.kind, expected: () => (state ? expected() : 0), state: () => state };
  $('tap').addEventListener('click', () => { unlocked = true; $('tap').hidden = true; apply(); });
  document.addEventListener('pointerdown', () => { unlocked = true; }, { once: true });

  function setState(s, quiet) {
    const was = state;
    state = s;
    if (!quiet && was && s.by && s.by !== me) {
      const who = nameOf(s.by);
      if (!was.source || (s.source && JSON.stringify(s.source) !== JSON.stringify(was.source))) say(who + ' put on ' + (s.source ? s.source.title : 'nothing'));
      else if (s.playing !== was.playing) say(who + (s.playing ? ' pressed play' : ' paused'));
      else if (s.rate !== was.rate) say(who + ' set the speed to ' + s.rate + 'x');
      else say(who + ' jumped to ' + Math.floor(s.position / 60) + ':' + String(Math.floor(s.position % 60)).padStart(2, '0'));
    }
    if (!was || JSON.stringify(was.source) !== JSON.stringify(s.source)) load(s.source).then(apply);
    else apply();
  }

  function members(list) {
    room.members = list;
    const ul = $('members');
    ul.textContent = '';
    for (const m of list) {
      const li = document.createElement('li');
      li.textContent = m.name + (m.id === me ? ' (you)' : '');
      if (m.host) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'host'; li.appendChild(b); }
      ul.appendChild(li);
    }
  }
  function chatLine(c) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = c.name + ' ';
    li.appendChild(b);
    li.appendChild(document.createTextNode(c.text));
    $('chat').appendChild(li);
    $('chat').scrollTop = 1e9;
  }

  function connect() {
    const q = new URLSearchParams({ m: me, n: nameBox.value.trim() || 'Guest' });
    if (hostKey) q.set('h', hostKey);
    const es = new EventSource('/w/api/' + code + '/events?' + q);
    es.addEventListener('hello', (e) => {
      const h = JSON.parse(e.data);
      offset = h.now - Date.now();
      measureClock();
      room = h; isHost = h.host;
      $('roomname').textContent = h.name;
      $('uploadbtn').hidden = !isHost;
      $('lockrow').hidden = !isHost;
      $('lock').checked = h.hostOnly;
      members(h.members);
      $('chat').textContent = '';
      h.chat.forEach(chatLine);
      setState(h.state, true);
      say(isHost ? 'You are the host. Share the code ' + code + ' or the invite link.' : 'Joined. Everyone sees the same moment.');
    });
    es.addEventListener('state', (e) => setState(JSON.parse(e.data)));
    es.addEventListener('members', (e) => members(JSON.parse(e.data)));
    es.addEventListener('chat', (e) => chatLine(JSON.parse(e.data)));
    es.addEventListener('room', (e) => { room.hostOnly = JSON.parse(e.data).hostOnly; $('lock').checked = room.hostOnly; say(room.hostOnly ? 'Only the host controls playback now.' : 'Everyone can control playback.'); });
    es.addEventListener('ended', () => { es.close(); $('room').hidden = true; $('ended').hidden = false; if (yt && ytReady) yt.pauseVideo(); vid.pause(); });
    es.onerror = () => { if (es.readyState === 2) { say('Connection lost: retrying…'); setTimeout(connect, 3000); } else say('Reconnecting…'); };
    return es;
  }
  let es = connect();
  nameBox.addEventListener('change', () => { es.close(); es = connect(); });

  $('linkform').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('link').value.trim();
    if (!url) return;
    unlocked = true;
    send({ type: 'source', url });
    $('link').value = '';
  });
  $('lock').addEventListener('change', () => send({ type: 'hostOnly', on: $('lock').checked }));
  $('chatform').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('msg').value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    $('msg').value = '';
  });
  $('file').addEventListener('change', () => {
    const f = $('file').files[0];
    if (!f) return;
    const x = new XMLHttpRequest();
    x.open('POST', '/w/api/' + code + '/upload?' + new URLSearchParams({ m: me, h: hostKey, name: f.name }));
    x.setRequestHeader('x-watch', '1');
    x.upload.onprogress = (e) => { if (e.lengthComputable) say('Sharing ' + f.name + ': ' + Math.floor((e.loaded / e.total) * 100) + '%'); };
    x.onload = () => say(x.status === 201 ? f.name + ' is ready for everyone.' : 'Could not share the video (' + x.status + ').');
    x.onerror = () => say('Could not share the video.');
    x.send(f);
    $('file').value = '';
  });
})();`,
  css: `:root { color-scheme: light dark; font-family: system-ui, sans-serif; --accent: #7c3aed; --bg: #f6f4ff; --panel: #fff; --border: #e6e1f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f0d1a; --panel: #1a1729; --border: #2d2842; --accent: #a78bfa; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: CanvasText; }
header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: linear-gradient(135deg, #6366f1, #a855f7 45%, #ec4899); color: #fff; flex-wrap: wrap; }
header .brand { font-weight: 700; }
header .grow { flex: 1; }
header input { width: 140px; padding: 6px 8px; border-radius: 8px; border: 0; font: inherit; }
header button { background: #fff2; color: #fff; border: 1px solid #fff6; }
main { padding: 12px; max-width: 1300px; margin: auto; }
button, .btn { font: inherit; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); color: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.muted { opacity: 0.7; }
.err { color: #ef4444; }
#join { max-width: 420px; margin: 40px auto; text-align: center; }
#joinform { display: flex; gap: 8px; justify-content: center; }
#joincode { font-size: 28px; letter-spacing: 6px; width: 200px; text-align: center; text-transform: uppercase; padding: 8px; border-radius: 10px; border: 1px solid var(--border); }
.layout { display: grid; grid-template-columns: 1fr 300px; gap: 12px; }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
#stage { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9; }
#stage video, #stage #yt, #stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; }
#empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: #fff; padding: 16px; }
#tap { position: absolute; inset: auto 0 16px; margin: auto; width: max-content; background: var(--accent); color: #fff; border: 0; font-size: 18px; padding: 12px 18px; }
.bar { display: flex; gap: 8px; margin-top: 8px; }
.bar input { flex: 1; min-width: 0; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); font: inherit; background: var(--panel); color: inherit; }
aside { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; min-height: 0; }
aside h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin: 6px 0; }
#members { list-style: none; padding: 0; margin: 0 0 6px; }
#members li { padding: 3px 0; }
.badge { margin-left: 6px; font-size: 11px; background: var(--accent); color: #fff; border-radius: 999px; padding: 1px 6px; }
#chat { list-style: none; padding: 0; margin: 0; flex: 1; overflow: auto; max-height: 42vh; min-height: 120px; }
#chat li { padding: 3px 0; overflow-wrap: anywhere; }
.row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
#ended { text-align: center; margin-top: 60px; }`,
};
