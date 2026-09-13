/**
 * App Android (§14, §15): el MISMO cliente web de apps/web, empaquetado.
 * El teléfono no hospeda, solo participa: arranca creando el usuario en el
 * dispositivo y entra a la app vacía; las comunidades se encuentran en Explorar
 * o con una invitación, y cada servidor reconoce esa misma identidad.
 *
 * La voz exige WebCodecs + MediaStreamTrackProcessor en el System WebView
 * (≥94, se actualiza por Play Store). Si el WebView es más viejo, el cliente
 * lo dice y el resto funciona igual (relay.ts `supported()`).
 */
import type { CapacitorConfig } from "@capacitor/cli";


const config: CapacitorConfig = {
  appId: "com.distop.app",
  appName: "Distop",
  webDir: "../web/dist",
  server: {
    /* http y no https, a conciencia: http://localhost sigue siendo un contexto
       seguro (getUserMedia y WebCodecs funcionan igual) y evita que el WebView
       bloquee como "contenido mixto" los servidores http de la red local — tu
       PC en la Wi-Fi de casa o el de este mismo teléfono. */
    androidScheme: "http",
    cleartext: true,
  },
  android: {
    /* Android 15 dibuja la app por debajo de la barra de estado y de la de
       navegación: la cabecera y la caja de escribir quedaban tapadas. "auto"
       aparta la vista de las barras justo ahí (Capacitor ≥7.1). */
    adjustMarginsForEdgeToEdge: "auto",
  },
  plugins: {
    /* El servidor de la comunidad DENTRO del APK (Capacitor-NodeJS →
       nodejs-mobile). manual: solo arranca cuando la persona hospeda aquí;
       quien es solo cliente no paga la memoria de un motor Node de fondo.
       El proyecto Node vive en webDir/nodejs (lo genera scripts/stage-server
       --mobile). */
    CapacitorNodeJS: {
      nodeDir: "nodejs",
      startMode: "manual",
    },
  },
};

export default config;
