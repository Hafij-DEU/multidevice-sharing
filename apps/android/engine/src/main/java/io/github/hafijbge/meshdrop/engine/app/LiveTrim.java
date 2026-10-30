package io.github.hafijbge.meshdrop.engine.app;

/**
 * Keeps live sound live on the phone: decides how much of what just arrived a playing track takes.
 * Once more than `high` would be queued, the newest audio is kept only up to `target` queued and the
 * rest dropped, or a stall's delay would last for the rest of the stream. Over Wi-Fi both are 120 ms.
 * A Bluetooth link delivers in bursts (sniff intervals, a radio shared with earbuds), so there a burst
 * that still fits under 500 ms is jitter and plays whole; cutting it to 120 ms made the sound stutter.
 */
public final class LiveTrim {
    static final int RATE = 48_000;
    private final int target;
    private final int high;
    private long dropped;

    LiveTrim(int targetMs, int highMs) {
        target = RATE / 1000 * targetMs;
        high = RATE / 1000 * highMs;
    }

    public static LiveTrim lan() {
        return new LiveTrim(120, 120);
    }

    public static LiveTrim bluetooth() {
        return new LiveTrim(200, 500);
    }

    /** The most frames a track should hold. */
    public int highFrames() {
        return high;
    }

    /** Of `incoming` frames arriving with `queued` frames not yet played, how many (the newest) to keep. */
    public int keep(int incoming, int queued) {
        int keep = queued + incoming <= high ? incoming : Math.min(incoming, Math.max(0, target - queued));
        dropped += incoming - keep;
        return keep;
    }

    /** Frames dropped so far. */
    public long dropped() {
        return dropped;
    }
}
