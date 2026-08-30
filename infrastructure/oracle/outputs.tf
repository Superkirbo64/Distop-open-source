# Salidas del stack. JAMÁS secretos aquí: los outputs se muestran en la
# consola de Resource Manager y quedan en claro dentro del state de Terraform
# (`sensitive = true` solo oculta la presentación, no el almacenamiento).
# Los secretos de este despliegue (TURN, AUTH_SECRET, frase de copias) se
# generan dentro de la VM y nunca pasan por Terraform.

output "public_ip" {
  description = "IPv4 reservada: apunta aquí el registro A de tu DNS."
  value       = oci_core_public_ip.distop.ip_address
}

output "distop_url" {
  description = "URL pública de la instancia (válida cuando DNS y HTTPS estén activos)."
  value       = "https://${var.public_hostname}"
}

output "backup_bucket" {
  description = "Bucket privado de Object Storage donde el timer diario sube las copias cifradas."
  value       = oci_objectstorage_bucket.backups.name
}

output "image_ocid" {
  description = "Imagen que se usó de verdad. Si el stack la resolvió sola, este es el OCID que hay que fijar para repetir el mismo despliegue."
  value       = local.image_ocid
}
