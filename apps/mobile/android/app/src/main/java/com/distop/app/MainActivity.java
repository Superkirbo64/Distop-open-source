package com.distop.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Antes de super.onCreate: es cuando Capacitor registra los plugins.
        registerPlugin(DistopHostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
