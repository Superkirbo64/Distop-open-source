import * as voice from "./voice.js";
/** canal → sala. Como mucho una carrera por sala de voz. */
const lobbies = new Map();
/** Los mundos que conoce el cliente. Fuera de rango se ignora. */
const WORLDS = 3;
export function lobbyOf(channelId) {
    return lobbies.get(channelId) ?? null;
}
/**
 * Abrir es también apuntarse: si ya hay una sala, quien pulsa se une a esa. Dos
 * carreras a la vez en el mismo canal solo servirían para partir a la gente.
 *
 * Hay que estar en la llamada: una carrera de la sala de voz se juega dentro de
 * la sala de voz.
 */
export function open(channelId, userId) {
    if (!voice.participantOf(channelId, userId))
        return null;
    const existing = lobbies.get(channelId);
    if (existing) {
        if (existing.members.includes(userId))
            return existing;
        // Apuntarse durante una carrera vale, pero se corre en la siguiente: la
        // parrilla de la que está en marcha es `runners` y ya está cerrada.
        existing.members = [...existing.members, userId];
        return existing;
    }
    const lobby = {
        channel_id: channelId,
        host_id: userId,
        members: [userId],
        runners: [],
        world: 0,
        seed: null,
        started_at: 0,
    };
    lobbies.set(channelId, lobby);
    return lobby;
}
/**
 * Salirse.
 *
 * Irse NO cierra la carrera, ni siquiera si se va quien la abrió: el testigo
 * pasa al siguiente apuntado. Cerrarla dejaba a los demás mirando una pista que
 * se desvanece, y a quien volvía a entrar le montaba una partida distinta de la
 * que se estaba corriendo. La sala solo desaparece cuando no queda nadie.
 */
export function leave(channelId, userId) {
    const lobby = lobbies.get(channelId);
    if (!lobby || !lobby.members.includes(userId))
        return false;
    lobby.members = lobby.members.filter((id) => id !== userId);
    if (lobby.members.length === 0) {
        lobbies.delete(channelId);
        return true;
    }
    if (lobby.host_id === userId)
        lobby.host_id = lobby.members[0];
    return true;
}
/** Quien sale de la llamada sale también de la carrera, esté empezada o no. */
export function leaveAll(userId) {
    const touched = [];
    for (const channelId of [...lobbies.keys()])
        if (leave(channelId, userId))
            touched.push(channelId);
    return touched;
}
/** El mundo lo elige el anfitrión, y solo antes de dar la salida. */
export function setWorld(channelId, userId, world) {
    const lobby = lobbies.get(channelId);
    if (!lobby || lobby.host_id !== userId || lobby.seed !== null)
        return false;
    if (!Number.isInteger(world) || world < 0 || world >= WORLDS)
        return false;
    if (lobby.world === world)
        return false;
    lobby.world = world;
    return true;
}
/**
 * La salida. La semilla la pone la instancia y no el cliente: si la eligiera
 * quien da la salida, podría probar semillas hasta encontrar una en la que gane.
 */
export function start(channelId, userId) {
    const lobby = lobbies.get(channelId);
    if (!lobby || lobby.host_id !== userId)
        return false;
    // La parrilla se cierra aquí. Quien se apunte a partir de ahora mira esta
    // carrera y corre la siguiente; si no, cada pantalla simularía una distinta.
    lobby.runners = [...lobby.members];
    lobby.seed = Math.floor(Math.random() * 0xffff_ffff);
    lobby.started_at = Date.now();
    return true;
}
