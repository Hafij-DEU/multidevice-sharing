package io.github.hafijbge.meshdrop.engine.bt;

/**
 * Diagnostics for live sound over Bluetooth: while {@link #on} is set (the app sets it from logcat tag
 * MeshDropTrace being loggable), each stage logs one line per event with a monotonic time in
 * microseconds, to find where a gap starts. Off (and free) by default.
 */
public final class Trace {
    public static volatile boolean on;
    private static final java.util.logging.Logger LOG = java.util.logging.Logger.getLogger("MeshDropTrace");

    private Trace() {}

    public static long us() {
        return System.nanoTime() / 1000;
    }

    public static void log(String line) {
        LOG.info(us() + " " + line);
    }
}
