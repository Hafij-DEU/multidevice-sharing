package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.net.TrustSource;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import java.util.function.Supplier;

/** Mesh members first, then manually paired devices — never a revoked one (mesh/members.ts CompositeTrust). */
public final class CompositeTrust implements TrustSource {
    private final Supplier<MembershipStore> members;
    private final TrustSource manual;

    public CompositeTrust(MembershipStore members, TrustSource manual) {
        this(() -> members, manual);
    }

    /** `members` is read on every call: the mesh can be joined or dropped while the server runs. */
    public CompositeTrust(Supplier<MembershipStore> members, TrustSource manual) {
        this.members = members;
        this.manual = manual;
    }

    @Override
    public boolean isTrusted(String deviceId) {
        MembershipStore m = members.get();
        if (m != null && m.isTrusted(deviceId)) return true;
        if (m != null && m.isRevoked(deviceId)) return false;
        return manual.isTrusted(deviceId);
    }

    @Override
    public TrustStore.Device get(String deviceId) {
        MembershipStore m = members.get();
        TrustStore.Device d = m == null ? null : m.get(deviceId);
        if (d != null) return d;
        if (m != null && m.isRevoked(deviceId)) return null;
        return manual.get(deviceId);
    }
}
