package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Joins the Xiaomi phone's share hotspot (from its QR code). Only these sockets are bound to
 * it (through {@link Network#bindSocket}), so the rest of MeshDrop keeps its own network.
 */
final class QrShareJoin implements AutoCloseable {
    private final ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback joined;
    private Network network;

    QrShareJoin(Context ctx) {
        cm = ctx.getSystemService(ConnectivityManager.class);
    }

    /** Tries WPA2 first (what the Xiaomi app's hotspot usually is), then WPA3; an empty password is an open network. */
    synchronized Network join(String ssid, String psk) throws IOException {
        close();
        if (psk == null || psk.isEmpty()) return request(new WifiNetworkSpecifier.Builder().setSsid(ssid).build(), ssid);
        try {
            return request(new WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(psk).build(), ssid);
        } catch (IOException wpa2) {
            try {
                return request(new WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa3Passphrase(psk).build(), ssid);
            } catch (IOException ignored) {
                throw wpa2;
            }
        }
    }

    private Network request(WifiNetworkSpecifier spec, String ssid) throws IOException {
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
        };
        try {
            cm.requestNetwork(req, cb, 90_000); // the user answers Android's "connect to device" dialog
        } catch (SecurityException e) {
            throw new IOException("Allow Nearby devices (Location on Android 12 and older), then try again.", e);
        }
        try {
            done.await(95, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            unregister(cb);
            throw new IOException("Interrupted.", e);
        }
        if (got[0] == null) {
            unregister(cb);
            throw new IOException("Did not join " + ssid + " (declined, out of range, or a wrong password).");
        }
        joined = cb;
        network = got[0];
        return network;
    }

    synchronized Network network() {
        return network;
    }

    @Override
    public synchronized void close() {
        if (joined == null) return;
        unregister(joined);
        joined = null;
        network = null;
    }

    private void unregister(ConnectivityManager.NetworkCallback cb) {
        try {
            cm.unregisterNetworkCallback(cb);
        } catch (IllegalArgumentException ignored) {
            // not registered (any more)
        }
    }
}
