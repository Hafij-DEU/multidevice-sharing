package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import java.util.logging.Logger;

/**
 * While a PC's sound comes over the Bluetooth link, plays silence to that PC as Bluetooth audio (A2DP)
 * and keeps the sound itself on this phone (other headphones, wired ones, or the speaker). Android gives
 * a streaming A2DP link priority on the radio; without it the link stalls for half a second every few
 * seconds and the sound broke up (measured on a POCO X3 Pro: 82-90 % of it arrived, with A2DP streaming
 * all of it). The PC connects the A2DP link when the sound starts (an app cannot); this waits for it. No
 * delay is added: the sound does not go through it.
 */
final class A2dpKeepAlive implements AutoCloseable {
    private static final Logger LOG = Logger.getLogger("MeshDropBt");
    private final AudioManager am;
    private final String pc;
    private final AudioTrack sound;
    private final Thread thread;
    private volatile boolean closed;
    private final AudioDeviceCallback watch = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            route();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            route();
        }
    };

    A2dpKeepAlive(Context ctx, String pcAddress, AudioTrack sound) {
        am = ctx.getSystemService(AudioManager.class);
        pc = pcAddress;
        this.sound = sound;
        route();
        am.registerAudioDeviceCallback(watch, null);
        thread = new Thread(this::silence, "MeshDrop A2DP keep-alive");
        thread.setDaemon(true);
        thread.start();
    }

    /** The PC as an A2DP output of this phone, if it is connected. */
    private AudioDeviceInfo pcOutput() {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP && same(d.getAddress(), pc)) return d;
        }
        return null;
    }

    /** Bluetooth addresses, also when Android shows only the last bytes ("XX:XX:XX:XX:2D:F0"). */
    static boolean same(String shown, String address) {
        if (shown == null || address == null || shown.length() != address.length()) return false;
        if (shown.equalsIgnoreCase(address)) return true;
        return shown.toUpperCase().startsWith("XX:") && shown.regionMatches(true, 12, address, 12, 5);
    }

    /** While the PC is an output, the sound plays where it would without it; otherwise Android picks. */
    private synchronized void route() {
        if (closed) return;
        AudioDeviceInfo p = pcOutput();
        AudioDeviceInfo best = null;
        int rank = Integer.MAX_VALUE;
        if (p != null) {
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int r = rank(d, p);
                if (r < rank) {
                    rank = r;
                    best = d;
                }
            }
        }
        sound.setPreferredDevice(best);
    }

    /** Headphones first (Bluetooth, then wired or USB), then the speaker; never the PC. */
    private static int rank(AudioDeviceInfo d, AudioDeviceInfo pc) {
        if (d.getId() == pc.getId()) return Integer.MAX_VALUE;
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return 0;
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return 1;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return 2;
            default:
                return Integer.MAX_VALUE;
        }
    }

    /** Plays silence to the PC whenever it is an output, until closed. */
    private void silence() {
        byte[] zeros = new byte[MediaCast.RATE / 50 * 4]; // 20 ms, s16 stereo
        AudioTrack t = null;
        try {
            while (!closed) {
                AudioDeviceInfo p = pcOutput();
                if (p == null) {
                    if (t != null) {
                        LOG.info("sound over bt: a2dp keep-alive off (the PC dropped it)");
                        t.release();
                        t = null;
                    }
                    Thread.sleep(200);
                    continue;
                }
                if (t == null) {
                    t = new AudioTrack.Builder()
                            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                            .setAudioFormat(new AudioFormat.Builder().setSampleRate(MediaCast.RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                            .setBufferSizeInBytes(zeros.length * 5)
                            .setTransferMode(AudioTrack.MODE_STREAM)
                            .build();
                    t.setPreferredDevice(p);
                    t.play();
                    LOG.info("sound over bt: a2dp keep-alive on");
                }
                // about 1 s of silence (each write waits for room), then look again
                for (int i = 0; i < 50 && !closed; i++) t.write(zeros, 0, zeros.length);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            LOG.info("sound over bt: a2dp keep-alive failed: " + e);
        } finally {
            if (t != null) t.release();
        }
    }

    @Override
    public void close() {
        synchronized (this) {
            closed = true;
        }
        am.unregisterAudioDeviceCallback(watch);
        thread.interrupt();
    }
}
