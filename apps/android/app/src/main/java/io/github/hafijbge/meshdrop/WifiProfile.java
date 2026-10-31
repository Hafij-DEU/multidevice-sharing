package io.github.hafijbge.meshdrop;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One Wi-Fi network the user saved into MeshDrop (M1, extended in M3 for 802.1X / eduroam). Secrets —
 * the passphrase and the enterprise password — live here only inside the sealed store ({@link WifiVault})
 * and never reach the UI: {@link #toView} leaves them out. A profile with a {@code lockBssid} pins the
 * network to one access point so the firmware cannot roam to a slower band ("band lock"); {@code fallback}
 * adds a second, unpinned suggestion for when that AP is out of range.
 *
 * <p>MeshDrop only ever stores networks the user adds here by hand. Android exposes no API to read other
 * apps' or the system's saved Wi-Fi passwords, so nothing in this module tries to.
 */
final class WifiProfile {
    String id;
    String ssid;
    /** "open", "wpa2", "wpa3" or "enterprise" (WPA2-EAP, e.g. eduroam). */
    String security = "wpa2";
    /** The passphrase (empty for open and enterprise networks). Stays in the sealed store. */
    String psk = "";
    /** Lowercase AP MAC to pin, or null to let Android pick any AP for this SSID. */
    String lockBssid;
    /** "2.4", "5" or "6": the band of the pinned AP, shown in the UI; null when not pinned. */
    String band;
    /** Also add an opposite-band AP (no pin, lower priority) so the device still joins when out of range. */
    boolean fallback;
    boolean hidden;
    int priority = 2;
    long createdAt;
    long updatedAt;
    /** Delete tombstone (M5): when the user removed this network, so the delete syncs to their other
     *  devices instead of the network reappearing from one that still has it. 0 while the network is live. */
    long deletedAt;

    // ---- M3: 802.1X / eduroam (only used when security == "enterprise") --------------------------
    /** EAP method: "peap", "ttls", "tls" or "pwd". */
    String eapMethod = "peap";
    /** Inner (phase 2) method: "mschapv2", "gtc", "pap" or "none". */
    String phase2 = "mschapv2";
    /** The user's username / login (e.g. user@realm). Not a secret, shown in the UI. */
    String identity = "";
    /** Outer/anonymous identity sent in the clear (e.g. anonymous@realm), optional. */
    String anonymousIdentity = "";
    /** The enterprise password. A secret: stays in the sealed store, never sent to the UI. */
    String eapPassword = "";
    /** CA certificate (PEM) used to verify the RADIUS server, optional. Not secret. */
    String caCertPem = "";
    /** Server-name match (e.g. "eduroam.example.edu"), guards against rogue APs. Not secret. */
    String domainSuffixMatch = "";
    /** The raw eap-config / CAT XML this profile was imported from, kept for re-import. Optional. */
    String eapXml;

    boolean isEnterprise() {
        return "enterprise".equals(security);
    }

    /** True once the user deleted this network: kept as a tombstone only so the delete can sync. */
    boolean deleted() {
        return deletedAt > 0;
    }

    Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ssid", ssid);
        m.put("security", security);
        m.put("psk", psk);
        m.put("lockBssid", lockBssid);
        m.put("band", band);
        m.put("fallback", fallback);
        m.put("hidden", hidden);
        m.put("priority", (long) priority);
        m.put("createdAt", createdAt);
        m.put("updatedAt", updatedAt);
        m.put("deletedAt", deletedAt);
        m.put("eapMethod", eapMethod);
        m.put("phase2", phase2);
        m.put("identity", identity);
        m.put("anonymousIdentity", anonymousIdentity);
        m.put("eapPassword", eapPassword);
        m.put("caCertPem", caCertPem);
        m.put("domainSuffixMatch", domainSuffixMatch);
        m.put("eapXml", eapXml);
        return m;
    }

    static WifiProfile fromMap(Map<?, ?> m) {
        WifiProfile p = new WifiProfile();
        p.id = str(m.get("id"));
        p.ssid = str(m.get("ssid"));
        if (m.get("security") != null) p.security = str(m.get("security"));
        p.psk = m.get("psk") == null ? "" : str(m.get("psk"));
        p.lockBssid = str(m.get("lockBssid"));
        p.band = str(m.get("band"));
        p.fallback = Boolean.TRUE.equals(m.get("fallback"));
        p.hidden = Boolean.TRUE.equals(m.get("hidden"));
        if (m.get("priority") instanceof Number) p.priority = ((Number) m.get("priority")).intValue();
        if (m.get("createdAt") instanceof Number) p.createdAt = ((Number) m.get("createdAt")).longValue();
        if (m.get("updatedAt") instanceof Number) p.updatedAt = ((Number) m.get("updatedAt")).longValue();
        if (m.get("deletedAt") instanceof Number) p.deletedAt = ((Number) m.get("deletedAt")).longValue();
        if (m.get("eapMethod") != null) p.eapMethod = str(m.get("eapMethod"));
        if (m.get("phase2") != null) p.phase2 = str(m.get("phase2"));
        p.identity = m.get("identity") == null ? "" : str(m.get("identity"));
        p.anonymousIdentity = m.get("anonymousIdentity") == null ? "" : str(m.get("anonymousIdentity"));
        p.eapPassword = m.get("eapPassword") == null ? "" : str(m.get("eapPassword"));
        p.caCertPem = m.get("caCertPem") == null ? "" : str(m.get("caCertPem"));
        p.domainSuffixMatch = m.get("domainSuffixMatch") == null ? "" : str(m.get("domainSuffixMatch"));
        p.eapXml = str(m.get("eapXml"));
        return p;
    }

    /** What the renderer gets: metadata only, never the passphrase or the enterprise password. */
    Map<String, Object> toView() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ssid", ssid);
        m.put("security", security);
        m.put("hasPassword", (psk != null && !psk.isEmpty()) || (eapPassword != null && !eapPassword.isEmpty()));
        m.put("lockBssid", lockBssid);
        m.put("band", band);
        m.put("fallback", fallback);
        m.put("hidden", hidden);
        m.put("priority", (long) priority);
        m.put("updatedAt", updatedAt);
        m.put("enterprise", isEnterprise());
        if (isEnterprise()) {
            m.put("eapMethod", eapMethod);
            m.put("phase2", phase2);
            m.put("identity", identity);
            m.put("anonymousIdentity", anonymousIdentity);
            m.put("domainSuffixMatch", domainSuffixMatch);
            m.put("hasCaCert", caCertPem != null && !caCertPem.isEmpty());
        }
        return m;
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }
}
