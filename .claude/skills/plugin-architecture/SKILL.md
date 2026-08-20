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
  "name": "Minecraft Status",
  "version": "1.0.0",
  "description": "Muestra jugadores y estado del servidor",
  "permissions": [
    "read_channels",
    "send_messages",
    "manage_game_server_widget"
  ],
  "entry": "index.js"
}
```
