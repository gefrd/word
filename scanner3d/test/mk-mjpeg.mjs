import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto('http://localhost:5190/test/synth.html'); await page.waitForFunction(() => window.ready);
const frames = await page.evaluate(() => window.renderCameraFrames(450));
fs.writeFileSync('test/out/camera.mjpeg', Buffer.concat(frames.map(b => Buffer.from(b, 'base64'))));
console.log('frames', frames.length, 'bytes', fs.statSync('test/out/camera.mjpeg').size);
await browser.close();
