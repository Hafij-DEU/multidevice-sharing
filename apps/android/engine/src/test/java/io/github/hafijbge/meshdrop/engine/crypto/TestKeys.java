package io.github.hafijbge.meshdrop.engine.crypto;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECPrivateKeySpec;

/** Test helper: P-256 private keys from the raw scalars in the protocol vectors. */
public final class TestKeys {
    private TestKeys() {}

    public static ECPrivateKey privateFromScalar(byte[] d) {
        if (d.length != 32) throw new IllegalArgumentException("expected a 32-byte scalar");
        BigInteger s = new BigInteger(1, d);
        if (s.signum() == 0 || s.compareTo(P256.PARAMS.getOrder()) >= 0) throw new IllegalArgumentException("scalar out of range");
        try {
            return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(s, P256.PARAMS));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException(e);
        }
    }
}
