// @ts-check
import { defineConfig } from "astro/config";

/**
 * Sitio público de Distop (§4.1): estático puro, sin servidor propio, desplegable
 * en cualquier capa gratuita. No comparte build con `apps/web` a propósito — el
 * cliente vive detrás de sesión y no necesita SEO; esto es justo lo contrario.
 */
export default defineConfig({
  site: "https://distop.app",
  trailingSlash: "always",
  i18n: {
    locales: ["es", "en", "pt-br"],
    defaultLocale: "es",
    routing: { prefixDefaultLocale: true },
  },
  redirects: { "/": "/es/" },
  build: { inlineStylesheets: "always" },
});
