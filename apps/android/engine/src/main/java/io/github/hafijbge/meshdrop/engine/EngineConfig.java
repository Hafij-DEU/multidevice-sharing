package io.github.hafijbge.meshdrop.engine;

import io.github.hafijbge.meshdrop.engine.identity.KeyVault;
import io.github.hafijbge.meshdrop.engine.recv.Inbox;
import io.github.hafijbge.meshdrop.engine.recv.InboxSink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.Source;
import java.io.File;

/** How an Engine is built: its home, key protection, where received files land, and its LAN settings. */
public final class EngineConfig {
    /** Hooks around multicast listening (Android: a WifiManager.MulticastLock). */
    public interface MulticastHooks {
        void acquire();

        void release();
    }

    public final File home;
    public final KeyVault vault;
    public final InboxSink sink;
    public int port = 53318;
    public String alias = "MeshDrop";
    public String deviceType = "mobile";
    public boolean discovery = true;
    /** Multicast group/port overrides (tests); null = the protocol defaults. */
    public Integer discoveryPort;
    public long discoveryIntervalMs = 5000;
    public boolean autoResume = true;
    public long partialMaxAgeMs = Inbox.PARTIAL_TTL_MS;
    public MulticastHooks multicastHooks;
    public Source.Resolver resolver = PathSource.RESOLVER;

    public EngineConfig(File home, KeyVault vault, InboxSink sink) {
        this.home = home;
        this.vault = vault;
        this.sink = sink;
    }
}
