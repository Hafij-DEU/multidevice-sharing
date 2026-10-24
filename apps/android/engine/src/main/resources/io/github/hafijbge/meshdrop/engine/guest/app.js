(function () {
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
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.resolve(null);
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

  // After a network error: ask again with growing pauses until the device answers (or the link ends).
  function resync(id, i, wait) {
    return sleep(wait).then(function () {
      return api('offers/' + id).then(checked).then(function (r) { return r.json(); }).then(function (s) {
        return s.files[i].received;
      });
    }).catch(function (e) {
      if (over || !(e instanceof TypeError)) throw e;
      return resync(id, i, Math.min(wait * 2, 15000));
    });
  }

  // Sent means saved: wait until the device reports the whole offer as done (or failed).
  function waitSaved(id) {
    return api('offers/' + id).then(checked).then(function (r) { return r.json(); }).then(function (s) {
      if (s.status === 'done') return;
      if (s.status === 'failed') throw new Error("the owner's device could not save the files");
      if (s.status === 'rejected') throw new Error('declined by the owner');
      return sleep(500).then(function () { return waitSaved(id); });
    }, function (e) {
      if (over || !(e instanceof TypeError)) throw e;
      return sleep(2000).then(function () { return waitSaved(id); });
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
          if (over || !(e instanceof TypeError)) throw e; // only network errors are retried
          status('Connection lost, retrying…', 'muted');
          return resync(id, i, 1000).then(function (n) {
            received = n;
            status('Sending…', '');
            return step();
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
        return upload(id, files, s, 0, total).then(function () { return waitSaved(id); }).then(function () {
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
