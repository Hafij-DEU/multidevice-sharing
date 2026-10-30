# R8 rules for the MeshDrop release build (on top of proguard-android-optimize.txt).
# Manifest components (activities, MeshService, ClipboardTile, NotifyListener, the Watchdog
# JobService, BootReceiver, RingStopReceiver, MeshApp) are kept by AGP's generated aapt rules; the
# explicit keeps below make that independent of the manifest merge.

# Readable crash stack traces (retrace with build/outputs/mapping/release/mapping.txt).
-keepattributes SourceFile,LineNumberTable,*Annotation*

# The WebView page calls MeshDropBridge.call(id, method, argsJson) and .close() by name
# (WebUi.addJavascriptInterface, assets/bridge/shim.js).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class io.github.hafijbge.meshdrop.Bridge {
    @android.webkit.JavascriptInterface public <methods>;
}

# Components started by the system by class name.
-keep public class io.github.hafijbge.meshdrop.MeshApp
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver

# GuestPage loads page.html/app.js/app.css with a path relative to its own package
# (Class.getResourceAsStream), so its package and name must stay as they are.
-keepnames class io.github.hafijbge.meshdrop.engine.guest.GuestPage

# Exception class names reach the UI (getClass().getSimpleName() when there is no message).
-keepnames class io.github.hafijbge.meshdrop.** extends java.lang.Throwable

# Enum names are written into JSON (kind.name()).
-keepclassmembers enum io.github.hafijbge.meshdrop.** {
    <fields>;
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# AndroidPlatform.prop() reads android.os.SystemProperties.get(String) by reflection: a framework
# class, untouched by R8, so it needs no keep rule. The engine's JSON (util.Json) and the
# AppController.call() dispatch are plain switch/instanceof code, no reflection.

# zxing core (QR decoding) is pure Java with no reflection: R8 may shrink it freely.
