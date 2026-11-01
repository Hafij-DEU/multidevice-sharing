package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.os.Build;
import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.app.AppController;
import io.github.hafijbge.meshdrop.engine.app.HistoryStore;
import io.github.hafijbge.meshdrop.engine.app.Settings;
import io.github.hafijbge.meshdrop.engine.app.SettingsStore;
import io.github.hafijbge.meshdrop.engine.recv.InboxSink;
import java.io.File;
import java.io.IOException;

/** The engine and the AppController for this process, started once and shared by the UI and the service. */
public final class Core {
    public final Context app;
    public final File home;
    public final AndroidPlatform platform;
    public final AppController controller;
    private boolean started;

    Core(Context ctx) {
        this.app = ctx.getApplicationContext();
        this.home = new File(app.getFilesDir(), "meshdrop");
        io.github.hafijbge.meshdrop.engine.app.Tr.load(new File(home, "lang.json")); // notifications before the page loads
        this.platform = new AndroidPlatform(app);
        SettingsStore settings = new SettingsStore(new File(home, "android-settings.json"), Settings.defaults(Build.MODEL == null ? "Android" : Build.MODEL));
        HistoryStore history = new HistoryStore(new File(home, "desktop-history.json"));
        InboxSink sink = platform.inboxSink();
        this.controller = new AppController(settings, history, platform, s -> {
            EngineConfig c = new EngineConfig(home, platform.keyVault(), sink);
            c.port = s.port;
            c.alias = s.alias;
            c.deviceType = "mobile";
            c.discovery = s.discovery;
            c.multicastHooks = platform.multicastHooks();
            c.resolver = platform.resolver();
            c.activity = platform.transferLocks();
            if (s.bluetooth) c.bt = new AndroidBt(app); // M14: links to paired devices without Wi-Fi
            c.btPolicy = AppController.linkPolicy(s);
            c.syncFolders = folder -> folder.startsWith("content://")
                    ? new SafSyncFolder(app, android.net.Uri.parse(folder))
                    : new io.github.hafijbge.meshdrop.engine.sync.PathSyncFolder(java.nio.file.Paths.get(folder));
            return Engine.create(c);
        });
        platform.attach(controller);
    }

    /** Starts the engine once (on a background thread: it binds sockets and may create the identity). */
    public synchronized void ensureStarted() throws IOException {
        if (started) return;
        controller.start();
        started = true;
    }

    public synchronized boolean started() {
        return started;
    }
}
