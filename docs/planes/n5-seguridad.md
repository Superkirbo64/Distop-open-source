# N5 — seguridad (transversal)

Modelo de amenazas por fase. No es una fase que se cierra al final: cada
trozo se avanza junto a la fase que protege, y una fase N no está hecha si su
bloque de aquí sigue abierto. Complementa el §22 de claude.md, que sigue
vigente entero.

## Fase N5a — directorio (con N2)

- [ ] SSRF: resolver DNS antes de conectar; bloquear RFC1918, link-local y
      metadata; límites de redirecciones, tamaño y tiempo
- [ ] Spam de registro: rate limits por origen + IP + fingerprint
- [ ] Suplantación: registro solo con challenge firmado ES256 (RFC 9421)
- [ ] Ranking manipulado: el carril destacado es revisión humana; el público
      no ordena por señales manipulables

## Fase N5b — TURN (con N1)

- [ ] Abuso de relay: credenciales efímeras con expiración de 24 h y
      denied-peer-ip hacia metadata, RFC1918 y loopback
- [ ] Secreto extraído: procedimiento de rotación documentado y ensayado

## Fase N5c — nube (con N1 y N3)

- [ ] Reclamación de la VM: right-sizing legítimo (las tres condiciones en Y)
      + copia diaria fuera de la VM + runbook de recuperación fría ensayado
- [ ] Secuestro de la cuenta OCI: MFA en la cuenta, instance principal sin
      claves en disco, IAM de mínimo privilegio sobre el bucket
- [ ] user_data legible: ni un secreto en cloud-init; los secretos se generan
      EN la VM con permisos 0600

## Fase N5d — nodos (con N4)

- [ ] Clave de nodo comprometida: revocación firmada + expiración corta
- [ ] Nodo hostil: datos jamás en claro (la regla dura de N4c)

## Fase N5e — lo ya vigente, aplicado a lo nuevo (§22)

- [ ] RFC 9421 con vectores de prueba reproducidos byte a byte (como el
      RFC 8291 en A2: que "está bien" no sea una opinión)
- [ ] Rate limits en cada endpoint nuevo (regla transversal de
      `docs/plan-continuidad.md`)
- [ ] Auditoría de cada acción nueva: registro, baja, relevo, certificado de
      nodo emitido o revocado — nunca tokens ni claves
- [ ] Copia fuera de OCI obligatoria en el runbook, no opcional

## Lo que esto no puede hacer

- No hace confiable a un proveedor: Oracle y Cloudflare pueden cambiar reglas
  o cerrar cuentas; la defensa es la copia y la portabilidad, no el contrato.
- No protege contra quien hospeda: el host ve sus datos, como en todo
  self-hosting.
- Un modelo de amenazas es una foto: cada fase nueva lo reabre, no lo hereda.

## Criterios de aceptación

- Cada amenaza listada tiene, en su fase, o una mitigación probada o una
  aceptación explícita escrita en el documento de esa fase.
- Los vectores RFC 9421 se reproducen byte a byte en tests.
- Ningún secreto aparece en user_data, logs, auditoría ni en el state de
  Terraform (el token DuckDNS opcional es la excepción documentada y
  avisada).
- Los simulacros (rotación del secreto TURN, recuperación fría, revocación de
  nodo) están ensayados y con fecha, no solo escritos.
