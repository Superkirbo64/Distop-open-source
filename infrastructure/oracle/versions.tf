# Versiones fijadas (§17: versiones fijadas en todo el monorepo).
# Tras el primer `terraform init`, commitea `.terraform.lock.hcl` para que la
# versión exacta del proveedor quede clavada también en CI y en Resource Manager.
terraform {
  # Techo en 1.6 a propósito, no por pereza: Terraform pasó a licencia BUSL en
  # esa versión y Oracle Resource Manager se quedó en la última MPL (1.5.x).
  # Pedir ">= 1.6" hacía que la consola rechazara el zip con "Invalid Terraform
  # version" antes siquiera de leer el plan. Nada de esta configuración
  # necesita 1.6: validaciones, templatefile y base64gzip existen desde mucho
  # antes. El CI valida con la misma versión que ejecutará Resource Manager.
  required_version = ">= 1.2, < 1.6"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}
