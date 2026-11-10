// 整章构建：把一章所有场景的 jsx 合并成一个脚本，跑一次 AE 建完并存盘
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve as _resolve, dirname } from 'node:path';

const H = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const r2 = (v) => Math.round(v * 100) / 100;
const FPS = 30;

// ---- 与 gen_anim 相同的抽稀与生成逻辑（复用） ----
function keys(samples, getter, tol) {
  const pts = samples.map((s) => ({t: s.f / FPS, v: getter(s)}));
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let last = pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    const v = pts[i].v;
    const diff = Array.isArray(v) ? Math.max(Math.abs(v[0] - last[0]), Math.abs(v[1] - last[1])) : Math.abs(v - last);
    if (diff > tol) { out.push(pts[i]); last = v; }
  }
  const lp = pts[pts.length - 1];
  if (out[out.length - 1].t < lp.t) out.push(lp);
  if (out.length > 40) {
    const st = (out.length - 1) / 39;
    const red = [];
    for (let i = 0; i < 40; i++) red.push(out[Math.round(i * st)]);
    return red;
  }
  return out;
}

function jsxKeys(prop, k, spatial) {
  if (!k.length) return '';
  return k.map((p) => {
    const v = spatial ? `[${r2(p.v[0])},${r2(p.v[1])}]` : Array.isArray(p.v) ? `[${p.v.map(r2).join(',')}]` : r2(p.v);
    return `${prop}.setValueAtTime(${r2(p.t)}, ${v});`;
  }).join('\n');
}

function fin(L, v) {
  L.push(`for (var _k = 1; _k <= ${v}.numKeys; _k++) ${v}.setInterpolationTypeAtKey(_k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);`);
}

function pickFont(ff) {
  const s = String(ff || '').toLowerCase();
  if (s.indexOf('monospace') >= 0 || s.indexOf('consolas') >= 0) return 'Consolas';
  if (s.indexOf('georgia') >= 0) return 'Georgia';
  if (s.indexOf('sans-serif') >= 0 || s.indexOf('sans sc') >= 0 || s.indexOf('yahei') >= 0) return 'Microsoft YaHei';
  if (s.indexOf('serif') >= 0) return 'SimSun';
  return 'Microsoft YaHei';
}

function buildTracks(frames) {
  const map = new Map();
  for (const fr of frames) {
    for (const e of fr.els) {
      const sig = e.kind === 'text' ? e.path + '#' + (e.text || '') : e.path;
      let tr = map.get(sig);
      if (!tr) { tr = {sig, kind: e.kind, first: null, last: null, samples: [], rep: e}; map.set(sig, tr); }
      tr.samples.push({f: fr.f, x: e.x, y: e.y, w: e.w, h: e.h, op: e.opacity, e});
      if (tr.first === null) tr.first = fr.f;
      tr.last = fr.f;
      tr.rep = e;
    }
  }
  return Array.from(map.values());
}

function makeAnim(tr, name, compVar) {
  const e0 = tr.samples[0].e;
  const L = [];
  const inT = tr.samples[0].f / FPS;
  const outT = (tr.last + 1) / FPS;
  L.push(`try {`);
  L.push(`AE_del(${compVar}, "${H(name)}");`);

  if (tr.kind === 'text') {
    const fam = pickFont(e0.fontFamily);
    const bold = parseInt(e0.fontWeight, 10) >= 600;
    const col = (e0.color || 'rgb(0,0,0)').match(/[\d.]+/g) || ['0', '0', '0'];
    const t = String(e0.text || '').split(String.fromCharCode(10)).join(String.fromCharCode(13));
    L.push(`var ly = ${compVar}.layers.addText(${JSON.stringify(t)}); ly.name = "${H(name)}";`);
    L.push(`var P = ly.property("Source Text"); var td = P.value;`);
    L.push(`td.font = "${fam}"; td.fontSize = ${r2(e0.fontSize)}; td.fauxBold = ${bold};`);
    L.push(`td.applyFill = true;`);
    L.push(`td.fillColor = [${r2(parseFloat(col[0]) / 255)},${r2(parseFloat(col[1]) / 255)},${r2(parseFloat(col[2]) / 255)}];`);
    L.push(`td.justification = ParagraphJustification.LEFT_JUSTIFY;`);
    if (e0.lineHeight) L.push(`td.leading = ${r2(e0.lineHeight)};`);
    if (e0.letterSpacing) L.push(`td.tracking = ${Math.round(e0.letterSpacing / e0.fontSize * 1000)};`);
    L.push(`P.setValue(td);`);
    L.push(`ly.property("Transform").property("Anchor Point").setValue([0,0]);`);
    L.push(`ly.property("Transform").property("Position").setValue([0,0]);`);
    L.push(`var _r = ly.sourceRectAtTime(0,false);`);
    L.push(`var _sx = 100 * (${r2(e0.w)} / Math.max(1,_r.width));`);
    L.push(`if (_sx > 78 && _sx < 132) ly.property("Transform").property("Scale").setValue([_sx,100]);`);
    L.push(`var _r2 = ly.sourceRectAtTime(0,false);`);
    L.push(`ly.property("Transform").property("Anchor Point").setValue([_r2.left+_r2.width/2,_r2.top+_r2.height/2]);`);
    const kp = keys(tr.samples, (s) => [s.x + s.w / 2, s.y + s.h / 2], 0.6);
    L.push(`var _p = ly.property("Transform").property("Position");`);
    L.push(jsxKeys('_p', kp, true)); fin(L, '_p');
    // 诊断：文本层暂不设透明度关键帧
    L.push(`ly.property("Transform").property("Opacity").setValue(100);`);
  } else if (tr.kind === 'rect') {
    L.push(`var ly = ${compVar}.layers.addShape(); ly.name = "${H(name)}";`);
    L.push(`var root = ly.property("ADBE Root Vectors Group");`);
    L.push(`var g = root.addProperty("ADBE Vector Group"); var vg = g.property("ADBE Vectors Group");`);
    L.push(`var rc = vg.addProperty("ADBE Vector Shape - Rect");`);
    L.push(`rc.property("ADBE Vector Rect Size").setValue([${r2(e0.w)},${r2(e0.h)}]);`);
    L.push(`rc.property("ADBE Vector Rect Position").setValue([0,0]);`);
    if (e0.radius > 0) L.push(`rc.property("ADBE Vector Rect Roundness").setValue(${r2(e0.radius)});`);
    if (e0.fill) {
      L.push(`var _fl = vg.addProperty("ADBE Vector Graphic - Fill");`);
      L.push(`_fl.property("ADBE Vector Fill Color").setValue([${r2(e0.fill.rgb[0] / 255)},${r2(e0.fill.rgb[1] / 255)},${r2(e0.fill.rgb[2] / 255)}]);`);
      if (e0.fill.a < 1) L.push(`_fl.property("ADBE Vector Fill Opacity").setValue(${r2(e0.fill.a * 100)});`);
    }
    if (e0.stroke) {
      L.push(`var _st = vg.addProperty("ADBE Vector Graphic - Stroke");`);
      L.push(`_st.property("ADBE Vector Stroke Color").setValue([${r2(e0.stroke.rgb[0] / 255)},${r2(e0.stroke.rgb[1] / 255)},${r2(e0.stroke.rgb[2] / 255)}]);`);
      L.push(`_st.property("ADBE Vector Stroke Width").setValue(${r2(e0.stroke.w)});`);
      if (e0.stroke.a < 1) L.push(`_st.property("ADBE Vector Stroke Opacity").setValue(${r2(e0.stroke.a * 100)});`);
    }
    L.push(`ly.property("Transform").property("Anchor Point").setValue([0,0]);`);
    const ks = keys(tr.samples, (s) => [s.w, s.h], 0.8);
    const sizeChanged = ks.some((k) => Math.abs(k.v[0] - e0.w) > 0.8 || Math.abs(k.v[1] - e0.h) > 0.8);
    if (sizeChanged) {
      const ksc = ks.map((k) => ({t: k.t, v: [k.v[0] / Math.max(1, e0.w) * 100, k.v[1] / Math.max(1, e0.h) * 100]}));
      L.push(`var _sc = ly.property("Transform").property("Scale");`);
      L.push(jsxKeys('_sc', ksc, false)); fin(L, '_sc');
    }
    const kp = keys(tr.samples, (s) => [s.x + s.w / 2, s.y + s.h / 2], 0.6);
    L.push(`var _p = ly.property("Transform").property("Position");`);
    L.push(jsxKeys('_p', kp, true)); fin(L, '_p');
    const ko = keys(tr.samples, (s) => s.op * 100, 2.0);
    if (ko.length > 1) {
      L.push(`var _o = ly.property("Transform").property("Opacity");`);
      L.push(jsxKeys('_o', ko, false)); fin(L, '_o');
    }
  } else if (tr.kind === 'svg') {
    const cx0 = e0.x + e0.w / 2, cy0 = e0.y + e0.h / 2;
    L.push(`var ly = ${compVar}.layers.addShape(); ly.name = "${H(name)}";`);
    L.push(`var root = ly.property("ADBE Root Vectors Group");`);
    for (const grp of e0.groups) {
      L.push(`var g = root.addProperty("ADBE Vector Group"); var vg = g.property("ADBE Vectors Group");`);
      for (const sub of grp.subs) {
        const vs = sub.v.map((p) => `[${r2(p[0] - cx0)},${r2(p[1] - cy0)}]`).join(',');
        const ins = sub.i.map((p) => `[${r2(p[0])},${r2(p[1])}]`).join(',');
        const ous = sub.o.map((p) => `[${r2(p[0])},${r2(p[1])}]`).join(',');
        L.push(`var sg = vg.addProperty("ADBE Vector Shape - Group"); var pv = sg.property("ADBE Vector Shape");`);
        L.push(`var _s = new Shape(); _s.vertices=[${vs}]; _s.inTangents=[${ins}]; _s.outTangents=[${ous}]; _s.closed=${sub.c}; pv.setValue(_s);`);
      }
      if (grp.fill) {
        L.push(`var _fl = vg.addProperty("ADBE Vector Graphic - Fill");`);
        L.push(`_fl.property("ADBE Vector Fill Color").setValue([${r2(grp.fill.rgb[0] / 255)},${r2(grp.fill.rgb[1] / 255)},${r2(grp.fill.rgb[2] / 255)}]);`);
        if (grp.fill.a < 1) L.push(`_fl.property("ADBE Vector Fill Opacity").setValue(${r2(grp.fill.a * 100)});`);
      }
      if (grp.stroke) {
        L.push(`var _st = vg.addProperty("ADBE Vector Graphic - Stroke");`);
        L.push(`_st.property("ADBE Vector Stroke Color").setValue([${r2(grp.stroke.rgb[0] / 255)},${r2(grp.stroke.rgb[1] / 255)},${r2(grp.stroke.rgb[2] / 255)}]);`);
        L.push(`_st.property("ADBE Vector Stroke Width").setValue(${r2(grp.stroke.w)});`);
        if (grp.stroke.a < 1) L.push(`_st.property("ADBE Vector Stroke Opacity").setValue(${r2(grp.stroke.a * 100)});`);
      }
    }
    L.push(`ly.property("Transform").property("Anchor Point").setValue([0,0]);`);
    L.push(`ly.property("Transform").property("Position").setValue([${r2(cx0)},${r2(cy0)}]);`);
    const ks = keys(tr.samples, (s) => [s.w, s.h], 0.8);
    const useScale = ks.some((k) => Math.abs(k.v[0] - e0.w) > 0.8 || Math.abs(k.v[1] - e0.h) > 0.8);
    if (useScale) {
      const ksc = ks.map((k) => ({t: k.t, v: [k.v[0] / e0.w * 100, k.v[1] / e0.h * 100]}));
      L.push(`var _sc = ly.property("Transform").property("Scale");`);
      L.push(jsxKeys('_sc', ksc, false)); fin(L, '_sc');
    }
    const kp = keys(tr.samples, (s) => [s.x + s.w / 2, s.y + s.h / 2], 0.6);
    L.push(`var _p = ly.property("Transform").property("Position");`);
    L.push(jsxKeys('_p', kp, true)); fin(L, '_p');
    const ko = keys(tr.samples, (s) => s.op * 100, 2.0);
    if (ko.length > 1) {
      L.push(`var _o = ly.property("Transform").property("Opacity");`);
      L.push(jsxKeys('_o', ko, false)); fin(L, '_o');
    }
  }

  L.push(`ly.inPoint = ${r2(inT)}; ly.outPoint = ${r2(outT)};`);
  L.push(`} catch(e) { _errs.push("${H(name)}: " + e.message); }`);
  return L.join('\n');
}

const HEADER = `
var FPS = 30;
var _errs = []; var _log = []; var COLORMAP = {};
function AE_folder(name){ for(var i=1;i<=app.project.numItems;i++){var it=app.project.item(i); if(it instanceof FolderItem && it.name===name) return it;} return app.project.items.addFolder(name); }
function AE_comp(name,folder,dur){ for(var i=1;i<=app.project.numItems;i++){var it=app.project.item(i); if(it instanceof CompItem && it.name===name) return it;} var c=app.project.items.addComp(name,1920,1080,1,Math.max(1,dur),FPS); if(folder) c.parentFolder=folder; return c; }
function AE_del(comp,name){ for(var i=comp.numLayers;i>=1;i--) if(comp.layer(i).name===name) comp.layer(i).remove(); }
`;

// ===== 全片构建主流程（10 章 + MAIN + 音频，每章保存一次）=====
const OUT_AEP = process.argv[2];
const OUT_PNG_DIR = process.argv[3] || 'C:/Users/admin/Desktop/ai生成科普视频/癫痫科普/AE工程_v2/_build/frames/all';
const LOGF = _resolve(OUT_AEP).replace(/\.aep$/i, '_build.log').split('\\').join('/');
const DUMP = 'C:/Users/admin/Desktop/ai生成科普视频/癫痫科普/AE工程_v2/_build/dump/';
const AUDIO = 'C:/Users/admin/Desktop/ai生成科普视频/癫痫科普/AE工程_v2/audio/master.m4a';

const CH = [
  ['Ch00', 80.322], ['Ch01', 65.000], ['Ch02', 70.302], ['Ch03', 70.280], ['Ch04', 75.255],
  ['Ch05', 80.226], ['Ch06', 112.942], ['Ch07', 90.227], ['Ch08', 110.000], ['Ch09', 60.000],
];
const TOTAL = 814.773;

const body = [HEADER];
body.push('var _errs = []; var _log = []; var COLORMAP = {};');
body.push('var T0 = new Date().getTime();');
body.push('function _el() { return ((new Date().getTime() - T0) / 1000).toFixed(1) + "s"; }');
body.push('var F_ALL = AE_folder("02_SCENES");');
body.push('var F_CH = AE_folder("01_CHAPTERS");');
body.push(`var main = AE_comp("00_MAIN", null, ${TOTAL});`);
body.push('for (var i = main.numLayers; i >= 1; i--) main.layer(i).remove();');

body.push(`
try {
  var _af = new File(${JSON.stringify(AUDIO)});
  if (_af.exists) {
    var _io = new ImportOptions(_af);
    var _foot = app.project.importFile(_io);
    _foot.name = "audio_master";
    var _al = main.layers.add(_foot);
    _al.name = "AUDIO_master";
    _al.startTime = 0;
    _log.push("audio ok " + _foot.duration.toFixed(2) + "s @ " + _el());
  } else { _log.push("audio MISSING"); }
} catch (ae) { _log.push("audio ERR " + ae.message); }
`);

let chStart = 0;
const summary = [];

for (const pair of CH) {
  const ch = pair[0], chDur = pair[1];
  const files = readdirSync(DUMP).filter((f) => f.indexOf(ch + '_S') === 0 && f.endsWith('.json')).sort();
  if (!files.length) { console.log('跳过（无采样）', ch); continue; }

  body.push(`// ===== ${ch} (${files.length} 场景) =====`);
  const sceneList = [];

  for (const sf of files) {
    const d = JSON.parse(readFileSync(DUMP + sf, 'utf8'));
    const compName = sf.replace(/\.json$/, '');

    const _frames = d.frames.map(function (fr) { return {f: fr.f - d.fromF, els: fr.els}; });
  let tracks = buildTracks(_frames);
    tracks = tracks.filter((t) => t.samples.length >= 2 || t.rep.w * t.rep.h > 400);
    // 去掉同位置"整句 + 当前句"重叠：保留较短的那层
    const txs = tracks.filter((t) => t.kind === 'text');
    for (let ai = 0; ai < txs.length; ai++) {
      for (let bi = ai + 1; bi < txs.length; bi++) {
        const a = txs[ai], b = txs[bi];
        if (a.dropped || b.dropped) continue;
        const ax = a.rep.x + a.rep.w / 2, ay = a.rep.y + a.rep.h / 2;
        const bx = b.rep.x + b.rep.w / 2, by = b.rep.y + b.rep.h / 2;
        if (Math.abs(ax - bx) < 40 && Math.abs(ay - by) < 14) {
          const ta = a.rep.text || '', tb = b.rep.text || '';
          if (ta !== tb && (ta.indexOf(tb) >= 0 || tb.indexOf(ta) >= 0)) {
            if (ta.length > tb.length) a.dropped = true; else b.dropped = true;
          }
        }
      }
    }
    tracks = tracks.filter((t) => !t.dropped);

    const dur = (d.toF - d.fromF + 1) / FPS;
    sceneList.push({name: compName, dur, start: d.from / FPS});
    summary.push({comp: compName, layers: tracks.length});

    body.push(`var sc = AE_comp("${compName}", F_ALL, ${r2(dur)});`);
    body.push('for (var i = sc.numLayers; i >= 1; i--) sc.layer(i).remove();');
    tracks.sort((a, b) => (a.rep.seq || 0) - (b.rep.seq || 0));
    let n = 0;
    for (const tr of tracks) {
      n++;
      const e = tr.rep;
      let label = '';
      if (e.kind === 'text') label = (e.text || '').slice(0, 8).replace(/[\r\n]/g, ' ');
      else if (e.kind === 'svg') label = 'v' + e.groups.length;
      else label = Math.round(e.w) + 'x' + Math.round(e.h);
      const name = `${compName}_e${String(n).padStart(3, '0')}_${e.kind}_${label}`;
      body.push(makeAnim(tr, name, 'sc'));
    }
    body.push(`_log.push("${compName} l=" + sc.numLayers + " @ " + _el());`);
  }

  // 章合成
  body.push(`var chc = AE_comp("${ch}", F_CH, ${chDur});`);
  body.push('for (var i = chc.numLayers; i >= 1; i--) chc.layer(i).remove();');
  for (let k = sceneList.length - 1; k >= 0; k--) {
    const s = sceneList[k];
    body.push(`var _s = AE_comp("${s.name}", F_ALL, ${r2(s.dur)}); var _l = chc.layers.add(_s); _l.name = "${s.name}"; _l.startTime = ${r2(s.start)};`);
  }
  body.push(`_log.push("${ch} layers=" + chc.numLayers + " @ " + _el());`);
  // 放进 MAIN
  body.push(`var _ml = main.layers.add(chc); _ml.name = "${ch}"; _ml.startTime = ${r2(chStart)}; _ml.inPoint = ${r2(chStart)}; _ml.outPoint = ${r2(chStart + chDur)};`);
  body.push(`try { chc.openInViewer(); var _vp = new File("C:/Users/admin/Desktop/ai生成科普视频/癫痫科普/AE工程_v2/_build/frames/all/${ch}.png"); if (_vp.exists) _vp.remove(); chc.saveFrameToPng(${r2(chDur * 0.6)}, _vp); $.sleep(700); _log.push("render ${ch} ok=" + _vp.exists); } catch (re) { _log.push("render ERR ${ch} " + re.message); }`);
  body.push(`app.project.save(new File(${JSON.stringify(OUT_AEP)})); _log.push("SAVED after ${ch} @ " + _el());
try { var _w0 = new File(${JSON.stringify(LOGF)}); _w0.encoding = "UTF-8"; _w0.open("w"); _w0.write(_log.join(String.fromCharCode(10))); _w0.close(); } catch (we) {}`);

  chStart += chDur;
}

// 收尾：统一校色 + 渲染检查帧 + 保存
body.push(`
// 统一重设文本颜色
var _rc = 0;
for (var qi = 1; qi <= app.project.numItems; qi++) {
  var qit = app.project.item(qi);
  if (!(qit instanceof CompItem)) continue;
  for (var ql = 1; ql <= qit.numLayers; ql++) {
    var qly = qit.layer(ql);
    if (qly instanceof TextLayer) {
      var qc = COLORMAP[qly.name];
      if (qc) {
        try { var qp = qly.property("Source Text"); var qtd = qp.value; qtd.applyFill = true; qtd.fillColor = qc; qp.setValue(qtd); _rc++; } catch (qe) {}
      }
    }
  }
}
_log.push("recolor " + _rc + " @ " + _el());

_log.push("errors=" + _errs.length);
for (var ei = 0; ei < _errs.length && ei < 40; ei++) _log.push("  ! " + _errs[ei]);

try {
  app.project.save(new File(${JSON.stringify(OUT_AEP)}));
  _log.push("FINAL SAVED @ " + _el());
} catch (se) { _log.push("FINAL SAVE ERR " + se.message); }

var w = new File(${JSON.stringify(LOGF)}); w.encoding = "UTF-8"; w.open("w"); w.write(_log.join(String.fromCharCode(10))); w.close();
app.quit();
`);

writeFileSync(OUT_AEP.replace(/\.aep$/i, '.jsx'), body.join('\n\n'), 'utf8');
console.log('场景数', summary.length, '总层数', summary.reduce((a, b) => a + b.layers, 0));
for (const s of summary) console.log('  ', s.comp, s.layers);
