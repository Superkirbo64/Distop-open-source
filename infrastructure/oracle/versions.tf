# Versiones fijadas (§17: versiones fijadas en todo el monorepo).
# Tras el primer `terraform init`, commitea `.terraform.lock.hcl` para que la
# versión exacta del proveedor quede clavada también en CI y en Resource Manager.
terraform {
  required_version = ">= 1.6"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}
