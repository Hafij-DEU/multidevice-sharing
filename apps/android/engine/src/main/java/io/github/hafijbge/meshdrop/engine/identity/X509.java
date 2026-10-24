package io.github.hafijbge.meshdrop.engine.identity;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.interfaces.ECPublicKey;

/**
 * Self-signed X.509 v3 certificate with the Node engine's profile (docs/protocol.md "Identity"),
 * ported from packages/core/src/x509.ts: ECDSA-with-SHA256, CN in UTF8String, validity
 * 200101000000Z (UTCTime) to 99991231235959Z (GeneralizedTime), critical basicConstraints CA:false.
 */
public final class X509 {
    private static final String OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
    private static final String OID_COMMON_NAME = "2.5.4.3";
    private static final String OID_BASIC_CONSTRAINTS = "2.5.29.19";

    private X509() {}

    // ---- minimal DER --------------------------------------------------------------------------------

    private static byte[] len(int n) {
        if (n < 0x80) return new byte[] {(byte) n};
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int bytes = 0;
        for (int v = n; v > 0; v >>>= 8) bytes++;
        b.write(0x80 | bytes);
        for (int i = bytes - 1; i >= 0; i--) b.write((n >>> (8 * i)) & 0xff);
        return b.toByteArray();
    }

    private static byte[] tlv(int tag, byte[]... parts) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] p : parts) body.write(p, 0, p.length);
        byte[] c = body.toByteArray();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        byte[] l = len(c.length);
        out.write(l, 0, l.length);
        out.write(c, 0, c.length);
        return out.toByteArray();
    }

    private static byte[] seq(byte[]... items) {
        return tlv(0x30, items);
    }

    private static byte[] integer(byte[] magnitude) {
        int i = 0;
        while (i < magnitude.length - 1 && magnitude[i] == 0) i++;
        byte[] body = java.util.Arrays.copyOfRange(magnitude, i, magnitude.length);
        if (body.length == 0) body = new byte[] {0};
        if ((body[0] & 0x80) != 0) {
            byte[] p = new byte[body.length + 1];
            System.arraycopy(body, 0, p, 1, body.length);
            body = p;
        }
        return tlv(0x02, body);
    }

    private static byte[] oid(String dotted) {
        String[] p = dotted.split("\\.");
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(Integer.parseInt(p[0]) * 40 + Integer.parseInt(p[1]));
        for (int k = 2; k < p.length; k++) {
            long v = Long.parseLong(p[k]);
            int n = 0;
            byte[] tmp = new byte[10];
            do {
                tmp[n++] = (byte) (v & 0x7f);
                v >>>= 7;
            } while (v > 0);
            for (int i = n - 1; i >= 0; i--) b.write(tmp[i] | (i > 0 ? 0x80 : 0));
        }
        return tlv(0x06, b.toByteArray());
    }

    private static byte[] ascii(int tag, String s) {
        return tlv(tag, s.getBytes(StandardCharsets.US_ASCII));
    }

    // ---- certificate --------------------------------------------------------------------------------

    /** The TBSCertificate (exposed for the x509-v1 vector). */
    public static byte[] tbs(PublicKey pub, byte[] serial, String commonName) {
        byte[] sigAlg = seq(oid(OID_ECDSA_SHA256));
        byte[] name = seq(tlv(0x31, seq(oid(OID_COMMON_NAME), tlv(0x0c, commonName.getBytes(StandardCharsets.UTF_8)))));
        byte[] validity = seq(ascii(0x17, "200101000000Z"), ascii(0x18, "99991231235959Z"));
        byte[] basicConstraints = seq(oid(OID_BASIC_CONSTRAINTS), tlv(0x01, new byte[] {(byte) 0xff}), tlv(0x04, seq()));
        return seq(
                tlv(0xa0, integer(new byte[] {2})),
                integer(serial),
                sigAlg,
                name,
                validity,
                name,
                P256.spki(pub),
                tlv(0xa3, seq(basicConstraints)));
    }

    public static byte[] selfSigned(KeyPair kp, byte[] serial, String commonName) {
        byte[] tbs = tbs(kp.getPublic(), serial, commonName);
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(kp.getPrivate());
            s.update(tbs);
            byte[] sig = s.sign();
            byte[] bits = new byte[sig.length + 1];
            System.arraycopy(sig, 0, bits, 1, sig.length);
            return seq(tbs, seq(oid(OID_ECDSA_SHA256)), tlv(0x03, bits));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static X509Certificate parse(byte[] der) throws GeneralSecurityException {
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    /** The P-256 key of any well-formed certificate (validity, subject and extensions are ignored). */
    public static ECPublicKey publicKey(byte[] der) throws GeneralSecurityException {
        PublicKey k = parse(der).getPublicKey();
        if (!(k instanceof ECPublicKey) || !P256.isP256(k)) throw new GeneralSecurityException("not a P-256 certificate");
        return P256.publicFromSpki(k.getEncoded());
    }
}
