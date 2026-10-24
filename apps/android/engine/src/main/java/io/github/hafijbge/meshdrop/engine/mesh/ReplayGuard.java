package io.github.hafijbge.meshdrop.engine.mesh;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Relayed request ids seen within `ttlMs` (at most `max`, oldest evicted first), each with the signed
 * answer frame once there is one, so a request the hub replays is answered again, never run twice.
 */
public final class ReplayGuard {
    private static final class Entry {
        final long at;
        byte[] answer;

        Entry(long at) {
            this.at = at;
        }
    }

    private final LinkedHashMap<String, Entry> seen = new LinkedHashMap<>();
    private final int max;
    private final long ttlMs;
    private final LongSupplier now;

    public ReplayGuard() {
        this(10_000, 600_000, System::currentTimeMillis);
    }

    public ReplayGuard(int max, long ttlMs, LongSupplier now) {
        this.max = max;
        this.ttlMs = ttlMs;
        this.now = now;
    }

    private void expire(long t) {
        Iterator<Map.Entry<String, Entry>> it = seen.entrySet().iterator();
        while (it.hasNext()) {
            if (t - it.next().getValue().at <= ttlMs) break; // insertion order = time order
            it.remove();
        }
    }

    /** True if `id` was seen within the TTL; otherwise records it and returns false. */
    public synchronized boolean seen(String id) {
        long t = now.getAsLong();
        expire(t);
        if (seen.containsKey(id)) return true;
        seen.put(id, new Entry(t));
        while (seen.size() > max) {
            Iterator<String> it = seen.keySet().iterator();
            it.next();
            it.remove();
        }
        return false;
    }

    public synchronized void answer(String id, byte[] frame) {
        Entry e = seen.get(id);
        if (e != null) e.answer = frame;
    }

    /** The answer recorded for `id`, or null (none yet, expired or evicted). */
    public synchronized byte[] cached(String id) {
        expire(now.getAsLong());
        Entry e = seen.get(id);
        return e == null ? null : e.answer;
    }

    public synchronized int size() {
        return seen.size();
    }
}
