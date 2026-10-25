const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
(async () => {
  const st = await api.runtime.sendMessage({ type: 'status' });
  if (!st) {
    $('status').textContent = 'The MeshDrop app is not running on this PC.';
    $('status').className = 'err';
    return;
  }
  const phones = st.devices ?? [];
  $('status').textContent = phones.length ? 'Continue this page on:' : 'No phone is reachable right now.';
  for (const d of phones) {
    const b = document.createElement('button');
    b.textContent = d.alias;
    b.addEventListener('click', async () => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      let state = { url: tab.url, title: tab.title, scroll: 0 };
      try {
        state = await api.tabs.sendMessage(tab.id, { type: 'snapshot' });
      } catch {
        /* a page the extension cannot read: the link alone */
      }
      const r = await api.runtime.sendMessage({ type: 'send-to-phone', to: d.deviceId, state });
      $('status').textContent = r ? `Sent to ${d.alias}.` : 'Could not send.';
    });
    $('phones').appendChild(b);
  }
})();
