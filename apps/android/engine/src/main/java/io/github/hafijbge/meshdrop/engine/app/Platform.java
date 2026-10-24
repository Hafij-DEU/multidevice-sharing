package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.send.SendItem;
import java.io.IOException;
import java.util.Map;

/** What the AppController needs from the platform (Android, or a fake in tests). */
public interface Platform {
    /** `openRef`: a received file to open when the notification is tapped, or null. */
    void notify(String title, String body, String openRef);

    void writeClipboard(String text);

    String readClipboard();

    void openInbox();

    void reveal(String ref);

    /** A file or folder the UI picked ("file"/"dir"; a path or a content URI) as a send item. */
    SendItem item(String kind, String pathOrUri) throws IOException;

    /** Adds platform fields to the state (platform, keepAlive, sharedPending). */
    void decorate(Map<String, Object> state);
}
