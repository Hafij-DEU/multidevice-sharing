package io.github.hafijbge.meshdrop.engine.net;

/** Who the receiver trusts: mesh members and manually paired devices (CompositeTrust), or just the latter. */
public interface TrustSource {
    boolean isTrusted(String deviceId);

    /** The device's alias and key, or null. */
    TrustStore.Device get(String deviceId);
}
