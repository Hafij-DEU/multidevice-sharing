package io.github.hafijbge.meshdrop;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import io.github.hafijbge.meshdrop.engine.identity.KeyVault;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals the identity key with an AES-256-GCM key that never leaves AndroidKeyStore. The identity key
 * itself is a software P-256 key: HPKE needs raw ECDH, which AndroidKeyStore offers only from API 31.
 * Sealed = "MDV1" ‖ IV(12) ‖ ciphertext. Unsealed data (an older build) is accepted once and re-sealed.
 */
final class KeystoreVault implements KeyVault {
    private static final String ALIAS = "meshdrop-identity";
    private static final byte[] MAGIC = "MDV1".getBytes(StandardCharsets.US_ASCII);

    private static SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    @Override
    public byte[] seal(byte[] plain) throws IOException {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain);
            byte[] out = new byte[MAGIC.length + iv.length + ct.length];
            System.arraycopy(MAGIC, 0, out, 0, MAGIC.length);
            System.arraycopy(iv, 0, out, MAGIC.length, iv.length);
            System.arraycopy(ct, 0, out, MAGIC.length + iv.length, ct.length);
            return out;
        } catch (GeneralSecurityException e) {
            throw new IOException("cannot seal the identity key", e);
        }
    }

    @Override
    public byte[] open(byte[] sealed) throws IOException {
        if (sealed.length < MAGIC.length + 12 || !Arrays.equals(Arrays.copyOf(sealed, MAGIC.length), MAGIC)) return sealed.clone();
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, sealed, MAGIC.length, 12));
            return c.doFinal(sealed, MAGIC.length + 12, sealed.length - MAGIC.length - 12);
        } catch (GeneralSecurityException e) {
            throw new IOException("cannot open the identity key", e);
        }
    }
}
