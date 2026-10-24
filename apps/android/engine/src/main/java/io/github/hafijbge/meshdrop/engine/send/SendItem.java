package io.github.hafijbge.meshdrop.engine.send;

/** One thing to send: a file, a folder, a text message, or clipboard text. */
public final class SendItem {
    public enum Kind { FILE, DIR, TEXT }

    public final Kind kind;
    public final Source source;
    public final Source.Tree tree;
    public final String text;
    public final boolean clipboard;

    private SendItem(Kind kind, Source source, Source.Tree tree, String text, boolean clipboard) {
        this.kind = kind;
        this.source = source;
        this.tree = tree;
        this.text = text;
        this.clipboard = clipboard;
    }

    public static SendItem file(Source s) {
        return new SendItem(Kind.FILE, s, null, null, false);
    }

    public static SendItem dir(Source.Tree t) {
        return new SendItem(Kind.DIR, null, t, null, false);
    }

    public static SendItem text(String text) {
        return new SendItem(Kind.TEXT, null, null, text, false);
    }

    public static SendItem clipboard(String text) {
        return new SendItem(Kind.TEXT, null, null, text, true);
    }
}
