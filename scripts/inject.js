// 注入到页面的提取器：把当前帧的 DOM 拆成"可矢量化元素"
// 输出每项：几何 + 类型 + 矢量路径(屏幕坐标) + 样式
(() => {
  const NS = 'http://www.w3.org/2000/svg';

  function cssPath(el) {
    const p = [];
    let n = el;
    while (n && n.id !== 'root') {
      const i = Array.prototype.indexOf.call(n.parentNode.children, n);
      p.unshift(n.tagName + ':' + i);
      n = n.parentNode;
    }
    return p.join('>');
  }

  function accOpacity(el) {
    let o = 1, n = el;
    while (n && n !== document.body) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(v)) o *= v;
      n = n.parentElement;
    }
    return o;
  }

  function parseColor(s) {
    if (!s) return null;
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length < 3 || p.some((v) => isNaN(v))) return null;
    return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1};
  }

  function radii(cs) {
    return [
      parseFloat(cs.borderTopLeftRadius) || 0,
      parseFloat(cs.borderTopRightRadius) || 0,
      parseFloat(cs.borderBottomRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius) || 0,
    ];
  }

  function num(el, n, d) {
    const v = el.getAttribute(n);
    return v == null ? d || 0 : parseFloat(v);
  }

  function shapeToD(s) {
    const t = s.tagName.toLowerCase();
    if (t === 'rect') {
      const x = num(s, 'x'), y = num(s, 'y'), w = num(s, 'width'), h = num(s, 'height');
      let rx = s.hasAttribute('rx') ? num(s, 'rx') : s.hasAttribute('ry') ? num(s, 'ry') : 0;
      let ry = s.hasAttribute('ry') ? num(s, 'ry') : rx;
      if (rx <= 0 && ry <= 0) return 'M' + x + ',' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + x + 'Z';
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      return 'M' + (x + rx) + ',' + y + 'H' + (x + w - rx) +
        'A' + rx + ',' + ry + ' 0 0 1 ' + (x + w) + ',' + (y + ry) +
        'V' + (y + h - ry) +
        'A' + rx + ',' + ry + ' 0 0 1 ' + (x + w - rx) + ',' + (y + h) +
        'H' + (x + rx) +
        'A' + rx + ',' + ry + ' 0 0 1 ' + x + ',' + (y + h - ry) +
        'V' + (y + ry) +
        'A' + rx + ',' + ry + ' 0 0 1 ' + (x + rx) + ',' + y + 'Z';
    }
    if (t === 'circle') {
      const cx = num(s, 'cx'), cy = num(s, 'cy'), r = num(s, 'r');
      return 'M' + (cx - r) + ',' + cy + 'A' + r + ',' + r + ' 0 1 0 ' + (cx + r) + ',' + cy +
        'A' + r + ',' + r + ' 0 1 0 ' + (cx - r) + ',' + cy + 'Z';
    }
    if (t === 'ellipse') {
      const cx = num(s, 'cx'), cy = num(s, 'cy'), rx = num(s, 'rx'), ry = num(s, 'ry');
      return 'M' + (cx - rx) + ',' + cy + 'A' + rx + ',' + ry + ' 0 1 0 ' + (cx + rx) + ',' + cy +
        'A' + rx + ',' + ry + ' 0 1 0 ' + (cx - rx) + ',' + cy + 'Z';
    }
    if (t === 'line') return 'M' + num(s, 'x1') + ',' + num(s, 'y1') + 'L' + num(s, 'x2') + ',' + num(s, 'y2');
    if (t === 'polygon' || t === 'polyline') {
      const a = (s.getAttribute('points') || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (a.length < 4) return '';
      let d = 'M' + a[0] + ',' + a[1];
      for (let i = 2; i < a.length; i += 2) d += 'L' + a[i] + ',' + a[i + 1];
      return t === 'polygon' ? d + 'Z' : d;
    }
    return '';
  }

  // 从节点树里抽取带换行的纯文本（<br> -> \n），供"混合文本块"使用
  function extractText(el) {
    let s = '';
    const rec = (n) => {
      if (n.nodeType === 3) { s += n.textContent; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'BR') { s += '\n'; return; }
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      for (let i = 0; i < n.childNodes.length; i++) rec(n.childNodes[i]);
    };
    for (let i = 0; i < el.childNodes.length; i++) rec(el.childNodes[i]);
    return s.replace(/[ \t]+/g, ' ').replace(/\n[ ]+/g, '\n').replace(/[ ]+\n/g, '\n').trim();
  }

  const INLINE = {BR: 1, SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, SUP: 1, SUB: 1, SMALL: 1, MARK: 1, FONT: 1};

  function textRangeRect(el) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const b = r.getBoundingClientRect();
      if (b.width > 0.5 && b.height > 0.5) return b;
    } catch (e) {}
    return el.getBoundingClientRect();
  }

  function dToSubpaths(d, m, R) {
    let subs;
    try {
      subs = window.__parseD(d);
    } catch (e) {
      return [];
    }
    if (!subs || !subs.length) return [];

    // 顶点做完整仿射变换；切线是向量，只做线性部分
    const V = (x, y) => [
      Math.round((m.a * x + m.c * y + m.e - R.x) * 100) / 100,
      Math.round((m.b * x + m.d * y + m.f - R.y) * 100) / 100,
    ];
    const T = (x, y) => [
      Math.round((m.a * x + m.c * y) * 100) / 100,
      Math.round((m.b * x + m.d * y) * 100) / 100,
    ];

    const out = [];
    for (let k = 0; k < subs.length; k++) {
      const sp = subs[k];
      if (sp.v.length < 2) continue;
      out.push({
        v: sp.v.map((p) => V(p[0], p[1])),
        i: sp.i.map((p) => T(p[0], p[1])),
        o: sp.o.map((p) => T(p[0], p[1])),
        c: sp.c,
      });
    }
    return out;
  }

  function svgGroups(svgEl, R) {
    const map = new Map();
    const nodes = svgEl.tagName.toLowerCase() === 'svg'
      ? Array.prototype.slice.call(svgEl.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon'))
      : [svgEl];

    for (let n = 0; n < nodes.length; n++) {
      const s = nodes[n];
      const cs = getComputedStyle(s);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const op = parseFloat(cs.opacity);
      if (!isNaN(op) && op <= 0.01) continue;
      const m = s.getScreenCTM();
      if (!m) continue;

      let d = '';
      if (s.tagName.toLowerCase() === 'path' && s.getPathData) d = s.getAttribute('d') || '';
      else d = shapeToD(s);
      if (!d) continue;

      const subs = dToSubpaths(d, m, R);
      if (!subs.length) continue;

      const fill = parseColor(cs.fill);
      const stroke = parseColor(cs.stroke);
      const sw = parseFloat(cs.strokeWidth) || 0;
      const fo = parseFloat(cs.fillOpacity);
      const so = parseFloat(cs.strokeOpacity);
      const useFill = fill && fill.a > 0 && cs.fill !== 'none';
      const useStroke = stroke && stroke.a > 0 && sw > 0 && cs.stroke !== 'none';
      if (!useFill && !useStroke) continue;

      const key = [
        useFill ? [fill.r, fill.g, fill.b, fill.a, isNaN(fo) ? 1 : fo].join(',') : 'nf',
        useStroke ? [stroke.r, stroke.g, stroke.b, stroke.a, sw, isNaN(so) ? 1 : so].join(',') : 'ns',
        cs.strokeDasharray || 'none',
      ].join('|');

      if (!map.has(key)) {
        map.set(key, {
          fill: useFill ? {rgb: [fill.r, fill.g, fill.b], a: Math.round(fill.a * (isNaN(fo) ? 1 : fo) * 1000) / 1000} : null,
          stroke: useStroke ? {rgb: [stroke.r, stroke.g, stroke.b], a: Math.round(stroke.a * (isNaN(so) ? 1 : so) * 1000) / 1000, w: sw} : null,
          dash: cs.strokeDasharray && cs.strokeDasharray !== 'none' ? cs.strokeDasharray : null,
          subs: [],
        });
      }
      const g = map.get(key);
      for (let k = 0; k < subs.length; k++) g.subs.push(subs[k]);
    }
    const arr = [];
    map.forEach((v) => arr.push(v));
    return arr;
  }

  function parseMatrix(t) {
    if (!t || t === 'none') return null;
    let m = t.match(/matrix\(([^)]+)\)/);
    if (m) {
      const v = m[1].split(',').map(Number);
      return {
        rot: Math.round(Math.atan2(v[1], v[0]) * 18000 / Math.PI) / 100,
        sx: Math.round(Math.hypot(v[0], v[1]) * 1000) / 1000,
        sy: Math.round(Math.hypot(v[2], v[3]) * 1000) / 1000,
        tx: v[4], ty: v[5],
      };
    }
    m = t.match(/matrix3d\(([^)]+)\)/);
    if (m) {
      const v = m[1].split(',').map(Number);
      return {
        rot: Math.round(Math.atan2(v[1], v[0]) * 18000 / Math.PI) / 100,
        sx: Math.round(Math.hypot(v[0], v[1]) * 1000) / 1000,
        sy: Math.round(Math.hypot(v[4], v[5]) * 1000) / 1000,
        tx: v[12], ty: v[13],
      };
    }
    return null;
  }

  window.__extract = function (frameNo) {
    const root = document.querySelector('#root');
    const R = root.getBoundingClientRect();
    const out = [];
    let seq = 0;

    function walk(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;

      const r = el.getBoundingClientRect();
      const op = accOpacity(el);
      if (r.width <= 1 || r.height <= 1 || op <= 0.01) return;
      if (r.bottom < -2 || r.top > 1082 || r.right < -2 || r.left > 1922) return;

      const tag = el.tagName.toLowerCase();
      const bg = parseColor(cs.backgroundColor);
      const hasBg = bg && bg.a > 0.01;
      const hasGrad = /gradient/.test(cs.backgroundImage || '');
      const bc = parseColor(cs.borderTopColor);
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const hasBorder = bw > 0 && cs.borderTopStyle !== 'none' && bc && bc.a > 0;
      const rad = radii(cs);
      const txt = (el.textContent || '').trim();
      const isTextLeaf = el.children.length === 0 && txt.length > 0;
      // 混合文本块：子元素全是 inline（br/span），且自身直接挂着文本节点
      // 典型：<Title>很多年后，<br/>我打开了一台<br/><span>旧电脑</span></Title>
      let allInline = el.children.length > 0;
      if (allInline) {
        for (let ci = 0; ci < el.children.length; ci++) {
          if (!INLINE[el.children[ci].tagName]) { allInline = false; break; }
        }
      }
      let directText = false;
      for (let ni = 0; ni < el.childNodes.length; ni++) {
        const nd = el.childNodes[ni];
        if (nd.nodeType === 3 && (nd.textContent || '').trim().length > 0) { directText = true; break; }
      }
      const isRichText = !isTextLeaf && allInline && directText;
      const svgOwn = tag === 'svg';

      const base = {
        path: cssPath(el),
        seq: seq++,
        tag: tag,
        x: Math.round((r.x - R.x) * 100) / 100,
        y: Math.round((r.y - R.y) * 100) / 100,
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
        opacity: Math.round(op * 1000) / 1000,
      };
      const mx = parseMatrix(cs.transform);
      if (mx && (Math.abs(mx.rot) > 0.05 || Math.abs(mx.sx - 1) > 0.01)) {
        base.rot = mx.rot; base.sx = mx.sx; base.sy = mx.sy;
        base.boxW = el.offsetWidth; base.boxH = el.offsetHeight;
      }

      if (isTextLeaf) {
        if (hasBg || hasGrad || hasBorder) {
          out.push(Object.assign({}, base, {
            path: base.path + '>bg', seq: seq++,
            kind: 'rect',
            fill: hasBg ? {rgb: [bg.r, bg.g, bg.b], a: Math.round(bg.a * 1000) / 1000} : null,
            radius: Math.max.apply(null, rad),
            stroke: hasBorder ? {rgb: [bc.r, bc.g, bc.b], a: Math.round(bc.a * 1000) / 1000, w: bw} : null,
            gradient: hasGrad ? cs.backgroundImage : null,
            shadow: cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : null,
          }));
        }
        const tr1 = textRangeRect(el);
        out.push(Object.assign({}, base, {
          seq: seq++,
          x: Math.round((tr1.x - R.x) * 100) / 100,
          y: Math.round((tr1.y - R.y) * 100) / 100,
          w: Math.round(tr1.width * 100) / 100,
          h: Math.round(tr1.height * 100) / 100,
          kind: 'text',
          text: txt,
          fontSize: parseFloat(cs.fontSize),
          fontFamily: cs.fontFamily,
          fontWeight: cs.fontWeight,
          color: cs.color,
          lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
          letterSpacing: cs.letterSpacing === 'normal' ? null : parseFloat(cs.letterSpacing),
          textAlign: cs.textAlign,
          shadow: cs.textShadow && cs.textShadow !== 'none' ? cs.textShadow : null,
        }));
        return;
      }

      if (isRichText) {
        // 先把"绝对定位的后代"（高亮条、角标、下划色块）单独建层，再叠一整块文本
        const absList = el.querySelectorAll('*');
        for (let si = 0; si < absList.length; si++) {
          const c = absList[si];
          const ccs = getComputedStyle(c);
          if (ccs.position !== 'absolute' && ccs.position !== 'fixed') continue;
          const cbg = parseColor(ccs.backgroundColor);
          if (!cbg || cbg.a <= 0.01) continue;
          const cr = c.getBoundingClientRect();
          if (cr.width < 2 || cr.height < 2) continue;
          const crad = radii(ccs);
          const cop = parseFloat(ccs.opacity);
          out.push({
            path: base.path + '>sb' + si, seq: seq++,
            kind: 'rect',
            x: Math.round((cr.x - R.x) * 100) / 100,
            y: Math.round((cr.y - R.y) * 100) / 100,
            w: Math.round(cr.width * 100) / 100,
            h: Math.round(cr.height * 100) / 100,
            opacity: Math.round(op * (isNaN(cop) ? 1 : cop) * 1000) / 1000,
            fill: {rgb: [cbg.r, cbg.g, cbg.b], a: Math.round(cbg.a * 1000) / 1000},
            radius: Math.max.apply(null, crad),
            stroke: null,
            gradient: null,
            shadow: null,
          });
        }
        const rt = extractText(el);
        if (rt) {
          const trr = textRangeRect(el);
          out.push(Object.assign({}, base, {
            seq: seq++,
            x: Math.round((trr.x - R.x) * 100) / 100,
            y: Math.round((trr.y - R.y) * 100) / 100,
            w: Math.round(trr.width * 100) / 100,
            h: Math.round(trr.height * 100) / 100,
            kind: 'text',
            text: rt,
            fontSize: parseFloat(cs.fontSize),
            fontFamily: cs.fontFamily,
            fontWeight: cs.fontWeight,
            color: cs.color,
            lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
            letterSpacing: cs.letterSpacing === 'normal' ? null : parseFloat(cs.letterSpacing),
            textAlign: cs.textAlign,
            shadow: cs.textShadow && cs.textShadow !== 'none' ? cs.textShadow : null,
          }));
        }
        return;
      }

      if (svgOwn) {
        const svgEl = el;
        const groups = svgGroups(svgEl, R);
        if (groups.length) out.push(Object.assign(base, {kind: 'svg', groups: groups}));

        const texts = svgEl.querySelectorAll('text');
        for (let i = 0; i < texts.length; i++) {
          const t = texts[i];
          const tr = t.getBoundingClientRect();
          if (tr.width < 1 || tr.height < 1) continue;
          const tcs = getComputedStyle(t);
          const tc = parseColor(tcs.fill);
          if (!tc) continue;
          out.push(Object.assign({}, base, {
            path: base.path + '>t' + i,
            seq: seq++,
            kind: 'text',
            x: Math.round((tr.x - R.x) * 100) / 100,
            y: Math.round((tr.y - R.y) * 100) / 100,
            w: Math.round(tr.width * 100) / 100,
            h: Math.round(tr.height * 100) / 100,
            text: (t.textContent || '').trim(),
            fontSize: parseFloat(tcs.fontSize) || 14,
            fontFamily: tcs.fontFamily,
            fontWeight: tcs.fontWeight,
            color: 'rgb(' + tc.r + ',' + tc.g + ',' + tc.b + ')',
            lineHeight: null,
            letterSpacing: null,
            textAlign: 'center',
            shadow: null,
          }));
        }
        return;
      }

      const shapeRec = {
        kind: 'rect',
        fill: hasBg ? {rgb: [bg.r, bg.g, bg.b], a: Math.round(bg.a * 1000) / 1000} : null,
        radius: Math.max.apply(null, rad),
        radii: rad,
        stroke: hasBorder ? {rgb: [bc.r, bc.g, bc.b], a: Math.round(bc.a * 1000) / 1000, w: bw} : null,
        gradient: hasGrad ? cs.backgroundImage : null,
        shadow: cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : null,
        isBackdrop: el.children.length > 0,
      };

      if (el.children.length === 0) {
        if (hasBg || hasBorder || hasGrad) out.push(Object.assign(base, shapeRec));
        return;
      }
      if (hasBg || hasGrad || hasBorder) {
        out.push(Object.assign({}, base, shapeRec, {path: base.path + '>bg', seq: seq++}));
      }
      for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
    }

    walk(root);
    return {frame: frameNo, els: out};
  };
})();
