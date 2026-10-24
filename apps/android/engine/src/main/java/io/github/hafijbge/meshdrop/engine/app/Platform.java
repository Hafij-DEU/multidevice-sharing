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

    /** Adds platform fields to the state (platform, keepAlive, sharedPending, joinLink). */
    void decorate(Map<String, Object> state);

    /** A join was attempted: a pending meshdrop://join link has been dealt with. */
    default void joinHandled() {}

    /** A small preview (a data: URL) of a received image or video, or null. */
    default String thumbnail(String ref) {
        return null;
    }
}
