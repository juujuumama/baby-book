// Renders public/icon.svg to the PNG sizes iOS and the web manifest need.
// Run with: npm run icons   (uses the Playwright Chromium already installed)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const targets = [['apple-touch-icon.png', 180, true], ['icon-192.png', 192, false], ['icon-512.png', 512, false]];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, square] of targets) {
  await page.setViewportSize({ width: size, height: size });
  // iOS rounds the corners itself, so its icon is a full square.
  const art = square ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${art}`);
  await page.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log('icons written');
