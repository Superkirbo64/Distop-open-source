# Distop en Oracle Cloud Always Free — VM A1 + IP reservada + bucket de copias.
#
# Diseño (docs/nube-oracle.md): la VM es reemplazable; lo que debe sobrevivir
# es la IP reservada, el bucket con las copias cifradas y este stack. OJO:
# `terraform destroy` también libera la IP reservada (sin prevent_destroy en
# v1 porque rompería el destroy de Resource Manager) — ver README.

provider "oci" {
  region = var.region
}

# El dynamic group y la policy solo pueden CREARSE contra la home region de la
# tenencia (IAM es global pero su plano de escritura no): este alias la
# descubre solo, sin pedir otra variable.
data "oci_identity_region_subscriptions" "home" {
  tenancy_id = var.tenancy_ocid

  filter {
    name   = "is_home_region"
    values = ["true"]
  }
}

provider "oci" {
  alias  = "home"
  region = data.oci_identity_region_subscriptions.home.region_subscriptions[0].region_name
}

locals {
  # Sufijo apto para nombres de OCI, único por despliegue (deriva del hostname).
  name_suffix = replace(var.public_hostname, ".", "-")

  # Los scripts se renderizan aparte y se inyectan en cloud-init con indent():
  # así viven como ficheros .sh de verdad, revisables y con shellcheck en CI.
  firstboot_sh = templatefile("${path.module}/files/firstboot.sh.tftpl", {
    public_hostname = var.public_hostname
    distop_release  = var.distop_release
    duckdns_token   = var.duckdns_token
  })

  backup_upload_sh = templatefile("${path.module}/files/backup-upload.sh.tftpl", {
    backup_bucket = oci_objectstorage_bucket.backups.name
    backup_keep   = var.backup_keep
  })

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    instance_name    = var.instance_name
    public_hostname  = var.public_hostname
    backup_keep      = var.backup_keep
    firstboot_sh     = local.firstboot_sh
    backup_upload_sh = local.backup_upload_sh
  })
}

# ── Red ──────────────────────────────────────────────────────────────────────

resource "oci_core_vcn" "distop" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.42.0.0/16"]
  display_name   = "distop"
  dns_label      = "distop"
}

resource "oci_core_internet_gateway" "distop" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id
  display_name   = "distop-internet"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id
  display_name   = "distop-public"

  route_rules {
    network_entity_id = oci_core_internet_gateway.distop.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

# Bloques planos a propósito, sin dynamic: lo que está abierto se lee de un
# vistazo y el diff de cualquier cambio enseña exactamente qué puerto se tocó.
# Todo se abre en DOS capas (aquí y en iptables de la VM, paso 3 de firstboot).
resource "oci_core_security_list" "distop" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.distop.id
  display_name   = "distop"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  # 80/tcp: ACME HTTP-01 y redirección a HTTPS (Caddy).
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 80
      max = 80
    }
  }

  # 443/tcp: Distop por HTTPS/WSS detrás de Caddy.
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 443
      max = 443
    }
  }

  # 3478/tcp: TURN por TCP para redes que capan UDP.
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 3478
      max = 3478
    }
  }

  # 22/tcp: SOLO el CIDR del administrador, jamás 0.0.0.0/0.
  ingress_security_rules {
    protocol = "6"
    source   = var.admin_cidr

    tcp_options {
      min = 22
      max = 22
    }
  }

  # 3478/udp: TURN, el camino preferente.
  ingress_security_rules {
    protocol = "17"
    source   = "0.0.0.0/0"

    udp_options {
      min = 3478
      max = 3478
    }
  }

  # 49160-49260/udp: allocations de relay de coturn (rango acotado a propósito).
  ingress_security_rules {
    protocol = "17"
    source   = "0.0.0.0/0"

    udp_options {
      min = 49160
      max = 49260
    }
  }

  # ICMP "fragmentation needed": sin él, path-MTU discovery se rompe y las
  # conexiones con frames grandes (vídeo ~1,5 MB) se cuelgan en silencio.
  ingress_security_rules {
    protocol = "1"
    source   = "0.0.0.0/0"

    icmp_options {
      type = 3
      code = 4
    }
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

# ── VM ───────────────────────────────────────────────────────────────────────

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
    subnet_id      = oci_core_subnet.public.id
    hostname_label = "distop"
    # Sin IP efímera: la ÚNICA IP de esta VM es la reservada que se asocia más
    # abajo y que sobrevive a la VM (recuperación fría sin cambiar DNS). Esto
    # abre una ventana sin egress al arrancar; firstboot.sh la espera (paso 1).
    assign_public_ip = false
  }

  source_details {
    source_type             = "image"
    source_id               = var.ubuntu_image_ocid
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    # base64gzip y no base64encode: el user_data de OCI tiene un límite de
    # 16 KB y este cloud-init en claro lo supera (~21 KB por los scripts
    # embebidos); gzip lo deja en ~10 KB y cloud-init lo descomprime solo.
    # infra.yml imprime ambos tamaños en cada cambio para vigilar el margen.
    user_data = base64gzip(local.cloud_init)
  }
}

# Cadena de datos hasta la IP privada primaria de la VNIC: es el único camino
# para asociar una IP RESERVADA ya creada a una VNIC que nació sin IP.
data "oci_core_vnic_attachments" "distop" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.distop.id
}

data "oci_core_private_ips" "distop" {
  vnic_id = data.oci_core_vnic_attachments.distop.vnic_attachments[0].vnic_id
}

# UNA sola IP pública, RESERVED: existe separada de la vida de la VM. No se
# declara prevent_destroy en v1 (rompería el destroy de Resource Manager);
# el README avisa de que destroy la libera y de cómo protegerla.
resource "oci_core_public_ip" "distop" {
  compartment_id = var.compartment_ocid
  display_name   = "distop"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.distop.private_ips[0].id
}

# ── Copias ───────────────────────────────────────────────────────────────────

data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.tenancy_ocid
}

# Bucket PRIVADO para las copias cifradas. Sin versioning a propósito: los
# 20 GB Always Free de Object Storage son una cuota COMBINADA de la tenencia y
# las versiones ocultas la comerían en silencio; la retención la gobierna
# backup_keep desde el script de subida.
resource "oci_objectstorage_bucket" "backups" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = "distop-backups-${local.name_suffix}"
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}

# ── IAM (instance principal para subir copias, sin claves API en disco) ──────
#
# Gated por create_iam: exige permisos de administrador en la home region.
# Fallback manual con los statements exactos en el README (create_iam = false).

resource "oci_identity_dynamic_group" "distop" {
  count    = var.create_iam ? 1 : 0
  provider = oci.home

  compartment_id = var.tenancy_ocid
  name           = "distop-backup-${local.name_suffix}"
  description    = "VM Distop autorizada a subir copias cifradas a su bucket"
  # Solo ESTA VM, mínimo privilegio. Tras una recuperación fría, `terraform
  # apply` re-apunta la regla al OCID de la VM nueva — no hay que tocar nada.
  matching_rule = "instance.id = '${oci_core_instance.distop.id}'"
}

resource "oci_identity_policy" "distop_backup" {
  count    = var.create_iam ? 1 : 0
  provider = oci.home

  compartment_id = var.compartment_ocid
  name           = "distop-backup-${local.name_suffix}"
  description    = "La VM Distop gestiona objetos SOLO en su bucket de copias"

  # manage objects cubre put/head/rename/delete/list de objetos; read buckets
  # cubre las operaciones de metadatos del bucket. Ambos acotados por nombre.
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.distop[0].name} to manage objects in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.distop[0].name} to read buckets in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
  ]
}
