package io.github.hafijbge.meshdrop.engine.net;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.X509;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.net.ssl.X509ExtendedTrustManager;

/**
 * TLS 1.3 per docs/protocol.md "TLS rules": the server presents the device certificate and accepts
 * any client certificate (trust is decided by device id); the pinned client checks SHA-256 of the
 * server certificate inside the handshake, before its own certificate is sent; the probe client
 * sends no certificate and pins nothing.
 */
public final class Tls {
    public static final String[] PROTOCOLS = {"TLSv1.3"};

    private Tls() {}

    private static final class DeviceKeyManager extends X509ExtendedKeyManager {
        private final X509Certificate cert;
        private final PrivateKey key;

        DeviceKeyManager(Identity id) throws GeneralSecurityException {
            this.cert = X509.parse(id.certDer());
            this.key = id.keyPair().getPrivate();
        }

        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return new String[] {"device"};
        }

        @Override
        public String chooseClientAlias(String[] keyType, Principal[] issuers, Socket socket) {
            return "device";
        }

        @Override
        public String chooseEngineClientAlias(String[] keyType, Principal[] issuers, SSLEngine engine) {
            return "device";
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return new String[] {"device"};
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return "device";
        }

        @Override
        public String chooseEngineServerAlias(String keyType, Principal[] issuers, SSLEngine engine) {
            return "device";
        }

        @Override
        public X509Certificate[] getCertificateChain(String alias) {
            return new X509Certificate[] {cert};
        }

        @Override
        public PrivateKey getPrivateKey(String alias) {
            return key;
        }
    }

    /** Accepts any certificate (the server's view of clients, and the probe's view of servers). */
    private static class AnyCert extends X509ExtendedTrustManager {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            checkServerTrusted(chain, authType);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            checkServerTrusted(chain, authType);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {}

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** Pins the server: SHA-256 of its certificate DER must be `expectedId`. */
    private static final class Pinned extends AnyCert {
        private final String expectedId;

        Pinned(String expectedId) {
            this.expectedId = expectedId;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("pin-mismatch: no certificate");
            if (!Identity.deviceIdOf(chain[0].getEncoded()).equals(expectedId)) throw new CertificateException("pin-mismatch");
        }
    }

    private static SSLContext context(KeyManager km, TrustManager tm) {
        try {
            SSLContext c = SSLContext.getInstance("TLS");
            c.init(km == null ? null : new KeyManager[] {km}, new TrustManager[] {tm}, null);
            return c;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static SSLContext serverContext(Identity id) {
        try {
            return context(new DeviceKeyManager(id), new AnyCert());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Contexts are costly to build (provider and key setup): one per (identity, pinned peer), reused. */
    private static final java.util.Map<String, SSLContext> PINNED = new java.util.concurrent.ConcurrentHashMap<>();
    private static volatile SSLContext probe;

    public static SSLContext pinnedClient(Identity me, String expectedId) {
        return PINNED.computeIfAbsent(me.deviceId() + "/" + expectedId, k -> {
            try {
                return context(new DeviceKeyManager(me), new Pinned(expectedId));
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        });
    }

    public static SSLContext probeClient() {
        SSLContext c = probe;
        if (c == null) probe = c = context(null, new AnyCert());
        return c;
    }

    /** Opens a TLS 1.3 connection and completes the handshake (the pin, if any, is checked inside it). */
    public static SSLSocket connect(SSLContext ctx, String host, int port, int timeoutMs) throws IOException {
        Socket tcp = new Socket();
        try {
            tcp.connect(new InetSocketAddress(host, port), timeoutMs);
            tcp.setSoTimeout(timeoutMs);
            SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(tcp, host, port, true);
            s.setEnabledProtocols(PROTOCOLS);
            s.setUseClientMode(true);
            s.startHandshake();
            return s;
        } catch (IOException | RuntimeException e) {
            tcp.close();
            throw e;
        }
    }

    /** Device id of the certificate the peer presented, or null. */
    public static String peerId(SSLSession s) {
        try {
            java.security.cert.Certificate[] c = s.getPeerCertificates();
            return c.length == 0 ? null : Identity.deviceIdOf(c[0].getEncoded());
        } catch (SSLPeerUnverifiedException | java.security.cert.CertificateEncodingException e) {
            return null;
        }
    }

    public static byte[] peerCertDer(SSLSocket s) throws IOException {
        try {
            return s.getSession().getPeerCertificates()[0].getEncoded();
        } catch (java.security.cert.CertificateEncodingException e) {
            throw new IOException(e);
        }
    }

    static String sha256Hex(byte[] b) {
        try {
            return io.github.hafijbge.meshdrop.engine.util.Hex.of(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
