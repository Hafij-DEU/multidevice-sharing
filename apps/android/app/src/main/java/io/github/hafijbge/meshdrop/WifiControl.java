package io.github.hafijbge.meshdrop;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.MacAddress;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiEnterpriseConfig;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.util.Xml;

import io.github.hafijbge.meshdrop.engine.app.AppController;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.StringReader;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserException;

/**
 * M1 + M2 of the Wi-Fi module. Stores the user's networks encrypted ({@link WifiStore}) and applies them
 * as {@link WifiNetworkSuggestion}s. A profile with a {@code lockBssid} pins one access point so the
 * firmware cannot roam to a slower band; an optional fallback adds a second, unpinned suggestion for when
 * that AP is out of range. Pinning needs Android 11 (API 30); below that the network is still saved and
 * suggested, just not band-locked.
 *
 * <p>Nothing here reads other apps' or the system's saved Wi-Fi passwords — Android exposes no such API.
 * Every passphrase comes from the user typing it into MeshDrop's own Wi-Fi tab.
 */
final class WifiControl {
    private final Activity activity;
    private final WifiManager wifi;
    private final WifiStore store;
    private final AppController controller;

    WifiControl(Activity activity, Core core) {
        this.activity = activity;
        this.wifi = (WifiManager) core.app.getSystemService(Context.WIFI_SERVICE);
        this.store = new WifiStore(new File(core.home, "wifi-profiles.bin"));
        this.controller = core.controller;
        this.controller.setWifiSyncHook(this::onWifiSync); // M5: receive syncs from the user's own devices
    }

    // ---- M1: storage ----------------------------------------------------------------------------

    List<Object> list() {
        List<Object> out = new ArrayList<>();
        for (WifiProfile p : store.load()) {
            if (!p.deleted()) out.add(p.toView()); // tombstones are kept only to sync the delete
        }
        return out;
    }

    synchronized Map<String, Object> save(Map<?, ?> args) throws IOException {
        String ssid = str(args.get("ssid"));
        String security = normalizeSecurity(str(args.get("security")));
        boolean open = "open".equals(security);
        boolean enterprise = "enterprise".equals(security);
        String id = str(args.get("id"));

        // An eap-config / CAT XML (e.g. a geteduroam download) fills in the enterprise defaults.
        Map<String, String> eap = null;
        if (enterprise) {
            String xml = str(args.get("eapXml"));
            if (xml != null && !xml.trim().isEmpty()) eap = importEapConfig(xml);
            if ((ssid == null || ssid.isEmpty()) && eap != null) ssid = eap.get("ssid");
        }
        if (ssid == null || ssid.isEmpty()) throw new IllegalArgumentException("Type the network name (SSID).");

        String psk = args.get("password") == null ? null : str(args.get("password"));
        if (!open && !enterprise) {
            if (psk == null || psk.isEmpty()) {
                WifiProfile existing = byId(id); // leave the field blank on edit to keep the old passphrase
                psk = existing == null ? null : existing.psk;
            }
            if (psk == null || psk.length() < 8 || psk.length() > 63) {
                throw new IllegalArgumentException("Type the Wi-Fi password (8–63 characters).");
            }
        }

        List<WifiProfile> all = store.load();
        WifiProfile p = null;
        if (id != null) {
            for (WifiProfile e : all) {
                if (id.equals(e.id)) {
                    p = e;
                    break;
                }
            }
        }
        long now = System.currentTimeMillis();
        if (p == null) {
            p = new WifiProfile();
            p.id = UUID.randomUUID().toString();
            p.createdAt = now;
            all.add(p);
        }
        p.ssid = ssid;
        p.security = security;
        p.psk = (open || enterprise) ? "" : psk;
        p.lockBssid = normBssid(str(args.get("lockBssid")));
        p.band = str(args.get("band"));
        p.fallback = Boolean.TRUE.equals(args.get("fallback"));
        p.hidden = Boolean.TRUE.equals(args.get("hidden"));
        if (args.get("priority") instanceof Number) p.priority = ((Number) args.get("priority")).intValue();
        if (enterprise) applyEnterprise(p, args, eap);
        p.updatedAt = now;
        p.deletedAt = 0; // saving revives a network even if an old tombstone shared its id
        store.save(all);
        pushToPeers(); // M5: keep the user's other devices in step
        return p.toView();
    }

    /** Fills a profile's 802.1X fields from the user's input, using an imported eap-config as defaults. */
    private void applyEnterprise(WifiProfile p, Map<?, ?> args, Map<String, String> eap) {
        p.eapMethod = firstNonEmpty(str(args.get("eapMethod")), get(eap, "eapMethod"), p.eapMethod, "peap");
        p.phase2 = firstNonEmpty(str(args.get("phase2")), get(eap, "phase2"), p.phase2, "mschapv2");
        p.anonymousIdentity = orEmpty(firstNonEmpty(
                str(args.get("anonymousIdentity")), get(eap, "anonymousIdentity"), p.anonymousIdentity, ""));
        p.domainSuffixMatch = orEmpty(firstNonEmpty(
                str(args.get("domainSuffixMatch")), get(eap, "domainSuffixMatch"), p.domainSuffixMatch, ""));
        p.caCertPem = orEmpty(firstNonEmpty(
                str(args.get("caCertPem")), get(eap, "caCertPem"), p.caCertPem, ""));
        String xml = str(args.get("eapXml"));
        if (xml != null && !xml.trim().isEmpty()) p.eapXml = xml;

        String identity = str(args.get("identity"));
        if (identity == null || identity.isEmpty()) identity = p.identity; // keep old on blank edit
        if (identity == null || identity.isEmpty()) {
            throw new IllegalArgumentException("Type your eduroam / 802.1X username.");
        }
        p.identity = identity;

        String pw = str(args.get("password"));
        if (pw == null || pw.isEmpty()) pw = str(args.get("eapPassword"));
        if (pw == null || pw.isEmpty()) pw = p.eapPassword; // keep old on blank edit
        if (!"tls".equals(p.eapMethod) && (pw == null || pw.isEmpty())) {
            throw new IllegalArgumentException("Type your eduroam / 802.1X password.");
        }
        p.eapPassword = pw == null ? "" : pw;
    }

    synchronized void delete(String id) throws IOException {
        List<WifiProfile> all = store.load();
        long now = System.currentTimeMillis();
        boolean hit = false;
        for (WifiProfile e : all) {
            if (e.id != null && e.id.equals(id) && !e.deleted()) {
                // Keep a tombstone (M5) so the delete syncs; drop the secrets it no longer needs.
                e.deletedAt = now;
                e.updatedAt = now;
                e.psk = "";
                e.eapPassword = "";
                hit = true;
            }
        }
        all.removeIf(p -> p.deleted() && now - p.deletedAt > TOMBSTONE_TTL_MS);
        store.save(all);
        if (hit) pushToPeers();
    }

    private WifiProfile byId(String id) {
        if (id == null) return null;
        for (WifiProfile e : store.load()) {
            if (id.equals(e.id)) return e;
        }
        return null;
    }

    // ---- M5: sync the user's networks across their own trusted devices ---------------------------
    //
    // The networks travel the mesh's pinned mutual-TLS link between the user's own trusted devices
    // (the same channel as remote control, LAN or hub), carrying the passphrases so a synced network
    // actually connects. At rest each device re-seals them with its own WifiVault key, so a plaintext
    // profile never touches the disk. No other app's or the system's networks are involved: only the
    // ones the user typed into MeshDrop here.

    private static final String SYNC_KIND = "wifi-sync";
    private static final int SYNC_TIMEOUT_MS = 12_000;
    /** Drop a delete tombstone once it is this old; by then every device has long since caught up. */
    private static final long TOMBSTONE_TTL_MS = 60L * 24 * 60 * 60 * 1000;

    /** An incoming "wifi-sync" message from one of the user's trusted devices (on an engine thread). */
    private Map<String, Object> onWifiSync(String peer, Map<String, Object> msg) {
        Map<String, Object> out = new LinkedHashMap<>();
        String op = str(msg.get("op"));
        try {
            if ("pull".equals(op)) {
                out.put("profiles", exportAll());
            } else if ("push".equals(op)) {
                int merged = msg.get("profiles") instanceof List ? merge((List<?>) msg.get("profiles")) : 0;
                out.put("merged", (long) merged);
            } else {
                out.put("error", "bad-op");
                return out;
            }
            out.put("ok", true);
        } catch (IOException | RuntimeException e) {
            out.put("error", e.getMessage() == null ? "sync-failed" : e.getMessage());
        }
        return out;
    }

    /** Every stored profile as a full map, secrets included: this travels only the pinned TLS mesh link. */
    private List<Object> exportAll() {
        List<Object> out = new ArrayList<>();
        for (WifiProfile p : store.load()) out.add(p.toMap());
        return out;
    }

    /**
     * Merges profiles received from another of the user's devices: for each id the newer timestamp wins,
     * and a delete tombstone removes a network the other device dropped. Returns how many local entries
     * changed. {@link WifiStore} keeps everything sealed at rest.
     */
    private synchronized int merge(List<?> incoming) throws IOException {
        List<WifiProfile> all = store.load();
        Map<String, WifiProfile> byId = new LinkedHashMap<>();
        for (WifiProfile p : all) {
            if (p.id != null) byId.put(p.id, p);
        }
        int changed = 0;
        long now = System.currentTimeMillis();
        for (Object it : incoming) {
            if (!(it instanceof Map)) continue;
            WifiProfile in = WifiProfile.fromMap((Map<?, ?>) it);
            if (in.id == null || in.id.isEmpty() || in.ssid == null) continue;
            WifiProfile cur = byId.get(in.id);
            long inStamp = Math.max(in.updatedAt, in.deletedAt);
            long curStamp = cur == null ? -1 : Math.max(cur.updatedAt, cur.deletedAt);
            if (cur == null) {
                if (in.deleted() && now - in.deletedAt > TOMBSTONE_TTL_MS) continue; // a stale tombstone for a network we never had
                byId.put(in.id, in);
                all.add(in);
                changed++;
            } else if (inStamp > curStamp) {
                copyInto(cur, in);
                changed++;
            }
        }
        if (changed > 0) {
            all.removeIf(p -> p.deleted() && now - p.deletedAt > TOMBSTONE_TTL_MS); // prune old tombstones
            store.save(all);
        }
        return changed;
    }

    /** Copies every synced field from one profile onto another, keeping the destination object's identity. */
    private static void copyInto(WifiProfile dst, WifiProfile src) {
        dst.ssid = src.ssid;
        dst.security = src.security;
        dst.psk = src.psk;
        dst.lockBssid = src.lockBssid;
        dst.band = src.band;
        dst.fallback = src.fallback;
        dst.hidden = src.hidden;
        dst.priority = src.priority;
        if (src.createdAt > 0) dst.createdAt = src.createdAt;
        dst.updatedAt = src.updatedAt;
        dst.deletedAt = src.deletedAt;
        dst.eapMethod = src.eapMethod;
        dst.phase2 = src.phase2;
        dst.identity = src.identity;
        dst.anonymousIdentity = src.anonymousIdentity;
        dst.eapPassword = src.eapPassword;
        dst.caCertPem = src.caCertPem;
        dst.domainSuffixMatch = src.domainSuffixMatch;
        dst.eapXml = src.eapXml;
    }

    /** Full two-way sync with every trusted device the user has, on demand ("Sync to my devices"). */
    Map<String, Object> syncNow() {
        List<String> peers = controller.trustedWifiPeers();
        int reached = 0;
        int mergedIn = 0;
        int pushedTo = 0;
        for (String peer : peers) {
            try {
                Map<String, Object> pull = new LinkedHashMap<>();
                pull.put("kind", SYNC_KIND);
                pull.put("op", "pull");
                Map<String, Object> r = controller.wifiSend(peer, pull, SYNC_TIMEOUT_MS);
                reached++;
                Object body = r == null ? null : r.get("body");
                if (body instanceof Map && ((Map<?, ?>) body).get("profiles") instanceof List) {
                    mergedIn += merge((List<?>) ((Map<?, ?>) body).get("profiles"));
                }
                Map<String, Object> push = new LinkedHashMap<>();
                push.put("kind", SYNC_KIND);
                push.put("op", "push");
                push.put("profiles", exportAll());
                controller.wifiSend(peer, push, SYNC_TIMEOUT_MS);
                pushedTo++;
            } catch (IOException | RuntimeException ignored) {
                // that device is not reachable now; the others still sync
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("devices", (long) peers.size());
        out.put("reached", (long) reached);
        out.put("pushed", (long) pushedTo);
        out.put("merged", (long) mergedIn);
        return out;
    }

    /** After a local change, push our networks to the user's trusted devices, best-effort and off-thread. */
    private void pushToPeers() {
        final List<Object> profiles = exportAll();
        new Thread(() -> {
            Map<String, Object> push = new LinkedHashMap<>();
            push.put("kind", SYNC_KIND);
            push.put("op", "push");
            push.put("profiles", profiles);
            for (String peer : controller.trustedWifiPeers()) {
                try {
                    controller.wifiSend(peer, push, SYNC_TIMEOUT_MS);
                } catch (IOException | RuntimeException ignored) {
                    // offline or busy: the next manual sync, or that device's own pull, catches up
                }
            }
        }, "meshdrop-wifi-push").start();
    }

    // ---- M2: apply ------------------------------------------------------------------------------

    /** Registers suggestions for the given profile ids (or all, when empty), replacing MeshDrop's set. */
    Map<String, Object> apply(List<?> ids) {
        List<WifiProfile> all = store.load();
        List<WifiNetworkSuggestion> suggestions = new ArrayList<>();
        int profiles = 0;
        boolean canLock = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        for (WifiProfile p : all) {
            if (p.deleted()) continue; // a tombstoned network is not suggested
            if (ids != null && !ids.isEmpty() && !ids.contains(p.id)) continue;
            WifiNetworkSuggestion primary = build(p, p.lockBssid, p.priority);
            if (primary == null) continue;
            suggestions.add(primary);
            profiles++;
            if (p.fallback && p.lockBssid != null && canLock) {
                WifiNetworkSuggestion backup = build(p, null, Math.max(0, p.priority - 1));
                if (backup != null) suggestions.add(backup);
            }
        }
        clearSuggestions();
        int status = suggestions.isEmpty()
                ? WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS
                : wifi.addNetworkSuggestions(suggestions);
        // A duplicate means our set is already registered (e.g. a re-apply below API 30, where the old
        // set cannot be read back to clear it first); treat it as success rather than an error.
        if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS
                && status != WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE) {
            throw new IllegalStateException("Android refused the networks: " + addFailure(status));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("profiles", (long) profiles);
        out.put("suggestions", (long) suggestions.size());
        out.put("canLock", canLock);
        return out;
    }

    /** Removes every suggestion MeshDrop registered (the per-app set), undoing the lock. */
    void forget() {
        clearSuggestions();
    }

    /**
     * Removes every Wi-Fi suggestion MeshDrop registered. Reading the current set back needs API 30
     * ({@link WifiManager#getNetworkSuggestions()}); below that, removing an empty list clears this
     * app's whole set.
     */
    private void clearSuggestions() {
        if (wifi == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            List<WifiNetworkSuggestion> old = wifi.getNetworkSuggestions();
            if (!old.isEmpty()) wifi.removeNetworkSuggestions(old);
        } else {
            wifi.removeNetworkSuggestions(new ArrayList<WifiNetworkSuggestion>());
        }
    }

    private WifiNetworkSuggestion build(WifiProfile p, String bssid, int priority) {
        if (p.ssid == null || p.ssid.isEmpty()) return null;
        WifiNetworkSuggestion.Builder b = new WifiNetworkSuggestion.Builder()
                .setSsid(p.ssid)
                .setPriority(Math.max(0, priority));
        if (p.hidden && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setIsHiddenSsid(true);
        if (bssid != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                b.setBssid(MacAddress.fromString(bssid));
            } catch (IllegalArgumentException ignore) {
                // A malformed stored BSSID: fall back to an unpinned suggestion rather than failing.
            }
        }
        switch (p.security == null ? "wpa2" : p.security) {
            case "open":
                break;
            case "enterprise":
                b.setWpa2EnterpriseConfig(buildEnterprise(p));
                break;
            case "wpa3":
                b.setWpa3Passphrase(p.psk);
                break;
            default:
                b.setWpa2Passphrase(p.psk);
                break;
        }
        try {
            return b.build();
        } catch (IllegalStateException e) {
            return null; // an inconsistent combination (e.g. an open network given a passphrase)
        }
    }

    // ---- status + scan --------------------------------------------------------------------------

    @SuppressWarnings("deprecation") // getConnectionInfo is still the simplest live source on API 29–30.
    Map<String, Object> status() {
        Map<String, Object> m = new LinkedHashMap<>();
        boolean on = wifi != null && wifi.isWifiEnabled();
        m.put("enabled", on);
        WifiInfo info = wifi == null ? null : wifi.getConnectionInfo();
        String bssid = info == null ? null : info.getBSSID();
        if (!on || info == null || bssid == null || "02:00:00:00:00:00".equals(bssid) || info.getFrequency() <= 0) {
            m.put("connected", false);
            m.put("locked", !lockedBssids().isEmpty());
            return m;
        }
        int freq = info.getFrequency();
        String bl = bssid.toLowerCase(Locale.US);
        m.put("connected", true);
        m.put("ssid", unquote(info.getSSID()));
        m.put("bssid", bl);
        m.put("freq", (long) freq);
        m.put("band", band(freq));
        m.put("channel", (long) channel(freq));
        m.put("rssi", (long) info.getRssi());
        m.put("linkMbps", (long) info.getLinkSpeed());
        m.put("locked", lockedBssids().contains(bl));
        return m;
    }

    @SuppressLint("MissingPermission") // checked in requireScanPermission() just above the access
    @SuppressWarnings("deprecation") // startScan + ScanResult.SSID still work and are the only app-visible path
    List<Object> scan(String ssid) {
        requireScanPermission();
        wifi.startScan();
        Map<String, Map<String, Object>> byBssid = new LinkedHashMap<>();
        for (ScanResult r : wifi.getScanResults()) {
            String rs = r.SSID;
            if (ssid != null && !ssid.isEmpty() && !ssid.equals(rs)) continue;
            if (r.BSSID == null) continue;
            boolean sae = r.capabilities != null && r.capabilities.contains("SAE");
            boolean psk = r.capabilities != null && r.capabilities.contains("PSK");
            Map<String, Object> ap = new LinkedHashMap<>();
            ap.put("ssid", rs);
            ap.put("bssid", r.BSSID.toLowerCase(Locale.US));
            ap.put("freq", (long) r.frequency);
            ap.put("band", band(r.frequency));
            ap.put("channel", (long) channel(r.frequency));
            ap.put("rssi", (long) r.level);
            ap.put("secure", sae || psk);
            ap.put("wpa3", sae);
            byBssid.put(r.BSSID, ap);
        }
        return new ArrayList<>(byBssid.values());
    }

    private void requireScanPermission() {
        String perm = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.NEARBY_WIFI_DEVICES
                : Manifest.permission.ACCESS_FINE_LOCATION;
        if (activity.checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            activity.runOnUiThread(() -> activity.requestPermissions(new String[] {perm}, 14));
            throw new IllegalStateException(Build.VERSION.SDK_INT >= 33
                    ? "Allow MeshDrop to find nearby Wi-Fi, then scan again."
                    : "Allow MeshDrop to use location (Android needs it to scan Wi-Fi), then scan again.");
        }
    }

    private Set<String> lockedBssids() {
        Set<String> out = new HashSet<>();
        // WifiNetworkSuggestion.getBssid() is API 30; below that no pin exists to read back.
        if (wifi == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return out;
        for (WifiNetworkSuggestion s : wifi.getNetworkSuggestions()) {
            if (s.getBssid() != null) out.add(s.getBssid().toString().toLowerCase(Locale.US));
        }
        return out;
    }

    // ---- band / channel maths (ported from the Band Lock app) -----------------------------------

    private static String band(int freq) {
        if (freq >= 5925) return "6";
        if (freq >= 4900) return "5";
        if (freq > 0) return "2.4";
        return "?";
    }

    private static int channel(int freq) {
        if (freq == 2484) return 14;
        if (freq >= 2412 && freq < 2484) return (freq - 2407) / 5;
        if (freq >= 5925) return (freq - 5950) / 5;
        if (freq >= 4900) return (freq - 5000) / 5;
        return 0;
    }

    private static String unquote(String ssid) {
        if (ssid == null || ssid.equals("<unknown ssid>")) return null;
        if (ssid.length() >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) {
            return ssid.substring(1, ssid.length() - 1);
        }
        return ssid;
    }

    private static String normalizeSecurity(String s) {
        if (s == null) return "wpa2";
        String v = s.toLowerCase(Locale.US);
        if (v.contains("eap") || v.contains("enterprise") || v.contains("802.1x")
                || v.contains("8021x") || v.contains("eduroam")) return "enterprise";
        if (v.contains("3") || v.contains("sae")) return "wpa3";
        if (v.contains("open") || v.contains("none")) return "open";
        return "wpa2";
    }

    private static String normBssid(String s) {
        return s == null || s.isEmpty() ? null : s.toLowerCase(Locale.US);
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static String addFailure(int status) {
        switch (status) {
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_APP_DISALLOWED:
                return "you declined MeshDrop's Wi-Fi earlier (allow it in Settings → Apps → MeshDrop).";
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_INVALID:
                return "the network details are invalid (check the password).";
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_NOT_ALLOWED:
                return "not allowed on this device.";
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE:
                return "a duplicate network.";
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_EXCEEDS_MAX_PER_APP:
                return "too many networks saved.";
            case WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_RESTRICTED_BY_ADMIN:
                return "your device administrator blocked adding Wi-Fi networks.";
            default:
                return "error " + status + ".";
        }
    }

    // ---- M3: 802.1X / eduroam enterprise config -------------------------------------------------

    /** Builds the {@link WifiEnterpriseConfig} for an enterprise profile from its stored fields. */
    private static WifiEnterpriseConfig buildEnterprise(WifiProfile p) {
        WifiEnterpriseConfig eap = new WifiEnterpriseConfig();
        eap.setEapMethod(eapMethodInt(p.eapMethod));
        eap.setPhase2Method(phase2Int(p.phase2));
        if (p.identity != null) eap.setIdentity(p.identity);
        if (p.anonymousIdentity != null && !p.anonymousIdentity.isEmpty()) {
            eap.setAnonymousIdentity(p.anonymousIdentity);
        }
        if (p.eapPassword != null) eap.setPassword(p.eapPassword);
        if (p.domainSuffixMatch != null && !p.domainSuffixMatch.isEmpty()) {
            eap.setDomainSuffixMatch(p.domainSuffixMatch);
        }
        X509Certificate ca = parseCa(p.caCertPem);
        if (ca != null) eap.setCaCertificate(ca);
        return eap;
    }

    private static int eapMethodInt(String m) {
        if (m == null) return WifiEnterpriseConfig.Eap.PEAP;
        switch (m.toLowerCase(Locale.US)) {
            case "ttls": return WifiEnterpriseConfig.Eap.TTLS;
            case "tls": return WifiEnterpriseConfig.Eap.TLS;
            case "pwd": return WifiEnterpriseConfig.Eap.PWD;
            default: return WifiEnterpriseConfig.Eap.PEAP;
        }
    }

    private static int phase2Int(String m) {
        if (m == null) return WifiEnterpriseConfig.Phase2.MSCHAPV2;
        switch (m.toLowerCase(Locale.US)) {
            case "pap": return WifiEnterpriseConfig.Phase2.PAP;
            case "gtc": return WifiEnterpriseConfig.Phase2.GTC;
            case "mschap": return WifiEnterpriseConfig.Phase2.MSCHAP;
            case "none": return WifiEnterpriseConfig.Phase2.NONE;
            default: return WifiEnterpriseConfig.Phase2.MSCHAPV2;
        }
    }

    /** Parses a PEM/base64 CA certificate, or returns null when none is set or it cannot be read. */
    private static X509Certificate parseCa(String pem) {
        if (pem == null || pem.trim().isEmpty()) return null;
        try {
            String body = pem.replace("-----BEGIN CERTIFICATE-----", "")
                    .replace("-----END CERTIFICATE-----", "")
                    .replaceAll("\\s", "");
            byte[] der = Base64.getDecoder().decode(body);
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            return (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception e) {
            return null; // a malformed cert: connect without pinning it rather than failing the save
        }
    }

    /**
     * Best-effort parse of an eduroam CAT / eap-config XML into profile defaults: the outer EAP type, the
     * inner (phase 2) method, the server name, the outer identity and the first CA certificate. The user
     * still supplies their own username and password.
     */
    private static Map<String, String> importEapConfig(String xml) {
        Map<String, String> out = new LinkedHashMap<>();
        StringBuilder ca = new StringBuilder();
        boolean inCa = false;
        boolean caDone = false;
        boolean outerTypeSeen = false;
        try {
            XmlPullParser xp = Xml.newPullParser();
            xp.setInput(new StringReader(xml));
            String path = "";
            String tag = null;
            for (int ev = xp.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = xp.next()) {
                if (ev == XmlPullParser.START_TAG) {
                    tag = xp.getName();
                    path = path + "/" + tag.toLowerCase(Locale.US);
                    if (!caDone && tag.equalsIgnoreCase("ca")) inCa = true;
                } else if (ev == XmlPullParser.END_TAG) {
                    if (inCa && xp.getName().equalsIgnoreCase("ca")) {
                        inCa = false;
                        caDone = true;
                    }
                    int cut = path.lastIndexOf('/');
                    path = cut < 0 ? "" : path.substring(0, cut);
                    tag = null;
                } else if (ev == XmlPullParser.TEXT) {
                    String text = xp.getText();
                    if (text == null) continue;
                    if (inCa) {
                        ca.append(text.replaceAll("\\s", ""));
                        continue;
                    }
                    text = text.trim();
                    if (text.isEmpty() || tag == null) continue;
                    boolean inner = path.contains("innerauthenticationmethod");
                    switch (tag.toLowerCase(Locale.US)) {
                        case "type":
                            if (inner) {
                                out.put("phase2", innerTypeToPhase2(text));
                            } else if (!outerTypeSeen) {
                                out.put("eapMethod", outerTypeToEap(text));
                                outerTypeSeen = true;
                            }
                            break;
                        case "noneapauthentication":
                            out.put("phase2", text.toLowerCase(Locale.US));
                            break;
                        case "serverid":
                            if (!out.containsKey("domainSuffixMatch")) out.put("domainSuffixMatch", text);
                            break;
                        case "outeridentity":
                            out.put("anonymousIdentity", text);
                            break;
                        case "ssid":
                            if (!out.containsKey("ssid")) out.put("ssid", text);
                            break;
                        default:
                            break;
                    }
                }
            }
        } catch (XmlPullParserException | IOException e) {
            // A malformed file: fall back to whatever the user typed by hand.
        }
        if (ca.length() > 0) {
            out.put("caCertPem", "-----BEGIN CERTIFICATE-----\n" + ca + "\n-----END CERTIFICATE-----\n");
        }
        return out;
    }

    /** CAT outer EAP type number to our method name (13=TLS, 21=TTLS, 25=PEAP, 52=PWD). */
    private static String outerTypeToEap(String type) {
        switch (type.trim()) {
            case "13": return "tls";
            case "21": return "ttls";
            case "52": return "pwd";
            case "25":
            default: return "peap";
        }
    }

    /** CAT inner EAP type number to our phase-2 name (26=MSCHAPv2; others default to MSCHAPv2). */
    private static String innerTypeToPhase2(String type) {
        switch (type.trim()) {
            case "26": return "mschapv2";
            default: return "mschapv2";
        }
    }

    private static String firstNonEmpty(String... vals) {
        for (String v : vals) {
            if (v != null && !v.isEmpty()) return v;
        }
        return vals.length == 0 ? null : vals[vals.length - 1];
    }

    private static String get(Map<String, String> m, String key) {
        return m == null ? null : m.get(key);
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }
}
