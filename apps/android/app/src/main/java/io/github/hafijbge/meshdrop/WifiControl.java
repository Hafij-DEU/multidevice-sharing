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
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

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

    WifiControl(Activity activity, Core core) {
        this.activity = activity;
        this.wifi = (WifiManager) core.app.getSystemService(Context.WIFI_SERVICE);
        this.store = new WifiStore(new File(core.home, "wifi-profiles.bin"));
    }

    // ---- M1: storage ----------------------------------------------------------------------------

    List<Object> list() {
        List<Object> out = new ArrayList<>();
        for (WifiProfile p : store.load()) out.add(p.toView());
        return out;
    }

    Map<String, Object> save(Map<?, ?> args) throws IOException {
        String ssid = str(args.get("ssid"));
        if (ssid == null || ssid.isEmpty()) throw new IllegalArgumentException("Type the network name (SSID).");
        String security = normalizeSecurity(str(args.get("security")));
        boolean open = "open".equals(security);
        String psk = args.get("password") == null ? null : str(args.get("password"));
        String id = str(args.get("id"));

        if (!open) {
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
        p.psk = open ? "" : psk;
        p.lockBssid = normBssid(str(args.get("lockBssid")));
        p.band = str(args.get("band"));
        p.fallback = Boolean.TRUE.equals(args.get("fallback"));
        p.hidden = Boolean.TRUE.equals(args.get("hidden"));
        if (args.get("priority") instanceof Number) p.priority = ((Number) args.get("priority")).intValue();
        p.updatedAt = now;
        store.save(all);
        return p.toView();
    }

    void delete(String id) throws IOException {
        List<WifiProfile> all = store.load();
        all.removeIf(e -> e.id != null && e.id.equals(id));
        store.save(all);
    }

    private WifiProfile byId(String id) {
        if (id == null) return null;
        for (WifiProfile e : store.load()) {
            if (id.equals(e.id)) return e;
        }
        return null;
    }

    // ---- M2: apply ------------------------------------------------------------------------------

    /** Registers suggestions for the given profile ids (or all, when empty), replacing MeshDrop's set. */
    Map<String, Object> apply(List<?> ids) {
        List<WifiProfile> all = store.load();
        List<WifiNetworkSuggestion> suggestions = new ArrayList<>();
        int profiles = 0;
        boolean canLock = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        for (WifiProfile p : all) {
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
            default:
                return "error " + status + ".";
        }
    }
}
