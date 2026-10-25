// The room board page (M11 room mode): a plain page any phone or laptop browser on the Wi-Fi opens
// from the room's QR. No framework: it lists posts, shows photos, posts files, and polls.
export const ROOM_PAGE = {
  html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeshDrop room</title>
<link rel="stylesheet" href="/r/app.css">
</head>
<body data-token="{{TOKEN}}">
<header><h1 id="title">Room</h1><p id="left" class="muted"></p></header>
<main>
  <section class="post">
    <input id="by" placeholder="Your name" maxlength="40">
    <label class="pick">Add photos or files<input id="files" type="file" multiple hidden></label>
    <p id="status" class="muted" role="status"></p>
  </section>
  <ul id="posts"></ul>
  <p id="empty" class="muted">Nothing here yet. Add the first photo!</p>
</main>
<script src="/r/app.js"></script>
</body>
</html>`,
  js: `(() => {
  const token = document.body.dataset.token;
  const api = '/r/api/' + token + '/posts';
  const $ = (id) => document.getElementById(id);
  const by = $('by');
  try { by.value = localStorage.getItem('meshdrop-room-name') || ''; } catch (e) {}
  by.addEventListener('change', () => { try { localStorage.setItem('meshdrop-room-name', by.value); } catch (e) {} });
  const size = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  let shown = '';
  async function load() {
    let r;
    try { r = await fetch(api); } catch (e) { return; }
    if (r.status === 410 || r.status === 404) { $('left').textContent = 'This room has ended.'; $('files').disabled = true; return; }
    const j = await r.json();
    $('title').textContent = j.title;
    const min = Math.max(0, Math.round((j.expiresAt - Date.now()) / 60000));
    $('left').textContent = 'Open for ' + (min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60) + ' min' : min + ' min') + ' more · everyone here sees what is posted';
    const sig = j.posts.map((p) => p.id).join(',');
    if (sig === shown) return;
    shown = sig;
    const ul = $('posts');
    ul.textContent = '';
    $('empty').hidden = j.posts.length > 0;
    for (const p of j.posts) {
      const li = document.createElement('li');
      if (p.image) {
        const img = document.createElement('img');
        img.src = api + '/' + p.id + '?inline=1';
        img.alt = p.name;
        img.loading = 'lazy';
        li.appendChild(img);
      }
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = p.name + ' · ' + size(p.size) + ' · ' + p.by;
      const a = document.createElement('a');
      a.href = api + '/' + p.id;
      a.textContent = 'Download';
      a.setAttribute('download', p.name);
      row.appendChild(name);
      row.appendChild(a);
      li.appendChild(row);
      ul.appendChild(li);
    }
  }
  $('files').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const [i, f] of files.entries()) {
      $('status').textContent = 'Posting ' + (i + 1) + ' of ' + files.length + '…';
      const q = new URLSearchParams({ name: f.name, by: by.value || 'Someone' });
      const r = await fetch(api + '?' + q, { method: 'POST', headers: { 'x-room': '1' }, body: f }).catch(() => null);
      if (!r || r.status !== 201) { $('status').textContent = r && r.status === 413 ? f.name + ' is too large (200 MB at most).' : 'Could not post ' + f.name + '.'; return; }
    }
    $('status').textContent = files.length ? 'Posted.' : '';
    e.target.value = '';
    load();
  });
  load();
  setInterval(load, 3000);
})();`,
  css: `:root { color-scheme: light dark; font-family: system-ui, sans-serif; --accent: #7c3aed; }
body { margin: 0; background: Canvas; color: CanvasText; }
header { padding: 16px; background: linear-gradient(135deg, #6366f1, #a855f7 45%, #ec4899); color: #fff; }
header h1 { margin: 0; font-size: 20px; }
header .muted { color: #fffc; margin: 4px 0 0; }
main { padding: 12px 16px; max-width: 720px; margin: auto; }
.muted { opacity: 0.7; }
.post { display: grid; gap: 8px; margin-bottom: 12px; }
.post input { padding: 10px; border-radius: 10px; border: 1px solid #8884; font: inherit; }
.pick { display: block; text-align: center; padding: 14px; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
#posts { list-style: none; padding: 0; display: grid; gap: 12px; }
#posts li { border: 1px solid #8884; border-radius: 12px; overflow: hidden; }
#posts img { display: block; width: 100%; max-height: 420px; object-fit: contain; background: #0001; }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; align-items: center; }
.row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row a { color: var(--accent); font-weight: 600; text-decoration: none; }`,
};
