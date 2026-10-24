package io.github.hafijbge.meshdrop.engine.identity;

/** No protection beyond file permissions (JVM tests and interop). */
public final class PlainKeyVault implements KeyVault {
    @Override
    public byte[] seal(byte[] plain) {
        return plain.clone();
    }

    @Override
    public byte[] open(byte[] sealed) {
        return sealed.clone();
    }
}
