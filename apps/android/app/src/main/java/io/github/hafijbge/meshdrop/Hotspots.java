package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import io.github.hafijbge.meshdrop.engine.disc.Discovery;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * M14: hotspots for devices with no Wi-Fi network to share. This phone hosts a local-only hotspot
 * (Android picks the name and password, and it has no internet: mobile data is never shared), or
 * joins another device's hotspot through a network request (Android asks the user first).
 */
final class Hotspots {
    private final Context ctx;
    private WifiManager.LocalOnlyHotspotReservation reservation;
    private ConnectivityManager.NetworkCallback joined;

    Hotspots(Context ctx) {
        this.ctx = ctx;
    }

    /** "ssid", "psk" and "ips" (this phone's addresses on the hotspot first). */
    @SuppressWarnings("deprecation")
    synchronized Map<String, Object> host() throws IOException {
        stop();
        WifiManager wifi = ctx.getSystemService(WifiManager.class);
        Set<String> before = addrs();
        CountDownLatch done = new CountDownLatch(1);
        WifiManager.LocalOnlyHotspotReservation[] got = new WifiManager.LocalOnlyHotspotReservation[1];
        int[] failed = {0};
        try {
            wifi.startLocalOnlyHotspot(new WifiManager.LocalOnlyHotspotCallback() {
                @Override
                public void onStarted(WifiManager.LocalOnlyHotspotReservation r) {
                    got[0] = r;
                    done.countDown();
                }

                @Override
                public void onFailed(int reason) {
                    failed[0] = reason;
                    done.countDown();
                }
            }, new Handler(Looper.getMainLooper()));
        } catch (SecurityException e) {
            throw new IOException("Allow MeshDrop to find nearby devices (location on Android 12 and older), then try again.", e);
        } catch (IllegalStateException e) {
            throw new IOException("Turn off this phone's own hotspot or tethering, then try again.", e);
        }
        await(done, 20);
        WifiManager.LocalOnlyHotspotReservation r = got[0];
        if (r == null) {
            switch (failed[0]) {
                case WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL:
                    throw new IOException("No free Wi-Fi channel for a hotspot.");
                case WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE:
                    throw new IOException("Turn off this phone's own hotspot or tethering, then try again.");
                case WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED:
                    throw new IOException("This phone does not allow hotspots.");
                default:
                    throw new IOException("The hotspot did not start." + (Build.VERSION.SDK_INT < 33 ? " Is location turned on?" : ""));
            }
        }
        reservation = r;
        String ssid;
        String psk;
        if (Build.VERSION.SDK_INT >= 30) {
            android.net.wifi.SoftApConfiguration c = r.getSoftApConfiguration();
            ssid = c.getSsid();
            psk = c.getPassphrase();
        } else {
            android.net.wifi.WifiConfiguration c = r.getWifiConfiguration();
            ssid = c == null ? null : c.SSID;
            psk = c == null ? null : c.preSharedKey;
        }
        ssid = unquote(ssid);
        psk = unquote(psk);
        if (ssid == null || ssid.isEmpty() || psk == null || psk.length() < 8) {
            stop();
            throw new IOException("The hotspot started without a name or password MeshDrop can share.");
        }
        // the hotspot's address shows up a moment after it starts
        List<String> fresh = new ArrayList<>();
        for (int i = 0; i < 20 && fresh.isEmpty(); i++) {
            for (String a : addrs()) if (!before.contains(a)) fresh.add(a);
            if (fresh.isEmpty()) sleep(250);
        }
        List<String> ips = new ArrayList<>(fresh);
        for (String a : addrs()) if (!ips.contains(a)) ips.add(a);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ssid", ssid);
        out.put("psk", psk);
        out.put("ips", ips);
        return out;
    }

    /**
     * Joins a hotspot and sends this app's connections through it: it has no internet, so the hub is
     * out of reach until it is left (the devices on it are what No Wi-Fi mode is for).
     */
    synchronized void join(String ssid, String psk) throws IOException {
        stop();
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        WifiNetworkSpecifier spec = new WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(psk).build();
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec)
                .build();
        CountDownLatch done = new CountDownLatch(1);
        Network[] got = new Network[1];
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                got[0] = n;
                done.countDown();
            }

            @Override
            public void onUnavailable() {
                done.countDown();
            }

            @Override
            public void onLost(Network n) {
                synchronized (Hotspots.this) {
                    if (joined == this) cm.bindProcessToNetwork(null);
                }
            }
        };
        try {
            cm.requestNetwork(req, cb, 90_000); // the user may take a while to answer Android's dialog
        } catch (SecurityException e) {
            throw new IOException("Allow MeshDrop to find nearby devices (location on Android 12 and older), then try again.", e);
        }
        await(done, 95);
        if (got[0] == null) {
            unregister(cm, cb);
            throw new IOException("Did not join " + ssid + " (declined, out of range, or a wrong password).");
        }
        joined = cb;
        cm.bindProcessToNetwork(got[0]);
    }

    synchronized void stop() {
        if (reservation != null) {
            reservation.close();
            reservation = null;
        }
        if (joined != null) {
            ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
            cm.bindProcessToNetwork(null);
            unregister(cm, joined);
            joined = null;
        }
    }

    private static void unregister(ConnectivityManager cm, ConnectivityManager.NetworkCallback cb) {
        try {
            cm.unregisterNetworkCallback(cb);
        } catch (IllegalArgumentException ignored) {
            // not registered (any more)
        }
    }

    private static Set<String> addrs() {
        Set<String> out = new HashSet<>();
        for (Map.Entry<NetworkInterface, Inet4Address> a : Discovery.interfaceAddrs()) out.add(a.getValue().getHostAddress());
        return out;
    }

    private static String unquote(String s) {
        return s != null && s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.substring(1, s.length() - 1) : s;
    }

    private static void await(CountDownLatch l, int seconds) throws IOException {
        try {
            l.await(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted.", e);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
