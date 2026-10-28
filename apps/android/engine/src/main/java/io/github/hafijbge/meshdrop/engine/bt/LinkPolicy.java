package io.github.hafijbge.meshdrop.engine.bt;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The No Wi-Fi settings (M14): Bluetooth on/off, everything over Bluetooth, and a per-device mode:
 * auto (LAN, else Bluetooth, else hub), wifi (never Bluetooth) or bt (only Bluetooth).
 */
public final class LinkPolicy {
    public static final String AUTO = "auto";
    public static final String WIFI = "wifi";
    public static final String BT = "bt";
    public static final LinkPolicy DEFAULT = new LinkPolicy(true, false, Collections.<String, String>emptyMap());

    public final boolean bluetooth;
    public final boolean allBluetooth;
    public final Map<String, String> deviceLinks;

    public LinkPolicy(boolean bluetooth, boolean allBluetooth, Map<String, String> deviceLinks) {
        this.bluetooth = bluetooth;
        this.allBluetooth = allBluetooth;
        Map<String, String> m = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : deviceLinks.entrySet()) if (isMode(e.getValue())) m.put(e.getKey(), e.getValue());
        this.deviceLinks = Collections.unmodifiableMap(m);
    }

    public static boolean isMode(String m) {
        return AUTO.equals(m) || WIFI.equals(m) || BT.equals(m);
    }

    /** The mode for one device ("wifi" whenever Bluetooth is off). */
    public String mode(String deviceId) {
        if (!bluetooth) return WIFI;
        if (allBluetooth) return BT;
        String m = deviceLinks.get(deviceId);
        return m == null ? AUTO : m;
    }
}
