import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = new URL('../public/hospital_tv_display_logo.png', import.meta.url);
const logo = (await readFile(source)).toString('base64');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [192, 512]) {
    const data = await page.evaluate(async ({ logo, size }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${logo}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { logo, size });
    await writeFile(fileURLToPath(new URL(`../public/app-icon-${size}.png`, import.meta.url)), Buffer.from(data, 'base64'));
  }
} finally {
  await browser.close();
}
