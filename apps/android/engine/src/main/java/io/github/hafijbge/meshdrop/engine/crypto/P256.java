package io.github.hafijbge.meshdrop.engine.crypto;

import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import javax.crypto.KeyAgreement;

/** EC P-256 (secp256r1) keys and encodings through the platform JCA provider. */
public final class P256 {
    public static final ECParameterSpec PARAMS;
    private static final BigInteger P = new BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16);
    private static final BigInteger B = new BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16);

    static {
        try {
            AlgorithmParameters ap = AlgorithmParameters.getInstance("EC");
            ap.init(new ECGenParameterSpec("secp256r1"));
            PARAMS = ap.getParameterSpec(ECParameterSpec.class);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("P-256 unavailable", e);
        }
    }

    private P256() {}

    public static KeyPair generate() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"));
            return g.generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static KeyFactory kf() {
        try {
            return KeyFactory.getInstance("EC");
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** True if the key is on P-256 (field size and order match). */
    public static boolean isP256(java.security.Key k) {
        java.security.spec.ECParameterSpec ps =
                k instanceof ECPublicKey ? ((ECPublicKey) k).getParams() : k instanceof ECPrivateKey ? ((ECPrivateKey) k).getParams() : null;
        return ps != null && ps.getOrder().equals(PARAMS.getOrder()) && ps.getCurve().getField().getFieldSize() == 256
                && ps.getCurve().getB().equals(B);
    }

    public static ECPublicKey publicFromPoint(BigInteger x, BigInteger y) {
        if (x.signum() < 0 || y.signum() < 0 || x.compareTo(P) >= 0 || y.compareTo(P) >= 0) throw new IllegalArgumentException("point out of range");
        BigInteger lhs = y.multiply(y).mod(P);
        BigInteger rhs = x.pow(3).subtract(x.multiply(BigInteger.valueOf(3))).add(B).mod(P);
        if (!lhs.equals(rhs)) throw new IllegalArgumentException("point not on P-256");
        try {
            return (ECPublicKey) kf().generatePublic(new ECPublicKeySpec(new ECPoint(x, y), PARAMS));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("invalid P-256 point", e);
        }
    }

    /** Uncompressed SEC1 point (0x04 ‖ X ‖ Y, 65 bytes). */
    public static ECPublicKey publicFromSec1(byte[] p) {
        if (p.length != 65 || p[0] != 0x04) throw new IllegalArgumentException("expected a 65-byte uncompressed point");
        return publicFromPoint(new BigInteger(1, java.util.Arrays.copyOfRange(p, 1, 33)), new BigInteger(1, java.util.Arrays.copyOfRange(p, 33, 65)));
    }

    public static byte[] sec1(PublicKey pk) {
        if (!(pk instanceof ECPublicKey) || !isP256(pk)) throw new IllegalArgumentException("expected a P-256 public key");
        ECPoint w = ((ECPublicKey) pk).getW();
        byte[] out = new byte[65];
        out[0] = 0x04;
        fixed32(w.getAffineX(), out, 1);
        fixed32(w.getAffineY(), out, 33);
        return out;
    }

    public static byte[] fixed32(BigInteger v) {
        byte[] out = new byte[32];
        fixed32(v, out, 0);
        return out;
    }

    private static void fixed32(BigInteger v, byte[] out, int off) {
        byte[] b = v.toByteArray();
        int len = Math.min(b.length, 32);
        System.arraycopy(b, b.length - len, out, off + 32 - len, len);
    }

    public static ECPublicKey publicFromSpki(byte[] der) {
        try {
            PublicKey k = kf().generatePublic(new X509EncodedKeySpec(der));
            if (!isP256(k)) throw new IllegalArgumentException("not a P-256 key");
            ECPoint w = ((ECPublicKey) k).getW();
            return publicFromPoint(w.getAffineX(), w.getAffineY());
        } catch (GeneralSecurityException | ClassCastException e) {
            throw new IllegalArgumentException("invalid SPKI", e);
        }
    }

    public static byte[] spki(PublicKey pk) {
        if (!isP256(pk)) throw new IllegalArgumentException("expected a P-256 public key");
        return pk.getEncoded();
    }

    public static byte[] pkcs8(PrivateKey sk) {
        return sk.getEncoded();
    }

    public static ECPrivateKey privateFromPkcs8(byte[] der) {
        try {
            PrivateKey k = kf().generatePrivate(new PKCS8EncodedKeySpec(der));
            if (!isP256(k)) throw new IllegalArgumentException("not a P-256 key");
            return (ECPrivateKey) k;
        } catch (GeneralSecurityException | ClassCastException e) {
            throw new IllegalArgumentException("invalid PKCS#8", e);
        }
    }

    /** ECDH shared secret (the X coordinate, 32 bytes). */
    public static byte[] ecdh(PrivateKey sk, PublicKey pk) {
        try {
            KeyAgreement ka = KeyAgreement.getInstance("ECDH");
            ka.init(sk);
            ka.doPhase(pk, true);
            byte[] s = ka.generateSecret();
            return s.length == 32 ? s : fixed32(new BigInteger(1, s));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("ECDH failed", e);
        }
    }
}
