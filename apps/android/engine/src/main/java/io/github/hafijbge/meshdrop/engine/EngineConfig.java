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
    /** How often manually paired peers that are not present are probed again (network blips, filtered multicast). */
    public long manualReprobeMs = 60_000;
    /** Called with true when a send or receive becomes active, false after `activityIdleMs` without any (Android: wake/Wi-Fi locks). */
    public ActivityListener activity;
    public long activityIdleMs = 60_000;
    /** This device's LAN addresses as reported to the hub's directory (null: every IPv4 interface address with the mesh port). */
    public java.util.function.Supplier<java.util.List<io.github.hafijbge.meshdrop.engine.hub.HubClient.LanAddr>> lanAddrs;
    /** Look for a device at the LAN addresses the hub's directory lists for it before relaying (tests turn it off to force the relay). */
    public boolean probeDirectoryAddrs = true;
    public long[] hubBackoffMs = io.github.hafijbge.meshdrop.engine.hub.HubClient.DEFAULT_BACKOFF_MS;

    public interface ActivityListener {
        void onBusy(boolean busy);
    }

    public EngineConfig(File home, KeyVault vault, InboxSink sink) {
        this.home = home;
        this.vault = vault;
        this.sink = sink;
    }
}
