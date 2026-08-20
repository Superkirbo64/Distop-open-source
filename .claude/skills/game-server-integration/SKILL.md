---
name: game-server-integration
description: Architecture requirements for hosting and integrating game servers (Minecraft and others) — installation, community widgets, isolation/security. Load when working on Minecraft or other game-server features — not yet implemented in this repo.
---

## 13. Servidores de Minecraft y servicios comunitarios

Los usuarios podrán utilizar la plataforma para administrar servidores de juegos, principalmente Minecraft.

La plataforma deberá diferenciar:

1. Integración con un servidor Minecraft existente.
2. Instalación de un servidor Minecraft.
3. Administración del servidor.
4. Visualización del estado.
5. Conexión entre eventos del juego y canales.
6. Ejecución de otros servicios comunitarios.

### 13.1 Instalación

El administrador podrá instalar:

* Minecraft Java.
* Minecraft Bedrock.
* Paper.
* Purpur.
* Fabric.
* Forge.
* NeoForge.
* Velocity.
* Waterfall u otras alternativas mantenidas.

El sistema podrá utilizar plantillas Docker.

Ejemplo conceptual:

```yaml
services:
  minecraft:
    image: itzg/minecraft-server
    environment:
      EULA: "TRUE"
      TYPE: "PAPER"
      MEMORY: "4G"
    ports:
      - "25565:25565"
    volumes:
      - "./minecraft-data:/data"
```

La interfaz deberá permitir:

* Seleccionar versión.
* Seleccionar tipo de servidor.
* Definir memoria.
* Definir puerto.
* Configurar whitelist.
* Configurar operadores.
* Instalar plugins.
* Iniciar.
* Detener.
* Reiniciar.
* Ver consola.
* Ver logs.
* Realizar backups.
* Restaurar backups.
* Ver jugadores online.
* Ver CPU y memoria.
* Copiar dirección del servidor.

### 13.2 Integración con la comunidad

Funciones deseadas:

* Widget de estado.
* Jugadores online.
* Dirección del servidor.
* Versión.
* Latencia.
* Eventos de entrada y salida.
* Chat puente.
* Avisos de servidor.
* Registro de muertes.
* Logros.
* Estado de backups.
* Botones de iniciar y detener.
* Permisos por rol.

### 13.3 Seguridad

Nunca exponer directamente:

* Contraseñas.
* Tokens RCON.
* Claves privadas.
* Variables de entorno.
* Dirección interna.
* Acceso al sistema de archivos completo.

Los servicios de juegos deben ejecutarse aislados.

Preferir:

* Contenedores.
* Usuarios sin privilegios.
* Volúmenes limitados.
* Límites de CPU.
* Límites de RAM.
* Redes separadas.
* Secretos cifrados.
* Logs auditables.

### 13.4 Otros servicios

La arquitectura deberá poder soportar posteriormente:

* Terraria.
* Valheim.
* Factorio.
* Project Zomboid.
* Palworld.
* Counter-Strike.
* Servidores web.
* Wikis.
* Bots.
* Bases de datos.
* Paneles.
* Repositorios.
* Herramientas para comunidades.

No implementar todos estos servicios en el MVP. Diseñar una arquitectura extensible.
