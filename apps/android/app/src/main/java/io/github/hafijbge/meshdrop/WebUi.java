package io.github.hafijbge.meshdrop;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The shared React renderer in a WebView, served from assets/web at https://appassets.androidplatform.net/
 * (WebViewAssetLoader). index.html gets the bridge shim injected before the app script; nothing else
 * can be loaded or navigated to.
 */
final class WebUi {
    static final String ORIGIN = "https://appassets.androidplatform.net";

    private WebUi() {}

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    static WebView create(Activity activity, Bridge bridge, String route) {
        WebView web = new WebView(activity);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled((activity.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/bridge/", path -> asset(activity, "bridge/" + path))
                .addPathHandler("/", path -> {
                    if (path.isEmpty() || path.equals("index.html")) return index(activity);
                    return asset(activity, "web/" + path);
                })
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!request.getUrl().toString().startsWith(ORIGIN + "/")) return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, null);
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("https".equals(u.getScheme()) && !u.toString().startsWith(ORIGIN + "/")) {
                    try {
                        activity.startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (RuntimeException ignored) {
                        // no browser
                    }
                }
                return true; // never navigate the app's WebView
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                bridge.pageOrigin(url);
            }
        });
        web.addJavascriptInterface(bridge, "MeshDropBridge");
        bridge.attach(web);
        web.loadUrl(ORIGIN + "/index.html" + (route == null ? "" : "#" + route));
        return web;
    }

    private static WebResourceResponse asset(Activity a, String path) {
        if (path.contains("..")) return null;
        try {
            return new WebResourceResponse(mime(path), null, a.getAssets().open(path));
        } catch (IOException e) {
            return null;
        }
    }

    /** index.html with the bridge shim loaded first (CSP script-src 'self' allows it). */
    private static WebResourceResponse index(Activity a) {
        try (InputStream in = a.getAssets().open("web/index.html")) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            String html = new String(b.toByteArray(), StandardCharsets.UTF_8);
            html = html.replace("<head>", "<head>\n    <script src=\"/bridge/shim.js\"></script>");
            return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            return null;
        }
    }

    private static String mime(String path) {
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }
}
