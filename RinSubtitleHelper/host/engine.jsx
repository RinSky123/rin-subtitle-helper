/* ==================================================================
 *  Rin字幕效果助手 — After Effects 字幕动画引擎 (ExtendScript)
 *  作者：RinSky123 · 个人原创，完全免费使用，无授权、无联网、无加密。
 *  运行环境：After Effects 2022+ / ExtendScript (ES3)
 *
 *  面板通过 csInterface.evalScript("PF_xxx(" + JSON.stringify(o) + ")") 调用。
 *  JSON 是 ES3 对象字面量的子集，因此宿主端直接得到真实对象，无需解析。
 *
 *  实现要点：全部功能基于 AE 原生对象——
 *    · 文字动画 = Text Animator + Range Selector(Percent Start/End)
 *    · 波浪     = ADBE Wave Warp 效果
 *    · 发光     = ADBE Glo2 (自带 Glow) 效果
 * ================================================================== */

/* ----------------------------- 通用工具 ----------------------------- */

function pf_log(msg) {
  try { $.writeln("[Rin字幕效果助手] " + msg); } catch (e) {}
}

function pf_trim(s) {
  return String(s).replace(/^\s+|\s+$/g, "");
}

function pf_activeComp() {
  var c = app.project.activeItem;
  if (c && c instanceof CompItem) return c;
  return null;
}

/** 依次尝试多个 matchName / 属性名，返回第一个可用的属性 */
function pf_addProp(group, names) {
  for (var i = 0; i < names.length; i++) {
    try {
      var p = group.addProperty(names[i]);
      if (p) return p;
    } catch (e) {}
  }
  return null;
}

/** 给已存在的属性设置值：按名字或索引逐个尝试 */
function pf_setProp(holder, candidates, value) {
  for (var i = 0; i < candidates.length; i++) {
    try {
      var p = holder.property(candidates[i]);
      if (p) { p.setValue(value); return true; }
    } catch (e) {}
  }
  return false;
}

/**
 * 递归查找属性（含子组）。
 * 关键：Range Selector 的 Based On / Units / Shape 是嵌在 "ADBE Text Range Advanced"
 * 子组里的，直接 property() 找不到，必须递归。
 */
function pf_deepProp(group, matchName, depth) {
  if (!group || depth > 4) return null;
  try { var p = group.property(matchName); if (p) return p; } catch (e) {}
  var n = 0;
  try { n = group.numProperties; } catch (e2) { return null; }
  for (var i = 1; i <= n; i++) {
    var c = group.property(i);
    var kids = 0;
    try { kids = c.numProperties; } catch (e3) { kids = 0; }
    if (kids > 0) {
      var r = pf_deepProp(c, matchName, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** 把关键帧改为平滑贝塞尔缓动 */
function pf_ease(prop, easeIn, easeOut) {
  try {
    var n = prop.numKeys;
    var ei = new KeyframeEase(0, (easeIn === undefined ? 33 : easeIn));
    var eo = new KeyframeEase(0, (easeOut === undefined ? 66 : easeOut));
    for (var i = 1; i <= n; i++) {
      try { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e1) {}
      try { prop.setTemporalEaseAtKey(i, [ei], [eo]); } catch (e2) {}
    }
  } catch (e) {}
}

/** "#RRGGBB" -> [r,g,b] (0..1) */
function pf_hex2rgb(hex) {
  var h = String(hex || "#ffffff").replace("#", "");
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  h = ("000000" + h).slice(-6);
  var r = parseInt(h.substr(0, 2), 16) / 255;
  var g = parseInt(h.substr(2, 2), 16) / 255;
  var b = parseInt(h.substr(4, 2), 16) / 255;
  return [isNaN(r) ? 1 : r, isNaN(g) ? 1 : g, isNaN(b) ? 1 : b];
}

/* ----------------------------- SRT 解析 ----------------------------- */

function pf_parseSRT(txt) {
  txt = String(txt).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  txt = txt.replace(new RegExp(String.fromCharCode(0xFEFF), "g"), ""); // 去 BOM
  var blocks = txt.split(/\n{2,}/);
  var cues = [];
  for (var i = 0; i < blocks.length; i++) {
    var block = pf_trim(blocks[i]);
    if (!block) continue;
    var lines = block.split("\n");
    var li = /^\d+$/.test(pf_trim(lines[0])) ? 1 : 0;
    if (li >= lines.length) continue;
    var m = String(lines[li]).match(
      /(\d+):(\d+):(\d+)[,.](\d+)\s*-+>\s*(\d+):(\d+):(\d+)[,.](\d+)/
    );
    if (!m) continue;
    var start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    var end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    var text = pf_trim(lines.slice(li + 1).join("\n"));
    if (end <= start) end = start + 1;
    if (text) cues.push({ start: start, end: end, text: text });
  }
  return cues;
}

function pf_readSRT(path) {
  var f = new File(path);
  if (!f.exists) return null;
  var txt = "";
  try {
    f.encoding = "UTF-8";
    f.open("r");
    txt = f.read();
    f.close();
  } catch (e) { return null; }
  return txt;
}

/* --------------------------- 智能分行 / 换行 --------------------------- */

/** 按最大字数 base 折行；西文尽量在空格处断开，中文直接按字断 */
function pf_wrapLine(line, base) {
  if (!base || base < 2 || line.length <= base) return line;
  var out = [];
  var rest = line;
  while (rest.length > base) {
    var cut = base;
    // 在 base 附近(往回最多 6 字)找一个空格作为断点
    var sp = -1;
    for (var k = base; k > Math.max(0, base - 6); k--) {
      if (rest.charAt(k) === " ") { sp = k; break; }
    }
    if (sp > 0) cut = sp;
    out.push(pf_trim(rest.substring(0, cut)));
    rest = pf_trim(rest.substring(cut));
  }
  if (rest.length) out.push(rest);
  return out.join("\n");
}

function pf_applyLineBreak(text, base) {
  if (!base || base <= 0) return text;
  var parts = String(text).split("\n");
  var out = [];
  for (var i = 0; i < parts.length; i++) out.push(pf_wrapLine(parts[i], base));
  return out.join("\r");
}

/* ----------------------------- 图层创建 ----------------------------- */

function pf_isTextLayer(layer) {
  try { return layer instanceof TextLayer; } catch (e) { return false; }
}

function pf_getTextDocProp(layer) {
  return layer.property("ADBE Text Properties").property("ADBE Text Document");
}

function pf_setSourceText(layer, text, opts, fontName) {
  var st = pf_getTextDocProp(layer);
  var td = st.value;
  if (fontName) { try { td.font = fontName; } catch (e0) {} }  // 先设字体，再设字号，避免被重置
  td.text = text;
  td.applyFill = true;
  if (opts && opts.fontSize) td.fontSize = opts.fontSize;
  td.fillColor = pf_hex2rgb(opts && opts.textColor ? opts.textColor : "#ffffff");
  try {
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
  } catch (e) {}
  st.setValue(td);
}

function pf_addTextLayer(comp, text, inSec, outSec, opts, fontName) {
  var layer = comp.layers.addText(text);
  layer.name = (opts && opts.layerName) ? opts.layerName : "PF_字幕";
  try { layer.startTime = 0; } catch (e) {}
  pf_setSourceText(layer, text, opts, fontName);
  if (inSec !== null && inSec !== undefined && outSec !== null && outSec !== undefined) {
    try { layer.inPoint = inSec; layer.outPoint = outSec; } catch (e) {}
  }
  return layer;
}

/* 突出字幕的方式：发光之后自动补一层投影（Drop Shadow，见 pf_autoShadow），不再用黑底/黑发光 */

/** 取出要处理的文字图层：选了"选中项"就用选中，否则全部文字图层 */
function pf_targetLayers(comp, useSelection) {
  var out = [];
  if (useSelection) {
    var sel = comp.selectedLayers;
    for (var i = 0; i < sel.length; i++) if (pf_isTextLayer(sel[i])) out.push(sel[i]);
  }
  if (out.length === 0) {
    for (var j = 1; j <= comp.numLayers; j++) {
      var L = comp.layer(j);
      if (pf_isTextLayer(L)) out.push(L);
    }
  }
  return out;
}

/* ----------------------------- 预合成 ----------------------------- */

/** 收集某个合成里的全部文字图层 */
function pf_collectTextLayers(comp) {
  var out = [];
  if (!comp) return out;
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (pf_isTextLayer(L)) out.push(L);
  }
  return out;
}

/** 找出预合成返回的对象（不同 AE 版本 precompose 的返回值不一致，做多重兜底） */
function pf_resolvePrecomp(comp, res, name) {
  try { if (res && res instanceof CompItem) return res; } catch (e0) {}
  try { var L = comp.layer(name); if (L && L.source) return L.source; } catch (e1) {}
  for (var i = app.project.numItems; i >= 1; i--) {
    var it = app.project.item(i);
    if (it instanceof CompItem && it.name === name) return it;
  }
  return null;
}

/**
 * 把指定的图层预合成到一个新合成里，并返回新合成。
 * moveAllAttributes=true 会把关键帧/效果一并带走。
 */
function pf_precomposeBatch(comp, layers, name) {
  if (!layers || !layers.length) return null;
  var idx = [];
  for (var i = 0; i < layers.length; i++) {
    try { idx.push(layers[i].index); } catch (e) {}
  }
  if (!idx.length) return null;
  var res = null;
  try { res = comp.layers.precompose(idx, name, true); } catch (e2) { return null; }
  return pf_resolvePrecomp(comp, res, name);
}

/* --------------------------- 文字动画核心 --------------------------- */

/**
 * 新建一个 Text Animator + Range Selector
 * basedOn: 1=字符, 3=词  (对应 AE 的 Range Type2)
 */
/**
 * 在一个组里用「试加一个属性」的方式找出真正的容器组。
 * 因为不同 AE 版本 / 语言下这些组的 matchName 不一定能直接取到，
 * 试加成功即可确认它就是我们要的那个组（试完立刻删掉）。
 */
function pf_findGroupByAdd(parent, probeName) {
  for (var i = 1; i <= parent.numProperties; i++) {
    var c = parent.property(i);
    var n = 0;
    try { n = c.numProperties; } catch (e) { continue; }
    if (!n) continue;
    try {
      var t = c.addProperty(probeName);
      if (t) { try { t.remove(); } catch (e2) {} return c; }
    } catch (e3) {}
  }
  return null;
}

function pf_addAnimator(layer, basedOn) {
  var tg = layer.property("ADBE Text Properties");

  // 动画器组：按 matchName 取不到就试加
  var anims = null;
  try { anims = tg.property("ADBE Text Animators"); } catch (e00) { anims = null; }
  if (!anims) anims = pf_findGroupByAdd(tg, "ADBE Text Animator");
  if (!anims) return { animator: null, props: null, sel: null };

  var anim = null;
  try { anim = anims.addProperty("ADBE Text Animator"); } catch (e01) { anim = null; }
  if (!anim) return { animator: null, props: null, sel: null };

  // 属性组：先按 matchName 取，取不到就用「试加 ADBE Text Opacity」的方式找
  var props = null;
  try { props = anim.property("ADBE Text Animator Properties"); } catch (e0) { props = null; }
  if (!props) props = pf_findGroupByAdd(anim, "ADBE Text Opacity");

  // 选择器组：同理
  var sels = null;
  try { sels = anim.property("ADBE Text Selectors"); } catch (e1) { sels = null; }
  if (!sels) sels = pf_findGroupByAdd(anim, "ADBE Text Selector");
  var sel = null;
  if (sels) { try { sel = sels.addProperty("ADBE Text Selector"); } catch (e2) { sel = null; } }

  if (sel) {
    // Based On / Units / Shape 在 "ADBE Text Range Advanced" 子组内，必须递归查找
    var pType = pf_deepProp(sel, "ADBE Text Range Type2", 0);
    if (pType) { try { pType.setValue(basedOn); } catch (e3) {} }   // 1=字符 3=词
    var pUnit = pf_deepProp(sel, "ADBE Text Range Units", 0);
    if (pUnit) { try { pUnit.setValue(1); } catch (e4) {} }          // 1=百分比
    var pShape = pf_deepProp(sel, "ADBE Text Range Shape", 0);
    if (pShape) { try { pShape.setValue(1); } catch (e5) {} }        // 1=方形
  }

  return { animator: anim, props: props, sel: sel };
}

/** 诊断：选中图层上的投影参数实际是多少（用来确认自动投影写没写进去） */
function PF_shadowDebug() {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var L = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    var c = comp.layer(i);
    if (pf_isTextLayer(c)) { L = c; break; }
  }
  if (!L) return "ERR|合成里没有文字图层";

  var out = [], found = false;
  try {
    for (var k = 1; k <= L.Effects.numProperties; k++) {
      var e = L.Effects.property(k);
      var mn = "";
      try { mn = String(e.matchName); } catch (e0) {}
      if (mn !== "ADBE Drop Shadow") continue;
      found = true;
      out.push("效果#" + k);
      for (var j = 1; j <= e.numProperties; j++) {
        var p = e.property(j);
        var v = "";
        try {
          var raw = p.value;
          v = (typeof raw === "number") ? String(Math.round(raw * 100) / 100)
                                        : (raw && raw.length ? "[" + raw.join(",") + "]" : String(raw));
        } catch (e1) { v = "?"; }
        out.push(p.name + "=" + v);
      }
      break;
    }
  } catch (e2) { return "ERR|读取失败：" + e2.toString(); }

  if (!found) return "ERR|这个图层上没有投影效果（先点一键生成效果）";
  return "OK|" + out.join(" / ");
}

/** 诊断：文字动画器到底建没建起来 */
function PF_animDebug() {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var L = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    if (pf_isTextLayer(comp.layer(i))) { L = comp.layer(i); break; }
  }
  if (!L) return "ERR|合成里没有文字图层";
  var out = [];
  try {
    var tg = L.property("ADBE Text Properties");
    out.push("Text组:" + (tg ? "有" : "无"));
    var anims = tg.property("ADBE Text Animators");
    out.push("Animators组:" + (anims ? "有" : "无"));
    var anim = anims.addProperty("ADBE Text Animator");
    out.push("Animator:" + (anim ? "已加" : "加不上"));
    var props = null;
    try { props = anim.property("ADBE Text Animator Properties"); } catch (e1) { props = null; }
    out.push("Properties(matchName):" + (props ? "有" : "无"));
    if (!props) props = pf_findGroupByAdd(anim, "ADBE Text Opacity");
    out.push("Properties(试加):" + (props ? "找到" : "没找到"));
    if (props) {
      var op = pf_addProp(props, ["ADBE Text Opacity"]);
      out.push("Opacity属性:" + (op ? "已加" : "加不上"));
    }
    var sels = null;
    try { sels = anim.property("ADBE Text Selectors"); } catch (e2) { sels = null; }
    out.push("Selectors组:" + (sels ? "有" : "无"));
    if (!sels) sels = pf_findGroupByAdd(anim, "ADBE Text Selector");
    if (sels) {
      var sel = sels.addProperty("ADBE Text Selector");
      out.push("Selector:" + (sel ? "已加" : "加不上"));
      if (sel) {
        var s1 = pf_selProp(sel, "ADBE Text Percent Start");
        out.push("PercentStart:" + (s1 ? "有" : "无"));
        var t2 = pf_deepProp(sel, "ADBE Text Range Type2", 0);
        out.push("BasedOn:" + (t2 ? "有" : "无"));
      }
    }
    try { anim.remove(); } catch (e3) {}
  } catch (e4) { out.push("异常:" + e4.toString()); }
  return "OK|" + out.join(" / ");
}

/** 取选择器上的 Start / End 属性（同样走递归兜底） */
function pf_selProp(sel, matchName) {
  return pf_deepProp(sel, matchName, 0);
}

/* ---------------- 出入场时长：按"词量"自适应 ---------------- */

/** 读出图层文字（读不到就返回空串） */
function pf_layerText(layer) {
  try { return String(pf_getTextDocProp(layer).value.text); } catch (e) { return ""; }
}

/**
 * 估一条字幕有多少个"词"：
 * 西文按空格/标点分词；中日韩按字算（中文一个字差不多顶西文一个词的视觉量）。
 */
function pf_wordCount(layer) {
  var t = pf_layerText(layer);
  if (!t) return 99;
  var cjk = t.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g);
  var nCjk = cjk ? cjk.length : 0;
  var latin = t.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g, " ");
  var parts = latin.split(/[^0-9A-Za-zÀ-ɏ']+/);
  var nLatin = 0;
  for (var i = 0; i < parts.length; i++) { if (pf_trim(parts[i])) nLatin++; }
  return nCjk + nLatin;
}

/**
 * 出入场时长自适应：
 *   4 个词以上 → 完全按面板设的秒数（长句本来就该慢）
 *   3 个词     → ×0.78
 *   2 个词     → ×0.62
 *   1 个词     → ×0.48
 * 短字幕停留时间本来就短，用同样长的动画会被"掐断"（出场还没走完图层就没了），
 * 所以按词量缩短；最后再兜一层：任何情况下都不超过图层时长的 42%，
 * 保证入场和出场都能完整走完、中间还留得住。
 */
function pf_scaleByWords(layer, baseSeconds) {
  var n = pf_wordCount(layer);
  var k = 1;
  if (n <= 1) k = 0.48;
  else if (n === 2) k = 0.62;
  else if (n === 3) k = 0.78;

  var d = baseSeconds * k;
  var dur = layer.outPoint - layer.inPoint;
  var cap = dur * 0.42;
  if (d > cap) d = cap;
  if (d < 0.07) d = Math.min(0.07, dur);
  return d;
}

/** 入场：动画 Start 0->100（字符从前往后出现） */
function pf_entryOnLayer(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;
  var dur = outP - inP;
  var base;
  if (opts.entrySeconds !== undefined && opts.entrySeconds !== null && opts.entrySeconds > 0) {
    base = opts.entrySeconds;                                // 绝对秒数（视频同款走这里）
  } else {
    base = dur * (opts.entryDuration === undefined ? 50 : opts.entryDuration) / 100;
  }
  if (base <= 0) base = Math.min(0.3, dur);
  var d = pf_scaleByWords(layer, base);                       // 短句自动加快

  if (opts.entryBasedOn === "sentence") {
    var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
    op.setValueAtTime(inP, 0);
    op.setValueAtTime(inP + d, 100);
    pf_ease(op);
    if (opts.entryMoveY) {
      var pos = layer.property("ADBE Transform Group").property("ADBE Position");
      var base = pos.value;              // 可能是 2D 或 3D，元素个数不定
      var from = base.slice();
      from[1] = base[1] + opts.entryMoveY;
      pos.setValueAtTime(inP, from);
      pos.setValueAtTime(inP + d, base.slice());
      pf_ease(pos);
    }
    return;
  }

  var a = pf_addAnimator(layer, opts.entryBasedOn === "word" ? 3 : 1);
  var opacity = pf_addProp(a.props, ["ADBE Text Opacity"]);
  if (opacity) opacity.setValue(0);
  if (opts.entryMoveY && a.props) {
    var p = pf_addProp(a.props, ["ADBE Text Position 3D", "ADBE Text Position"]);
    if (p) p.setValue([0, opts.entryMoveY, 0]);
  }
  var s = pf_selProp(a.sel, "ADBE Text Percent Start");
  if (s) { s.setValueAtTime(inP, 0); s.setValueAtTime(inP + d, 100); pf_ease(s); }

  // 兜底：动画器没建起来时，务必把动画器删掉 —— 没有选择器的动画器会选中全部字符，
  // 那样 opacity=0 会让整句字幕一直不可见。改为整层淡入，至少不是"啪"一下出现。
  if (!opacity || !s) {
    if (a && a.animator) { try { a.animator.remove(); } catch (e6) {} }
    pf_sentenceFade(layer, inP, inP + d, 0, 100, opts.entryMoveY);
  }
}

/** 整层淡入/淡出（兜底用） */
function pf_sentenceFade(layer, t0, t1, fromV, toV, moveY) {
  try {
    var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
    op.setValueAtTime(t0, fromV);
    op.setValueAtTime(t1, toV);
    pf_ease(op);
    if (moveY) {
      var pos = layer.property("ADBE Transform Group").property("ADBE Position");
      var base = pos.value, a = base.slice(), b = base.slice();
      a[1] = base[1] + (fromV === 0 ? moveY : 0);
      b[1] = base[1] + (fromV === 0 ? 0 : moveY);
      pos.setValueAtTime(t0, a);
      pos.setValueAtTime(t1, b);
      pf_ease(pos);
    }
  } catch (e) {}
}

/** 出场：动画 End 0->100（字符从前往后消失） */
function pf_exitOnLayer(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;
  var dur = outP - inP;
  var base;
  if (opts.exitSeconds !== undefined && opts.exitSeconds !== null && opts.exitSeconds > 0) {
    base = opts.exitSeconds;                                 // 绝对秒数（视频同款走这里）
  } else {
    base = dur * (opts.exitDuration === undefined ? 70 : opts.exitDuration) / 100;
  }
  if (base <= 0) base = Math.min(0.3, dur);
  var d = pf_scaleByWords(layer, base);                       // 短句自动加快

  if (opts.exitBasedOn === "sentence") {
    var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
    op.setValueAtTime(outP - d, 100);
    op.setValueAtTime(outP, 0);
    pf_ease(op);
    return;
  }

  var a = pf_addAnimator(layer, opts.exitBasedOn === "word" ? 3 : 1);
  var opacity = pf_addProp(a.props, ["ADBE Text Opacity"]);
  if (opacity) opacity.setValue(0);
  if (opts.exitMoveY && a.props) {
    var p = pf_addProp(a.props, ["ADBE Text Position 3D", "ADBE Text Position"]);
    if (p) p.setValue([0, opts.exitMoveY, 0]);
  }
  var e = pf_selProp(a.sel, "ADBE Text Percent End");
  if (e) { e.setValueAtTime(outP - d, 0); e.setValueAtTime(outP, 100); pf_ease(e); }

  // 同理：没选择器的话动画器会选中全部字符 → 整句提前消失，直接删掉
  if (!opacity || !e) { if (a && a.animator) { try { a.animator.remove(); } catch (e7) {} } }

  // 渐隐：整层在出场期间一起淡出，给下一条让路
  var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
  if (op) { op.setValueAtTime(outP - d, 100); op.setValueAtTime(outP, 0); pf_ease(op); }
}

/* ---------------------- 持续放大 + 黑底动画 ---------------------- */

/** 从出现到消失，整层缓缓放大（隐隐放大，增加动态感） */
function pf_applyScale(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;
  if (outP <= inP) return;
  var g = (opts.growAmount === undefined) ? 5 : opts.growAmount;
  if (g === 0) return;
  var sc = layer.property("ADBE Transform Group").property("ADBE Scale");
  var v = sc.value;
  var base = [], end = [];
  for (var i = 0; i < v.length; i++) {
    base.push(v[i]);
    end.push(v[i] * (1 + g / 100));
  }
  try {
    sc.setValueAtTime(inP, base);
    sc.setValueAtTime(outP, end);
  } catch (e) {}
}

/** 字符间距 / 词间距（Tracking Amount） */
function pf_trackingOnLayer(layer, opts) {
  if (!opts.spacing) return;
  var a = pf_addAnimator(layer, opts.spacingBasedOn === "word" ? 3 : 1);
  var t = pf_addProp(a.props, ["ADBE Text Tracking Amount"]);
  if (t) t.setValue(opts.spacing / 10);
}

/* ------------------------------- 字体 ------------------------------- */

/* ---- 系统字体扫描（纯 ExtendScript，不依赖 Node）---- */

function pf_u8(s, i) { return s.charCodeAt(i) & 0xFF; }
function pf_u16(s, i) { return (pf_u8(s, i) << 8) | pf_u8(s, i + 1); }
function pf_u32(s, i) {
  return pf_u8(s, i) * 0x1000000 + (pf_u8(s, i + 1) << 16) + (pf_u8(s, i + 2) << 8) + pf_u8(s, i + 3);
}
function pf_utf16be(s, start, len) {
  var r = "";
  for (var i = 0; i + 1 < len; i += 2) {
    var c = (pf_u8(s, start + i) << 8) | pf_u8(s, start + i + 1);
    if (c) r += String.fromCharCode(c);
  }
  return r;
}

/** 读取某个字体(相对文件偏移 fontOffset 的 offset table)的 name 表，抽取 PostScript/显示名 */
function pf_readNamesAt(f, fontOffset) {
  f.seek(fontOffset);
  var hdr = f.read(12);
  if (hdr.length < 12) return null;
  var numTables = pf_u16(hdr, 4);
  if (numTables < 1 || numTables > 1024) return null;

  var dir = f.read(numTables * 16);
  var nameOff = -1, nameLen = 0;
  for (var i = 0; i < numTables; i++) {
    var rec = i * 16;
    if (dir.substr(rec, 4) === "name") {
      nameOff = pf_u32(dir, rec + 8);
      nameLen = pf_u32(dir, rec + 12);
      break;
    }
  }
  if (nameOff <= 0 || nameLen <= 0 || nameLen > 65536) return null;

  f.seek(nameOff);
  var nt = f.read(nameLen);
  if (nt.length < 6) return null;

  var count = pf_u16(nt, 2);
  var strBase = pf_u16(nt, 4);
  var res = { ps: "", family: "", full: "" };
  var best = { ps: -1, family: -1, full: -1 };

  for (var j = 0; j < count; j++) {
    var r = 6 + j * 12;
    if (r + 12 > nt.length) break;
    var platformID = pf_u16(nt, r);
    var encodingID = pf_u16(nt, r + 2);
    var languageID = pf_u16(nt, r + 4);
    var nameID = pf_u16(nt, r + 6);
    var length = pf_u16(nt, r + 8);
    var offset = pf_u16(nt, r + 10);

    if (nameID !== 1 && nameID !== 4 && nameID !== 6) continue;

    var start = strBase + offset;
    if (start + length > nt.length) continue;

    var text = (platformID === 3 || platformID === 0)
      ? pf_utf16be(nt, start, length)
      : nt.substring(start, start + length);
    if (!text) continue;

    var w = 0;
    if (platformID === 3) w += 4;
    if (languageID === 0x409) w += 2;
    if (encodingID === 1) w += 1;

    var key = (nameID === 1) ? "family" : (nameID === 4 ? "full" : "ps");
    if (w > best[key]) { best[key] = w; res[key] = text; }
  }
  if (!res.ps && !res.family && !res.full) return null;
  return res;
}

/** 解析单个字体文件(TTF/OTF/TTC)，把结果塞进 out 表(按 PostScript 名去重) */
function pf_scanFontFile(path, out, seen) {
  var f = new File(path);
  if (!f.exists) return;
  try { f.encoding = "BINARY"; } catch (e) {}
  if (!f.open("r")) return;
  try {
    var head = f.read(12);
    if (head.length >= 12 && head.substr(0, 4) === "ttcf") {
      var num = pf_u32(head, 8);
      if (num > 0 && num <= 128) {
        var offsets = f.read(num * 4);
        for (var i = 0; i < num; i++) {
          var off = pf_u32(offsets, i * 4);
          pf_pushFont(pf_readNamesAt(f, off), out, seen);
        }
      }
    } else {
      pf_pushFont(pf_readNamesAt(f, 0), out, seen);
    }
  } catch (e2) {}
  try { f.close(); } catch (e3) {}
}

function pf_pushFont(n, out, seen) {
  if (!n) return;
  var ps = n.ps || n.full || n.family;
  if (!ps) return;
  if (seen[ps]) return;
  seen[ps] = true;
  out.push(ps + "\t" + (n.family || n.full || ps));
}

/**
 * 扫描系统已安装字体。
 * 返回 "OK|ps1\t显示名1\nps2\t显示名2\n..."，面板端按行解析。
 */
function PF_listFonts() {
  var out = [];
  var seen = {};
  var dirs = [];
  var win = "";
  try { win = $.getenv("WINDIR"); } catch (e0) { win = ""; }
  if (!win) win = "C:\\Windows";
  dirs.push(win + "/Fonts");
  var la = "";
  try { la = $.getenv("LOCALAPPDATA"); } catch (e1) { la = ""; }
  if (la) dirs.push(la + "/Microsoft/Windows/Fonts");

  for (var d = 0; d < dirs.length; d++) {
    var folder = new Folder(dirs[d]);
    if (!folder.exists) continue;
    var files = folder.getFiles();
    for (var i = 0; i < files.length; i++) {
      var it = files[i];
      if (!(it instanceof File)) continue;
      if (!/\.(ttf|otf|ttc|otc)$/i.test(it.name)) continue;
      try { pf_scanFontFile(it.fsName, out, seen); } catch (e) {}
    }
  }
  out.sort();
  if (out.length === 0) return "ERR|没有扫描到字体";
  return "OK|" + out.join("\n");
}

/**
 * 决定第 index 个图层用哪个字体（PostScript 名）
 * fontMode: single=统一字体 / random=随机 / cycle=按顺序循环
 */
function pf_pickFont(opts, index) {
  var mode = opts.fontMode || "single";
  var list = opts.fonts || [];
  if (mode === "random") {
    if (!list.length) return null;
    var pick = pf_randomPick(list, pf_lastFont);
    pf_lastFont = pick;
    return pick;
  }
  if (mode === "cycle") {
    if (!list.length) return null;
    return list[index % list.length];
  }
  var single = opts.fontSingle || "";
  return single.length ? single : null;
}

/** 把字体应用到已有文字图层（整段换成该字体） */
function pf_fontOnLayer(layer, opts, index) {
  var name = pf_pickFont(opts, index);
  if (!name) return;
  var st = pf_getTextDocProp(layer);
  var td = st.value;
  if (!td) return;
  try { td.font = name; } catch (e) {}
  st.setValue(td);
}

/** 对目标文字图层套用 单字体/随机字体/循环字体 */
function PF_fonts(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";
  var mode = o.fontMode || "single";
  if (mode !== "single" && (!o.fonts || !o.fonts.length)) return "ERR|随机字体列表为空";
  pf_lastFont = "";
  for (var i = 0; i < layers.length; i++) pf_fontOnLayer(layers[i], o, i);
  return "OK|已应用" + (mode === "random" ? "随机" : (mode === "cycle" ? "循环" : "统一")) +
         "字体 (" + layers.length + ")";
}

/* ------------------------------- 颜色 ------------------------------- */

/** 发光色「每句随机」用的鲜艳色卡（避免随机出灰扑扑的颜色，发光看不出来） */
var PF_VIVID = ["#ffffff", "#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dffd2",
                "#4dd2ff", "#4d7dff", "#b44dff", "#ff4dd2", "#ff7ac6", "#00e5a0"];

// 洗牌轮转的袋子状态（文字色 / 发光色 各一套）
var pf_bagColor = { bag: [], idx: 0, last: "" };
var pf_bagGlow  = { bag: [], idx: 0, last: "" };

/** 从列表里随机取一个，尽量不与「上一次」相同（避免相邻重复） */
function pf_randomPick(list, last) {
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0];
  var pick = list[Math.floor(Math.random() * list.length)];
  var guard = 0;
  while (pick === last && guard < 30) {
    pick = list[Math.floor(Math.random() * list.length)];
    guard++;
  }
  return pick;
}

/**
 * 上色：以「一条字幕 = 一个颜色」为单位
 * 单色 → 全部同一个色；随机多色 → 每句随机取一个（相邻不重复）
 */
/**
 * 取色：不用纯随机，改用「洗牌轮转」——
 * 每轮把色池打乱后按顺序发，发完再洗一轮。
 * 这样相邻两句绝不会同色，也不会像纯随机的短序列那样撞出三四句一个色；
 * 色池有几色，最多连续几句内一定轮完一圈。
 */
function pf_cyclePick(list, state) {
  if (!list || !list.length) return null;
  if (!state.bag || !state.bag.length || state.idx >= state.bag.length) {
    state.bag = list.slice();
    // Fisher–Yates 洗牌
    for (var i = state.bag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = state.bag[i]; state.bag[i] = state.bag[j]; state.bag[j] = tmp;
    }
    // 新一轮的第一个不能和上一句（= 上一轮最后一个）撞色
    if (state.bag.length > 1 && state.bag[0] === state.last) {
      var k = 1 + Math.floor(Math.random() * (state.bag.length - 1));
      var t2 = state.bag[0]; state.bag[0] = state.bag[k]; state.bag[k] = t2;
    }
    state.idx = 0;
  }
  var v = state.bag[state.idx++];
  state.last = v;
  return v;
}

/** 每一批重新开一轮（否则跨批次会接着上批的位置，容易显得不随机） */
function pf_resetColorBags() {
  pf_bagColor.bag = []; pf_bagColor.idx = 0; pf_bagColor.last = "";
  pf_bagGlow.bag = [];  pf_bagGlow.idx = 0;  pf_bagGlow.last = "";
}

/**
 * 这一条字幕该用哪个颜色 —— 文字色和流光色共用同一个。
 * 单色模式 → 就用面板上选的那个；随机模式 → 洗牌轮转（相邻不重复、短序列内不撞色）
 */
function pf_pickTextColor(opts) {
  if (opts.colorMode !== "random") return opts.singleColor || "#ffffff";
  var colors = (opts.colors && opts.colors.length) ? opts.colors : ["#ffffff"];
  var hex = pf_cyclePick(colors, pf_bagColor);
  if (!hex) hex = "#ffffff";
  pf_lastColor = hex;
  return hex;
}

function pf_colorOnLayer(layer, opts) {
  var hex = pf_pickTextColor(opts);
  pf_setTextFill(layer, hex);
  return hex;
}

/** 直接改文字填充色（不动其它文字属性） */
function pf_setTextFill(layer, hex) {
  var st = pf_getTextDocProp(layer);
  var td = st.value;
  if (!td) return;
  td.applyFill = true;
  td.fillColor = pf_hex2rgb(hex);
  st.setValue(td);
}

/** 递归查找并赋值（找不到就跳过，不报错） */
function pf_setOn(group, matchName, value) {
  var p = pf_deepProp(group, matchName, 0);
  if (p) { try { p.setValue(value); return true; } catch (e) {} }
  return false;
}

/** 把关键帧全改成线性（流光要匀速，不能有缓动） */
function pf_linear(prop) {
  try {
    var n = prop.numKeys;
    for (var i = 1; i <= n; i++) {
      try {
        prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      } catch (e1) {}
    }
  } catch (e) {}
}

/* ------------------------------- 流光 ------------------------------- */

/**
 * 流光：让颜色在文字上像水一样流动。两种模式（mode）：
 *
 *  band（光带）：底色转白，一条【彩色】光带循环扫过 —— 颜色像光一样淌过去
 *  wash（晕染留白）：底色就是【流光色】，动画器刷【白色】，一段柔和的留白滑过
 *                    —— 整句都被晕染了，只有一部分留白（视频里的那种）
 *
 * 手法和原版一致：Text Animator 的「填充色」+ Range Selector 的 Percent Offset 循环。
 * 选择器窗口取一块带宽，Offset 从 0 推到 100 来回滚，窗口就不断往前跑，无缝循环。
 * 形状用 Smooth(6)：S 型平滑衰减 → 颜色一点点渗进去，水彩晕染感。
 *
 * color：这一条字幕的颜色（跟文字颜色同步，随机模式下每条不同）
 */
function pf_flowOnLayer(layer, opts, color, mode) {
  var f = (opts && opts.flow) ? opts.flow : {};
  if (!f.enabled) return false;
  mode = (mode === "wash") ? "wash" : "band";

  var inP = layer.inPoint, outP = layer.outPoint;
  if (outP <= inP) return false;

  var a = pf_addAnimator(layer, 1);                    // 1 = 按字符
  if (!a.animator || !a.props || !a.sel) {
    if (a.animator) { try { a.animator.remove(); } catch (e0) {} }
    return false;
  }

  var fc = pf_addProp(a.props, ["ADBE Text Fill Color"]);
  if (!fc) { try { a.animator.remove(); } catch (e1) {} return false; }
  // 晕染留白：整句已是流光色，动画器负责把"留白"刷上去
  try { fc.setValue(mode === "wash" ? [1, 1, 1] : pf_hex2rgb(color || "#ffffff")); } catch (e2) {}

  // 窗口宽度（占整句 %）。两种模式都开得很大：
  // 带够宽才是一整片扫过整句，而不是几个字一小坨；留白够宽才是"部分留白"而不是细线
  var band = (mode === "wash") ? 50 : 70;
  if (f.band !== undefined && f.band !== null && mode !== "wash") band = f.band;
  if (band < 10) band = 10;
  if (band > 100) band = 100;
  pf_setOn(a.sel, "ADBE Text Percent Start", 0);
  pf_setOn(a.sel, "ADBE Text Percent End", band);

  // 形状：
  //   光带 → **方形(1) + 平滑度**：带内是实色，文字开头那一段也能吃到满色（之前用 Smooth
  //          是钟形，两端权重恒为 0，所以开头永远染不上）；柔化只交给平滑度做边界
  //   晕染留白 → Smooth(6)：整段渐变、两端自然淡出，这才是"晕染"
  var pShape = pf_deepProp(a.sel, "ADBE Text Range Shape", 0);
  if (pShape) {
    if (mode === "wash") {
      try { pShape.setValue(6); }
      catch (e3) { try { pShape.setValue(4); } catch (e3b) {} }
    } else {
      try { pShape.setValue(1); } catch (e3c) {}   // 1 = 方形
      // AE 里「平滑度」只在方形形状下生效：把带的边界做柔，但内部保持实色
      var pSmooth = pf_deepProp(a.sel, "ADBE Text Range Smoothness", 0);
      if (pSmooth) { try { pSmooth.setValue(60); } catch (e3d) {} }
    }
  }

  var off = pf_selProp(a.sel, "ADBE Text Percent Offset");
  if (!off) { try { a.animator.remove(); } catch (e4) {} return false; }

  // 周期：默认 5 秒走完一趟（慢一点，能看出在动就够了，不必急着走完）
  var period = (f.period === undefined || f.period === null || f.period <= 0) ? 5 : f.period;
  if (period < 0.5) period = 0.5;

  try {
    // 主驱动：表达式走的「来回」波（0 → 100 → 0，连续、平滑、永不跳变）。
    // 单程 period 秒，一个完整来回 2*period 秒 —— 长字幕也不会出现"走完突然重来"的突兀感。
    try {
      off.expression =
        "var s = " + inP + ", per = " + period + ";\n" +
        "var t = time - s; if (t < 0) t = 0;\n" +
        "var ph = (t % (2 * per)) / per;\n" +
        "var v = ph <= 1 ? ph : 2 - ph;\n" +
        "v * 100;\n";
    } catch (eExpr) {}

    // 关键帧备用（表达式被关掉时也能动）：用同样的来回节奏采样
    var step = period;
    var t = inP, val = 0, dir = 1, guard = 0;
    off.setValueAtTime(t, 0);
    while (t < outP + 1e-6 && guard < 800) {
      t += step;
      if (t > outP) t = outP;
      val = (val === 0) ? 100 : 0;
      off.setValueAtTime(t, val);
      if (t >= outP) break;
      guard++;
    }
    try {
      var kn = off.numKeys;
      for (var i = 1; i <= kn; i++) {
        off.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      }
    } catch (eK) {}
  } catch (e5) { return false; }
  return true;
}

/* ------------------------------- 波浪 ------------------------------- */

function pf_waveOnLayer(layer, opts) {
  var w = opts.wave || {};
  if (!w.enabled) return;
  var eff = layer.Effects.addProperty("ADBE Wave Warp");
  if (!eff) return;
  // 索引兜底：2=波高 3=波宽 4=波速 (不同语言版本名字不同)
  pf_setProp(eff, ["Wave Height", 2], w.height === undefined ? 4 : w.height);
  pf_setProp(eff, ["Wave Width", 3], w.width === undefined ? 400 : w.width);
  pf_setProp(eff, ["Wave Speed", 4], w.speed === undefined ? 0.4 : w.speed);
  // 固定边缘，避免字幕整体抖动出画
  pf_setProp(eff, ["Pinning", 5], 1); // 1 = All Edges
}

/* ------------------------------- 发光 ------------------------------- */

/** 优先用 Deep Glow 2（matchName = PEDG），没有则退回 AE 自带 Glow */
function pf_addGlowEffect(layer) {
  var candidates = ["PEDG", "Deep Glow 2", "DeepGlow2", "Deep Glow", "DeepGlow"];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var e = layer.Effects.addProperty(candidates[i]);
      if (e) return { eff: e, deep: true };
    } catch (err) {}
  }
  try {
    var g = layer.Effects.addProperty("ADBE Glo2");
    if (g) return { eff: g, deep: false };
  } catch (err2) {}
  return null;
}

/** 按关键字递归扫描效果参数并赋值（适配 Deep Glow 各版本/语言的参数名） */
function pf_configureDeepGlow(group, g, rgb) {
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    var kids = 0;
    try { kids = p.numProperties; } catch (e) { kids = 0; }
    if (kids > 0) { pf_configureDeepGlow(p, g, rgb); continue; }

    var nm = "";
    try { nm = String(p.name).toLowerCase(); } catch (e2) {}
    var isColor = false;
    try { isColor = (p.propertyValueType === PropertyValueType.COLOR); } catch (e3) {}

    try {
      if (nm.indexOf("threshold") >= 0) {
        p.setValue(g.threshold === undefined ? 0 : g.threshold);
      } else if (nm.indexOf("radius") >= 0) {
        p.setValue(g.radius === undefined ? 200 : g.radius);
      } else if (nm.indexOf("exposure") >= 0 || nm.indexOf("intensity") >= 0 ||
                 nm.indexOf("brightness") >= 0 || nm.indexOf("strength") >= 0) {
        p.setValue(g.strength === undefined ? 0.5 : g.strength);
      } else if (isColor && nm.indexOf("color") >= 0) {
        p.setValue(rgb);
      }
    } catch (e4) {}
  }
}

function pf_glowOnLayer(layer, opts) {
  var g = opts.glow || {};
  if (!g.enabled) return;
  var res = pf_addGlowEffect(layer);
  if (!res) return;
  var eff = res.eff;
  var rgb;
  if (g.colorRandom) {                    // 发光色「每句随机」：同样洗牌轮转，短序列内不撞色
    var gpick = pf_cyclePick(PF_VIVID, pf_bagGlow);
    if (!gpick) gpick = "#ffffff";
    pf_lastGlow = gpick;
    rgb = pf_hex2rgb(gpick);
  } else {
    rgb = pf_hex2rgb(g.color || "#ffffff");
  }

  if (res.deep) {
    pf_configureDeepGlow(eff, g, rgb);
    pf_autoShadow(layer);             // 发光之后自动补投影（固定参数）
    return;
  }

  // 退回 AE 自带 Glow
  pf_setProp(eff, ["Glow Threshold", "阈值", 1], g.threshold === undefined ? 0 : g.threshold);
  pf_setProp(eff, ["Glow Radius", "半径", 2], g.radius === undefined ? 200 : g.radius);
  pf_setProp(eff, ["Glow Intensity", "强度", 3], g.strength === undefined ? 0.5 : g.strength);
  if (g.color) {
    pf_setProp(eff, ["Color A", 5], rgb);
    pf_setProp(eff, ["Color B", 6], rgb);
    pf_setProp(eff, ["Glow Colors", 4], 2); // 2 = A & B Colors
  }
  pf_autoShadow(layer);               // 发光之后自动补投影（固定参数）
}

/* ------------------------------- 投影 ------------------------------- */

/** 读一个属性当前的值（读不到返回 null），用于写完校验 */
function pf_readNum(p) {
  try {
    var v = p.value;
    if (typeof v === "number") return v;
    if (v && v.length) return v[0];
  } catch (e) {}
  return null;
}

/**
 * 自动投影：加发光时顺手补一层 Drop Shadow，参数固定（面板上不调）：
 * 黑色 · 不透明度 100% · 方向 135° · 距离 10 · 柔和 20 · 不勾「仅阴影」
 *
 * 做法：先删掉旧投影再重新添加 —— 新加的永远排在效果列表最后，
 * 而 AE 的效果是从上往下依次作用，最后一个 = 最后渲染 = 盖在发光之上。
 * （不用 moveTo，moveTo 对效果不一定生效）
 *
 * 赋值方式：**按属性名扫描**（英文 + 中文关键字）而不是靠索引猜。
 * 因为不同语言 / 版本的 Drop Shadow 属性名和顺序都不一样，按索引写会静默失败，
 * 结果就是 AE 停在它自己的出厂值上（你看到的 35% 就是这么来的）。
 * 写完再**读回校验**，不对就按标准索引补一次。
 */
function pf_autoShadow(layer) {
  try {
    var fx = layer.Effects;
    for (var k = fx.numProperties; k >= 1; k--) {
      var old = fx.property(k);
      var omn = "";
      try { omn = String(old.matchName); } catch (e0) { omn = ""; }
      if (omn === "ADBE Drop Shadow") { old.remove(); break; }
    }
  } catch (e1) {}

  var eff = null;
  try { eff = layer.Effects.addProperty("ADBE Drop Shadow"); } catch (e2) { eff = null; }
  if (!eff) return;

  var WANT = { opacity: 100, direction: 135, distance: 10, softness: 20 };
  var got = { color: false, opacity: false, direction: false, distance: false, softness: false, only: false };
  var n = 0;
  try { n = eff.numProperties; } catch (eN) { n = 0; }

  for (var i = 1; i <= n; i++) {
    var p = eff.property(i);
    var nm = "";
    try { nm = String(p.name).toLowerCase(); } catch (e3) {}
    var isColor = false;
    try { isColor = (p.propertyValueType === PropertyValueType.COLOR); } catch (e4) {}

    try {
      if (isColor) {
        p.setValue([0, 0, 0]);                      // 阴影颜色 = 纯黑
        got.color = true;
      } else if (!got.opacity && (nm.indexOf("opacity") >= 0 || nm.indexOf("不透明") >= 0)) {
        p.setValue(WANT.opacity);
        got.opacity = true;
      } else if (!got.direction && (nm.indexOf("direction") >= 0 || nm.indexOf("方向") >= 0)) {
        p.setValue(WANT.direction);
        got.direction = true;
      } else if (!got.distance && (nm.indexOf("distance") >= 0 || nm.indexOf("距离") >= 0)) {
        p.setValue(WANT.distance);
        got.distance = true;
      } else if (!got.softness && (nm.indexOf("softness") >= 0 || nm.indexOf("柔和") >= 0)) {
        p.setValue(WANT.softness);
        got.softness = true;
      } else if (!got.only && (nm.indexOf("only") >= 0 || nm.indexOf("仅阴影") >= 0)) {
        p.setValue(0);                              // 不勾「仅阴影」
        got.only = true;
      }
    } catch (e5) {}
  }

  // 兜底：某个参数名没命中 → 按 AE 标准顺序补一次（1色 2不透明度 3方向 4距离 5柔和 6仅阴影）
  var fallback = [["opacity", 2], ["direction", 3], ["distance", 4], ["softness", 5]];
  for (var j = 0; j < fallback.length; j++) {
    var key = fallback[j][0], idx = fallback[j][1];
    if (got[key]) continue;
    try {
      var q = eff.property(idx);
      if (q && q.propertyValueType !== PropertyValueType.COLOR) {
        q.setValue(WANT[key]);
        got[key] = true;
      }
    } catch (e6) {}
  }

  // 读回校验：不透明度还没到 100 就再强写一次（这是唯一肉眼最敏感的参数）
  try {
    for (var r = 1; r <= n; r++) {
      var rp = eff.property(r);
      var rn = "";
      try { rn = String(rp.name).toLowerCase(); } catch (e7) {}
      if (rn.indexOf("opacity") >= 0 || rn.indexOf("不透明") >= 0) {
        if (pf_readNum(rp) !== WANT.opacity) rp.setValue(WANT.opacity);
        break;
      }
    }
  } catch (e8) {}
}

/* --------------------------- 面板可调用的入口 --------------------------- */

/** 选择 SRT 文件，返回路径（不加过滤器，避免部分 AE 版本把过滤函数当成筛选条件） */
function PF_pickSRT() {
  var f = File.openDialog("选择字幕文件");
  if (!f) return "";
  return f.fsName;
}

function PF_ping() {
  var v = "?";
  try { v = app.version; } catch (e) {}
  return "OK|AE " + v;
}

/** 由 SRT 生成文字图层 */
function PF_importSRT(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  if (!o.srtPath) return "ERR|未选择字幕文件";

  var txt = pf_readSRT(o.srtPath);
  if (txt === null) return "ERR|无法读取字幕文件";

  var cues = pf_parseSRT(txt);
  if (cues.length === 0) return "ERR|字幕解析为空";

  var made = 0;
  pf_lastBatch = [];
  pf_lastPrecomp = null;
  pf_lastFont = "";
  pf_lastColor = "";

  var cueLayers = [];
  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];
    if (c.end + 2 > comp.duration) { try { comp.duration = c.end + 2; } catch (e) {} }
    var body = pf_applyLineBreak(c.text, o.lineBreakBase);
    // 导入只负责建层：**不套用②里的字体**（字体统一由「确认修改字体」来改）
    var layer = pf_addTextLayer(comp, body, c.start, c.end, o, null);
    try { layer.label = 12; } catch (e) {}
    cueLayers.push(layer);
    made++;
  }

  // 导入阶段只建层，不施加任何效果（字体/交叠/动画都放到后面的按钮里）
  pf_lastBatch = [];
  for (var m = 0; m < cueLayers.length; m++) pf_lastBatch.push(cueLayers[m]);

  var msg = "生成 " + made + " 个字幕图层";

  // 导入后自动预合成：把刚建的字幕图层打包进一个新合成
  if (o.precompose) {
    var pname = (o.precompName && o.precompName.length) ? o.precompName : "PF_字幕";
    var pc = pf_precomposeBatch(comp, pf_lastBatch, pname);
    if (pc) {
      pf_lastPrecomp = pc;
      pf_lastBatch = pf_collectTextLayers(pc);  // 换成预合成内的图层引用
      try { pc.openInViewer(); } catch (e5) {}  // 打开预合成，方便继续加效果
      msg += "，已预合成「" + pc.name + "」";
    } else {
      msg += "（预合成失败，图层保留在原合成）";
    }
  }
  return "OK|" + msg;
}

/* --------------------- 批量应用（供各入口复用） --------------------- */

var pf_lastBatch = [];      // 最近一次 PF_importSRT 生成的图层
var pf_lastPrecomp = null;  // 最近一次自动创建的预合成
var pf_lastFont = "";       // 上一句用过的字体（避免相邻重复）
var pf_lastColor = "";      // 上一句用过的颜色（避免相邻重复）
var pf_lastGlow = "";       // 上一句用过的发光色（发光色随机时，避免相邻重复）

/** 给单个文字图层套用全部样式 */
function pf_styleOne(L, o) {
  var flowOn = !!(o.flow && o.flow.enabled);
  var fmode = (o.flow && o.flow.mode) ? o.flow.mode : "band";

  // 颜色只取一次：文字底色和流光色必须是同一个（随机模式下 = 这一句抽到的那个色）
  var col = null;
  if (flowOn || o.doColor !== false) col = pf_pickTextColor(o);

  // 先挂流光动画器，拿到结果再决定底色 ——
  // 光带模式要把底色刷白，但万一动画器没建起来，白底就会变成"整句纯白"。
  // 所以只有流光真的建成功了才刷白，否则老老实实上色。
  var flowed = false;
  if (flowOn) flowed = pf_flowOnLayer(L, o, col, fmode);

  if (flowOn && fmode !== "wash" && flowed) {
    pf_setTextFill(L, "#ffffff");     // 光带：底色转白，彩色光带才看得出来
  } else if (col) {
    pf_setTextFill(L, col);           // 晕染留白 / 普通上色 / 光带失败的兜底
  }
  // 投影不在这里加：它是"发光"的附属，在 pf_glowOnLayer 里自动补（保证排在发光之后）
  if (o.doTracking) pf_trackingOnLayer(L, o);
  if (o.doEntry) pf_entryOnLayer(L, o);
  if (o.doExit) pf_exitOnLayer(L, o);
  if (o.growEnabled) pf_applyScale(L, o);
}

/**
 * 新旧交叠：把每条字幕的出场点延长到「下一条入点 + 出场时长」，
 * 于是旧字幕刚开始渐隐时，新字幕正好开始入场。
 * 已经交叠过就跳过（幂等，重复点不会越拖越长）。
 */
function pf_applyOverlap(layers, o) {
  if (!o.overlap) return;
  var ex = (o.exitSeconds && o.exitSeconds > 0) ? o.exitSeconds : 0.25;
  var arr = layers.slice();
  arr.sort(function (a, b) { return a.inPoint - b.inPoint; });
  for (var i = 0; i < arr.length - 1; i++) {
    var cur = arr[i], nxt = arr[i + 1];
    if (cur.outPoint > nxt.inPoint + 0.01) continue;      // 已交叠，跳过
    var newOut = nxt.inPoint + ex;
    if (newOut > nxt.outPoint) newOut = nxt.outPoint;
    if (newOut > cur.inPoint + 0.2) { try { cur.outPoint = newOut; } catch (e) {} }
  }
  var last = arr[arr.length - 1];
  if (last) { try { last.outPoint = last.outPoint + ex; } catch (e2) {} }
}

function pf_applyAnimation(layers, o) {
  pf_lastColor = "";
  pf_resetColorBags();
  pf_applyOverlap(layers, o);
  for (var i = 0; i < layers.length; i++) pf_styleOne(layers[i], o);
}

function pf_applyWave(layers, o) {
  for (var i = 0; i < layers.length; i++) pf_waveOnLayer(layers[i], o);
}

function pf_applyGlow(layers, o) {
  pf_lastGlow = "";
  pf_bagGlow.bag = []; pf_bagGlow.idx = 0; pf_bagGlow.last = "";
  for (var i = 0; i < layers.length; i++) pf_glowOnLayer(layers[i], o);
}

/** 对目标文字图层应用动画(入场/出场/间距/颜色) */
function PF_animate(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";
  pf_applyAnimation(layers, o);
  return "OK|已处理 " + layers.length + " 个图层";
}

/** 波浪 */
function PF_wave(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";
  pf_applyWave(layers, o);
  return "OK|波浪已应用 (" + layers.length + ")";
}

/** 发光 */
function PF_glow(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";
  pf_applyGlow(layers, o);
  return "OK|发光已应用 (" + layers.length + ")";
}

/**
 * 一键生成：只对当前合成里的文字图层套用 字体/颜色/动画/波浪/发光。
 * 不再负责导入字幕（导入由「① 字幕 → 确定导入」单独完成）。
 */
function PF_runAll(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";

  pf_lastFont = "";
  pf_lastColor = "";
  pf_lastGlow = "";
  pf_resetColorBags();
  pf_applyOverlap(layers, o);
  for (var i = 0; i < layers.length; i++) {
    pf_fontOnLayer(layers[i], o, i);
    pf_styleOne(layers[i], o);
  }
  pf_applyWave(layers, o);
  pf_applyGlow(layers, o);
  return "OK|已应用字体/颜色/动画/波浪/发光 (" + layers.length + " 个图层)";
}

/** 图层交错：把目标文字图层按顺序错开起始时间(卡点常用) */
function PF_interlace(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  var step = o.step === undefined ? 0.1 : o.step;
  // 按入点排序，依次追加偏移
  layers.sort(function (a, b) { return a.inPoint - b.inPoint; });
  for (var i = 0; i < layers.length; i++) {
    try {
      layers[i].startTime = layers[i].startTime + i * step;
    } catch (e) {}
  }
  return "OK|已交错 " + layers.length + " 个图层";
}

/** 新建调整图层(整片调色/发光用) */
function PF_adjustment(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var L = comp.layers.addSolid([0, 0, 0], "PF_调整图层", comp.width, comp.height, 1, comp.duration);
  try { L.adjustmentLayer = true; } catch (e) {}
  return "OK|已创建调整图层";
}
