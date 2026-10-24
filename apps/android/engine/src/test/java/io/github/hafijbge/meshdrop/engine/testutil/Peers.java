package io.github.hafijbge.meshdrop.engine.testutil;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.identity.X509;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.recv.Inbox;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** A Java receiver on a temp home, for tests. */
public final class Peers {
    public static final class Receiver implements AutoCloseable {
        public final File home;
        public final File inboxDir;
        public final Identity id;
        public final TrustStore trust;
        public final Inbox inbox;
        public final MeshServer server;
        public final List<Map<String, Object>> events = Collections.synchronizedList(new ArrayList<>());
        public int port;

        Receiver(File home, MeshServer.Options opts) throws Exception {
            this.home = home;
            this.inboxDir = new File(home, "inbox");
            this.id = Identity.loadOrCreate(home, new PlainKeyVault());
            this.trust = new TrustStore(new File(home, "trust.json"));
            this.inbox = new Inbox(new File(home, "inbox-state"), new DirectorySink(inboxDir));
            this.server = new MeshServer(id, trust, inbox, events::add, opts);
            this.port = server.start();
        }

        /** Trusts the device whose identity lives at `otherHome` (Node or Java layout). */
        public String trustHome(File otherHome, String alias) throws Exception {
            byte[] der = Files.readAllBytes(new File(otherHome, "identity/cert.der").toPath());
            String deviceId = Identity.deviceIdOf(der);
            trust.add(deviceId, alias, TrustStore.pem(X509.publicKey(der)));
            return deviceId;
        }

        @Override
        public void close() {
            server.stop();
        }
    }

    private Peers() {}

    public static Receiver receiver(File home) throws Exception {
        return new Receiver(home, new MeshServer.Options());
    }

    public static Receiver receiver(File home, MeshServer.Options opts) throws Exception {
        return new Receiver(home, opts);
    }
}
