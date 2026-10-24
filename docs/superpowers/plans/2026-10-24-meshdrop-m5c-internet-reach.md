# MeshDrop M5c: Internet Reach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Lean mode (owner): no review subagent; GitHub CI and CodeQL check the pushed branch.

**Goal:** The hub PC becomes reachable from the internet in one of two ways, chosen in the app:
- **(a) Tunnel:** Tailscale Funnel, or a Cloudflare named tunnel, through the installed CLI.
- **(b) Port forward:**
  - UPnP or NAT-PMP, or a port the owner forwards by hand;
  - a DuckDNS name;
  - a Let's Encrypt certificate obtained over DNS-01 through DuckDNS;
  - a public HTTPS listener.

The app checks which way can work (CGNAT detection) and suggests it. The resulting `wss://` URL becomes the hub URL in the membership list, so devices and internet links use it.

**Spec:**
- §3 goal 4 (two modes; detect and suggest);
- §8 "Hub reachability";
- §12 owner answers 1 and 2:
  - both tunnel providers, driving the installed CLIs, with no quick tunnels;
  - CGNAT detection by comparing the router's WAN address with the public IP;
  - port-forward built in full, with DuckDNS first and Let's Encrypt.

## Global Constraints

- **Branch and commits:** branch `m5c-internet-reach` from `m5b-internet-links`; same commit identity and trailer.
- **External programs:** run with `execFile` (no shell), through an injectable `Runner` so tests use fakes.
  - Nothing is installed or logged in by the app: a missing CLI or a logged-out account is reported with the exact command the owner must run.
- **Network calls (all owner-initiated):**
  - **Public-IP check:** `https://api.ipify.org`, with `https://ifconfig.me/ip` as fallback. Both URLs are configurable, and each is called only when the owner presses "Check".
  - **DuckDNS:** `https://www.duckdns.org/update`.
  - **ACME:** `https://acme-v02.api.letsencrypt.org/directory`, with the staging URL as an option.
- **Secrets:** the DuckDNS token, ACME account key and certificate key go in `<home>/reach/` (mode 0600). They never appear in events, logs or the app state; the state shows only `tokenSet: true`.
- **Public listener** (port-forward mode):
  - TLS 1.3 + 1.2 with the Let's Encrypt certificate, internal port configurable (default 53322);
  - serves exactly the ingress: the `/mesh/v1/hub` WebSocket and `/l/` links;
  - certificate renewal 30 days before expiry, checked daily.
- **CGNAT detection:**
  - **Router WAN address:** from UPnP `GetExternalIPAddress` or NAT-PMP.
  - **CGNAT:** if the WAN address is in `100.64.0.0/10` or private ranges, or differs from the public IP, port-forward cannot work, and the app says so and suggests a tunnel.

## Tasks

1. **Runner and tunnel drivers.** `src/reach/tunnel.ts`.
   - **Tailscale:**
     - `tailscale status --json` gives `Self.DNSName` and `BackendState`;
     - enable runs `tailscale funnel --bg --https=443 http://127.0.0.1:<ingress>`;
     - disable runs `tailscale funnel --https=443 off`.
   - **Cloudflare:**
     - `cloudflared tunnel list --output json`;
     - `cloudflared tunnel create meshdrop` if missing;
     - `cloudflared tunnel route dns meshdrop <host>`;
     - a supervised child `cloudflared tunnel run --url http://127.0.0.1:<ingress> meshdrop`, restarted with backoff.
   - Test with fake CLIs (scripts on `PATH`) for every state: missing, logged out, ok, failure.
2. **NAT traversal.** `src/reach/nat.ts`.
   - **UPnP IGD:** SSDP discovery, the device description, then `GetExternalIPAddress`, `AddPortMapping` and `DeletePortMapping` over SOAP.
   - **NAT-PMP:** external address and TCP mapping; the gateway comes from `/proc/net/route`.
   - Test against a fake IGD (HTTP + SSDP on loopback) and a fake NAT-PMP server (UDP).
3. **Detection and DuckDNS.** `src/reach/detect.ts`, `src/reach/duckdns.ts`.
   - `detect()` → `{ wanIp?, publicIp?, cgnat: boolean, upnp: boolean, natpmp: boolean, suggestion: 'tunnel' | 'port-forward' }`.
   - `duckdnsUpdate(domain, token, ip?, txt?)`.
   - Test with fake endpoints.
4. **ACME (RFC 8555) over DNS-01 through DuckDNS.** `src/reach/acme.ts`.
   - The JWS uses ES256.
   - Flow: account → order → authorization → the TXT record set through DuckDNS → challenge → finalize with a CSR built from scratch with `node:crypto` and our DER helpers → download the certificate.
   - Test against a fake ACME server in the test (directory, nonce, account, order, authz, challenge, finalize, cert), checking JWS signatures.
5. **Public HTTPS listener and reach manager.** `src/reach/manager.ts`, the engine wiring, `HubServer.attachPublic(server)`.
   - Modes: `off | tailscale | cloudflare | port-forward`.
   - When up, the hub URL `wss://<host>[:port]/mesh/v1/hub` is set in the list through `setHubUrls`.
   - Renewal timer.
   - Engine API `reachStatus()`, `reachDetect()`, `reachSet(config)`.
   - Test with fakes end to end: a port-forward mode with a fake ACME and IGD gives an HTTPS listener whose certificate the test trusts, and a WebSocket to `/mesh/v1/hub` over it works.
6. **Desktop.** On the Mesh page, the hub gets an "Internet access" section:
   - Detect, then a suggestion;
   - pick a mode;
   - per-mode fields: Cloudflare hostname, DuckDNS domain and token, ports;
   - the status line and errors with the exact command to fix them.
   - CLI: `meshdrop hub reach [status|detect|tailscale|cloudflare <host>|port-forward <domain> --token-file F|off]`.
   - Tests: controller cases with a fake runner.
7. **Docs.** README "Reach your PC from anywhere", and protocol notes.

## Rulings made while planning

- **Fakes only in tests.** No real Tailscale, Cloudflare, router, DuckDNS or Let's Encrypt can be exercised here. The drivers follow the documented CLI and protocols, and real-device checks are for the owner. Cost if wrong: a CLI output format drift shows up only on a real machine.
- **DNS-01 through DuckDNS** rather than HTTP-01, because DNS-01 needs no port 80 forward. Cost if wrong: owners of other DNS providers can't get a certificate yet.
- **Cloudflared runs as a child of the app/listener** (not a system service). Cost if wrong: the tunnel is down while MeshDrop is not running, which is when the hub is unreachable anyway.
