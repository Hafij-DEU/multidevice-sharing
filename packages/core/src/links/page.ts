// The internet guest link page (M5b). The link key is in the URL fragment (#k=), which browsers never
// send to the server; everything is decrypted here with WebCrypto (AES-256-GCM, links/crypto.ts format).
// No inline script or style (CSP), DOM text via textContent only, no template literals in the script.

/** The format helpers, shared with the test (which runs them against protocol/vectors/link-v1.json). */
export const LINK_CRYPTO_JS = `
var LINK_DOMAIN = 'meshdrop-link-v1';
var LINK_CHUNK = 4 * 1024 * 1024;
var MANIFEST_FILE = 0xffffffff;
var OFFER_FILE = 0xfffffffe;
var UPLOAD_BASE = 0x80000000;
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(b) {
  var s = '';
  for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.prototype.slice.call(b.subarray(i, i + 0x8000)));
  return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
function linkNonce(fileIdx, chunkIdx) {
  var n = new Uint8Array(12);
  var v = new DataView(n.buffer);
  v.setUint32(0, fileIdx >>> 0);
  v.setUint32(4, Math.floor(chunkIdx / 4294967296));
  v.setUint32(8, chunkIdx >>> 0);
  return n;
}
function linkAad(linkId, fileIdx, chunkIdx, last) {
  var enc = new TextEncoder();
  var a = enc.encode(LINK_DOMAIN);
  var b = enc.encode(linkId);
  var out = new Uint8Array(a.length + 1 + b.length + 1 + 13);
  out.set(a, 0);
  out.set(b, a.length + 1);
  var t = a.length + 1 + b.length + 1;
  var v = new DataView(out.buffer);
  v.setUint32(t, fileIdx >>> 0);
  v.setUint32(t + 4, Math.floor(chunkIdx / 4294967296));
  v.setUint32(t + 8, chunkIdx >>> 0);
  out[t + 12] = last ? 1 : 0;
  return out;
}
function linkImportKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
function linkOpen(key, linkId, fileIdx, chunkIdx, last, sealed) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: linkNonce(fileIdx, chunkIdx), additionalData: linkAad(linkId, fileIdx, chunkIdx, last), tagLength: 128 }, key, sealed)
    .then(function (b) { return new Uint8Array(b); });
}
function linkSeal(key, linkId, fileIdx, chunkIdx, last, plain) {
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: linkNonce(fileIdx, chunkIdx), additionalData: linkAad(linkId, fileIdx, chunkIdx, last), tagLength: 128 }, key, plain)
    .then(function (b) { return new Uint8Array(b); });
}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeshDrop</title>
<link rel="stylesheet" href="/l/app.css">
</head>
<body>
<main>
  <header><h1>MeshDrop</h1></header>
  <p id="status" role="status"></p>
  <section id="pw" hidden>
    <h2>Password</h2>
    <input id="password" type="password" autocomplete="off">
    <button id="unlock" class="primary" type="button">Open</button>
  </section>
  <section id="files" hidden>
    <h2>Shared with you</h2>
    <blockquote id="message" hidden></blockquote>
    <ul id="list" class="list"></ul>
  </section>
  <section id="send" hidden>
    <h2>Send files back</h2>
    <label class="pick">Choose files<input id="pick" type="file" multiple></label>
    <textarea id="text" rows="3" placeholder="Or type a message"></textarea>
    <button id="go" class="primary" type="button">Send</button>
    <progress id="progress" max="1" value="0" hidden></progress>
  </section>
</main>
<script src="/l/app.js"></script>
</body>
</html>
`;

const app = `(function () {
  'use strict';
  ${'${LINK_CRYPTO_JS}'}
  var id = location.pathname.split('/')[2];
  var m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  var rawKey = m ? b64urlToBytes(m[1]) : null;
  var key = null;
  var session = null;
  var over = false;
  function el(x) { return document.getElementById(x); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function size(n) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function status(t, kind) { var s = el('status'); s.textContent = t; s.className = kind || ''; }
  var GONE = { 'expired': 'This link has expired.', 'used-up': 'This link has no downloads left.', 'not-found': 'This link was removed or never existed.' };
  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (session) opts.headers['x-link-session'] = session;
    return fetch('/l/' + id + '/api/' + path, opts).then(function (r) {
      if (r.ok) return r;
      return r.json().catch(function () { return {}; }).then(function (j) {
        var e = new Error(j.error || ('HTTP ' + r.status));
        e.code = j.error;
        e.status = r.status;
        if (GONE[j.error]) { over = true; status(GONE[j.error], 'error'); el('files').hidden = true; el('send').hidden = true; }
        throw e;
      });
    });
  }
  function bytes(r) { return r.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }

  function download(i, f) {
    var n = Math.max(1, Math.ceil(f.size / LINK_CHUNK));
    var parts = [];
    var k = 0;
    if (f.size > 1024 * 1024 * 1024) status('Large file: this may need a lot of memory on a phone.', 'muted');
    function next() {
      if (k >= n) {
        var url = URL.createObjectURL(new Blob(parts, { type: f.type || 'application/octet-stream' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        status('Downloaded ' + f.name + '.', 'ok');
        return Promise.resolve();
      }
      return api('chunk/' + i + '/' + k).then(bytes).then(function (sealed) {
        return linkOpen(key, id, i, k, k === n - 1, sealed);
      }).then(function (plain) {
        parts.push(plain);
        k++;
        status('Downloading ' + f.name + ' ' + Math.round((k / n) * 100) + '%', 'muted');
        return next();
      });
    }
    return next();
  }

  function show(man) {
    el('files').hidden = false;
    if (man.text) { el('message').hidden = false; el('message').textContent = man.text; }
    var ul = el('list');
    ul.replaceChildren();
    man.files.forEach(function (f, i) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Download';
      b.addEventListener('click', function () {
        b.disabled = true;
        download(i, f).catch(function (e) { if (!over) status(e.name === 'OperationError' ? 'This file does not decrypt: the link is damaged.' : 'Download failed: ' + e.message, 'error'); })
          .then(function () { b.disabled = false; });
      });
      var name = document.createElement('span');
      name.textContent = f.name + ' · ' + size(f.size) + ' ';
      li.appendChild(name);
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function open(password) {
    return api('open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(password ? { password: password } : {}) })
      .then(function (r) { return r.json(); })
      .then(function (j) { session = j.session; el('pw').hidden = true; return api('manifest'); })
      .then(bytes)
      .then(function (sealed) { return linkOpen(key, id, MANIFEST_FILE, 0, true, sealed); })
      .then(function (plain) { status('', ''); show(JSON.parse(new TextDecoder().decode(plain))); }, function (e) {
        if (e.name === 'OperationError') { status('This link does not open: its key is wrong or incomplete.', 'error'); throw e; }
        if (e.code === 'bad-password') status('Wrong password.', 'error');
        else if (e.code === 'throttled') status('Too many tries: wait a few minutes.', 'error');
        else if (!over) status('Could not open: ' + e.message, 'error');
        throw e;
      });
  }

  // ---- sending back ----------------------------------------------------------------------------
  function sendBack() {
    var files = Array.prototype.slice.call(el('pick').files);
    var text = el('text').value;
    if (files.length === 0 && text.trim() === '') { status('Choose files or type a message first.', 'error'); return; }
    el('go').disabled = true;
    var offer = { files: files.map(function (f) { var o = { name: f.name, size: f.size }; if (f.type) o.type = f.type; return o; }) };
    if (text.trim() !== '') offer.text = text;
    var oid;
    api('key', { method: 'POST', headers: { 'x-link-key': bytesToB64url(rawKey) } })
      .then(function () { return linkSeal(key, id, OFFER_FILE, 0, true, new TextEncoder().encode(JSON.stringify(offer))); })
      .then(function (sealed) { return api('offers', { method: 'POST', body: sealed }); })
      .then(function (r) { return r.json(); })
      .then(function (j) { oid = j.id; status('Waiting for the owner to accept…', 'muted'); return answer(); })
      .then(function (s) {
        if (s.status === 'rejected') throw new Error('declined by the owner');
        el('progress').hidden = files.length === 0;
        return upload(files, s);
      })
      .then(function () { return saved(); })
      .then(function () { status('Sent.', 'ok'); el('pick').value = ''; el('text').value = ''; },
        function (e) { if (!over) status('Could not send: ' + e.message, 'error'); })
      .then(function () { el('go').disabled = false; });

    function answer() {
      return api('offers/' + oid).then(function (r) { return r.json(); }).then(function (s) {
        return s.status === 'pending' ? sleep(1500).then(answer) : s;
      });
    }
    function saved() {
      return api('offers/' + oid).then(function (r) { return r.json(); }).then(function (s) {
        if (s.status === 'done') return;
        if (s.status === 'failed') throw new Error("the owner's device could not save the files");
        if (s.status === 'rejected') throw new Error('declined by the owner');
        return sleep(700).then(saved);
      });
    }
    function upload(files, s) {
      var total = files.reduce(function (n, f) { return n + f.size; }, 0) || 1;
      var done = 0;
      var i = 0;
      function file() {
        if (i >= files.length) return Promise.resolve();
        var f = files[i];
        var off = s.files[i].received - (s.files[i].received % LINK_CHUNK);
        function slice(wait) {
          if (off >= f.size) { done += f.size; i++; return file(); }
          var end = Math.min(f.size, off + LINK_CHUNK);
          return f.slice(off, end).arrayBuffer().then(function (b) {
            return linkSeal(key, id, UPLOAD_BASE + i, off / LINK_CHUNK, end >= f.size, new Uint8Array(b));
          }).then(function (sealed) {
            return api('offers/' + oid + '/' + i + '?offset=' + off, { method: 'PUT', body: sealed });
          }).then(function () {
            off = end;
            el('progress').value = (done + off) / total;
            return slice(1000);
          }, function (e) {
            if (over || !(e instanceof TypeError)) throw e;
            status('Connection lost, retrying…', 'muted');
            return sleep(wait).then(function () { return api('offers/' + oid); }).then(function (r) { return r.json(); }).then(function (st) {
              off = st.files[i].received - (st.files[i].received % LINK_CHUNK);
              status('Sending…', '');
              return slice(1000);
            }, function () { return slice(Math.min(wait * 2, 15000)); });
          });
        }
        return slice(1000);
      }
      return file();
    }
  }

  if (!rawKey || rawKey.length !== 32) { status('This link is missing its key: copy the whole link, including the part after #.', 'error'); return; }
  linkImportKey(rawKey).then(function (k) {
    key = k;
    return api('info').then(function (r) { return r.json(); });
  }).then(function (info) {
    if (info.allowUploads) el('send').hidden = false;
    if (info.needsPassword) {
      el('pw').hidden = false;
      el('unlock').addEventListener('click', function () { open(el('password').value).catch(function () {}); });
      return;
    }
    return open().catch(function () {});
  }).catch(function () {});
  el('go').addEventListener('click', sendBack);
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
textarea, input[type=password] { width: 100%; margin: 8px 0; padding: 8px; font: inherit; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .4); background: transparent; color: inherit; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 0; cursor: pointer; }
button.primary { background: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
blockquote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--muted); white-space: pre-wrap; }
progress { width: 100%; margin-top: 10px; }
`;

export const LINK_PAGE = { html, js: app.replace('${LINK_CRYPTO_JS}', LINK_CRYPTO_JS), css } as const;
