/**
 * Identidad de marca en un único sitio (§1): el nombre, la terminología y el
 * color base son variables, no literales repartidos por la interfaz. Renombrar
 * el proyecto es editar este archivo y el bloque de tokens de styles.css.
 */
export const BRAND = {
  name: "Distop",
  tagline: "auth.tagline",
  /** Acento por defecto cuando una comunidad no define el suyo. */
  accent: "#4059e0",
  repository: "https://github.com/",
  license: "AGPL-3.0",
} as const;
