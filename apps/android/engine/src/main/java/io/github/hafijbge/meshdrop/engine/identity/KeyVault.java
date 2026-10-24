package io.github.hafijbge.meshdrop.engine.identity;

import java.io.IOException;

/** Protects the identity key at rest (Android: an AndroidKeyStore AES key; JVM tests: none). */
public interface KeyVault {
    byte[] seal(byte[] plain) throws IOException;

    byte[] open(byte[] sealed) throws IOException;
}
