package io.github.hafijbge.meshdrop.engine;

import java.util.Map;

/** One engine event: source receiver|sender|discovery, a type, and Node-shaped data. */
public final class EngineEvent {
    public final String source;
    public final String type;
    public final Map<String, Object> data;

    public EngineEvent(String source, String type, Map<String, Object> data) {
        this.source = source;
        this.type = type;
        this.data = data;
    }

    @Override
    public String toString() {
        return source + ":" + type + " " + data;
    }
}
