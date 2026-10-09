// 老 WebView（Chrome 61，Android 8 设备自带）缺的运行时 API。语法降级交给 esbuild，这里只补 API。
(function () {
  var g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window;
  if (typeof globalThis === "undefined") g.globalThis = g;

  if (!Promise.allSettled) {
    Promise.allSettled = function (items) {
      return Promise.all(Array.from(items, function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: "fulfilled", value: value }; },
          function (reason) { return { status: "rejected", reason: reason }; });
      }));
    };
  }
  if (Promise.prototype.finally === undefined) {
    Promise.prototype.finally = function (fn) {
      return this.then(function (v) { return Promise.resolve(fn()).then(function () { return v; }); },
        function (e) { return Promise.resolve(fn()).then(function () { throw e; }); });
    };
  }

  if (g.performance && performance.timeOrigin === undefined) {
    var origin = performance.timing && performance.timing.navigationStart || Date.now() - performance.now();
    try { Object.defineProperty(performance, "timeOrigin", { value: origin }); } catch (e) { performance.timeOrigin = origin; }
  }

  // AbortSignal.timeout：Chrome 61 连 AbortController 都没有，fetch 也不认 signal。
  // 给一个带超时毫秒数的假 signal，再包一层 fetch 用 Promise.race 实现超时。
  if (!g.AbortSignal) g.AbortSignal = function AbortSignal() {};
  if (!g.AbortSignal.timeout) {
    g.AbortSignal.timeout = function (ms) { var s = Object.create(g.AbortSignal.prototype); s.__timeoutMs = ms; return s; };
    var nativeFetch = g.fetch.bind(g);
    g.fetch = function (input, init) {
      var ms = init && init.signal && init.signal.__timeoutMs;
      if (!ms) return nativeFetch(input, init);
      var rest = Object.assign({}, init); delete rest.signal;
      return Promise.race([nativeFetch(input, rest), new Promise(function (_, reject) {
        setTimeout(function () { var e = new Error("The operation timed out."); e.name = "TimeoutError"; reject(e); }, ms);
      })]);
    };
  }

  var EP = Element.prototype;
  if (!EP.toggleAttribute) {
    EP.toggleAttribute = function (name, force) {
      var has = this.hasAttribute(name), want = force === undefined ? !has : !!force;
      if (want && !has) this.setAttribute(name, ""); else if (!want && has) this.removeAttribute(name);
      return want;
    };
  }
})();
