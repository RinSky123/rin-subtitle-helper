/* ==================================================================
 *  Rin字幕效果助手 — 面板逻辑（by RinSky123 · 完全免费使用）
 *  ① 读写 UI  ② 组装参数对象  ③ 调用宿主引擎
 * ================================================================== */
(function () {
  "use strict";

  var VERSION = "0.33";

  var cs = new CSInterface();
  var state = {
    srtPath: "",
    colors: ["#ffffff"],   // 文字/流光颜色列表（随机模式用）；只有这一个默认白时算"未设置"
    colorsSeeded: false,   // 是否已经自动铺过随机色板
    glowHue: 0,            // 横杠：色相
    glowLight: 100,        // 横杠：明暗（100 = 白）
    presets: [],           // 预设 [{name, color}]（单色用）/{name, colors}（随机用）
    fonts: [],
    fontSingle: "",
    allFonts: null
  };

  /* -------------------- 工具 -------------------- */
  function $(id) { return document.getElementById(id); }
  function val(id) { return $(id) ? $(id).value : ""; }
  function num(id) { return parseFloat(val(id)) || 0; }
  function checked(id) { return $(id) && $(id).checked; }
  function radio(name, dflt) {
    var r = document.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : dflt;
  }
  function setStatus(msg, isErr) {
    var el = $("status");
    el.textContent = msg;
    el.className = "status" + (isErr ? " err" : "");
  }
  function randomHex() {
    var h = Math.floor(Math.random() * 0xffffff).toString(16);
    while (h.length < 6) h = "0" + h;
    return "#" + h;
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    function hx(v) {
      var n = Math.max(0, Math.min(255, Math.round((v + m) * 255)));
      return ("0" + n.toString(16)).slice(-2);
    }
    return "#" + hx(r) + hx(g) + hx(b);
  }
  function pickColor() { return hslToHex(state.glowHue, 100, state.glowLight); }

  function hexToRgba(hex, a) {
    var h = String(hex || "#ffffff").replace("#", "");
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    h = ("000000" + h).slice(-6);
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return "rgba(" + (r || 0) + "," + (g || 0) + "," + (b || 0) + "," + a + ")";
  }

  function callEngine(fn, opts, label) {
    var script = "typeof " + fn + " === 'function' ? " + fn + "(" + JSON.stringify(opts) + ") : 'ERR|引擎未加载'";
    setStatus((label || fn) + " …运行中");
    cs.evalScript(script, function (res) {
      res = String(res == null ? "" : res);
      if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, "") || "执行失败", true);
      else setStatus(res.replace(/^OK\|?/, "") || "完成", false);
    });
  }

  /* -------------------- 组装参数 -------------------- */
  function buildOpts() {
    var col = pickColor();
    return {
      srtPath: state.srtPath,
      useSelection: checked("use-selection"),

      textColor: "#ffffff",           // 文字固定白色
      lineBreakBase: num("linebreak"),
      precompose: checked("precompose"),
      precompName: val("precomp-name") || "PF_字幕",

      growEnabled: checked("grow-en"),
      growAmount: num("grow-amt"),
      overlap: checked("overlap"),

      fontMode: radio("fmode", "single"),
      fontSingle: state.fontSingle,
      fonts: state.fonts.slice(),

      // 颜色 = 发光颜色
      colorMode: radio("cmode", "single"),
      singleColor: col,
      colors: state.colors.slice(),

      doEntry: checked("do-entry"),
      doExit: checked("do-exit"),
      doTracking: checked("do-tracking"),
      entryBasedOn: val("entry-based"),
      exitBasedOn: val("exit-based"),
      entrySeconds: num("entry-sec"),
      exitSeconds: num("exit-sec"),
      entryMoveY: num("entry-move"),
      exitMoveY: num("exit-move"),
      spacing: num("spacing"),
      spacingBasedOn: val("spacing-based"),

      wave: {
        enabled: checked("wave-en"),
        height: num("wave-h"),
        width: num("wave-w"),
        speed: num("wave-s")
      },

      glow: {
        enabled: checked("glow-en"),
        threshold: num("glow-th"),
        radius: num("glow-r"),
        strength: num("glow-i"),
        color: val("glow-color"),                 // 发光色（独立于文字颜色）
        colorRandom: checked("glow-color-random"), // 每句随机发光色
        shadow: true                              // 发光后自动补一层投影（固定参数）
      },

      // 流光：文字颜色以光带形式循环扫过文字
      flow: {
        enabled: checked("flow-en"),
        mode: val("flow-mode") || "band",   // band=光带 / wash=晕染留白
        period: num("flow-period"),          // 秒 / 趟（默认 5 秒）
        color: col                          // 仅作兜底；引擎实际用「文字颜色」那套色
      },


      step: 0.1
    };
  }

  /* -------------------- 颜色横杠 -------------------- */
  function updateColorUI() {
    var hex = pickColor();
    if ($("hue-h")) $("hue-h").style.left = (state.glowHue / 360 * 100) + "%";
    if ($("light-h")) $("light-h").style.left = state.glowLight + "%";
    if ($("color-swatch")) $("color-swatch").style.background = hex;
    if ($("color-hex")) $("color-hex").textContent = hex;
    if ($("light-bar")) {
      $("light-bar").style.background =
        "linear-gradient(to right, #000 0%, " + hslToHex(state.glowHue, 100, 50) + " 50%, #fff 100%)";
    }
  }

  function bindBar(barId, onChange) {
    var bar = $(barId);
    if (!bar) return;
    function fromEvent(e) {
      var r = bar.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      onChange(ratio);
      updateColorUI();
      refreshPreview();
      saveCfg();
    }
    bar.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      fromEvent(e);
      var move = function (ev) { fromEvent(ev); };
      var up = function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  /* -------------------- 颜色列表 -------------------- */

  /**
   * 随机色池是不是「还没动过的出厂状态」= 只有一个 #ffffff。
   * 是的话说明用户还没选过随机色，绝不能拿这个白去随机 —— 那就会出现"没选白色却整句纯白"。
   */
  function poolIsPristine() {
    return state.colors.length === 1 && /^#(fff|ffffff)$/i.test(state.colors[0]);
  }

  /** 给随机色池铺一组能看的颜色（只在用户没选过色时自动用） */
  function seedRandomColors() {
    state.colors = ["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"];
    state.colorsSeeded = true;
    renderColors(); refreshPreview(); saveCfg();
  }

  function renderColors() {
    var box = $("color-list");
    if (!box) return;
    box.innerHTML = "";
    state.colors.forEach(function (hex, i) {
      var wrap = document.createElement("div");
      wrap.className = "color-item";
      var sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.background = hex;
      var del = document.createElement("button");
      del.className = "del";
      del.textContent = "×";
      del.addEventListener("click", function () {
        if (state.colors.length <= 1) { setStatus("至少保留一个颜色", true); return; }
        state.colors.splice(i, 1);
        renderColors(); refreshPreview(); saveCfg();
      });
      wrap.appendChild(sw);
      wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }

  /* -------------------- 预设 -------------------- */
  /** 单个圆点 */
  function makeDot(hex) {
    var d = document.createElement("span");
    d.className = "dot";
    d.style.background = hex;
    d.title = hex;
    return d;
  }

  function renderPresets() {
    var box = $("preset-list");
    if (!box) return;
    box.innerHTML = "";
    state.presets.forEach(function (p, i) {
      // 兼容旧版存的预设（没有 mode 字段）：多色列表 → 配色，否则算单色
      var single = p.mode ? (p.mode === "single")
                          : !(p.colors && p.colors.length > 1);
      var list = single ? [p.color || "#ffffff"] : (p.colors || []);

      var chip = document.createElement("span");
      chip.className = "chip click";

      // 色点：单色 → 一个圆；多色 → 并排几个小圆（最多 5 个，多的用 +N 表示）
      var dots = document.createElement("span");
      dots.className = "dots";
      var show = single ? 1 : Math.min(5, list.length);
      for (var k = 0; k < show; k++) dots.appendChild(makeDot(list[k] || "#ffffff"));
      if (!single && list.length > show) {
        var more = document.createElement("span");
        more.className = "dot more";
        more.textContent = "+" + (list.length - show);
        more.title = "共 " + list.length + " 个颜色";
        dots.appendChild(more);
      }
      chip.appendChild(dots);

      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name;
      var x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.presets.splice(i, 1);
        renderPresets(); savePresets();
      });
      chip.appendChild(nm); chip.appendChild(x);

      chip.addEventListener("click", function () {
        if (single) {
          // 单色预设：颜色 + 横杠一起还原，预览和实际都跟着变
          setColorTo(p.color || "#ffffff");
          var r = document.querySelector('input[name="cmode"][value="single"]');
          if (r && !r.checked) { r.checked = true; syncColorUI(); }
          setStatus("已套用预设：" + p.name);
        } else {
          if (p.colors && p.colors.length) {
            state.colors = p.colors.slice();
            state.colorsSeeded = true;
            var r2 = document.querySelector('input[name="cmode"][value="random"]');
            if (r2 && !r2.checked) { r2.checked = true; }
            renderColors(); syncColorUI(); refreshPreview(); saveCfg();
            setStatus("已套用预设：" + p.name);
          }
        }
      });
      box.appendChild(chip);
    });
  }

  /** 把横杠状态调到某个颜色（用 HSL 反推） */
  function setColorTo(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var r = parseInt(h.substr(0, 2), 16) / 255, g = parseInt(h.substr(2, 2), 16) / 255, b = parseInt(h.substr(4, 2), 16) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var hue = 0;
    if (d !== 0) {
      if (mx === r) hue = 60 * (((g - b) / d) % 6);
      else if (mx === g) hue = 60 * ((b - r) / d + 2);
      else hue = 60 * ((r - g) / d + 4);
    }
    if (hue < 0) hue += 360;
    state.glowHue = Math.round(hue);
    state.glowLight = Math.round((mx + mn) / 2 * 100);
    updateColorUI(); refreshPreview(); saveCfg();
  }

  function savePresets() {
    try { localStorage.setItem("rinsubtitle_presets", JSON.stringify(state.presets)); } catch (e) {}
  }
  function loadPresets() {
    try {
      var d = JSON.parse(localStorage.getItem("rinsubtitle_presets") || "[]");
      if (d && d.length) state.presets = d;
    } catch (e) {}
  }

  /* -------------------- 系统字体 -------------------- */
  function applyFontText(text, cb) {
    var lines = String(text).split("\n");
    var arr = [];
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      var p = lines[i].split("\t");
      arr.push({ ps: p[0], family: p[1] || p[0] });
    }
    if (!arr.length) return false;
    state.allFonts = arr;
    $("font-scan-info").textContent = "共 " + arr.length + " 个字体";
    setStatus("扫描到 " + arr.length + " 个系统字体");
    refreshPreview();
    if (cb) cb(true);
    return true;
  }
  function nodeScanFonts() {
    try {
      var req = (typeof require === "function") ? require : (window.cep_node ? window.cep_node.require : null);
      if (!req) return null;
      var path = req("path");
      var ext = cs.getSystemPath("extension");
      return req(path.join(ext, "client", "fonts.js")).listFonts();
    } catch (e) { return null; }
  }
  function scanFonts(cb) {
    setStatus("正在扫描系统字体…");
    cs.evalScript(
      "typeof PF_listFonts === 'function' ? PF_listFonts() : 'ERR|引擎未加载'",
      function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") !== 0 && applyFontText(res.replace(/^OK\|/, ""), cb)) return;
        var arr = nodeScanFonts();
        if (arr && arr.length) {
          state.allFonts = arr;
          $("font-scan-info").textContent = "共 " + arr.length + " 个字体";
          setStatus("扫描到 " + arr.length + " 个系统字体");
          refreshPreview();
          if (cb) cb(true);
          return;
        }
        $("font-scan-info").textContent = "扫描失败";
        setStatus("扫描字体失败：" + res.replace(/^ERR\|/, ""), true);
        if (cb) cb(false);
      }
    );
  }
  function ensureFonts(force, cb) {
    if (state.allFonts && !force) { if (cb) cb(true); return; }
    scanFonts(cb);
  }
  /**
   * PostScript 名 → 家族名兜底。
   * 没扫描到系统字体表时也要能预览：Arial-BoldItalicMT → Arial。
   */
  function psToFamily(ps) {
    var s = String(ps || "");
    s = s.replace(/^[A-Za-z]{6}\+/, "");      // 去掉子集前缀 ABCDEF+
    var base = s.split("-")[0];
    return base || s;
  }

  function fontLabel(ps) {
    if (!ps) return "";
    if (state.allFonts) {
      for (var i = 0; i < state.allFonts.length; i++) {
        if (state.allFonts[i].ps === ps) return state.allFonts[i].family;
      }
    }
    return psToFamily(ps);
  }

  function renderFontChips() {
    var box = $("font-list");
    box.innerHTML = "";
    state.fonts.forEach(function (ps, i) {
      var chip = document.createElement("span");
      chip.className = "chip";
      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = fontLabel(ps);
      nm.title = ps;
      var x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.addEventListener("click", function () {
        state.fonts.splice(i, 1);
        renderFontChips(); refreshPreview(); saveCfg();
      });
      chip.appendChild(nm); chip.appendChild(x);
      box.appendChild(chip);
    });
    $("font-count").textContent = state.fonts.length;
  }

  function syncFontUI() {
    $("font-single-name").textContent = state.fontSingle ? fontLabel(state.fontSingle) : "未设置";
  }

  /* -------------------- 字体弹窗 -------------------- */
  var pickMode = "multi";
  function renderFontOptions(filter) {
    var box = $("font-options");
    box.innerHTML = "";
    var list = state.allFonts || [];
    var f = (filter || "").toLowerCase();
    var shown = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (f && (it.family + " " + it.ps).toLowerCase().indexOf(f) < 0) continue;
      shown++;
      var row = document.createElement("div");
      row.className = "font-row";
      var isSel = pickMode === "single" ? state.fontSingle === it.ps : state.fonts.indexOf(it.ps) >= 0;
      if (isSel) row.className += " sel";
      var name = document.createElement("span");
      name.className = "fname";
      name.textContent = it.family;
      name.style.fontFamily = "'" + it.family.replace(/'/g, "") + "'";
      var ps = document.createElement("span");
      ps.className = "fps";
      ps.textContent = it.ps;
      row.appendChild(name); row.appendChild(ps);
      (function (item) {
        row.addEventListener("click", function () {
          if (pickMode === "single") {
            state.fontSingle = item.ps;
            closeFontModal();
            syncFontUI(); refreshPreview(); saveCfg();
            setStatus("统一字体：" + item.family);
          } else {
            var k = state.fonts.indexOf(item.ps);
            if (k >= 0) state.fonts.splice(k, 1); else state.fonts.push(item.ps);
            renderFontOptions(val("font-search"));
            renderFontChips(); refreshPreview(); saveCfg();
          }
        });
      })(it);
      box.appendChild(row);
    }
    if (shown === 0) box.innerHTML = '<div class="hint" style="padding:10px">没有匹配的字体</div>';
  }
  function openFontModal(mode) {
    pickMode = mode;
    $("font-modal").classList.remove("hidden");
    renderFontOptions(val("font-search"));
    ensureFonts(false, function () { renderFontOptions(val("font-search")); });
  }
  function closeFontModal() { $("font-modal").classList.add("hidden"); }

  /* -------------------- 预览（字体/颜色/发光/投影/波浪/动画） -------------------- */
  var pvIndex = 0;

  function pvPickFont() {
    if (radio("fmode", "single") === "single") return state.fontSingle || "";
    if (!state.fonts.length) return "";
    return state.fonts[pvIndex % state.fonts.length];
  }
  function pvPickColor() {
    if (radio("cmode", "single") === "single") return pickColor();
    // 随机模式：色池还是出厂默认白的话，预览也别拿它当随机色
    if (poolIsPristine()) return ["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"][pvIndex % 7];
    if (!state.colors.length) return pickColor();
    return state.colors[pvIndex % state.colors.length];
  }

  /** 预览用的发光色（勾了「每句随机」就轮换，模拟每句不同色） */
  var PV_VIVID = ["#ffffff", "#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dffd2",
                  "#4dd2ff", "#4d7dff", "#b44dff", "#ff4dd2", "#ff7ac6", "#00e5a0"];
  function pvGlowColor() {
    if (checked("glow-color-random")) return PV_VIVID[pvIndex % PV_VIVID.length];
    return val("glow-color") || "#ffffff";
  }

  /** 从 PostScript 名推 CSS 的 family / 粗细 / 斜体，尽量还原真实字体 */
  function pvFontCss(ps) {
    var low = String(ps).toLowerCase();
    var weight = "normal", style = "normal";
    if (low.indexOf("black") >= 0 || low.indexOf("heavy") >= 0) weight = "900";
    else if (low.indexOf("extrabold") >= 0 || low.indexOf("ultrabold") >= 0) weight = "800";
    else if (low.indexOf("semibold") >= 0 || low.indexOf("demibold") >= 0) weight = "600";
    else if (low.indexOf("bold") >= 0) weight = "700";
    else if (low.indexOf("medium") >= 0) weight = "500";
    else if (low.indexOf("light") >= 0) weight = "300";
    else if (low.indexOf("thin") >= 0 || low.indexOf("hairline") >= 0) weight = "100";
    if (low.indexOf("italic") >= 0 || low.indexOf("oblique") >= 0) style = "italic";
    // fontLabel 内部已做：先查系统字体表拿真家族名，查不到才用 PS 名推断
    return { family: fontLabel(ps) || psToFamily(ps), weight: weight, style: style };
  }

  function buildPreviewShadow() {
    var out = [];
    if (checked("glow-en")) {
      var blur = Math.max(1, num("glow-r") / 14);
      var alpha = Math.max(0.15, Math.min(0.9, num("glow-i") / 1.2));
      var gcol = pvGlowColor();
      for (var k = 1; k <= 3; k++) {
        out.push("0 0 " + (blur * k / 1.8).toFixed(1) + "px " + hexToRgba(gcol, alpha));
      }
    }
    // 投影：跟着发光一起自动加（和引擎里 PF_SHADOW 一致）
    if (checked("glow-en")) {
      out.push("-7px 7px 12px " + hexToRgba("#000000", 1));
    }
    return out.join(", ");
  }

  /** 波浪 / 流光：勾选时逐字起伏 / 逐字扫光（两个都勾就同时上） */
  function buildPreviewChars(el) {
    if (!el) return;
    // 用元素自己原来的文字，中英两列各显示各的
    var txt = el.getAttribute("data-text");
    if (txt === null) {
      txt = el.textContent;
      el.setAttribute("data-text", txt);
    }
    var waveOn = checked("wave-en"), flowOn = checked("flow-en");
    if (!waveOn && !flowOn) { el.textContent = txt; return; }

    var amp = Math.max(1, num("wave-h") / 4);
    var wdur = 1 / Math.max(0.15, num("wave-s"));
    var wstep = Math.max(0.02, Math.min(0.3, num("wave-w") / 4000));

    // 流光：一个周期 = 面板上的「周期」（秒）。每字错开「周期 ÷ 字数」→
    // 整行正好铺满一个波长，看起来是一整片颜色晕染着扫过整句，而不是一个字一个字跳。
    var fdur = Math.max(0.5, num("flow-period") || 5);
    var fstep = fdur / Math.max(2, txt.length);

    el.innerHTML = "";
    for (var i = 0; i < txt.length; i++) {
      var s = document.createElement("span");
      s.textContent = txt.charAt(i);
      s.style.display = "inline-block";
      s.style.setProperty("--pv-amp", amp.toFixed(1) + "px");
      var anim = [], delay = [];
      if (waveOn) { anim.push("pvWave " + wdur.toFixed(2) + "s ease-in-out infinite"); delay.push((i * wstep).toFixed(2) + "s"); }
      if (flowOn) { anim.push("pvFlow " + fdur.toFixed(2) + "s ease-in-out infinite"); delay.push((i * fstep).toFixed(3) + "s"); }
      s.style.animation = anim.join(", ");
      s.style.animationDelay = delay.join(", ");
      el.appendChild(s);
    }
  }

  /** 预览里的四个文本元素：左列英文两行、右列中文两行 */
  var PV_IDS_ALL = ["pv-en-1", "pv-en-2", "pv-cn-1", "pv-cn-2"];

  function applyPreviewStyle() {
    var els = [];
    for (var i = 0; i < PV_IDS_ALL.length; i++) {
      var e = $(PV_IDS_ALL[i]);
      if (e) els.push(e);
    }
    if (!els.length) return;

    var ps = pvPickFont();
    var f = pvFontCss(ps);

    // 流光两种模式，和 AE 端一致：
    //   光带    → 底色白，选的颜色作为光带扫过
    //   晕染留白 → 整句就是这个颜色，一段柔和的留白滑过去
    var flowOn = checked("flow-en");
    var fmode = val("flow-mode") || "band";
    var col = pvPickColor();
    var base = col, band = col;
    if (flowOn && fmode === "band") base = "#ffffff";
    if (flowOn && fmode === "wash") band = "#ffffff";

    var shadow = buildPreviewShadow();
    for (var k = 0; k < els.length; k++) {
      var el = els[k];
      el.style.fontFamily = ps
        ? "'" + String(f.family).replace(/'/g, "") + "', 'Microsoft YaHei', 'Segoe UI', sans-serif"
        : "";
      el.style.fontWeight = f.weight;
      el.style.fontStyle = f.style;
      el.style.color = base;
      el.style.setProperty("--pv-base", base);
      el.style.setProperty("--pv-flow", band);
      el.style.textShadow = shadow;
      buildPreviewChars(el);
    }
  }

  /* ---- 预览用的动画：和引擎里的预设一一对应 ---- */

  var PV_FULL = "inset(0 0% 0 0)";

  /** 预览用哪种入场观感：跟第 1 页的粒度走 */
  function pvAnimId() {
    var b = val("entry-based");
    return b === "sentence" ? "fade" : (b === "word" ? "wordfade" : "wipe");
  }

  /** 入场关键帧：起始态(offset 0) → 正常态(offset te)。属性集固定，方便逐帧插值 */
  function animInFrames(id, te) {
    function k(o) {
      return {
        offset: o.offset,
        opacity: o.opacity === undefined ? 1 : o.opacity,
        transform: o.transform || "scale(1)",
        clipPath: o.clipPath || PV_FULL,
        filter: o.filter || "blur(0px)",
        letterSpacing: o.letterSpacing || "0.02em"
      };
    }
    switch (id) {
      case "fade":     return [k({ offset: 0, opacity: 0 }), k({ offset: te })];
      case "wash":     return [k({ offset: 0, opacity: 0, filter: "blur(7px)", transform: "scale(1.07)" }), k({ offset: te })];
      case "glow":     return [k({ offset: 0, opacity: 0, filter: "blur(5px)", transform: "scale(1.35)" }), k({ offset: te })];
      case "rise":     return [k({ offset: 0, opacity: 0, transform: "translateY(26px)" }), k({ offset: te })];
      case "wordfade": return [k({ offset: 0, opacity: 0, filter: "blur(4px)" }), k({ offset: te })];
      case "tracking": return [k({ offset: 0, opacity: 0, letterSpacing: "0.32em" }), k({ offset: te })];
      case "pop":      return [k({ offset: 0, opacity: 0, transform: "scale(0.55)" }), k({ offset: te })];
      default:         return [k({ offset: 0, clipPath: "inset(0 100% 0 0)" }), k({ offset: te })];
    }
  }
  function cloneKF(o, offset) {
    var r = {};
    for (var k in o) { if (k !== "offset") r[k] = o[k]; }
    r.offset = offset;
    return r;
  }

  /**
   * 给某一句生成「入场 → 停留 → 出场」的关键帧。
   * 关键点：入场前和出场后都必须是**不可见**的（否则两句会同时挂在屏幕上，
   * 看不出"接替"）。所以首帧前补一个透明帧，尾帧用出场终态一直保持到 1。
   */
  function buildLineFrames(holdSec, delaySec, totalSec) {
    var entry = Math.max(0.05, num("entry-sec"));
    var exit = Math.max(0.05, num("exit-sec"));
    var doEntry = checked("do-entry"), doExit = checked("do-exit");
    var g = num("grow-amt") / 100;
    var id = pvAnimId();

    var pair = animInFrames(id, 1);        // [起始态, 正常态]
    var out = [];

    var t0 = delaySec;
    var tIn = t0 + (doEntry ? entry : 0);
    var tOut = tIn + holdSec;
    var tEnd = tOut + (doExit ? exit : 0);
    var o0 = t0 / totalSec, oIn = tIn / totalSec, oOut = tOut / totalSec, oEnd = tEnd / totalSec;

    function withScale(kf, sc) {
      var t = kf.transform || "scale(1)";
      return (t === "scale(1)") ? ("scale(" + sc + ")") : (t + " scale(" + sc + ")");
    }
    var holdScale = (1 + g * Math.min(1, oOut)).toFixed(3);
    var endScale = (1 + g).toFixed(3);

    // 出场终态（也是"不可见"的那一帧）
    var hidden = cloneKF(pair[0], Math.max(oEnd, oOut + 0.0001));
    hidden.opacity = 0;
    if (id === "wipe") hidden.clipPath = "inset(0 0% 0 100%)";
    hidden.transform = withScale(pair[0], endScale);

    // 入场之前的隐藏帧（避免循环开头就露出来）
    if (o0 > 0.0005) {
      var pre = cloneKF(hidden, 0);
      pre.opacity = 0;
      out.push(pre);
    }

    if (doEntry) {
      var inF = animInFrames(id, Math.max(0.0001, oIn - o0));
      out.push(cloneKF(inF[0], o0), cloneKF(inF[1], oIn));
    } else {
      out.push(cloneKF(pair[1], o0));
    }

    if (doExit) {
      var startKF = cloneKF(pair[1], oOut);
      startKF.transform = withScale(pair[1], holdScale);
      out.push(startKF, hidden);
      // 这一句走完就结束了，但整轮动画还要继续 —— 必须补一个末尾帧把"不可见"保持住，
      // 否则关键帧没覆盖到 100%，播过头会回到初始样式（字又冒出来，看起来就是闪一下）
      if (oEnd < 0.9995) out.push(cloneKF(hidden, 1));
    } else {
      var hk = cloneKF(pair[1], oOut);
      hk.transform = withScale(pair[1], holdScale);
      out.push(hk, cloneKF(pair[1], 1));
    }
    return out;
  }

  var pvAnims = [];   // 四个元素上的动画实例

  /**
   * 两句交替预览（同一行，不是上下两行）：
   *   第 1 句：入场 → 停留 → 出场
   *   第 2 句：在**第 1 句刚开始出场时**就在原位入场，两句重叠一段时间后第 1 句消失
   * 这样看到的就是"旧字幕让路、新字幕接上"的接替。
   * 左右两列（英/中）共用同一时间轴，完全同步。
   */
  function refreshAnimPreview() {
    for (var i = 0; i < pvAnims.length; i++) { try { pvAnims[i].cancel(); } catch (e) {} }
    pvAnims = [];

    var entry = Math.max(0.05, num("entry-sec"));
    var exit = Math.max(0.05, num("exit-sec"));
    var doEntry = checked("do-entry"), doExit = checked("do-exit");

    var hold = Math.max(2.2, entry + exit + 1.2);
    var lineSpan = (doEntry ? entry : 0) + hold + (doExit ? exit : 0);

    // 第 2 句提前 exit 秒开始入场 → 正好落在第 1 句的出场区间里，形成交叠接替
    var overlap = doExit ? Math.min(exit, Math.max(0.15, exit * 0.85)) : 0.2;
    var start2 = Math.max(0, (doEntry ? entry : 0) + hold - overlap);

    // 总时长 = 第 2 句完整走完；第 1 句在自己的出场结束后保持不可见
    var total = start2 + lineSpan;
    if (total <= 0) return;

    var frames1 = buildLineFrames(hold, 0, total);
    var frames2 = buildLineFrames(hold, start2, total);

    var dur = Math.round(total * 1000);
    function play(el, frames) {
      if (!el || !el.animate) return;
      try { pvAnims.push(el.animate(frames, { duration: dur, iterations: Infinity })); } catch (e) {}
    }

    // 左列英文两行、右列中文两行，各自跑第一/第二句
    play($("pv-en-1"), frames1);
    play($("pv-cn-1"), frames1);
    play($("pv-en-2"), frames2);
    play($("pv-cn-2"), frames2);
  }

  var pvTimer = null;
  function refreshPreview() {
    pvIndex = 0;
    applyPreviewStyle();
    refreshAnimPreview();
    if (pvTimer) { clearInterval(pvTimer); pvTimer = null; }
    var needCycle = radio("fmode", "single") !== "single" ||
                    (radio("cmode", "single") !== "single" && state.colors.length > 1);
    if (needCycle) pvTimer = setInterval(function () { pvIndex++; applyPreviewStyle(); }, 2600);
  }

  /* -------------------- 滑块显示 -------------------- */
  var updaters = {};   // id -> 刷新显示的函数（重置后要重新刷一遍）

  function bindRange(id, valId, suffix) {
    var el = $(id), out = $(valId);
    if (!el || !out) return;
    function upd() { out.textContent = el.value + (suffix || ""); }
    el.addEventListener("input", upd);
    updaters[id] = upd;
    upd();
  }
  function bindDec(id, valId, digits, suffix) {
    var el = $(id), out = $(valId);
    if (!el || !out) return;
    function upd() { out.textContent = parseFloat(el.value).toFixed(digits) + (suffix || ""); }
    el.addEventListener("input", upd);
    updaters[id] = upd;
    upd();
  }
  function bindSec(id, valId) { bindDec(id, valId, 2, "s"); }

  function refreshAllDisplays() {
    for (var id in updaters) { try { updaters[id](); } catch (e) {} }
  }

  /* -------------------- 持久化 -------------------- */
  var FIELDS = ["linebreak", "precomp-name",
    "grow-amt",
    "entry-based", "exit-based", "entry-sec", "exit-sec", "entry-move", "exit-move",
    "spacing", "spacing-based", "wave-h", "wave-w", "wave-s",
    "glow-th", "glow-r", "glow-i", "glow-color", "flow-period", "flow-mode"];
  var CHECKS = ["do-entry", "do-exit", "do-tracking", "wave-en", "glow-en", "use-selection",
    "precompose", "grow-en", "overlap", "flow-en", "glow-color-random"];

  function saveCfg() {
    var data = { colors: state.colors, glowHue: state.glowHue, glowLight: state.glowLight,
                 fonts: state.fonts, fontSingle: state.fontSingle };
    FIELDS.forEach(function (f) { data[f] = val(f); });
    CHECKS.forEach(function (c) { data[c] = checked(c); });
    data.cmode = radio("cmode", "single");
    data.fmode = radio("fmode", "single");
    try { localStorage.setItem("rinsubtitle", JSON.stringify(data)); } catch (e) {}
  }

  function loadCfg() {
    var data;
    try { data = JSON.parse(localStorage.getItem("rinsubtitle") || "null"); } catch (e) { data = null; }
    if (!data) return;
    FIELDS.forEach(function (f) { if (data[f] !== undefined && $(f)) $(f).value = data[f]; });
    CHECKS.forEach(function (c) { if (data[c] !== undefined && $(c)) $(c).checked = data[c]; });
    if (data.colors && data.colors.length) state.colors = data.colors;
    if (typeof data.glowHue === "number") state.glowHue = data.glowHue;
    if (typeof data.glowLight === "number") state.glowLight = data.glowLight;
    if (data.fonts && data.fonts.length) state.fonts = data.fonts;
    if (data.fontSingle) state.fontSingle = data.fontSingle;
    [["cmode", data.cmode], ["fmode", data.fmode]].forEach(function (p) {
      if (!p[1]) return;
      var r = document.querySelector('input[name="' + p[0] + '"][value="' + p[1] + '"]');
      if (r) r.checked = true;
    });
  }

  /** 单色时隐藏随机颜色那一块 */
  function syncColorUI() {
    var single = radio("cmode", "single") === "single";
    var box = $("color-random-box");
    if (box) box.classList.toggle("hidden", single);
  }

  /* -------------------- 重置（还原出厂默认值） -------------------- */
  var DEFAULTS = null;   // 启动时快照的面板默认值

  var GROUP_IDS = {
    "1": ["linebreak", "precomp-name", "precompose"],
    "2": [],
    "3": ["glow-en", "glow-th", "glow-r", "glow-i", "glow-color", "glow-color-random",
          "flow-en", "flow-mode", "flow-period", "radio:cmode"],
    "4": ["do-entry", "entry-based", "entry-sec", "do-exit", "exit-based", "exit-sec",
          "entry-move", "exit-move", "overlap", "do-tracking", "spacing", "spacing-based",
          "grow-en", "grow-amt"],
    "5": ["wave-en", "wave-h", "wave-w", "wave-s"]
  };

  /** 必须在读取用户配置之前调用：把面板当前的出厂值快照下来 */
  function snapshotDefaults() {
    DEFAULTS = {};
    for (var k in GROUP_IDS) {
      (function (ids) {
        ids.forEach(function (id) {
          if (id.indexOf("radio:") === 0) {
            var n = id.slice(6);
            var r = document.querySelector('input[name="' + n + '"]:checked');
            DEFAULTS[id] = { v: r ? r.value : "" };
            return;
          }
          var el = $(id);
          if (!el) return;
          if (el.type === "checkbox") DEFAULTS[id] = { c: el.checked };
          else DEFAULTS[id] = { v: el.value };
        });
      })(GROUP_IDS[k]);
    }
    DEFAULTS.__bars = { hue: state.glowHue, light: state.glowLight, colors: state.colors.slice() };

    // 用户点过「存为默认」的话，用他存的那套覆盖出厂值
    try {
      var saved = JSON.parse(localStorage.getItem("rinsubtitle_defaults") || "null");
      if (saved) {
        for (var id in saved) {
          if (id === "__bars") { if (saved.__bars) DEFAULTS.__bars = saved.__bars; continue; }
          if (DEFAULTS[id] !== undefined) DEFAULTS[id] = saved[id];
        }
      }
    } catch (e) {}
  }

  /** 把当前面板参数存成「我的默认值」，各卡片的重置就回到这一套 */
  function saveAsDefault() {
    var data = {};
    for (var k in GROUP_IDS) {
      (function (ids) {
        ids.forEach(function (id) {
          if (id.indexOf("radio:") === 0) {
            var n = id.slice(6);
            var r = document.querySelector('input[name="' + n + '"]:checked');
            data[id] = { v: r ? r.value : "" };
            return;
          }
          var el = $(id);
          if (!el) return;
          if (el.type === "checkbox") data[id] = { c: el.checked };
          else data[id] = { v: el.value };
        });
      })(GROUP_IDS[k]);
    }
    data.__bars = { hue: state.glowHue, light: state.glowLight, colors: state.colors.slice() };
    DEFAULTS = data;
    try { localStorage.setItem("rinsubtitle_defaults", JSON.stringify(data)); } catch (e) {}
    setStatus("已把当前参数存为默认值，以后各卡片「重置」就回到这一套");
  }

  function resetGroup(k) {
    k = String(k);
    if (!DEFAULTS) return;
    (GROUP_IDS[k] || []).forEach(function (id) {
      if (id.indexOf("radio:") === 0) {
        var n = id.slice(6), dv = DEFAULTS[id] ? DEFAULTS[id].v : "";
        var el = document.querySelector('input[name="' + n + '"][value="' + dv + '"]');
        if (el) el.checked = true;
        return;
      }
      var e = $(id), d = DEFAULTS[id];
      if (!e || !d) return;
      if (d.c !== undefined) e.checked = d.c;
      else e.value = d.v;
    });

    if (k === "2") { state.fonts = []; state.fontSingle = ""; }
    if (k === "3") {
      state.glowHue = DEFAULTS.__bars.hue;
      state.glowLight = DEFAULTS.__bars.light;
      state.colors = DEFAULTS.__bars.colors.slice();
    }

    refreshAllDisplays();
    renderFontChips(); renderColors(); renderPresets();
    updateColorUI(); syncColorUI(); syncFontUI();
    refreshPreview(); saveCfg();
    setStatus("已重置该组件的参数");
  }

  /* -------------------- 事件绑定 -------------------- */
  function bind() {
    bindRange("linebreak", "linebreak-val");
    bindDec("flow-period", "flow-period-val", 1, "s");
    bindRange("grow-amt", "grow-amt-val", "%");
    bindSec("entry-sec", "entry-sec-val");
    bindSec("exit-sec", "exit-sec-val");
    bindRange("spacing", "spacing-val");
    bindRange("wave-h", "wave-h-val");
    bindRange("wave-w", "wave-w-val");
    bindRange("wave-s", "wave-s-val");
    bindRange("glow-th", "glow-th-val");
    bindRange("glow-r", "glow-r-val");
    bindRange("glow-i", "glow-i-val");

    ["cmode", "fmode"].forEach(function (n) {
      Array.prototype.forEach.call(document.querySelectorAll('input[name="' + n + '"]'), function (r) {
        r.addEventListener("change", function () {
          // 切到「随机」时，如果色池还是出厂那个默认白，先铺一组颜色，
          // 否则随机出来就是整句纯白
          if (n === "cmode" && r.value === "random" && r.checked && poolIsPristine()) {
            seedRandomColors();
            setStatus("随机颜色已铺好，点色块可以改");
          }
          syncColorUI(); syncFontUI(); refreshPreview(); saveCfg();
        });
      });
    });

    // 重置按钮
    Array.prototype.forEach.call(document.querySelectorAll("button.reset"), function (b) {
      b.addEventListener("click", function () { resetGroup(b.getAttribute("data-reset")); });
    });


    // ① 字幕
    $("pick-srt").addEventListener("click", function () {
      cs.evalScript("PF_pickSRT()", function (p) {
        if (p && p !== "undefined" && p !== "" && p !== "EvalScript error.") {
          state.srtPath = p;
          $("srt-name").textContent = p.replace(/^.*[\\\/]/, "");
          $("srt-name").title = p;
          setStatus("已选择字幕：" + $("srt-name").textContent);
        } else setStatus("未选择文件", true);
      });
    });
    $("import-srt").addEventListener("click", function () {
      if (!state.srtPath) { setStatus("请先选择 SRT 文件", true); return; }
      callEngine("PF_importSRT", buildOpts(), "导入字幕");
    });

    // ② 字体
    $("pick-font-single").addEventListener("click", function () { openFontModal("single"); });
    $("add-fonts").addEventListener("click", function () { openFontModal("multi"); });
    $("clear-fonts").addEventListener("click", function () {
      state.fonts = []; renderFontChips(); refreshPreview(); saveCfg();
    });
    $("apply-fonts").addEventListener("click", function () {
      var mode = radio("fmode", "single");
      if (mode === "single" && !state.fontSingle) { setStatus("请先点「选择字体」挑一个统一字体", true); return; }
      if (mode !== "single" && !state.fonts.length) { setStatus("请先点「+ 添加」把要随机的字体选进来", true); return; }
      callEngine("PF_fonts", buildOpts(), "修改字体");
    });
    $("font-modal-ok").addEventListener("click", closeFontModal);
    $("font-modal").addEventListener("click", function (e) {
      if (e.target === $("font-modal")) closeFontModal();
    });
    $("font-search").addEventListener("input", function () { renderFontOptions(val("font-search")); });
    $("font-scan").addEventListener("click", function () {
      ensureFonts(true, function () { renderFontOptions(val("font-search")); });
    });

    // ③ 颜色（横杠）
    bindBar("hue-bar", function (r) { state.glowHue = Math.round(r * 360); });
    bindBar("light-bar", function (r) { state.glowLight = Math.round(r * 100); });
    $("add-color").addEventListener("click", function () {
      if (state.colors.length >= 12) { setStatus("最多 12 个颜色", true); return; }
      var hex = pickColor();
      if (poolIsPristine()) {
        // 池子还是出厂那个默认白 → 直接换掉它，别把白色留在随机池里
        state.colors = [hex];
        state.colorsSeeded = true;
        setStatus("已用当前颜色替换掉默认白色");
      } else {
        state.colors.push(hex);
      }
      renderColors(); refreshPreview(); saveCfg();
    });
    $("randomize-colors").addEventListener("click", function () {
      if (poolIsPristine()) { seedRandomColors(); setStatus("已铺一组随机色板"); return; }
      state.colors = state.colors.map(function () { return randomHex(); });
      renderColors(); refreshPreview(); saveCfg();
    });
    $("preset-save").addEventListener("click", function () {
      var single = radio("cmode", "single") === "single";
      var col = pickColor();
      var nm = single ? ("颜色 " + col) : ("配色 ×" + state.colors.length);
      // mode 决定这个预设是"单色"还是"一套配色"；色点按 mode 显示，
      // 否则单色预设会去取随机色池的第一个色，看着就不是当前选的颜色
      state.presets.push({
        name: nm,
        mode: single ? "single" : "random",
        color: col,
        colors: single ? [] : state.colors.slice()
      });
      renderPresets(); savePresets();
      setStatus("已保存预设：" + nm);
    });

    // 执行
    $("run-all").addEventListener("click", function () { callEngine("PF_runAll", buildOpts(), "一键生成效果"); });
    $("run-animate").addEventListener("click", function () { callEngine("PF_animate", buildOpts(), "应用动画"); });
    $("run-fonts").addEventListener("click", function () { callEngine("PF_fonts", buildOpts(), "随机字体"); });
    $("run-wave").addEventListener("click", function () { callEngine("PF_wave", buildOpts(), "应用波浪"); });
    $("run-glow").addEventListener("click", function () { callEngine("PF_glow", buildOpts(), "应用发光"); });
    $("run-interlace").addEventListener("click", function () { callEngine("PF_interlace", buildOpts(), "图层交错"); });
    $("run-adjust").addEventListener("click", function () { callEngine("PF_adjustment", buildOpts(), "调整图层"); });
    $("save-cfg").addEventListener("click", function () { saveCfg(); setStatus("设置已保存"); });
    $("save-default").addEventListener("click", saveAsDefault);
    $("diag-shadow").addEventListener("click", function () {
      cs.evalScript("typeof PF_shadowDebug === 'function' ? PF_shadowDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("投影实际值：" + res.replace(/^OK\|/, ""));
      });
    });
    $("diag").addEventListener("click", function () {
      cs.evalScript("typeof PF_animDebug === 'function' ? PF_animDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("诊断结果：" + res.replace(/^OK\|/, ""));
      });
    });

    // 预览联动
    var PV_IDS = ["entry-sec", "exit-sec", "grow-amt", "entry-based", "exit-based", "do-entry", "do-exit",
      "glow-en", "glow-th", "glow-r", "glow-i", "glow-color", "glow-color-random",
      "flow-en", "flow-mode", "flow-period",
      "wave-en", "wave-h", "wave-w", "wave-s"];
    PV_IDS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", refreshPreview);
      el.addEventListener("change", refreshPreview);
    });

    FIELDS.forEach(function (f) { if ($(f)) $(f).addEventListener("change", saveCfg); });
    CHECKS.forEach(function (c) { if ($(c)) $(c).addEventListener("change", saveCfg); });
  }

  /* -------------------- 引擎加载 -------------------- */
  function enginePath() {
    var ext = cs.getSystemPath("extension");
    if (!ext) return "";
    return (ext + "/host/engine.jsx").replace(/\\/g, "/");
  }
  function loadEngine(cb) {
    var jsx = enginePath();
    if (!jsx) { cb("ERR|拿不到扩展路径 (getSystemPath 返回空)"); return; }
    var script = 'try{ $.evalFile("' + jsx + '"); "OK|LOADED"; }' +
                 'catch(e){ "ERR|" + e.toString() + "  [line " + (e.line || "?") + "]" }';
    cs.evalScript(script, function (r) {
      r = String(r == null ? "" : r);
      if (r.indexOf("ERR") === 0) { cb(r); return; }
      cs.evalScript("typeof PF_ping === 'function' ? PF_ping() : 'ERR|引擎已加载但 PF_ping 未定义'", cb);
    });
  }

  /* -------------------- 初始化 -------------------- */
  function init() {
    if ($("ver")) $("ver").textContent = "v" + VERSION;
    snapshotDefaults();      // 先记下出厂默认值，再读用户配置
    loadCfg();
    loadPresets();
    // 兜底：以前存下来的配置里，随机色池可能还是那个出厂默认白 ——
    // 那样随机出来的就是整句纯白。这里补一组颜色。
    if (radio("cmode", "single") === "random" && poolIsPristine()) seedRandomColors();
    renderColors();
    renderPresets();
    renderFontChips();
    syncColorUI();
    syncFontUI();
    updateColorUI();
    bind();
    renderFontOptions("");
    refreshPreview();
    setStatus("连接引擎中…");

    loadEngine(function (r) {
      r = String(r == null ? "" : r);
      if (r.indexOf("ERR") === 0) {
        $("host-info").textContent = "未连接";
        setStatus("引擎加载失败：\n" + r.replace(/^ERR\|/, ""), true);
      } else {
        $("host-info").textContent = r.replace(/^OK\|/, "") || "已连接";
        setStatus("就绪");
        // 引擎就绪后扫一次系统字体：④ 的预览才能用上真实字体家族名
        ensureFonts(false, function () {
          syncFontUI();
          renderFontChips();
          refreshPreview();
        });
      }
    });
  }

  function boot() {
    try { init(); }
    catch (e) {
      try {
        var el = document.getElementById("status");
        if (el) { el.className = "status err"; el.textContent = "面板出错：" + ((e && e.message) ? e.message : e); }
      } catch (e2) {}
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
