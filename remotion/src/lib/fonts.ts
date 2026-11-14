import { staticFile } from "remotion";

/**
 * CSS @font-face declaration for NotoSerif-Bold and NotoSansDevanagari-Bold (bundled locally).
 */
export const NOTO_SERIF_FONT_FAMILY = "NotoSerif-Bold";
export const NOTO_SANS_DEVANAGARI_FONT_FAMILY = "Noto Sans Devanagari";

export const notoSerifFontFace = `
@font-face {
  font-family: '${NOTO_SERIF_FONT_FAMILY}';
  src: url('${staticFile("fonts/NotoSerif-Bold.ttf")}') format('truetype');
  font-weight: 700;
  font-style: normal;
}
`;

export const devanagariFontFace = `
@font-face {
  font-family: '${NOTO_SANS_DEVANAGARI_FONT_FAMILY}';
  src: url('${staticFile("fonts/NotoSansDevanagari-Bold.ttf")}') format('truetype');
  font-weight: 700;
  font-style: normal;
}
`;

/**
 * Map of subtitle font families to their CSS-safe names.
 * These match the options available in SubtitleModal.jsx.
 * Includes 'Noto Sans Devanagari' as fallback to prevent tofu boxes on Hindi text.
 */
export const SUBTITLE_FONTS: Record<string, string> = {
  Verdana: "Verdana, Geneva, 'Noto Sans Devanagari', sans-serif",
  Arial: "Arial, Helvetica, 'Noto Sans Devanagari', sans-serif",
  Impact: "Impact, Haettenschweiler, 'Noto Sans Devanagari', sans-serif",
  Helvetica: "Helvetica, Arial, 'Noto Sans Devanagari', sans-serif",
  Georgia: "Georgia, 'Times New Roman', 'Noto Sans Devanagari', serif",
  "Courier New": "'Courier New', Courier, 'Noto Sans Devanagari', monospace",
  "Noto Sans Devanagari": "'Noto Sans Devanagari', sans-serif",
};

export function getFontStack(fontFamily: string): string {
  const stack = SUBTITLE_FONTS[fontFamily];
  if (stack) return stack;
  return `${fontFamily}, 'Noto Sans Devanagari', sans-serif`;
}
