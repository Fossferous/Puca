package com.sovereign.app;

/**
 * LITE build: nothing. Lite has no remote control of any kind, so no plugin
 * is registered and the page finds none (docs/REMOTE_CONTROL.md). The full
 * build's ControlRegistrar (src/full/java) is the one that wires the
 * :phone-control module, which Lite does not depend on.
 */
final class ControlRegistrar {

    private ControlRegistrar() {}

    static void register(MainActivity activity) {
        // Lite: no control of this phone.
    }
}
