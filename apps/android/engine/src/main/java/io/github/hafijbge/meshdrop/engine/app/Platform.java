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

    /** A camera photo or video (MediaStore id and content URI). */
    final class Media {
        public final long id;
        public final String uri;

        public Media(long id, String uri) {
            this.id = id;
            this.uri = uri;
        }
    }

    /** Copied content other than text (Android: content URIs of a copied image or files), or an empty list. */
    default java.util.List<String> clipboardUris() {
        return new java.util.ArrayList<>();
    }

    /** Puts received files on the clipboard (refs as the inbox located them). */
    default void writeClipboardFiles(java.util.List<String> refs) {}

    /** Photo backup exists on this platform (Android). */
    default boolean supportsBackup() {
        return false;
    }

    /** Photo backup: whether the app may read the camera photos and videos. */
    default boolean mediaPermission() {
        return false;
    }

    /** Camera photos and videos (under DCIM/) with a MediaStore id above `afterId`, oldest first, at most `limit`. */
    default java.util.List<Media> cameraMediaAfter(long afterId, int limit) {
        return new java.util.ArrayList<>();
    }

    /** The highest MediaStore id of a camera photo or video now (0: none). */
    default long cameraMediaMaxId() {
        return 0;
    }

    /** A small preview (a data: URL) of a received image or video, or null. */
    default String thumbnail(String ref) {
        return null;
    }

    // ---- M10 ----

    /** Find my device: rings at full alarm volume (even on silent) until stopped. */
    default void ring(boolean on) {}

    /** {battery:{level,charging}, storage:{free,total}, signal:{level,type}} as far as known. */
    default java.util.Map<String, Object> status() {
        return new java.util.LinkedHashMap<>();
    }

    /** Opens an http(s) link a trusted device handed over (or offers it in a notification). */
    default void openUrl(String url) {}

    /** Answers a forwarded notification through its own reply action; false when it is gone. */
    default boolean replyNotification(String key, String text) {
        return false;
    }

    /** Notification access is granted (forwarding needs it). */
    default boolean notificationAccess() {
        return false;
    }

    // ---- M10b: live sound, camera, microphone (LAN) ----

    /** Throws (with what to do) unless this kind ("audio" | "camera" | "mic") can start now; also keeps the service running for it. */
    default void mediaStarting(String kind) throws java.io.IOException {
        throw new java.io.IOException("Not available on this device.");
    }

    default void mediaStopped(String kind) {}

    /** Plays raw s16le 48 kHz stereo from `in` until it ends or `stop` says so. */
    default void playAudio(java.io.InputStream in, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        throw new java.io.IOException("Not available on this device.");
    }

    /** Writes JPEG frames (back to back) from the front (or `back`) camera to `out` until `stop` says so; throws {@link CameraTakenException} when another app has the camera. */
    default void captureCamera(java.io.OutputStream out, java.util.function.BooleanSupplier stop, boolean back) throws java.io.IOException {
        throw new java.io.IOException("Not available on this device.");
    }

    /** Writes s16le 48 kHz mono from the microphone to `out` until `stop` says so. */
    default void captureMic(java.io.OutputStream out, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        throw new java.io.IOException("Not available on this device.");
    }

    /** Writes what this device plays (s16le 48 kHz stereo) to `out` until `stop` says so. */
    default void captureSound(java.io.OutputStream out, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        throw new java.io.IOException("Not available on this device.");
    }

    // ---- M14: sound over a Bluetooth link goes as Opus ----

    /** An Opus encoder: 20 ms of s16le 48 kHz PCM in, Opus packets out. */
    default io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec opusEncoder(int channels, int bitrate) throws java.io.IOException {
        throw new java.io.IOException(io.github.hafijbge.meshdrop.engine.bt.OpusRtp.NO_CODEC);
    }

    /** An Opus decoder: one Opus packet in, s16le 48 kHz PCM out. */
    default io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec opusDecoder(int channels) throws java.io.IOException {
        throw new java.io.IOException(io.github.hafijbge.meshdrop.engine.bt.OpusRtp.NO_CODEC);
    }

    // ---- M14: hotspots, for devices with no Wi-Fi network to share ----

    /**
     * Starts a hotspot on this device for the others to join: "ssid", "psk", and "ips" (this device's
     * addresses on it, a List of String, best first). Closed by {@link #hotspotStop}.
     */
    default java.util.Map<String, Object> hotspotHost() throws java.io.IOException {
        throw new java.io.IOException("Hotspots are not available on this device.");
    }

    /** Joins another device's hotspot (returns once connected); left by {@link #hotspotStop}. */
    default void hotspotJoin(String ssid, String psk) throws java.io.IOException {
        throw new java.io.IOException("Hotspots are not available on this device.");
    }

    /** Ends the hotspot this device hosts, or leaves the one it joined. */
    default void hotspotStop() {}

    // ---- M11 ----

    /** The name a picked file shows (a content:// ref has its own name). */
    default String displayName(String ref) {
        int i = ref.lastIndexOf('/');
        return i >= 0 ? ref.substring(i + 1) : ref;
    }

    /** Deletes a received file (burn after reading). */
    default void deleteReceived(String ref) {
        try {
            java.nio.file.Files.deleteIfExists(java.nio.file.Paths.get(ref));
        } catch (java.io.IOException | RuntimeException ignored) {
            // gone already
        }
    }
}
