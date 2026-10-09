// 老 WebView 不认 container query 单位（1cqw）和 aspect-ratio。
// 画面里所有尺寸都是 em，基准是 .tv-picture 的 font-size = 屏幕宽度的 1%。这里用 JS 算出来写回去。
// 遥控/小屏设备没有机身边框的必要：.tv-screen 铺满视口，按 16:9 能放下的最大尺寸取基准。
(function () {
  var root = document.documentElement;
  function fit() {
    var w = root.clientWidth, h = root.clientHeight;
    var unit = Math.min(w, h * 16 / 9) / 100;
    root.style.setProperty("--cqw", unit + "px");
  }
  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);

  // 点开机时顺手进全屏（浏览器顶栏会吃掉三分之一的小屏）。不支持就算了。
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".tv-power")) return;
    var req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      try { var p = req.call(root); if (p && p.catch) p.catch(function () {}); } catch (err) {}
    }
  }, true);

  // 老 WebView 偶尔会停发 requestAnimationFrame（页面可见、定时器照跑，就是不出帧）：
  // 画面定格在换条那一帧（卡片还没淡入，整块空白），声音照常往下播。
  // 兜底：回调 250ms 内没被调用就用 setTimeout 补一次。补过几次记在 window.__aitvRafStalls，方便上设备核对。
  var nativeRAF = window.requestAnimationFrame.bind(window);
  var nativeCAF = window.cancelAnimationFrame.bind(window);
  var pending = {}, nextId = 1;
  window.__aitvRafStalls = { count: 0, last: 0 };
  window.requestAnimationFrame = function (cb) {
    var id = nextId++, done = false, raf, timer;
    function run(ts, stalled) {
      if (done) return;
      done = true; delete pending[id];
      nativeCAF(raf); clearTimeout(timer);
      if (stalled && !document.hidden) { window.__aitvRafStalls.count++; window.__aitvRafStalls.last = Date.now(); }
      cb(ts);
    }
    raf = nativeRAF(function (ts) { run(ts, false); });
    timer = setTimeout(function () { run(performance.now(), true); }, 250);
    pending[id] = function () { done = true; nativeCAF(raf); clearTimeout(timer); };
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (pending[id]) { pending[id](); delete pending[id]; }
  };
})();
