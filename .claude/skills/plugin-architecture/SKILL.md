---
name: plugin-architecture
description: Architecture requirements for the platform's bot/plugin/extension system (manifests, sandboxing, marketplace). Load when designing or implementing bots, webhooks, plugins, integrations, or the plugin marketplace — not yet implemented in this repo.
---

## 12. Bots, plugins y extensiones

La plataforma deberá ser extensible.

Debe existir una API para:

* Bots.
* Webhooks.
* Aplicaciones.
* Plugins.
* Integraciones.
* Automatizaciones.
* Temas.
* Widgets.
* Comandos.
* Eventos.
* Paneles personalizados.

La arquitectura debe evitar que plugins ejecuten código peligroso dentro del cliente.

Considerar:

* Plugins aislados.
* Sandboxing.
* Permisos declarativos.
* Manifiestos.
* APIs limitadas.
* Firma opcional.
* Revisión comunitaria.
* Lista de permisos antes de instalar.
* Marketplace abierto.
* Instalación desde GitHub.
* Instalación mediante URL.
* Instalación mediante archivo.

Ejemplo de manifiesto:

```json
{
  "name": "Estado del Servidor",
  "version": "1.0.0",
  "description": "Muestra el estado de la instancia en un canal",
  "permissions": [
    "read_channels",
    "send_messages",
    "read_instance_health"
  ],
  "entry": "index.js"
}
```
