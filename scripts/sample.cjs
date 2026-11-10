const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8899/tools/ae_probe/index.html';
const HERE = __dirname;
const INJECT = fs.readFileSync(path.join(HERE, 'inject.js'), 'utf8');
const PATHPARSE = fs.readFileSync(path.join(HERE, 'pathparse.js'), 'utf8');

// 从源码解析场景表
function parseScenes(ch) {
  const f = `C:/Users/admin/Desktop/ai生成科普视频/癫痫科普/纯MG动画方案/remotion-studio-mg/src/film/mg/${ch}.tsx`;
  const src = fs.readFileSync(f, 'utf8');
  const re = /<Scene\s+from=\{([\d.]+)\}\s+to=\{([\d.]+)\}/g;
  const out = [];
  let m, i = 0;
  while ((m = re.exec(src)) !== null) {
    i++;
    out.push({ idx: i, from: parseFloat(m[1]), to: parseFloat(m[2]) });
  }
  return out;
}

(async () => {
  const ch = process.argv[2] || 'Ch00';
  const sceneIdx = parseInt(process.argv[3] || '0', 10); // 0 = 全部
  const step = parseInt(process.argv[4] || '2', 10);

  const scenes = parseScenes(ch);
  const targets = sceneIdx > 0 ? [scenes[sceneIdx - 1]] : scenes;

  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e).slice(0, 200)));

  await page.goto(BASE + '?c=' + ch, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('typeof window.__seek === "function"', { timeout: 60000 });
  await page.evaluate(PATHPARSE);
  await page.evaluate(INJECT);

  for (const sc of targets) {
    const fromF = Math.round(sc.from * 30);
    const toF = Math.round(sc.to * 30) - 1;
    const tag = `${ch}_S${String(sc.idx).padStart(2, '0')}`;
    const outFile = path.join(HERE, 'dump', tag + '.json');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    const frames = [];
    const t0 = Date.now();
    for (let f = fromF; f <= toF; f += step) {
      await page.evaluate((fr) => window.__seek(fr), f);
      const d = await page.evaluate((fr) => window.__extract(fr), f);
      frames.push({ f, els: d.els });
    }
    if ((toF - fromF) % step !== 0) {
      await page.evaluate((fr) => window.__seek(fr), toF);
      const d = await page.evaluate((fr) => window.__extract(fr), toF);
      frames.push({ f: toF, els: d.els });
    }

    fs.writeFileSync(outFile, JSON.stringify({
      ch, scene: sc.idx, from: sc.from, to: sc.to, fromF, toF, step, frames,
    }));

    let maxEls = 0, sumEls = 0;
    for (const fr of frames) { maxEls = Math.max(maxEls, fr.els.length); sumEls += fr.els.length; }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag}  帧 ${fromF}-${toF}  采样 ${frames.length}  平均层 ${(sumEls / frames.length).toFixed(1)}  峰值 ${maxEls}  用时 ${dt}s`);
  }
  if (errs.length) console.log('错误:', errs.slice(0, 3));
  await browser.close();
})();
