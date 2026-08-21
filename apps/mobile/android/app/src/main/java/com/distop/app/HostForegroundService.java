package com.distop.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Servicio en primer plano mientras este teléfono hospeda su comunidad (§5).
 *
 * No ejecuta nada: el servidor Node corre embebido en el proceso de la app
 * (Capacitor-NodeJS). Lo único que hace este servicio es sostener el aviso
 * fijo que le dice a Android "no duermas este proceso, hay gente conectada".
 * Tipo specialUse: dataSync tiene un tope de 6 horas desde Android 15 y un
 * servidor comunitario no es una sincronización.
 */
public class HostForegroundService extends Service {
    static final String CHANNEL_ID = "distop.host";
    static final int NOTIFICATION_ID = 1001;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Comunidad en el aire",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Se muestra mientras este teléfono hospeda tu comunidad.");
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = builder
                .setContentTitle("Tu comunidad está en el aire")
                .setContentText("Este teléfono la hospeda. Cerrar la app del todo la apaga.")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(tap)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // STICKY: si Android recicla el proceso, que lo reviva con la app.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
