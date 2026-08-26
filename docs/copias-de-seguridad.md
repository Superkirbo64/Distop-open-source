# Copias de seguridad y restauración

Una copia de Distop reconstruye **la misma instancia**: la misma identidad, las
mismas sesiones, las mismas invitaciones y los mismos archivos. No es lo mismo
que la exportación de una comunidad (`GET /api/v1/communities/:id/export`), que
es JSON legible y sirve para llevarte tus datos a otro sitio.

Y no es un relevo. Restaurar no crea una instancia sucesora: crea otra copia de
esta. Si la original sigue encendida, acabarás con dos.

## Hacer una copia

Desde el propio ordenador anfitrión, con la cuenta que hospeda:

```bash
curl -X POST http://localhost:8080/api/v1/instance/backups \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"passphrase":"una frase larga que puedas recordar"}'
```

Responde en cuanto arranca, no cuando termina: cifrar cuarenta gigas tarda
minutos. El progreso se consulta en `GET /api/v1/instance/backups/:job_id`, y
`GET /api/v1/instance/backups` lista las copias que hay en disco.

El fichero queda en `<directorio de datos>/backups/`. Mientras se escribe se
llama `.partial` y solo cambia de nombre cuando está entero y sincronizado a
disco: un corte de luz a mitad deja un `.partial`, nunca una copia que parece
buena y no lo es.

**La frase no se guarda en ninguna parte.** Si la pierdes, la copia es un fichero
de ruido. Es el precio de que, si alguien la encuentra, también lo sea para él.

## Qué lleva dentro y qué no

| | |
|---|---|
| `database/app.db` | la base entera: mensajes, miembros, roles, invitaciones, sesiones |
| `identity/instance.key` | la clave privada de la instancia |
| `secrets/auth-secret` | el secreto con el que se reconocen las sesiones |
| `secrets/push` | las claves de Web Push de la instancia |
| `uploads/…` | los adjuntos, sin las subidas a medias |

Se quedan fuera, y constan explícitamente en el manifiesto como redacciones:

- **`voice_relay`**: las credenciales del TURN gestionado de pago.
- **`public.fixed`**: la dirección pública fijada para el equipo de origen.

La primera puede acabar en un disco externo o en el correo de alguien; la segunda
podría publicar por error el equipo anterior. Tras restaurar hay que configurarlas
de nuevo en Ajustes.

Lo que sí viaja y conviene saber son dos cosas:

**Los hashes de contraseña de tus miembros.** scrypt retrasa un ataque contra
ellos, no lo impide. Quien tenga la copia y la frase tiene eso.

**Las claves de Web Push.** Viajan porque si no viajaran, la suscripción del
navegador de cada miembro moriría al restaurar y habría que pedirle a todo el
mundo que volviera a activarlo. El precio es directo: **quien restaure esta
copia puede mandar notificaciones a los navegadores de tus miembros.** No
puede leer nada suyo ni entrar en sus cuentas, pero puede hacerles sonar el
móvil.

Una copia anterior a que existiera Web Push no trae esa pieza, y eso no es un
fallo: restaura igual y la instancia genera un par nuevo. Lo único que se
pierde son las suscripciones, que se vuelven a activar en Ajustes.

## Mirar dentro sin restaurar

```bash
DISTOP_BACKUP_PASSPHRASE='...' node apps/node-server/restore.ts \
  --inspect --file ruta/a/copia.distop-backup
```

Dice de qué instancia es, de cuándo y qué trae. **No comprueba que esté entera**:
para eso, `--deep`, que recorre todos los bytes y contrasta todos los hashes.
Añade tiempo proporcional al tamaño, y es la comprobación que quieres hacer el
día que guardas la copia, no el día que la necesitas.

## Restaurar

Con la instancia **parada**. No hay ruta HTTP que restaure: sustituir el
directorio de datos desde una petición sería el mando a distancia perfecto para
el día que alguien se cuele.

```bash
DISTOP_BACKUP_PASSPHRASE='...' node apps/node-server/restore.ts \
  --file ruta/a/copia.distop-backup --target ./data
```

La frase va en la variable de entorno y no en un argumento: los argumentos de un
proceso los puede leer cualquiera que liste procesos en el equipo.

Nada toca el directorio final hasta que todo lo demás ha salido bien: se extrae a
un `.restore-incoming`, se contrastan todos los hashes, se abre la base, se
comprueba su integridad, sus claves foráneas y su versión de esquema, y se
verifica que la base y el manifiesto cuentan la misma historia sobre de quién es
la instancia. Si algo falla, no se ha movido nada y el informe dice qué faltaba,
qué no cuadraba y qué rutas se rechazaron.

También se cruza cada fila de adjunto de SQLite con el fichero declarado en el
manifiesto: ruta relativa, tamaño, hash y, cuando existe en el esquema, su
`content_hash`. Los conteos de usuarios, comunidades, canales, mensajes y
adjuntos deben coincidir. Una restauración válida registra
`INSTANCE_RESTORE_COMPLETED` en la auditoría de cada comunidad antes de colocar
la base.

Sobre un directorio que ya tiene datos hace falta `--replace`, y lo anterior no
se borra: se aparta a `app.db.bak`, `uploads.bak` y demás. Restaurar la copia
equivocada es un error que alguien va a cometer, y siempre se descubre después.

Si el proceso o el equipo se corta durante el intercambio, el diario
`restore.journal` permite que el siguiente intento revierta primero los
movimientos parciales y recupere los datos anteriores antes de continuar.

Una copia hecha por una versión más nueva de Distop **no se restaura**: sus
tablas pueden tener columnas que este código no conoce, y migrar hacia atrás no
existe. Actualiza primero.

## Lo que esto no puede hacer

- **Una copia offline no se puede revocar.** Quien la tenga puede levantarla
  cuando quiera. No hay coordinador central que diga "esa ya no vale".
- **Nada impide que dos copias corran a la vez.** Serían dos instancias con la
  misma identidad y la misma época, escribiendo historias distintas que no se
  fusionan. Si restauras en otro equipo, apaga el original.
- **Borrar la copia vieja es una promesa de una persona**, no una propiedad del
  sistema.
