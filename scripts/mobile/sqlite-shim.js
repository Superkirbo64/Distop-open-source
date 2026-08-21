/**
 * `node:sqlite` sobre node-sqlite3-wasm, para el motor Node 18 embebido en el
 * APK (nodejs-mobile no trae node:sqlite: existe desde Node 22.5).
 *
 * node-sqlite3-wasm es SQLite compilado a WASM con un VFS que escribe en el
 * disco de verdad vía node:fs — persistencia real, no un volcado en memoria.
 * La forma de la API es casi la misma; las diferencias que importan:
 *
 * - Los statements WASM hay que finalizarlos o se acumulan en la memoria del
 *   proceso. El servidor usa el patrón db.prepare(...).get(...) al vuelo, así
 *   que aquí cada ejecución prepara, ejecuta y finaliza. Menos rápido que
 *   cachear, pero imposible de dejar fugas.
 * - node:sqlite pasa parámetros posicionales sueltos; WASM los quiere en array.
 * - Los PRAGMA de rendimiento del VFS nativo (WAL, busy_timeout) no existen en
 *   WASM: se intentan y, si el motor no los conoce, se sigue sin ellos. Solo
 *   esos: un PRAGMA de datos (user_version) que falle sí debe explotar.
 */
// CJS bajo Node 18: la exportación con nombre no siempre se detecta.
import sqliteWasm from "node-sqlite3-wasm";
const { Database } = sqliteWasm;

const PRAGMA_OPCIONAL = /pragma\s+(journal_mode|busy_timeout|synchronous|foreign_keys)/i;

export class DatabaseSync {
  #db;

  constructor(path) {
    this.#db = new Database(path);
  }

  exec(sql) {
    try {
      this.#db.exec(sql);
    } catch (err) {
      if (!PRAGMA_OPCIONAL.test(sql)) throw err;
    }
  }

  prepare(sql) {
    const db = this.#db;
    const run = (method, args) => {
      const stmt = db.prepare(sql);
      try {
        return stmt[method](args.length > 0 ? args : undefined);
      } catch (err) {
        if (PRAGMA_OPCIONAL.test(sql)) return undefined;
        throw err;
      } finally {
        stmt.finalize();
      }
    };
    return {
      get: (...args) => run("get", args),
      all: (...args) => run("all", args),
      run: (...args) => {
        const result = run("run", args);
        return { changes: result?.changes ?? 0, lastInsertRowid: result?.lastInsertRowid ?? 0 };
      },
    };
  }

  close() {
    this.#db.close();
  }
}
