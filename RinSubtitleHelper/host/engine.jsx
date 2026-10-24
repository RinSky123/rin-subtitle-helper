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

/** 两个颜色是不是同一个（用于判断"文字颜色是不是纯白"） */
function pf_sameHex(a, b) {
  function norm(s) {
    var h = String(s || "").replace("#", "").toLowerCase();
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return h;
  }
  return norm(a) === norm(b);
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

/** 是不是中日韩字符（这类可以逐字断行） */
function pf_isCJKChar(ch) {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(ch);
}

/** 是不是"不能出现在行首"的标点（句读类） */
var PF_NO_LINE_START = "，。、；：？！,.;:?!）)」』】》”’…—·";

/** 是不是"不能出现在行尾"的标点（开引号/开括号类） */
var PF_NO_LINE_END = "（(「『【《“‘";

/** 这个字符是不是纯标点 / 符号（用来判断"只剩标点"） */
function pf_isPunctOnly(str) {
  var s = pf_trim(str);
  if (!s) return true;
  return !/[0-9A-Za-zÀ-ɏ぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(s);
}

/**
 * 按最大字数 base 折行。
 *
 * 三条硬规则（以前都没做到，是"一个词被拆开""只剩标点也单独占一行"的根源）：
 *
 *   ① **不拆单词** —— 西文一个词整体留在同一行。
 *      以前只在断点往回 6 个字符内找空格，找不到就直接在 base 处硬切，
 *      于是 "Welcome" 会被切成 "Welc" / "ome"。
 *      现在：往回找最近空格，**不限距离**；实在一个空格都没有（整行没空格）
 *      才退化为按字断，避免死循环。
 *
 *   ② **标点不单独成行** —— 剩下只有标点时，把它并回上一行，
 *      而不是自己占一行（"…" / "。" 单独一行是最丑的情况）。
 *
 *   ③ **行首不留收尾标点、行尾不留开引号** ——
 *      断行后若下一行以 ，。？！ 开头，把它们挪到上一行末尾。
 *
 * 中文本来就可以逐字断，所以规则①只对西文生效。
 */
function pf_wrapLine(line, base) {
  if (!base || base < 2) return line;
  var s = String(line);
  if (s.length <= base) return s;

  var out = [];
  var rest = s;

  while (rest.length > base) {
    var cut = -1;

    // ---- 规则①：往回找最近空格，不限制距离 ----
    // 从 base 处往回扫，第一个空格就是断点（空格留在上一行末尾，随后 trim 掉）。
    for (var k = base; k > 0; k--) {
      if (rest.charAt(k) === " ") { cut = k; break; }
    }

    // 没在 base 附近找到空格 → 判断换行点在哪。
    if (cut < 0) {
      var firstSp = rest.indexOf(" ");

      if (firstSp > 0 && firstSp <= base) {
        // ① 这一行前面有完整单词 → 在最后一个能放下的空格处断，
        //    保证本行所有词完整。
        cut = rest.substring(0, base + 1).lastIndexOf(" ");
        if (cut <= 0) cut = firstSp;
      } else {
        // ② 第一个词本身就比整行还宽（或整段没有空格）。
        //    这时**没有放得下的换行点** —— 只能按字断。
        //
        //    例外：中日韩本来就该逐字断，走的也是这条。
        //    西文单词宽于整行时也只能断，否则会溢出画面外。
        cut = base;
      }
    }

    var head = pf_trim(rest.substring(0, cut));
    rest = pf_trim(rest.substring(cut));

    // ---- 规则③：下一行不能以收尾标点开头 → 挪到本行末尾 ----
    while (rest.length && PF_NO_LINE_START.indexOf(rest.charAt(0)) >= 0) {
      head += rest.charAt(0);
      rest = rest.substring(1);
    }
    // 本行末尾不能是开引号/开括号 → 挪到下一行开头
    while (head.length && PF_NO_LINE_END.indexOf(head.charAt(head.length - 1)) >= 0) {
      rest = head.charAt(head.length - 1) + rest;
      head = head.substring(0, head.length - 1);
    }
    head = pf_trim(head);

    if (head) out.push(head);
    if (!rest) break;
  }

  // ---- 规则②：剩下只有标点 → 并回上一行，不单独成行 ----
  if (rest.length) {
    if (pf_isPunctOnly(rest) && out.length) {
      out[out.length - 1] = out[out.length - 1] + pf_trim(rest);
    } else {
      out.push(pf_trim(rest));
    }
  }

  return out.join("\n");
}

function pf_applyLineBreak(text, base) {
  if (!base || base <= 0) return text;
  var parts = String(text).split("\n");
  var out = [];
  for (var i = 0; i < parts.length; i++) out.push(pf_wrapLine(parts[i], base));
  return out.join("\r");
}

/**
 * 清洗标点 —— 字幕里那些不好看、也不读的标点。
 *
 * 处理三类：
 *   ① 行尾/行首的标点直接删（"你好，" → "你好"）
 *   ② 连续重复的标点压成一个（"真的？？？" → "真的？"，"..." → "…"）
 *   ③ 行首的引导性标点删掉（"，但是" → "但是"）
 *
 * 保留有语义的：引号、括号、问号叹号本身，只是不让它们堆在一起。
 */
function pf_cleanPunctuation(text) {
  if (!text) return "";
  var t = String(text);

  // 省略号先归一（各种写法的三个点 → 一个省略号）
  t = t.replace(/\.{2,}/g, "…");
  t = t.replace(/。{2,}/g, "…");
  t = t.replace(/·{2,}/g, "…");

  // 连续重复的同一个标点压成一个（？？？ → ？；！！！ → ！）
  t = t.replace(/([\?!,，、;；:：])\1+/g, "$1");

  // 问号 / 叹号连用（"？！" 这种混排）压成一个
  t = t.replace(/[?？!！]{2,}/g, function (m) {
    return /[?？]/.test(m) ? "？" : "！";
  });

  // 行首的逗号、句号、顿号、分号直接去掉
  t = t.replace(/^[\s,，、;；:：。.]+/, "");
  // 行尾的逗号、顿号、分号去掉（句号/问号/叹号/省略号保留，它们表示语气结束）
  t = t.replace(/[\s,，、;；:：]+$/g, "");

  // 多余空格（连续两个以上压成一个）
  t = t.replace(/[ \t]{2,}/g, " ");

  return pf_trim(t);
}

/** 强制大写（只影响拉丁字母，中文/数字不动） */
function pf_toUpper(text) {
  if (!text) return "";
  return String(text).toUpperCase();
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
  // 图层名保持字幕原文（AE 默认就用文字内容命名）—— 时间线上一眼能认出是哪句字幕。
  // 只有调用方显式给了 layerName 才改名。
  if (opts && opts.layerName) { try { layer.name = opts.layerName; } catch (eN) {} }
  try { layer.startTime = 0; } catch (e) {}
  pf_setSourceText(layer, text, opts, fontName);
  if (inSec !== null && inSec !== undefined && outSec !== null && outSec !== undefined) {
    try { layer.inPoint = inSec; layer.outPoint = outSec; } catch (e) {}
  }
  return layer;
}

/* 突出字幕的方式：发光前后各补一层投影（Drop Shadow，见 pf_buildEffectChain），不再用黑底/黑发光 */

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

/**
 * 清掉图层上**上次由本面板建出来的**文字动画器 + 关键帧。
 *
 * 为什么必须清：
 *   每次「一键生成」都会新加一批动画器。旧的那批不会自己消失，
 *   于是同一个图层上会同时存在「出场 1 秒」和「出场 2 秒」两套关键帧。
 *   两个选择器都在推 Percent End，谁跑得快谁先让字消失 ——
 *   结果就是**你把出场调大，看起来还是按旧的快节奏消失**。
 *   整层透明度、缩放也是同理：旧关键帧留在别的时间点上，
 *   新关键帧插进去以后曲线会拐回去，表现完全对不上设置。
 *
 * 判定「是自己建的」有两个依据，任一命中即删：
 *   · 动画器名字带本面板的前缀（下面 pf_addAnimator 会写上）
 *   · 带「文字不透明度 = 0」属性 + 选择器 —— 只有出入场 / 随机动画是这个结构
 * 用户自己手打的动画器一般不带这个组合，不会被误删。
 */
var PF_ANIM_TAG = "Rin";

function pf_isOurAnimator(anim) {
  if (!anim) return false;
  try {
    var nm = String(anim.name || "");
    if (nm.indexOf(PF_ANIM_TAG) === 0) return true;
  } catch (e0) {}
  // 结构判定（名字没设上时的兜底）：
  //   · 文字不透明度 = 0  → 出入场 / 随机动画
  //   · 带填充色属性      → 流光
  try {
    var pr = anim.property("ADBE Text Animator Properties");
    if (pr) {
      var op = null;
      try { op = pr.property("ADBE Text Opacity"); } catch (e1) { op = null; }
      if (op) {
        var v = null;
        try { v = Number(op.value); } catch (e2) { v = null; }
        if (v === 0) return true;
      }
      var fc = null;
      try { fc = pr.property("ADBE Text Fill Color"); } catch (e4) { fc = null; }
      if (fc) return true;
    }
  } catch (e3) {}
  return false;
}

function pf_clearOurAnimators(layer) {
  var tg = null;
  try { tg = layer.property("ADBE Text Properties"); } catch (e0) { return; }
  if (!tg) return;
  var anims = null;
  try { anims = tg.property("ADBE Text Animators"); } catch (e1) { anims = null; }
  if (!anims) return;

  var n = 0;
  try { n = anims.numProperties; } catch (e2) { return; }
  // 从后往前删，避免索引错位
  for (var i = n; i >= 1; i--) {
    var a = null;
    try { a = anims.property(i); } catch (e3) { continue; }
    if (pf_isOurAnimator(a)) {
      try { a.remove(); } catch (e4) {}
    }
  }

  // 整层透明度 / 缩放上的旧关键帧也要清掉 —— 否则改了出场时长，
  // 旧关键帧仍在原来的时间点上，曲线会拐回去。
  //
  // 只清这两个：位置关键帧有可能用户自己打过，不动它。
  //
  // 透明度归位到 100：它只有出场会动，基准固定。
  var opProp = pf_layerProp(layer, "ADBE Opacity");
  pf_clearKeys(opProp);
  if (opProp) { try { opProp.setValue(100); } catch (eOp) {} }

  // 缩放：删完关键帧后**必须归位到基准值**，否则属性会停在
  // "上次放大到的值"（比如 119%），关掉放大后字幕就永远偏大。
  // 基准是第一次执行时记下来的（可能来自图层属性或标记），没有就用当前值。
  //
  // 先触发一次标记解析 —— 重开 AE 后 pf_scaleBase 只在标记里，
  // 不先读出来，这里就没法归位。
  pf_getSrtOut(layer);
  var scProp = pf_layerProp(layer, "ADBE Scale");
  pf_clearKeys(scProp);
  if (scProp && layer.pf_scaleBase) {
    try { scProp.setValue(layer.pf_scaleBase); } catch (eSc) {}
  }
}

/** 取图层变换组里的属性（取不到返回 null） */
function pf_layerProp(layer, matchName) {
  try {
    var g = layer.property("ADBE Transform Group");
    if (!g) return null;
    return g.property(matchName);
  } catch (e) { return null; }
}

/** 删掉属性上的所有关键帧（没有关键帧就什么都不做） */
function pf_clearKeys(prop) {
  if (!prop) return;
  try {
    var n = prop.numKeys;
    if (!n) return;
    // 从后往前删，删到只剩 0 个
    for (var i = n; i >= 1; i--) {
      try { prop.removeKey(i); } catch (e1) {}
    }
  } catch (e0) {}
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

  // 打个名字标记：下次重新生成时靠它认出"这是本面板建的"，
  // 先清掉再重建 —— 否则新旧两套关键帧会同时留在图层上。
  try { anim.name = PF_ANIM_TAG + "动画"; } catch (eName) {}

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

/**
 * 诊断：打印字幕的时序信息。
 *
 * 出场不对时先点这个 —— 一眼就能看出问题出在哪一层：
 *   · 标记有没有真的写进去（`标记:无` = 写失败，原始出点找不回来）
 *   · 原始出点 T 和当前出点对不对得上
 *   · 出场帧数算出来是多少、淡出区间落在哪
 *
 * 正常应该看到：
 *   标记:_rinsub_out:12.5|2|100,100  原始出点:12.5s  出点:13.9s
 *   出场:35 帧 = 1.40s（25fps）→ 淡出 12.5s ~ 13.9s
 */
function PF_timingDebug() {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var L = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    var c = comp.layer(i);
    if (pf_isTextLayer(c)) { L = c; break; }
  }
  if (!L) return "ERR|合成里没有文字图层";

  var fps = pf_layerFps(L);
  var mk = pf_readMarkerText(L);
  var T = pf_getSrtOut(L);
  var E = pf_getExtendSeconds(L);

  var opts = { exitFrameOffset: 0 };          // 诊断只看基准值
  var frames = pf_exitFrameCount(opts);
  var d = pf_exitFadeSeconds(opts, L);

  var out = [];
  out.push("帧率:" + fps);
  out.push("标记:" + (mk ? mk : "无"));
  out.push("原始出点:" + (T !== null ? (Math.round(T * 1000) / 1000) + "s" : "未知"));
  out.push("延长:" + E + "s");
  out.push("出点:" + (Math.round(L.outPoint * 1000) / 1000) + "s");
  out.push("入场:" + (Math.round(L.inPoint * 1000) / 1000) + "s");
  out.push("出场基准:" + frames + " 帧 = " + (Math.round(d * 1000) / 1000) + "s");

  if (T !== null) {
    out.push("淡出区间:" + (Math.round(T * 1000) / 1000) + "s ~ " +
             (Math.round((T + d) * 1000) / 1000) + "s");
    var gap = L.outPoint - (T + d);
    if (gap > 0.02) out.push("⚠ 出点比淡出结束晚 " + (Math.round(gap * 1000) / 1000) + "s");
  } else {
    out.push("⚠ 没有标记 → 出场会把延长的出点当原始出点");
  }

  return "OK|" + out.join(" ‖ ");
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

  // 顺便把效果链顺序也打出来（投影1 → 发光 → 投影2 才对）
  var chain = [];
  try {
    for (var c = 1; c <= L.Effects.numProperties; c++) {
      var ce = L.Effects.property(c);
      var cmn = "", cnm = "";
      try { cmn = String(ce.matchName); } catch (ec) { cmn = ""; }
      try { cnm = String(ce.name); } catch (ec2) { cnm = ""; }
      chain.push(c + ":" + (cnm || cmn));
    }
  } catch (ec3) {}

  var out = [], found = 0;
  try {
    for (var k = 1; k <= L.Effects.numProperties; k++) {
      var e = L.Effects.property(k);
      var mn = "";
      try { mn = String(e.matchName); } catch (e0) {}
      if (mn !== "ADBE Drop Shadow") continue;
      found++;
      out.push("投影#" + k + "【" + (function () {
        try { return String(e.name); } catch (en) { return "?"; }
      })() + "】");
      for (var j = 1; j <= e.numProperties; j++) {
        var p = e.property(j);
        var v = "";
        try {
          var raw = p.value;
          v = (typeof raw === "number") ? String(Math.round(raw * 100) / 100)
                                        : (raw && raw.length ? "[" + raw.join(",") + "]" : String(raw));
        } catch (e1) { v = "?"; }
        // 不透明度额外换算成面板显示值，方便直接对上 AE 界面
        var note = "";
        if (j === 2 && typeof raw === "number") {
          var shown = (raw > 100.5) ? (raw / 2.55) : raw;
          note = " (面板显示约 " + Math.round(shown) + "%)";
        }
        out.push(p.name + "=" + v + note);
      }
    }
  } catch (e2) { return "ERR|读取失败：" + e2.toString(); }

  if (!found) return "ERR|这个图层上没有投影效果（先点一键生成效果）";
  return "OK|效果链[" + chain.join(" > ") + "] ‖ " + out.join(" / ");
}

/**
 * 诊断：把 Deep Glow 的**参数名和实际值**全部列出来。
 * 汉化版参数名是中文，光看面板上的数字对不上时，用这个看 AE 里到底是什么。
 */
function PF_glowDebug() {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var L = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    if (pf_isTextLayer(comp.layer(i))) { L = comp.layer(i); break; }
  }
  if (!L) return "ERR|合成里没有文字图层";

  var eff = null;
  try {
    for (var k = 1; k <= L.Effects.numProperties; k++) {
      var e = L.Effects.property(k);
      if (pf_isGlowEffect(e)) { eff = e; break; }
    }
  } catch (e0) {}
  if (!eff) return "ERR|这个图层上没有发光效果";

  var mn = "", nm = "";
  try { mn = String(eff.matchName); } catch (e1) {}
  try { nm = String(eff.name); } catch (e2) {}

  var out = [];
  function walk(group, prefix) {
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      var p = group.property(i);
      var kids = 0;
      try { kids = p.numProperties; } catch (e3) { kids = 0; }
      var pn = "", pm = "";
      try { pn = String(p.name); } catch (e4) { pn = "?"; }
      try { pm = String(p.matchName); } catch (e5) { pm = ""; }
      var path = prefix ? (prefix + "/" + pn) : pn;

      if (kids > 0) { walk(p, path); continue; }

      var v = "";
      try {
        var raw = p.value;
        v = (typeof raw === "number") ? String(Math.round(raw * 1000) / 1000)
                                      : (raw && raw.length ? "[" + raw.join(",") + "]" : String(raw));
      } catch (e6) { v = "?"; }
      var key = pf_dgKeyOf(pn, pm);
      out.push(path + "=" + v + (key ? ("→" + key) : ""));
    }
  }
  walk(eff, "");

  // 额外把 Tint 的四个关键参数单独标出来 —— 发光色是否生效全看它们。
  // 必须用**和写入完全同一个函数**（pf_resolveTintProps）来取，
  // 否则诊断显示的又是一套独立推理的结果，会骗人。
  var tintInfo = "";
  try {
    var tg = pf_findGlowColorGroup(eff, 0);
    var t = tg ? pf_resolveTintProps(tg) : null;
    if (t) {
      function show(p) {
        if (!p) return "(无)";
        try {
          var raw = p.value;
          if (typeof raw === "number") return String(Math.round(raw * 100) / 100);
          if (raw && raw.length) return "[" + raw.join(",") + "]";
          return String(raw);
        } catch (e) { return "?"; }
      }
      tintInfo = " ‖ Tint: Enable=" + show(t.enable) +
                 " Color=" + show(t.color) +
                 " Mode=" + show(t.mode) +
                 " Mix=" + show(t.mix);
    } else {
      tintInfo = " ‖ Tint: 未找到";
    }
  } catch (e7) {}

  return "OK|" + nm + "(" + mn + ") ‖ " + out.join(" / ") + tintInfo;
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

/* ---------------- 出入场时长（面板按帧调节） ---------------- */

/**
 * 合成帧率 —— 面板上的帧数都要靠它换算成秒。
 * 取不到就按 25fps，不会因为异常把动画时长算成 0。
 */
function pf_layerFps(layer) {
  var fps = 25;
  try {
    fps = layer.containingComp.frameRate;
  } catch (e) {}
  if (!fps || fps <= 0) fps = 25;
  return fps;
}

/** 入场基准：1.5 秒。面板上的帧数是在这个基准上加减的。 */
var PF_ENTRY_BASE_SEC = 1.5;

/** 出场基准：35 帧内匀速淡完。面板上的帧数是在这个基准上加减的。 */
var PF_EXIT_BASE_FRAMES = 35;

/** 出场帧数的上下限（用户设定：最短 10 帧，最长 50 帧） */
var PF_EXIT_MIN_FRAMES = 10;
var PF_EXIT_MAX_FRAMES = 50;

/**
 * 入场时长（秒）。
 *
 * 面板给的是**帧偏移**：0 = 基准 1.5 秒，往右加帧、往左减帧。
 * 所以实际时长 = 1.5 + offset / fps。
 *
 * 兼容旧调用：没给 entryFrameOffset 时仍然读 entrySeconds。
 */
function pf_entrySeconds(opts, layer) {
  var fps = pf_layerFps(layer);
  var sec;

  if (opts.entryFrameOffset !== undefined && opts.entryFrameOffset !== null) {
    sec = PF_ENTRY_BASE_SEC + Number(opts.entryFrameOffset) / fps;
  } else if (opts.entrySeconds !== undefined && opts.entrySeconds !== null && opts.entrySeconds > 0) {
    sec = opts.entrySeconds;
  } else {
    var dur = 0;
    try { dur = layer.outPoint - layer.inPoint; } catch (e) {}
    sec = dur * (opts.entryDuration === undefined ? 50 : opts.entryDuration) / 100;
  }

  // 最短 1 帧：滑块往左拉到底时基准 1.5 秒会被减成负数，
  // 负数时长会让关键帧倒着走，动画直接不播。夹到 1 帧即可。
  var minSec = 1 / fps;
  if (!(sec > 0)) sec = minSec;
  if (sec < minSec) sec = minSec;
  return sec;
}

/** 出场帧数：35 + 偏移，夹在 10~50 帧之间 */
function pf_exitFrameCount(opts) {
  var f = PF_EXIT_BASE_FRAMES;
  if (opts && opts.exitFrameOffset !== undefined && opts.exitFrameOffset !== null) {
    f += Number(opts.exitFrameOffset) || 0;
  }
  if (f < PF_EXIT_MIN_FRAMES) f = PF_EXIT_MIN_FRAMES;
  if (f > PF_EXIT_MAX_FRAMES) f = PF_EXIT_MAX_FRAMES;
  return f;
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
 *
 * 注意：句子模式走字符粒度，时长按图层整体算，不按词量再打折。
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

/**
 * 句子模式的"逐行、行内从左到右"淡入/淡出。
 *
 * 需求是：**一行一行地出现，而且每行内部是 从左到右 渐显**（不是整行一起亮）。
 *
 * AE 的 Range Selector 有几种粒度：1=字符 2=字符(不含空格) 3=词 4=行。
 *
 *  - 用 4（行）：整行一起出现，行内没有"从左到右"的推进 —— 之前就是这样，不行。
 *  - 用 1（字符）：**行内从左到右推进**，正是要的效果；
 *    多行时它会把上一行扫完再接着扫下一行 —— 视觉上天然就是"一行一行"。
 *
 * 所以句子模式直接用**字符粒度**：
 *   入场 Start 0→100，字符从行首逐字亮起，扫完一行接下一行
 *   出场 End 0→100，同样的顺序逐字消失
 *
 * 这比"按行"更细腻，也刚好满足"一行一行 + 从左到右"两个要求。
 */
var PF_RANGE_CHARS = 1;

function pf_sentenceLineFade(layer, opts, isExit) {
  var inP = layer.inPoint, outP = layer.outPoint;
  var dur = outP - inP;

  // 时间窗口：出场从 T（本该结束的时刻）开始；入场从入点开始。
  var d, t0, t1;
  if (isExit) {
    d = pf_exitFadeSeconds(opts, layer);
    t0 = pf_layerExitStart(layer);
    t1 = t0 + d;
    // 和 pf_exitOnLayer 一致：时间不够就延长出点，不能压缩淡出时长。
    if (t1 > outP) {
      try { layer.outPoint = t1; outP = t1; } catch (eOut) {}
    }
  } else {
    d = pf_scaleByWords(layer, pf_entrySeconds(opts, layer));
    t0 = inP;
    t1 = inP + d;
  }

  // ---- 整层渐隐/渐显：**强制**，和逐字推进同一时间窗口 ----
  //
  // 句子模式只给字符粒度打了 Percent End/Start，字是一个个变化的，
  // 若不叠整层透明度，画面上就没有"整体渐渐变淡/变亮"的过渡。
  // 两条一起走：
  //   逐字 → 从左到右一个个消退
  //   整层 → 同时整体变淡
  // 出场会让路给下一条，入场则不会和上一条叠成一片。
  if (isExit) pf_forceExitFade(layer, opts, t0, t1);
  else pf_forceEntryFade(layer, opts, t0, t1);

  // 字符粒度：行内从左到右推进，扫完一行自然接下一行 ——
  // 同时满足"一行一行"和"行内从左到右"两个要求。
  var anim = pf_addAnimator(layer, PF_RANGE_CHARS);
  if (!anim || !anim.animator || !anim.props || !anim.sel) {
    // 动画器没建起来就退回整层淡入淡出，至少不是"啪"一下
    if (isExit) pf_sentenceFade(layer, t0, t1, 100, 0, opts.exitMoveY, true);
    else pf_sentenceFade(layer, t0, t1, 0, 100, opts.entryMoveY, false);
    return;
  }

  // 校验粒度。默认值本来就是字符，这里只在读回明显不对时兜底。
  var t2 = pf_deepProp(anim.sel, "ADBE Text Range Type2", 0);
  var gotType = null;
  try { gotType = t2 ? t2.value : null; } catch (eT) { gotType = null; }
  if (gotType !== null && Number(gotType) !== PF_RANGE_CHARS) {
    try { t2.setValue(PF_RANGE_CHARS); } catch (eT2) {}
  }

  var opacity = pf_addProp(anim.props, ["ADBE Text Opacity"]);
  if (opacity) opacity.setValue(0);

  if ((isExit ? opts.exitMoveY : opts.entryMoveY) && anim.props) {
    var p = pf_addProp(anim.props, ["ADBE Text Position 3D", "ADBE Text Position"]);
    if (p) p.setValue([0, isExit ? opts.exitMoveY : opts.entryMoveY, 0]);
  }

  // 方形边界 + 柔和度：推进时边界是渐变的，看起来是"渐显/渐隐"而不是硬切。
  // Smoothness 给足一点，字与字之间才有连续的淡入感。
  var shape = pf_deepProp(anim.sel, "ADBE Text Range Shape", 0);
  if (shape) { try { shape.setValue(1); } catch (e1) {} }
  var smooth = pf_deepProp(anim.sel, "ADBE Text Range Smoothness", 0);
  if (smooth) { try { smooth.setValue(100); } catch (e2) {} }

  if (isExit) {
    // 出场用线性（匀速消失），入场保持缓动 —— 和字/词模式保持一致
    var e = pf_selProp(anim.sel, "ADBE Text Percent End");
    if (e) { e.setValueAtTime(t0, 0); e.setValueAtTime(t1, 100); pf_linear(e); }
  } else {
    var s = pf_selProp(anim.sel, "ADBE Text Percent Start");
    if (s) { s.setValueAtTime(t0, 0); s.setValueAtTime(t1, 100); pf_ease(s); }
  }
}

/* ==================================================================
 *  【项目强制约束】出入场必须自带整层渐隐/渐显
 *
 *  规则：**任何入场动画都要渐显，任何出场动画都要渐隐**，强制加。
 *
 *  为什么不能靠每个动画自己加：
 *    两条字幕交叠时（旧的在出场、新的在入场），如果只有逐字推进、
 *    没有整层透明度变化，两句话会同时以较高不透明度压在画面上，
 *    新的那条根本看不清。整层渐隐是"让路"的机制，不是可选装饰。
 *
 *  所以把它抽成下面这一对函数，由 pf_entryOnLayer / pf_exitOnLayer
 *  在最外层统一调用 —— **以后新加任何出入场动画，只要走这两个入口，
 *  就自动带上渐隐渐显，不需要各自再实现一遍**。
 *
 *  唯一的例外：用户明确要求某个动画不要渐隐，那种情况才单独跳过。
 * ================================================================== */

/**
 * 整层渐隐/渐显。
 *
 * @param layer  目标图层
 * @param t0,t1  时间窗口
 * @param from   起始不透明度（入场 0，出场 100）
 * @param to     结束不透明度（入场 100，出场 0）
 * @param linear true = 匀速（出场用）；false = 缓动（入场用）
 */
function pf_layerFade(layer, t0, t1, from, to, linear) {
  var op = null;
  try { op = layer.property("ADBE Transform Group").property("ADBE Opacity"); } catch (eOp) { op = null; }
  if (!op) return false;

  var before = 0;
  try { before = op.numKeys; } catch (eN) { before = 0; }

  try {
    op.setValueAtTime(t0, from);
    op.setValueAtTime(t1, to);
  } catch (e) { return false; }

  // **只给刚加的那两个关键帧设插值**，不要用 pf_ease/pf_linear ——
  // 它们会遍历整个属性上的所有关键帧。
  // 入场先写了 0→100（缓动），出场再写 100→0 时若整条刷成线性，
  // 入场的缓动会被一起改掉，入场手感就变了。
  var after = 0;
  try { after = op.numKeys; } catch (eN2) { after = before + 2; }
  var fromIdx = Math.max(1, after - 1);
  for (var i = fromIdx; i <= after; i++) {
    try {
      if (linear) {
        op.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      } else {
        op.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        var ei = new KeyframeEase(0, 33), eo = new KeyframeEase(0, 66);
        try { op.setTemporalEaseAtKey(i, [ei], [eo]); } catch (eTE) {}
      }
    } catch (eI) {}
  }
  return true;
}

/** 入场必备的整层渐显（0 → 100，和入场动画同一时间窗口） */
function pf_layerFadeIn(layer, t0, t1) {
  return pf_layerFade(layer, t0, t1, 0, 100, false);
}

/** 出场必备的整层渐隐（100 → 0，和出场动画同一时间窗口，匀速） */
function pf_layerFadeOut(layer, t0, t1) {
  return pf_layerFade(layer, t0, t1, 100, 0, true);
}

/**
 * 入场。**所有入场动画都从这里进来**，所以整层渐显是必然有的 ——
 * 不需要每个动画各写一遍（项目强制约束，见上面 pf_layerFade 的说明）。
 */
function pf_entryOnLayer(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;
  var base = pf_entrySeconds(opts, layer);                    // 基准 1.5s ± 帧偏移
  var d = pf_scaleByWords(layer, base);                       // 短句自动加快
  var t1 = inP + d;

  if (opts.entryBasedOn === "sentence") {
    // 句子模式：逐行柔和淡入（不是整层硬切）
    pf_sentenceLineFade(layer, opts, false);
    return;
  }

  // ---- ① 整层渐显：强制，和入场动画同一时间窗口 ----
  // 放在分支之前，任何入场动画（含以后新增的）都会经过这里。
  pf_forceEntryFade(layer, opts, inP, t1);

  var a = pf_addAnimator(layer, opts.entryBasedOn === "word" ? 3 : 1);
  var opacity = pf_addProp(a.props, ["ADBE Text Opacity"]);
  if (opacity) opacity.setValue(0);
  if (opts.entryMoveY && a.props) {
    var p = pf_addProp(a.props, ["ADBE Text Position 3D", "ADBE Text Position"]);
    if (p) p.setValue([0, opts.entryMoveY, 0]);
  }
  var s = pf_selProp(a.sel, "ADBE Text Percent Start");
  if (s) { s.setValueAtTime(inP, 0); s.setValueAtTime(t1, 100); pf_ease(s); }

  // 兜底：动画器没建起来时，务必把动画器删掉 —— 没有选择器的动画器会选中全部字符，
  // 那样 opacity=0 会让整句字幕一直不可见。
  // 整层渐显已经加过了，这里不用再补。
  if (!opacity || !s) {
    if (a && a.animator) { try { a.animator.remove(); } catch (e6) {} }
  }
}

/**
 * 【强制约束】给入场补整层渐显。
 *
 * 为什么单独抽一个函数：以后新增入场动画时，只要在入口调一次，
 * 就自动满足"任何入场都要渐显"，不会漏。
 *
 * 例外口子：`opts.noEntryFade === true` 时不加 ——
 * 只在用户对某个具体动画明确要求"不要渐显"时才用。
 */
function pf_forceEntryFade(layer, opts, t0, t1) {
  if (opts && opts.noEntryFade === true) return;
  pf_layerFadeIn(layer, t0, t1);
}

/**
 * 【强制约束】给出场补整层渐隐。
 * 例外口子：`opts.noExitFade === true`。
 */
function pf_forceExitFade(layer, opts, t0, t1) {
  if (opts && opts.noExitFade === true) return;
  pf_layerFadeOut(layer, t0, t1);
}

/**
 * 整层淡入/淡出（兜底用）。
 * linear = true 时用匀速（出场用它，和主流程的"匀速消失"保持一致）。
 */
function pf_sentenceFade(layer, t0, t1, fromV, toV, moveY, linear) {
  try {
    var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
    op.setValueAtTime(t0, fromV);
    op.setValueAtTime(t1, toV);
    if (linear) pf_linear(op); else pf_ease(op);
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

/**
 * 出场渐隐的时长 —— **按帧计算**：基准 35 帧，面板的滑块在这上面加减。
 *
 * 三个要点，都是踩过坑之后定下来的：
 *
 * ① 渐隐**从哪一刻开始** → 原 SRT 出点（= 延长段的第一帧），准时开始变淡
 * ② 渐隐**持续多久**     → 帧数 ÷ 合成帧率（默认 35 帧）
 * ③ 擦除动画和整层渐隐用**同一个窗口**，一起消失
 *
 * 为什么用帧而不是秒：
 *   卡点字幕是按帧对齐的，用秒会因为帧率不同而漂移；
 *   帧数在任何帧率下都是"同样多帧"，和 AE 时间线对得上。
 *
 * 延长量只负责"给这段出场留够地方"，不参与时长计算。
 */
function pf_exitFadeSeconds(opts, layer) {
  var fps = pf_layerFps(layer);
  var frames = pf_exitFrameCount(opts);

  // 兼容：旧调用只给了 exitSeconds、没有帧偏移时，仍按秒走。
  // 这样预设 / 第 2 页等旧路径不会突然跳到基准值。
  if ((!opts || opts.exitFrameOffset === undefined || opts.exitFrameOffset === null) &&
      opts && opts.exitSeconds !== undefined && opts.exitSeconds !== null && opts.exitSeconds > 0) {
    var s = opts.exitSeconds;
    if (s > 10) s = 10;
    if (s < 0.03) s = 0.03;
    return s;
  }

  var d = frames / fps;
  if (d < 0.03) d = 0.03;
  return d;
}

/**
 * 读出/记住一条字幕"原本该结束的时刻" T（SRT 出点）。
 *
 * 为什么不能只挂在图层对象的自定义属性上（layer.pf_srtOut）：
 * ExtendScript 的图层对象是 AE 的代理，自定义属性**不随工程保存** ——
 * 关掉 AE 再打开，这个值就没了，下次「一键生成」会把已经被延后的出点
 * 当成 T，于是每次都往后拖一截，越用越长。
 *
 * 改用**图层标记**存：标记会写进工程文件，重开 AE 也还在。
 * 标记名带一个固定前缀，便于识别，也不会和用户自己打的标记混淆。
 */
var PF_SRT_MARK = "_rinsub_out:";

/**
 * 取图层的**标记组**。
 *
 * 关键点：AE 里 `layer.marker` 是一个 **PropertyGroup**（标记属性组），
 * 不是 MarkerValue。要写标记必须：
 *
 *     layer.marker.setValueAtTime(t, new MarkerValue("文字"));
 *
 * 早先的代码写的是 `layer.marker = new MarkerValue(...)` —— 给只读属性赋值，
 * 直接抛异常被 catch 吞掉，**标记一个都没写进去**。
 * 后果非常隐蔽：下次读不到"原始出点"，就把已经被延长过的出点当成原始出点，
 * 于是字幕在整个延长段里一直全亮，淡出拖到延长结束才开始 ——
 * 表现就是"出场怎么调都没用、新字幕都入场两秒了它才消失"。
 */
function pf_markerGroup(layer) {
  try {
    var mp = layer.marker;
    if (mp && typeof mp.numKeys === "number") return mp;
  } catch (e) {}
  return null;
}

/** 读出本面板写入的标记文本（没有返回 null） */
function pf_readMarkerText(layer) {
  var mp = pf_markerGroup(layer);
  if (!mp) return null;
  var n = 0;
  try { n = mp.numKeys; } catch (e) { return null; }
  for (var i = 1; i <= n; i++) {
    var mv = null;
    try { mv = mp.key(i); } catch (e1) { continue; }
    if (!mv) continue;
    var c = "";
    try { c = String(mv.comment); } catch (e2) { continue; }
    if (c.indexOf(PF_SRT_MARK) === 0) return c;
  }
  return null;
}

/** 删掉本面板写的标记（用户自己的标记不动） */
function pf_removeOurMarkers(layer) {
  var mp = pf_markerGroup(layer);
  if (!mp) return;
  var n = 0;
  try { n = mp.numKeys; } catch (e) { return; }
  // 从后往前删，索引不会错位
  for (var i = n; i >= 1; i--) {
    var mv = null;
    try { mv = mp.key(i); } catch (e1) { continue; }
    var c = "";
    try { c = String(mv.comment); } catch (e2) { continue; }
    if (c.indexOf(PF_SRT_MARK) === 0) { try { mp.removeKey(i); } catch (e3) {} }
  }
}

function pf_getSrtOut(layer) {
  // ① 本次会话里已经算过 → 直接用
  if (layer.pf_srtOut !== undefined && layer.pf_srtOut !== null) return layer.pf_srtOut;

  // ② 工程里存的标记（跨会话）
  //    格式：_rinsub_out:出点                          （旧格式）
  //         _rinsub_out:出点|延长秒数                  （v1.07）
  //         _rinsub_out:出点|延长秒数|sx,sy            （放大基准）
  var m = pf_readMarkerText(layer);
  if (m) {
    var body = m.substring(PF_SRT_MARK.length).split("|");
    var v = parseFloat(body[0]);
    if (!isNaN(v)) {
      layer.pf_srtOut = v;
      if (body.length > 1) {
        var ex = parseFloat(body[1]);
        if (!isNaN(ex)) layer.pf_extendSec = ex;
      }
      if (body.length > 2) {
        var sc = String(body[2]).split(",");
        var sx = parseFloat(sc[0]), sy = parseFloat(sc[1]);
        if (!isNaN(sx) && !isNaN(sy)) layer.pf_scaleBase = [sx, sy];
      }
      return v;
    }
  }

  return null;
}

/**
 * 写入"原始出点"，同时记录**延长了多少秒**。
 *
 * 延长量要单独存：出场淡出就是在这段里完成的
 * （从延长第一帧开始，到延长结束刚好淡完）。
 *
 * 旧格式的标记只有出点、没有延长量，读出来时 extendSec 记为 0，
 * 出场会回退到面板设置 —— 不会出错，只是需要重新导入一次才有新行为。
 */
function pf_setSrtOut(layer, t, extendSec) {
  try { layer.pf_srtOut = t; } catch (e) {}
  if (extendSec !== undefined && extendSec !== null) {
    try { layer.pf_extendSec = extendSec; } catch (e1) {}
  }
  pf_writeSrtMarker(layer, t, extendSec, null);
}

/**
 * 把标记内容整体重写一遍。
 *
 * 三个字段：出点 | 延长秒数 | 放大基准（sx,sy）
 * 放大基准也放进来，是因为「持续放大」是**累乘**的 ——
 * 若每次都拿当前（已经被放大过的）值当基准，每点一次「一键生成」
 * 字幕就更大一圈。基准必须能跨会话留住。
 *
 * 参数传 null/undefined 时，沿用图层上已有的值。
 *
 * **写法要点**：必须通过标记组 `layer.marker.setValueAtTime(t, mv)`，
 * 不能写 `layer.marker = mv` —— 后者是给只读属性赋值，静默失败。
 * 标记写在图层入点处，位置本身不重要，只是个存储点。
 */
function pf_writeSrtMarker(layer, t, extendSec, scaleBase) {
  var e = (extendSec !== undefined && extendSec !== null) ? Number(extendSec) : pf_getExtendSeconds(layer);
  if (isNaN(e)) e = 0;

  var sb = null;
  if (scaleBase) {
    sb = scaleBase;
  } else if (layer.pf_scaleBase) {
    sb = layer.pf_scaleBase;
  }

  var txt = PF_SRT_MARK + t + "|" + e;
  if (sb) txt += "|" + sb[0] + "," + sb[1];

  var mp = pf_markerGroup(layer);
  if (!mp) return;

  // 先清掉旧的（同一个图层只留一个本面板标记），再写新的
  pf_removeOurMarkers(layer);

  var at = 0;
  try { at = layer.inPoint; } catch (e0) { at = 0; }

  try {
    var mv = new MarkerValue(txt);
    mp.setValueAtTime(at, mv);
  } catch (e3) {}
}

/** 读出这条字幕导入时被延长了多少秒（没有记录返回 0） */
function pf_getExtendSeconds(layer) {
  if (layer.pf_extendSec !== undefined && layer.pf_extendSec !== null) {
    return Number(layer.pf_extendSec) || 0;
  }
  // 触发一次标记解析，顺便把延长量读出来
  pf_getSrtOut(layer);
  var v = Number(layer.pf_extendSec);
  return isNaN(v) ? 0 : v;
}

/**
 * 这条字幕的"该结束时刻" T（SRT 原始出点）。
 * 处理过就有记录；没有（例如只点「应用动画」）就用当前出点。
 */
function pf_layerExitStart(layer) {
  var v = pf_getSrtOut(layer);
  return (v !== null) ? v : layer.outPoint;
}

/**
 * 出场。**所有出场动画都从这里进来**，所以整层渐隐是必然有的 ——
 * 不需要每个动画各写一遍（项目强制约束，见 pf_layerFade 的说明）。
 */
function pf_exitOnLayer(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;

  if (opts.exitBasedOn === "sentence") {
    // 句子模式：逐行柔和淡出（和入场同一套实现，方向相反）
    pf_sentenceLineFade(layer, opts, true);
    return;
  }

  // 淡出**从 T（本该结束的时刻）开始**，在面板设定的出场时长内走完。
  // 不能用 outP - d 倒推：出点已经被延后了 d 秒，
  // 那样算出来的起点会比 T 更早，字幕会提前开始变淡。
  var d = pf_exitFadeSeconds(opts, layer);
  var t0 = pf_layerExitStart(layer);
  var t1 = t0 + d;

  // 淡出需要的时间比图层剩下的时间长 → **延长出点**，而不是压缩淡出。
  //
  // 这里原来写的是 `if (t1 > outP) { t1 = outP; ... }`，等于把淡出时长
  // 硬压到所剩无几（最坏只剩 0.03 秒），表现就是"一下子就没了"。
  // 用户设了 1.5 秒的出场，就应该真用 1.5 秒。
  if (t1 > outP) {
    try { layer.outPoint = t1; outP = t1; } catch (eOut) {}
  }

  // ---- ① 整层渐隐：强制，和出场动画同一时间窗口 ----
  // 放在逐字动画之前，任何出场动画（含以后新增的）都会经过这里。
  pf_forceExitFade(layer, opts, t0, t1);

  var a = pf_addAnimator(layer, opts.exitBasedOn === "word" ? 3 : 1);
  var opacity = pf_addProp(a.props, ["ADBE Text Opacity"]);
  if (opacity) opacity.setValue(0);
  if (opts.exitMoveY && a.props) {
    var p = pf_addProp(a.props, ["ADBE Text Position 3D", "ADBE Text Position"]);
    if (p) p.setValue([0, opts.exitMoveY, 0]);
  }
  // **匀速消失**：不用 pf_ease，改用线性插值。
  // 缓动会让开头慢、结尾快，看起来像"先挂着不动、最后一哆嗦就没了"；
  // 线性则是从延长的第一帧开始，均匀地一路淡到底。
  var e = pf_selProp(a.sel, "ADBE Text Percent End");
  if (e) { e.setValueAtTime(t0, 0); e.setValueAtTime(t1, 100); pf_linear(e); }

  // 同理：没选择器的话动画器会选中全部字符 → 整句提前消失，直接删掉
  if (!opacity || !e) { if (a && a.animator) { try { a.animator.remove(); } catch (e7) {} } }
}


/* ---------------------- 持续放大 + 黑底动画 ---------------------- */

/**
 * 整条字幕生命周期内持续放大，同时字间距慢慢拉开。
 *
 * **放大从入场开始（inPoint），一直到出点结束（outPoint）** ——
 * 覆盖字幕的整段显示时间，入场、停留、出场全程都在缓慢变大。
 *
 * 幅度在面板数值上再乘 1.6，让变化更容易察觉：
 * 面板写 5 → 实际约 8%；写 12 → 约 19%。
 *
 * 字距和缩放共用同一段时间轴、同一个缓动 —— 字号变大的同时字距也放开，
 * 整体是"舒展开"，而不是单纯把字放大挤在一起。
 */
function pf_applyScale(layer, opts) {
  var inP = layer.inPoint, outP = layer.outPoint;
  if (outP <= inP) return;

  var g = (opts.growAmount === undefined) ? 5 : opts.growAmount;
  if (g <= 0) return;

  // 放大覆盖**整条字幕的显示时间**：入场开始 → 出场结束。
  // 不要在入场结束时才开始，那样入场过程是静止的。
  var growStart = inP;

  var sc = layer.property("ADBE Transform Group").property("ADBE Scale");

  // 基准缩放：**第一次执行时记下来，之后一直用它**。
  //
  // 不能每次读 sc.value 当基准 —— 关键帧刚被清掉时，属性值停在
  // "上次放大到的值"（比如 119%），再乘一次放大倍数，每点一次「一键生成」
  // 字幕就更大一圈。基准存进图层标记，跨会话也在。
  var v;
  if (layer.pf_scaleBase) {
    v = layer.pf_scaleBase;
  } else {
    v = sc.value;
    var snapshot = [];
    for (var b = 0; b < v.length; b++) snapshot.push(Number(v[b]));
    try { layer.pf_scaleBase = snapshot; } catch (eSB) {}
    // 立刻写进标记，否则关掉 AE 再开基准就丢了
    var t0ForMark = pf_getSrtOut(layer);
    if (t0ForMark !== null) {
      pf_writeSrtMarker(layer, t0ForMark, null, snapshot);
    }
  }
  var base = [], end = [];

  // 实际放大倍数：在面板数值上再放大 1.6 倍，让变化更容易察觉。
  var factor = 1 + (g * 1.6) / 100;
  for (var i = 0; i < v.length; i++) {
    base.push(v[i]);
    end.push(v[i] * factor);
  }

  try {
    sc.setValueAtTime(growStart, base);
    sc.setValueAtTime(outP, end);
    // 匀速放大：整段时间里变化是均匀的，任何时刻看都在缓慢变大
    pf_linear(sc);
  } catch (e) {}

  // ---- 字间距同步拉开 ----
  // 和缩放用同一段时间轴、同一个节奏。
  //
  // 注意：用户勾了「间距」时，pf_trackingOnLayer 已经加过一个常量 Tracking；
  // pf_applyGrowTracking 内部会复用它、在它基础上打关键帧，
  // 不会另加动画器（AE 里多个 Tracking 会累加，导致字距翻倍）。
  pf_applyGrowTracking(layer, opts, growStart, outP, g);
}

/**
 * 放大过程中字间距从 0 拉到目标值。
 *
 * 用独立的 Tracking Amount 动画器，只做"额外增加"的量，
 * 不覆盖面板上「间距」组件已经设好的基础值 ——
 * 两个动画器的 Tracking 是**相加**的，所以基础间距仍然保留。
 */
function pf_applyGrowTracking(layer, opts, t0, t1, growPct) {
  // 拉开量跟着放大比例走：放大越多，字距拉得越开。
  // 每放大 1% → 增加 0.6 个单位（AE 里 1 个单位 ≈ 1/1000 em，视觉上很轻微）。
  var extra = growPct * 0.6;
  if (extra <= 0) return;

  // 已有 Tracking 动画器（用户勾了「间距」）→ **把它改成带关键帧的**，
  // 而不是另加一个。AE 里多个动画器的 Tracking 会累加，叠两个就翻倍了。
  var existing = pf_findTrackingProp(layer);
  if (existing) {
    // 基础值保持在 t0，之后逐渐加上拉开量 —— 原有间距不丢，只是慢慢变宽
    var baseVal = 0;
    try { baseVal = Number(existing.value) || 0; } catch (e0) { baseVal = 0; }
    try {
      existing.setValueAtTime(t0, baseVal);
      existing.setValueAtTime(t1, baseVal + extra);
      pf_ease(existing);
    } catch (e1) {}
    return;
  }

  var a = pf_addAnimator(layer, 1);          // 1 = 按字符
  if (!a || !a.animator || !a.props) {
    if (a && a.animator) { try { a.animator.remove(); } catch (e2) {} }
    return;
  }
  var tr = pf_addProp(a.props, ["ADBE Text Tracking Amount"]);
  if (!tr) { try { a.animator.remove(); } catch (e3) {} return; }

  try {
    tr.setValueAtTime(t0, 0);
    tr.setValueAtTime(t1, extra);
    pf_ease(tr);
  } catch (e4) {}
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

/** 读图层当前的文字填充色，返回 "#rrggbb"（读不到就返回 null） */
function pf_readTextFill(layer) {
  try {
    var td = pf_getTextDocProp(layer).value;
    if (!td) return null;
    var c = td.fillColor;
    if (!c || c.length < 3) return null;
    function hx(v) {
      var n = Math.max(0, Math.min(255, Math.round(Number(v) * 255)));
      return ("0" + n.toString(16)).slice(-2);
    }
    return "#" + hx(c[0]) + hx(c[1]) + hx(c[2]);
  } catch (e) { return null; }
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

/** HSL -> [r,g,b]（0~1）。彩带要从一个底色派生出几档相近的颜色 */
function pf_hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  function hue(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  if (s === 0) return [l, l, l];
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

/** [r,g,b] 0~1 -> {h,s,l} */
function pf_rgb2hsl(rgb) {
  var r = rgb[0], g = rgb[1], b = rgb[2];
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  var h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  var l = (mx + mn) / 2;
  var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: h, s: s, l: l };
}

/** 给选择器设置一个"匀速循环 + 相位偏移"的 Offset 表达式 */
function pf_flowOffsetExpr(off, inP, period, phase, repeat) {
  // repeat = 一个周期内扫过几轮（多留白时扫得更密一点）
  try {
    off.expression =
      "var s = " + inP + ", per = " + period + ";\n" +
      "var t = time - s; if (t < 0) t = 0;\n" +
      "var v = (t / per) * 100 * " + repeat + " + " + phase + ";\n" +
      "v % 100;\n";
  } catch (e) {}
}

/** 给选择器补一组关键帧（表达式被关掉时也能动） */
function pf_flowOffsetKeys(off, inP, outP, period, phase, repeat) {
  try {
    var span = Math.max(0.05, period);
    var dur = outP - inP;
    var loops = Math.max(1, Math.ceil(dur / span) + 1);
    for (var i = 0; i <= loops; i++) {
      var t = inP + i * span;
      if (t > outP) t = outP;
      var v = (i * 100 * repeat + phase) % 100;
      off.setValueAtTime(t, v);
      if (t >= outP) break;
    }
    var kn = off.numKeys;
    for (var k = 1; k <= kn; k++) {
      try {
        off.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      } catch (eK) {}
    }
  } catch (e) {}
}

/**
 * 在图层上挂一条「流光带」：宽度 band（占整句 %），颜色 rgb，相位 phase。
 * 返回是否创建成功。
 */
function pf_addFlowBand(layer, rgb, band, phase, period, repeat) {
  var a = pf_addAnimator(layer, 1);                 // 按字符
  if (!a.animator || !a.props || !a.sel) {
    if (a.animator) { try { a.animator.remove(); } catch (e0) {} }
    return false;
  }

  var fc = pf_addProp(a.props, ["ADBE Text Fill Color"]);
  if (!fc) { try { a.animator.remove(); } catch (e1) {} return false; }
  try { fc.setValue(rgb); } catch (e2) {}

  pf_setOn(a.sel, "ADBE Text Percent Start", 0);
  pf_setOn(a.sel, "ADBE Text Percent End", Math.max(1, Math.min(100, band)));

  // 晕染用 Smooth(6)：两端自然淡出，才有水彩渗开的感觉
  var pShape = pf_deepProp(a.sel, "ADBE Text Range Shape", 0);
  if (pShape) {
    try { pShape.setValue(6); } catch (e3) {
      try { pShape.setValue(4); } catch (e3b) {}
    }
  }

  var off = pf_selProp(a.sel, "ADBE Text Percent Offset");
  if (!off) { try { a.animator.remove(); } catch (e4) {} return false; }

  var inP = layer.inPoint, outP = layer.outPoint;
  pf_flowOffsetExpr(off, inP, period, phase, repeat || 1);
  pf_flowOffsetKeys(off, inP, outP, period, phase, repeat || 1);

  return true;
}

/**
 * 全范围晕染留白：多条白色留白同时扫过。
 *
 * 注意：这个用 Text Animator 实现，是**按字符**推进的，所以多行字幕
 * 会一行一行地扫（彩带用下面的分形噪波方案，才能两行同时染色）。
 */
function pf_flowMultiBands(layer, rgb, count, period) {
  if (count < 1) count = 1;
  if (count > 6) count = 6;

  var gap = 100 / count;
  var band = Math.max(6, gap * 0.62);
  var repeat = Math.max(1, Math.round(100 / gap));

  var ok = 0;
  for (var i = 0; i < count; i++) {
    if (pf_addFlowBand(layer, rgb, band, i * gap, period, repeat)) ok++;
  }
  return ok > 0;
}

/* ==================================================================
 *  彩带 —— 用分形噪波做（参考 Sapphire 的 S_TextureFlux）
 *
 *  为什么不用 Text Animator：
 *    Text Animator 是按**字符下标**选范围，多行字幕会一行扫完再扫下一行。
 *    S_TextureFlux / Fractal Noise 是**按屏幕位置**生成噪波，
 *    所以整块字幕（不管几行）是同时被同一个场覆盖的 —— 这才是"大范围染色"。
 *
 *  AE 内置等价实现（不需要 Sapphire）：
 *    ① 在**调整图层**上加 Fractal Noise，得到流动的分形场
 *    ② 用 Tint 把灰度场映射成 [文字色 → 白色] 两色
 *    ③ 用 Set Matte，以字幕图层的 Alpha（或用 Tracker）当遮罩
 *    ④ 调整图层的混合模式设为 "屏幕" / "相加"，叠在字幕上
 *
 *  为了不依赖 MoCha，这里走更稳的路子：**直接给文字图层加 Fractal Noise +
 *  Tint，然后靠文字自身的 Alpha 限制范围**（文字图层上的效果天然只作用于字形）。
 * ================================================================== */

/** Fractal Noise 的标准参数名（中英文） */
var PF_FN_KEYS = {
  contrast:    ["Contrast", "对比度"],
  brightness:  ["Brightness", "亮度"],
  transformZ:  ["Transform", "变换"],       // 变换子组里有缩放
  complexity:  ["Complexity", "复杂度"],
  evolution:   ["Evolution", "演化"],
  subScale:    ["Scale", "缩放"],
  opacity:     ["Opacity", "不透明度"]
};

/** 用「按名字找 + 递归」定位 Fractal Noise 里的某个参数 */
function pf_fnProp(eff, key) {
  var names = PF_FN_KEYS[key] || [];
  for (var n = 0; n < names.length; n++) {
    var p = pf_deepProp(eff, names[n], 0);
    if (p) return p;
  }
  return null;
}

/**
 * 给图层加「彩带」（分形噪波染色）。
 *
 *  textHex —— 这一句的文字色（紫色那条 = Color0，跟随用户设定的字体颜色）
 *  opts    —— { period, blankCount }
 *
 * 返回是否成功。
 */
function pf_ribbonFlux(layer, textHex, opts, mode) {
  var inP = layer.inPoint, outP = layer.outPoint;
  if (outP <= inP) return false;

  mode = mode || "ribbon";

  var f = (opts && opts.flow) ? opts.flow : {};
  var period = (f.period === undefined || f.period === null || f.period <= 0) ? 5 : f.period;
  if (period < 0.5) period = 0.5;

  var count = Math.round((f.blankCount === undefined || f.blankCount === null) ? 3 : f.blankCount);
  if (count < 2) count = 2;
  if (count > 6) count = 6;

  // ① 分形噪波
  var fn = null;
  try { fn = layer.Effects.addProperty("ADBE Fractal Noise"); } catch (e0) { fn = null; }
  if (!fn) {
    try { fn = layer.Effects.addProperty("Fractal Noise"); } catch (e1) { fn = null; }
  }
  if (!fn) return false;

  // 噪波类型：Soft Linear(1) 柔和云状，适合晕染；Basic(1) 也是柔和款
  try {
    var pType = pf_deepProp(fn, "Fractal Type", 0);
    if (pType) pType.setValue(1);
  } catch (e2) {}

  // 各模式的场参数 —— 决定"留白/光带"的粗细与锐利程度
  //   band     光带  ：高对比 + 窄带，颜色扫过感强
  //   wash     晕染留白：低对比 + 宽而软，一段大留白
  //   fullwash 全范围   ：中对比 + 多处
  //   ribbon   彩带    ：中对比 + 弯曲多带
  var tune = {
    band:     { contrast: 220, brightness: -20, scaleBase: 260, complexityAdd: 0 },
    wash:     { contrast:  90, brightness:   0, scaleBase: 420, complexityAdd: -2 },
    fullwash: { contrast: 150, brightness:  -5, scaleBase: 220, complexityAdd: 1 },
    ribbon:   { contrast: 170, brightness: -10, scaleBase: 220, complexityAdd: 1 }
  }[mode] || { contrast: 160, brightness: -10, scaleBase: 220, complexityAdd: 1 };

  try {
    var pCon = pf_fnProp(fn, "contrast");
    if (pCon) pCon.setValue(tune.contrast);
    var pBri = pf_fnProp(fn, "brightness");
    if (pBri) pBri.setValue(tune.brightness);
  } catch (e3) {}

  try {
    var pCpx = pf_fnProp(fn, "complexity");
    if (pCpx) pCpx.setValue(Math.max(1, Math.min(10, count + tune.complexityAdd)));
  } catch (e4) {}

  // 缩放：控制条纹粗细 —— 留白处数越多，单个带越窄
  try {
    var pScale = pf_deepProp(fn, "Scale", 0);
    if (pScale) {
      var sc = Math.max(30, Math.min(500, tune.scaleBase / Math.max(1, count / 3)));
      pScale.setValue([sc, sc]);
    }
  } catch (e5) {}

  // ② 流动驱动
  //
  //  彩带要的是"看着很快、其实位移很小"的那种海面流动感：
  //    · Evolution 高速推进 → 纹理内部不断翻滚、流动感强
  //    · Offset Turbulence 只做**极小的漂移** → 整体位置几乎不动
  //  这样就是"走得很慢，但看起来很快"。
  //
  //  其余模式用匀速平移的演化即可。
  var evo = pf_fnProp(fn, "evolution");
  if (evo) {
    try {
      if (mode === "ribbon") {
        // 每个周期转 2 整圈（速度感强），且**匀速**，不会忽快忽慢
        evo.expression =
          "var s = " + inP + ", per = " + period + ";\n" +
          "var t = time - s; if (t < 0) t = 0;\n" +
          "(t / per) * 360 * 2;\n";
        evo.setValueAtTime(inP, 0);
        evo.setValueAtTime(outP, 720 * Math.max(1, outP > inP ? (outP - inP) / period : 1));
      } else {
        evo.expression =
          "var s = " + inP + ", per = " + period + ";\n" +
          "var t = time - s; if (t < 0) t = 0;\n" +
          "(t / per) * 360 * " + Math.max(1, count) + ";\n";
        evo.setValueAtTime(inP, 0);
        evo.setValueAtTime(outP, 360 * Math.max(1, count));
      }
      try {
        var kn = evo.numKeys;
        for (var i = 1; i <= kn; i++) {
          evo.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
      } catch (eK) {}
    } catch (e6) {}
  }

  // 彩带：Offset Turbulence 做极小漂移 —— 位置几乎不动，只有纹理在滚
  if (mode === "ribbon") {
    try {
      var pOff = pf_deepProp(fn, "Offset Turbulence", 0);
      if (pOff) {
        // 漂移幅度很小（±8%），但来回摆动，像水面缓慢起伏
        pOff.expression =
          "var s = " + inP + ", per = " + period + ";\n" +
          "var t = time - s; if (t < 0) t = 0;\n" +
          "var ph = (t / per) * 2 * Math.PI;\n" +
          "var dx = Math.sin(ph) * 8;\n" +
          "var dy = Math.cos(ph * 0.7) * 6;\n" +
          "value + [dx, dy];\n";
      }
    } catch (eOff) {}
  }

  // ③ Tint：把灰度场映射成两色
  //     光带   → 暗部=白（底色），亮部=文字色（彩色光带扫过）
  //     其余   → 暗部=文字色（染色主体），亮部=白（留白）
  var tint = null;
  try { tint = layer.Effects.addProperty("ADBE Tint"); } catch (e7) { tint = null; }
  if (tint) {
    var textRgb = pf_hex2rgb(textHex || "#ffffff");
    var white   = [1, 1, 1];
    var darkRgb  = (mode === "band") ? white   : textRgb;
    var lightRgb = (mode === "band") ? textRgb : white;
    pf_setProp(tint, ["Map Black To", "黑色映射到", 1], darkRgb);
    pf_setProp(tint, ["Map White To", "白色映射到", 2], lightRgb);
    pf_setProp(tint, ["Amount to Tint", "着色量", 3], 100);
  }

  return !!tint;
}

/**
 * 流光：让颜色在文字上像水一样流动。四种模式（mode）：
 *
 *  band（光带）：底色转白，一条【彩色】光带循环扫过 —— 颜色像光一样淌过去
 *  wash（晕染留白）：底色就是【文字色】，动画器刷【白色】，一段柔和的留白滑过
 *                    —— 整句都被晕染了，只有一部分留白（视频里的那种）
 *  fullwash（全范围晕染留白）：同上，但**3~6 处留白**同时扫过（不是整句变白）
 *  ribbon（彩带）：同上，但每处留白做成**弯曲的长条**，像缎带淌过，边界更柔
 *
 * 手法和原版一致：Text Animator 的「填充色」+ Range Selector 的 Percent Offset 循环。
 * 选择器窗口取一块带宽，Offset 从 0 推到 100 来回滚，窗口就不断往前跑，无缝循环。
 * 形状用 Smooth(6)：S 型平滑衰减 → 颜色一点点渗进去，水彩晕染感。
 *
 * color：这一条字幕的颜色（跟文字颜色同步，随机模式下每条不同）
 */
function pf_flowOnLayer(layer, opts, color, mode, layerIndex) {
  var f = (opts && opts.flow) ? opts.flow : {};
  if (!f.enabled) return false;

  // 第 2 页的模式来自多个独立开关，可能同时勾选多种。
  //   · flow.random = true  → 每条字幕从 modes 里随机取一个
  //   · flow.random = false → 用第一个勾选的模式
  var modes = f.modes;
  if (modes && modes.length) {
    if (f.random && modes.length > 1) {
      var pick = (layerIndex === undefined || layerIndex === null) ? 0 : Math.abs(layerIndex) % modes.length;
      mode = modes[pick];
    } else if (!mode || modes.indexOf(mode) < 0) {
      mode = modes[0];
    }
  }

  mode = (mode === "wash" || mode === "fullwash" || mode === "ribbon") ? mode : "band";

  var inP = layer.inPoint, outP = layer.outPoint;
  if (outP <= inP) return false;

  // 周期：默认 5 秒走完一趟（慢一点，能看出在动就够了，不必急着走完）
  var period = (f.period === undefined || f.period === null || f.period <= 0) ? 5 : f.period;
  if (period < 0.5) period = 0.5;

  // 留白/彩带的数量（面板可调，默认 3）
  var count = (f.blankCount === undefined || f.blankCount === null) ? 3 : Math.round(f.blankCount);
  if (count < 2) count = 2;
  if (count > 6) count = 6;

  // ---- 四种模式统一走分形噪波 ----
  // 为什么不再用 Text Animator：它是按**字符下标**选范围，
  // 多行字幕会一行扫完再扫下一行。分形噪波按**屏幕位置**生成场，
  // 整块字幕（不管几行）是同时被覆盖的 —— 这才是"多行同时染色"。
  if (pf_ribbonFlux(layer, color, opts, mode)) return true;

  // ---- 兜底：分形噪波加不上时，退回 Text Animator（会是逐行扫）----
  return pf_flowLegacy(layer, opts, color, mode, period, count);
}

/** 旧实现（Text Animator），仅在分形噪波不可用时兜底 */
function pf_flowLegacy(layer, opts, color, mode, period, count) {
  var f = (opts && opts.flow) ? opts.flow : {};
  var inP = layer.inPoint, outP = layer.outPoint;

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

/**
 * 波浪（AE 原生 Wave Warp）。
 *
 * AE 里这个效果的参数顺序是**固定**的：
 *   1 波形类型 Wave Type
 *   2 波高     Wave Height
 *   3 波宽     Wave Width
 *   4 方向     Direction
 *   5 波速     Wave Speed      ← 注意是 5，不是 4
 *   6 固定     Pinning         ← 注意是 6，不是 5
 *   7 相位     Phase
 *   8 抗锯齿   Antialiasing
 *
 * 之前把「波速」写成索引 4、「固定」写成 5，结果：
 *   0.4 被写进了**方向**（变成 0.4°，几乎等于不动），
 *   1 被写进了**波速** —— 波形参数全错，动画自然不对。
 *
 * 现在按**名字优先 + 正确索引兜底**写入，中英文都能认。
 */
function pf_waveOnLayer(layer, opts) {
  var w = opts.wave || {};
  if (!w.enabled) return;

  var eff = null;
  try { eff = layer.Effects.addProperty("ADBE Wave Warp"); } catch (e0) { eff = null; }
  if (!eff) return;

  var height = (w.height === undefined) ? 4   : w.height;
  var width  = (w.width  === undefined) ? 400 : w.width;
  var speed  = (w.speed  === undefined) ? 0.4 : w.speed;

  // 先按名字写（最可靠），名字认不出再按正确索引兜底
  function put(names, idx, value) {
    var p = null;
    try { p = eff.property(names[0]); } catch (e1) { p = null; }
    for (var i = 1; i < names.length && !p; i++) {
      try { p = eff.property(names[i]); } catch (e2) { p = null; }
    }
    if (!p) {
      try { p = eff.property(idx); } catch (e3) { p = null; }
    }
    if (!p) return false;
    return pf_setNumChecked(p, value);
  }

  put(["Wave Height", "波高", "波浪高度"], 2, height);
  put(["Wave Width", "波宽", "波浪宽度"], 3, width);
  put(["Wave Speed", "波速", "波浪速度"], 5, speed);      // ← 正确索引 5
  put(["Pinning", "固定", "固定边缘", "固定邊緣"], 6, 1);  // ← 正确索引 6，1 = All Edges

  // 波形类型用 Sine（柔和），不硬写：有的版本没有这个参数
  try {
    var pType = eff.property("Wave Type");
    if (pType && w.type !== undefined) pType.setValue(w.type);
  } catch (e4) {}
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

/**
 * 这个效果是不是"发光"（Deep Glow 2 或 AE 自带 Glow）。
 *
 * 关键：先看 matchName（权威），只有拿不到 matchName 时才退回名字关键字。
 * 而且**必须排除投影** —— 投影的名字里可能带"发光"字样（比如"投影1-发光前"），
 * 只按名字关键字判断会把投影误当成发光删掉 / 抄走。
 */
function pf_isGlowEffect(e) {
  var mn = "", nm = "";
  try { mn = String(e.matchName); } catch (e0) { mn = ""; }
  try { nm = String(e.name).toLowerCase(); } catch (e1) { nm = ""; }

  if (mn === "ADBE Drop Shadow") return false;      // 投影，永远不是发光
  if (mn === "ADBE Glo2" || mn === "PEDG") return true;

  // 名字里明确写着"投影"的也不是发光
  if (nm.indexOf("投影") >= 0 || nm.indexOf("shadow") >= 0) return false;
  return nm.indexOf("deep glow") >= 0 || nm.indexOf("deepglow") >= 0 ||
         nm.indexOf("glow") >= 0 || nm.indexOf("发光") >= 0;
}

/** 图层上是否已经有发光效果 */
function pf_hasGlow(layer) {
  try {
    var fx = layer.Effects;
    for (var k = 1; k <= fx.numProperties; k++) {
      if (pf_isGlowEffect(fx.property(k))) return true;
    }
  } catch (e2) {}
  return false;
}

/** 删掉图层上已有的发光效果，重建效果链前先清场 */
function pf_removeGlow(layer) {
  try {
    var fx = layer.Effects;
    for (var k = fx.numProperties; k >= 1; k--) {
      var e = fx.property(k);
      if (pf_isGlowEffect(e)) { try { e.remove(); } catch (e2) {} }
    }
  } catch (e3) {}
}

/**
 * 把值写成"开关打开"。
 *
 * AE 里效果复选框是 **OneD（0/1 数值）**，不是布尔 —— 所以要**先写 1**。
 * 写 true 在某些版本上会被接受但存成布尔，读回来不是数字，
 * 后续判断和面板显示都可能出问题。
 */
function pf_enableFlag(p) {
  if (!p) return false;
  var tries = [1, true];
  for (var i = 0; i < tries.length; i++) {
    try {
      p.setValue(tries[i]);
    } catch (e) { continue; }          // 这个类型不接受，试下一个
    var v = null;
    try { v = p.value; } catch (eR) { v = null; }
    // 读不出来（某些属性 value 抛异常）算成功 —— 写没报错就是写进去了
    if (v === null || v === 1 || v === true) return true;
  }
  return false;
}

/** 判断一个属性是不是"开关"（AE 里效果复选框是 0/1 数值，靠名字认） */
function pf_isToggle(p) {
  try {
    if (p.value === true || p.value === false) return true;
  } catch (e2) {}
  var nm = "";
  try { nm = String(p.name).toLowerCase(); } catch (e) { nm = ""; }
  return nm.indexOf("enable") >= 0 || nm.indexOf("启用") >= 0 ||
         nm.indexOf("开关") >= 0 || nm === "on" || nm.indexOf("turn on") >= 0;
}

/**
 * Deep Glow 2 的颜色控制在 **Style → Tint** 子组里，结构是：
 *
 *   Style → Tint
 *     ├ Enable   [✓]          开关
 *     ├ Color    [紫]         颜色
 *     ├ Mode     [Soft Light] 混合模式
 *     └ Mix      [100.00%]    混合强度
 *
 * 要点（这几条缺一个，单独调色就不生效）：
 *   ① Enable 必须打开
 *   ② Color 写目标色
 *   ③ Mix 必须拉到 100%（默认可能不是满的）
 *   ④ Mode 用 **Soft Light** —— 它会把颜色"染"到底下的发光上，
 *      而不会像 Normal 那样直接把辉光盖成一块纯色
 *
 * 参数名各版本不同（Color / 颜色、Mix / 混合），所以按名字 + 位置双重匹配。
 */
var PF_TINT_MODE_SOFTLIGHT = 3;   // Deep Glow 的混合模式下拉框里 Soft Light 的值

/**
 * 读一个属性的名字（name 读不到就退回 matchName），统一转小写。
 * 实测汉化版里 name 有时会抛异常，所以两个都试。
 */
function pf_propNameLower(p) {
  var s = "";
  try { s = String(p.name); } catch (e) {}
  if (!s) { try { s = String(p.matchName); } catch (e2) {} }
  return s.toLowerCase();
}

/**
 * 精确定位 Tint 的四个参数：Enable / Color / Mode / Mix。
 *
 * **为什么不能在整个组里按名字找**（v0.41 的教训）：
 * 实测 Deep Glow v1.6.6 里，`numProperties` 对 `Style`、`Tint` 这类分组
 * 一律返回 0 —— 整棵属性树在脚本看来是**扁平**的。
 * 于是"回到父组找 Enable"找到的是**别的分组的同名开关**
 * （色差有 Enable、宽高比有 Enable Angle…），
 * 结果 Color 能写进去（全效果只有这一个），Enable/Mode/Mix 全写到了错误的地方，
 * 表现就是"颜色变了，但 Tint 开关还是没勾上"。
 *
 * 正确做法：**以 Color 的下标为锚点，只在它前后 3 格内找邻居**。
 * 实测布局是 `… Tint, Enable, Color, Mode, Mix …`，
 * 因此 Enable 在 Color 前 1 格，Mode / Mix 在后 1、2 格。
 * 名字能读到就按名字校验，读不到就按位置兜底。
 *
 * 返回 { group, color, enable, mode, mix }，找不到颜色返回 null。
 */
function pf_resolveTintProps(group) {
  if (!group) return null;

  var n = 0;
  try { n = group.numProperties; } catch (e) { return null; }
  if (!n) return null;

  // ---- 锚点：找到颜色属性 ----
  var ci = 0, colorProp = null;
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e1) { continue; }
    if (!p) continue;
    var isColor = false;
    try { isColor = (p.propertyValueType === PropertyValueType.COLOR); } catch (e2) {}
    if (isColor) { ci = i; colorProp = p; break; }
  }
  if (!ci) return null;

  function at(idx) {
    if (idx < 1 || idx > n) return null;
    try { return group.property(idx); } catch (e) { return null; }
  }

  /**
   * 在 Color 前后 3 格内按名字找，找不到就用固定偏移兜底。
   *
   * `avoid` 是**必须排除**的词 —— 汉化版里这一条是刚需：
   * 风格下面的「混合模式」(Blend Mode) 同时含「混合」和「模式」，
   * 不排除的话 Mode 和 Mix 两个槽位会抢到同一个属性，
   * Mix 被写成 100 就等于把混合模式改成了别的值。
   */
  function near(keys, defOffset, avoid) {
    function hit(p) {
      var nm = p ? pf_propNameLower(p) : "";
      if (!nm) return false;
      if (avoid) {
        for (var v = 0; v < avoid.length; v++) {
          if (nm.indexOf(avoid[v]) >= 0) return false;
        }
      }
      for (var k = 0; k < keys.length; k++) {
        if (nm.indexOf(keys[k]) >= 0) return true;
      }
      return false;
    }

    // 先按"离 Color 最近"的顺序扫，避免远一点的重名属性抢先
    for (var d = 1; d <= 3; d++) {
      var a = at(ci - d), b = at(ci + d);
      if (hit(a)) return a;
      if (hit(b)) return b;
    }
    return at(ci + defOffset);
  }

  // 中文界面下 Tint 组叫「色调」：
  //   启用 / 颜色 / 模式 / 混合
  // Mix 必须排除「模式」——否则会抓到「混合模式」
  return {
    group:  group,
    color:  colorProp,
    enable: near(["enable", "启用", "开关", "on"], -1),
    mode:   near(["mode", "模式", "blend"], 1),
    mix:    near(["mix", "amount", "混合", "数量", "强度"], 2, ["模式", "mode", "blend"])
  };
}

/**
 * 找到 Deep Glow 的颜色属性**所在的组**。
 *
 * 为什么不按组名找 "Tint"：实测 Deep Glow v1.6.6 上，
 * 有些节点的 numProperties 读不准，按名字找组会直接失败
 * （调试输出里能看到 Tint 的属性能被列出来，但 findTint 返回"未找到"）。
 *
 * 换个思路：Deep Glow 里**只有一个颜色属性**（就是 Tint → Color），
 * 所以"找到颜色属性，它所在的组就是 Tint"—— 完全不依赖组名。
 */
function pf_findGlowColorGroup(group, depth) {
  if (!group) return null;
  if (depth === undefined) depth = 0;
  if (depth > 8) return null;

  var n = 0;
  try { n = group.numProperties; } catch (e) { return null; }

  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e1) { continue; }
    if (!p) continue;

    var isColor = false;
    try { isColor = (p.propertyValueType === PropertyValueType.COLOR); } catch (e2) {}
    if (isColor) return group;                 // 颜色所在的这一层就是 Tint

    var kids = 0;
    try { kids = p.numProperties; } catch (e3) { kids = 0; }
    if (kids > 0) {
      var r = pf_findGlowColorGroup(p, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function pf_enableDeepGlowTint(tintGroup, rgb) {
  var t = pf_resolveTintProps(tintGroup);
  if (!t) return false;

  var setColor = false;

  // ① Enable —— **必须打开**，这是单独调色生效的前提。
  //    先写 1（AE 的复选框就是 OneD 0/1），读回不对再试 true。
  var enabled = false;
  if (t.enable) {
    enabled = pf_enableFlag(t.enable);
    if (!enabled) {
      try { t.enable.setValue(1); enabled = (pf_readNum(t.enable) === 1); } catch (e0) {}
    }
  }

  // ② Color
  if (t.color) {
    try { t.color.setValue(rgb); setColor = true; } catch (e5) {}
  }

  // ③ Mix 拉满（0~1 刻度写 1，百分比刻度写 100）
  if (t.mix) {
    var cur = pf_readNum(t.mix);
    if (cur !== null) pf_setNumChecked(t.mix, (Math.abs(cur) <= 1.0001) ? 1 : 100);
  }

  // ④ Mode → Soft Light（枚举值因版本而异，读回不对就依次退）
  if (t.mode) {
    var tries = [PF_TINT_MODE_SOFTLIGHT, 3, 4, 2];
    for (var m = 0; m < tries.length; m++) {
      try {
        t.mode.setValue(tries[m]);
        var got = pf_readNum(t.mode);
        if (got !== null && Math.abs(got - tries[m]) < 0.5) break;
      } catch (e8) {}
    }
  }

  return setColor && enabled;
}

/**
 * 关闭 Tint —— 文字不是白色时用。
 * 关掉 Tint 后，Deep Glow 会直接吃文字本身的颜色，也就是"跟随文字颜色"。
 */
function pf_disableDeepGlowTint(tintGroup) {
  // 只关 Tint 自己的那个 Enable。
  // 之前是"把组里所有像开关的属性都关掉"，在扁平树的环境下会连带
  // 色差 / 宽高比 / 取消预乘等功能一起关掉，副作用太大。
  var t = pf_resolveTintProps(tintGroup);
  if (!t || !t.enable) return false;
  try { t.enable.setValue(0); return true; } catch (e1) {
    try { t.enable.setValue(false); return true; } catch (e2) {}
  }
  return false;
}

/* ---------------- Deep Glow 2 参数写入 ---------------- */

/**
 * Deep Glow 2 的参数关键字表 —— **英文 + 中文都要有**。
 *
 * 关键教训：官方版参数名是英文（Radius / Exposure），
 * 但国内常见的汉化版会把名字改成中文（半径 / 曝光）。
 * 只匹配英文的话，汉化版上一个都写不进去，AE 就停在 Deep Glow 自己的默认值上
 * —— 表现就是"面板设了 200，效果里还是 500"。
 *
 * 匹配时 name 和 matchName 都会查：matchName 不随语言变，是更可靠的依据。
 * 顺序也有讲究 —— 更具体的词放前面，避免"强度"误配到"混合强度"之类。
 */
var PF_DG_KEYWORDS = [
  ["threshold", ["threshold", "阈值", "临界"]],
  ["radius",    ["radius", "半径", "扩散"]],
  ["exposure",  ["exposure", "曝光"]],
  ["intensity", ["light intensity", "灯光强度", "intensity", "brightness", "strength", "亮度", "强度", "增益"]]
];

/** 判断一个属性属于 Deep Glow 的哪个参数（name / matchName 任一命中即可），都不是返回 null */
function pf_dgKeyOf(name, matchName) {
  var s = (String(name) + " " + String(matchName)).toLowerCase();
  for (var i = 0; i < PF_DG_KEYWORDS.length; i++) {
    var kws = PF_DG_KEYWORDS[i][1];
    for (var k = 0; k < kws.length; k++) {
      if (s.indexOf(kws[k]) >= 0) return PF_DG_KEYWORDS[i][0];
    }
  }
  return null;
}

/**
 * 按关键字递归扫描 Deep Glow 2 的参数并赋值（中英文 / 各版本都能认）。
 * 每个数值写完都**读回校验**，对不上就再写一次。
 */
function pf_configureDeepGlow(group, g, rgb, state) {
  var wantTh  = (g.threshold === undefined) ? 0    : g.threshold;
  var wantR   = (g.radius    === undefined) ? 200  : g.radius;
  var wantExp = (g.exposure  === undefined) ? 0.32 : g.exposure;   // 曝光
  var wantInt = (g.strength  === undefined) ? 0.4  : g.strength;   // 灯光强度

  // state 用来把"到底写进去了哪些"带回给调用方
  if (!state) state = { tintGroupFound: false, colorWritten: false, hits: {} };

  // ---- Tint 组：先按名字找，找不到就按"颜色属性所在的组"定位 ----
  // 实测 Deep Glow v1.6.6 上按组名找会失败（numProperties 读不准），
  // 而 Deep Glow 里只有一个颜色属性，所以"颜色在哪个组，哪个组就是 Tint"。
  //
  // 注意：这里**不能 return** —— 半径/曝光/强度还要继续往下扫。
  if (!state.tintGroupFound) {
    var tintG = pf_findGlowColorGroup(group, 0);
    if (tintG) {
      state.tintGroupFound = true;
      if (state.useTint) {
        if (pf_enableDeepGlowTint(tintG, rgb)) state.colorWritten = true;
      } else {
        pf_disableDeepGlowTint(tintG);
        state.colorFollowsText = true;
      }
    }
  }

  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    var kids = 0;
    try { kids = p.numProperties; } catch (e) { kids = 0; }

    var gnm = "";
    try { gnm = String(p.name).toLowerCase(); } catch (eG) { gnm = ""; }
    var gmn = "";
    try { gmn = String(p.matchName).toLowerCase(); } catch (eGM) { gmn = ""; }

    if (kids > 0) {
      // 子组一律递归往下扫参数。
      // Tint **不在这里处理** —— 上面已经用 pf_findGlowColorGroup +
      // pf_resolveTintProps 精确写过了。之前这里还有一段"按组名找 Tint"的分支，
      // 在 numProperties 读不准的版本上会认错组，把 Tint 再写一遍（写坏）。
      pf_configureDeepGlow(p, g, rgb, state);
      continue;
    }

    var nm = "";
    try { nm = String(p.name); } catch (e2) { nm = ""; }
    var mn = "";
    try { mn = String(p.matchName); } catch (e3) { mn = ""; }
    var isColor = false;
    try { isColor = (p.propertyValueType === PropertyValueType.COLOR); } catch (e4) {}

    var key = pf_dgKeyOf(nm, mn);
    try {
      if (key === "threshold")      { pf_setNumChecked(p, wantTh);  state.hits.threshold = true; }
      else if (key === "radius")    { pf_setNumChecked(p, wantR);   state.hits.radius = true; }
      else if (key === "exposure")  { pf_setNumChecked(p, wantExp); state.hits.exposure = true; }
      else if (key === "intensity") { pf_setNumChecked(p, wantInt); state.hits.intensity = true; }
      else if (isColor && state.useTint) {
        // 颜色属性：只有**要用 Tint 单独着色**时才写。
        // 文字不是白色时 useTint=false，这里必须闭嘴 ——
        // 否则会把 Tint 的颜色也改成文字色，虽然 Tint 关着看不出来，
        // 但下次用户把文字改回白色，就会看到上一次遗留的怪颜色。
        p.setValue(rgb);
        state.colorWritten = true;
      }
    } catch (e5) {}
  }

  return state;
}

/**
 * 最后一道兜底：**只认半径**。
 *
 * 为什么不做"按索引写"：AE 效果的第一项可能是「信息与帮助」这类组，
 * 各版本 / 汉化版的位置都不一样，硬猜索引会把曝光的值写进半径，比不写更糟
 * （实测过：猜错时半径会变成 0.32）。
 *
 * 但半径有一个**可靠的数值特征**：它是 Deep Glow 里唯一一个值域很大的参数
 * （默认 500，实际范围 0~2000+），而曝光 / 灯光强度都在 0~10。
 * 所以：效果里如果有且仅有一个「当前值 > 100」的一维数值参数，那它必然是半径。
 * 曝光和强度数值特征太像（默认都是 1），不猜，交给名字匹配。
 */
function pf_configureDeepGlowByIndex(eff, g, state) {
  if (state.hits.radius) return state;          // 名字已经命中，不用兜底

  var wantR = (g.radius === undefined) ? 200 : g.radius;
  var cands = [];

  function scan(group) {
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      var p = group.property(i);
      var kids = 0;
      try { kids = p.numProperties; } catch (e1) { kids = 0; }
      if (kids > 0) { scan(p); continue; }

      var pvt = null;
      try { pvt = p.propertyValueType; } catch (e2) { pvt = null; }
      if (pvt !== null && pvt !== PropertyValueType.OneD) continue;

      var v = pf_readNum(p);
      if (v === null) continue;
      if (v > 100) cands.push(p);               // 值域特征：>100 只可能是半径
    }
  }
  try { scan(eff); } catch (e3) { return state; }

  if (cands.length === 1) {                      // 唯一候选才写，多个就放弃
    pf_setNumChecked(cands[0], wantR);
    state.hits.radius = true;
    state.byIndex = true;
  }
  return state;
}

/** AE 自带 Glow 的参数写入 */
function pf_configureBuiltinGlow(eff, g, rgb) {
  pf_setProp(eff, ["Glow Threshold", "阈值", 1], g.threshold === undefined ? 0 : g.threshold);
  pf_setProp(eff, ["Glow Radius", "半径", 2], g.radius === undefined ? 200 : g.radius);
  pf_setProp(eff, ["Glow Intensity", "强度", 3], g.strength === undefined ? 0.4 : g.strength);
  if (g.color) {
    pf_setProp(eff, ["Color A", 5], rgb);
    pf_setProp(eff, ["Color B", 6], rgb);
    pf_setProp(eff, ["Glow Colors", 4], 2); // 2 = A & B Colors
  }
}

/**
 * 一条字幕的发光色规则：
 *   · 文字是**白色**（默认）→ 用「发光颜色」那套设置，通过 **Tint** 单独着色
 *   · 文字是**其它颜色**  → **关掉 Tint**，Deep Glow 直接吃文字色
 *
 * 返回 { rgb, useTint }
 *   rgb     —— 写进 Tint 的颜色（跟随文字时就是文字色，实际不会被用到）
 *   useTint —— true = 打开 Tint 单独着色；false = 关闭 Tint 跟随文字
 */
function pf_glowPlan(o, textColor) {
  var g = (o && o.glow) ? o.glow : {};

  var tc = textColor;
  if (tc === undefined || tc === null) tc = pf_pickTextColor(o);

  // 文字不是白色 → 跟随文字，关掉 Tint
  if (!pf_sameHex(tc, "#ffffff")) {
    pf_lastGlow = tc;
    return { rgb: pf_hex2rgb(tc), useTint: false };
  }

  // 文字是白色 → 用发光色设置，开 Tint
  if (g.colorMode === "random" || g.colorRandom) {
    var list = (g.colors && g.colors.length) ? g.colors : PF_VIVID;
    var hex = pf_cyclePick(list, pf_bagGlow);
    if (!hex) hex = "#ffffff";
    pf_lastGlow = hex;
    return { rgb: pf_hex2rgb(hex), useTint: true };
  }
  return { rgb: pf_hex2rgb(g.singleColor || g.color || "#ffffff"), useTint: true };
}

/** 兼容旧调用：只要颜色 */
function pf_pickGlowColor(o, textColor) {
  return pf_glowPlan(o, textColor).rgb;
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

/** 两层投影的固定参数（面板上不调） */
var PF_SHADOW_NEAR = { name: "投影1-发光前", opacity: 100, direction: 135, distance: 5, softness: 2  };
var PF_SHADOW_FAR  = { name: "投影2-发光后", opacity: 90,  direction: 135, distance: 5, softness: 20 };

/** 删掉图层上所有投影效果（重建效果链前先清场） */
function pf_removeShadows(layer) {
  try {
    var fx = layer.Effects;
    for (var k = fx.numProperties; k >= 1; k--) {
      var e = fx.property(k);
      var mn = "";
      try { mn = String(e.matchName); } catch (e0) { mn = ""; }
      if (mn === "ADBE Drop Shadow") { try { e.remove(); } catch (e1) {} }
    }
  } catch (e2) {}
}

/**
 * AE 的 Drop Shadow 参数顺序在各国语言 / 各版本里都是固定的：
 *   1 阴影颜色  2 不透明度  3 方向  4 距离  5 柔和度  6 仅阴影
 */
var PF_SHADOW_IDX = { color: 1, opacity: 2, direction: 3, distance: 4, softness: 5, only: 6 };

/**
 * 给一个数值属性赋值，并**读回校验**。
 * 读回来对不上就再写一次；写不进去的（比如类型不匹配）返回 false 交给上层换法子。
 */
function pf_setNumChecked(p, v) {
  if (!p) return false;
  try { p.setValue(v); } catch (e1) {
    try { p.setValue([v]); } catch (e2) {}
  }
  var got = pf_readNum(p);
  if (got === null) return true;                 // 读不出来就认为写成功了
  if (Math.abs(got - v) < 0.01) return true;

  // 对不上：再补一次
  try { p.setValue(v); } catch (e3) {}
  got = pf_readNum(p);
  return got !== null && Math.abs(got - v) < 0.01;
}

/**
 * 判断 Drop Shadow 不透明度用的是哪种刻度，返回「每个百分点对应多少原始值」。
 *
 * 为什么要这一步：AE 的 Drop Shadow 在脚本里**不是** 0~100 的百分比刻度，
 * 而是 0~255（面板显示 = 原始值 / 255 × 100）。
 * 所以直接写 100 会显示成 39%（100/255），写 90 显示 35% —— 正是之前的问题。
 *
 * 识别方法：新建的 Drop Shadow 不透明度默认是 50%。
 * 读一下刚加上的效果就知道刻度：
 *   · 读到 ≈ 50   → 0~100 刻度，比例 1
 *   · 读到 ≈ 128  → 0~255 刻度，比例 2.55
 */
function pf_percentScale(p) {
  var def = pf_readNum(p);
  if (def === null) return 1;

  // 默认 50%：超过 100.5 说明不是 0~100 刻度
  if (def > 100.5) {
    // 常见就是 0~255（128 → 2.56，真实刻度 2.55）。
    // 用 2.55 而不是 128/50，避免 90% 写成 230.4 后读回 90.35% 的偏差
    if (Math.abs(def - 127.5) <= 3) return 2.55;
    return def / 50;
  }

  // 归一化刻度（0~1 表示 0~100%）
  if (def > 0 && def <= 1.5) return 0.01;

  return 1;
}

/** 写「百分比」型属性，自动按该属性的实际刻度换算 */
function pf_writePercent(p, percent, scale) {
  if (!p) return false;
  var k = (typeof scale === "number" && scale > 0) ? scale : pf_percentScale(p);
  var target = percent * k;

  function write(v) {
    try { p.setValue(v); return true; } catch (e) {
      try { p.setValue([v]); return true; } catch (e2) { return false; }
    }
  }

  if (!write(target)) return false;

  // 读回校验：用同一比例换回百分比再比
  var r = pf_readNum(p);
  if (r === null) return true;                       // 读不出来，当写成功
  if (Math.abs(r / k - percent) <= 0.5) return true;

  // 100% 时 k≈2.56 → 目标 256 超出 0~255，被夹到 255（=100%），这是正常结果
  if (percent >= 99.5 && r >= 250 && k > 2) return true;

  // 对不上：再写一次（按实测读回值反推真正的刻度）
  if (r > 0 && Math.abs(r - target) > 0.01) {
    var k2 = r / percent;
    if (k2 > 0) { write(percent * k2); r = pf_readNum(p); if (r === null) return true; }
  }
  return r === null || Math.abs(r / k - percent) <= 0.5 || Math.abs(r / k2 - percent) <= 0.5;
}

/** 按名字找 Drop Shadow 的某个参数 */
function pf_shadowPropByName(eff, key, n) {
  var keys = {
    opacity:   ["opacity", "不透明"],
    direction: ["direction", "方向"],
    distance:  ["distance", "距离"],
    softness:  ["softness", "柔和"]
  }[key];
  if (!keys) return null;
  for (var i = 1; i <= n; i++) {
    var p = eff.property(i);
    var nm = "";
    try { nm = String(p.name).toLowerCase(); } catch (e) { continue; }
    for (var k = 0; k < keys.length; k++) {
      if (nm.indexOf(keys[k]) >= 0) return p;
    }
  }
  return null;
}

/**
 * 加一层 Drop Shadow，参数由 cfg 给。
 *
 * 写入策略（两层保险）：
 *   ① 先**按索引**写 —— Drop Shadow 的参数顺序是固定的，最稳；
 *   ② 逐个**读回校验**，对不上的再**按名字**（英文 + 中文关键字）写一次；
 *   ③ 仍然对不上就再按索引强写一次。
 * 之所以要这么啰嗦：不同语言 / 版本下按名字扫描可能命中不到，
 * 一旦静默失败，AE 就会停在它自己的出厂值上（你看到的 35% / 39% 就是这么来的）。
 */
function pf_addShadow(layer, cfg) {
  var eff = null;
  try { eff = layer.Effects.addProperty("ADBE Drop Shadow"); } catch (e2) { eff = null; }
  if (!eff) return null;

  var n = 0;
  try { n = eff.numProperties; } catch (eN2) { n = 0; }

  var WANT = {
    opacity:   cfg.opacity,
    direction: cfg.direction,
    distance:  cfg.distance,
    softness:  cfg.softness
  };

  // ① 先量出「不透明度」的刻度 —— 必须在写任何值之前做，
  //    因为新效果的默认值（50%）是唯一可靠的参照点。
  var opProp = null;
  try { opProp = eff.property(PF_SHADOW_IDX.opacity); } catch (eOp) { opProp = null; }
  if (!opProp) opProp = pf_shadowPropByName(eff, "opacity", n);
  var opScale = pf_percentScale(opProp);

  // ② 阴影颜色 = 纯黑（按索引 1，拿不到就按类型找）
  try {
    var cp = eff.property(PF_SHADOW_IDX.color);
    var okColor = false;
    try { okColor = (cp.propertyValueType === PropertyValueType.COLOR); } catch (ec) { okColor = true; }
    if (cp && okColor) cp.setValue([0, 0, 0]);
  } catch (eC) {}

  // ③ 四个数值参数：先按索引写
  var failed = [];
  for (var key in WANT) {
    if (!WANT.hasOwnProperty(key)) continue;
    var p = null;
    try { p = eff.property(PF_SHADOW_IDX[key]); } catch (eP) { p = null; }
    var ok = (key === "opacity") ? pf_writePercent(p, WANT[key], opScale)
                                 : pf_setNumChecked(p, WANT[key]);
    if (!ok) failed.push(key);
  }

  // ④ 还不对的，按名字再写一遍
  var still = [];
  for (var i = 0; i < failed.length; i++) {
    var k2 = failed[i];
    var q = pf_shadowPropByName(eff, k2, n);
    var ok2 = (k2 === "opacity") ? pf_writePercent(q, WANT[k2], opScale)
                                 : pf_setNumChecked(q, WANT[k2]);
    if (!ok2) still.push(k2);
  }

  // ④ 仍旧不对：按名字直接 setValue 一次（不再校验），尽量不留出厂值
  for (var j = 0; j < still.length; j++) {
    var k3 = still[j];
    try {
      var q2 = pf_shadowPropByName(eff, k3, n);
      if (q2) q2.setValue(WANT[k3]);
    } catch (e5) {}
  }

  // ⑤ 「仅阴影」保持不勾（有就写 0，没有就算了）
  try {
    var only = eff.property(PF_SHADOW_IDX.only);
    if (only) only.setValue(0);
  } catch (e6) {}

  // 改名放在最后：个别 AE 版本改完名字会重排属性，先写值再改名最保险
  try { eff.name = cfg.name; } catch (eN) {}

  return eff;
}

/**
 * 重建一个文字图层的「发光 + 双层投影」效果链。
 *
 * 最终顺序必须是：  投影1 → 发光 → 投影2
 * AE 的效果是从上往下依次作用，所以"排在发光前"的那层会先渲染（垫在发光下面），
 * "排在发光后"的那层最后渲染（盖在最上面）。
 *
 * 不用 moveTo（对效果不一定生效），而是**按顺序重新添加**：
 *   先清掉旧的发光和投影 → 加投影1 → 加发光 → 加投影2
 * 新加的效果永远追加在列表末尾，于是天然就得到上面这个顺序。
 *
 * keepGlow：图层上原本就有发光时（「应用动画」流程）不要删它，只重排投影。
 */
function pf_buildEffectChain(layer, opts, textColor) {
  var g = (opts && opts.glow) ? opts.glow : {};
  var glowOn = !!g.enabled;
  var keepGlow = !!(opts && opts.keepGlow) && pf_hasGlow(layer);

  if (keepGlow) {
    // 保留原发光：AE 不支持给效果排序，只能「删掉再按顺序重建」。
    // 先把原发光的参数抄下来，删掉，再按 投影1 → 发光(还原参数) → 投影2 的顺序加回去。
    pf_rebuildKeepingGlow(layer);
    return;
  }

  pf_removeGlow(layer);
  pf_removeShadows(layer);

  pf_addShadow(layer, PF_SHADOW_NEAR);       // ① 发光之前

  if (glowOn) {
    var res = pf_addGlowEffect(layer);
    if (res) {
      // 发光色规则：文字白 → 开 Tint 单独着色；文字非白 → 关 Tint 跟随文字
      var plan = pf_glowPlan(opts, textColor);
      if (res.deep) {
        var st = pf_configureDeepGlow(res.eff, g, plan.rgb, {
          useTint: plan.useTint,
          tintGroupFound: false, colorWritten: false, hits: {}
        });
        // 兜底：名字一个都没命中（极端汉化 / 改名版本）→ 用值域特征救回半径
        pf_configureDeepGlowByIndex(res.eff, g, st);
        // 把这次写入的结果记下来，供「一键生成效果」回报给面板
        pf_lastGlowWrite = st;
      } else {
        pf_configureBuiltinGlow(res.eff, g, plan.rgb);
        pf_lastGlowWrite = { builtin: true };
      }
    } else {
      pf_lastGlowWrite = { failed: true };
    }
  }

  pf_addShadow(layer, PF_SHADOW_FAR);        // ② 发光之后
}

/** 最近一次 Deep Glow 参数写入的结果（面板用它提示"到底写进去没有"） */
var pf_lastGlowWrite = null;

/** 把写入结果拼成一句人话，附在「一键生成效果」的返回里 */
function pf_glowWriteSummary() {
  var st = pf_lastGlowWrite;
  if (!st) return "";
  if (st.failed) return "  ⚠ 发光效果没能创建（插件未安装？）";
  if (st.builtin) return "  发光：AE 自带 Glow";

  var h = st.hits || {};
  var got = [], miss = [];
  if (h.radius) got.push("半径"); else miss.push("半径");
  if (h.exposure) got.push("曝光"); else miss.push("曝光");
  if (h.intensity) got.push("灯光强度"); else miss.push("灯光强度");
  if (h.threshold) got.push("阈值");

  var s = "  发光参数已写入：" + (got.length ? got.join("/") : "无");
  if (miss.length) {
    s += "；⚠ 未写入：" + miss.join("/") +
         "（该版本的参数名认不出，请点「发光值」按钮把实际参数名发给我）";
  }
  if (st.byIndex) s += "（半径靠数值特征兜底写入）";
  // 发光色（Tint）的结果 —— 这是最容易"看着写了其实没生效"的一项，单独报
  if (st.useTint) {
    s += st.colorWritten ? "；Tint 已开启并写入发光色" : "；⚠ Tint 没能打开（请点「发光值」看具体参数）";
  } else {
    s += "；文字非白色 → 发光跟随文字色（Tint 关闭）";
  }
  return s;
}

/**
 * 「应用动画」流程用：图层上已经有发光，不能删掉它（用户可能自己调过参数）。
 * 但 AE 又不能给效果排序，所以只能：抄下原发光的全部参数 → 删掉 →
 * 按 投影1 → 发光(把参数写回去) → 投影2 的顺序重建。
 * 参数按「属性名 → 值」逐个记，重建后按名字写回，不依赖索引。
 */
function pf_rebuildKeepingGlow(layer) {
  var snap = null, eff = null;

  try {
    var fx = layer.Effects;
    for (var k = 1; k <= fx.numProperties; k++) {
      var e = fx.property(k);
      if (!pf_isGlowEffect(e)) continue;
      eff = e;
      snap = pf_snapshotEffect(e);
      break;
    }
  } catch (e2) { return; }

  if (!eff || !snap) {
    pf_buildEffectChain(layer, { glow: { enabled: false } });
    return;
  }

  pf_removeGlow(layer);
  pf_removeShadows(layer);

  pf_addShadow(layer, PF_SHADOW_NEAR);                       // ① 发光之前

  var res = pf_addGlowEffect(layer);                         // 发光（同类型重建）
  if (res) pf_restoreEffect(res.eff, snap);

  pf_addShadow(layer, PF_SHADOW_FAR);                        // ② 发光之后
}

/** 把一个效果的「属性路径 → 值」全部抄下来 */
function pf_snapshotEffect(eff) {
  var out = { name: "", matchName: "", props: [] };
  try { out.name = String(eff.name); } catch (e0) {}
  try { out.matchName = String(eff.matchName); } catch (e1) {}

  function walk(group, prefix) {
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
      var p = group.property(i);
      var kids = 0;
      try { kids = p.numProperties; } catch (e2) { kids = 0; }
      var nm = "";
      try { nm = String(p.name); } catch (e3) { nm = "?" + i; }
      var path = prefix ? (prefix + "/" + nm) : nm;
      if (kids > 0) { walk(p, path); continue; }
      var v = null;
      try {
        var raw = p.value;
        if (typeof raw === "number") v = raw;
        else if (raw && raw.length !== undefined) v = [raw[0], raw[1], raw[2], raw[3]].slice(0, raw.length);
      } catch (e4) { v = null; }
      if (v !== null) out.props.push({ path: path, value: v });
    }
  }
  walk(eff, "");
  return out;
}

/** 把抄下来的值写回重建后的效果（按属性名逐级定位，不依赖索引） */
function pf_restoreEffect(eff, snap) {
  if (!eff || !snap) return;
  for (var i = 0; i < snap.props.length; i++) {
    var rec = snap.props[i];
    var parts = rec.path.split("/");
    var node = eff;
    for (var j = 0; j < parts.length; j++) {
      var nxt = null;
      try { nxt = node.property(parts[j]); } catch (e0) { nxt = null; }
      if (!nxt) { node = null; break; }
      node = nxt;
    }
    if (!node) continue;
    try { node.setValue(rec.value); } catch (e1) {}
  }
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

  // ---- 每条字幕延长 N 帧 ----
  // 「延长」= **入点不动，只把出点往后拉 N 帧**，每条字幕都多显示一段。
  //
  // 注意这和"延迟"是两回事：
  //   延迟 = 整条往后挪（起点和终点一起挪），时长不变
  //   延长 = 起点不动，终点后移，时长 +N
  //
  // 按合成实际帧率换算成秒，所以 25 / 30 / 60fps 都对得上。
  var fps = 25;
  try { fps = comp.frameRate || 25; } catch (ef) {}
  var extendFrames = (o.extendFrames === undefined || o.extendFrames === null) ? 50 : Number(o.extendFrames);
  if (isNaN(extendFrames) || extendFrames < 0) extendFrames = 0;
  var extendSec = extendFrames / fps;

  var cueLayers = [];
  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];

    // ---- 文本预处理：先清洗标点，再强制大写，最后折行 ----
    // 顺序有讲究：必须**先清洗再折行**，否则折行把一行的标点挤到行首，
    // 清洗规则就管不到它了。
    var body = c.text;
    if (o.cleanPunct) body = pf_cleanPunctuation(body);
    if (o.forceUpper) body = pf_toUpper(body);
    body = pf_applyLineBreak(body, o.lineBreakBase);

    // ---- 延长出点 ----
    // 入点保持 SRT 原值，出点往后加 extendSec。
    var newIn = c.start;
    var newOut = c.end + extendSec;
    if (newIn < 0) newIn = 0;

    if (newOut + 2 > comp.duration) { try { comp.duration = newOut + 2; } catch (e) {} }

    // 导入只负责建层：**不套用②里的字体**（字体统一由「确认修改字体」来改）
    var layer = pf_addTextLayer(comp, body, newIn, newOut, o, null);
    // 记下两件事，都写进图层标记（重开 AE 也还在）：
    //   · 原始出点 c.end      → 出场从这里开始淡
    //   · 延长量 extendSec    → 淡出就在这段里走完（匀速）
    pf_setSrtOut(layer, c.end, extendSec);
    try { layer.label = 12; } catch (e) {}
    cueLayers.push(layer);
    made++;
  }

  // 导入阶段只建层，不施加任何效果（字体/交叠/动画都放到后面的按钮里）
  pf_lastBatch = [];
  for (var m = 0; m < cueLayers.length; m++) pf_lastBatch.push(cueLayers[m]);

  var msg = "生成 " + made + " 个字幕图层";

  // 导入后立刻验证标记真的写进去了 —— 标记丢失会让出场拖到延长结束才淡，
  // 这是最隐蔽的时序错误，不如在导入时就报出来。
  var markOk = 0;
  for (var v = 0; v < cueLayers.length; v++) {
    if (pf_readMarkerText(cueLayers[v])) markOk++;
  }
  if (made > 0) {
    msg += markOk === made
      ? "（出点标记 " + markOk + "/" + made + " ✓）"
      : "（⚠ 出点标记只写入 " + markOk + "/" + made + "，出场可能不准）";
  }

  // 导入后自动预合成：把刚建的字幕图层打包进一个新合成
  if (o.precompose) {
    var pname = (o.precompName && o.precompName.length) ? o.precompName : "字幕";
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
function pf_styleOne(L, o, layerIndex) {
  // **先清掉上次生成的动画器与关键帧，再重建。**
  //
  // 不这么做的话，改完出场时长点「一键生成」，旧的关键帧还在图层上：
  // 两套选择器同时在推 Percent End，先跑完的那套说了算 ——
  // 表现就是"出场时长怎么调都没变化"。缩放、整层透明度同理。
  pf_clearOurAnimators(L);

  var flowOn = !!(o.flow && o.flow.enabled);
  var fmode = (o.flow && o.flow.mode) ? o.flow.mode : "band";

  // 颜色只取一次：文字底色和流光色必须是同一个（随机模式下 = 这一句抽到的那个色）
  var col = null;
  if (flowOn || o.doColor !== false) col = pf_pickTextColor(o);

  // 先挂流光动画器，拿到结果再决定底色 ——
  // 光带模式要把底色刷白，但万一动画器没建起来，白底就会变成"整句纯白"。
  // 所以只有流光真的建成功了才刷白，否则老老实实上色。
  //
  // layerIndex 传下去，是为了"多种效果 + 随机"时能按序号稳定地轮换 ——
  // 同一个工程重复执行，同一条字幕拿到的效果不会变来变去。
  var flowed = false;
  if (flowOn) flowed = pf_flowOnLayer(L, o, col, fmode, layerIndex);

  // 这条字幕最终呈现的文字色（发光色规则要用它：白色才用发光色设置，否则跟随文字色）
  var finalText = col || "#ffffff";

  // 底色规则：
  //   光带 → 刷白（Tint 的暗部是白，亮部是文字色 → 彩色光带扫过白底）
  //   其余 → 保持文字色（Tint 的暗部是文字色，亮部是白 → 染色 + 白色留白）
  //
  // 注意：四种模式现在都走分形噪波，噪波会**完全覆盖**字形原来的填充色，
  // 所以这里的底色只是兜底 / 万一噪波没建起来时的表现。
  if (flowOn && fmode === "band" && flowed) {
    pf_setTextFill(L, "#ffffff");
    finalText = "#ffffff";
  } else if (col) {
    pf_setTextFill(L, col);
  }
  // 投影 / 发光不在这里加：它们属于效果链，由 pf_effectsOne 统一按「投影1 → 发光 → 投影2」重建
  if (o.canvas) pf_applyCanvasText(L, o);
  if (o.doTracking) pf_trackingOnLayer(L, o);
  if (o.doEntry) pf_entryOnLayer(L, o);
  if (o.doExit) pf_exitOnLayer(L, o);

  // ---- 持续放大：只要这条字幕**做了动画**就自动执行 ----
  //
  // 判断依据是"有没有动画"本身，而不是面板上的复选框：
  //   · 第一页：入场 / 出场 / 第 2 页的随机动画，任意一个开着就算做了动画
  //   · 第二页：同上（它只是把入出场参数换成随机动画）
  //
  // 这样两个页面行为一致：只要字幕在动，就一定带着缓慢放大，
  // 用户不需要额外记得去勾「放大」。
  //
  // 例外：用户在面板上**显式取消勾选「放大」**时不加 ——
  // 保留一个手动口子，想彻底不要放大时可以关掉。
  // 默认（growEnabled 未定义时）视为开启。
  var hasAnim = !!(o.doEntry || o.doExit ||
                   (o.randomAnim && o.randomAnim.enabled));
  var growWanted = (o.growEnabled === false) ? false : hasAnim;
  if (growWanted) pf_applyScale(L, o);

  return finalText;
}

/**
 * 第 2 页「画面与文字」的字号 / 字距 / 行距。
 *
 * 规则（按面板上写的那句话）：
 *   · 2 词及以下（短句）：整条字幕字号 = 第一行字号 + 短句字号增量
 *     （增量为 0 时就用第一行字号）
 *   · 3 词及以上且分成两行：第一行用第一行字号，第二行 = 第一行 + 第二行字号增量
 *
 * 实现上：AE 的 Text Document 里字号是**整段统一**的，没法给两行设不同字号。
 * 所以两行字幕按第二行的字号统一处理 —— 视觉上接近参考插件的行为，
 * 又不会因为逐行拆分而破坏字符动画。
 *
 * 字距用 Tracking（ADBE Text Tracking Amount），单位是 1/1000 em；
 * 行距用 Leading（ADBE Text Leading），单位是像素。
 */
function pf_applyCanvasText(layer, o) {
  var cv = o.canvas;
  if (!cv) return;

  var size1 = Number(cv.size1);
  if (!(size1 > 0)) size1 = 100;
  var size2Delta = Number(cv.size2Delta) || 0;
  var shortDelta = Number(cv.shortDelta) || 0;

  // 判断这条字幕有几行、有多少词
  var txt = pf_layerText(layer);
  var lines = String(txt || "").split(/\r\n|\r|\n/);
  var lineCount = lines.length;
  var words = pf_wordCount(layer);

  var finalSize;
  if (lineCount >= 2) {
    // 两行：第二行更大 → 整体按第二行字号（见上面注释）
    finalSize = size1 + size2Delta;
  } else if (words <= 2) {
    // 短句：加"短句字号增量"；为 0 就用第一行字号
    finalSize = size1 + shortDelta;
  } else {
    finalSize = size1;
  }
  if (!(finalSize > 0)) finalSize = size1;

  // 写回文字文档
  try {
    var st = pf_getTextDocProp(layer);
    var td = st.value;
    if (td) {
      td.fontSize = finalSize;
      var lead = Number(cv.leading);
      if (lead > 0) { try { td.leading = lead; } catch (eL) {} }
      var track = Number(cv.tracking);
      if (track !== 0) {
        try { td.tracking = track / 1000; } catch (eT) {}   // AE 用 em 比例
      }
      st.setValue(td);
    }
  } catch (e) {}

  // 字距的兜底：Text Document 的 tracking 在部分 AE 版本上写不进去。
  //
  // 注意这里**不无条件再加一个动画器** ——
  // 「间距」组件和放大时的字距拉伸各自都会加 Tracking Amount 动画器，
  // AE 里多个动画器的值会**累加**，再叠一个就是加倍的间距。
  // 只有当上面写 Text Document 确实失败、且没有别的 tracking 动画器时才兜底。
  var docOk = false;
  try {
    var chk = pf_getTextDocProp(layer).value;
    if (chk) {
      var applied = Number(chk.tracking) * 1000;
      var want = Number(cv.tracking);
      if (Math.abs(applied - want) < 1) docOk = true;
    }
  } catch (eChk) { docOk = false; }

  if (!docOk && !pf_hasTrackingAnimator(layer)) {
    try {
      var track2 = Number(cv.tracking);
      if (track2 > 0) {
        var a = pf_addAnimator(layer, 1);
        if (a && a.props) {
          var amt = pf_addProp(a.props, ["ADBE Text Tracking Amount"]);
          if (amt) amt.setValue(track2);
        }
      }
    } catch (e2) {}
  }
}

/**
 * 找到图层上已有的 Tracking Amount 属性（没有返回 null）。
 *
 * 用它做两件事：避免重复叠加动画器（会翻倍），
 * 以及复用它来做"放大时字距拉开"的关键帧。
 */
function pf_findTrackingProp(layer) {
  try {
    var tg = layer.property("ADBE Text Properties");
    var anims = tg.property("ADBE Text Animators");
    var n = anims.numProperties;
    for (var i = 1; i <= n; i++) {
      var anim = anims.property(i);
      var props = anim.property("ADBE Text Animator Properties");
      if (!props) continue;
      var m = 0;
      try { m = props.numProperties; } catch (e) { m = 0; }
      for (var k = 1; k <= m; k++) {
        var p = props.property(k);
        var mn = "";
        try { mn = String(p.matchName); } catch (e2) { mn = ""; }
        if (mn === "ADBE Text Tracking Amount") return p;
      }
    }
  } catch (e3) {}
  return null;
}

/** 图层上是否已经有 Tracking Amount 动画器 */
function pf_hasTrackingAnimator(layer) {
  return !!pf_findTrackingProp(layer);
}

/* ==================================================================
 *  【项目强制约束】有发光就必须有两层投影
 *
 *  规则：**只要字幕做了发光效果，双层投影（发光前 + 发光后）必须同时存在。**
 *  不论以后新增什么功能、从哪条路径加发光，都不能只加发光不加投影。
 *
 *  pf_buildEffectChain 本身就是「投影1 → 发光 → 投影2」按顺序重建的，
 *  所以走它的路径天然满足。但为了防住**将来新加的、不走它的发光路径**，
 *  这里再加一道幂等校验：pf_effectsOne 是所有效果应用的最后一道关口，
 *  在它返回前统一核对一遍，缺了就补。
 * ================================================================== */

/** 数一下图层上有几层投影 */
function pf_countShadows(layer) {
  var n = 0;
  try {
    var fx = layer.Effects;
    for (var k = 1; k <= fx.numProperties; k++) {
      var e = fx.property(k);
      var mn = "";
      try { mn = String(e.matchName); } catch (e0) { mn = ""; }
      if (mn === "ADBE Drop Shadow") n++;
    }
  } catch (e1) {}
  return n;
}

/**
 * 兜底校验：图层上有发光但投影不足两层 → 整条效果链重建一遍。
 *
 * 只在"确实不一致"时才动，正常情况什么都不做（幂等、不重复加投影）。
 * 返回是否做了修补，方便诊断和回报。
 */
function pf_ensureShadowPair(layer, o, textColor) {
  var hasGlow = pf_hasGlow(layer);
  if (!hasGlow) return false;                 // 没发光就不强制（「应用动画」也补，但那条另走）
  if (pf_countShadows(layer) >= 2) return false;
  // 有发光但投影不全 → 按标准顺序重建（保留原发光参数）
  pf_rebuildKeepingGlow(layer);
  return true;
}

/**
 * 给单个图层重建效果链。
 * 不管这次做的是"动画"还是"发光"，都会补上两层投影 —— 这是明确要求的行为。
 * shadowsOnly：只补两层投影、不动发光（「应用动画」走这条，避免顺手把发光也加上）。
 */
function pf_effectsOne(L, o, shadowsOnly, textColor) {
  if (shadowsOnly) {
    // 只补两层投影：图层上原有发光就保留（按 投影1→发光→投影2 重排），
    // 没有发光就只加两层投影。
    pf_buildEffectChain(L, { glow: { enabled: false }, keepGlow: true }, textColor);
  } else {
    pf_buildEffectChain(L, o, textColor);
  }

  // 【强制约束】最后再过一遍：有发光就必须有两层投影。
  // 防的是将来新增的发光路径没走上面这段。
  pf_ensureShadowPair(L, o, textColor);
}

/**
 * 出场时间轴：决定每条字幕**从什么时候开始淡出**，以及出点停在哪。
 *
 * 这是整个字幕时序里最容易搞错的一块，把规则写清楚：
 *
 *   SRT 里的 out 时刻 = 这条字幕"本该结束"的时刻（记为 T）
 *   面板的出场时长  = 淡出要花多久（记为 L，用户设多少就是多少）
 *
 *   → 淡出**从 T 开始**（准时开始变淡，不会一直全亮挂着）
 *   → 淡出**到 T + L 结束**，所以图层出点 = T + L
 *
 * 关键点：出点往后挪了 L，但那段时间画面在**逐渐变透明**，
 * 不是"还在显示"。这样既满足"超过本该显示的时间就消失"，
 * 又保留了用户设定的出场时长。
 *
 * 之前两次都错在别处：
 *   ① 早期：出点 = 下一条入点 + L。间隔 5 秒就把出点推到 5 秒后，
 *      淡出也跟着从那儿才开始 —— 字幕一直全亮挂着。
 *   ② v0.44：把淡出时长硬截到 1 秒，用户设 2~3 秒也没用，出场显得太快。
 *
 * 现在用 layer 上记录的 `pf_srtOut`（原始 SRT 出点）当 T。
 * 这个值在第一次处理时写入，之后重复点「一键生成」不会叠加。
 */
/**
 * 找回一条字幕"本该结束的时刻"（原始 SRT 出点）。
 *
 * 有标记 → 直接用（正常情况）。
 *
 * 没有标记 → 说明这条图层是**旧版本导入的**（旧版本的标记写入是坏的，
 * `layer.marker = ...` 赋值静默失败，标记一个都没写进去）。
 * 这时候出点里已经含着延长段了，直接当成原始出点会让字幕
 * 在整个延长段里全亮挂着 —— 必须把延长段减回去：
 *
 *     原始出点 = 当前出点 − 延长帧数 ÷ 帧率
 *
 * 延长帧数取面板上的设定（导入时用的就是它，默认 50）。
 * 算完后立刻写进标记，之后就不再依赖推断，也不会重复扣减。
 *
 * 实在推断不出来（面板延长为 0）→ 才退回"当前出点当原始出点"。
 */
function pf_resolveSrtOut(layer, o) {
  var T = pf_getSrtOut(layer);
  if (T !== null) return { T: T, E: pf_getExtendSeconds(layer) };

  var fps = pf_layerFps(layer);
  var frames = (o && o.extendFrames !== undefined && o.extendFrames !== null)
             ? Number(o.extendFrames) : 0;
  if (isNaN(frames) || frames < 0) frames = 0;

  if (frames > 0) {
    var E = frames / fps;
    var guessed = layer.outPoint - E;
    // 推断出的出点必须还在入点之后，否则说明这条图层根本不带延长段
    if (guessed > layer.inPoint) {
      pf_setSrtOut(layer, guessed, E);
      return { T: guessed, E: E };
    }
  }

  // 手动建的图层 / 不带延长段的图层 → 当前出点就是"本该结束"的时刻
  pf_setSrtOut(layer, layer.outPoint, 0);
  return { T: layer.outPoint, E: 0 };
}

function pf_applyOverlap(layers, o) {
  var arr = layers.slice();
  arr.sort(function (a, b) { return a.inPoint - b.inPoint; });

  for (var i = 0; i < arr.length; i++) {
    var cur = arr[i];

    // ---- ① 确定这条字幕"本该结束"的时刻 T 与延长量 E ----
    var r = pf_resolveSrtOut(cur, o);
    var T = r.T;
    var E = r.E;

    // ---- ② 出点 = 淡出结束的时刻 ----
    // **出场淡出就发生在 [T, T+L] 这段里**，匀速走完，淡完正好到出点。
    //
    // L 是面板上的出场时长（用户设多少就是多少），不是延长量 ——
    // 延长量只负责"导入时先给这段出场留够地方"。
    // 若延长量比出场时长大，多出来的那截就白留了，
    // 所以出点直接按淡出结束时刻收掉，不留全透明空转的时间。
    //
    // 出场关掉时（只要入场），出点保持导入时的 T + E。
    var newOut;
    if (o && o.doExit === false) {
      newOut = T + E;
    } else {
      newOut = T + pf_exitFadeSeconds(o, cur);
    }

    if (newOut < cur.inPoint + 0.05) newOut = cur.inPoint + 0.05;

    try { cur.outPoint = newOut; } catch (e0) {}
  }
}

function pf_applyAnimation(layers, o) {
  pf_lastColor = "";
  pf_resetColorBags();
  pf_applyOverlap(layers, o);
  for (var i = 0; i < layers.length; i++) {
    var tc = pf_styleOne(layers[i], o, i);
    // 「应用动画」也要求补两层投影，但不顺手加发光
    pf_effectsOne(layers[i], o, true, tc);
  }
}

function pf_applyWave(layers, o) {
  for (var i = 0; i < layers.length; i++) pf_waveOnLayer(layers[i], o);
}

function pf_applyGlow(layers, o) {
  pf_lastGlow = "";
  pf_bagGlow.bag = []; pf_bagGlow.idx = 0; pf_bagGlow.last = "";
  for (var i = 0; i < layers.length; i++) {
    // 只点「发光」时，先读一下这个图层当前的文字填充色 —— 发光色规则要用它判断
    var tc = pf_readTextFill(layers[i]);
    pf_effectsOne(layers[i], o, false, tc);
  }
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
  return "OK|发光已应用 (" + layers.length + ")" + pf_glowWriteSummary();
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
  var textColors = [];                      // 每条字幕实际用的文字色，发光色规则要用
  for (var i = 0; i < layers.length; i++) {
    pf_fontOnLayer(layers[i], o, i);
    textColors.push(pf_styleOne(layers[i], o, i));
  }
  pf_applyWave(layers, o);
  // 发光：走效果链重建（投影1 → 发光 → 投影2），逐条传入该条的文字色
  pf_lastGlow = "";
  pf_bagGlow.bag = []; pf_bagGlow.idx = 0; pf_bagGlow.last = "";
  for (var k = 0; k < layers.length; k++) {
    pf_effectsOne(layers[k], o, false, textColors[k]);
  }
  return "OK|已应用字体/颜色/动画/波浪/发光·双层投影 (" + layers.length + " 个图层)" +
         pf_glowWriteSummary();
}

/* ==================================================================
 *  分块执行（面板进度条用）
 *
 *  AE 的 ExtendScript 是**同步**的，跑一个几百层的"一键生成"会
 *  把 AE 界面卡死十几秒，面板只能干等 —— 没有任何进度可言。
 *
 *  这里把工作切成若干块，每块处理一小批图层就返回。
 *  面板用 evalScript 串行调用，每拿到一次返回就推进一格进度条；
 *  因为每次调用之间 AE 有机会刷新界面，所以既不会假死，进度也是真的。
 *
 *  调用顺序：
 *      PF_runStart(o)  → 建状态、做第一阶段，返回 "P|<i>|<total>|<阶段名>"
 *      PF_runStep()    →  每调一次推进一格
 *      PF_runEnd()     → 收尾，返回最终结果
 * ================================================================== */

var PF_JOB = null;

/** 把图层列表存进全局，供后续分块调用使用（ExtendScript 不能用闭包跨调用） */
function pf_jobLayers(job) {
  var out = [];
  for (var i = 0; i < job.layers.length; i++) out.push(job.layers[i]);
  return out;
}

/** 进度回报格式：P|已完成数|总数|阶段说明 */
function pf_progress(job, label) {
  return "P|" + job.done + "|" + job.total + "|" + label;
}

/**
 * 第 2 页的「画面与文字」：把合成尺寸 / 帧率改成用户设定的值。
 *
 * 为什么要先改合成再动图层：
 *   · 帧率决定「延长 N 帧」换算成多少秒（pf_applyOverlap 里用到）
 *   · 画布尺寸决定文字实际占多大比例，字号是按画布像素给的
 *
 * 只改"当前合成"，不动项目里别的合成 —— 用户可能只想调这一条时间线。
 */
function pf_applyCanvas(comp, o) {
  var cv = o && o.canvas;
  if (!cv) return;

  var w = Math.round(Number(cv.width));
  var h = Math.round(Number(cv.height));
  if (w > 0 && h > 0) {
    try { comp.width = w; } catch (e1) {}
    try { comp.height = h; } catch (e2) {}
  }

  var fps = Number(cv.fps);
  if (fps > 0) {
    // AE 的 frameRate 只能取有限几档，写不进去就保持原样。
    try { comp.frameRate = fps; } catch (e3) {}
  }
}

/**
 * 第 2 页「随机动画」：给每条字幕从勾选的动画里挑一个套用。
 *
 * 目前池里只有「淡入淡出」一项。之所以还要做成"多选 + 随机"，
 * 是为了以后加新动画时不用改数据结构 —— 往池子里加一项就行。
 *
 * 淡入淡出的做法：按**词**粒度做逐词淡入 + 逐词淡出，
 * 时长沿用第 1 页的入场 / 出场秒数（参数不在第 2 页重复出现）。
 */
function pf_applyRandomAnim(layer, o, index) {
  var ra = o && o.randomAnim;
  if (!ra || !ra.enabled) return;
  var pool = ra.pool || [];
  if (!pool.length) return;

  // 按序号轮转，保证相邻两条拿到的动画不一样（池里只有一项时就都一样）
  var pick = pool[index % pool.length];
  if (pick !== "ra-fade") return;      // 以后有新动画在这里分支

  var inP = layer.inPoint, outP = layer.outPoint;
  var dur = outP - inP;
  if (dur <= 0) return;

  // 入场时长：沿用第 1 页设置（基准 1.5s ± 帧偏移）
  var entrySec = pf_entrySeconds(o, layer);
  if (entrySec > dur * 0.9) entrySec = dur * 0.45;
  if (entrySec < 0.03) entrySec = 0.03;

  // 出场：和基础页用同一条规则 —— 从原 SRT 出点（延长第一帧）开始，
  // 按「出场帧数 ÷ 帧率」匀速淡完。
  var exitSec = pf_exitFadeSeconds(o, layer);
  if (exitSec > dur * 0.95) exitSec = dur * 0.95;
  if (exitSec < 0.03) exitSec = 0.03;

  var tOut = pf_layerExitStart(layer);
  var exitFrom = tOut;
  var exitTo = Math.min(outP, exitFrom + exitSec);
  if (exitTo - exitFrom < 0.03) {
    try { layer.outPoint = exitFrom + 0.03; outP = layer.outPoint; } catch (eX) {}
    exitTo = Math.min(outP, exitFrom + exitSec);
  }

  // ---- 整层渐显 / 渐隐：强制（项目约束，见 pf_layerFade 的说明） ----
  // 第 2 页的随机动画也必须走这条，否则两条字幕交叠时新的那条看不清。
  pf_forceEntryFade(layer, o, inP, inP + entrySec);
  pf_forceExitFade(layer, o, exitFrom, exitTo);

  // 逐词淡入
  var aIn = pf_addAnimator(layer, 3);              // 3 = 按词
  var opIn = pf_addProp(aIn.props, ["ADBE Text Opacity"]);
  if (opIn) opIn.setValue(0);
  var sIn = pf_selProp(aIn.sel, "ADBE Text Percent Start");
  if (sIn) {
    sIn.setValueAtTime(inP, 0);
    sIn.setValueAtTime(inP + entrySec, 100);
    pf_ease(sIn);
  }
  // 选择器没建起来 → 整个动画器会选中全部字符，整句一直不可见，必须删掉
  if (!opIn || !sIn) { if (aIn && aIn.animator) { try { aIn.animator.remove(); } catch (e1) {} } }

  // 逐词淡出 —— 匀速
  var aOut = pf_addAnimator(layer, 3);
  var opOut = pf_addProp(aOut.props, ["ADBE Text Opacity"]);
  if (opOut) opOut.setValue(0);
  var eOut = pf_selProp(aOut.sel, "ADBE Text Percent End");
  if (eOut) {
    eOut.setValueAtTime(exitFrom, 0);
    eOut.setValueAtTime(exitTo, 100);
    pf_linear(eOut);
  }
  if (!opOut || !eOut) { if (aOut && aOut.animator) { try { aOut.animator.remove(); } catch (e2) {} } }
}

function PF_runStart(o) {
  var comp = pf_activeComp();
  if (!comp) return "ERR|没有打开的合成";
  var layers = pf_targetLayers(comp, o.useSelection);
  if (layers.length === 0) return "ERR|没有可用的文字图层";

  // 第 2 页的「画面与文字」：先把合成尺寸 / 帧率改掉，再处理字幕。
  // 必须在算交叠之前做 —— 帧率会影响"延长 N 帧"换算成秒的结果。
  pf_applyCanvas(comp, o);

  pf_lastFont = "";
  pf_lastColor = "";
  pf_lastGlow = "";
  pf_resetColorBags();
  pf_applyOverlap(layers, o);

  PF_JOB = {
    opts: o,
    layers: layers,
    colors: [],
    idx: 0,
    done: 0,
    // 每条字幕要过 3 道工序：颜色/字体 → 波浪 → 发光
    total: layers.length * 3,
    phase: 0
  };

  return pf_progress(PF_JOB, "准备中");
}

/**
 * 推进一格。每调用一次只处理**一条**字幕的一道工序，
 * 这样进度条走得细，AE 也不会长时间卡住。
 */
function PF_runStep() {
  var job = PF_JOB;
  if (!job) return "ERR|没有正在执行的任务";

  var n = job.layers.length;

  // 当前阶段已经做完了 → 切到下一阶段（这一步不做事，只报"准备中"）
  if (job.idx >= n) {
    job.phase++;
    job.idx = 0;
    if (job.phase === 1) return pf_progress(job, "准备波浪");
    if (job.phase === 2) {
      pf_lastGlow = "";
      pf_bagGlow.bag = []; pf_bagGlow.idx = 0; pf_bagGlow.last = "";
      return pf_progress(job, "准备发光");
    }
    return pf_progress(job, "收尾");
  }

  var L = job.layers[job.idx];

  if (job.phase === 0) {
    pf_fontOnLayer(L, job.opts, job.idx);
    job.colors[job.idx] = pf_styleOne(L, job.opts, job.idx);
    // 第 2 页：在基础样式之上再套一层「随机动画」
    pf_applyRandomAnim(L, job.opts, job.idx);
  } else if (job.phase === 1) {
    pf_waveOnLayer(L, job.opts);
  } else if (job.phase === 2) {
    pf_effectsOne(L, job.opts, false, job.colors[job.idx]);
  } else {
    return pf_progress(job, "收尾");
  }

  job.idx++;
  job.done++;
  return pf_progress(job, job.phase === 0 ? "字体 / 颜色 / 动画"
                        : (job.phase === 1 ? "波浪" : "发光 / 投影"));
}

function PF_runEnd() {
  var job = PF_JOB;
  var n = job ? job.layers.length : 0;
  PF_JOB = null;
  return "OK|已应用字体/颜色/动画/波浪/发光·双层投影 (" + n + " 个图层)" +
         pf_glowWriteSummary();
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
