package io.github.hafijbge.meshdrop;

import android.app.Application;

/** Holds the one Core (engine + AppController) of this process. */
public final class MeshApp extends Application {
    private Core core;

    @Override
    public void onCreate() {
        super.onCreate();
        // Build the Core (it reads android-settings.json) off the main thread, so the first core() on
        // the main thread usually finds it ready instead of doing the disk read itself.
        new Thread(this::core, "meshdrop-core").start();
    }

    public synchronized Core core() {
        if (core == null) core = new Core(this);
        return core;
    }
}
