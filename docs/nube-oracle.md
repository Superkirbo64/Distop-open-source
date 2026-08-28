# Distop en Oracle Cloud Always Free

Esta guía define el despliegue de referencia de una instancia Distop que debe
permanecer disponible sin presupuesto recurrente. El objetivo no es prometer
alta disponibilidad —Oracle no ofrece SLA para Free Tier— sino conseguir que
una pérdida de la VM sea recuperable, que el tráfico pesado permanezca fuera de
la plataforma central y que publicar la instancia sea casi tan sencillo como
activar Tailscale Funnel.

Los límites cambian. Antes de publicar un instalador o un botón de despliegue,
contrastar siempre esta guía con la [documentación vigente de Always
Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

La hoja de ruta de fases futuras vive en `docs/planes/`.

## Decisión de arquitectura

La instalación de referencia usa:

- una VM `VM.Standard.A1.Flex` de **1 OCPU y 6 GB de RAM** en la región principal;
- una IPv4 pública reservada y un nombre DNS estable;
- Caddy para HTTPS y proxy inverso;
- Distop compilado desde el código del tag elegido, en la propia VM, mediante
  Docker Compose — no existe todavía una imagen publicada en un registro;
  publicarla multi-arquitectura es trabajo planificado del release;
- coturn en la propia VM como TURN principal;
- vídeo y pantalla P2P (`video: direct`);
- voz por la instancia, como ya funciona en `gateway.ts`;
- copias cifradas programadas dentro del propio servidor y subidas a Object
  Storage;
- Terraform y cloud-init para reconstruir la VM en vez de mantener una sucesora
  ociosa.

No se coloca Tailscale Funnel delante del camino normal de una VM pública. Funnel
queda como publicación sencilla de una instalación doméstica y como alternativa
temporal mientras se configura DNS. En Oracle, la ruta avanzada —IPv4 reservada,
DNS y Caddy— evita el límite de ancho de banda no configurable de Funnel.

```text
                         ┌─────────────────────────────┐
                         │ Directorio Distop           │
                         │ Workers + D1                │
                         │ solo metadatos públicos     │
                         └──────────────┬──────────────┘
                                        │ latido firmado
                                        │
Internet ── HTTPS/WSS ── Caddy ── Distop/SQLite ── Object Storage
     │                         Oracle A1       copia cifrada
     │
     └── WebRTC P2P cámara/pantalla
             └── coturn en Oracle cuando el camino directo falla
                    └── Cloudflare TURN como perfil de contingencia
```

### Lo que «remoto» cambia en la instancia

Con `TRUST_PROXY=true` o `PUBLIC_URL` configurados, `isLocalRequest` (`http.ts`)
es falso para **todas** las peticiones — también para un `curl` a `127.0.0.1`
hecho por SSH dentro de la propia VM. Basta que la instancia sepa que vive
detrás de un proxy para que ninguna petición pueda probar que es local. No es un
fallo: es la regla que impide que alguien al otro lado del proxy se haga pasar
por el equipo anfitrión.

En este despliegue, por tanto, no funciona nada que exija petición local:

- `POST /api/v1/instance/backups` — crear una copia por HTTP;
- la inspección y la restauración de copias por API;
- el relevo de anfitrión desde la web (`docs/relevo.md`).

Sí funciona todo lo que solo exige ser anfitrión (`requireHost`), incluida la
configuración del relevo TURN con `PUT /api/v1/instance/relay`. Y los caminos
por CLI dentro de la VM (`restore.ts`, `adopt.ts`) siguen vivos: se entra por
SSH y se ejecutan con la instancia parada. Las copias automáticas las hace el
planificador interno del servidor (ver «Copias a Object Storage»), no un `curl`
externo. Es diseño, no una limitación a corregir.

## Presupuesto Always Free

La referencia vigente al redactar esta guía, agosto de 2026, concede en la
región principal:

| Recurso | Cuota Always Free | Uso de referencia |
|---|---:|---:|
| Ampere A1 | 1.500 OCPU-h y 9.000 GB-h/mes | 1 OCPU, 6 GB |
| Tráfico saliente | 10 TB/mes | aplicación, voz y TURN |
| Block Volume | 200 GB combinados | volumen de arranque de 50 GB |
| Object Storage | 20 GB combinados | copias cifradas |
| Backups de volumen | 5 | recuperación adicional, no única |
| Load Balancer flexible | 1 a 10 Mbps | no se usa en la ruta de medios |

Los 20 GB de Object Storage son una cuota combinada entre Standard, Infrequent
Access y Archive. No están partidos obligatoriamente en 10 + 10. Para una copia
que deba restaurarse rápidamente se puede usar Standard y aplicar una política
de retención para no llenar la cuota.

Oracle puede recuperar una instancia Always Free que, durante siete días,
mantenga simultáneamente CPU p95, red y —en A1— memoria por debajo del 20 %.
Son **tres condiciones en Y**: tienen que cumplirse las tres a la vez, así que
una instancia con uso real en cualquiera de las tres dimensiones no es
candidata a reclamación. Dimensionar a la baja según el uso real es legítimo,
no una trampa; lo que no se debe hacer es generar carga falsa. Se debe
dimensionar la VM según uso real, vigilarla y asumir que puede perderse. Free
Tier tampoco incluye SLA ni soporte técnico.

## Recuperación fría, no sucesora encendida

Una segunda A1 de 1 OCPU/6 GB consume el resto de la cuota y será precisamente la
máquina más ociosa. La referencia usa una sucesora fría:

1. El planificador interno de la instancia crea una copia `.distop-backup`
   cifrada de forma programada (ver «Copias a Object Storage»).
2. La copia se sube a un bucket privado de Object Storage.
3. Terraform conserva la descripción reconstruible de la infraestructura.
4. La IPv4 reservada existe separada de la vida de la VM.
5. Ante una pérdida, se crea otra VM, se reasigna la IP y se restaura la copia.

Una IP reservada puede reasignarse, pero Terraform no convierte una IP efímera
existente en reservada. Debe crearse como reservada desde el primer despliegue.
No declarar `prevent_destroy` sobre la VM: sí sobre la IP y el bucket cuando la
configuración se separe en módulos.

La copia de Object Storage tampoco debe ser la única copia. Al menos una copia
cifrada reciente debe salir periódicamente de la cuenta de Oracle: PC del dueño,
NAS u otro proveedor gratuito. Una suspensión de la cuenta podría afectar VM,
IP, volumen y bucket a la vez.

Para enterarse de una caída antes que los miembros conviene un watchdog **fuera
de Oracle**: una `e2-micro` del free tier de Google —su 1 GB mensual de salida
sobra de largo para pings a `/health`— u otro servicio gratuito equivalente.
Que sea otro proveedor no es capricho: es otro dominio de fallo. Una suspensión
de la cuenta de Oracle no puede llevarse también al vigilante.

## Terraform para el botón “Deploy to Oracle Cloud”

El botón oficial abre **Create Stack** de Resource Manager con un ZIP Terraform
precargado. El ZIP debe contener la configuración en su raíz y estar publicado
en GitHub, GitLab o mediante una URL preautenticada de Object Storage.

No debe apuntarse el botón al ZIP completo del repositorio si los `.tf` viven en
un subdirectorio. El proceso de release debe construir un artefacto específico,
por ejemplo `distop-oci-stack-v0.1.0.zip`, con esta estructura:

```text
main.tf
variables.tf
outputs.tf
versions.tf
cloud-init.yaml.tftpl
schema.yaml
```

El botón final, una vez publicado y probado ese artefacto, tiene esta forma:

```md
[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=URL_CODIFICADA_DEL_ZIP)
```

No publicar todavía un botón con un marcador ni con la rama `main`: una
actualización del repositorio podría cambiar silenciosamente el stack que ve el
usuario. El botón debe fijarse a un artefacto versionado y con checksum.

### Variables mínimas del stack

```hcl
variable "tenancy_ocid" { type = string }
variable "compartment_ocid" { type = string }
variable "region" { type = string }
variable "availability_domain" { type = string }
variable "ssh_public_key" { type = string }

variable "instance_name" {
  type    = string
  default = "Mi instancia Distop"
}

variable "ocpus" {
  type    = number
  default = 1
  validation {
    condition     = var.ocpus > 0 && var.ocpus <= 2
    error_message = "Always Free permite como máximo 2 OCPU A1 combinadas."
  }
}

variable "memory_gb" {
  type    = number
  default = 6
  validation {
    condition     = var.memory_gb >= 1 && var.memory_gb <= 12
    error_message = "Always Free permite como máximo 12 GB A1 combinados."
  }
}

variable "ubuntu_image_ocid" {
  description = "OCID de una imagen Ubuntu 24.04 ARM64 disponible en la región elegida."
  type        = string
}

variable "distop_release" {
  description = "Tag git inmutable de Distop que cloud-init clona y compila en la VM."
  type        = string
}

variable "public_hostname" {
  description = "Nombre DNS que ya apunta o apuntará a la IPv4 reservada."
  type        = string
}
```

El primer stack debe pedir explícitamente el OCID de la imagen ARM64. Resolver
“la última Ubuntu” automáticamente vuelve una reconstrucción no reproducible y
puede cambiar de imagen sin revisión. Una release posterior puede ofrecer una
lista regional generada y probada.

No hay variables para credenciales TURN, y es a propósito: el secreto de coturn
se genera dentro de la VM en el primer arranque y nunca viaja como variable del
stack — todo lo que entra por variables acaba en el estado de Terraform y en el
`user_data`, ambos legibles (ver «Salidas seguras» y «cloud-init»).

### Red y VM

El esqueleto siguiente muestra los recursos y las reglas necesarias. Debe
validarse con `terraform validate`, `terraform plan` y un despliegue real en una
tenancy de prueba antes de convertirse en artefacto público.

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

provider "oci" {
  region = var.region
}

resource "oci_core_vcn" "distop" {
  compartment_id = var.compartment_ocid
  cidr_block     = "10.42.0.0/16"
  display_name   = "distop"
  dns_label      = "distop"
}

resource "oci_core_internet_gateway" "distop" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id
  enabled        = true
  display_name   = "distop-internet"
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id
  route_rules {
    network_entity_id = oci_core_internet_gateway.distop.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "distop" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  dynamic "ingress_security_rules" {
    for_each = toset(["22", "80", "443", "3478"])
    content {
      protocol = "6"
      source   = ingress_security_rules.value == "22" ? "REEMPLAZAR_POR_CIDR_ADMIN" : "0.0.0.0/0"
      tcp_options {
        min = tonumber(ingress_security_rules.value)
        max = tonumber(ingress_security_rules.value)
      }
    }
  }

  ingress_security_rules {
    protocol = "17"
    source   = "0.0.0.0/0"
    udp_options { min = 3478, max = 3478 }
  }

  ingress_security_rules {
    protocol = "17"
    source   = "0.0.0.0/0"
    udp_options { min = 49160, max = 49260 }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.distop.id
  cidr_block        = "10.42.1.0/24"
  display_name      = "distop-public"
  dns_label         = "public"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.distop.id]
}

resource "oci_core_public_ip" "distop" {
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  display_name   = "distop"
}

resource "oci_core_instance" "distop" {
  availability_domain = var.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "distop"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = false
    hostname_label   = "distop"
  }

  source_details {
    source_type = "image"
    source_id   = var.ubuntu_image_ocid
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      instance_name   = var.instance_name
      public_hostname = var.public_hostname
      distop_release  = var.distop_release
    }))
  }
}

data "oci_core_vnic_attachments" "distop" {
  compartment_id = var.compartment_ocid
  instance_id     = oci_core_instance.distop.id
}

data "oci_core_vnic" "distop" {
  vnic_id = data.oci_core_vnic_attachments.distop.vnic_attachments[0].vnic_id
}

resource "oci_core_public_ip" "attachment" {
  # Según la versión del proveedor, la asociación puede hacerse en el mismo
  # recurso de IP mediante private_ip_id. No crear una segunda IP: adaptar el
  # recurso anterior durante la validación del stack.
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_vnic.distop.private_ip_id
  display_name   = "distop-attached"
}
```

El fragmento deja deliberadamente visible una decisión que debe resolverse antes
de publicar: el proveedor OCI asocia la IP reservada mediante `private_ip_id`;
por tanto, el stack final debe tener **un solo** recurso `oci_core_public_ip`, no
los dos recursos ilustrativos. Tampoco debe exponer SSH a `0.0.0.0/0`: el
formulario debe pedir el CIDR del administrador o instalar OCI Bastion.

### Salidas seguras

```hcl
output "public_ip" {
  value = oci_core_public_ip.distop.ip_address
}

output "distop_url" {
  value = "https://${var.public_hostname}"
}
```

No sacar contraseñas, tokens TURN, claves de DuckDNS ni frases de copia mediante
outputs de Terraform. `sensitive = true` solo oculta la presentación: el secreto
puede seguir dentro del estado de Terraform. La versión pública debe generar los
secretos dentro de la VM o recuperarlos desde OCI Vault, nunca recibirlos como
variables ordinarias del stack.

## cloud-init

El arranque debe ser idempotente: si se ejecuta dos veces no debe borrar `/data`
ni regenerar la identidad de una instancia restaurada. Un esquema seguro es:

```yaml
#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - git
  - iptables-persistent
  - coturn
  - caddy

write_files:
  - path: /etc/distop/distop.env
    permissions: "0600"
    content: |
      INSTANCE_NAME=${instance_name}
      PUBLIC_URL=https://${public_hostname}
      TRUST_PROXY=true
      DATABASE_PATH=/data/app.db
      DEFAULT_STORAGE_PATH=/data/uploads
      NODE_ENV=production
      # Copias programadas dentro del servidor: aquí la API local de copias no
      # está disponible (ver «Lo que "remoto" cambia en la instancia»).
      BACKUP_INTERVAL_HOURS=24
      BACKUP_KEEP=7
      BACKUP_PASSPHRASE_FILE=/data/backup-passphrase
      # Opt-in: descomentar para aparecer en el descubrimiento y publicar NodeInfo.
      # PUBLIC_DISCOVERY_ENABLED=true
      # AUTH_SECRET, TURN_URL y TURN_SECRET los añade el primer arranque (runcmd).
      # Jamás en write_files: user_data es legible desde la consola de OCI y
      # desde el endpoint de metadata de la propia VM.

  # Docker publica puertos mediante NAT (cadena DOCKER), saltándose las reglas
  # INPUT del host: el "5000:5000" del compose del repo dejaría la instancia
  # expuesta a Internet aunque iptables no abriera el puerto. Solo loopback:
  - path: /etc/distop/docker-compose.override.yml
    permissions: "0644"
    content: |
      services:
        instance:
          ports: !override
            - "127.0.0.1:5000:5000"

  - path: /etc/caddy/Caddyfile
    permissions: "0644"
    content: |
      ${public_hostname} {
        encode zstd gzip
        reverse_proxy 127.0.0.1:5000
      }

  - path: /etc/turnserver.conf
    permissions: "0600"
    content: |
      listening-port=3478
      fingerprint
      use-auth-secret
      static-auth-secret=REEMPLAZADO_EN_EL_PRIMER_ARRANQUE
      realm=${public_hostname}
      min-port=49160
      max-port=49260
      no-cli
      no-multicast-peers
      no-loopback-peers
      stale-nonce=600
      # El primer arranque sustituye el marcador por un secreto generado en la
      # VM y añade external-ip=IP_PUBLICA/IP_PRIVADA desde el metadata de OCI.
      # Sin ese mapeo, TURN detrás de la VNIC anuncia candidatos de relay
      # inalcanzables.

  - path: /etc/systemd/system/distop.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Distop
      Wants=network-online.target
      After=network-online.target docker.service
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/opt/distop/src
      ExecStart=/usr/bin/docker compose -f docker-compose.yml -f /etc/distop/docker-compose.override.yml --env-file /etc/distop/distop.env up -d --build
      ExecStop=/usr/bin/docker compose -f docker-compose.yml -f /etc/distop/docker-compose.override.yml down
      TimeoutStartSec=0

      [Install]
      WantedBy=multi-user.target

runcmd:
  - [mkdir, -p, /opt/distop, /data, /etc/distop]
  # Instalar Docker desde su repositorio oficial. No ejecutar ciegamente
  # scripts remotos ni desplegar desde una rama mutable.
  # Clonar el tag inmutable: hoy no hay imagen publicada, se compila en la VM.
  - [git, clone, --depth, "1", --branch, "${distop_release}",
     "https://github.com/Superkirbo64/Distop-open-source", /opt/distop/src]
  # Secretos: se generan AQUÍ, en la VM, y solo aquí. Idempotente a propósito:
  # un segundo arranque no debe rotar nada ni tocar /data.
  - ["sh", "-c", "grep -q '^AUTH_SECRET=' /etc/distop/distop.env ||
     echo AUTH_SECRET=$(openssl rand -hex 32) >> /etc/distop/distop.env"]
  - ["sh", "-c", "test -f /data/backup-passphrase ||
     (umask 077; openssl rand -base64 32 > /data/backup-passphrase)"]
  - ["sh", "-c", "test -f /etc/distop/turn.secret ||
     (umask 077; openssl rand -hex 32 > /etc/distop/turn.secret)"]
  - ["sh", "-c", "sed -i \"s/REEMPLAZADO_EN_EL_PRIMER_ARRANQUE/$(cat /etc/distop/turn.secret)/\" /etc/turnserver.conf"]
  - ["sh", "-c", "grep -q '^TURN_SECRET=' /etc/distop/distop.env ||
     { echo TURN_URL=turn:${public_hostname}:3478;
       echo TURN_SECRET=$(cat /etc/distop/turn.secret); } >> /etc/distop/distop.env"]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, coturn]
  - [systemctl, enable, --now, caddy]
  - [systemctl, enable, --now, distop]
```

Esta es una plantilla de diseño, no el `cloud-init` final. Faltan a propósito:

- instalación reproducible de Docker;
- obtención de IP pública/privada del metadata de OCI para el `external-ip` de
  coturn;
- restauración opcional desde Object Storage antes de iniciar Distop;
- el timer que sube las copias del planificador interno al bucket;
- actualización DNS por API.

La frase de `/data/backup-passphrase` tiene que existir **además fuera de la
VM** — apuntada en el gestor de contraseñas del dueño en cuanto termina el
primer arranque. Si solo vive en el disco que se perdió, la copia es ruido.

Sobre la tensión compilar-o-descargar: hoy no existe una imagen Docker
publicada de Distop — el `ghcr.io/distop/distop` que aparece en el sitio de
marketing es copy, no un artefacto real. Por eso la v1 clona el tag y compila
en la VM (`up -d --build`): más lento (10–20 minutos en una A1) y dependiente
de GitHub y npm en ese momento, pero honesto. Cuando el release publique la
imagen multi-arquitectura `linux/arm64`, cloud-init pasará a `docker compose
pull` fijado por digest y este paso dejará de doler.

## Caddy y DNS

Configuración mínima:

```caddyfile
comunidad.example.org {
  encode zstd gzip
  reverse_proxy 127.0.0.1:5000
}
```

Requisitos:

- registros A apuntando a la IPv4 reservada;
- puertos TCP 80 y 443 abiertos en la lista de seguridad de OCI y en la VM;
- `PUBLIC_URL=https://comunidad.example.org`;
- `TRUST_PROXY=true`, porque Caddy es el único proxy de confianza delante de
  Distop;
- el puerto 5000 ligado a loopback o bloqueado desde Internet (el override de
  compose del cloud-init existe exactamente para esto).

El proxy tiene dos trampas que no avisan. La primera es WebSocket: la voz viaja
como frames binarios por `/realtime`, y el vídeo del modo host por un segundo
WebSocket con `?media=video` en el mismo puerto. El proxy no debe recortar
query strings ni limitar el tamaño de frame — los keyframes rondan 1,5 MB — y
el techo de caudal, 8 MiB/s por emisor, ya lo pone la instancia: no debe
ponerlo también Caddy. La segunda es el límite de tamaño de cuerpo: si el proxy
lo fija por debajo de `MAX_UPLOAD_SIZE_MB`, los adjuntos grandes fallarán en
Caddy con la instancia perfectamente dispuesta a aceptarlos.

**No usar sslip.io ni nip.io** para el nombre DNS: todos sus subdominios
comparten la cuota de certificados de Let's Encrypt del dominio raíz y está
crónicamente agotada — el certificado no llegará. DuckDNS sí sirve para
comenzar sin comprar dominio: está en la Public Suffix List, así que cada
subdominio tiene cuota propia, y Caddy tiene módulo DNS para él
(`caddy-dns/duckdns`). FreeDNS es otra alternativa válida. El token de DuckDNS
debe permanecer en la VM. Una experiencia realmente automática necesita que el
usuario autorice un nombre o introduzca un token: sin esa autorización,
Terraform puede devolver la IP, pero no inventar legítimamente un nombre DNS.

Tailscale Funnel puede ser el carril fácil tanto en casa como temporalmente en
OCI, usando una auth key etiquetada, efímera, preautorizada y con privilegios
mínimos. No debe hornearse una auth key reutilizable en el ZIP Terraform ni en el
estado de Resource Manager.

## coturn en la misma VM

`ice.ts` ya admite `mode: "custom"`. Una configuración compatible entrega al
cliente:

```text
turn:comunidad.example.org:3478?transport=udp
turn:comunidad.example.org:3478?transport=tcp
```

con usuario y contraseña — o, con `use-auth-secret`, con credenciales acuñadas
al vuelo.

Escribir `turnserver.conf` no conecta nada: Distop solo entrega a los clientes
los servidores ICE que conoce, y hay exactamente dos formas de que conozca este
coturn. La primera es la meta `voice_relay`, que se configura con
`PUT /api/v1/instance/relay` — funciona en remoto porque solo exige ser
anfitrión, y es lo que edita la pantalla de Ajustes → Voz y vídeo. La segunda
es la variable de entorno `ICE_SERVERS`, que tiene precedencia y bloquea la
edición desde la interfaz (`locked: true`). Un cloud-init que solo escribe la
configuración de coturn deja un relay encendido que ningún cliente usará.

El modo `custom` con usuario y contraseña fijos es suficiente para una primera
instalación pequeña, pero no es la forma ideal de exponer un TURN público: si
un miembro extrae la credencial puede usar el relay fuera de Distop hasta que
se rote. Las credenciales temporales con secreto compartido
(`use-auth-secret`, el mecanismo REST de coturn) **se implementan en esta
fase**: la instancia acuña usuario y credencial con caducidad en cada visita y
el secreto nunca sale del servidor. Hasta que la release desplegada las
traiga:

- usar una contraseña aleatoria larga;
- no reutilizarla en ningún otro servicio;
- limitar el rango UDP de relay;
- vigilar bytes y allocations;
- rotarla cuando se expulse a alguien que pudo copiarla;
- mantener Cloudflare Realtime TURN como contingencia independiente.

Un TURN caído o mal configurado degrada solo el **vídeo directo** entre
navegadores; la voz no se toca — viaja por la instancia sobre el mismo
WebSocket, sin WebRTC de por medio.

### Puertos

Abrir en **las dos capas**, red OCI e `iptables` de la VM:

| Protocolo | Puerto | Uso |
|---|---:|---|
| TCP | 80 | ACME/HTTPS redirect |
| TCP | 443 | Distop HTTPS/WSS |
| UDP y TCP | 3478 | TURN |
| UDP | 49160–49260 | allocations de relay |
| TCP | 22 | solo CIDR de administración o bastion |

No hace falta abrir 5349 hasta configurar `turns:` con certificado y probar la
renovación. Para redes que solo dejan salir por 443, coturn necesitaría un diseño
adicional porque Caddy ya ocupa TCP 443. Las opciones son IP secundaria,
balanceo por protocolo/SNI compatible o Cloudflare TURN como respaldo.

Oracle documenta que las imágenes incluyen reglas de firewall del sistema y
recomienda no usar UFW para modificarlas en Ubuntu. Conservar primero las reglas
de iSCSI de OCI y añadir reglas concretas; no reemplazar a ciegas el ruleset.

Ejemplo conceptual que debe integrarse con las reglas existentes:

```sh
iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
iptables -I INPUT -p udp --dport 3478 -j ACCEPT
iptables -I INPUT -p udp --dport 49160:49260 -j ACCEPT
netfilter-persistent save
```

No copiar este bloque sin comprobar antes `iptables-save`: las reglas de la
imagen que protegen el acceso a los volúmenes deben permanecer.

## Copias a Object Storage

Distop ya crea copias consistentes y cifradas, pero la receta con `curl` de
`docs/copias-de-seguridad.md` **no aplica aquí**: ese endpoint exige petición
local y en esta VM nunca la habrá (ver «Lo que “remoto” cambia en la
instancia»). Tampoco vale copiar `app.db` mientras está abierta. La
automatización usa dos piezas:

1. **El planificador interno del servidor.** Con `BACKUP_INTERVAL_HOURS` mayor
   que cero, la instancia crea cada N horas una copia `.distop-backup` cifrada
   con la frase de `BACKUP_PASSPHRASE_FILE` y conserva las últimas
   `BACKUP_KEEP`. Si el fichero de frase falta, no se puede leer o la frase es
   demasiado corta, el proceso se niega a arrancar: descubrir que las copias
   llevaban meses apagadas el día que muere el disco es el peor momento
   posible. El planificador se aparta mientras hay una llamada de voz en curso
   y reintenta después.
2. **Un timer del sistema que sube al bucket.** Un systemd timer sube cada
   copia terminada a Object Storage con nombre temporal, verifica tamaño y
   checksum, solo entonces la publica con su nombre definitivo, y poda las
   remotas más antiguas.

Política inicial:

- copia diaria cifrada, conservar siete;
- subir primero con nombre temporal y publicar el objeto solo tras verificarlo;
- la frase de cifrado **nunca viaja al bucket**, y existe además fuera de la VM
  (gestor de contraseñas del dueño);
- restauración de prueba mensual;
- copia externa periódica fuera de OCI.

### Runbook de reconstrucción

Ante una VM perdida, en orden y por SSH:

1. `terraform apply` crea la VM nueva y reasocia la IPv4 reservada.
2. Descargar la última copia del bucket (`oci os object get`).
3. Parar la instancia: `systemctl stop distop`.
4. Restaurar por CLI:
   `DISTOP_BACKUP_PASSPHRASE='...' node apps/node-server/restore.ts --file copia.distop-backup --target /data`.
5. Arrancar (`systemctl start distop`) y comprobar `/health` y que el
   fingerprint de identidad es el de siempre.
6. **Reconfigurar el relevo TURN y la URL fija.** La copia redacta a propósito
   `voice_relay` y `public.fixed` por ser secretos: tras restaurar hay que
   volver a introducirlos desde Ajustes o con `PUT /api/v1/instance/relay`.
   Este paso está en la checklist final porque se olvida siempre.

Object Storage no es un backend directo de adjuntos en la primera fase. Los
adjuntos siguen en `/data/uploads`; el bucket guarda artefactos de recuperación.
Cambiar `storage.ts` a S3/OCI es otro proyecto y requiere semántica de borrado,
integridad, cuotas y URLs privadas.

## Publicación y descubrimiento

`GET /api/v1/discovery` ya lista comunidades públicas dentro de una instancia —
pero solo si el administrador activó `PUBLIC_DISCOVERY_ENABLED`. Apagado, que
es el valor de fábrica, responde `[]` con 200: indistinguible a propósito de
una instancia sin comunidades públicas. El directorio central solo resuelve la
mitad global — encontrar instancias que el cliente nunca visitó — y es
**opt-in**: una instancia que no se registra pierde findabilidad, nunca
funcionalidad. No hay plataforma central obligatoria, ni la habrá.

### NodeInfo como puerta estándar

NodeInfo **se implementa en esta fase**; no existe todavía. Hoy
`GET /.well-known/nodeinfo` cae en el fallback de la SPA y devuelve
`index.html` con 200 — lo peor que se le puede responder a una máquina, un
falso positivo. La implementación enruta `/.well-known/*` antes del contenido
estático y responde, solo con `PUBLIC_DISCOVERY_ENABLED` activado (sin él,
404: NodeInfo existe para ser rastreado, y una instancia que no optó por el
descubrimiento no se autoanuncia):

```http
GET /.well-known/nodeinfo
```

```json
{
  "links": [
    {
      "rel": "http://nodeinfo.diaspora.software/ns/schema/2.1",
      "href": "https://comunidad.example.org/nodeinfo/2.1"
    }
  ]
}
```

y un documento NodeInfo válido:

```json
{
  "version": "2.1",
  "software": { "name": "distop", "version": "0.1.2", "repository": "https://github.com/Superkirbo64/Distop-open-source" },
  "protocols": ["distop"],
  "services": { "inbound": [], "outbound": [] },
  "openRegistrations": true,
  "usage": { "users": {}, "localPosts": 0 },
  "metadata": {
    "distop": {
      "info": "https://comunidad.example.org/api/v1/info",
      "discovery": "https://comunidad.example.org/api/v1/discovery"
    }
  }
}
```

NodeInfo no sustituye `/api/v1/info`: lo descubre. Los campos de identidad,
capabilities, epoch, role y `moved_to` siguen perteneciendo al protocolo Distop.
No introducir claves privadas, URLs internas, conteos privados ni nombres de
comunidades no publicadas en NodeInfo.

### Latidos con RFC 9421

El latido y el desafío deben usar HTTP Message Signatures, algoritmo
`ecdsa-p256-sha256`, que coincide con las claves P-256 actuales. El perfil Distop
debe fijar exactamente qué componentes se cubren para evitar implementaciones
incompatibles:

```text
"@method" "@authority" "@target-uri" "content-digest" "content-type"
```

Parámetros obligatorios:

- `created`;
- `expires`, con ventana corta;
- `nonce`, entregado por el directorio;
- `keyid`, igual al fingerprint de instancia;
- `alg="ecdsa-p256-sha256"`.

El cuerpo lleva `Content-Digest`; el directorio rechaza nonces repetidos,
desviaciones de reloj excesivas, autoridad distinta del origen registrado y
claves cuyo fingerprint no corresponda. RFC 9421 ofrece la firma, no toda la
política de confianza: la prueba de control de origen, la prevención de replay y
la cadena de sucesión siguen siendo reglas de Distop.

### Dos carriles desde el primer día

```text
Público
  Autopublicación verificada
  Buscable si el usuario lo pide
  Sin portada ni recomendación automática

Destacado
  Solicitud y revisión humana
  Reglas, contacto y moderadores verificables
  Elegible para portada y recomendaciones
```

No ordenar la portada solamente por miembros o actividad. Eso recompensa bots y
amplifica abuso. Matrix.org congeló su directorio abierto y migró a listas
curadas precisamente porque el directorio podía amplificar contenido dañino.

## Directorio central en Workers + D1

La API central descrita en `CLAUDE.md` puede alojar el registro. En agosto de
2026 Workers Free admite 100.000 solicitudes diarias. D1 Free incluye 5 millones
de filas leídas y 100.000 escritas al día, 5 GB totales por cuenta, pero cada
base gratuita está limitada a 500 MB. Los índices también cuentan como filas
escritas.

### Esquema D1 inicial

```sql
CREATE TABLE instances (
  instance_id       TEXT PRIMARY KEY,
  lineage_id        TEXT NOT NULL,
  origin            TEXT NOT NULL UNIQUE,
  fingerprint       TEXT NOT NULL UNIQUE,
  public_key_jwk    TEXT NOT NULL,
  epoch             INTEGER NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  icon_url          TEXT,
  languages_json    TEXT NOT NULL DEFAULT '[]',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  registration_mode TEXT NOT NULL,
  directory_tier    TEXT NOT NULL DEFAULT 'public'
                    CHECK (directory_tier IN ('public', 'featured', 'hidden', 'blocked')),
  health_state      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (health_state IN ('pending', 'online', 'offline', 'blocked')),
  first_verified_at INTEGER NOT NULL,
  state_changed_at  INTEGER NOT NULL,
  persisted_seen_at INTEGER NOT NULL,
  manifest_etag     TEXT,
  moderation_note   TEXT
);

CREATE INDEX idx_instances_explore
  ON instances(directory_tier, health_state, state_changed_at);
CREATE INDEX idx_instances_lineage ON instances(lineage_id, epoch);

CREATE TABLE succession_edges (
  from_instance_id TEXT NOT NULL,
  to_instance_id   TEXT NOT NULL,
  from_epoch       INTEGER NOT NULL,
  to_epoch         INTEGER NOT NULL,
  certificate_json TEXT NOT NULL,
  verified_at      INTEGER NOT NULL,
  PRIMARY KEY (from_instance_id, to_instance_id)
);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL,
  category         TEXT NOT NULL,
  details          TEXT NOT NULL,
  reporter_hash    TEXT,
  state            TEXT NOT NULL DEFAULT 'open',
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_reports_queue ON reports(state, created_at);

CREATE TABLE moderation_actions (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL,
  action           TEXT NOT NULL,
  reason           TEXT NOT NULL,
  actor             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER
);
```

No guardar un registro D1 en cada latido. Con 1.000 instancias y un latido cada
cinco minutos serían 288.000 solicitudes y escrituras diarias, fuera del límite
Free incluso antes de contar índices.

### Modelo de latido sin escritura continua

1. La instancia envía un latido firmado cada 15 minutos con `manifest_etag`.
2. El Worker verifica firma, nonce, origen y epoch.
3. Un Durable Object por shard mantiene `lastSeen` y estado reciente en memoria o
   almacenamiento SQLite.
4. D1 se actualiza solo cuando cambia metadata, `online → offline`,
   `offline → online`, hay relevo o acción de moderación.
5. Una alarma evalúa expiraciones por lotes; no crea un temporizador por fila.
6. La página Explorar lee D1 y acepta que “online” sea una indicación eventual,
   no presencia en tiempo real.

Durable Objects también tiene límites y escritura medida en Free. No debe
persistir cada ping si no hace falta; puede agrupar por shard y compactar. Una
alternativa aún más simple para el MVP es latido cada hora y persistencia directa
en D1, suficiente mientras haya pocas instancias. No construir la optimización de
10.000 nodos antes de tener cien.

### Seguridad de la verificación

El directorio no puede hacer `fetch()` ingenuo a cualquier URL suministrada:

- solo HTTPS público, salvo un modo de desarrollo explícito;
- resolver DNS antes de conectar y rechazar loopback, link-local, RFC 1918, ULA
  IPv6 y endpoints de metadata cloud;
- limitar redirecciones y volver a validar cada destino;
- limitar tamaño, tiempo y tipo de respuesta;
- no descargar iconos directamente desde el navegador del visitante;
- aplicar rate limits por origen, IP y fingerprint;
- requerir desafío de ida y vuelta antes de publicar;
- conservar lista de bloqueos separada de datos declarados por la instancia.

Workers no ofrece control perfecto contra DNS rebinding mediante una simple
comprobación previa. La versión de producción debe preferir que **la instancia
inicie** el registro firmado y probar control mediante un nonce visible en su
origen, minimizando sondeos arbitrarios del directorio.

## Presupuesto P2P de vídeo y pantalla

`video-budget.ts` protege el modo `host`. En modo `direct`, el límite se desplaza
a la subida del emisor:

```text
subida aproximada = bitrate de la fuente × espectadores efectivos
```

Una pantalla de 1,8 Mbps para nueve espectadores exige cerca de 16,2 Mbps de
subida. Antes de convertir `direct` en valor predeterminado global, implementar:

- máximo de espectadores por fuente según bitrate;
- reducción escalonada de resolución, FPS y bitrate;
- prioridad de pantalla sobre cámara;
- suspensión de pistas invisibles;
- indicador “tu subida limita la calidad”;
- telemetría local de `RTCPeerConnection.getStats()` sin contenido ni IPs;
- posibilidad de rechazar un espectador adicional en vez de degradar toda la
  llamada silenciosamente.

Cuando las métricas reales justifiquen un SFU, evaluar Cloudflare Realtime SFU
como perfil opcional. Su tráfico comparte el bucket de facturación con TURN; no
debe introducirse como dependencia obligatoria del MVP ni asumirse ilimitado.

## Experiencia de usuario

La interfaz no debe pedir al usuario común que entienda redes antes de empezar:

```text
Publicar mi comunidad
  ├─ En este PC → Tailscale Funnel → URL fija *.ts.net
  └─ Siempre disponible → Deploy to Oracle Cloud
                         ├─ Fácil: Funnel temporal
                         └─ Avanzado: IP reservada + DNS + Caddy
```

El resultado de Resource Manager debe mostrar:

- estado del despliegue;
- IP reservada;
- URL, solo cuando DNS y HTTPS estén verificados;
- código de reclamación de un solo uso por un canal seguro;
- estado de copia;
- estado de TURN;
- coste estimado: `0` únicamente si todos los recursos tienen etiqueta Always
  Free y permanecen dentro de cuota.

Nunca prometer un tiempo fijo como “tres minutos”. La capacidad A1 puede no estar
disponible en la región principal y cloud-init depende de repositorios externos.
La UI debe explicar `out of host capacity` y permitir reintentar en otro
availability domain de la misma región principal.

## Lo que esto no puede hacer

- **No hay SLA.** Always Free no promete disponibilidad ni soporte. Oracle
  puede reclamar la instancia (las tres condiciones en Y de arriba), y una
  suspensión de cuenta se lleva VM, IP, volumen y bucket a la vez. La defensa
  es la copia fuera de OCI, no la confianza en el proveedor.
- **Nada es «local» en esta VM.** Con proxy delante y `PUBLIC_URL`
  configurada, la copia por HTTP, la inspección y restauración por API y el
  relevo de anfitrión desde la web no funcionan y no van a funcionar. Sus
  caminos aquí son el planificador interno de copias y la CLI por SSH.
- **Restaurar exige parar la instancia.** No hay restauración en caliente ni
  automática al arrancar; es una operación deliberada por CLI, con la
  instancia detenida.
- **La copia no incluye `voice_relay` ni `public.fixed`.** Se redactan a
  propósito por ser secretos: tras cada restauración hay que reconfigurarlos a
  mano, y olvidarlo deja el vídeo directo sin relay sin ningún aviso ruidoso.
- **Hasta que lleguen las credenciales TURN efímeras, la credencial fija es
  extraíble.** Cualquier miembro puede copiarla del navegador y usar el relay
  fuera de Distop hasta que se rote.
- **Esto sigue siendo self-hosting.** La VM es tuya, las copias son tuyas y el
  fallo también. El PC en casa sigue siendo el modo por defecto de Distop; la
  nube es un tercer modo opcional para quien quiere la comunidad siempre
  encendida, no un servicio que alguien opera por ti.

## Puertas antes de declararlo listo

- [ ] Imagen Distop multi-arquitectura publicada por el job de release y fijada
  por digest — hasta entonces la VM compila desde el tag, y esta casilla no
  bloquea a las demás.
- [ ] ZIP Terraform versionado, checksum publicado y `terraform validate` limpio.
- [ ] Despliegue probado en tenancy Free Tier nueva sin crear recursos cobrables.
- [ ] Una sola IPv4 reservada creada y correctamente asociada.
- [ ] SSH restringido; puerto 5000 no público.
- [ ] Reglas OCI e iptables probadas sin romper iSCSI.
- [ ] Caddy renueva certificados tras reinicio.
- [ ] coturn anuncia la IP externa correcta y supera una prueba WebRTC desde red
  móvil y red doméstica.
- [ ] Credenciales TURN temporales o riesgo de credencial fija aceptado y visible.
- [ ] Planificador interno creando copias cifradas y timer subiéndolas al
  bucket, verificado de punta a punta.
- [ ] Ensayo real del runbook de restauración por CLI, incluida la
  reconfiguración de `voice_relay` y `public.fixed` tras restaurar.
- [ ] Pérdida y reconstrucción completa ensayadas conservando identidad.
- [ ] NodeInfo válido y `/api/v1/info` sin datos privados.
- [ ] Perfil RFC 9421 documentado con vectores de prueba.
- [ ] Registro resistente a replay, SSRF, spam y sucesiones falsas.
- [ ] Directorio público separado del destacado desde el primer lanzamiento.
- [ ] Alertas de cuota de Oracle, Workers, D1, TURN y almacenamiento.

## Referencias

- [Oracle: Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle: Deploy to Oracle Cloud button](https://docs.oracle.com/en-us/iaas/Content/ResourceManager/Tasks/deploybutton.htm)
- [Oracle: public IP addresses](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm)
- [Oracle: platform images and firewall warning](https://docs.oracle.com/en-us/iaas/Content/Compute/References/images.htm)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [NodeInfo 2.1](https://nodeinfo.diaspora.software/protocol.html)
- [RFC 9421: HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
- [Matrix.org: Switching to Curated Room Directories](https://www.matrix.org/blog/2025/02/curated-room-directories/)

