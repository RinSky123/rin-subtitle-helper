/* ==================================================================
 *  Rin字幕效果助手 — 面板逻辑（by RinSky123 · 完全免费使用）
 *  ① 读写 UI  ② 组装参数对象  ③ 调用宿主引擎
 * ================================================================== */
(function () {
  "use strict";

  var VERSION = "1.13.1";

  /* 配置存储的版本号。改动默认值 / 字段结构时 +1，
     旧版本的存档会被丢弃，保证新默认值能生效（不会被旧存档"粘住"）。 */
  var CFG_VER = 1131;

  var cs = new CSInterface();
  var state = {
    srtPath: "",
    // 文字颜色
    colors: ["#ffffff"],   // 随机模式用的色池；只有这一个默认白时算"未设置"
    colorsSeeded: false,
    hue: 0,                // 色相横杠
    light: 100,            // 明暗横杠（100 = 白）
    presets: [],           // 文字颜色预设 [{name, mode, color, colors}]
    // 发光颜色（与文字颜色完全独立）
    glowColors: ["#ffffff"],
    glowColorsSeeded: false,
    glowHue: 0,
    glowLight: 100,
    glowPresets: [],       // 发光颜色预设
    // 参数预设（整套面板参数）
    paramPresets: [],
    fonts: [],
    fontSingle: "",
    allFonts: null,

    /* ---------- 第 2 页：随机字幕 ---------- */
    page: 1,
    rFonts: [],                       // 随机字幕用的字体池（和第 1 页互不影响）
    rColors: ["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"],
    rHue: 200,
    rLight: 60
  };

  /* 第 2 页「画面与文字」的默认值 —— 「重置」用它复位 */
  var CV_DEFAULTS = {
    "cv-w": 1080, "cv-h": 1080, "cv-fps": 60,
    "cv-size1": 100, "cv-size2-delta": 20, "cv-short-delta": 20,
    "cv-tracking": 20, "cv-leading": 65
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
  function pickColor()      { return hslToHex(state.hue, 100, state.light); }
  function pickGlowColor()  { return hslToHex(state.glowHue, 100, state.glowLight); }

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

  /* -------------------- 带进度条的「一键生成」 -------------------- */

  var runBusy = false;

  function showProgress(show) {
    var box = $("run-progress");
    if (box) box.classList.toggle("hidden", !show);
  }

  function setProgress(done, total, label) {
    var bar = $("rp-bar"), cnt = $("rp-count"), lb = $("rp-label");
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
    if (bar) bar.style.width = pct + "%";
    if (cnt) cnt.textContent = done + " / " + total;
    if (lb && label) lb.textContent = label + "…";
  }

  function evalOnce(script, cb) {
    cs.evalScript(script, function (res) {
      cb(String(res == null ? "" : res));
    });
  }

  /**
   * 分块跑「一键生成」。
   *
   * 为什么要分块：ExtendScript 是同步的，一次处理几百个图层会把 AE 卡住十几秒，
   * 面板只能干等，进度条也动不了。改成"每次只处理一条字幕的一道工序"，
   * 每次调用之间 AE 能刷新界面，进度是真实推进的。
   */
  function runWithProgress() {
    if (runBusy) return;
    runBusy = true;

    var opts = buildOpts();
    var script = "typeof PF_runStart === 'function' ? PF_runStart(" + JSON.stringify(opts) + ") : 'ERR|引擎未加载'";

    showProgress(true);
    setProgress(0, 0, "准备中");
    setStatus("一键生成效果 …运行中");

    function finish(text, isErr) {
      runBusy = false;
      showProgress(false);
      setStatus(text, !!isErr);
    }

    evalOnce(script, function (res) {
      if (res.indexOf("ERR") === 0) { finish(res.replace(/^ERR\|?/, "") || "执行失败", true); return; }

      var m = /^P\|(\d+)\|(\d+)\|(.*)$/.exec(res);
      if (!m) { finish(res.replace(/^OK\|?/, "") || "完成", false); return; }

      setProgress(parseInt(m[1], 10), parseInt(m[2], 10), m[3]);

      (function step() {
        evalOnce("typeof PF_runStep === 'function' ? PF_runStep() : 'ERR|引擎未加载'", function (r2) {
          if (r2.indexOf("ERR") === 0) { finish(r2.replace(/^ERR\|?/, "") || "执行失败", true); return; }

          var m2 = /^P\|(\d+)\|(\d+)\|(.*)$/.exec(r2);
          if (m2) {
            var done = parseInt(m2[1], 10), tot = parseInt(m2[2], 10);
            setProgress(done, tot, m2[3]);
            if (done < tot) {
              // setTimeout(0) 让出事件循环，面板才有机会把进度画出来
              setTimeout(step, 0);
            } else {
              evalOnce("typeof PF_runEnd === 'function' ? PF_runEnd() : 'OK|完成'", function (r3) {
                finish(String(r3).replace(/^OK\|?/, "") || "完成", false);
              });
            }
            return;
          }
          finish(r2.replace(/^OK\|?/, "") || "完成", false);
        });
      })();
    });
  }

  /* -------------------- 组装参数 -------------------- */
  function buildOpts() {
    var gcol = pickGlowColor();
    var gmode = radio("gcmode", "single");
    return {
      srtPath: state.srtPath,
      useSelection: checked("use-selection"),

      lineBreakBase: num("linebreak"),
      extendFrames: num("extend-frames"),
      forceUpper: checked("force-upper"),
      cleanPunct: checked("clean-punct"),
      precompose: checked("precompose"),
      precompName: val("precomp-name") || "字幕",

      growEnabled: checked("grow-en"),
      growAmount: num("grow-amt"),
      overlap: checked("overlap"),

      fontMode: radio("fmode", "single"),
      fontSingle: state.fontSingle,
      fonts: state.fonts.slice(),

      // 文字颜色
      colorMode: radio("cmode", "single"),
      singleColor: pickColor(),
      colors: state.colors.slice(),

      doEntry: checked("do-entry"),
      doExit: checked("do-exit"),
      doTracking: checked("do-tracking"),
      entryBasedOn: val("entry-based"),
      exitBasedOn: val("exit-based"),
      // 帧偏移：0 = 基准（入场 1.5s / 出场 35 帧），正数加长、负数缩短。
      // 引擎按合成帧率把帧数换算成秒。
      entryFrameOffset: num("entry-frames"),
      exitFrameOffset: num("exit-frames"),
      // 兼容字段：旧预设可能带秒数，引擎在没有帧偏移时才用它。
      // 面板上已经没有这两个输入框了，这里给基准值即可。
      entrySeconds: ENTRY_BASE_SEC,
      exitSeconds: 0,
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

      // 发光：参数 + 独立的发光色（单色 / 随机多色）
      glow: {
        enabled: checked("glow-en"),
        threshold: num("glow-th"),
        radius: num("glow-r"),
        exposure: num("glow-exp"),        // 曝光
        strength: num("glow-i"),          // 灯光强度
        colorMode: gmode,
        singleColor: gcol,
        colors: state.glowColors.slice(),
        color: gcol,                      // 兼容旧字段
        colorRandom: gmode === "random"   // 兼容旧字段
      },

      // 两层投影（固定参数，引擎里写死；这里显式声明，便于以后扩展）
      shadows: true,

      // 流光：文字颜色以光带形式循环扫过文字
      flow: {
        enabled: checked("flow-en"),
        mode: val("flow-mode") || "band",       // band / wash / fullwash / ribbon
        period: num("flow-period"),
        blankCount: num("flow-blank-count"),    // 全范围晕染留白 / 彩带 的留白处数
        color: pickColor()
      },

      step: 0.1
    };
  }

  /* ==================================================================
   *  调色区（文字颜色 / 发光颜色 共用一套实现）
   * ================================================================== */

  function makeColorCtl(cfg) {
    var st = {
      getHue: cfg.getHue, setHue: cfg.setHue,
      getLight: cfg.getLight, setLight: cfg.setLight,
      getColors: cfg.getColors, setColors: cfg.setColors,
      getPresets: cfg.getPresets,
      savePresets: cfg.savePresets
    };

    function hex() { return hslToHex(st.getHue(), 100, st.getLight()); }

    function paint() {
      if ($(cfg.hueHId)) $(cfg.hueHId).style.left = (st.getHue() / 360 * 100) + "%";
      if ($(cfg.lightHId)) $(cfg.lightHId).style.left = st.getLight() + "%";
      if ($(cfg.swatchId)) $(cfg.swatchId).style.background = hex();
      if ($(cfg.hexId)) $(cfg.hexId).textContent = hex();
      if ($(cfg.lightBarId)) {
        $(cfg.lightBarId).style.background =
          "linear-gradient(to right, #000 0%, " + hslToHex(st.getHue(), 100, 50) + " 50%, #fff 100%)";
      }
    }

    function bindBar(barId, apply) {
      var bar = $(barId);
      if (!bar) return;
      function fromEvent(e) {
        var r = bar.getBoundingClientRect();
        var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        apply(ratio);
        paint(); cfg.onChange(); saveCfg();
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

    function renderColors() {
      var box = $(cfg.listId);
      if (!box) return;
      var list = st.getColors();
      box.innerHTML = "";
      list.forEach(function (c, i) {
        var wrap = document.createElement("div");
        wrap.className = "color-item";
        var sw = document.createElement("div");
        sw.className = "swatch";
        sw.style.background = c;
        var del = document.createElement("button");
        del.className = "del";
        del.textContent = "×";
        del.addEventListener("click", function () {
          var arr = st.getColors();
          if (arr.length <= 1) { setStatus("至少保留一个颜色", true); return; }
          arr.splice(i, 1);
          st.setColors(arr);
          renderColors(); cfg.onChange(); saveCfg();
        });
        wrap.appendChild(sw);
        wrap.appendChild(del);
        box.appendChild(wrap);
      });
    }

    function makeDot(h) {
      var d = document.createElement("span");
      d.className = "dot";
      d.style.background = h;
      d.title = h;
      return d;
    }

    function renderPresets() {
      var box = $(cfg.presetListId);
      if (!box) return;
      box.innerHTML = "";
      var list = st.getPresets();
      list.forEach(function (p, i) {
        var single = p.mode ? (p.mode === "single") : !(p.colors && p.colors.length > 1);
        var cl = single ? [p.color || "#ffffff"] : (p.colors || []);

        var chip = document.createElement("span");
        chip.className = "chip click";

        var dots = document.createElement("span");
        dots.className = "dots";
        var show = single ? 1 : Math.min(5, cl.length);
        for (var k = 0; k < show; k++) dots.appendChild(makeDot(cl[k] || "#ffffff"));
        if (!single && cl.length > show) {
          var more = document.createElement("span");
          more.className = "dot more";
          more.textContent = "+" + (cl.length - show);
          more.title = "共 " + cl.length + " 个颜色";
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
          var arr = st.getPresets();
          arr.splice(i, 1);
          renderPresets(); st.savePresets();
        });
        chip.appendChild(nm); chip.appendChild(x);

        chip.addEventListener("click", function () {
          if (single) {
            setHex(p.color || "#ffffff");
            var r = document.querySelector('input[name="' + cfg.modeName + '"][value="single"]');
            if (r && !r.checked) { r.checked = true; cfg.syncBox(); }
            cfg.onChange(); saveCfg();
          } else if (p.colors && p.colors.length) {
            st.setColors(p.colors.slice());
            var r2 = document.querySelector('input[name="' + cfg.modeName + '"][value="random"]');
            if (r2 && !r2.checked) { r2.checked = true; }
            renderColors(); cfg.syncBox(); cfg.onChange(); saveCfg();
          }
          setStatus("已套用预设：" + p.name);
        });
        box.appendChild(chip);
      });
    }

    /** 把横杠状态调到某个颜色（用 HSL 反推） */
    function setHex(hexv) {
      var h = String(hexv).replace("#", "");
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
      st.setHue(Math.round(hue));
      st.setLight(Math.round((mx + mn) / 2 * 100));
      paint();
    }

    function seed() {
      st.setColors(["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"]);
      renderColors();
    }
    function isPristine() {
      var c = st.getColors();
      return c.length === 1 && /^#(fff|ffffff)$/i.test(c[0]);
    }

    /** 切换单色 / 随机时，随机池还是出厂白就自动铺一组色 */
    function onModeChange() {
      if (radio(cfg.modeName, "single") === "random" && isPristine()) {
        seed();
        cfg.onChange(); saveCfg();
        setStatus("随机颜色已铺好，点色块可以改");
      }
    }

    function addColor() {
      var arr = st.getColors();
      if (arr.length >= 12) { setStatus("最多 12 个颜色", true); return; }
      var c = hex();
      if (isPristine()) {
        st.setColors([c]);
        setStatus("已用当前颜色替换掉默认白色");
      } else {
        arr.push(c);
        st.setColors(arr);
      }
      renderColors(); cfg.onChange(); saveCfg();
    }
    function randomize() {
      if (isPristine()) { seed(); setStatus("已铺一组随机色板"); }
      else {
        st.setColors(st.getColors().map(function () { return randomHex(); }));
        renderColors();
      }
      cfg.onChange(); saveCfg();
    }
    function savePreset() {
      var single = radio(cfg.modeName, "single") === "single";
      var c = hex();
      var nm = single ? ("颜色 " + c) : ("配色 ×" + st.getColors().length);
      var arr = st.getPresets();
      arr.push({
        name: nm,
        mode: single ? "single" : "random",
        color: c,
        colors: single ? [] : st.getColors().slice()
      });
      renderPresets(); st.savePresets();
      setStatus("已保存预设：" + nm);
    }

    return {
      hex: hex, paint: paint, renderColors: renderColors, renderPresets: renderPresets,
      setHex: setHex, seed: seed, isPristine: isPristine, onModeChange: onModeChange,
      addColor: addColor, randomize: randomize, savePreset: savePreset,
      bindBars: function () {
        bindBar(cfg.hueBarId,   function (r) { st.setHue(Math.round(r * 360)); });
        bindBar(cfg.lightBarId, function (r) { st.setLight(Math.round(r * 100)); });
      }
    };
  }

  /* 文字颜色 */
  var textCtl = makeColorCtl({
    modeName: "cmode",
    hueBarId: "hue-bar", hueHId: "hue-h",
    lightBarId: "light-bar", lightHId: "light-h",
    swatchId: "color-swatch", hexId: "color-hex",
    listId: "color-list", presetListId: "preset-list",
    getHue: function () { return state.hue; },
    setHue: function (v) { state.hue = v; },
    getLight: function () { return state.light; },
    setLight: function (v) { state.light = v; },
    getColors: function () { return state.colors; },
    setColors: function (v) { state.colors = v; },
    getPresets: function () { return state.presets; },
    savePresets: function () { saveLS("rinsubtitle_presets", state.presets); },
    syncBox: syncColorUI,
    // 文字颜色也会影响发光（白色才用发光色设置），所以两边一起刷
    onChange: function () { refreshPreview(); }
  });

  /* 发光颜色 */
  var glowCtl = makeColorCtl({
    modeName: "gcmode",
    hueBarId: "ghue-bar", hueHId: "ghue-h",
    lightBarId: "glight-bar", lightHId: "glight-h",
    swatchId: "glow-swatch", hexId: "glow-hex",
    listId: "glow-list", presetListId: "glow-preset-list",
    getHue: function () { return state.glowHue; },
    setHue: function (v) { state.glowHue = v; },
    getLight: function () { return state.glowLight; },
    setLight: function (v) { state.glowLight = v; },
    getColors: function () { return state.glowColors; },
    setColors: function (v) { state.glowColors = v; },
    getPresets: function () { return state.glowPresets; },
    savePresets: function () { saveLS("rinsubtitle_glowpresets", state.glowPresets); },
    syncBox: syncColorUI,
    // 发光色只在文字为白时生效，所以顺带把状态提示刷一下
    onChange: function () { refreshGlowPreview(); }
  });

  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function loadLS(k, dflt) {
    try {
      var d = JSON.parse(localStorage.getItem(k) || "null");
      return d === null ? dflt : d;
    } catch (e) { return dflt; }
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
  function psToFamily(ps) {
    var s = String(ps || "");
    s = s.replace(/^[A-Za-z]{6}\+/, "");
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
        renderFontChips(); saveCfg();
      });
      chip.appendChild(nm); chip.appendChild(x);
      box.appendChild(chip);
    });
    $("font-count").textContent = state.fonts.length;
  }

  function syncFontUI() {
    $("font-single-name").textContent = state.fontSingle ? fontLabel(state.fontSingle) : "未设置";
  }

  /* ==================================================================
   *  分页：第 1 页 基础字幕面板 / 第 2 页 随机字幕面板
   * ================================================================== */

  var PAGE_TITLES = { 1: "基础字幕面板", 2: "随机字幕面板" };

  function showPage(n) {
    n = (n === 2) ? 2 : 1;
    state.page = n;

    var p1 = $("page-1"), p2 = $("page-2");
    if (p1) p1.classList.toggle("hidden", n !== 1);
    if (p2) p2.classList.toggle("hidden", n !== 2);

    // 两个页签：当前页高亮
    var t1 = $("page-1-tab"), t2 = $("page-2-tab");
    if (t1) t1.classList.toggle("active", n === 1);
    if (t2) t2.classList.toggle("active", n === 2);

    // 第 1 页没有"上一页"，第 2 页没有"下一页"
    var prev = $("page-prev"), next = $("page-next");
    if (prev) prev.classList.toggle("hidden", n === 1);
    if (next) next.classList.toggle("hidden", n === 2);

    // 「执行」卡片两页都保留（诊断 / 状态栏都要用），
    // 但生成按钮组只属于第 1 页 —— 第 2 页有自己的「一键生成随机效果」。
    var p1only = $("page1-only");
    if (p1only) p1only.classList.toggle("hidden", n !== 1);

    saveCfg();
  }

  /* -------------------- 第 2 页：随机字幕 -------------------- */

  /** 随机字体列表 */
  function renderRandomFontChips() {
    var box = $("r-font-list");
    if (!box) return;
    box.innerHTML = "";
    state.rFonts.forEach(function (ps, i) {
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
        state.rFonts.splice(i, 1);
        renderRandomFontChips(); saveCfg();
      });
      chip.appendChild(nm); chip.appendChild(x);
      box.appendChild(chip);
    });
    var c = $("r-font-count");
    if (c) c.textContent = state.rFonts.length;
  }

  /** 随机颜色列表 */
  function renderRandomColors() {
    var box = $("r-color-list");
    if (!box) return;
    box.innerHTML = "";
    state.rColors.forEach(function (c, i) {
      var wrap = document.createElement("div");
      wrap.className = "color-item";
      var sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.background = c;
      var del = document.createElement("button");
      del.className = "del";
      del.textContent = "×";
      del.addEventListener("click", function () {
        if (state.rColors.length <= 1) { setStatus("至少保留一个颜色", true); return; }
        state.rColors.splice(i, 1);
        renderRandomColors(); saveCfg();
      });
      wrap.appendChild(sw); wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }

  function syncRandomGlowHint() {
    var el = $("r-glow-hint");
    if (!el) return;
    if (!checked("r-glow-en")) {
      el.className = "hint glow-hint";
      el.innerHTML = "发光已关闭。";
      return;
    }
    el.className = "hint glow-hint";
    el.innerHTML = "发光使用基础页设置的半径 / 曝光 / 灯光强度。文字发光需要 Deep Glow 插件支持。";
  }

  /* -------------------- 画面与文字：实时排版预览 -------------------- */

  /**
   * 把参数换算成"预览框里看到的字号"。
   *
   * 预览框固定 150×150，代表用户设定的画布（比如 1080×1080）。
   * 所以缩放比例 = 150 / max(宽, 高) —— 按较长边算，
   * 这样竖屏、横屏、方形都能完整落在框里，不会撑破。
   *
   * 字号、字距、行距都是"画面里的像素"，必须乘同一个比例才直观：
   * 用户把字号从 100 调到 140，预览里的字就真的变大 40%。
   */
  function refreshCanvasPreview() {
    var W = num("cv-w") || 1080;
    var H = num("cv-h") || 1080;
    var fps = num("cv-fps") || 60;
    var size1 = num("cv-size1") || 100;
    var d2 = num("cv-size2-delta") || 0;
    var dShort = num("cv-short-delta") || 0;
    var tracking = num("cv-tracking") || 0;
    var leading = num("cv-leading") || 0;

    var frame = $("cv-frame");
    if (!frame) return;

    // 画布尺寸变了，预览框跟着变成同样的宽高比
    var BOX = 150;
    var scale = BOX / Math.max(1, W, H);
    var fw = Math.max(20, Math.round(W * scale));
    var fh = Math.max(20, Math.round(H * scale));
    frame.style.width = fw + "px";
    frame.style.height = fh + "px";

    // 短句用 size1 + dShort；两行时第二行用 size1 + d2（按需求说明）
    var shortSize = Math.max(1, size1 + dShort);
    var secondSize = Math.max(1, size1 + d2);

    function styleLine(el, fontSizePx) {
      if (!el) return;
      var fs = Math.max(4, fontSizePx * scale);
      el.style.fontSize = fs.toFixed(2) + "px";
      // 字距：也按同一个比例缩，否则预览里的疏密和实际对不上
      el.style.letterSpacing = (tracking * scale).toFixed(2) + "px";
      el.style.marginTop = (leading * scale * 0.0).toFixed(2) + "px";
    }

    var l1 = $("cv-line1"), l2 = $("cv-line2");
    styleLine(l1, size1);
    styleLine(l2, secondSize);

    // 行距作用在两行之间
    if (l2) l2.style.marginTop = (leading * scale).toFixed(2) + "px";

    // 第二行只有在"有第二行"的时候才显示。
    // 依据：第二行字号增量 > 0 或者用户改过，预览里始终显示两行更直观
    // —— 这里始终显示，让用户能看到两行的相对大小。
    if (l2) l2.style.display = "";

    // 覆盖在画面中心 —— 字幕本来就是居中排版
    var info = $("cv-preview-info");
    if (info) info.textContent = W + " × " + H + " · " + fps + "fps" +
      (d2 ? "" : " · 第二行同字号");
  }

  /* -------------------- 流光：三种模式各自一个开关 -------------------- */

  var FLOW_IDS = {
    fullwash: "r-flow-fullwash",
    ribbon: "r-flow-ribbon",
    random: "r-flow-random"
  };

  /** 返回当前勾选的流光效果（不含"随机"） */
  function pickedFlowModes() {
    var out = [];
    if (checked("r-flow-fullwash")) out.push("fullwash");
    if (checked("r-flow-ribbon")) out.push("ribbon");
    return out;
  }

  function flowRandomOn() { return checked("r-flow-random"); }

  /** 有任何一个流光开关打开，就算流光启用 */
  function flowEnabledAny() {
    return pickedFlowModes().length > 0 || flowRandomOn();
  }

  /**
   * 流光开关的状态校验与提示。
   *
   * 三种开关的关系：
   *   · 勾了「全范围晕染留白」→ 只用这一种
   *   · 勾了「彩带」          → 只用这一种
   *   · 两个都勾              → 两种都用（随机模式下二选一）
   *   · 勾了「随机」          → 每条字幕从**已勾选的具体效果**里随机取一个
   *
   * 只勾「随机」但一个具体效果都没勾 → 没有可随机的对象，这时给提示。
   */
  function syncFlowHint() {
    var el = $("r-flow-hint");
    if (!el) return;
    var modes = pickedFlowModes();
    var rnd = flowRandomOn();

    if (!modes.length && !rnd) {
      el.className = "hint";
      el.textContent = "流光已关闭。";
      return;
    }
    if (rnd && !modes.length) {
      el.className = "hint flow-warn";
      el.textContent = "「随机」需要至少先勾选一种效果（全范围晕染留白 或 彩带）。";
      return;
    }
    if (rnd && modes.length) {
      el.className = "hint";
      el.textContent = "每条字幕从勾选的 " + modes.length + " 种效果里随机取一个。";
      return;
    }
    el.className = "hint";
    el.textContent = modes.length > 1
      ? "已启用 " + modes.length + " 种效果，会同时叠加。"
      : "已启用：" + (modes[0] === "fullwash" ? "全范围晕染留白" : "彩带");
  }

  /* -------------------- 随机动画：至少选一个 -------------------- */

  var ANIM_PICKS = ["ra-fade"];

  /** 返回当前勾选的动画 id 列表 */
  function pickedAnims() {
    var out = [];
    ANIM_PICKS.forEach(function (id) {
      var el = $(id);
      if (el && el.checked) out.push(id);
    });
    return out;
  }

  /**
   * 校验"最少选一个动画"。
   *
   * 用户取消最后一个勾选时 **不允许** —— 直接把它勾回去并给提示。
   * 这样永远不会出现"随机动画一个都没选"的无效状态，
   * 也就不会在生成时静默跳过动画、让用户以为功能坏了。
   */
  function syncAnimPicks(changedId) {
    var picks = pickedAnims();
    var hint = $("ra-hint");

    if (picks.length === 0) {
      if (changedId) { var el = $(changedId); if (el) el.checked = true; }
      if (hint) { hint.textContent = "至少需要选择一个动画效果。"; }
      return false;
    }
    if (hint) hint.textContent = picks.length > 1
      ? "已选 " + picks.length + " 个，每条字幕随机取一个。"
      : "";
    return true;
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
      var pool = (pickMode === "r-multi") ? state.rFonts : state.fonts;
      var isSel = pickMode === "single" ? state.fontSingle === it.ps : pool.indexOf(it.ps) >= 0;
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
            syncFontUI(); saveCfg();
            setStatus("统一字体：" + item.family);
          } else if (pickMode === "r-multi") {
            var kr = state.rFonts.indexOf(item.ps);
            if (kr >= 0) state.rFonts.splice(kr, 1); else state.rFonts.push(item.ps);
            renderFontOptions(val("font-search"));
            renderRandomFontChips(); saveCfg();
          } else {
            var k = state.fonts.indexOf(item.ps);
            if (k >= 0) state.fonts.splice(k, 1); else state.fonts.push(item.ps);
            renderFontOptions(val("font-search"));
            renderFontChips(); saveCfg();
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

  /* ==================================================================
   *  预览
   *  ① 动画预览（④）：出入场动画 + 文字颜色 + 流光
   *  ② 发光预览（③）：发光 + 两层投影
   *  两个预览的字体都固定：英文 Arial Black，中文 宋体
   * ================================================================== */

  var PV_EN_FONT = '"Arial Black", Arial, "Microsoft YaHei", sans-serif';
  var PV_CN_FONT = 'SimSun, "宋体", "Songti SC", serif';

  var pvIndex = 0;
  var pvTimer = null;

  /** 预览里的文字颜色（随机模式下按序号轮换，模拟"每条不同色"） */
  var PV_VIVID = ["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"];
  function pvPickTextColor() {
    if (radio("cmode", "single") === "single") return pickColor();
    if (textCtl.isPristine()) return PV_VIVID[pvIndex % PV_VIVID.length];
    if (!state.colors.length) return pickColor();
    return state.colors[pvIndex % state.colors.length];
  }
  /** 预览用的发光色（随机模式下按序号轮换） */
  function pvPickGlowColor() {
    if (radio("gcmode", "single") === "single") return pickGlowColor();
    if (glowCtl.isPristine()) return PV_VIVID[pvIndex % PV_VIVID.length];
    if (!state.glowColors.length) return pickGlowColor();
    return state.glowColors[pvIndex % state.glowColors.length];
  }

  /** 6 位小写 hex，方便比较颜色 */
  function normHex(h) {
    var s = String(h || "").replace("#", "").toLowerCase();
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    return s;
  }

  /**
   * 发光实际生效的颜色 —— 和引擎里的规则保持一致：
   *   · 文字颜色是白色（默认）→ 用「发光颜色」那套设置
   *   · 文字颜色是其它颜色  → 跟随文字颜色，忽略发光颜色的设置
   */
  function pvGlowEffectiveColor() {
    var tc = pvPickTextColor();
    if (normHex(tc) !== normHex("#ffffff")) return tc;
    return pvPickGlowColor();
  }

  /** 当前文字颜色是否为白（用来给发光调色区加提示） */
  function textIsWhite() {
    return normHex(pvPickTextColor()) === normHex("#ffffff");
  }

  /**
   * 发光调色区下面那行状态提示。
   *
   * 规则和引擎里的 pf_glowPlan 保持一致：
   *   · 文字白色   → 发光用「发光颜色」这里的设置（开 Deep Glow 的 Tint）
   *   · 文字非白色 → 发光**跟随文字颜色**，上面的设置暂时不生效
   *
   * 不加这行提示时，用户改了发光色却没反应，会以为功能坏了。
   */
  function syncGlowColorHint() {
    var el = $("glow-color-hint");
    if (!el) return;
    var follow = !textIsWhite();
    el.className = "hint glow-hint" + (follow ? " follow" : "");
    el.innerHTML = follow
      ? "文字颜色不是白色 → <b>发光跟随文字颜色</b>，上面的发光颜色设置暂不生效。把文字改回白色即可单独调发光色。"
      : "文字是白色 → 发光使用上面设置的颜色。文字发光需要 Deep Glow 插件支持。";
  }

  /**
   * 两层投影的 CSS 还原。
   * AE 的 Drop Shadow：方向 135° = 右下方；距离 = 偏移量；柔和 = 模糊半径。
   */
  function shadowCss(offset, blur, alpha) {
    var rad = 135 * Math.PI / 180;
    var dx = (-Math.cos(rad) * offset).toFixed(2);
    var dy = (Math.sin(rad) * offset).toFixed(2);
    return dx + "px " + dy + "px " + blur + "px " + hexToRgba("#000000", alpha);
  }

  /** 发光预览 + 动画预览都要显示的两层投影（和引擎里的 PF_SHADOW_* 一致） */
  function previewShadows() {
    return [
      shadowCss(5, Math.max(1, 2), 1),     // 投影1：发光前  100% / 135° / 距离5 / 柔和2
      shadowCss(5, Math.max(2, 20), 0.9)   // 投影2：发光后  90%  / 135° / 距离5 / 柔和20
    ];
  }

  /** 发光本身的 CSS 近似（多层模糊叠加，模拟辉光） */
  function previewGlow() {
    if (!checked("glow-en")) return [];
    var r = num("glow-r");
    var exp = num("glow-exp");
    var inten = num("glow-i");
    // 和引擎同一条规则：文字是白色才用发光色设置，否则跟随文字颜色
    var col = pvGlowEffectiveColor();
    var blur = Math.max(1, r / 12);
    var alpha = Math.max(0.10, Math.min(0.95, (exp + inten) / 1.6));
    var out = [];
    for (var k = 1; k <= 3; k++) {
      out.push("0 0 " + (blur * k / 1.7).toFixed(1) + "px " + hexToRgba(col, alpha));
    }
    return out;
  }

  /**
   * 流光预览（四种模式通用）。
   *
   * 实际效果是 AE 的 **Fractal Noise + Tint**（参考 Sapphire 的 S_TextureFlux）：
   * 噪波**按屏幕位置**生成，所以多行字幕是**同时**被覆盖的。
   *
   * 这里用 CSS 斜向渐变条纹 + background-position 平移动画来逼近：
   *   · 条纹 = 「底色 / 流光色」交替，条纹对数 = 留白处数
   *   · 背景匀速平移 → 条纹流动
   *   · 用 background-clip:text 裁进字形，天然整块统一，**不分行**
   *
   * 四种模式的差别：
   *   band     光带    → 白底 + 彩色窄带，对比强、条纹细
   *   wash     晕染留白 → 文字色底 + 一大块柔和留白
   *   fullwash 全范围   → 文字色底 + 多处留白
   *   ribbon   彩带    → 同上，条纹更斜更弯
   */
  function applyFluxPreview(el, txt, period, count, mode, amp, waveOn, wdur, wstep) {
    var flowCol = pvPickTextColor();

    // 文字本身是白色时，"白底 + 白带"的流光在预览里就是一片白，什么都看不见。
    // AE 里之所以看得见，是因为白字压在**深色画面上**，对比来自画面本身；
    // 面板预览没有那个背景，所以这里必须自己造出对比：
    // 白色换成浅灰，让流光带真正显形。
    function visibleOnDark(hex) {
      return (normHex(hex) === "ffffff") ? "#c9d4e2" : hex;
    }

    el.setAttribute("data-text", txt);

    var n = Math.max(2, Math.min(6, count));
    var periodMs = Math.max(500, period * 1000);

    // 各模式的视觉参数
    // band 是"白底 + 文字色带"；其余是"文字色底 + 白色留白"。
    // 两边都要先过 visibleOnDark：文字是纯白时把它换成浅灰，
    // 否则白底白带 / 白底白留白完全看不见。
    var cBase = visibleOnDark(flowCol);
    var cfg = {
      band:     { angle: 135, ratio: 0.30, base: "#ffffff",   stripe: cBase },
      wash:     { angle: 135, ratio: 0.55, base: cBase,      stripe: "#ffffff" },
      fullwash: { angle: 135, ratio: 0.50, base: cBase,      stripe: "#ffffff" },
      ribbon:   { angle: 118, ratio: 0.52, base: cBase,      stripe: "#ffffff" }
    }[mode] || { angle: 135, ratio: 0.5, base: cBase, stripe: "#ffffff" };

    // 晕染留白只有一处大留白；其余按"留白处数"
    var pairs = (mode === "wash") ? 1 : n;

    // 生成条纹：base（底）与 stripe（流动带）交替
    var stops = [];
    var seg = 100 / (pairs * 2);
    for (var i = 0; i < pairs * 2; i++) {
      var c = (i % 2 === 0) ? cfg.base : cfg.stripe;
      stops.push(c + " " + (i * seg).toFixed(1) + "%");
      stops.push(c + " " + ((i + 1) * seg).toFixed(1) + "%");
    }
    var gradient = "linear-gradient(" + cfg.angle + "deg, " + stops.join(", ") + ")";

    // ---- 逐字重建 ----
    // 关键：渐变必须挂在**每个字自己**身上，不能挂在父元素上用 background-clip:text。
    // 原因：入场/出场是逐字 opacity 动画，每个 span 会各自成为一个独立的层，
    // 父元素的 background-clip:text 就裁不到这些子层里的字形了 ——
    // 表现就是"一开流光，预览框整行消失"。
    // 注意：这里**不能**调 clearFlowAnims()。
    // 本函数会被 4 个预览元素依次调用，在第二个元素上清理
    // 会把第一个元素刚建好的动画一起取消。统一由调用方在循环外清一次。
    el.innerHTML = "";
    el.style.backgroundImage = "";
    el.style.backgroundClip = "";
    el.style.webkitBackgroundClip = "";
    el.style.webkitTextFillColor = "";
    el.style.animation = "";          // 父层不再承载渐变，也就不需要位移动画

    var spans = [];
    for (var k = 0; k < txt.length; k++) {
      var s = document.createElement("span");
      var ch = txt.charAt(k);
      if (ch === " ") { s.style.whiteSpace = "pre"; }
      else { s.style.display = "inline-block"; }
      s.textContent = ch;
      el.appendChild(s);
      spans.push(s);
    }
    if (!spans.length) return;

    // 量一下整行宽度：每个字都铺**同样大小的一整块**渐变，
    // 再按各自在行内的偏移取景，拼起来才是跨字连续的一条带。
    var baseRect = el.getBoundingClientRect();
    var firstRect = spans[0].getBoundingClientRect();
    var lastRect = spans[spans.length - 1].getBoundingClientRect();
    var totalW = Math.max(8, Math.round(lastRect.right - firstRect.left));
    var originX = firstRect.left - baseRect.left;

    for (var j = 0; j < spans.length; j++) {
      var sp = spans[j];
      var off = Math.round(sp.getBoundingClientRect().left - baseRect.left - originX);

      sp.style.backgroundImage = gradient;
      sp.style.backgroundSize = totalW + "px 100%";
      sp.style.backgroundRepeat = "repeat";
      // 每个字从"自己在整行里的位置"开始取景 → 拼起来是一条连续的带
      sp.style.backgroundPosition = (-off) + "px 0";
      sp.style.webkitBackgroundClip = "text";
      sp.style.backgroundClip = "text";
      sp.style.webkitTextFillColor = "transparent";
      sp.style.color = "transparent";

      if (waveOn) {
        sp.style.setProperty("--pv-amp", amp.toFixed(1) + "px");
        sp.style.animation = "pvWave " + wdur.toFixed(2) + "s ease-in-out infinite";
        sp.style.animationDelay = (j * wstep).toFixed(2) + "s";
      }

      // 流动：整块渐变匀速平移一个自身宽度，正好无缝循环。
      // 用 WAAPI 而不是 CSS 动画，因为每个字的起点偏移不同，
      // CSS 关键帧写不出"每个元素不同起点"的百分比。
      if (sp.animate) {
        try {
          pvFlowAnims.push(sp.animate(
            [
              { backgroundPosition: (-off) + "px 0" },
              { backgroundPosition: (-off + totalW) + "px 0" }
            ],
            { duration: periodMs, iterations: Infinity, easing: "linear" }
          ));
        } catch (e) {}
      }
    }
  }

  /** 波浪 / 流光：勾选时逐字起伏 / 逐字扫光 */
  function buildPreviewChars(el) {
    if (!el) return;
    var txt = el.getAttribute("data-text");
    if (txt === null) {
      txt = el.textContent;
      el.setAttribute("data-text", txt);
    }
    var waveOn = checked("wave-en"), flowOn = checked("flow-en");
    if (!waveOn && !flowOn) {
      // 不做波浪 / 流光时也要保持**逐字结构** ——
      // 入场/出场的逐字擦除动画需要按字符分开操作。
      // 这里若直接写 textContent 会把 span 全清掉，逐字动画就无处可挂
      // （表现为"整行一起出现"，和 AE 的逐字推进对不上）。
      ensureCharSpans(el);
      return;
    }

    var amp = Math.max(1, num("wave-h") / 4);
    var wdur = 1 / Math.max(0.15, num("wave-s"));
    var wstep = Math.max(0.02, Math.min(0.3, num("wave-w") / 4000));

    var fmode = val("flow-mode") || "band";
    var fdur = Math.max(0.5, num("flow-period") || 5);
    var fstep = fdur / Math.max(2, txt.length);

    // 全范围晕染留白 / 彩带：整行铺 blankN 个完整波长 → 同时出现 blankN 处留白。
    // 做法：把整行按字符数切成 blankN 段，段内相位照常推进，段与段之间重置，
    // 于是每一段都跑同样的波形，屏幕上看就是 N 处留白一起扫。
    var blankN = Math.max(2, Math.min(6, Math.round(num("flow-blank-count") || 3)));
    var multi = (fmode === "fullwash" || fmode === "ribbon");
    var groupSize = Math.max(1, Math.ceil(txt.length / blankN));
    var fbase = fdur / groupSize;        // 段内每个字错开的秒数

    // 流光：四种模式**都走条纹**（位置相关），这样多行是同时被覆盖的。
    // 逐字那种做法是按字符下标推进，多行会一行一行扫，和实际不符。
    if (flowOn) {
      applyFluxPreview(el, txt, fdur, blankN, fmode, amp, waveOn, wdur, wstep);
      return;
    }

    el.innerHTML = "";
    for (var i = 0; i < txt.length; i++) {
      var s = document.createElement("span");
      s.textContent = txt.charAt(i);
      s.style.display = "inline-block";
      s.style.setProperty("--pv-amp", amp.toFixed(1) + "px");

      var anim = [], delay = [];
      if (waveOn) {
        anim.push("pvWave " + wdur.toFixed(2) + "s ease-in-out infinite");
        delay.push((i * wstep).toFixed(2) + "s");
      }
      if (flowOn) {
        // multi：同一段内的字按位置错开，段与段之间归零 → 整行 N 处留白
        var thisDelay = multi ? ((i % groupSize) * fbase) : (i * fstep);
        anim.push("pvFlow " + fdur.toFixed(2) + "s ease-in-out infinite");
        delay.push(thisDelay.toFixed(3) + "s");
      }
      s.style.animation = anim.join(", ");
      s.style.animationDelay = delay.join(", ");
      el.appendChild(s);
    }
  }

  /* ---------- ① 动画预览（④） ---------- */

  var PV_ANIM_IDS = ["pv-en-1", "pv-en-2", "pv-cn-1", "pv-cn-2"];

  function applyAnimPreviewStyle() {
    var flowOn = checked("flow-en");
    var fmode = val("flow-mode") || "band";
    var col = pvPickTextColor();
    var base = col;
    // 光带：底色转白；彩带：Fractal Noise 的 Color1 = 白，文字也当白底。
    // 但文字本身是白色时不能真给纯白 —— 白底白字在预览里等于看不见。
    // 换成浅灰，既保留"浅色底"的观感，又能看出流动带。
    if (flowOn && (fmode === "band" || fmode === "ribbon")) {
      base = (normHex(base) === "ffffff") ? "#c9d4e2" : "#ffffff";
    }
    // wash / fullwash：底色始终是文字色，白色留白由逐字层负责

    // 留白（wash 系列）的"刷白"色；光带是彩色扫过，用文字色
    var flowCol = (flowOn && (fmode === "band" || fmode === "ribbon")) ? col : "#ffffff";

    var shadow = previewShadows().join(", ");

    // 清流光动画必须在**循环外**做一次。
    // 放进循环里会出事：处理第 2 个元素时，会把第 1 个元素刚建好的
    // 背景位移动画一起取消掉 —— 表现就是"只有最后一个预览框在流动"，
    // 甚至全都不动。
    clearFlowAnims();

    for (var i = 0; i < PV_ANIM_IDS.length; i++) {
      var el = $(PV_ANIM_IDS[i]);
      if (!el) continue;
      var isCn = PV_ANIM_IDS[i].indexOf("-cn-") >= 0;
      el.style.fontFamily = isCn ? PV_CN_FONT : PV_EN_FONT;

      // 每次重建前先清掉彩带留下的样式，否则切回别的模式会残留透明字。
      // 流光把渐变和"透明填充"挂在了**每个字**身上，这里必须逐字清掉，
      // 不然关掉流光后文字仍然是透明的（看起来像"没了"）。
      el.style.backgroundImage = "";
      el.style.backgroundClip = "";
      el.style.webkitBackgroundClip = "";
      el.style.webkitTextFillColor = "";
      el.style.animation = "";
      var oldSpans = el.querySelectorAll("span");
      for (var q = 0; q < oldSpans.length; q++) {
        var os = oldSpans[q];
        os.style.backgroundImage = "";
        os.style.backgroundClip = "";
        os.style.webkitBackgroundClip = "";
        os.style.webkitTextFillColor = "";
        os.style.color = "";
        os.style.animation = "";
      }

      el.style.color = base;
      el.style.setProperty("--pv-base", base);
      el.style.setProperty("--pv-flow", flowCol);
      el.style.textShadow = shadow;
      buildPreviewChars(el);
    }
  }

  /* ---------- ② 发光预览（③） ---------- */

  var PV_GLOW_IDS = ["gv-en", "gv-cn"];

  function applyGlowPreviewStyle() {
    var shadow = previewShadows().concat(previewGlow()).join(", ");
    // 发光预览里的字就用这条字幕真正的文字色 —— 文字不是白的时候，
    // 一眼就能看出"发光跟着文字走了"
    var base = pvPickTextColor();
    for (var i = 0; i < PV_GLOW_IDS.length; i++) {
      var el = $(PV_GLOW_IDS[i]);
      if (!el) continue;
      var isCn = PV_GLOW_IDS[i] === "gv-cn";
      el.style.fontFamily = isCn ? PV_CN_FONT : PV_EN_FONT;
      el.style.color = base;
      el.style.textShadow = shadow;
    }
  }

  /* ---------- 预览用的动画关键帧：和引擎里的预设一一对应 ---------- */

  var PV_FULL = "inset(0 0% 0 0)";

  function pvAnimId() {
    var b = val("entry-based");
    return b === "sentence" ? "fade" : (b === "word" ? "wordfade" : "wipe");
  }

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
   * 时间轴**相对这一句自己的开始**（t=0），相位错开交给动画的 delay 参数，
   * 这样两句用同一套帧、只靠负延迟错相位，循环点才能和中间点同构。
   */
  function buildLineFrames(holdSec, totalSec) {
    var entry = previewEntrySeconds();
    var exit = previewExitSeconds();
    var doEntry = checked("do-entry"), doExit = checked("do-exit");
    var g = num("grow-amt") / 100;
    var id = pvAnimId();

    var pair = animInFrames(id, 1);
    var out = [];

    var t0 = 0;
    var tIn = doEntry ? entry : 0;
    var tOut = tIn + holdSec;
    var tEnd = tOut + (doExit ? exit : 0);
    var o0 = 0, oIn = tIn / totalSec, oOut = tOut / totalSec, oEnd = tEnd / totalSec;

    function withScale(kf, sc) {
      var t = kf.transform || "scale(1)";
      return (t === "scale(1)") ? ("scale(" + sc + ")") : (t + " scale(" + sc + ")");
    }

    // 和引擎保持一致：放大从**入场开始**一路持续到**出场结束**，
    // 覆盖字幕的整段显示时间。幅度同样乘 1.6。
    // 引擎用的是线性插值（pf_linear），预览也用线性，两边节奏一致。
    var growFrom = 0;                          // 从这一句开始就放大
    var growSpan = Math.max(0.0001, oEnd);
    function scaleAt(t) {
      var k = Math.max(0, Math.min(1, (t - growFrom) / growSpan));
      return 1 + g * 1.6 * k;
    }
    var holdScale = scaleAt(oOut).toFixed(3);
    var endScale  = scaleAt(oEnd).toFixed(3);

    // 字距也随放大一起拉开，节奏和 scaleAt 完全同步。
    // 引擎那边是给 Tracking 打关键帧（0 → growPct*0.6），
    // 预览用 letter-spacing 近似：起始 0.02em，结束时按同样比例增加。
    function trackAt(t) {
      var k = Math.max(0, Math.min(1, (t - growFrom) / growSpan));
      return 0.02 + (num("grow-amt") || 0) * 0.06 * k;
    }
    var holdTrack = trackAt(oOut).toFixed(3) + "em";
    var endTrack  = trackAt(oEnd).toFixed(3) + "em";

    // 注意：不透明度交给每个字自己控制（refreshCharWipe），
    // 父层这些关键帧里 opacity 一律保持 1，否则会二次相乘，导致字更淡。
    var hidden = cloneKF(pair[0], Math.max(oEnd, oOut + 0.0001));
    hidden.opacity = 1;
    if (id === "wipe") hidden.clipPath = "inset(0 0% 0 100%)";
    hidden.transform = withScale(pair[0], endScale);
    hidden.letterSpacing = endTrack;

    if (o0 > 0.0005) {
      var pre = cloneKF(hidden, 0);
      out.push(pre);
    }

    // 入场关键帧也要带上**该时刻的缩放值**。
    // 之前直接用 inF[0]/inF[1]，缩放会从 0 处直接跳到后面某个值 ——
    // 入场那段是"突然变大"，而不是"从小到大持续放大"。
    if (doEntry) {
      var inF = animInFrames(id, Math.max(0.0001, oIn - o0));
      var k0 = cloneKF(inF[0], o0), k1 = cloneKF(inF[1], oIn);
      k0.opacity = 1; k1.opacity = 1;
      k0.transform = withScale(inF[0], scaleAt(o0).toFixed(3));
      k1.transform = withScale(inF[1], scaleAt(oIn).toFixed(3));
      k0.letterSpacing = trackAt(o0).toFixed(3) + "em";
      k1.letterSpacing = trackAt(oIn).toFixed(3) + "em";
      out.push(k0, k1);
    } else {
      var e0 = cloneKF(pair[1], o0);
      e0.transform = withScale(pair[1], scaleAt(o0).toFixed(3));
      e0.letterSpacing = trackAt(o0).toFixed(3) + "em";
      out.push(e0);
    }

    if (doExit) {
      var startKF = cloneKF(pair[1], oOut);
      startKF.transform = withScale(pair[1], holdScale);
      startKF.letterSpacing = holdTrack;
      out.push(startKF, hidden);
      if (oEnd < 0.9995) out.push(cloneKF(hidden, 1));
    } else {
      var hk = cloneKF(pair[1], oOut);
      hk.transform = withScale(pair[1], holdScale);
      hk.letterSpacing = holdTrack;
      out.push(hk, cloneKF(pair[1], 1));
    }

    // 逐字模式（普通逐字擦除 / 随机溶解）：逐个字的消失交给 refreshCharWipe，
    // 父层负责 clip-path / 缩放这类整层变化。
    //
    // **但整层渐隐必须保留** —— 引擎里出场是两条一起走：
    //   逐字层 Percent End 推进 + 图层 Opacity 100→0
    // 以前预览把父层 opacity 钉死在 1，所以预览里根本看不到"渐渐变淡"，
    // 只有字一个个消失，和 AE 的实际观感对不上。
    // 现在父层在出场窗口 [oOut, oEnd] 里同样线性淡到 0，两边一致。
    //
    // 另外：clip-path 必须全程保持"全开" —— 逐字擦除已经在字级别表现"露出"了，
    // 父层再裁一刀就变成"整行被裁"，这正是之前预览和 AE 对不上的主要原因。
    for (var q = 0; q < out.length; q++) {
      out[q].opacity = 1;
      out[q].clipPath = PV_FULL;
    }
    if (doExit) {
      // hidden 就在 oEnd 处，把它改成全透明即可让整层从 oOut 一路淡到 0
      hidden.opacity = 0;
    }
    out.push({ offset: 1, opacity: doExit ? 0 : 1, transform: hidden.transform,
               clipPath: PV_FULL, filter: "blur(0px)", letterSpacing: "0.02em" });
    return out;
  }

  var pvAnims = [];

  // 流光的背景位移动画（每个字一条），重建前要全部取消，
  // 否则切模式 / 调参数时会越积越多，越拖越卡。
  var pvFlowAnims = [];

  function clearFlowAnims() {
    for (var i = 0; i < pvFlowAnims.length; i++) {
      try { pvFlowAnims[i].cancel(); } catch (e) {}
    }
    pvFlowAnims = [];
  }

  /**
   * 随机溶解的逐字动画：给每个字单独一条动画，
   * 出场时按**随机顺序**在 exit 秒内各自淡出。
   * 只挂一套动画，避免和整句的出入场动画打架。
   */
  function ensureCharSpans(el) {
    if (!el) return "";
    var txt = el.getAttribute("data-text");
    if (txt === null) { txt = el.textContent; el.setAttribute("data-text", txt); }
    // 已经是逐字结构就不重拆（否则会把已有的 span 又包一层）
    if (el.querySelector("span")) return txt;

    el.innerHTML = "";
    for (var i = 0; i < txt.length; i++) {
      var s = document.createElement("span");
      var ch = txt.charAt(i);
      // 空格不能是 inline-block：那样宽度会塌缩成 0，单词会粘在一起。
      // 用 pre 保留宽度，同时仍然是行内元素，能正常参与断行。
      if (ch === " ") { s.style.whiteSpace = "pre"; }
      else { s.style.display = "inline-block"; }
      s.textContent = ch;
      el.appendChild(s);
    }
    return txt;
  }

  /**
   * 逐字擦除 / 逐字淡出：按 Range Selector 的行为，字符从前往后依次变化。
   * 入场用每个字的 opacity 0→1，出场用 1→0，时间上依次错开。
   * （文字整体已经由父层动画控制 clip-path / 缩放，这里只补"逐个"这一层）
   */
  /* ===== 出入场时长：面板按"帧"调，内部换算成秒 =====
   *
   * 入场：基准 1.5 秒，滑块是**帧偏移**（-60 ~ +60 帧）
   * 出场：基准 35 帧，滑块是**帧偏移**（-25 ~ +15 帧，即 10 ~ 50 帧）
   *
   * 预览没有真实合成帧率，统一按 25fps 折算 —— 和引擎在 25fps 工程里完全一致。
   */
  var PV_FPS = 25;
  var ENTRY_BASE_SEC = 1.5;
  var EXIT_BASE_FRAMES = 35;
  var EXIT_MIN_FRAMES = 10;
  var EXIT_MAX_FRAMES = 50;

  /** 入场时长（秒）：1.5 + 帧偏移 / fps，最短 1 帧 */
  function previewEntrySeconds() {
    var sec = ENTRY_BASE_SEC + num("entry-frames") / PV_FPS;
    var minSec = 1 / PV_FPS;
    if (!(sec > minSec)) sec = minSec;
    return sec;
  }

  /** 出场帧数：35 + 偏移，夹在 10~50 之间 */
  function previewExitFrames() {
    var f = EXIT_BASE_FRAMES + num("exit-frames");
    if (f < EXIT_MIN_FRAMES) f = EXIT_MIN_FRAMES;
    if (f > EXIT_MAX_FRAMES) f = EXIT_MAX_FRAMES;
    return Math.round(f);
  }

  /** 出场时长（秒）= 出场帧数 / fps */
  function previewExitSeconds() {
    var sec = previewExitFrames() / PV_FPS;
    if (!(sec > 0.03)) sec = 0.03;
    return sec;
  }

  /**
   * 参数下面的小字：把"0"翻译成人能看懂的帧数/秒数。
   * 用户调完滑杆能立刻确认到底是多少帧，不用自己算。
   */
  function syncFrameNotes() {
    var en = $("entry-frames-note");
    if (en) {
      var off = Math.round(num("entry-frames"));
      var enSec = previewEntrySeconds();
      var enFrames = Math.round(enSec * PV_FPS);
      if (off === 0) {
        en.textContent = "基准 " + enSec.toFixed(2) + " 秒（" + enFrames + " 帧）";
      } else {
        en.textContent = (off > 0 ? "+" + off : String(off)) + " 帧 → " +
                         enSec.toFixed(2) + " 秒（" + enFrames + " 帧）";
      }
    }

    var ex = $("exit-frames-note");
    if (ex) {
      var exFrames = previewExitFrames();
      var off2 = Math.round(num("exit-frames"));
      var sec2 = exFrames / PV_FPS;
      if (off2 === 0) {
        ex.textContent = "基准 " + exFrames + " 帧（" + sec2.toFixed(2) + " 秒）";
      } else {
        ex.textContent = (off2 > 0 ? "+" + off2 : String(off2)) + " 帧 → 共 " +
                         exFrames + " 帧（" + sec2.toFixed(2) + " 秒）";
      }
    }

    var gr = $("grow-note");
    if (gr) {
      var g = num("grow-amt");
      gr.textContent = g > 0 ? ("约 +" + (g * 1.6).toFixed(0) + "% 放大") : "已关闭";
    }

    var sp = $("spacing-note");
    if (sp) {
      var s = num("spacing");
      sp.textContent = s > 0 ? ("字距 " + s + "（千分之一 em）") : "字距 0";
    }
  }

  function refreshCharWipe(el, total, delaySec, hold, entry, exit) {
    if (!el) return;
    ensureCharSpans(el);
    var spans = el.querySelectorAll("span");
    var n = spans.length;
    if (!n) return;

    var doEntry = checked("do-entry"), doExit = checked("do-exit");
    var dur = Math.round(total * 1000);
    var delayMs = Math.round((delaySec || 0) * 1000);

    // 出场时长按"延长段"算，和引擎一致
    exit = previewExitSeconds();

    // 帧里的时间都相对"这一句自己的开始"，相位由 delay 控制。
    // 入场从 0 开始（第一个字第一刻就动）；
    // 出场必须从「入场结束 + 停留」开始算 —— 之前 tOut = hold，
    // 漏掉了入场占用的那 entry 秒，逐字层会比整行早 entry 秒消失（留下黑场）。
    var tIn = 0;
    var tOut = (doEntry ? entry : 0) + hold;

    /**
     * 进度按 AE 的 Range Selector 粒度分配 —— 三种模式各不相同：
     *
     *   字符：每个字一个进度，从左到右逐字推进
     *   词  ：**一个词内的所有字母共用同一个进度**，整词一起出现/消失。
     *         这是最容易做错的地方 —— 若按字推进，"Welcome" 会变成
     *         W → e → l … 一个个蹦出来，和 AE 的"整词一起变"完全不一样。
     *   句  ：引擎用字符粒度（行内从左到右，扫完一行接下一行），按字推进即可
     *
     * 中文没有空格分词，一个字就是一个"词"，所以词模式下中文仍是逐字推进，
     * 和 AE 的表现一致。
     */
    var entryMode = val("entry-based"), exitMode = val("exit-based");

    /**
     * 把 n 个字按 AE 的粒度切成"推进单元"，返回每个字所属单元的编号。
     *   字符 / 句  → 每个字自己一个单元（从左到右逐字推进）
     *   词         → 空白分隔的一整段西文算一个单元；中日韩字符各算一个
     *
     * 词模式必须这样分组：AE 的 Range Selector 以「词」为单位推进时，
     * 一个词里的字母是**同时**变化的。若仍按字分配进度，
     * "Welcome" 会变成 W→e→l→c… 一个个蹦出来，和实际渲染完全不同。
     */
    function buildUnits(mode) {
      if (mode !== "word") {
        var single = [];
        for (var p = 0; p < n; p++) single[p] = p;
        return { of: single, count: n };
      }

      var units = [], cur = -1, prevWasSpace = true;
      for (var w = 0; w < n; w++) {
        var ch = spans[w].textContent;
        // 空白归到前一个词，不额外占一个进度
        if (/^\s$/.test(ch)) {
          units[w] = Math.max(0, cur);
          prevWasSpace = true;
          continue;
        }
        // 中日韩：一字一词
        if (new RegExp("[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]").test(ch)) {
          cur++; units[w] = cur; prevWasSpace = false; continue;
        }
        // 西文：连续非空白属于同一个词
        if (prevWasSpace || cur < 0) cur++;
        units[w] = cur;
        prevWasSpace = false;
      }
      return { of: units, count: cur + 1 };
    }

    // 入场和出场可以选择不同粒度，所以各算一份
    var entryUnits = buildUnits(entryMode);
    var exitUnits = buildUnits(exitMode);

    function ratioOf(units, i) {
      if (n <= 1) return 0;
      var denom = Math.max(1, units.count - 1);
      return Math.min(1, (units.of[i] || 0) / denom);
    }

    for (var i = 0; i < n; i++) {
      var s = spans[i];
      if (!s.animate) continue;
      var kfc = [];

      if (doEntry && entry > 0) {
        var eRatio = ratioOf(entryUnits, i);
        var eStart = tIn + entry * eRatio * 0.85;
        var eEnd = Math.min(tOut, eStart + entry * 0.35);
        kfc.push({ offset: 0, opacity: 0 });
        kfc.push({ offset: Math.max(0.0001, eStart / total), opacity: 0 });
        kfc.push({ offset: Math.max(0.0002, eEnd / total), opacity: 1 });
      } else {
        kfc.push({ offset: 0, opacity: 1 });
      }

      if (doExit && exit > 0) {
        var xRatio = ratioOf(exitUnits, i);
        var xStart = tOut + exit * xRatio * 0.85;
        // 整句淡出必须在 tOut + exit 处结束 —— 和入场"tOut 处结束"对称。
        // 之前用 min(total, …)，而 total 是整个循环周期，比出场结束点还晚，
        // 等于没有约束；最后一个字会拖到 1.2 倍出场时长才消失，和 AE 对不上。
        var xEnd = Math.min(tOut + exit, xStart + exit * 0.35);
        kfc.push({ offset: Math.min(1, xStart / total), opacity: 1 });
        kfc.push({ offset: Math.min(1, xEnd / total), opacity: 0 });
      }
      kfc.push({ offset: 1, opacity: 0 });

      // 关键帧必须严格递增，否则 Web Animations 会丢帧
      kfc.sort(function (a, b) { return a.offset - b.offset; });
      var clean = [];
      for (var q = 0; q < kfc.length; q++) {
        if (!clean.length || kfc[q].offset > clean[clean.length - 1].offset + 1e-6) clean.push(kfc[q]);
        else clean[clean.length - 1] = kfc[q];
      }

      // easing 必须是 linear：这里的关键帧 offset 已经精确表达了每个字的
      // 起止时刻，再套一层 ease-out 会把整条时间轴做非线性拉伸，
      // 结果就是"该显示的时候不显示、该结束的时候还没结束"，和 AE 的
      // Range Selector 线性推进完全不一致。
      try {
        pvAnims.push(s.animate(clean, {
          duration: dur, iterations: Infinity, easing: "linear",
          delay: delayMs, fill: "both"
        }));
      } catch (e) {}
    }
  }

  /**
   * 无缝循环的关键：
   *
   * 一句的生命周期 = 入场 eIn → 停留 hold → 出场 eOut。
   * 两句交替时，让"A 开始出场"和"B 开始入场"发生在**同一刻**，就是交叠；
   * 再让"B 开始出场"和"A 重新入场"也发生在同一刻，一整轮就闭合了。
   *
   *     T = 2 * half,  half = eIn + hold
   *     第 1 句 delay = 0
   *     第 2 句 delay = half      （＋ fill:"both" 保证等待期不可见）
   *
   * 这样任何时刻都至少有一句在画面上，循环点和中间点同构，看不出接缝。
   *
   * 之前的两处错误：
   *   1) total = 2*step + eOut - overlap 比实际可见时长长一大截，
   *      每句有 5 秒是空的；
   *   2) 第 2 句用正延迟却没给 fill，等待期退回元素自身 opacity:1，
   *      开头整句压在屏幕上。
   */
  function refreshAnimPreview() {
    for (var i = 0; i < pvAnims.length; i++) { try { pvAnims[i].cancel(); } catch (e) {} }
    pvAnims = [];

    var entry = previewEntrySeconds();
    // 出场时长 = 出场帧数 ÷ 帧率（基准 35 帧），和引擎一致
    var exit = previewExitSeconds();
    var doEntry = checked("do-entry"), doExit = checked("do-exit");

    var eIn = doEntry ? entry : 0;
    var eOut = doExit ? exit : 0;

    // 时间轴推导（这是无缝循环 + 不出现长黑场的关键）：
    //
    // 一句的生命周期 = 入场 eIn → 停留 hold → 出场 eOut，占 eIn+hold+eOut 秒。
    // 两句交替，希望"A 开始出场"和"B 开始入场"发生在**同一刻** —— 这就是交叠。
    //   A 出场开始 = eIn + hold
    //   令 B 的入场也从这一刻开始 → B 的延迟 S = eIn + hold
    //   B 出场开始 = S + eIn + hold = 2(eIn + hold)
    //   令 A 重新入场也在这刻 → 整轮周期 T = 2(eIn + hold)
    //
    // 这样每个周期里任何时刻都至少有一句在画面上，既没有长黑场，
    // 循环点上"A 在入场 ‖ B 在出场"和中间点"B 在入场 ‖ A 在出场"完全同构。
    // 之前用 total = 2*step + eOut - overlap 算，周期比实际可见时长长一大截，
    // 每句有 5 秒是空的 —— 那才是"显示一下就没了"的真正原因。
    var CYCLE = 8;                                  // 目标一轮 8 秒
    var half = CYCLE / 2;
    var hold = half - eIn;

    // 每句至少停留 2.2 秒；出入场设得太大时宁可整轮超过 8 秒，也不牺牲停留。
    var MIN_HOLD = 2.2;
    if (hold < MIN_HOLD) {
      hold = MIN_HOLD;
      half = eIn + hold;
    }
    var total = 2 * half;
    if (total <= 0) return;

    // 两句必须用**负**延迟错开半个周期。
    //
    // 正延迟不行：延迟期间动画不写值，元素退回自身 opacity:1，
    // 第 2 句会在开头整句压在屏幕上（即使加了 fill 也解决不了循环点：
    // 正延迟下第 2 句的迭代边界在 2*half，和 8 秒周期错位，绕回时会跳变）。
    //
    // 负延迟 = "这条动画已经播到一半"，所以从第 0 秒起两句就处在
    // 正常的交叠相位，整段严格以 2*half 为周期重复，循环点看不出接缝。
    //   t=0     : A 入场  ‖ B 正在出场   ← 就是中间的典型交叠
    //   t=half  : A 出场  ‖ B 入场
    //   t=2half : 回到 t=0 的状态
    var d1 = 0;                        // 第 1 句：从入场开始
    var d2 = half - total;             // 第 2 句：等价于已经播到 half 处

    var frames1 = buildLineFrames(hold, total);
    var frames2 = buildLineFrames(hold, total);   // 帧内容相同，靠 delay 错相位

    var dur = Math.round(total * 1000);
    function play(el, frames, delaySec) {
      if (!el || !el.animate) return;
      try {
        pvAnims.push(el.animate(frames, {
          duration: dur, iterations: Infinity,
          delay: Math.round(delaySec * 1000),
          // fill:"both" 让延迟期也保持首帧（不可见），
          // 否则第 2 句在等待入场的那 half 秒里会以 opacity:1 整句露在屏幕上。
          fill: "both"
        }));
      } catch (e) {}
    }

    play($("pv-en-1"), frames1, d1);
    play($("pv-cn-1"), frames1, d1);
    play($("pv-en-2"), frames2, d2);
    play($("pv-cn-2"), frames2, d2);

    // 逐字擦除：AE 的入场/出场是 Range Selector 按字符推进，预览也要逐字。
    // 同样要带负延迟，否则逐字层和整层会错位。
    refreshCharWipe($("pv-en-1"), total, d1, hold, entry, exit);
    refreshCharWipe($("pv-cn-1"), total, d1, hold, entry, exit);
    refreshCharWipe($("pv-en-2"), total, d2, hold, entry, exit);
    refreshCharWipe($("pv-cn-2"), total, d2, hold, entry, exit);
  }

  /* ---------- 刷新调度（rAF 节流，拖滑杆不卡） ---------- */

  var rafPending = false, rafJob = null;

  function schedule(job) {
    rafJob = job;
    if (rafPending) return;
    rafPending = true;
    var run = function () {
      rafPending = false;
      var j = rafJob;
      rafJob = null;
      if (j) { try { j(); } catch (e) {} }
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 动画相关参数变了：重排文字样式 + 重启动画 + 更新帧数小字 */
  function refreshAnimPreviewAll() {
    schedule(function () {
      syncFrameNotes();
      applyAnimPreviewStyle();
      refreshAnimPreview();
    });
  }

  /** 只改发光：不碰动画，避免拖动发光滑杆时动画一直重头播 */
  function refreshGlowPreview() {
    schedule(function () { applyGlowPreviewStyle(); syncGlowColorHint(); });
  }

  /** 全刷（启动 / 重置 / 套用预设时用） */
  function refreshPreview() {
    schedule(function () {
      syncFrameNotes();
      applyAnimPreviewStyle();
      applyGlowPreviewStyle();
      syncGlowColorHint();
      refreshAnimPreview();
    });
  }

  function startColorCycle() {
    if (pvTimer) { clearInterval(pvTimer); pvTimer = null; }
    var needCycle = (radio("cmode", "single") !== "single" && state.colors.length > 1) ||
                    (radio("gcmode", "single") !== "single" && state.glowColors.length > 1);
    if (needCycle) {
      pvTimer = setInterval(function () {
        pvIndex++;
        applyAnimPreviewStyle();
        applyGlowPreviewStyle();
      }, 2600);
    }
  }

  /* ==================================================================
   *  滑杆 + 可直接输入的数值框
   * ================================================================== */

  var updaters = {};

  function bindRange(id, valId, digits) {
    var el = $(id), out = $(valId);
    if (!el || !out) return;

    function fmt(v) {
      var n = parseFloat(v);
      if (isNaN(n)) return "";
      return digits ? n.toFixed(digits) : String(Math.round(n));
    }
    function syncOut() { out.value = fmt(el.value); }

    el.addEventListener("input", syncOut);

    // 数值框里直接改：夹到滑杆范围内 → 写回滑杆 → 触发滑杆的 input/change，
    // 这样预览刷新、保存配置等既有监听都会照常跑，不用重复实现一遍。
    function commit() {
      var n = parseFloat(out.value);
      if (isNaN(n)) { syncOut(); return; }
      var mn = parseFloat(el.min), mx = parseFloat(el.max);
      if (!isNaN(mn) && n < mn) n = mn;
      if (!isNaN(mx) && n > mx) n = mx;
      el.value = n;
      syncOut();
      try {
        el.dispatchEvent(new Event("input"));
        el.dispatchEvent(new Event("change"));
      } catch (e) {}
    }
    out.addEventListener("change", commit);
    out.addEventListener("blur", commit);
    out.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) { commit(); try { out.blur(); } catch (e2) {} }
    });

    updaters[id] = syncOut;
    syncOut();
  }

  function refreshAllDisplays() {
    for (var id in updaters) { try { updaters[id](); } catch (e) {} }
  }

  /* -------------------- 持久化 -------------------- */

  var FIELDS = ["linebreak", "extend-frames", "precomp-name",
    // 第 2 页导入组件（独立副本）
    "r-linebreak", "r-extend-frames", "r-precomp-name",
    "grow-amt",
    "entry-based", "exit-based", "entry-frames", "exit-frames",
    "entry-move", "exit-move",
    "spacing", "spacing-based", "wave-h", "wave-w", "wave-s",
    "glow-th", "glow-r", "glow-exp", "glow-i",
    "flow-period", "flow-mode", "flow-blank-count"];
  var CHECKS = ["do-entry", "do-exit", "do-tracking", "wave-en", "glow-en", "use-selection",
    "precompose", "force-upper", "clean-punct",
    "r-precompose", "r-force-upper", "r-clean-punct",
    "grow-en", "overlap", "flow-en"];
  var RADIOS = ["cmode", "fmode", "gcmode"];

  function collectFields() {
    var data = {};
    FIELDS.forEach(function (f) { data[f] = val(f); });
    CHECKS.forEach(function (c) { data[c] = checked(c); });
    RADIOS.forEach(function (r) { data[r] = radio(r, ""); });
    return data;
  }
  function applyFields(data) {
    if (!data) return;
    FIELDS.forEach(function (f) { if (data[f] !== undefined && $(f)) $(f).value = data[f]; });
    CHECKS.forEach(function (c) { if (data[c] !== undefined && $(c)) $(c).checked = data[c]; });
    RADIOS.forEach(function (n) {
      if (!data[n]) return;
      var el = document.querySelector('input[name="' + n + '"][value="' + data[n] + '"]');
      if (el) el.checked = true;
    });
  }

  function saveCfg() {
    var data = collectFields();
    data.v = CFG_VER;
    data.colors = state.colors;
    data.hue = state.hue;
    data.light = state.light;
    data.glowColors = state.glowColors;
    data.glowHue = state.glowHue;
    data.glowLight = state.glowLight;
    data.fonts = state.fonts;
    data.fontSingle = state.fontSingle;

    // 第 2 页（随机字幕）的状态单独存一份，互不影响
    var r = {
      rFonts: state.rFonts,
      rColors: state.rColors,
      rHue: state.rHue,
      rLight: state.rLight,
      rGlow: checked("r-glow-en"),
      rFlowFullwash: checked("r-flow-fullwash"),
      rFlowRibbon: checked("r-flow-ribbon"),
      rFlowRandom: checked("r-flow-random"),
      rFlowPeriod: val("r-flow-period"),
      rFlowBlank: val("r-flow-blank-count"),
      cv: (function () {
        var o = {};
        Object.keys(CV_DEFAULTS).forEach(function (id) { o[id] = val(id); });
        return o;
      })(),
      anims: pickedAnims()
    };
    saveLS("rinsubtitle_random", r);
    saveLS("rinsubtitle", data);
  }

  function loadCfg() {
    var data = loadLS("rinsubtitle", null);
    if (!data) return;
    // 旧版本的存档一律丢弃 —— 否则新的出厂默认值会被旧存档"粘住"
    if (data.v !== CFG_VER) return;

    applyFields(data);
    if (data.colors && data.colors.length) state.colors = data.colors;
    if (typeof data.hue === "number") state.hue = data.hue;
    if (typeof data.light === "number") state.light = data.light;
    if (data.glowColors && data.glowColors.length) state.glowColors = data.glowColors;
    if (typeof data.glowHue === "number") state.glowHue = data.glowHue;
    if (typeof data.glowLight === "number") state.glowLight = data.glowLight;
    if (data.fonts && data.fonts.length) state.fonts = data.fonts;
    if (data.fontSingle) state.fontSingle = data.fontSingle;

    loadRandomCfg();
  }

  /** 读第 2 页（随机字幕）的存档 */
  function loadRandomCfg() {
    var r = loadLS("rinsubtitle_random", null);
    if (!r) return;
    if (r.rFonts && r.rFonts.length) state.rFonts = r.rFonts;
    if (r.rColors && r.rColors.length) state.rColors = r.rColors;
    if (typeof r.rHue === "number") state.rHue = r.rHue;
    if (typeof r.rLight === "number") state.rLight = r.rLight;

    var ge = $("r-glow-en");
    if (ge && typeof r.rGlow === "boolean") ge.checked = r.rGlow;
    var ffw = $("r-flow-fullwash"), frb = $("r-flow-ribbon"), frn = $("r-flow-random");
    if (ffw && typeof r.rFlowFullwash === "boolean") ffw.checked = r.rFlowFullwash;
    if (frb && typeof r.rFlowRibbon === "boolean") frb.checked = r.rFlowRibbon;
    if (frn && typeof r.rFlowRandom === "boolean") frn.checked = r.rFlowRandom;
    var fp = $("r-flow-period"), fpv = $("r-flow-period-val");
    if (fp && r.rFlowPeriod) { fp.value = r.rFlowPeriod; if (fpv) fpv.value = r.rFlowPeriod; }
    var fb = $("r-flow-blank-count"), fbv = $("r-flow-blank-count-val");
    if (fb && r.rFlowBlank) { fb.value = r.rFlowBlank; if (fbv) fbv.value = r.rFlowBlank; }

    // 画面与文字
    if (r.cv) {
      Object.keys(CV_DEFAULTS).forEach(function (id) {
        var el = $(id);
        if (el && r.cv[id] !== undefined && r.cv[id] !== "") el.value = r.cv[id];
      });
    }

    // 随机动画：先全不勾，再按存档勾回，最后跑一次校验兜底
    if (r.anims && r.anims.length) {
      ANIM_PICKS.forEach(function (id) { var el = $(id); if (el) el.checked = false; });
      r.anims.forEach(function (id) { var el = $(id); if (el) el.checked = true; });
    }
  }

  /** 单色时隐藏随机颜色那一块 */
  function syncColorUI() {
    var tb = $("color-random-box");
    if (tb) tb.classList.toggle("hidden", radio("cmode", "single") === "single");
    var gb = $("glow-random-box");
    if (gb) gb.classList.toggle("hidden", radio("gcmode", "single") === "single");
  }

  /* ==================================================================
   *  出厂默认（不可被覆盖）
   *  用户「存为预设」只往预设列表里加，永远改不动这里的值。
   * ================================================================== */

  var FACTORY = null;

  var GROUP_IDS = {
    "1": ["linebreak", "extend-frames", "precomp-name", "precompose",
          "force-upper", "clean-punct"],
    "2": [],
    "3": ["glow-en", "glow-th", "glow-r", "glow-exp", "glow-i",
          "flow-en", "flow-mode", "flow-period", "flow-blank-count",
          "radio:cmode", "radio:gcmode"],
    "4": ["do-entry", "entry-based", "entry-frames", "do-exit", "exit-based", "exit-frames",
          "entry-move", "exit-move", "overlap", "do-tracking", "spacing", "spacing-based",
          "grow-en", "grow-amt"],
    "5": ["wave-en", "wave-h", "wave-w", "wave-s"],
    // 第 2 页的字幕导入（独立副本）
    "9": ["r-linebreak", "r-extend-frames", "r-precomp-name",
          "r-precompose", "r-force-upper", "r-clean-punct"]
  };

  var ALL_IDS = (function () {
    var out = [];
    for (var k in GROUP_IDS) out = out.concat(GROUP_IDS[k]);
    return out;
  })();

  /** 必须在读取用户配置之前调用：把面板 HTML 里的出厂值快照下来 */
  function snapshotFactory() {
    FACTORY = { fields: {}, bars: {} };
    ALL_IDS.forEach(function (id) {
      if (id.indexOf("radio:") === 0) {
        var n = id.slice(6);
        var r = document.querySelector('input[name="' + n + '"]:checked');
        FACTORY.fields[id] = { v: r ? r.value : "" };
        return;
      }
      var el = $(id);
      if (!el) return;
      if (el.type === "checkbox") FACTORY.fields[id] = { c: el.checked };
      else FACTORY.fields[id] = { v: el.value };
    });
    FACTORY.bars = { hue: 0, light: 100, colors: ["#ffffff"],
                     glowHue: 0, glowLight: 100, glowColors: ["#ffffff"] };
  }

  /** 恢复出厂默认：所有卡片、两个调色区、字体选择一起还原 */
  function resetAll() {
    ALL_IDS.forEach(function (id) {
      if (id.indexOf("radio:") === 0) {
        var n = id.slice(6), dv = FACTORY.fields[id] ? FACTORY.fields[id].v : "";
        var el = document.querySelector('input[name="' + n + '"][value="' + dv + '"]');
        if (el) el.checked = true;
        return;
      }
      var e = $(id), d = FACTORY.fields[id];
      if (!e || !d) return;
      if (d.c !== undefined) e.checked = d.c;
      else e.value = d.v;
    });
    state.hue = FACTORY.bars.hue;         state.light = FACTORY.bars.light;
    state.colors = FACTORY.bars.colors.slice();
    state.glowHue = FACTORY.bars.glowHue; state.glowLight = FACTORY.bars.glowLight;
    state.glowColors = FACTORY.bars.glowColors.slice();
    state.fonts = []; state.fontSingle = "";
    afterBulkChange();
    setStatus("已恢复出厂默认参数");
  }

  /** 重置某一组（回到出厂默认） */
  function resetGroup(k) {
    k = String(k);
    (GROUP_IDS[k] || []).forEach(function (id) {
      if (id.indexOf("radio:") === 0) {
        var n = id.slice(6), dv = FACTORY.fields[id] ? FACTORY.fields[id].v : "";
        var el = document.querySelector('input[name="' + n + '"][value="' + dv + '"]');
        if (el) el.checked = true;
        return;
      }
      var e = $(id), d = FACTORY.fields[id];
      if (!e || !d) return;
      if (d.c !== undefined) e.checked = d.c;
      else e.value = d.v;
    });

    if (k === "2") { state.fonts = []; state.fontSingle = ""; }
    if (k === "6") {
      // 第 2 页：随机字体池 + 随机色池回到出厂，发光默认打开
      state.rFonts = [];
      state.rColors = ["#ff4d4d", "#ff9f1a", "#ffe14d", "#7dff4d", "#4dd2ff", "#b44dff", "#ff4dd2"];
      var ge = $("r-glow-en"); if (ge) ge.checked = true;
      var ffw = $("r-flow-fullwash"), frb = $("r-flow-ribbon"), frn = $("r-flow-random");
      if (ffw) ffw.checked = false;
      if (frb) frb.checked = false;
      if (frn) frn.checked = false;
      syncFlowHint();
    }
    if (k === "7") {
      // 画面与文字：回到出厂尺寸 / 字号 / 间距
      Object.keys(CV_DEFAULTS).forEach(function (id) {
        var el = $(id);
        if (el) el.value = CV_DEFAULTS[id];
      });
    }
    if (k === "8") {
      // 随机动画：只勾"淡入淡出"
      ANIM_PICKS.forEach(function (id) { var el = $(id); if (el) el.checked = false; });
      var f = $("ra-fade"); if (f) f.checked = true;
    }
    if (k === "3") {
      state.hue = FACTORY.bars.hue;         state.light = FACTORY.bars.light;
      state.colors = FACTORY.bars.colors.slice();
      state.glowHue = FACTORY.bars.glowHue; state.glowLight = FACTORY.bars.glowLight;
      state.glowColors = FACTORY.bars.glowColors.slice();
    }

    afterBulkChange();
    setStatus("已重置该组件的参数");
  }

  /** 批量改了控件之后：刷新所有显示 + 重建 UI + 重画预览 + 存盘 */
  function afterBulkChange() {
    refreshAllDisplays();
    syncFrameNotes();
    renderFontChips();
    renderRandomFontChips(); renderRandomColors();
    textCtl.renderColors(); textCtl.renderPresets(); textCtl.paint();
    glowCtl.renderColors(); glowCtl.renderPresets(); glowCtl.paint();
    syncColorUI(); syncFontUI();
    syncRandomGlowHint();
    syncFlowHint();
    syncAnimPicks("");
    refreshCanvasPreview();
    refreshPreview();
    saveCfg();
  }

  /* -------------------- 参数预设（整面板） -------------------- */

  function renderParamPresets() {
    var box = $("param-preset-list");
    if (!box) return;
    box.innerHTML = "";
    state.paramPresets.forEach(function (p, i) {
      var chip = document.createElement("span");
      chip.className = "chip click";
      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name;
      var x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.paramPresets.splice(i, 1);
        renderParamPresets(); saveLS("rinsubtitle_paramsets", state.paramPresets);
      });
      chip.appendChild(nm); chip.appendChild(x);
      chip.addEventListener("click", function () {
        applyFields(p.fields);
        if (p.bars) {
          state.hue = p.bars.hue;               state.light = p.bars.light;
          state.colors = (p.bars.colors || state.colors).slice();
          state.glowHue = p.bars.glowHue;       state.glowLight = p.bars.glowLight;
          state.glowColors = (p.bars.glowColors || state.glowColors).slice();
        }
        afterBulkChange();
        setStatus("已套用预设：" + p.name);
      });
      box.appendChild(chip);
    });
  }

  function saveParamPreset() {
    // CEP 里 window.prompt 不一定可用，所以自动编号命名，不做弹窗输入
    var name = "预设 " + (state.paramPresets.length + 1);
    state.paramPresets.push({
      name: name,
      fields: collectFields(),
      bars: {
        hue: state.hue, light: state.light, colors: state.colors.slice(),
        glowHue: state.glowHue, glowLight: state.glowLight, glowColors: state.glowColors.slice()
      }
    });
    renderParamPresets();
    saveLS("rinsubtitle_paramsets", state.paramPresets);
    setStatus("已存为预设：" + name + "（出厂默认不受影响）");
  }

  /* -------------------- 事件绑定 -------------------- */
  /**
   * "留白处数"现在对**四种流光模式都生效**（都走分形噪波），
   * 所以这一行始终显示；只在流光没开时隐藏。
   */
  function syncFlowBlankRow() {
    var row = $("flow-blank-row");
    if (!row) return;
    row.classList.toggle("hidden", !checked("flow-en"));
  }

  /**
   * 第 2 页的字幕导入。
   *
   * 这是第 1 页 ① 字幕组件的**独立副本**：路径、分行、延长、预合成、
   * 强制大写、清洗标点都各存一份，两边互不干扰。
   * 以后第 2 页要单独改导入行为，改这里即可，不会影响第 1 页。
   */
  var rState = { srtPath: "" };

  function bindRandomImport() {
    var pick = $("r-pick-srt"), imp = $("r-import-srt"), name = $("r-srt-name");
    if (!pick || !imp) return;

    bindRange("r-linebreak", "r-linebreak-val", 0);

    pick.addEventListener("click", function () {
      cs.evalScript("PF_pickSRT()", function (p) {
        if (p && p !== "undefined" && p !== "" && p !== "EvalScript error.") {
          rState.srtPath = p;
          name.textContent = p.replace(/^.*[\\\/]/, "");
          name.title = p;
          setStatus("已选择字幕：" + name.textContent);
        } else setStatus("未选择文件", true);
      });
    });

    imp.addEventListener("click", function () {
      if (!rState.srtPath) { setStatus("请先选择 SRT 文件", true); return; }
      var n = Math.round(num("r-extend-frames"));
      var msg = "导入字幕";
      if (n > 0) msg += "（每条延长 " + n + " 帧）";
      callEngine("PF_importSRT", buildRandomImportOpts(), msg);
    });

    // 「延长」框：只接受整数帧
    var ef = $("r-extend-frames");
    if (ef) {
      ef.addEventListener("change", function () {
        var v = Math.round(parseFloat(ef.value));
        if (isNaN(v) || v < 0) v = 0;
        if (v > 600) v = 600;
        ef.value = v;
        saveCfg();
      });
    }
  }

  /** 第 2 页导入用的参数：只取导入相关的几项，其余沿用默认 */
  function buildRandomImportOpts() {
    return {
      srtPath: rState.srtPath,
      useSelection: false,
      lineBreakBase: num("r-linebreak"),
      extendFrames: num("r-extend-frames"),
      forceUpper: checked("r-force-upper"),
      cleanPunct: checked("r-clean-punct"),
      precompose: checked("r-precompose"),
      precompName: val("r-precomp-name") || "字幕"
    };
  }

  function bind() {
    bindRange("linebreak", "linebreak-val", 0);
    bindRange("flow-period", "flow-period-val", 1);
    bindRange("flow-blank-count", "flow-blank-count-val", 0);
    bindRange("grow-amt", "grow-amt-val", 0);
    bindRange("entry-frames", "entry-frames-val", 0);
    bindRange("exit-frames", "exit-frames-val", 0);
    bindRange("spacing", "spacing-val", 0);
    bindRange("wave-h", "wave-h-val", 0);
    bindRange("wave-w", "wave-w-val", 0);
    bindRange("wave-s", "wave-s-val", 1);
    bindRange("glow-th", "glow-th-val", 0);
    bindRange("glow-r", "glow-r-val", 0);
    bindRange("glow-exp", "glow-exp-val", 2);
    bindRange("glow-i", "glow-i-val", 2);

    RADIOS.forEach(function (n) {
      Array.prototype.forEach.call(document.querySelectorAll('input[name="' + n + '"]'), function (r) {
        r.addEventListener("change", function () {
          if (n === "cmode") textCtl.onModeChange();
          if (n === "gcmode") glowCtl.onModeChange();
          syncColorUI(); syncFontUI(); startColorCycle();
          refreshPreview(); saveCfg();
        });
      });
    });

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
      var n = Math.round(num("extend-frames"));
      var msg = "导入字幕";
      if (n > 0) msg += "（每条延长 " + n + " 帧）";
      callEngine("PF_importSRT", buildOpts(), msg);
    });

    // 「延长」框：只接受整数帧，空值按 0 处理
    (function () {
      var el = $("extend-frames");
      if (!el) return;
      el.addEventListener("change", function () {
        var v = Math.round(parseFloat(el.value));
        if (isNaN(v) || v < 0) v = 0;
        if (v > 600) v = 600;
        el.value = v;
        saveCfg();
      });
    })();

    /* ---------- 第 2 页的字幕导入（独立副本，状态与第 1 页互不影响） ---------- */
    bindRandomImport();

    // ② 字体
    $("pick-font-single").addEventListener("click", function () { openFontModal("single"); });
    $("add-fonts").addEventListener("click", function () { openFontModal("multi"); });
    $("clear-fonts").addEventListener("click", function () {
      state.fonts = []; renderFontChips(); saveCfg();
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

    // ③ 文字颜色
    textCtl.bindBars();
    $("add-color").addEventListener("click", textCtl.addColor);
    $("randomize-colors").addEventListener("click", textCtl.randomize);
    $("preset-save").addEventListener("click", textCtl.savePreset);

    // ③ 发光颜色
    glowCtl.bindBars();
    $("add-glow-color").addEventListener("click", glowCtl.addColor);
    $("randomize-glow-colors").addEventListener("click", glowCtl.randomize);
    $("glow-preset-save").addEventListener("click", glowCtl.savePreset);

    // 执行
    $("run-all").addEventListener("click", runWithProgress);
    $("run-animate").addEventListener("click", function () { callEngine("PF_animate", buildOpts(), "应用动画"); });
    $("run-fonts").addEventListener("click", function () { callEngine("PF_fonts", buildOpts(), "随机字体"); });
    $("run-wave").addEventListener("click", function () { callEngine("PF_wave", buildOpts(), "应用波浪"); });
    $("run-glow").addEventListener("click", function () { callEngine("PF_glow", buildOpts(), "应用发光"); });
    $("run-interlace").addEventListener("click", function () { callEngine("PF_interlace", buildOpts(), "图层交错"); });
    $("run-adjust").addEventListener("click", function () { callEngine("PF_adjustment", buildOpts(), "调整图层"); });
    $("save-cfg").addEventListener("click", function () { saveCfg(); setStatus("设置已保存"); });
    $("save-default").addEventListener("click", saveParamPreset);
    // CEP 里 window.confirm 不一定可用，直接恢复（自己存的预设不受影响）
    $("reset-all").addEventListener("click", resetAll);
    $("diag-shadow").addEventListener("click", function () {
      cs.evalScript("typeof PF_shadowDebug === 'function' ? PF_shadowDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("效果链 / 投影实际值：" + res.replace(/^OK\|/, ""));
      });
    });
    $("diag").addEventListener("click", function () {
      cs.evalScript("typeof PF_animDebug === 'function' ? PF_animDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("诊断结果：" + res.replace(/^OK\|/, ""));
      });
    });
    // 时序诊断：出场不对时先点它，一眼看出标记/出点/帧数哪一层出了问题
    var dt = $("diag-timing");
    if (dt) dt.addEventListener("click", function () {
      cs.evalScript("typeof PF_timingDebug === 'function' ? PF_timingDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("时序：" + res.replace(/^OK\|/, ""));
      });
    });

    // 汉化版 Deep Glow 的参数名是中文，这个按钮把实际参数名和值都打出来
    $("diag-glow").addEventListener("click", function () {
      cs.evalScript("typeof PF_glowDebug === 'function' ? PF_glowDebug() : 'ERR|引擎未加载'", function (res) {
        res = String(res == null ? "" : res);
        if (res.indexOf("ERR") === 0) setStatus(res.replace(/^ERR\|?/, ""), true);
        else setStatus("Deep Glow 实际参数：" + res.replace(/^OK\|/, ""));
      });
    });

    // 预览联动：动画类参数 → 重排动画；发光类参数 → 只重画发光（不打断动画）
    ["entry-frames", "exit-frames", "grow-amt", "spacing", "entry-based", "exit-based",
     "do-entry", "do-exit",
     "entry-move", "exit-move",
     "flow-en", "flow-mode", "flow-period", "flow-blank-count",
     "wave-en", "wave-h", "wave-w", "wave-s"]
      .forEach(function (id) {
        var el = $(id);
        if (!el) return;
        el.addEventListener("input", refreshAnimPreviewAll);
        el.addEventListener("change", refreshAnimPreviewAll);
      });

    // 「留白处数」跟着流光开关显隐
    var fmSel = $("flow-mode");
    if (fmSel) fmSel.addEventListener("change", syncFlowBlankRow);
    var feChk = $("flow-en");
    if (feChk) feChk.addEventListener("change", syncFlowBlankRow);

    ["glow-en", "glow-th", "glow-r", "glow-exp", "glow-i"]
      .forEach(function (id) {
        var el = $(id);
        if (!el) return;
        el.addEventListener("input", refreshGlowPreview);
        el.addEventListener("change", refreshGlowPreview);
      });

    // 所有参数改动都自动记忆：
    //   · change  —— 下拉框 / 输入框提交
    //   · input   —— 拖滑杆的过程中（否则拖完直接关面板，值会丢）
    // 用节流避免拖动时每帧都写 localStorage。
    var saveTimer = null;
    function saveSoon() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; saveCfg(); }, 400);
    }
    FIELDS.concat(CHECKS).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", saveCfg);
      el.addEventListener("input", saveSoon);
    });

    bindRandomPage(saveSoon);
  }

  /* -------------------- 第 2 页的事件绑定 -------------------- */

  function bindRandomPage(saveSoon) {
    // 翻页：左右箭头 + 两个页签都能点
    var prev = $("page-prev"), next = $("page-next");
    if (prev) prev.addEventListener("click", function () { showPage(1); });
    if (next) next.addEventListener("click", function () { showPage(2); });
    ["page-1-tab", "page-2-tab"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("click", function () { showPage(parseInt(el.getAttribute("data-page"), 10)); });
    });

    // 随机字体
    var addF = $("r-add-fonts");
    if (addF) addF.addEventListener("click", function () { openFontModal("r-multi"); });
    var clrF = $("r-clear-fonts");
    if (clrF) clrF.addEventListener("click", function () {
      state.rFonts = [];
      renderRandomFontChips(); saveCfg();
      setStatus("已清空随机字体");
    });

    // 随机颜色
    var addC = $("r-add-color");
    if (addC) addC.addEventListener("click", function () {
      if (state.rColors.length >= 12) { setStatus("最多 12 个颜色", true); return; }
      state.rColors.push(hslToHex(state.rHue, 100, state.rLight));
      renderRandomColors(); saveCfg();
    });
    var rndC = $("r-randomize-colors");
    if (rndC) rndC.addEventListener("click", function () {
      state.rColors = state.rColors.map(function () { return randomHex(); });
      renderRandomColors(); saveCfg();
    });

    // 发光开关 / 流光参数
    ["r-glow-en"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () { syncRandomGlowHint(); saveCfg(); });
    });

    bindRange("r-flow-period", "r-flow-period-val", 1);
    bindRange("r-flow-blank-count", "r-flow-blank-count-val", 0);

    // 流光：三个开关各自独立，任何改动都刷新提示
    ["r-flow-fullwash", "r-flow-ribbon", "r-flow-random"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () { syncFlowHint(); saveCfg(); });
    });

    ["r-flow-period", "r-flow-blank-count"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", saveCfg);
      if (saveSoon) el.addEventListener("input", saveSoon);
    });

    // ---- 画面与文字：任何参数变动都立即重排预览 ----
    Object.keys(CV_DEFAULTS).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", refreshCanvasPreview);
      el.addEventListener("change", function () { refreshCanvasPreview(); saveCfg(); });
    });

    // ---- 随机动画：多选开关，至少保留一个 ----
    ANIM_PICKS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        syncAnimPicks(id);
        saveCfg();
      });
    });

    // 一键生成随机效果
    var run = $("r-run-all");
    if (run) run.addEventListener("click", runRandomPage);
  }

  /**
   * 第 2 页的「一键生成」。
   *
   * 做法：把第 1 页的基础参数整体拿来，只覆盖三样东西 ——
   *   · 字体：用第 2 页的随机字体池，强制 random 模式
   *   · 颜色：用第 2 页的随机色池，强制 random 模式
   *   · 发光：用第 2 页的开关（默认开），其余参数沿用第 1 页
   * 流光是第 2 页独立的开关 + 模式（只有全范围晕染留白 / 彩带）。
   */
  function buildRandomOpts() {
    var o = buildOpts();
    o.fontMode = "random";
    o.fonts = state.rFonts.slice();
    o.colorMode = "random";
    o.colors = state.rColors.slice();
    o.glow.enabled = checked("r-glow-en");

    // 流光：三种开关的组合交给引擎
    //   modes      —— 勾选的具体效果（全范围晕染留白 / 彩带）
    //   random     —— 是否每条字幕随机取一个
    //   enabled    —— 有任何开关打开就算启用
    var fm = pickedFlowModes();
    o.flow.enabled = flowEnabledAny() && fm.length > 0;
    o.flow.modes = fm;
    o.flow.random = flowRandomOn();
    o.flow.mode = fm[0] || "fullwash";     // 兼容旧字段
    o.flow.period = num("r-flow-period");
    o.flow.blankCount = num("r-flow-blank-count");
    o.flow.color = state.rColors[0] || "#ffffff";
    o.page = 2;

    // 画面与文字
    o.canvas = {
      width: num("cv-w") || 1080,
      height: num("cv-h") || 1080,
      fps: num("cv-fps") || 60,
      size1: num("cv-size1") || 100,
      size2Delta: num("cv-size2-delta") || 0,
      shortDelta: num("cv-short-delta") || 0,
      tracking: num("cv-tracking") || 0,
      leading: num("cv-leading") || 0
    };

    // 随机动画：目前只有淡入淡出。选了就按"词"粒度做淡入淡出，
    // 参数（时长）沿用第 1 页的出入场秒数。
    var picks = pickedAnims();
    o.randomAnim = {
      enabled: picks.length > 0,
      pool: picks,
      entryBasedOn: "word",
      exitBasedOn: "word"
    };

    return o;
  }

  function runRandomPage() {
    if (runBusy) return;
    if (!state.rFonts.length) { setStatus("请先在「随机字体」里添加至少一个字体", true); return; }

    runBusy = true;
    var opts = buildRandomOpts();
    var script = "typeof PF_runStart === 'function' ? PF_runStart(" + JSON.stringify(opts) + ") : 'ERR|引擎未加载'";

    showProgress(true);
    setProgress(0, 0, "准备中");
    setStatus("一键生成随机效果 …运行中");

    function finish(text, isErr) {
      runBusy = false;
      showProgress(false);
      setStatus(text, !!isErr);
    }

    evalOnce(script, function (res) {
      if (res.indexOf("ERR") === 0) { finish(res.replace(/^ERR\|?/, "") || "执行失败", true); return; }
      var m = /^P\|(\d+)\|(\d+)\|(.*)$/.exec(res);
      if (!m) { finish(res.replace(/^OK\|?/, "") || "完成", false); return; }
      setProgress(parseInt(m[1], 10), parseInt(m[2], 10), m[3]);

      (function step() {
        evalOnce("typeof PF_runStep === 'function' ? PF_runStep() : 'ERR|引擎未加载'", function (r2) {
          if (r2.indexOf("ERR") === 0) { finish(r2.replace(/^ERR\|?/, "") || "执行失败", true); return; }
          var m2 = /^P\|(\d+)\|(\d+)\|(.*)$/.exec(r2);
          if (m2) {
            var done = parseInt(m2[1], 10), tot = parseInt(m2[2], 10);
            setProgress(done, tot, m2[3]);
            if (done < tot) setTimeout(step, 0);
            else evalOnce("typeof PF_runEnd === 'function' ? PF_runEnd() : 'OK|完成'", function (r3) {
              finish(String(r3).replace(/^OK\|?/, "") || "完成", false);
            });
            return;
          }
          finish(r2.replace(/^OK\|?/, "") || "完成", false);
        });
      })();
    });
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
    snapshotFactory();       // 先记下出厂默认值，再读用户配置
    loadCfg();
    state.presets = loadLS("rinsubtitle_presets", []) || [];
    state.glowPresets = loadLS("rinsubtitle_glowpresets", []) || [];
    state.paramPresets = loadLS("rinsubtitle_paramsets", []) || [];

    // 兜底：随机模式但色池还是出厂白 → 铺一组色，避免"随机出整句纯白"
    if (radio("cmode", "single") === "random" && textCtl.isPristine()) textCtl.seed();
    if (radio("gcmode", "single") === "random" && glowCtl.isPristine()) glowCtl.seed();

    textCtl.renderColors(); textCtl.renderPresets(); textCtl.paint();
    glowCtl.renderColors(); glowCtl.renderPresets(); glowCtl.paint();
    renderFontChips();
    renderRandomFontChips();
    renderRandomColors();
    renderParamPresets();
    syncColorUI();
    syncFontUI();
    syncFlowBlankRow();
    syncRandomGlowHint();
    syncFlowHint();
    syncAnimPicks("");
    refreshCanvasPreview();
    showPage(1);
    bind();
    renderFontOptions("");
    refreshPreview();
    startColorCycle();
    setStatus("连接引擎中…");

    loadEngine(function (r) {
      r = String(r == null ? "" : r);
      if (r.indexOf("ERR") === 0) {
        $("host-info").textContent = "未连接";
        setStatus("引擎加载失败：\n" + r.replace(/^ERR\|/, ""), true);
      } else {
        $("host-info").textContent = r.replace(/^OK\|/, "") || "已连接";
        setStatus("就绪");
        ensureFonts(false, function () {
          syncFontUI();
          renderFontChips();
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
