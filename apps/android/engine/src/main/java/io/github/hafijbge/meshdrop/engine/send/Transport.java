package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.net.Http;
import java.io.IOException;
import java.net.Socket;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * How the sender reaches a receiver's API (transfer/transport.ts): directly over pinned TLS on the
 * LAN, or through the hub as signed relay envelopes (live, or held on the hub for an offline target).
 * The session logic in Sender is the same over all of them.
 */
public interface Transport {
    /** "lan", "relay" or "held". */
    String kind();

    /**
     * One request. `track` gets the socket while it is open (so a pause can close it); `aborted` is
     * polled by transports without a socket of their own.
     */
    Http.Response request(String method, String path, byte[] body, String contentType, int timeoutMs, Set<Socket> track, BooleanSupplier aborted)
            throws IOException;

    /** The device is away: not retried now, but kept for auto-resume ("offline" is a transient error). */
    final class Away extends IOException {
        public Away() {
            super("offline");
        }
    }

    /** No way to reach the target on this transport (retrying cannot help). */
    final class NoRoute extends IOException {
        public NoRoute() {
            super("no-route");
        }
    }
}
