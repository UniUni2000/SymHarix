import { readFileSync } from 'node:fs';

function extractEmbeddedImageHref(fileName: string): string {
  const svg = readFileSync(new URL(`../../assets/logo/${fileName}`, import.meta.url), 'utf8');
  const match = svg.match(/href="([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`SymHarix logo asset ${fileName} does not contain an embedded image href.`);
  }
  return match[1];
}

export const symHarixLogoDarkThemeDataUri = extractEmbeddedImageHref('symharix-mark-reference-transparent-light-stem.svg');
export const symHarixLogoLightThemeDataUri = extractEmbeddedImageHref('symharix-mark-reference-transparent-navy-stem.svg');
