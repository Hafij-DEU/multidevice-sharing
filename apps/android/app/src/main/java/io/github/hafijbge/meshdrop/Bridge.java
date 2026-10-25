package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import io.github.hafijbge.meshdrop.engine.app.AppController;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * window.MeshDropBridge: one call(id, method, argsJson) entry point. Runs DesktopApi methods off the
 * UI thread and answers with window.__mdResolve(id, ok, json); state is pushed with window.__mdState.
 * Calls are accepted only while the page is the app's own asset origin.
 */
public final class Bridge {
    private final Activity activity;
    private final Core core;
    private final Pickers pickers;
    private final ExecutorService exec = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile WebView web;
    private volatile boolean trusted;

    Bridge(Activity activity, Core core, Pickers pickers) {
        this.activity = activity;
        this.core = core;
        this.pickers = pickers;
    }

    private final AppController.StateListener stateListener = json -> push("window.__mdState(" + Json.stringify(json) + ")");

    void attach(WebView w) {
        this.web = w;
        core.controller.addStateListener(stateListener);
    }

    void pageOrigin(String url) {
        trusted = url != null && url.startsWith(WebUi.ORIGIN + "/");
    }

    void destroy() {
        core.controller.removeStateListener(stateListener); // the process outlives this window
        web = null;
        exec.shutdownNow();
    }

    private void push(String js) {
        WebView w = web;
        if (w == null) return;
        main.post(() -> {
            WebView v = web;
            if (v != null) v.evaluateJavascript(js, null);
        });
    }

    private void resolve(int id, boolean ok, Object value) {
        String json = value == null ? "null" : Json.stringify(Json.stringify(value));
        push("window.__mdResolve(" + id + "," + ok + "," + json + ")");
    }

    /** window.close() from the page (the clipboard picker): finish the activity. */
    @JavascriptInterface
    public void close() {
        if (trusted) activity.runOnUiThread(activity::finish);
    }

    @JavascriptInterface
    @SuppressWarnings("unchecked")
    public void call(int id, String method, String argsJson) {
        if (!trusted) return;
        exec.execute(() -> {
            try {
                core.ensureStarted();
                Object parsed = Json.parse(argsJson);
                List<Object> args = parsed instanceof List ? (List<Object>) parsed : new ArrayList<>();
                resolve(id, true, dispatch(method, args));
            } catch (Throwable e) {
                Throwable c = e.getCause() != null && e instanceof java.lang.reflect.InvocationTargetException ? e.getCause() : e;
                String msg = c.getMessage();
                resolve(id, false, msg == null || msg.isEmpty() ? "Something went wrong." : msg);
            }
        });
    }

    private Object dispatch(String method, List<Object> args) throws Exception {
        AndroidPlatform p = core.platform;
        switch (method) {
            case "pickItems":
                return pickers.pick("dir".equals(args.isEmpty() ? null : args.get(0)));
            case "pickFiles": {
                List<Object> paths = new ArrayList<>();
                for (Object it : pickers.pick(false)) paths.add(((java.util.Map<?, ?>) it).get("path"));
                return paths;
            }
            case "pickFolder": {
                List<Object> got = pickers.pick(true);
                return got.isEmpty() ? null : ((java.util.Map<?, ?>) got.get(0)).get("path");
            }
            case "pickSavePath":
            case "pickOpenPath":
                return null;
            case "scanQr":
                return pickers.scanQr();
            case "scanDocument":
                return pickers.scanDocument();
            case "backupPermission": {
                String[] perms = android.os.Build.VERSION.SDK_INT >= 33
                        ? new String[] {android.Manifest.permission.READ_MEDIA_IMAGES, android.Manifest.permission.READ_MEDIA_VIDEO}
                        : new String[] {android.Manifest.permission.READ_EXTERNAL_STORAGE};
                activity.runOnUiThread(() -> activity.requestPermissions(perms, 9));
                return null;
            }
            case "takeSharedItems":
                return new ArrayList<Object>(p.takeShared());
            case "keepAliveAction":
                p.keepAliveAction(activity, (String) args.get(0));
                return null;
            default:
                AppController c = core.controller;
                return c.call(method, args);
        }
    }
}
