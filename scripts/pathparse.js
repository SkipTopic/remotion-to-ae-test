// SVG path 解析器 → 三次贝塞尔子路径（供 AE 形状层使用）
// 支持 M/L/H/V/C/S/Q/T/A/Z，绝对与相对命令
(function () {
  const K = 0.5522847498307936;

  function tokenize(d) {
    const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
    const out = [];
    let m;
    while ((m = re.exec(d)) !== null) out.push(m[1] ? m[1] : parseFloat(m[2]));
    return out;
  }

  // 椭圆弧 → 若干三次贝塞尔段
  function arcSegs(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
    if (rx === 0 || ry === 0) return [{ c1: [x1, y1], c2: [x2, y2], p: [x2, y2] }];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (phiDeg * Math.PI) / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    const x1p = cosP * dx2 + sinP * dy2;
    const y1p = -sinP * dx2 + cosP * dy2;
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const sign = largeArc === sweep ? -1 : 1;
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    if (num < 0) num = 0;
    const co = sign * Math.sqrt(num / den || 0);
    const cxp = (co * rx * y1p) / ry;
    const cyp = (-co * ry * x1p) / rx;
    const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy;
      const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
      let a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dth > 0) dth -= 2 * Math.PI;
    if (sweep && dth < 0) dth += 2 * Math.PI;

    const nSeg = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
    const delta = dth / nSeg;
    const t = (4 / 3) * Math.tan(delta / 4);
    const segs = [];
    let th = th1;
    for (let i = 0; i < nSeg; i++) {
      const c1 = Math.cos(th), s1 = Math.sin(th);
      const th2 = th + delta;
      const c2 = Math.cos(th2), s2 = Math.sin(th2);
      const p1 = [cosP * rx * c1 - sinP * ry * s1 + cx, sinP * rx * c1 + cosP * ry * s1 + cy];
      const p2 = [cosP * rx * c2 - sinP * ry * s2 + cx, sinP * rx * c2 + cosP * ry * s2 + cy];
      const d1 = [-rx * s1 * cosP - ry * c1 * sinP, -rx * s1 * sinP + ry * c1 * cosP];
      const d2 = [-rx * s2 * cosP - ry * c2 * sinP, -rx * s2 * sinP + ry * c2 * cosP];
      segs.push({
        c1: [p1[0] + t * d1[0], p1[1] + t * d1[1]],
        c2: [p2[0] - t * d2[0], p2[1] - t * d2[1]],
        p: p2,
      });
      th = th2;
    }
    if (segs.length) segs[segs.length - 1].p = [x2, y2];
    return segs;
  }

  function parseD(d) {
    const tk = tokenize(d);
    const subs = [];
    let s = null;
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let pcx = null, pcy = null, ptype = null;
    let i = 0, cmd = null;

    const startSub = (x, y) => {
      s = { v: [[x, y]], i: [[0, 0]], o: [[0, 0]], c: false };
      subs.push(s);
    };
    const addPt = (x, y) => { s.v.push([x, y]); s.i.push([0, 0]); s.o.push([0, 0]); };
    const addCurve = (c1x, c1y, c2x, c2y, x, y) => {
      const last = s.v.length - 1;
      s.o[last] = [c1x - s.v[last][0], c1y - s.v[last][1]];
      s.v.push([x, y]);
      s.i.push([c2x - x, c2y - y]);
      s.o.push([0, 0]);
    };

    while (i < tk.length) {
      if (typeof tk[i] === 'string') { cmd = tk[i]; i++; }
      if (cmd === 'Z' || cmd === 'z') {
        if (s) s.c = true;
        cx = sx; cy = sy;
        pcx = pcy = null;
        cmd = null;
        continue;
      }
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'M') {
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        startSub(x, y);
        cx = sx = x; cy = sy = y;
        cmd = rel ? 'l' : 'L';
        pcx = pcy = null;
      } else if (C === 'L') {
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        if (!s) startSub(cx, cy);
        addPt(x, y);
        cx = x; cy = y;
        pcx = pcy = null;
      } else if (C === 'H') {
        const x = tk[i++] + (rel ? cx : 0);
        if (!s) startSub(cx, cy);
        addPt(x, cy);
        cx = x;
        pcx = pcy = null;
      } else if (C === 'V') {
        const y = tk[i++] + (rel ? cy : 0);
        if (!s) startSub(cx, cy);
        addPt(cx, y);
        cy = y;
        pcx = pcy = null;
      } else if (C === 'C') {
        const x1 = tk[i++] + (rel ? cx : 0), y1 = tk[i++] + (rel ? cy : 0);
        const x2 = tk[i++] + (rel ? cx : 0), y2 = tk[i++] + (rel ? cy : 0);
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        if (!s) startSub(cx, cy);
        addCurve(x1, y1, x2, y2, x, y);
        pcx = x2; pcy = y2; ptype = 'C';
        cx = x; cy = y;
      } else if (C === 'S') {
        const x2 = tk[i++] + (rel ? cx : 0), y2 = tk[i++] + (rel ? cy : 0);
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        const x1 = ptype === 'C' || ptype === 'S' ? 2 * cx - pcx : cx;
        const y1 = ptype === 'C' || ptype === 'S' ? 2 * cy - pcy : cy;
        if (!s) startSub(cx, cy);
        addCurve(x1, y1, x2, y2, x, y);
        pcx = x2; pcy = y2; ptype = 'S';
        cx = x; cy = y;
      } else if (C === 'Q') {
        const qx = tk[i++] + (rel ? cx : 0), qy = tk[i++] + (rel ? cy : 0);
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        if (!s) startSub(cx, cy);
        addCurve(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        pcx = qx; pcy = qy; ptype = 'Q';
        cx = x; cy = y;
      } else if (C === 'T') {
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        const qx = ptype === 'Q' || ptype === 'T' ? 2 * cx - pcx : cx;
        const qy = ptype === 'Q' || ptype === 'T' ? 2 * cy - pcy : cy;
        if (!s) startSub(cx, cy);
        addCurve(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        pcx = qx; pcy = qy; ptype = 'T';
        cx = x; cy = y;
      } else if (C === 'A') {
        const rx = tk[i++], ry = tk[i++], rot = tk[i++], la = tk[i++], sw = tk[i++];
        const x = tk[i++] + (rel ? cx : 0), y = tk[i++] + (rel ? cy : 0);
        if (!s) startSub(cx, cy);
        const segs = arcSegs(cx, cy, rx, ry, rot, la, sw, x, y);
        for (const sg of segs) addCurve(sg.c1[0], sg.c1[1], sg.c2[0], sg.c2[1], sg.p[0], sg.p[1]);
        cx = x; cy = y;
        pcx = pcy = null;
      } else {
        i++;
      }
    }

    for (const sp of subs) {
      if (sp.c && sp.v.length > 1) {
        const f = sp.v[0], l = sp.v[sp.v.length - 1];
        if (Math.abs(f[0] - l[0]) < 0.02 && Math.abs(f[1] - l[1]) < 0.02) {
          sp.i[0] = sp.i[sp.i.length - 1];
          sp.v.pop(); sp.i.pop(); sp.o.pop();
        }
      }
    }
    return subs.filter((x) => x.v.length >= 2);
  }

  window.__parseD = parseD;
  window.__arcSegs = arcSegs;
})();
