package io.github.hafijbge.meshdrop.engine.crypto;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PublicKey;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * HPKE (RFC 9180) mode_auth with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-GCM: the suite in
 * docs/protocol.md. Ported from packages/core/src/crypto/hpke.ts. Messages are sealed at an explicit
 * sequence number (nonce = base_nonce XOR I2OSP(seq, 12)) so chunks can be sent in any order.
 */
public final class Hpke {
    public enum Aead {
        AES_128_GCM(0x0001, 16),
        AES_256_GCM(0x0002, 32);

        final int id;
        final int nk;

        Aead(int id, int nk) {
            this.id = id;
            this.nk = nk;
        }
    }

    private static final int MODE_AUTH = 0x02;
    private static final int KEM_ID = 0x0010;
    private static final int KDF_ID = 0x0001;
    private static final int N_SECRET = 32;
    private static final int N_H = 32;
    private static final int N_N = 12;
    private static final int N_T = 16;
    private static final byte[] VERSION = ascii("HPKE-v1");
    private static final byte[] EMPTY = new byte[0];
    private static final byte[] KEM_SUITE = cat(ascii("KEM"), i2osp(KEM_ID, 2));

    private Hpke() {}

    /** One HPKE encryption context (one per session and target). */
    public static final class Context {
        private final byte[] key;
        private final byte[] baseNonce;
        private final byte[] exporterSecret;
        private final Aead aead;

        public Context(byte[] key, byte[] baseNonce, byte[] exporterSecret, Aead aead) {
            this.key = key.clone();
            this.baseNonce = baseNonce.clone();
            this.exporterSecret = exporterSecret.clone();
            this.aead = aead;
        }

        public byte[] key() {
            return key.clone();
        }

        public byte[] baseNonce() {
            return baseNonce.clone();
        }

        public byte[] exporterSecret() {
            return exporterSecret.clone();
        }

        public Aead aead() {
            return aead;
        }

        private byte[] nonce(long seq) {
            if (seq < 0) throw new IllegalArgumentException("seq must be non-negative");
            byte[] n = baseNonce.clone();
            for (int i = 0; i < 8; i++) n[N_N - 1 - i] ^= (byte) (seq >>> (8 * i));
            return n;
        }

        private Cipher cipher(int mode, long seq, byte[] aad) throws GeneralSecurityException {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(N_T * 8, nonce(seq)));
            c.updateAAD(aad);
            return c;
        }

        public byte[] seal(long seq, byte[] aad, byte[] pt) {
            try {
                return cipher(Cipher.ENCRYPT_MODE, seq, aad).doFinal(pt);
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException("seal failed", e);
            }
        }

        /** Throws AEADBadTagException when the ciphertext does not authenticate. */
        public byte[] open(long seq, byte[] aad, byte[] ct) throws AEADBadTagException {
            try {
                return cipher(Cipher.DECRYPT_MODE, seq, aad).doFinal(ct);
            } catch (AEADBadTagException e) {
                throw e;
            } catch (GeneralSecurityException e) {
                throw new AEADBadTagException("open failed: " + e.getMessage());
            }
        }

        /** RFC 9180 Context.Export. */
        public byte[] export(byte[] exporterContext, int len) {
            return labeledExpand(suite(aead), exporterSecret, "sec", exporterContext, len);
        }
    }

    /** The sender's half: the encapsulated key for the receiver and the context. */
    public static final class Sender {
        public final byte[] enc;
        public final byte[] sharedSecret;
        public final Context ctx;

        Sender(byte[] enc, byte[] sharedSecret, Context ctx) {
            this.enc = enc;
            this.sharedSecret = sharedSecret;
            this.ctx = ctx;
        }
    }

    public static Sender setupAuthS(PublicKey pkR, byte[] info, KeyPair skS, KeyPair ephemeral) {
        return setupAuthS(pkR, info, skS, ephemeral, Aead.AES_256_GCM);
    }

    /** SetupAuthS. `ephemeral` null = a fresh key pair. */
    public static Sender setupAuthS(PublicKey pkR, byte[] info, KeyPair skS, KeyPair ephemeral, Aead aead) {
        KeyPair e = ephemeral != null ? ephemeral : P256.generate();
        byte[] enc = P256.sec1(e.getPublic());
        byte[] dh = cat(P256.ecdh(e.getPrivate(), pkR), P256.ecdh(skS.getPrivate(), pkR));
        byte[] kemContext = cat(enc, P256.sec1(pkR), P256.sec1(skS.getPublic()));
        byte[] shared = extractAndExpand(dh, kemContext);
        return new Sender(enc, shared, keySchedule(shared, info, aead));
    }

    public static Context setupAuthR(byte[] enc, KeyPair skR, byte[] info, PublicKey pkS) {
        return setupAuthR(enc, skR, info, pkS, Aead.AES_256_GCM);
    }

    /** SetupAuthR. Throws IllegalArgumentException for an invalid encapsulated key. */
    public static Context setupAuthR(byte[] enc, KeyPair skR, byte[] info, PublicKey pkS, Aead aead) {
        PublicKey pkE = P256.publicFromSec1(enc);
        byte[] dh = cat(P256.ecdh(skR.getPrivate(), pkE), P256.ecdh(skR.getPrivate(), pkS));
        byte[] kemContext = cat(enc, P256.sec1(skR.getPublic()), P256.sec1(pkS));
        return keySchedule(extractAndExpand(dh, kemContext), info, aead);
    }

    // ---- key schedule -------------------------------------------------------------------------------

    private static byte[] suite(Aead aead) {
        return cat(ascii("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead.id, 2));
    }

    private static byte[] extractAndExpand(byte[] dh, byte[] kemContext) {
        byte[] eaePrk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh);
        return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, N_SECRET);
    }

    private static Context keySchedule(byte[] shared, byte[] info, Aead aead) {
        byte[] suite = suite(aead);
        byte[] pskIdHash = labeledExtract(suite, EMPTY, "psk_id_hash", EMPTY);
        byte[] infoHash = labeledExtract(suite, EMPTY, "info_hash", info);
        byte[] ksContext = cat(new byte[] {(byte) MODE_AUTH}, pskIdHash, infoHash);
        byte[] secret = labeledExtract(suite, shared, "secret", EMPTY);
        return new Context(
                labeledExpand(suite, secret, "key", ksContext, aead.nk),
                labeledExpand(suite, secret, "base_nonce", ksContext, N_N),
                labeledExpand(suite, secret, "exp", ksContext, N_H),
                aead);
    }

    private static byte[] labeledExtract(byte[] suite, byte[] salt, String label, byte[] ikm) {
        return hkdfExtract(salt, cat(VERSION, suite, ascii(label), ikm));
    }

    private static byte[] labeledExpand(byte[] suite, byte[] prk, String label, byte[] info, int len) {
        return hkdfExpand(prk, cat(i2osp(len, 2), VERSION, suite, ascii(label), info), len);
    }

    static byte[] hkdfExtract(byte[] salt, byte[] ikm) {
        return hmac(salt.length == 0 ? new byte[N_H] : salt, ikm);
    }

    static byte[] hkdfExpand(byte[] prk, byte[] info, int len) {
        if (len > 255 * N_H) throw new IllegalArgumentException("HKDF length");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] t = EMPTY;
        for (int i = 1; out.size() < len; i++) {
            t = hmac(prk, cat(t, info, new byte[] {(byte) i}));
            out.write(t, 0, t.length);
        }
        return java.util.Arrays.copyOf(out.toByteArray(), len);
    }

    private static byte[] hmac(byte[] key, byte[] data) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return m.doFinal(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] i2osp(long v, int len) {
        byte[] out = new byte[len];
        for (int i = len - 1; i >= 0; i--) {
            out[i] = (byte) v;
            v >>>= 8;
        }
        return out;
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    static byte[] cat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, o, p.length);
            o += p.length;
        }
        return out;
    }
}
