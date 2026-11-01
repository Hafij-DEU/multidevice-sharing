package io.github.hafijbge.meshdrop.picker;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.TypedArray;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.text.TextUtils;
import android.text.format.DateFormat;
import android.text.format.Formatter;
import android.util.LruCache;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.MimeTypeMap;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.Spinner;
import android.widget.TextView;
import java.io.File;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lets the user tick what to send: the newest items first (Recent), then Videos, Photos, Audio,
 * installed Apps, APK files on storage and other Files, each sortable by date, name or size. The
 * ticks survive tab switches and go back to the caller as parallel arrays (uri, name, size, mime);
 * an installed app becomes its base APK plus any split APKs. Files on storage come back as file://
 * URIs, media and picked documents as content:// URIs (picked documents keep a persisted grant).
 */
public final class PickerActivity extends Activity {
    public static final String EXTRA_URIS = "uris";
    public static final String EXTRA_NAMES = "names";
    public static final String EXTRA_SIZES = "sizes";
    public static final String EXTRA_MIMES = "mimes";
    /** Optional input: the most files the caller can take at once (0 or absent: no limit). */
    public static final String EXTRA_MAX = "max";
    /** How many of the newest items the Recent tab lists. */
    private static final int RECENT_MAX = 300;
    private static final int REQ_MEDIA = 1;
    private static final int REQ_BROWSE = 2;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    /** MIUI and HyperOS hide the app list behind this runtime permission (only where it exists). */
    private static final String MIUI_APP_LIST = "com.android.permission.GET_INSTALLED_APPS";
    private static final int ACCENT = 0xff2563eb;
    private static final String[] SORTS = {"Newest first", "Oldest first", "Name A–Z", "Name Z–A", "Largest first", "Smallest first"};

    private enum Kind {
        RECENT("Recent", 0xff0d9488),
        VIDEOS("Videos", 0xffdc2626),
        PHOTOS("Photos", 0xff16a34a),
        AUDIO("Audio", 0xff9333ea),
        APPS("Apps", ACCENT),
        APKS("APK files", 0xff0891b2),
        FILES("Files", 0xff64748b);

        final String label;
        final int color;

        Kind(String label, int color) {
            this.label = label;
            this.color = color;
        }
    }

    /** One row: a media item, a file, an APK file or an installed app. */
    private static final class Entry {
        final String key;
        final Kind kind;
        final Uri uri;
        final String name; // the file name the receiver gets
        final long size;
        final String mime;
        final long date; // ms
        String title; // what the row shows; the app label for apps and APK files
        String detail = "";
        boolean notInstalled;
        String pkg; // installed apps: whose icon to show
        String apkPath; // APK files: where to read the icon from
        List<Part> parts; // installed apps: base APK plus splits

        Entry(String key, Kind kind, Uri uri, String name, long size, String mime, long date) {
            this.key = key;
            this.kind = kind;
            this.uri = uri;
            this.name = name;
            this.title = name;
            this.size = size;
            this.mime = mime;
            this.date = date;
        }

        int fileCount() {
            return parts != null ? parts.size() : 1;
        }
    }

    /** One file of an installed app (its base APK or a split), with the name the receiver gets. */
    private static final class Part {
        final Uri uri;
        final String name;
        final long size;
        final String mime;

        Part(Uri uri, String name, long size, String mime) {
            this.uri = uri;
            this.name = safeName(name);
            this.size = size;
            this.mime = mime;
        }
    }

    private final Map<Kind, List<Entry>> loaded = new EnumMap<>(Kind.class);
    private final Set<Kind> loading = new HashSet<>();
    private final Map<Kind, Integer> sortOf = new EnumMap<>(Kind.class);
    private final Map<Kind, TextView> tabs = new EnumMap<>(Kind.class);
    private final Map<String, Entry> selected = new LinkedHashMap<>();
    private final List<Entry> browsed = new ArrayList<>();
    private final Set<String> recentKeys = new HashSet<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService iconPool = Executors.newFixedThreadPool(2);
    private final LruCache<String, Drawable> icons = new LruCache<>(300);
    private final Set<String> noArt = new HashSet<>();
    private final Collator collator = Collator.getInstance();
    private final Rows rows = new Rows();
    private PackageManager pm;
    private java.text.DateFormat dates;
    private Kind current;
    private boolean quiet;
    private int maxFiles;
    private boolean hadAllFiles;

    private Spinner sort;
    private CheckBox notInstalledOnly;
    private Button browse;
    private CheckBox selectAll;
    private LinearLayout notice;
    private TextView noticeText;
    private TextView empty;
    private TextView count;
    private Button done;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        pm = getPackageManager();
        dates = DateFormat.getMediumDateFormat(this);
        maxFiles = getIntent().getIntExtra(EXTRA_MAX, 0);
        hadAllFiles = allFiles();
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        TextView title = new TextView(this);
        title.setText("Choose what to send");
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(dp(16), dp(16), dp(16), dp(8));
        root.addView(title);

        HorizontalScrollView tabScroll = new HorizontalScrollView(this);
        tabScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabBar = new LinearLayout(this);
        tabBar.setPadding(dp(8), 0, dp(8), 0);
        for (Kind k : Kind.values()) {
            TextView t = new TextView(this);
            t.setPadding(dp(14), dp(8), dp(14), dp(8));
            t.setTextSize(15);
            t.setOnClickListener(v -> show(k));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMargins(dp(2), 0, dp(2), 0);
            tabBar.addView(t, lp);
            tabs.put(k, t);
            sortOf.put(k, k == Kind.APPS ? 2 : 0);
        }
        tabScroll.addView(tabBar);
        root.addView(tabScroll);

        LinearLayout tools = new LinearLayout(this);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        tools.setPadding(dp(8), dp(4), dp(8), dp(4));
        sort = new Spinner(this);
        ArrayAdapter<String> sorts = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, SORTS);
        sorts.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sort.setAdapter(sorts);
        sort.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (quiet || current == null || sortOf.get(current) == position) return;
                sortOf.put(current, position);
                refreshList();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        tools.addView(sort, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        notInstalledOnly = new CheckBox(this);
        notInstalledOnly.setText("Not installed only");
        notInstalledOnly.setOnCheckedChangeListener((b, on) -> refreshList());
        tools.addView(notInstalledOnly);
        browse = new Button(this);
        browse.setText("Browse…");
        browse.setOnClickListener(v -> startActivityForResult(
                new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true),
                REQ_BROWSE));
        tools.addView(browse);
        selectAll = new CheckBox(this);
        selectAll.setText("All");
        selectAll.setOnCheckedChangeListener((b, on) -> {
            if (quiet) return;
            for (int i = 0; i < rows.getCount(); i++) {
                Entry e = rows.getItem(i);
                if (on) selected.put(e.key, e);
                else selected.remove(e.key);
            }
            changed();
        });
        tools.addView(selectAll);
        root.addView(tools);

        notice = new LinearLayout(this);
        notice.setOrientation(LinearLayout.VERTICAL);
        notice.setPadding(dp(16), dp(8), dp(16), dp(8));
        noticeText = new TextView(this);
        notice.addView(noticeText);
        Button allow = new Button(this);
        allow.setText("Allow");
        allow.setOnClickListener(v -> askAccess());
        notice.addView(allow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(notice);

        FrameLayout listBox = new FrameLayout(this);
        ListView list = new ListView(this);
        list.setAdapter(rows);
        listBox.addView(list);
        empty = new TextView(this);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(24), dp(24), dp(24), dp(24));
        listBox.addView(empty, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        list.setEmptyView(empty);
        root.addView(listBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(8), dp(8), dp(8));
        bar.setBackgroundColor(0xffeef2f7);
        count = new TextView(this);
        bar.addView(count, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button clear = new Button(this);
        clear.setText("Clear");
        clear.setOnClickListener(v -> {
            selected.clear();
            changed();
        });
        bar.addView(clear);
        done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(v -> finishWithSelection());
        bar.addView(done);
        root.addView(bar);

        // the system-bar insets replace a view's own padding, so they go on a wrapper
        FrameLayout frame = new FrameLayout(this);
        frame.setFitsSystemWindows(true);
        frame.addView(root);
        setContentView(frame);
        show(Kind.RECENT);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // coming back from the All files access screen: what the loaded tabs may list has changed
        boolean all = allFiles();
        if (all != hadAllFiles) {
            hadAllFiles = all;
            loaded.keySet().removeIf(k -> !loading.contains(k));
        }
        if (current != null) show(current);
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        iconPool.shutdownNow();
        super.onDestroy();
    }

    private void show(Kind kind) {
        current = kind;
        for (Map.Entry<Kind, TextView> t : tabs.entrySet()) styleTab(t.getKey(), t.getValue());
        quiet = true;
        sort.setSelection(sortOf.get(kind), false);
        quiet = false;
        notInstalledOnly.setVisibility(kind == Kind.APKS ? View.VISIBLE : View.GONE);
        browse.setVisibility(kind == Kind.FILES ? View.VISIBLE : View.GONE);
        String missing = missingAccess(kind);
        String note = missing != null ? missing
                : limited(kind) ? "Only the photos and videos you allowed are shown. Tap Allow to choose more."
                : kind == Kind.RECENT && !allFiles() ? "Showing photos, videos and audio. Allow All files access to add documents and APK files." : null;
        notice.setVisibility(note == null ? View.GONE : View.VISIBLE);
        noticeText.setText(note);
        if (missing == null && !loaded.containsKey(kind)) load(kind);
        refreshList();
    }

    private void styleTab(Kind k, TextView t) {
        boolean on = k == current;
        t.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        t.setTextColor(on ? ACCENT : 0xff475569);
        GradientDrawable pill = t.getBackground() instanceof GradientDrawable ? (GradientDrawable) t.getBackground() : new GradientDrawable();
        pill.setCornerRadius(dp(18));
        pill.setColor(on ? 0xffdbeafe : 0x00000000);
        t.setBackground(pill);
    }

    /** The tab's name with how many of its items are ticked. */
    private String tabLabel(Kind k) {
        int n = 0;
        for (Entry e : selected.values()) if (k == Kind.RECENT ? recentKeys.contains(e.key) : e.kind == k) n++;
        return n > 0 ? k.label + " (" + n + ")" : k.label;
    }

    /** Why a tab cannot be listed yet, or null when it can. */
    private String missingAccess(Kind kind) {
        switch (kind) {
            case RECENT:
                return allFiles() || anyMedia() ? null : "Allow access to your photos, videos and audio to list the newest ones here.";
            case APPS:
                return hasMiuiAppList() && !granted(MIUI_APP_LIST) ? "Allow access to your installed apps to list them here." : null;
            case APKS:
            case FILES:
                return allFiles() ? null
                        : "Listing APK files and documents saved by other apps needs All files access. Only the files you send are read.";
            default:
                return allFiles() || granted(mediaPermission(kind)) || limited(kind) ? null
                        : "Allow access to your " + kind.label.toLowerCase(Locale.ROOT) + " to list them here.";
        }
    }

    /** Android 14's "Allow limited access": only the photos and videos the user picked are listed. */
    private boolean limited(Kind kind) {
        return Build.VERSION.SDK_INT >= 34 && (kind == Kind.VIDEOS || kind == Kind.PHOTOS) && !allFiles()
                && !granted(mediaPermission(kind)) && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
    }

    /** Whether any kind of media may be listed (fully or, on Android 14, only what the user allowed). */
    private boolean anyMedia() {
        if (Build.VERSION.SDK_INT < 33) return granted(Manifest.permission.READ_EXTERNAL_STORAGE);
        return granted(Manifest.permission.READ_MEDIA_VIDEO) || granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_AUDIO)
                || Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
    }

    private boolean allFiles() {
        return Build.VERSION.SDK_INT >= 30 ? Environment.isExternalStorageManager() : granted(Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    private boolean granted(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasMiuiAppList() {
        try {
            pm.getPermissionInfo(MIUI_APP_LIST, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static String mediaPermission(Kind kind) {
        if (Build.VERSION.SDK_INT < 33) return Manifest.permission.READ_EXTERNAL_STORAGE;
        if (kind == Kind.VIDEOS) return Manifest.permission.READ_MEDIA_VIDEO;
        if (kind == Kind.PHOTOS) return Manifest.permission.READ_MEDIA_IMAGES;
        return Manifest.permission.READ_MEDIA_AUDIO;
    }

    private void askAccess() {
        if (current == Kind.RECENT && !anyMedia()) {
            if (Build.VERSION.SDK_INT < 33) {
                requestPermissions(new String[] {Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_MEDIA);
            } else if (Build.VERSION.SDK_INT < 34) {
                requestPermissions(new String[] {Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_AUDIO}, REQ_MEDIA);
            } else {
                requestPermissions(new String[] {Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_AUDIO,
                        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED}, REQ_MEDIA);
            }
        } else if (current == Kind.APPS) {
            requestPermissions(new String[] {MIUI_APP_LIST}, REQ_MEDIA);
        } else if (current == Kind.RECENT || current == Kind.APKS || current == Kind.FILES) {
            askAllFiles();
        } else if (Build.VERSION.SDK_INT >= 34 && current != Kind.AUDIO) {
            // asking again while access is limited lets the user change which items are allowed
            requestPermissions(new String[] {mediaPermission(current), Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED}, REQ_MEDIA);
        } else {
            requestPermissions(new String[] {mediaPermission(current)}, REQ_MEDIA);
        }
    }

    private void askAllFiles() {
        if (Build.VERSION.SDK_INT < 30) {
            requestPermissions(new String[] {Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_MEDIA);
            return;
        }
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_MEDIA || current == null) return;
        // what may be listed can change with the answer, so the tab is read again
        if (!loading.contains(current)) loaded.remove(current);
        show(current);
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != REQ_BROWSE || result != RESULT_OK || data == null) return;
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        long now = System.currentTimeMillis();
        for (Uri u : uris) {
            Part s = described(u);
            if (s == null) continue;
            try {
                // the grant ends with this screen, and the caller may read the file much later
                getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException notPersistable) {
                // fine while the app runs
            }
            Entry e = new Entry("saf:" + u, Kind.FILES, u, s.name, s.size, s.mime, now);
            e.detail = "Picked";
            browsed.removeIf(b -> b.key.equals(e.key));
            browsed.add(e);
            selected.put(e.key, e);
        }
        show(Kind.FILES);
    }

    /** The name, size and type a document provider reports; null when it cannot be read or has no size. */
    private Part described(Uri uri) {
        String name = null;
        long size = -1;
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        } catch (RuntimeException e) {
            return null;
        }
        if (size < 0) return null;
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "file";
        name = safeName(name);
        String mime = getContentResolver().getType(uri);
        if (mime == null) {
            int dot = name.lastIndexOf('.');
            mime = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        }
        return new Part(uri, name, size, mime != null ? mime : "application/octet-stream");
    }

    private void load(Kind kind) {
        if (!loading.add(kind)) return;
        io.execute(() -> {
            List<Entry> out;
            try {
                out = query(kind);
            } catch (RuntimeException e) {
                out = new ArrayList<>();
            }
            List<Entry> got = out;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                loading.remove(kind);
                loaded.put(kind, got);
                if (kind == Kind.RECENT) {
                    recentKeys.clear();
                    for (Entry e : got) recentKeys.add(e.key);
                    updateBar();
                }
                if (current == kind) refreshList();
            });
        });
    }

    private List<Entry> query(Kind kind) {
        switch (kind) {
            case RECENT:
                return recent();
            case VIDEOS:
            case PHOTOS:
            case AUDIO:
                return media(mediaBase(kind), kind);
            case APPS:
                return apps();
            case APKS:
                return apks();
            default:
                return files();
        }
    }

    private static Uri mediaBase(Kind kind) {
        if (kind == Kind.VIDEOS) return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
        if (kind == Kind.PHOTOS) return MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
        return MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
    }

    /**
     * The newest items of every kind this app may see, by when they arrived on the phone. Each keeps
     * the key its own tab gives it, so a tick here is the same tick there.
     */
    @SuppressWarnings("deprecation") // see files()
    private List<Entry> recent() {
        List<Entry> out = new ArrayList<>();
        Uri base = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL);
        String[] cols = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.MIME_TYPE, MediaStore.Files.FileColumns.MEDIA_TYPE};
        String sel = MediaStore.MediaColumns.SIZE + ">0 AND " + MediaStore.MediaColumns.MIME_TYPE + " IS NOT NULL";
        try (Cursor c = getContentResolver().query(base, cols, sel, null, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            while (c != null && out.size() < RECENT_MAX && c.moveToNext()) {
                if (c.isNull(1)) continue;
                String path = c.getString(1);
                String name = c.isNull(2) ? new File(path).getName() : safeName(c.getString(2));
                if (name.startsWith(".") || path.contains("/.")) continue;
                String mime = c.getString(5);
                Kind kind;
                switch (c.getInt(6)) {
                    case MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE:
                        kind = Kind.PHOTOS;
                        break;
                    case MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO:
                        kind = Kind.VIDEOS;
                        break;
                    case MediaStore.Files.FileColumns.MEDIA_TYPE_AUDIO:
                        kind = Kind.AUDIO;
                        break;
                    default:
                        kind = APK_MIME.equals(mime) || name.toLowerCase(Locale.ROOT).endsWith(".apk") ? Kind.APKS : Kind.FILES;
                }
                Entry e;
                if (kind == Kind.APKS || kind == Kind.FILES) {
                    e = new Entry("file:" + path, kind, Uri.fromFile(new File(path)), name, c.getLong(3), kind == Kind.APKS ? APK_MIME : mime, c.getLong(4) * 1000);
                    if (kind == Kind.APKS) e.apkPath = path;
                } else {
                    Uri u = ContentUris.withAppendedId(mediaBase(kind), c.getLong(0));
                    e = new Entry(u.toString(), kind, u, name, c.getLong(3), mime, c.getLong(4) * 1000);
                }
                File dir = new File(path).getParentFile();
                if (dir != null) e.detail = dir.getName();
                out.add(e);
            }
        }
        return out;
    }

    private List<Entry> media(Uri base, Kind kind) {
        List<Entry> out = new ArrayList<>();
        String[] cols = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.MIME_TYPE};
        try (Cursor c = getContentResolver().query(base, cols, MediaStore.MediaColumns.SIZE + ">0", null, null)) {
            while (c != null && c.moveToNext()) {
                Uri u = ContentUris.withAppendedId(base, c.getLong(0));
                String name = c.isNull(1) ? "file" : safeName(c.getString(1));
                String mime = c.isNull(4) ? "application/octet-stream" : c.getString(4);
                out.add(new Entry(u.toString(), kind, u, name, c.getLong(2), mime, c.getLong(3) * 1000));
            }
        }
        return out;
    }

    /** Documents, archives and other non-media files (needs All files access to see other apps' files). */
    @SuppressWarnings("deprecation") // DATA is the only way to the path, and All files access may open it directly
    private List<Entry> files() {
        List<Entry> out = new ArrayList<>();
        String sel = MediaStore.Files.FileColumns.MEDIA_TYPE + " NOT IN (1,2,3) AND " + MediaStore.MediaColumns.MIME_TYPE + " IS NOT NULL AND "
                + MediaStore.MediaColumns.MIME_TYPE + "!=? AND " + MediaStore.MediaColumns.SIZE + ">0";
        for (Row r : rows(sel, new String[] {APK_MIME})) {
            if (r.path.contains("/.") || r.path.toLowerCase(Locale.ROOT).endsWith(".apk")) continue;
            out.add(new Entry("file:" + r.path, Kind.FILES, Uri.fromFile(new File(r.path)), r.name, r.size, r.mime, r.date));
        }
        return out;
    }

    /** APK files on storage, each marked installed, not installed, newer or older. */
    @SuppressWarnings("deprecation") // the int-flag PackageManager calls are fine on every API level this runs on
    private List<Entry> apks() {
        List<Entry> out = new ArrayList<>();
        String sel = "(" + MediaStore.MediaColumns.DATA + " LIKE ? OR " + MediaStore.MediaColumns.MIME_TYPE + "=?) AND " + MediaStore.MediaColumns.SIZE + ">0";
        for (Row r : rows(sel, new String[] {"%.apk", APK_MIME})) {
            Entry e = new Entry("file:" + r.path, Kind.APKS, Uri.fromFile(new File(r.path)), r.name, r.size, APK_MIME, r.date);
            e.apkPath = r.path;
            PackageInfo pi = pm.getPackageArchiveInfo(r.path, 0);
            if (pi == null || pi.applicationInfo == null) {
                e.detail = "Can't read this APK";
                e.notInstalled = true;
            } else {
                ApplicationInfo ai = pi.applicationInfo;
                ai.sourceDir = r.path;
                ai.publicSourceDir = r.path;
                e.title = ai.loadLabel(pm).toString();
                String status;
                try {
                    long have = pm.getPackageInfo(pi.packageName, 0).getLongVersionCode();
                    long file = pi.getLongVersionCode();
                    status = file > have ? "Newer than installed" : file < have ? "Older than installed" : "Installed";
                } catch (PackageManager.NameNotFoundException notThere) {
                    status = "Not installed";
                    e.notInstalled = true;
                }
                e.detail = (pi.versionName != null ? "v" + pi.versionName + " • " : "") + status + " • " + r.name;
            }
            out.add(e);
        }
        return out;
    }

    /** Apps the user installed (and updated system apps); each is sent as its base APK plus splits. */
    @SuppressWarnings("deprecation") // the int-flag PackageManager calls are fine on every API level this runs on
    private List<Entry> apps() {
        List<Entry> out = new ArrayList<>();
        for (PackageInfo pi : pm.getInstalledPackages(0)) {
            ApplicationInfo ai = pi.applicationInfo;
            if (ai == null || pi.packageName.equals(getPackageName()) || ai.sourceDir == null) continue;
            if ((ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0) continue;
            String label = ai.loadLabel(pm).toString();
            String base = safeName(label).replace(':', '_').trim();
            if (base.isEmpty()) base = pi.packageName;
            List<Part> parts = new ArrayList<>();
            File apk = new File(ai.sourceDir);
            parts.add(new Part(Uri.fromFile(apk), base + ".apk", apk.length(), APK_MIME));
            if (ai.splitSourceDirs != null) {
                for (String s : ai.splitSourceDirs) {
                    File f = new File(s);
                    parts.add(new Part(Uri.fromFile(f), base + " - " + f.getName(), f.length(), APK_MIME));
                }
            }
            long size = 0;
            for (Part p : parts) size += p.size;
            Entry e = new Entry("app:" + pi.packageName, Kind.APPS, parts.get(0).uri, parts.get(0).name, size, APK_MIME, pi.lastUpdateTime);
            e.title = label;
            e.pkg = pi.packageName;
            e.parts = parts;
            e.detail = (pi.versionName != null ? "v" + pi.versionName : pi.packageName)
                    + (parts.size() > 1 ? " • split app, " + parts.size() + " APKs" : "");
            out.add(e);
        }
        return out;
    }

    private static final class Row {
        String path;
        String name;
        long size;
        long date;
        String mime;
    }

    @SuppressWarnings("deprecation") // see files()
    private List<Row> rows(String selection, String[] args) {
        List<Row> out = new ArrayList<>();
        Uri base = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL);
        String[] cols = {MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.MIME_TYPE};
        try (Cursor c = getContentResolver().query(base, cols, selection, args, null)) {
            while (c != null && c.moveToNext()) {
                if (c.isNull(0)) continue;
                Row r = new Row();
                r.path = c.getString(0);
                r.name = c.isNull(1) ? new File(r.path).getName() : safeName(c.getString(1));
                if (r.name.startsWith(".")) continue;
                r.size = c.getLong(2);
                r.date = c.getLong(3) * 1000;
                r.mime = c.isNull(4) ? "application/octet-stream" : c.getString(4);
                out.add(r);
            }
        }
        return out;
    }

    private static String safeName(String name) {
        return name.replace('/', '_').replace('\\', '_');
    }

    private void refreshList() {
        if (current == null) return;
        List<Entry> show = new ArrayList<>();
        if (current == Kind.FILES) show.addAll(browsed);
        List<Entry> got = loaded.get(current);
        boolean blocked = missingAccess(current) != null;
        if (got != null && !blocked) show.addAll(got);
        if (current == Kind.APKS && notInstalledOnly.isChecked()) show.removeIf(e -> !e.notInstalled);
        show.sort(order(sortOf.get(current)));
        rows.set(show);
        if (blocked) empty.setText(current == Kind.FILES ? "Or tap Browse… to pick files with the system picker." : "");
        else if (got == null) empty.setText("Loading…");
        else empty.setText("Nothing here.");
        changed();
    }

    private Comparator<Entry> order(int s) {
        Comparator<Entry> byName = (a, b) -> collator.compare(a.title, b.title);
        switch (s) {
            case 1:
                return Comparator.comparingLong((Entry e) -> e.date);
            case 2:
                return byName;
            case 3:
                return byName.reversed();
            case 4:
                return Comparator.comparingLong((Entry e) -> e.size).reversed();
            case 5:
                return Comparator.comparingLong((Entry e) -> e.size);
            default:
                return Comparator.comparingLong((Entry e) -> e.date).reversed();
        }
    }

    /**
     * Ticks or unticks one row. Rows take their own taps: ListView keeps a single pending item click,
     * so a second tap within its 64 ms pressed delay replaced the first and one tick was lost.
     */
    private void toggle(Holder h) {
        Entry e = h.entry;
        boolean on = selected.remove(e.key) == null;
        if (on) selected.put(e.key, e);
        // only this row's tick changes, so the list is not rebuilt
        h.box.setChecked(on);
        updateBar();
    }

    /** Re-reads the ticks into the rows, then updates everything around them. */
    private void changed() {
        rows.notifyDataSetChanged();
        updateBar();
    }

    /** Updates the tab counts, the All box and the bottom bar from the ticks. */
    private void updateBar() {
        for (Map.Entry<Kind, TextView> t : tabs.entrySet()) {
            String label = tabLabel(t.getKey());
            if (!label.contentEquals(t.getValue().getText())) t.getValue().setText(label);
        }
        boolean all = rows.getCount() > 0;
        for (int i = 0; all && i < rows.getCount(); i++) all = selected.containsKey(rows.getItem(i).key);
        quiet = true;
        selectAll.setChecked(all);
        selectAll.setEnabled(rows.getCount() > 0);
        quiet = false;
        int files = 0;
        long bytes = 0;
        for (Entry e : selected.values()) {
            files += e.fileCount();
            bytes += e.size;
        }
        boolean tooMany = maxFiles > 0 && files > maxFiles;
        if (selected.isEmpty()) count.setText("Nothing selected");
        else if (tooMany) count.setText(files + " files: up to " + maxFiles + " can go at a time");
        else count.setText(selected.size() + " selected • " + Formatter.formatFileSize(this, bytes));
        done.setEnabled(!selected.isEmpty() && !tooMany);
    }

    private void finishWithSelection() {
        ArrayList<Uri> uris = new ArrayList<>();
        ArrayList<String> names = new ArrayList<>();
        ArrayList<String> mimes = new ArrayList<>();
        List<Long> sizes = new ArrayList<>();
        for (Entry e : selected.values()) {
            if (e.parts != null) {
                for (Part p : e.parts) {
                    uris.add(p.uri);
                    names.add(p.name);
                    sizes.add(p.size);
                    mimes.add(p.mime);
                }
            } else {
                uris.add(e.uri);
                names.add(e.name);
                sizes.add(e.size);
                mimes.add(e.mime);
            }
        }
        long[] sz = new long[sizes.size()];
        for (int i = 0; i < sz.length; i++) sz[i] = sizes.get(i);
        setResult(RESULT_OK, new Intent()
                .putParcelableArrayListExtra(EXTRA_URIS, uris)
                .putStringArrayListExtra(EXTRA_NAMES, names)
                .putExtra(EXTRA_SIZES, sz)
                .putStringArrayListExtra(EXTRA_MIMES, mimes));
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private final class Rows extends BaseAdapter {
        private List<Entry> items = new ArrayList<>();

        void set(List<Entry> items) {
            this.items = items;
            notifyDataSetChanged();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public Entry getItem(int position) {
            return items.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convert, ViewGroup parent) {
            Holder h;
            if (convert == null) {
                h = new Holder();
                LinearLayout row = new LinearLayout(PickerActivity.this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(12), dp(8), dp(12), dp(8));
                row.setMinimumHeight(dp(64));
                TypedArray ripple = obtainStyledAttributes(new int[] {android.R.attr.selectableItemBackground});
                row.setBackground(ripple.getDrawable(0));
                ripple.recycle();
                row.setOnClickListener(v -> toggle((Holder) v.getTag()));
                h.box = new CheckBox(PickerActivity.this);
                h.box.setFocusable(false);
                h.box.setClickable(false);
                row.addView(h.box);
                h.icon = new ImageView(PickerActivity.this);
                h.icon.setScaleType(ImageView.ScaleType.CENTER_CROP);
                LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(48), dp(48));
                ilp.setMargins(dp(4), 0, dp(12), 0);
                row.addView(h.icon, ilp);
                LinearLayout texts = new LinearLayout(PickerActivity.this);
                texts.setOrientation(LinearLayout.VERTICAL);
                h.title = new TextView(PickerActivity.this);
                h.title.setTextSize(15);
                h.title.setTextColor(0xff0f172a);
                h.title.setSingleLine(true);
                h.title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                texts.addView(h.title);
                h.sub = new TextView(PickerActivity.this);
                h.sub.setTextSize(12);
                h.sub.setTextColor(0xff64748b);
                h.sub.setSingleLine(true);
                h.sub.setEllipsize(TextUtils.TruncateAt.END);
                texts.addView(h.sub);
                row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                row.setTag(h);
                convert = row;
            } else {
                h = (Holder) convert.getTag();
            }
            Entry e = items.get(position);
            h.entry = e;
            h.box.setChecked(selected.containsKey(e.key));
            h.title.setText(e.title);
            StringBuilder sub = new StringBuilder(Formatter.formatShortFileSize(PickerActivity.this, e.size));
            if (e.date > 0) sub.append(" • ").append(dates.format(e.date));
            if (!e.detail.isEmpty()) sub.append(" • ").append(e.detail);
            h.sub.setText(sub);
            h.sub.setTextColor(e.kind == Kind.APKS && e.notInstalled ? 0xffb45309 : 0xff64748b);
            icon(h.icon, e);
            return convert;
        }
    }

    private static final class Holder {
        Entry entry;
        CheckBox box;
        ImageView icon;
        TextView title;
        TextView sub;
    }

    /** Shows a cached icon or thumbnail, else a coloured tile while the real one loads. */
    private void icon(ImageView v, Entry e) {
        v.setTag(e.key);
        Drawable have = icons.get(e.key);
        if (have != null) {
            v.setImageDrawable(have);
            return;
        }
        v.setImageDrawable(new Tile(e.kind.color, tileText(e)));
        if (e.kind == Kind.FILES || noArt.contains(e.key)) return;
        iconPool.execute(() -> {
            Drawable got = loadIcon(e);
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                if (got == null) {
                    noArt.add(e.key);
                    return;
                }
                icons.put(e.key, got);
                if (e.key.equals(v.getTag())) v.setImageDrawable(got);
            });
        });
    }

    @SuppressWarnings("deprecation") // see apks()
    private Drawable loadIcon(Entry e) {
        try {
            if (e.kind == Kind.APPS) return pm.getApplicationIcon(e.pkg);
            if (e.kind == Kind.APKS) {
                PackageInfo pi = pm.getPackageArchiveInfo(e.apkPath, 0);
                if (pi == null || pi.applicationInfo == null) return null;
                pi.applicationInfo.sourceDir = e.apkPath;
                pi.applicationInfo.publicSourceDir = e.apkPath;
                return pi.applicationInfo.loadIcon(pm);
            }
            Bitmap b = getContentResolver().loadThumbnail(e.uri, new Size(dp(96), dp(96)), null);
            return new BitmapDrawable(getResources(), b);
        } catch (Exception | OutOfMemoryError x) {
            return null;
        }
    }

    private static String tileText(Entry e) {
        if (e.kind == Kind.APPS || e.kind == Kind.APKS) return "APK";
        int dot = e.name.lastIndexOf('.');
        String ext = dot < 0 || dot == e.name.length() - 1 ? "" : e.name.substring(dot + 1).toUpperCase(Locale.ROOT);
        if (ext.isEmpty() || ext.length() > 4) return e.kind == Kind.AUDIO ? "♪" : "FILE";
        return ext;
    }

    /** A rounded square in the tab's colour with the file type written on it. */
    private static final class Tile extends Drawable {
        private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint fg = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final String text;

        Tile(int color, String text) {
            bg.setColor(color);
            fg.setColor(0xffffffff);
            fg.setTypeface(Typeface.DEFAULT_BOLD);
            fg.setTextAlign(Paint.Align.CENTER);
            this.text = text;
        }

        @Override
        public void draw(Canvas c) {
            RectF r = new RectF(getBounds());
            float radius = r.width() * 0.18f;
            c.drawRoundRect(r, radius, radius, bg);
            fg.setTextSize(r.height() * (text.length() > 3 ? 0.24f : 0.3f));
            c.drawText(text, r.centerX(), r.centerY() - (fg.descent() + fg.ascent()) / 2, fg);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter filter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
