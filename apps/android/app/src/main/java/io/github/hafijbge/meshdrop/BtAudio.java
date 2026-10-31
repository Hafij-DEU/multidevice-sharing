package io.github.hafijbge.meshdrop;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothA2dp;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Build;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Phone sound on a PC as Bluetooth audio (A2DP), the way earbuds get it: the radio schedules it and
 * drops late packets instead of resending them, so it neither stalls nor drifts behind. No app may
 * connect A2DP itself (BluetoothA2dp.connect is a system API), so the user picks the PC as the audio
 * output; MeshDrop opens that picker and watches which device the sound plays on.
 */
final class BtAudio {
    /** Hidden in the SDK, but sent to apps holding BLUETOOTH_CONNECT: the phone switched audio device. */
    private static final String ACTIVE_DEVICE_CHANGED = "android.bluetooth.a2dp.profile.action.ACTIVE_DEVICE_CHANGED";

    private final Context ctx;
    private final Runnable changed;
    private volatile BluetoothA2dp a2dp;
    private BroadcastReceiver receiver;

    BtAudio(Context ctx, Runnable changed) {
        this.ctx = ctx.getApplicationContext();
        this.changed = changed;
    }

    /** Starts watching Bluetooth audio connections (once; a no-op without Bluetooth). */
    synchronized void start() {
        if (receiver != null) return;
        BluetoothManager m = ctx.getSystemService(BluetoothManager.class);
        BluetoothAdapter a = m == null ? null : m.getAdapter();
        if (a == null) return;
        try {
            a.getProfileProxy(ctx, new BluetoothProfile.ServiceListener() {
                @Override
                public void onServiceConnected(int profile, BluetoothProfile proxy) {
                    a2dp = (BluetoothA2dp) proxy;
                    changed.run();
                }

                @Override
                public void onServiceDisconnected(int profile) {
                    a2dp = null;
                }
            }, BluetoothProfile.A2DP);
        } catch (SecurityException e) {
            // no BLUETOOTH_CONNECT yet: sinks() stays empty until it is granted
        }
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                changed.run();
            }
        };
        IntentFilter f = new IntentFilter(BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED);
        f.addAction(BluetoothA2dp.ACTION_PLAYING_STATE_CHANGED);
        f.addAction(ACTIVE_DEVICE_CHANGED);
        f.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        // exported: these come from the Bluetooth app (uid 1002), not the system, so a not-exported
        // receiver never gets them and the screen kept showing audio that had ended. Other apps cannot
        // fake them: they are protected broadcasts, and they only trigger a refresh anyway.
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, f, Context.RECEIVER_EXPORTED);
        else ctx.registerReceiver(receiver, f);
    }

    /**
     * Addresses (upper case) of the Bluetooth audio devices media plays on: the ones playing now, else
     * every connected one (the phone sends media to one of them; which one is a system secret).
     */
    @SuppressLint("MissingPermission") // a SecurityException is caught: no permission, no answer
    Set<String> sinks() {
        start();
        Set<String> connected = new HashSet<>();
        Set<String> playing = new HashSet<>();
        try {
            BluetoothA2dp p = a2dp;
            if (p != null) {
                for (BluetoothDevice d : p.getConnectedDevices()) {
                    String address = d.getAddress().toUpperCase(Locale.ROOT);
                    connected.add(address);
                    if (p.isA2dpPlaying(d)) playing.add(address);
                }
            }
        } catch (SecurityException | IllegalStateException e) {
            // Bluetooth off or not allowed: nothing plays over it as far as MeshDrop can tell
        }
        return playing.isEmpty() ? connected : playing;
    }

    /** The system's audio output picker (Android 14+), else the Bluetooth settings list. */
    static void pick(Activity a) {
        if (Build.VERSION.SDK_INT >= 34 && android.media.MediaRouter2.getInstance(a).showSystemOutputSwitcher()) return;
        settings(a);
    }

    /** Bluetooth settings: tapping the PC there connects its audio too. */
    static void settings(Activity a) {
        a.startActivity(new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS));
    }
}
