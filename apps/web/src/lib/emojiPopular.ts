/**
 * Los emojis de siempre: lo primero que ve quien abre el selector, antes de
 * bajar por los 1900 del catálogo (§10.3).
 *
 * Vive aparte del catálogo generado porque no sale de ninguna fuente: es una
 * elección, y sirve dos veces. La segunda es el instalador de escritorio —
 * scripts/stage-curated-emoji.mjs lee ESTA lista para decidir qué animaciones
 * embarca el NSIS (§16). Añadir uno aquí lo añade en los dos sitios.
 */
export const POPULAR_EMOJI: readonly string[] = [
  "👍", "👎", "❤️", "🔥", "🎉", "😄", "😂", "🙂", "😉", "😊",
  "😍", "🤔", "😐", "😴", "😢", "😭", "😡", "🥳", "🤝", "🙏",
  "👀", "💪", "✨", "⭐", "💡", "✅", "❌", "⚠️", "🚀", "🐛",
  "💻", "📌", "📎", "🔗", "🔒", "🎮", "🎵", "☕", "🍕", "🌙",
  "🎂", "🍺", "🐱", "🐶", "🌈", "☀️", "🌧️", "❄️", "🏆", "🎯",
];
