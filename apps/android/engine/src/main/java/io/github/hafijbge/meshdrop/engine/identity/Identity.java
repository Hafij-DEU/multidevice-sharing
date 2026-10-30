package io.github.hafijbge.meshdrop.engine.identity;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * This device's long-term P-256 key and self-signed certificate. Device id = hex SHA-256 of the
 * certificate DER. Stored as <home>/identity/cert.der and identity/key.bin (PKCS#8 sealed by a KeyVault).
 */
public final class Identity {
    private final KeyPair keyPair;
    private final byte[] certDer;
    private final String deviceId;

    private Identity(KeyPair keyPair, byte[] certDer) {
        this.keyPair = keyPair;
        this.certDer = certDer.clone();
        this.deviceId = deviceIdOf(certDer);
    }

    public static String deviceIdOf(byte[] certDer) {
        try {
            return Hex.of(MessageDigest.getInstance("SHA-256").digest(certDer));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public String deviceId() {
        return deviceId;
    }

    public byte[] certDer() {
        return certDer.clone();
    }

    public KeyPair keyPair() {
        return keyPair;
    }

    /** Loads the identity under `home`, or creates one. Never regenerates half an identity. */
    public static synchronized Identity loadOrCreate(File home, KeyVault vault) throws IOException {
        File dir = new File(home, "identity");
        File cert = new File(dir, "cert.der");
        File key = new File(dir, "key.bin");
        boolean hasCert = cert.isFile(), hasKey = key.isFile();
        if (hasCert && hasKey) return load(cert, key, vault);
        if (hasCert) throw new IOException("identity: missing identity/key.bin (refusing to regenerate half an identity)");
        if (hasKey) throw new IOException("identity: missing identity/cert.der (refusing to regenerate half an identity)");
        return create(home, dir, vault);
    }

    private static Identity load(File certFile, File keyFile, KeyVault vault) throws IOException {
        byte[] der = Files.readAllBytes(certFile.toPath());
        try {
            java.security.interfaces.ECPrivateKey sk = P256.privateFromPkcs8(vault.open(Files.readAllBytes(keyFile.toPath())));
            KeyPair kp = new KeyPair(X509.publicKey(der), sk);
            X509.parse(der).verify(kp.getPublic());
            // The key must belong to the certificate: sign and verify a probe.
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initSign(sk);
            s.update(new byte[] {1});
            byte[] sig = s.sign();
            s.initVerify(kp.getPublic());
            s.update(new byte[] {1});
            if (!s.verify(sig)) throw new IOException("identity: key does not match the certificate");
            return new Identity(kp, der);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IOException("identity: cannot load (" + e.getMessage() + ")", e);
        }
    }

    private static Identity create(File home, File dir, KeyVault vault) throws IOException {
        KeyPair kp = P256.generate();
        byte[] serial = new byte[16];
        new SecureRandom().nextBytes(serial);
        serial[0] &= 0x7f;
        if (serial[0] == 0) serial[0] = 1;
        String cn;
        try {
            cn = "meshdrop-" + Hex.of(MessageDigest.getInstance("SHA-256").digest(P256.spki(kp.getPublic()))).substring(0, 8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        byte[] der = X509.selfSigned(kp, serial, cn);
        // Write into a temp dir and rename it into place: a crash never leaves half an identity.
        File tmp = new File(home, "identity.tmp-" + Long.toHexString(System.nanoTime()));
        if (!tmp.mkdirs()) throw new IOException("cannot create " + tmp);
        Atomic.write(new File(tmp, "cert.der"), der);
        Atomic.write(new File(tmp, "key.bin"), vault.seal(P256.pkcs8(kp.getPrivate())));
        Files.move(tmp.toPath(), dir.toPath(), StandardCopyOption.ATOMIC_MOVE);
        return new Identity(kp, der);
    }
}
