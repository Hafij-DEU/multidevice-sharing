package io.github.hafijbge.meshdrop;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One Wi-Fi network the user saved into MeshDrop (M1). The passphrase lives here only inside the sealed
 * store ({@link WifiVault}) and never reaches the UI: {@link #toView} leaves it out. A profile with a
 * {@code lockBssid} pins the network to one access point so the firmware cannot roam to a slower band
 * ("band lock"); {@code fallback} adds a second, unpinned suggestion for when that AP is out of range.
 *
 * <p>MeshDrop only ever stores networks the user adds here by hand. Android exposes no API to read other
 * apps' or the system's saved Wi-Fi passwords, so nothing in this module tries to.
 */
final class WifiProfile {
    String id;
    String ssid;
    /** "open", "wpa2" or "wpa3". */
    String security = "wpa2";
    /** The passphrase (empty for open networks). Stays in the sealed store, never sent to the UI. */
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
    /** Reserved for M3 (eduroam / 802.1X): the EAP-config XML. Unused for now. */
    String eapXml;

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
        p.eapXml = str(m.get("eapXml"));
        return p;
    }

    /** What the renderer gets: metadata only, never the passphrase. */
    Map<String, Object> toView() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ssid", ssid);
        m.put("security", security);
        m.put("hasPassword", psk != null && !psk.isEmpty());
        m.put("lockBssid", lockBssid);
        m.put("band", band);
        m.put("fallback", fallback);
        m.put("hidden", hidden);
        m.put("priority", (long) priority);
        m.put("updatedAt", updatedAt);
        m.put("enterprise", eapXml != null && !eapXml.isEmpty());
        return m;
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }
}
