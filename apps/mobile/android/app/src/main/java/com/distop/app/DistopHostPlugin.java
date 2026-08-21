package com.distop.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

/**
 * Puente mínimo para que el cliente web encienda o apague el aviso de
 * "comunidad en el aire" (HostForegroundService) cuando el servidor embebido
 * arranca o se deja de hospedar. Superficie mínima a propósito (§22): dos
 * métodos, sin parámetros, sin acceso a nada más del sistema.
 */
@CapacitorPlugin(name = "DistopHost")
public class DistopHostPlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        Intent intent = new Intent(getContext(), HostForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getContext().stopService(new Intent(getContext(), HostForegroundService.class));
        call.resolve();
    }
}
