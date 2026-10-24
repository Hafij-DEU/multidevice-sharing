package io.github.hafijbge.meshdrop.engine.guest;

import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.recv.InboxSink;
import io.github.hafijbge.meshdrop.engine.util.B64;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * What LAN guests send (guest/uploads.ts). A guest first offers (names, sizes, browser-made
 * thumbnails, text); nothing is stored until the owner accepts. Accepted files are uploaded in slices
 * at exact offsets (so a cut upload resumes where it stopped), kept in partialDir, and published into
 * the inbox under a free name once every file is complete. Reject or end: partial data is deleted and
 * further writes get 410.
 */
public final class GuestUploads {
    public static final int MAX_GUEST_FILES = 1000;
    public static final int MAX_GUEST_TEXT = 64 * 1024;
    public static final int MAX_GUEST_THUMB = 48 * 1024;
    public static final int MAX_GUEST_SLICE = 4 * 1024 * 1024;
    public static final int MAX_GUEST_PENDING = 4;
    /** All thumbnails of one offer together (they travel in every app state update while pending). */
    public static final int MAX_GUEST_THUMBS_TOTAL = 1024 * 1024;
    private static final String PARTIAL_DIR = ".meshdrop-partial";
    private static final Pattern THUMB_RE = Pattern.compile("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$");
    private static final Pattern TYPE_RE = Pattern.compile("^[\\x21-\\x7e][\\x20-\\x7e]{0,127}$");
    private static final SecureRandom RNG = new SecureRandom();

    /** An HTTP answer for the guest: `status`, error `code` and extra JSON fields. */
    public static final class GuestError extends Exception {
        public final int status;
        public final String code;
        public final Map<String, Object> extra;

        public GuestError(int status, String code) {
            this(status, code, new LinkedHashMap<>());
        }

        public GuestError(int status, String code, Map<String, Object> extra) {
            super(code);
            this.status = status;
            this.code = code;
            this.extra = extra;
        }
    }

    private static final class GFile {
        String name;
        long size;
        String type;
        String thumb;
        String rel;
        long received;
        String path;
    }

    private static final class Offer {
        final String id;
        volatile String status = "pending";
        final List<GFile> files;
        final String text;
        /** Landing the files has begun: a reject arriving now is too late. */
        volatile boolean landing;

        Offer(String id, List<GFile> files, String text) {
            this.id = id;
            this.files = files;
            this.text = text;
        }
    }

    private final Map<String, Offer> offers = new LinkedHashMap<>();
    private final File partialDir;
    private final InboxSink sink;
    private final Consumer<Map<String, Object>> onEvent;

    /** Events: {type: "guest-offer"|"guest-file"|"guest-received"|"guest-rejected"|"guest-failed", id, ...}. */
    public GuestUploads(File partialDir, InboxSink sink, Consumer<Map<String, Object>> onEvent) {
        this.partialDir = partialDir;
        this.sink = sink;
        this.onEvent = onEvent;
    }

    private static GuestError bad() {
        return new GuestError(400, "bad-offer");
    }

    private Offer get(String id) throws GuestError {
        Offer o;
        synchronized (offers) {
            o = id == null ? null : offers.get(id);
        }
        if (o == null) throw new GuestError(404, "not-found");
        return o;
    }

    private void emit(String type, String id, Map<String, Object> extra) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("type", type);
        e.put("id", id);
        e.putAll(extra);
        try {
            onEvent.accept(e);
        } catch (RuntimeException ignored) {
            // a failing listener must not break an upload
        }
    }

    private static List<Object> view(List<GFile> files) {
        List<Object> out = new ArrayList<>();
        for (GFile f : files) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", f.name);
            m.put("size", f.size);
            if (f.type != null) m.put("type", f.type);
            if (f.thumb != null) m.put("thumb", f.thumb);
            out.add(m);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Offer parseOffer(Object b) throws GuestError {
        if (!(b instanceof Map)) throw bad();
        Map<String, Object> o = (Map<String, Object>) b;
        Object files = o.containsKey("files") ? o.get("files") : new ArrayList<>();
        if (!(files instanceof List) || ((List<Object>) files).size() > MAX_GUEST_FILES) throw bad();
        String text = null;
        if (o.containsKey("text")) {
            if (!(o.get("text") instanceof String) || ((String) o.get("text")).getBytes(StandardCharsets.UTF_8).length > MAX_GUEST_TEXT) throw bad();
            if (!((String) o.get("text")).isEmpty()) text = (String) o.get("text");
        }
        List<GFile> out = new ArrayList<>();
        long thumbs = 0;
        for (Object x0 : (List<Object>) files) {
            if (!(x0 instanceof Map)) throw bad();
            Map<String, Object> x = (Map<String, Object>) x0;
            if (!(x.get("name") instanceof String) || !(x.get("size") instanceof Long) || (Long) x.get("size") < 0) throw bad();
            GFile g = new GFile();
            g.name = (String) x.get("name");
            g.size = (Long) x.get("size");
            try {
                g.rel = Sanitize.safeRelPath(g.name);
            } catch (RuntimeException e) {
                throw bad();
            }
            if (g.rel.isEmpty()) throw bad();
            if (x.containsKey("type")) {
                if (!(x.get("type") instanceof String) || !TYPE_RE.matcher((String) x.get("type")).matches()) throw bad();
                g.type = (String) x.get("type");
            }
            if (x.containsKey("thumb")) {
                if (!(x.get("thumb") instanceof String)) throw bad();
                String t = (String) x.get("thumb");
                if (t.length() > MAX_GUEST_THUMB || !THUMB_RE.matcher(t).matches()) throw bad();
                g.thumb = t;
                thumbs += t.length();
            }
            out.add(g);
        }
        if (out.isEmpty() && text == null) throw bad();
        // Never inside the inbox's partial area; never one path both a file and a folder.
        Set<String> names = new HashSet<>();
        for (GFile f : out) names.add(f.rel.toLowerCase(Locale.ROOT));
        for (GFile f : out) {
            String[] parts = f.rel.toLowerCase(Locale.ROOT).split("/");
            if (parts[0].equals(PARTIAL_DIR)) throw bad();
            for (int i = 1; i < parts.length; i++) if (names.contains(String.join("/", Arrays.copyOfRange(parts, 0, i)))) throw bad();
        }
        if (thumbs > MAX_GUEST_THUMBS_TOTAL) throw bad();
        byte[] id = new byte[12];
        RNG.nextBytes(id);
        return new Offer(B64.url(id), out, text);
    }

    /** A new offer from the guest's JSON: {id, status: "pending"}. */
    public Map<String, Object> offer(Object body) throws GuestError {
        Offer o = parseOffer(body);
        synchronized (offers) {
            int pending = 0;
            for (Offer x : offers.values()) if (x.status.equals("pending")) pending++;
            if (pending >= MAX_GUEST_PENDING) throw new GuestError(429, "too-many");
            offers.put(o.id, o);
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("files", view(o.files));
        if (o.text != null) extra.put("text", o.text);
        emit("guest-offer", o.id, extra);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("id", o.id);
        r.put("status", "pending");
        return r;
    }

    public boolean has(String id) {
        synchronized (offers) {
            return offers.containsKey(id);
        }
    }

    /** Offers waiting for the owner's answer (for the accept prompt). */
    public List<Map<String, Object>> pending() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (offers) {
            for (Offer o : offers.values()) {
                if (!o.status.equals("pending")) continue;
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", o.id);
                m.put("files", view(o.files));
                if (o.text != null) m.put("text", o.text);
                out.add(m);
            }
        }
        return out;
    }

    public Map<String, Object> status(String id) throws GuestError {
        Offer o = get(id);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", o.status);
        List<Object> files = new ArrayList<>();
        synchronized (o) {
            for (GFile f : o.files) {
                Map<String, Object> x = new LinkedHashMap<>();
                x.put("name", f.name);
                x.put("size", f.size);
                x.put("received", f.received);
                files.add(x);
            }
        }
        m.put("files", files);
        return m;
    }

    private File dirOf(Offer o) {
        return new File(partialDir, o.id);
    }

    public void accept(String id) throws GuestError, IOException {
        Offer o = get(id);
        synchronized (o) {
            if (!o.status.equals("pending")) throw new GuestError(409, o.status);
            o.status = "accepted";
            for (GFile f : o.files) f.thumb = null; // answered: the preview is no longer needed
            File dir = dirOf(o);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            for (int i = 0; i < o.files.size(); i++) if (o.files.get(i).size == 0) new RandomAccessFile(new File(dir, String.valueOf(i)), "rw").close();
            maybeLand(o);
        }
    }

    public void reject(String id) throws GuestError {
        Offer o = get(id);
        if (!o.status.equals("pending") && !o.status.equals("accepted")) return;
        if (o.landing) return; // every byte is in: the files land
        o.status = "rejected"; // at once: a write in flight stops at its next check
        synchronized (o) {
            for (GFile f : o.files) f.thumb = null;
            deleteTree(dirOf(o));
        }
        emit("guest-rejected", id, new LinkedHashMap<>());
    }

    /** The session ended: every unfinished offer is dropped with its partial data. */
    public void cancelAll() {
        List<String> ids = new ArrayList<>();
        synchronized (offers) {
            for (Offer o : offers.values()) if (o.status.equals("pending") || o.status.equals("accepted")) ids.add(o.id);
        }
        for (String id : ids) {
            try {
                reject(id);
            } catch (GuestError ignored) {
                // gone already
            }
        }
    }

    /** Writes one slice at `offset` (which must equal what is stored so far); returns the new total. */
    public long write(String id, int fileIdx, long offset, byte[] data) throws GuestError, IOException {
        Offer o = get(id);
        synchronized (o) {
            if (o.status.equals("rejected")) throw new GuestError(410, "rejected");
            if (o.status.equals("pending")) throw new GuestError(409, "not-accepted");
            GFile f = fileIdx >= 0 && fileIdx < o.files.size() ? o.files.get(fileIdx) : null;
            if (f == null) throw new GuestError(404, "not-found");
            if (!o.status.equals("accepted") || f.received == f.size) return f.received; // complete already (a repeated last slice)
            if (offset != f.received) {
                Map<String, Object> extra = new LinkedHashMap<>();
                extra.put("received", f.received);
                throw new GuestError(409, "offset", extra);
            }
            if (data.length > MAX_GUEST_SLICE) throw new GuestError(413, "too-large");
            if (f.received + data.length > f.size) throw new GuestError(400, "too-large");
            try (RandomAccessFile raf = new RandomAccessFile(new File(dirOf(o), String.valueOf(fileIdx)), "rw")) {
                raf.seek(f.received);
                raf.write(data);
            }
            if (!o.status.equals("accepted")) throw new GuestError(410, "rejected");
            f.received += data.length;
            maybeLand(o);
            return f.received;
        }
    }

    private boolean taken(String rel) {
        try {
            return sink.kind(rel) != InboxSink.Kind.NONE;
        } catch (IOException e) {
            return true;
        }
    }

    /** Every byte is in: publish the files into the inbox together (nothing lands before that). Caller holds o. */
    private void maybeLand(Offer o) {
        if (!o.status.equals("accepted")) return;
        for (GFile f : o.files) if (f.received != f.size) return;
        o.landing = true;
        File dir = dirOf(o);
        Map<String, String> tops = new HashMap<>(); // a folder's top name -> its free name in the inbox, for this offer
        List<String> landed = new ArrayList<>();
        try {
            for (int i = 0; i < o.files.size(); i++) {
                GFile f = o.files.get(i);
                List<String> parts = new ArrayList<>(Arrays.asList(f.rel.split("/")));
                String base = parts.remove(parts.size() - 1);
                if (!parts.isEmpty()) {
                    String first = parts.get(0);
                    String top = tops.get(first);
                    if (top == null) {
                        top = Sanitize.uniqueName(first, this::taken); // never merged into a folder already there
                        tops.put(first, top);
                    }
                    parts.set(0, top);
                }
                String relDir = String.join("/", parts);
                sink.mkdirs(relDir);
                File part = new File(dir, String.valueOf(i));
                for (;;) {
                    String name = Sanitize.uniqueName(base, n -> taken(relDir.isEmpty() ? n : relDir + "/" + n));
                    String rel = relDir.isEmpty() ? name : relDir + "/" + name;
                    String got = sink.publishAs(rel, part, f.type);
                    if (got == null) continue; // lost a race for this name: take the next
                    f.path = sink.locate(got);
                    landed.add(f.path);
                    break;
                }
                Map<String, Object> extra = new LinkedHashMap<>();
                extra.put("path", f.path);
                emit("guest-file", o.id, extra);
            }
        } catch (IOException | RuntimeException e) {
            // The guest is told it failed and the owner gets an event. Unlike the desktop, files already
            // published stay: the sink (MediaStore) has no delete.
            o.status = "failed";
            deleteTree(dir);
            Map<String, Object> extra = new LinkedHashMap<>();
            extra.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            emit("guest-failed", o.id, extra);
            return;
        }
        o.status = "done";
        deleteTree(dir);
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("files", new ArrayList<Object>(landed));
        if (o.text != null) extra.put("text", o.text);
        emit("guest-received", o.id, extra);
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
