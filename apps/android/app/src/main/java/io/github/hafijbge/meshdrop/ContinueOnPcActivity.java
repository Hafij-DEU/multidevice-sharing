package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Bundle;
import android.os.SystemClock;
import android.widget.Toast;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * M13 Share → "Continue on PC": the shared page opens on the PC (through its browser extension, at the
 * same spot). A video playing on the phone (YouTube and others with a media session) continues at the
 * same second, read with the notification access MeshDrop already has. No screen: a toast, then gone.
 */
public final class ContinueOnPcActivity extends Activity {
    private static final Pattern URL = Pattern.compile("https?://\\S+");

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        CharSequence text = getIntent().getCharSequenceExtra(Intent.EXTRA_TEXT);
        Matcher m = URL.matcher(text == null ? "" : text);
        if (!m.find()) {
            Toast.makeText(this, "Share a link to continue it on the PC.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        String url = m.group();
        long time = playingSecond();
        Core core = ((MeshApp) getApplication()).core();
        new Thread(() -> {
            String msg;
            try {
                core.ensureStarted();
                msg = "Opening on " + core.controller.handoffPush(url, time) + (time > 0 ? " at " + time / 60 + ":" + String.format(java.util.Locale.ROOT, "%02d", time % 60) : "");
            } catch (Exception e) {
                msg = e.getMessage() == null ? "Could not reach the PC." : e.getMessage();
            }
            String shown = msg;
            runOnUiThread(() -> Toast.makeText(getApplicationContext(), shown, Toast.LENGTH_SHORT).show());
        }, "continue-on-pc").start();
        finish();
    }

    /** The second the playing media is at (0: nothing playing, or no notification access). */
    private long playingSecond() {
        try {
            MediaSessionManager msm = getSystemService(MediaSessionManager.class);
            for (MediaController c : msm.getActiveSessions(new ComponentName(this, NotifyListener.class))) {
                PlaybackState s = c.getPlaybackState();
                if (s == null || s.getPosition() < 0) continue;
                long pos = s.getPosition();
                if (s.getState() == PlaybackState.STATE_PLAYING) pos += (long) ((SystemClock.elapsedRealtime() - s.getLastPositionUpdateTime()) * s.getPlaybackSpeed());
                if (s.getState() == PlaybackState.STATE_PLAYING || s.getState() == PlaybackState.STATE_PAUSED) return pos / 1000;
            }
        } catch (RuntimeException ignored) {
            // no notification access (SecurityException): the link alone
        }
        return 0;
    }
}
