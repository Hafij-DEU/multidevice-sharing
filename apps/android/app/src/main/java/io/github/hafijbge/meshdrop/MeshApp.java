package io.github.hafijbge.meshdrop;

import android.app.Application;

/** Holds the one Core (engine + AppController) of this process. */
public final class MeshApp extends Application {
    private Core core;

    public synchronized Core core() {
        if (core == null) core = new Core(this);
        return core;
    }
}
