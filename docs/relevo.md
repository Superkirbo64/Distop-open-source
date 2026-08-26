# Relevo: cambiar de anfitrión sin perder la comunidad

Quien hospeda deja de hospedar, y otra máquina continúa. Los miembros no tienen
que crear nada nuevo ni volver a entrar: siguen en la misma comunidad.

Esto **no** es una copia de seguridad. Una copia reconstruye *la misma*
instancia y lleva su clave privada dentro ([copias-de-seguridad.md](copias-de-seguridad.md)).
Un relevo entrega la línea a *otra* instancia, que genera su propia clave.

## Por qué la clave no viaja

Los miembros tienen fijada la clave pública del equipo que hospeda. Copiarla al
equipo nuevo sería lo fácil y sería lo peor: dos máquinas capaces de firmar como
la misma instancia, para siempre, sin forma de revocar ninguna.

En su lugar, el sucesor genera su propia clave y el predecesor firma un
**certificado de sucesión**: *"yo, que soy quien tenías fijado, autorizo a esta
otra clave a continuar la línea en la época siguiente"*. Un cliente que tenía
fijado al equipo viejo puede seguir la cadena hasta el nuevo sin fiarse de nadie
más.

```
linaje L, época 1, clave KA   ──cert firmado por KA──▶   linaje L, época 2, clave KB
   instancia A                                              instancia B
```

El linaje no cambia: es la misma comunidad. La instancia y la clave sí. La época
sube exactamente uno — ni salta, ni se repite, ni retrocede.

## Cómo se hace

**En el equipo viejo**, autoriza al nuevo y guarda el código que aparece. Se
enseña una sola vez, porque solo se guarda su hash:

```bash
curl -X POST http://localhost:5000/api/v1/instance/successors \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"label":"el portátil de Ana"}'
```

**En el equipo nuevo**, con su instancia parada:

```bash
DISTOP_ENROL_CODE='XXXX-XXXX-XXXX-XXXX' node apps/node-server/adopt.ts \
  --from https://equipo-viejo.ts.net --origin https://equipo-nuevo.ts.net --target ./data
```

Se presenta con su clave, espera a que el viejo prepare la copia, la descarga
—reanudable, por rangos—, la verifica entera y firma un recibo. Al terminar
tiene todos los datos y **no manda**: queda en reserva.

**En el equipo viejo**, cuando quieras cortar:

```bash
curl -X POST http://localhost:5000/api/v1/instance/handover/activate \
  -H "authorization: Bearer $TOKEN"
```

**En el equipo nuevo**, para terminar:

```bash
node apps/node-server/adopt.ts --promote --target ./data
```

## El corte, en dos tiempos

Activar no retira al equipo viejo de golpe. Congela las escrituras, saca una
**copia final** y espera a que el sucesor confirme que también la tiene.

La razón es concreta: entre la copia grande y el corte, la comunidad ha seguido
hablando. Con un aviso de 24 h, un corte instantáneo perdería un día entero de
conversación sin que nadie se diera cuenta hasta mucho después.

Mientras dura, el equipo viejo se sigue leyendo y devuelve `503` a los cambios,
diciendo por qué. Si el sucesor no aparece, se cancela y todo vuelve a la
normalidad sin haber tocado la época:

```bash
curl -X DELETE http://localhost:5000/api/v1/instance/handover -H "authorization: Bearer $TOKEN"
```

## Después

El equipo viejo devuelve `410 INSTANCE_SUPERSEDED` a todo, con la dirección
nueva y el certificado dentro del error. Siguen abiertos: `/health`,
`/api/v1/info` (con `moved_to`), `/api/v1/succession/chain`, entrar, y la
exportación de comunidades — que es un derecho y no depende de quién mande.

Retirado significa retirado. Seguir sirviendo datos como si mandara sería la
forma más fácil de partir una comunidad en dos, con la mitad de la gente
escribiendo en la máquina antigua.

## Aviso a los miembros

Un relevo normal se anuncia con **24 horas**, con fecha, nuevo anfitrión y
motivo, y queda en la auditoría de cada comunidad. Antes de esa hora, activar
falla.

Un relevo de **emergencia** —el disco está fallando, el equipo se apaga esta
tarde— se salta la espera, pero hay que pedirlo en voz alta (`unplanned` y
`confirm`), y queda escrito que **no hubo aviso**. Prohibirlo haría imposible
salvar una comunidad cuando de verdad hace falta; fingir que hubo aviso sería
mentir a sus miembros.

## Qué se lleva el equipo nuevo

Todo lo que hace que la comunidad siga siendo la misma: mensajes, miembros,
roles, invitaciones, archivos, **y las sesiones abiertas**, para que nadie
aparezca desconectado de golpe ni quede fuera por no tener contraseña.

También, y conviene saberlo: **los hashes de contraseña** de tus miembros.
scrypt retrasa un ataque contra ellos, no lo impide.

No se lleva: la clave privada del equipo viejo, las credenciales del TURN de
pago, ni la dirección pública fijada del equipo anterior.

El secreto de sesiones sí viaja, pero el equipo nuevo **estrena el suyo** y
conserva el viejo durante dos semanas: cada sesión que aparece en ese plazo pasa
al secreto nuevo, así que el almacén no se queda indefinidamente en modo doble.
El equipo viejo también conocía el viejo, y quedárselo para siempre sería
dejarle una llave.

## Salir de una comunidad

Tres acciones distintas, y la interfaz tiene que ofrecerlas por separado:

```bash
# irse, dejando lo que escribiste
POST /api/v1/communities/:id/leave

# irse llevándote lo que escribiste
POST /api/v1/communities/:id/leave   {"purge_messages": true}

# borrar la cuenta entera de esta instancia
DELETE /api/v1/users/me
```

Lo que **no** se promete: que tus mensajes desaparezcan del mundo. Estuvieron en
el disco de quien hospeda desde el primer día y pudo copiarlos. Lo que se ofrece
es real —dejan de servirse y dejan de estar en la base— y se dice tal cual.

## Lo que esto no puede hacer

- **A quien nunca vio al equipo viejo no se le puede avisar.** La cadena
  convence a quien tenía algo fijado; a quien llega nuevo, no le dice nada.
- **Si el equipo viejo muere antes de activar**, el sucesor tiene los datos y un
  certificado prefirmado, pero ascender exige afirmar que el otro no va a
  volver: `--promote --force`. No es automático y no puede serlo — una máquina
  no distingue de forma segura "el otro murió" de "no llego al otro".
- **Reactivar el equipo viejo con la época antigua no se puede.** Volver atrás
  sería un rollback criptográfico. Para que vuelva a servir hace falta un relevo
  nuevo en sentido contrario, con su época y su certificado.
- **Nada impide físicamente que las dos máquinas se enciendan a la vez.** La
  época protege a quien ya vio la nueva, no al mundo. Dos escrituras divergentes
  no se fusionan, y este diseño se niega a fingir que sí.
