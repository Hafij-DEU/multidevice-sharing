package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.os.Build;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import java.io.File;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;

/**
 * The saved Wi-Fi networks moved out of MeshDrop into the Band Lock app (0.11.0). On the first start after
 * the update this removes what the old Wi-Fi tab left behind: its network suggestions (a band lock would
 * otherwise stay pinned with no way to undo it), the sealed store and its Keystore key. Networks the user
 * had saved in Android itself ("connect directly") are Android's and stay. Runs once: it keys off the store.
 */
final class WifiCleanup {
    private WifiCleanup() {}

    static void run(Core core) {
        File store = new File(core.home, "wifi-profiles.bin");
        if (!store.exists()) return;
        try {
            WifiManager wifi = (WifiManager) core.app.getSystemService(Context.WIFI_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                List<WifiNetworkSuggestion> old = wifi.getNetworkSuggestions();
                if (!old.isEmpty()) wifi.removeNetworkSuggestions(old);
            } else {
                // Android 10 has no getNetworkSuggestions(); an empty list clears all of this app's.
                wifi.removeNetworkSuggestions(new ArrayList<WifiNetworkSuggestion>());
            }
        } catch (RuntimeException ignored) {
            // Wi-Fi service unavailable: the suggestions go when MeshDrop is uninstalled.
        }
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias("meshdrop-wifi")) ks.deleteEntry("meshdrop-wifi");
        } catch (Exception ignored) {
            // The key is useless without the store, which goes below.
        }
        store.delete();
        new File(core.home, "wifi-profiles.bin.tmp").delete();
    }
}
