/* ------------------------------------------------------------------
 * CSInterface.js  —  精简版
 * 只包含本面板需要的能力：evalScript / 宿主信息 / 系统路径。
 * 逻辑等价于 Adobe CEP 官方库的对应部分，未使用其代码。
 * ------------------------------------------------------------------ */
function CSInterface() {}

/** 执行宿主(After Effects)端 ExtendScript，结果通过 callback 返回字符串 */
CSInterface.prototype.evalScript = function (script, callback) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript(script, callback || function () {});
  } else if (callback) {
    callback("ERR_NO_CEP");
  }
};

/** 返回宿主环境信息(含 appName / appVersion) */
CSInterface.prototype.getHostEnvironment = function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return {};
  }
};

/** 返回扩展自身的绝对路径 */
CSInterface.prototype.getSystemPath = function (pathType) {
  var p = "";
  try {
    p = window.__adobe_cep__.getSystemPath(pathType || "extension");
  } catch (e) {
    p = "";
  }
  return decodeURI(p).replace(/\/$/, "");
};

/** 打开扩展（本面板不使用，占位保持接口完整） */
CSInterface.prototype.closeExtension = function () {
  try { window.__adobe_cep__.closeExtension(); } catch (e) {}
};

/** CEP 事件常量 */
var CSEvent = function (type, scope, appId, extensionId) {
  this.type = type;
  this.scope = scope;
  this.appId = appId;
  this.extensionId = extensionId;
  this.data = null;
};
