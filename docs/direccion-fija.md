# Dirección pública de Distop

Distop ofrece dos opciones desde **Tu servidor → Compartir tu comunidad**.

## Cloudflare automático

Es la opción más fácil: no pide cuenta, dominio ni cambios en el router. Distop
descarga `cloudflared`, abre un *quick tunnel* y muestra una dirección HTTPS.
Esa dirección cambia cuando se reinicia la aplicación. La identidad portable de
Distop permite que los miembros entren por la dirección nueva conservando su
perfil, historial, membresías y roles.

## Tailscale Funnel fijo

Es la opción recomendada cuando se quiere una dirección que no cambie. El
asistente comprueba Tailscale, guía el inicio de sesión, activa Funnel y fija la
dirección `https://equipo.tailnet.ts.net` para las invitaciones.

La instalación requiere confirmación de administrador porque Tailscale añade un
servicio de red. La primera activación de Funnel también puede pedir habilitar
HTTPS/Funnel en la consola del *tailnet*; Distop muestra el enlace exacto.

Funnel pasa por la infraestructura de Tailscale y está sujeto a sus límites de
uso justo. Chat, presencia y llamadas ligeras son un buen caso de uso; para
transferir muchos archivos grandes conviene un túnel Cloudflare con nombre.

## Cloudflare con nombre (manual)

Quien ya tenga un dominio puede crear un túnel con nombre en Cloudflare y usar,
por ejemplo, `chat.midominio.example`. También existen proveedores de dominios
gratuitos, pero su solicitud, aprobación y configuración DNS son externas a
Distop. Una vez configurado, se puede establecer mediante `PUBLIC_URL`.

En todos los modos el servidor sigue viviendo en el equipo anfitrión: si ese
equipo o Distop están apagados, la comunidad queda temporalmente fuera de línea.
