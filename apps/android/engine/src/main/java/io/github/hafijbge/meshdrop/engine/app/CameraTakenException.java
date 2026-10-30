package io.github.hafijbge.meshdrop.engine.app;

import java.io.IOException;

/** Another app has the camera (face unlock when the phone wakes, a camera app): it may come back. */
public class CameraTakenException extends IOException {
    public CameraTakenException() {
        super("Another app is using the camera: close it, then tap again.");
    }
}
