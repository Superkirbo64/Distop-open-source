# Distop en Oracle Cloud Always Free

> **ARCHIVADO — no soportado.** La capa gratuita ARM de Oracle lleva meses
> sin dar capacidad (`Out of host capacity` una y otra vez), y llegar hasta ese
> error exige Terraform, DNS y certificados. Para una comunidad hay caminos
> mucho más cortos: el túnel que la aplicación abre sola, Tailscale Funnel, una
> Raspberry o una VPS pequeña. Este stack se conserva porque funciona y porque
> el trabajo es recuperable, no porque se recomiende.

Stack Terraform del despliegue de referencia en la nube a coste cero
(`docs/nube-oracle.md` explica el porqué de cada decisión; aquí está el cómo).
Crea: VCN + subred pública, una VM `VM.Standard.A1.Flex` (Ubuntu 24.04 ARM),
**una** IPv4 reservada asociada a su VNIC, un bucket privado de Object Storage
para copias cifradas y, opcionalmente, el IAM (dynamic group + policy) para
subirlas con instance principal.

Dentro de la VM, cloud-init deja: Docker + Compose (la instancia se compila
desde el tag `distop_release`), Caddy con HTTPS automático, coturn con
credenciales efímeras (`use-auth-secret`) y dos timers systemd (subida diaria
de copias y refresco de DuckDNS si aplica). Los secretos —`AUTH_SECRET`,
secreto TURN, frase de copias— **se generan dentro de la VM**: nunca viajan
por variables de Terraform ni por el user_data.

## Prerequisitos

- Cuenta de Oracle Cloud (Free Tier vale). Terraform solo hace falta si
  aplicas desde tu equipo, y tiene que ser **1.5.x**: Resource Manager se
  quedó en la última versión con licencia MPL y el stack fija ese techo
  (`versions.tf`). Desde la consola no instalas nada.
- [`oci` CLI](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/cliconcepts.htm)
  configurado en tu equipo (solo para consultar OCIDs e imágenes; la VM ya
  trae el suyo en un venv).
- Un nombre DNS: subdominio de [DuckDNS](https://www.duckdns.org) o dominio
  propio. **Jamás sslip.io ni nip.io**: su cuota compartida de Let's Encrypt
  está agotada y Caddy no conseguiría certificado.
- Tu IP pública para `admin_cidr` (por ejemplo de `curl -4 ifconfig.me`).

Copia `terraform.tfvars.example` a `terraform.tfvars` y rellena. Tras el
primer `terraform init`, commitea `.terraform.lock.hcl` (fija el proveedor).

## OCIDs que pide el stack

| Variable | Dónde se consigue |
|---|---|
| `tenancy_ocid` | Consola → Perfil → Tenancy, o `~/.oci/config` |
| `compartment_ocid` | Consola → Identity → Compartments (puede ser la tenancy) |
| `availability_domain` | `oci iam availability-domain list --compartment-id <tenancy>` |
| `ubuntu_image_ocid` | opcional: vacío lo resuelve el stack (ver abajo) |

`distop_release` no tiene valor por defecto: aplicar a mano obliga a decir qué
versión se despliega. El job `oci-stack` que empaquetaba el zip inyectando ese
valor **se retiró al archivar este camino**, así que ya no hay zip publicado en
las releases; para usar el stack hay que empaquetar
`infrastructure/oracle/` a mano (con `main.tf` en la raíz del zip) o aplicarlo
desde tu equipo con Terraform 1.5.x.

## Imagen ARM64 (Ubuntu 24.04 aarch64)

No hace falta elegirla: con `ubuntu_image_ocid` vacío, el stack resuelve la
Ubuntu 24.04 más reciente **compatible con `VM.Standard.A1.Flex`**, y ese
filtro por shape ya garantiza aarch64. Existe porque el desplegable de la
consola mezcla x86 y ARM sin distinguirlos, y elegir mal no falla al rellenar
el formulario: falla al lanzar la VM, con
`400-InvalidParameter, Shape VM.Standard.A1.Flex is not valid for image ocid1.image...`.

La reproducibilidad se mantiene por el otro lado: el OCID que se usó sale por
el output `image_ocid`. Para clavar esa misma imagen en futuros despliegues,
cópialo a `ubuntu_image_ocid` — lo que se fija a mano siempre manda.

Para elegirla tú desde el principio, las candidatas de TU región:

```sh
oci compute image list \
  --compartment-id "$TENANCY_OCID" \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" \
  --shape "VM.Standard.A1.Flex" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].{nombre:"display-name", ocid:id}'
```

## Desplegar

```sh
terraform init
terraform plan
terraform apply
```

- **`Out of host capacity`**: la capacidad A1 gratuita escasea. Cambia
  `availability_domain` a otro AD de la misma región y vuelve a aplicar;
  si la región solo tiene un AD, reintenta más tarde (a primera hora suele
  haber más suerte). No cambies de región: las cuotas Always Free viven en
  la región principal.
- El primer arranque tarda: firstboot espera la IP, instala paquetes y
  **compila Distop desde el código (10-20 min en 1 OCPU)**. Sigue el progreso
  con `ssh ubuntu@IP` y `sudo tail -f /var/log/distop-firstboot.log`.

## DNS

`terraform output public_ip` da la IP reservada.

- **DuckDNS**: pon `public_hostname = "loquesea.duckdns.org"` y
  `duckdns_token`. La VM actualiza y refresca el registro sola (timer cada
  30 min). Aviso: el token queda legible en el state de Terraform y en el
  user_data de la VM — es un secreto de valor bajo (solo actualiza ese
  subdominio), pero con dominio propio ni existe.
- **Dominio propio**: crea un registro A hacia la IP reservada y deja
  `duckdns_token` vacío. Recomendado para cualquier comunidad seria.

Caddy pide el certificado en cuanto el DNS resuelve; si el registro tarda en
propagarse, reintenta solo.

## Primer acceso (claim con SETUP_CODE)

La instancia recién creada se reclama desde otro equipo con un código de un
solo uso. Hay dos maneras de tenerlo, y la primera evita el SSH:

- **`setup_code` en las variables del stack**: lo eliges tú, cloud-init lo
  escribe en `/etc/distop/distop.env` y lo tecleas en la web directamente.
  Mismo aviso que `duckdns_token`: queda legible en el state y en el
  user_data — pero deja de valer en el instante en que alguien reclama la
  instancia.
- **`setup_code` vacío** (el default): la instancia genera uno aleatorio en
  cada arranque y solo se lee entrando por SSH.

```sh
ssh ubuntu@IP
sudo docker compose -f /opt/distop/docker-compose.oracle.yml logs instance | grep -i setup
```

Abre `https://<public_hostname>`, entra y usa ese código cuando la aplicación
lo pida.

Al reclamarla, la propia aplicación te enseña **una sola vez** la frase de las
copias, para que no haya que entrar por SSH a buscarla. Guárdala en tu gestor
de contraseñas en ese momento: sin ella una copia no se puede restaurar. Si
cierras el aviso sin copiarla, sigue en la VM y se lee así:

```sh
sudo cat /data/backup-passphrase
```

Por HTTP no vuelve a salir nunca: si apareciera en cada sesión, robar una
sesión sería robar el descifrado de todas las copias.

## Copias de seguridad

- El **planificador interno** del servidor crea una copia cifrada
  `.distop-backup` cada `BACKUP_INTERVAL_HOURS` (24) en `/data/backups`,
  conservando `backup_keep`.
- El timer `distop-backup-upload.timer` la sube a diario al bucket con
  instance principal: `incoming/` → verificación → `backups/`, y poda el
  bucket al mismo `backup_keep`. Techo propio de ~15 GiB (los 20 GB Always
  Free son cuota combinada de la tenencia).
- El primer día puede fallar la subida mientras el IAM propaga; el timer
  reintenta al día siguiente. Prueba manual:
  `sudo systemctl start distop-backup-upload.service && journalctl -u distop-backup-upload -e`.
- **Saca una copia fuera de OCI periódicamente** (`scp` al PC de casa, NAS…):
  una suspensión de la cuenta afectaría a VM, IP, volumen y bucket a la vez.

## Runbook de restauración

Vale para la misma VM o para una reconstruida (`terraform apply` tras perderla
re-asocia la misma IP y re-apunta el IAM a la VM nueva).

```sh
# 1. Parar la instancia — restore exige el servidor parado; no hay ruta HTTP
#    a propósito (sería el mando a distancia perfecto para un intruso).
sudo systemctl stop distop

# 2. Bajar la copia del bucket (nombre del bucket: terraform output backup_bucket)
export OCI_CLI_AUTH=instance_principal
/opt/oci-cli/bin/oci os object list -bn <bucket> --prefix backups/
/opt/oci-cli/bin/oci os object get -bn <bucket> \
  --name "backups/<fichero>.distop-backup" --file /tmp/copia.distop-backup

# 3. Inspeccionar. La frase es la GUARDADA FUERA (la de la copia), no la que
#    una VM nueva acaba de generar en /data/backup-passphrase.
sudo docker compose -f /opt/distop/docker-compose.oracle.yml run --rm \
  -e DISTOP_BACKUP_PASSPHRASE='<frase guardada>' \
  -v /tmp/copia.distop-backup:/tmp/copia.distop-backup:ro \
  instance node restore.ts --inspect --file /tmp/copia.distop-backup

# 4. Restaurar sobre /data (mismo comando sin --inspect, con --target)
sudo docker compose -f /opt/distop/docker-compose.oracle.yml run --rm \
  -e DISTOP_BACKUP_PASSPHRASE='<frase guardada>' \
  -v /tmp/copia.distop-backup:/tmp/copia.distop-backup:ro \
  instance node restore.ts --file /tmp/copia.distop-backup --target /data

# 5. Arrancar
sudo systemctl start distop
```

Después de restaurar:

- El relay TURN se recupera solo: en este despliegue viene del entorno
  (`TURN_URL`/`TURN_SECRET` en `/etc/distop/distop.env`), que la copia no toca.
- La copia redacta a propósito `voice_relay` y `public.fixed` de la base:
  revisa en el panel del anfitrión la publicación fija si la usabas.
- Comprueba qué frase hay ahora en `/data/backup-passphrase`: las copias
  NUEVAS se cifrarán con esa. Guárdala fuera otra vez.
- Ensaya esta restauración una vez al mes; una copia no probada no es copia.

## Rotar el secreto TURN

Rótalo si expulsas a alguien que pudo extraerlo o por higiene periódica:

```sh
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/distop/turn.secret'
NUEVO=$(sudo cat /etc/distop/turn.secret)
sudo sed -i "s|^static-auth-secret=.*|static-auth-secret=$NUEVO|" /etc/turnserver.conf
sudo sed -i "s|^TURN_SECRET=.*|TURN_SECRET=$NUEVO|" /etc/distop/distop.env
sudo systemctl restart coturn
sudo systemctl restart distop   # recrea el contenedor con el env nuevo
```

Las credenciales efímeras ya emitidas caducan solas (TTL 24 h); tras rotar,
las llamadas en curso renegocian al reconectar.

## IAM manual (create_iam = false)

Si no eres administrador de la tenencia, pide a quien lo sea que cree, en la
**home region**:

1. Un dynamic group `distop-backup-<sufijo>` con la regla:
   `instance.id = '<OCID de la VM>'`
2. Una policy en el compartment con:

```text
Allow dynamic-group distop-backup-<sufijo> to manage objects in compartment id <compartment_ocid> where target.bucket.name = '<bucket>'
Allow dynamic-group distop-backup-<sufijo> to read buckets in compartment id <compartment_ocid> where target.bucket.name = '<bucket>'
```

Ojo: la regla apunta al OCID de la VM; si la VM se reconstruye, hay que
actualizarla (con `create_iam = true` lo hace `terraform apply` solo).

## destroy: lee esto antes

`terraform destroy` elimina **también la IP reservada y el bucket con las
copias**. No hay `prevent_destroy` en v1 (rompería el destroy desde Resource
Manager), así que la única red de seguridad es tuya: antes de destruir, baja
la última copia y apunta que el DNS quedará huérfano. Para retirar solo la VM
conservando IP y bucket: `terraform destroy -target=oci_core_instance.distop`
(la IP queda reservada sin asociar, lista para el siguiente apply).

## Lo que esto no puede hacer

- **Sin SLA**: Always Free no promete disponibilidad ni soporte. Oracle puede
  reclamar la VM si durante 7 días CPU p95, red **y** memoria están a la vez
  bajo el 20 %. No generes carga falsa: dimensiona según uso real y asume que
  la VM puede perderse (para eso están las copias y la IP reservada).
- **Nada es "local"**: con `TRUST_PROXY` y `PUBLIC_URL`, la instancia nunca ve
  peticiones locales; el backup por HTTP, restore/inspect y el relevo desde la
  web no funcionan aquí. Los caminos CLI en la VM (este runbook) son el
  mecanismo, por diseño.
- **Restaurar exige parar** la instancia; no hay restore en caliente.
- La copia **no incluye** `voice_relay` ni `public.fixed` (redactados).
- El user_data de OCI tiene un límite de 16 KB: cloud-init viaja gzip+base64
  (`base64gzip` en main.tf) y el CI (`infra.yml`) mide en cada cambio lo que
  se enviaría de verdad, fallando antes de que lo descubra un apply.
- Esto sigue siendo self-hosting: el PC de casa sigue siendo el modo por
  defecto de Distop; esta VM es el tercer modo, opcional y a coste cero.
