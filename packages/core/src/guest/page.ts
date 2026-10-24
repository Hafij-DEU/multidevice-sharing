// The LAN guest page (M5a): one static HTML page, a script and a stylesheet, served by guest/server.ts.
// Plain JavaScript for any phone browser; no framework, no inline script or style (the CSP forbids
// them), and DOM text is only ever set with textContent. Kept as strings here so the desktop bundle
// needs no asset files. The script avoids template literals so it can live inside this one.

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="guest-token" content="{{TOKEN}}">
<title>MeshDrop</title>
<link rel="stylesheet" href="/g/app.css">
</head>
<body>
<main>
  <header>
    <h1>MeshDrop</h1>
    <p class="muted">Sharing with <strong id="owner">…</strong> · <span id="left"></span></p>
  </header>
  <p id="status" role="status"></p>
  <section>
    <h2>Send</h2>
    <label class="pick">Choose files<input id="files" type="file" multiple></label>
    <ul id="chosen" class="list"></ul>
    <textarea id="text" rows="3" maxlength="60000" placeholder="Or type a message"></textarea>
    <button id="send" class="primary" type="button">Send</button>
    <progress id="progress" max="1" value="0" hidden></progress>
  </section>
  <section>
    <h2>Files for you</h2>
    <ul id="shared" class="list"></ul>
    <p id="none" class="muted">Nothing shared yet.</p>
  </section>
</main>
<script src="/g/app.js"></script>
</body>
</html>
`;

const js = `(function () {
  'use strict';
  var token = document.querySelector('meta[name="guest-token"]').getAttribute('content');
  var SLICE = 4 * 1024 * 1024;
  var THUMB_MAX = 48 * 1024;
  var expiresAt = 0;
  var over = false;

  function el(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function size(n) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function status(text, kind) {
    var s = el('status');
    s.textContent = text;
    s.className = kind || '';
  }
  function api(path, opts) {
    opts = opts || {};
    var h = opts.headers || {};
    h['x-guest-token'] = token;
    opts.headers = h;
    opts.credentials = 'same-origin';
    return fetch('/g/api/' + path, opts);
  }
  function end(code) {
    over = true;
    el('send').disabled = true;
    status(code === 'used' ? 'This link was opened in another browser. Ask for a new QR code.' : 'This link has expired. Ask for a new QR code.', 'error');
  }
  function checked(r) {
    if (r.status === 410 || r.status === 404) {
      return r.json().catch(function () { return {}; }).then(function (j) { end(j.error); throw new Error('gone'); });
    }
    return r;
  }

  function tick() {
    if (over) return;
    var left = Math.max(0, expiresAt - Date.now());
    el('left').textContent = left > 0 ? Math.ceil(left / 60000) + ' min left' : 'expired';
    if (left === 0) end('expired');
  }

  function loadSession() {
    return api('session').then(checked).then(function (r) { return r.json(); }).then(function (s) {
      el('owner').textContent = s.owner;
      expiresAt = s.expiresAt;
      tick();
    });
  }

  function loadShared() {
    return api('shared').then(checked).then(function (r) { return r.json(); }).then(function (list) {
      var ul = el('shared');
      ul.replaceChildren();
      el('none').hidden = list.length > 0;
      list.forEach(function (f) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '/g/api/shared/' + encodeURIComponent(f.id) + '?t=' + encodeURIComponent(token);
        a.setAttribute('download', f.name);
        a.textContent = f.name;
        var s = document.createElement('span');
        s.className = 'muted';
        s.textContent = ' ' + size(f.size);
        li.appendChild(a);
        li.appendChild(s);
        ul.appendChild(li);
      });
    });
  }

  function thumb(file) {
    if (!/^image\\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 96 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var d = c.toDataURL('image/jpeg', 0.7);
        resolve(d.length <= THUMB_MAX ? d : null);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function showChosen() {
    var ul = el('chosen');
    ul.replaceChildren();
    Array.prototype.forEach.call(el('files').files, function (f) {
      var li = document.createElement('li');
      li.textContent = f.name + ' · ' + size(f.size);
      ul.appendChild(li);
    });
  }

  function waitAnswer(id) {
    return api('offers/' + id).then(checked).then(function (r) { return r.json(); }).then(function (s) {
      if (s.status === 'pending') return sleep(1000).then(function () { return waitAnswer(id); });
      return s;
    });
  }

  function putSlice(id, i, offset, blob) {
    return api('offers/' + id + '/' + i + '?offset=' + offset, { method: 'PUT', body: blob }).then(checked).then(function (r) {
      return r.json().then(function (j) {
        if (r.ok) return j.received;
        if (r.status === 409 && typeof j.received === 'number') return j.received; // resume at the server's offset
        throw new Error(j.error || ('HTTP ' + r.status));
      });
    });
  }

  function upload(id, files, state, done, total) {
    var p = el('progress');
    var i = 0;
    function nextFile() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i];
      var received = state.files[i].received;
      function step() {
        p.value = total ? (done + received) / total : 1;
        if (received >= f.size) { done += f.size; i++; return nextFile(); }
        return putSlice(id, i, received, f.slice(received, received + SLICE)).then(function (n) {
          received = n;
          return step();
        }, function (e) {
          if (over) throw e;
          status('Connection lost, retrying…', 'muted');
          return sleep(2000).then(function () {
            return api('offers/' + id).then(checked).then(function (r) { return r.json(); }).then(function (s) {
              received = s.files[i].received;
              status('Sending…', '');
              return step();
            });
          });
        });
      }
      return step();
    }
    return nextFile();
  }

  function send() {
    var files = Array.prototype.slice.call(el('files').files);
    var text = el('text').value;
    if (files.length === 0 && text.trim() === '') { status('Choose files or type a message first.', 'error'); return; }
    el('send').disabled = true;
    status('Preparing…', '');
    Promise.all(files.map(thumb)).then(function (thumbs) {
      var offer = { files: files.map(function (f, k) {
        var o = { name: f.name, size: f.size };
        if (f.type) o.type = f.type;
        if (thumbs[k]) o.thumb = thumbs[k];
        return o;
      }) };
      if (text.trim() !== '') offer.text = text;
      return api('offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(offer) }).then(checked);
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error === 'too-many' ? 'Wait until the owner answers your earlier sends.' : (j.error || ('HTTP ' + r.status)));
        return j.id;
      });
    }).then(function (id) {
      status('Waiting for the owner to accept…', 'muted');
      return waitAnswer(id).then(function (s) {
        if (s.status === 'rejected') { status('Declined by the owner.', 'error'); return; }
        var total = files.reduce(function (n, f) { return n + f.size; }, 0);
        el('progress').hidden = files.length === 0;
        status('Sending…', '');
        return upload(id, files, s, 0, total).then(function () {
          el('progress').value = 1;
          status('Sent.', 'ok');
          el('files').value = '';
          el('text').value = '';
          showChosen();
        });
      });
    }).catch(function (e) {
      if (!over) status(e.message === 'gone' ? 'This link has expired.' : 'Could not send: ' + e.message, 'error');
    }).then(function () {
      if (!over) el('send').disabled = false;
    });
  }

  el('files').addEventListener('change', showChosen);
  el('send').addEventListener('click', send);
  loadSession().then(loadShared).catch(function () {});
  setInterval(function () { if (!over) loadShared().catch(function () {}); tick(); }, 5000);
})();
`;

const css = `:root { color-scheme: light dark; --fg: #111; --bg: #fafafa; --muted: #666; --card: #fff; --accent: #2563eb; --err: #b91c1c; --ok: #15803d; }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #111; --muted: #9a9a9a; --card: #1b1b1b; --accent: #60a5fa; --err: #f87171; --ok: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 560px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0; }
h2 { font-size: 1.05rem; margin: 0 0 8px; }
section { background: var(--card); border-radius: 12px; padding: 16px; margin: 16px 0; }
.muted { color: var(--muted); }
.error { color: var(--err); }
.ok { color: var(--ok); }
.list { list-style: none; padding: 0; margin: 8px 0; word-break: break-word; }
.list li { padding: 6px 0; border-bottom: 1px solid rgba(128, 128, 128, .2); }
.pick { display: inline-block; padding: 10px 14px; border: 1px dashed var(--muted); border-radius: 8px; cursor: pointer; }
.pick input { display: block; margin-top: 6px; max-width: 100%; }
textarea { width: 100%; margin: 8px 0; padding: 8px; font: inherit; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .4); background: transparent; color: inherit; }
button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; cursor: pointer; }
button.primary { background: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
progress { width: 100%; margin-top: 10px; }
a { color: var(--accent); }
`;

export const GUEST_PAGE = { html, js, css } as const;
