# Directorio público de Distop

Este servicio solo guarda fichas públicas firmadas y leases. No transporta
mensajes, archivos, sesiones, voz ni vídeo. Una caída del directorio elimina
temporalmente `Explorar`; las instancias y las invitaciones siguen funcionando.

## Deno Deploy

1. Crea una aplicación nueva desde este directorio y usa `main.ts` como entrypoint.
2. Añade un Deno KV a la aplicación.
3. Define `DIRECTORY_CHALLENGE_SECRET` y `DIRECTORY_ADMIN_TOKEN` con dos
   secretos aleatorios diferentes de al menos 32 caracteres.
4. Publica y copia su URL en `DIRECTORY_URL` de las instancias.

Localmente:

```sh
deno task test
deno task dev
```

En local no se puede cerrar el círculo entero: `POST /v1/listings` resuelve el
origen anunciado y exige HTTPS con DNS público, así que una instancia en
`localhost` siempre termina en `ORIGIN_DNS_EMPTY`. Para comprobar el resto —que
la firma y el JSON canónico de Node coinciden con los de Deno— se publica desde
una instancia real con `PUBLIC_URL` de mentira y se mira el error: si dice
`ORIGIN_DNS_EMPTY` en vez de `BAD_SIGNATURE`, el contrato entre los dos runtimes
está bien. El manifiesto capturado se le pasa después a `DirectoryService` con el
verificador de origen anulado y tiene que aparecer en `explore`.

Una instancia renueva una vez al día y todas sus comunidades se guardan juntas:
10.000 instancias producen unas 300.000 escrituras y 600.000 requests mensuales
(desafío + publicación). Los desafíos son tokens HMAC sin estado y los límites
por IP viven en memoria, por lo que no gastan escrituras de KV. Esto deja el caso
base por debajo de 500.000 escrituras y un millón de requests; reportes y tareas de
moderación consumen el margen restante.

Las fichas caducan solas. El origen se resuelve antes de consultarlo y se
rechazan loopback, RFC1918, link-local, CGNAT, rangos de documentación y
multicast; además no se siguen redirecciones y la respuesta tiene límite.
