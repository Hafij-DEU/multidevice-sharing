# MeshDrop M9: The Phone Works Without the PC — Implementation Plan

> Lean mode (owner): executed natively, GitHub CI + CodeQL check the pushed work.

**Goal:** Sending over the internet, and holding files for an offline device, keep working while the main PC (the hub) is off. Phones can make internet links too.

**Owner's words:**
- "Phone works without the PC: today, sending over the internet and holding files for an offline device need the PC on. A second hub (a cheap VPS, or a backup PC) would cover times the main PC is off."
- "Internet links from the phone: today only the hub PC can make them."

## Decisions (Claude's calls)

**Relay hubs, not a second root.**
- The main hub keeps the mesh root key and stays the only membership authority: joins, revokes, recovery.
- A relay hub is an ordinary member (joined with an invite) that the main hub marks as a relay. It runs the same hub server **without the root key**:
  - authenticated links;
  - relay;
  - held files;
  - the directory;
  - internet links.
- A VPS never holds a key that could change who is in the mesh.
- What a relay sees is what the main hub sees: envelopes, held ciphertext, link ciphertext.
- Cost if wrong: joining a new device or revoking one still needs the main PC.

**The relay list is a separate signed document.**
- The membership list validates keys strictly, so older apps would reject a new field.
- Instead the main hub signs `{v:1, mesh, version, issuedAt, relays:[{deviceId, urls}]}` with the root key (domain `meshdrop-relays-v1`).
- It sends the list as a control message `{t:'relays', s}` on welcome and on every change. Relays pass the same signed document on.
- Clients keep it in `<home>/relays.json`. Older apps ignore the unknown message.

**Failover order on the device.**
1. The main hub: LAN pinned first, then its URLs, as today.
2. When a whole pass over the main hub fails, try each relay's URLs. Before trusting a relay:
   - its `hello` must name a relay from the signed list;
   - its `welcome` must be signed by that relay's member key.
3. While on a relay, try the main hub again every 5 minutes. Once it answers, move back.

**Draining.** Files a relay held for a device are fetched by that device: after linking to the main hub, and every 10 minutes, it opens a short link to each relay. The relay delivers held sessions on connect, as hubs already do, and the device closes the link when it goes quiet.

**The relay hub runs inside the normal engine.**
- When the signed relay list names this device, the engine starts the hub server in relay mode:
  - on its ingress port;
  - reachable through the existing Internet access modes (port forward + DuckDNS + Let's Encrypt suits a VPS: no NAT).
- The relay's own HubClient stays linked to the main hub when that is up, and the membership updates it receives are pushed to its own links.
- Headless on a VPS: `meshdrop listen` (systemd user service) with the CLI `meshdrop join <invite>`.

**Main hub UI:** Mesh → Relay hubs. Mark a member as a relay and enter its public `wss://` URL(s), or remove it.

**Internet links from members (M9b).**
- A member device encrypts the link itself, with the same chunk format and key-in-fragment, and uploads only ciphertext over its hub link:
  - control `{t:'link-create', meta}`;
  - binary upload frames with the encrypted manifest and chunks;
  - `{t:'link-done'}`.
- The hub (main or relay) stores it in its LinkStore as the owner's link and serves `/l/<id>`.
- The password goes to the hub over the authenticated TLS link and is stored as scrypt, as today.
- List and revoke work over control messages for the owner's own links.
- No visitor uploads on member-made links: the hub cannot decrypt them for a device that is away. Cost if wrong: phone links are download-only.

## Tasks

1. **Signed relay list.** `mesh/relays.ts`: sign, verify, store; and the same in Java. Tests: signature, version order, a wrong root.
2. **Hub server in relay mode.**
   - `rootKey` becomes optional. Without it, joins, invites and revokes answer "not on a relay hub".
   - Membership arrives from outside (`setMembership(s)` pushes it to the links).
   - The server sends the relay list on welcome.
3. **HubClient failover and drain (Node).**
   - Targets: main, then relays.
   - Accept a relay hub, back off to main every 5 min, drain links.
   - Test: three engines (main hub, relay, two members). Stop the main hub: both members fail over and send through the relay; a held file is delivered after the main returns.
4. **Engine + desktop.**
   - The main hub: `relaysSet([{deviceId, urls}])`, pushed to everyone. A device named as a relay runs the relay server.
   - The Mesh page: a Relay hubs section; the status line names the hub a device is linked to.
5. **Java HubClient** failover, relay acceptance, relay list store, drain. Test against a Node main hub + Node relay.
6. **Member links (M9b).**
   - Node hub routes `link-create` / upload / `link-list` / `link-revoke`.
   - Java and Node member clients.
   - The phone's Guests page gets Internet links.
   - Tests: a Java phone makes a link through a Node hub, and a browser-side decrypt (Node) of the downloaded ciphertext matches.
7. **Docs** (README "A hub that is always on", protocol), release 0.4.0.

## Review focus

- A relay can never change membership (no root key; every list it forwards is root-signed).
- A device never trusts a hub that is in neither the membership nor the signed relay list.
- No double delivery when the same session is held on two hubs: the receiver already rejects a finished session (tombstones).
- A member link upload is bounded: the hub's link quota applies, and an unfinished upload is removed.
