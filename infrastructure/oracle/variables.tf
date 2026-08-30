# Variables del stack. Las validaciones codifican los límites Always Free para
# que un error de cuota aparezca en `terraform plan`, no como factura sorpresa.
#
# A propósito NO existen turn_username/turn_password ni ninguna otra variable
# secreta de servicio: los secretos (TURN, AUTH_SECRET, frase de copias) se
# generan DENTRO de la VM en firstboot.sh. Todo lo que entra por variable acaba
# en el state de Terraform y en el user_data, ambos legibles.

variable "tenancy_ocid" {
  description = "OCID de la tenancy (raíz). Resource Manager lo rellena solo."
  type        = string
}

variable "compartment_ocid" {
  description = "OCID del compartment donde vivirán la red, la VM y el bucket (puede ser la propia tenancy)."
  type        = string
}

variable "region" {
  description = "Región principal de la tenencia — las cuotas Always Free viven ahí (ej.: eu-madrid-1)."
  type        = string
}

variable "availability_domain" {
  description = "Availability domain para la VM. Ante 'Out of host capacity', cambia a otro AD de la misma región y reaplica (ver README)."
  type        = string
}

variable "ssh_public_key" {
  description = "Clave pública SSH del administrador (una línea, formato authorized_keys)."
  type        = string
}

variable "instance_name" {
  description = "Nombre visible de la instancia Distop."
  type        = string
  default     = "Mi instancia Distop"
}

variable "ocpus" {
  description = "OCPUs de la VM A1.Flex."
  type        = number
  default     = 1

  validation {
    condition     = var.ocpus > 0 && var.ocpus <= 2
    error_message = "Always Free permite como máximo 2 OCPU A1 combinadas en toda la tenencia."
  }
}

variable "memory_gb" {
  description = "Memoria de la VM en GB."
  type        = number
  default     = 6

  validation {
    condition     = var.memory_gb >= 1 && var.memory_gb <= 12
    error_message = "Always Free permite como máximo 12 GB de RAM A1 combinados en toda la tenencia."
  }
}

variable "boot_volume_gb" {
  description = "Tamaño del volumen de arranque en GB. Los datos (/data) viven dentro de él en v1."
  type        = number
  default     = 50

  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 200
    error_message = "boot_volume_gb debe estar entre 50 (mínimo de OCI) y 200 (cuota Block Volume Always Free combinada)."
  }
}

variable "ubuntu_image_ocid" {
  description = "OCID de una imagen Canonical Ubuntu 24.04 aarch64. Vacío = la resuelve el stack (la más reciente compatible con A1.Flex, que por el filtro de shape siempre es aarch64). Fíjalo cuando quieras clavar una imagen concreta; el OCID en uso sale por el output image_ocid."
  type        = string
  default     = ""
}

variable "distop_release" {
  description = "Tag inmutable de Distop que firstboot clona y compila (ej.: v0.1.2)."
  type        = string

  validation {
    condition     = can(regex("^v[0-9]", var.distop_release))
    error_message = "distop_release debe ser un tag versionado (v0.1.2), nunca una rama mutable."
  }
}

variable "public_hostname" {
  description = "Nombre DNS que apunta(rá) a la IP reservada: subdominio DuckDNS o dominio propio. Jamás sslip.io/nip.io (cuota Let's Encrypt compartida agotada, ver README)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.public_hostname))
    error_message = "public_hostname debe ser un nombre DNS en minúsculas, sin esquema ni barra (ej.: micomunidad.duckdns.org)."
  }
}

variable "admin_cidr" {
  description = "CIDR IPv4 con acceso SSH (ej.: 203.0.113.7/32). Obligatorio y sin default: el 22 jamás se abre al mundo entero."
  type        = string

  validation {
    condition     = can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/(3[0-2]|[12]?[0-9])$", var.admin_cidr))
    error_message = "admin_cidr debe ser un CIDR IPv4 válido, por ejemplo 203.0.113.7/32."
  }
}

variable "duckdns_token" {
  description = "Token de DuckDNS; vacío si usas dominio propio. AVISO: sensitive solo oculta la presentación — el token queda legible en el state de Terraform y en el user_data de la VM. Con dominio propio no hace falta ninguno."
  type        = string
  default     = ""
  sensitive   = true
}

variable "setup_code" {
  description = "Código de un solo uso para reclamar la instancia desde el navegador, sin entrar por SSH a leer el log. Vacío = la instancia genera uno aleatorio en cada arranque y solo se lee por SSH. AVISO: como duckdns_token, queda legible en el state y en el user_data — pero muere en el momento en que alguien reclama la instancia."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.setup_code == "" || can(regex("^[A-Za-z0-9-]{8,64}$", var.setup_code))
    error_message = "setup_code debe tener entre 8 y 64 caracteres, solo letras, números o guiones: va literal a un fichero de entorno y un espacio o una almohadilla lo romperían."
  }
}

variable "create_iam" {
  description = "Crear dynamic group + policy para que la VM suba copias con instance principal. Exige permisos de administrador en la home region; si no los tienes, ponlo en false y sigue el fallback manual del README."
  type        = bool
  default     = true
}

variable "backup_keep" {
  description = "Cuántas copias cifradas conservar (en la VM y en el bucket)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_keep >= 1 && var.backup_keep <= 60
    error_message = "backup_keep debe estar entre 1 y 60."
  }
}
