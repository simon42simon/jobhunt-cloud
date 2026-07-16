import { jsx as g, jsxs as J, Fragment as Bt } from "react/jsx-runtime";
import * as c from "react";
import { useState as Ii, forwardRef as eo, createElement as bn, useLayoutEffect as _i } from "react";
import * as ut from "react-dom";
function yr(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
function Mi(...e) {
  return (t) => {
    let n = !1;
    const r = e.map((o) => {
      const s = yr(o, t);
      return !n && typeof s == "function" && (n = !0), s;
    });
    if (n)
      return () => {
        for (let o = 0; o < r.length; o++) {
          const s = r[o];
          typeof s == "function" ? s() : yr(e[o], null);
        }
      };
  };
}
function j(...e) {
  return c.useCallback(Mi(...e), e);
}
// @__NO_SIDE_EFFECTS__
function ke(e) {
  const t = c.forwardRef((n, r) => {
    let { children: o, ...s } = n, i = null, a = !1;
    const l = [];
    wr(o) && typeof St == "function" && (o = St(o._payload)), c.Children.forEach(o, (m) => {
      var v;
      if (Vi(m)) {
        a = !0;
        const y = m;
        let p = "child" in y.props ? y.props.child : y.props.children;
        wr(p) && typeof St == "function" && (p = St(p._payload)), i = Li(y, p), l.push((v = i == null ? void 0 : i.props) == null ? void 0 : v.children);
      } else
        l.push(m);
    }), i ? i = c.cloneElement(i, void 0, l) : (
      // A `Slottable` was found but it didn't resolve to a single element (e.g.
      // it wrapped multiple elements, text, or a render-prop `child` that
      // wasn't an element). Don't fall back to treating the `Slottable` wrapper
      // itself as the slot target — throw a descriptive error below instead.
      !a && c.Children.count(o) === 1 && c.isValidElement(o) && (i = o)
    );
    const f = i ? $i(i) : void 0, u = j(r, f);
    if (!i) {
      if (o || o === 0)
        throw new Error(
          a ? zi(e) : Hi(e)
        );
      return o;
    }
    const d = Fi(s, i.props ?? {});
    return i.type !== c.Fragment && (d.ref = r ? u : f), c.cloneElement(i, d);
  });
  return t.displayName = `${e}.Slot`, t;
}
var Di = /* @__PURE__ */ ke("Slot"), to = Symbol.for("radix.slottable");
// @__NO_SIDE_EFFECTS__
function ki(e) {
  const t = (n) => "child" in n ? n.children(n.child) : n.children;
  return t.displayName = `${e}.Slottable`, t.__radixId = to, t;
}
var Li = (e, t) => {
  if ("child" in e.props) {
    const n = e.props.child;
    return c.isValidElement(n) ? c.cloneElement(n, void 0, e.props.children(n.props.children)) : null;
  }
  return c.isValidElement(t) ? t : null;
};
function Fi(e, t) {
  const n = { ...t };
  for (const r in t) {
    const o = e[r], s = t[r];
    /^on[A-Z]/.test(r) ? o && s ? n[r] = (...a) => {
      const l = s(...a);
      return o(...a), l;
    } : o && (n[r] = o) : r === "style" ? n[r] = { ...o, ...s } : r === "className" && (n[r] = [o, s].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function $i(e) {
  var r, o;
  let t = (r = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (o = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
function Vi(e) {
  return c.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === to;
}
var Bi = Symbol.for("react.lazy");
function wr(e) {
  return e != null && typeof e == "object" && "$$typeof" in e && e.$$typeof === Bi && "_payload" in e && Wi(e._payload);
}
function Wi(e) {
  return typeof e == "object" && e !== null && "then" in e;
}
var Hi = (e) => `${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`, zi = (e) => `${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`, St = c[" use ".trim().toString()];
function no(e) {
  var t, n, r = "";
  if (typeof e == "string" || typeof e == "number") r += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (n = no(e[t])) && (r && (r += " "), r += n);
  } else for (n in e) e[n] && (r && (r += " "), r += n);
  return r;
}
function ro() {
  for (var e, t, n = 0, r = "", o = arguments.length; n < o; n++) (e = arguments[n]) && (t = no(e)) && (r && (r += " "), r += t);
  return r;
}
const xr = (e) => typeof e == "boolean" ? `${e}` : e === 0 ? "0" : e, Cr = ro, _n = (e, t) => (n) => {
  var r;
  if ((t == null ? void 0 : t.variants) == null) return Cr(e, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
  const { variants: o, defaultVariants: s } = t, i = Object.keys(o).map((f) => {
    const u = n == null ? void 0 : n[f], d = s == null ? void 0 : s[f];
    if (u === null) return null;
    const m = xr(u) || xr(d);
    return o[f][m];
  }), a = n && Object.entries(n).reduce((f, u) => {
    let [d, m] = u;
    return m === void 0 || (f[d] = m), f;
  }, {}), l = t == null || (r = t.compoundVariants) === null || r === void 0 ? void 0 : r.reduce((f, u) => {
    let { class: d, className: m, ...v } = u;
    return Object.entries(v).every((y) => {
      let [p, h] = y;
      return Array.isArray(h) ? h.includes({
        ...s,
        ...a
      }[p]) : {
        ...s,
        ...a
      }[p] === h;
    }) ? [
      ...f,
      d,
      m
    ] : f;
  }, []);
  return Cr(e, i, l, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
}, Mn = "-", Ui = (e) => {
  const t = ji(e), {
    conflictingClassGroups: n,
    conflictingClassGroupModifiers: r
  } = e;
  return {
    getClassGroupId: (i) => {
      const a = i.split(Mn);
      return a[0] === "" && a.length !== 1 && a.shift(), oo(a, t) || Gi(i);
    },
    getConflictingClassGroupIds: (i, a) => {
      const l = n[i] || [];
      return a && r[i] ? [...l, ...r[i]] : l;
    }
  };
}, oo = (e, t) => {
  var i;
  if (e.length === 0)
    return t.classGroupId;
  const n = e[0], r = t.nextPart.get(n), o = r ? oo(e.slice(1), r) : void 0;
  if (o)
    return o;
  if (t.validators.length === 0)
    return;
  const s = e.join(Mn);
  return (i = t.validators.find(({
    validator: a
  }) => a(s))) == null ? void 0 : i.classGroupId;
}, Sr = /^\[(.+)\]$/, Gi = (e) => {
  if (Sr.test(e)) {
    const t = Sr.exec(e)[1], n = t == null ? void 0 : t.substring(0, t.indexOf(":"));
    if (n)
      return "arbitrary.." + n;
  }
}, ji = (e) => {
  const {
    theme: t,
    prefix: n
  } = e, r = {
    nextPart: /* @__PURE__ */ new Map(),
    validators: []
  };
  return Yi(Object.entries(e.classGroups), n).forEach(([s, i]) => {
    yn(i, r, s, t);
  }), r;
}, yn = (e, t, n, r) => {
  e.forEach((o) => {
    if (typeof o == "string") {
      const s = o === "" ? t : Rr(t, o);
      s.classGroupId = n;
      return;
    }
    if (typeof o == "function") {
      if (Ki(o)) {
        yn(o(r), t, n, r);
        return;
      }
      t.validators.push({
        validator: o,
        classGroupId: n
      });
      return;
    }
    Object.entries(o).forEach(([s, i]) => {
      yn(i, Rr(t, s), n, r);
    });
  });
}, Rr = (e, t) => {
  let n = e;
  return t.split(Mn).forEach((r) => {
    n.nextPart.has(r) || n.nextPart.set(r, {
      nextPart: /* @__PURE__ */ new Map(),
      validators: []
    }), n = n.nextPart.get(r);
  }), n;
}, Ki = (e) => e.isThemeGetter, Yi = (e, t) => t ? e.map(([n, r]) => {
  const o = r.map((s) => typeof s == "string" ? t + s : typeof s == "object" ? Object.fromEntries(Object.entries(s).map(([i, a]) => [t + i, a])) : s);
  return [n, o];
}) : e, Xi = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let t = 0, n = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map();
  const o = (s, i) => {
    n.set(s, i), t++, t > e && (t = 0, r = n, n = /* @__PURE__ */ new Map());
  };
  return {
    get(s) {
      let i = n.get(s);
      if (i !== void 0)
        return i;
      if ((i = r.get(s)) !== void 0)
        return o(s, i), i;
    },
    set(s, i) {
      n.has(s) ? n.set(s, i) : o(s, i);
    }
  };
}, so = "!", qi = (e) => {
  const {
    separator: t,
    experimentalParseClassName: n
  } = e, r = t.length === 1, o = t[0], s = t.length, i = (a) => {
    const l = [];
    let f = 0, u = 0, d;
    for (let h = 0; h < a.length; h++) {
      let b = a[h];
      if (f === 0) {
        if (b === o && (r || a.slice(h, h + s) === t)) {
          l.push(a.slice(u, h)), u = h + s;
          continue;
        }
        if (b === "/") {
          d = h;
          continue;
        }
      }
      b === "[" ? f++ : b === "]" && f--;
    }
    const m = l.length === 0 ? a : a.substring(u), v = m.startsWith(so), y = v ? m.substring(1) : m, p = d && d > u ? d - u : void 0;
    return {
      modifiers: l,
      hasImportantModifier: v,
      baseClassName: y,
      maybePostfixModifierPosition: p
    };
  };
  return n ? (a) => n({
    className: a,
    parseClassName: i
  }) : i;
}, Zi = (e) => {
  if (e.length <= 1)
    return e;
  const t = [];
  let n = [];
  return e.forEach((r) => {
    r[0] === "[" ? (t.push(...n.sort(), r), n = []) : n.push(r);
  }), t.push(...n.sort()), t;
}, Qi = (e) => ({
  cache: Xi(e.cacheSize),
  parseClassName: qi(e),
  ...Ui(e)
}), Ji = /\s+/, ea = (e, t) => {
  const {
    parseClassName: n,
    getClassGroupId: r,
    getConflictingClassGroupIds: o
  } = t, s = [], i = e.trim().split(Ji);
  let a = "";
  for (let l = i.length - 1; l >= 0; l -= 1) {
    const f = i[l], {
      modifiers: u,
      hasImportantModifier: d,
      baseClassName: m,
      maybePostfixModifierPosition: v
    } = n(f);
    let y = !!v, p = r(y ? m.substring(0, v) : m);
    if (!p) {
      if (!y) {
        a = f + (a.length > 0 ? " " + a : a);
        continue;
      }
      if (p = r(m), !p) {
        a = f + (a.length > 0 ? " " + a : a);
        continue;
      }
      y = !1;
    }
    const h = Zi(u).join(":"), b = d ? h + so : h, x = b + p;
    if (s.includes(x))
      continue;
    s.push(x);
    const w = o(p, y);
    for (let C = 0; C < w.length; ++C) {
      const S = w[C];
      s.push(b + S);
    }
    a = f + (a.length > 0 ? " " + a : a);
  }
  return a;
};
function ta() {
  let e = 0, t, n, r = "";
  for (; e < arguments.length; )
    (t = arguments[e++]) && (n = io(t)) && (r && (r += " "), r += n);
  return r;
}
const io = (e) => {
  if (typeof e == "string")
    return e;
  let t, n = "";
  for (let r = 0; r < e.length; r++)
    e[r] && (t = io(e[r])) && (n && (n += " "), n += t);
  return n;
};
function na(e, ...t) {
  let n, r, o, s = i;
  function i(l) {
    const f = t.reduce((u, d) => d(u), e());
    return n = Qi(f), r = n.cache.get, o = n.cache.set, s = a, a(l);
  }
  function a(l) {
    const f = r(l);
    if (f)
      return f;
    const u = ea(l, n);
    return o(l, u), u;
  }
  return function() {
    return s(ta.apply(null, arguments));
  };
}
const Y = (e) => {
  const t = (n) => n[e] || [];
  return t.isThemeGetter = !0, t;
}, ao = /^\[(?:([a-z-]+):)?(.+)\]$/i, ra = /^\d+\/\d+$/, oa = /* @__PURE__ */ new Set(["px", "full", "screen"]), sa = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, ia = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, aa = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/, ca = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, la = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, we = (e) => Ge(e) || oa.has(e) || ra.test(e), Re = (e) => Qe(e, "length", ha), Ge = (e) => !!e && !Number.isNaN(Number(e)), sn = (e) => Qe(e, "number", Ge), ot = (e) => !!e && Number.isInteger(Number(e)), ua = (e) => e.endsWith("%") && Ge(e.slice(0, -1)), k = (e) => ao.test(e), Ee = (e) => sa.test(e), da = /* @__PURE__ */ new Set(["length", "size", "percentage"]), fa = (e) => Qe(e, da, co), pa = (e) => Qe(e, "position", co), ma = /* @__PURE__ */ new Set(["image", "url"]), ga = (e) => Qe(e, ma, ya), va = (e) => Qe(e, "", ba), st = () => !0, Qe = (e, t, n) => {
  const r = ao.exec(e);
  return r ? r[1] ? typeof t == "string" ? r[1] === t : t.has(r[1]) : n(r[2]) : !1;
}, ha = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  ia.test(e) && !aa.test(e)
), co = () => !1, ba = (e) => ca.test(e), ya = (e) => la.test(e), wa = () => {
  const e = Y("colors"), t = Y("spacing"), n = Y("blur"), r = Y("brightness"), o = Y("borderColor"), s = Y("borderRadius"), i = Y("borderSpacing"), a = Y("borderWidth"), l = Y("contrast"), f = Y("grayscale"), u = Y("hueRotate"), d = Y("invert"), m = Y("gap"), v = Y("gradientColorStops"), y = Y("gradientColorStopPositions"), p = Y("inset"), h = Y("margin"), b = Y("opacity"), x = Y("padding"), w = Y("saturate"), C = Y("scale"), S = Y("sepia"), R = Y("skew"), E = Y("space"), T = Y("translate"), V = () => ["auto", "contain", "none"], L = () => ["auto", "hidden", "clip", "visible", "scroll"], P = () => ["auto", k, t], N = () => [k, t], $ = () => ["", we, Re], F = () => ["auto", Ge, k], z = () => ["bottom", "center", "left", "left-bottom", "left-top", "right", "right-bottom", "right-top", "top"], I = () => ["solid", "dashed", "dotted", "double", "none"], W = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], A = () => ["start", "end", "center", "between", "around", "evenly", "stretch"], B = () => ["", "0", k], X = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], q = () => [Ge, k];
  return {
    cacheSize: 500,
    separator: ":",
    theme: {
      colors: [st],
      spacing: [we, Re],
      blur: ["none", "", Ee, k],
      brightness: q(),
      borderColor: [e],
      borderRadius: ["none", "", "full", Ee, k],
      borderSpacing: N(),
      borderWidth: $(),
      contrast: q(),
      grayscale: B(),
      hueRotate: q(),
      invert: B(),
      gap: N(),
      gradientColorStops: [e],
      gradientColorStopPositions: [ua, Re],
      inset: P(),
      margin: P(),
      opacity: q(),
      padding: N(),
      saturate: q(),
      scale: q(),
      sepia: B(),
      skew: q(),
      space: N(),
      translate: N()
    },
    classGroups: {
      // Layout
      /**
       * Aspect Ratio
       * @see https://tailwindcss.com/docs/aspect-ratio
       */
      aspect: [{
        aspect: ["auto", "square", "video", k]
      }],
      /**
       * Container
       * @see https://tailwindcss.com/docs/container
       */
      container: ["container"],
      /**
       * Columns
       * @see https://tailwindcss.com/docs/columns
       */
      columns: [{
        columns: [Ee]
      }],
      /**
       * Break After
       * @see https://tailwindcss.com/docs/break-after
       */
      "break-after": [{
        "break-after": X()
      }],
      /**
       * Break Before
       * @see https://tailwindcss.com/docs/break-before
       */
      "break-before": [{
        "break-before": X()
      }],
      /**
       * Break Inside
       * @see https://tailwindcss.com/docs/break-inside
       */
      "break-inside": [{
        "break-inside": ["auto", "avoid", "avoid-page", "avoid-column"]
      }],
      /**
       * Box Decoration Break
       * @see https://tailwindcss.com/docs/box-decoration-break
       */
      "box-decoration": [{
        "box-decoration": ["slice", "clone"]
      }],
      /**
       * Box Sizing
       * @see https://tailwindcss.com/docs/box-sizing
       */
      box: [{
        box: ["border", "content"]
      }],
      /**
       * Display
       * @see https://tailwindcss.com/docs/display
       */
      display: ["block", "inline-block", "inline", "flex", "inline-flex", "table", "inline-table", "table-caption", "table-cell", "table-column", "table-column-group", "table-footer-group", "table-header-group", "table-row-group", "table-row", "flow-root", "grid", "inline-grid", "contents", "list-item", "hidden"],
      /**
       * Floats
       * @see https://tailwindcss.com/docs/float
       */
      float: [{
        float: ["right", "left", "none", "start", "end"]
      }],
      /**
       * Clear
       * @see https://tailwindcss.com/docs/clear
       */
      clear: [{
        clear: ["left", "right", "both", "none", "start", "end"]
      }],
      /**
       * Isolation
       * @see https://tailwindcss.com/docs/isolation
       */
      isolation: ["isolate", "isolation-auto"],
      /**
       * Object Fit
       * @see https://tailwindcss.com/docs/object-fit
       */
      "object-fit": [{
        object: ["contain", "cover", "fill", "none", "scale-down"]
      }],
      /**
       * Object Position
       * @see https://tailwindcss.com/docs/object-position
       */
      "object-position": [{
        object: [...z(), k]
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: L()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": L()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": L()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: V()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": V()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": V()
      }],
      /**
       * Position
       * @see https://tailwindcss.com/docs/position
       */
      position: ["static", "fixed", "absolute", "relative", "sticky"],
      /**
       * Top / Right / Bottom / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      inset: [{
        inset: [p]
      }],
      /**
       * Right / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": [p]
      }],
      /**
       * Top / Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": [p]
      }],
      /**
       * Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      start: [{
        start: [p]
      }],
      /**
       * End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      end: [{
        end: [p]
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: [p]
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: [p]
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: [p]
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: [p]
      }],
      /**
       * Visibility
       * @see https://tailwindcss.com/docs/visibility
       */
      visibility: ["visible", "invisible", "collapse"],
      /**
       * Z-Index
       * @see https://tailwindcss.com/docs/z-index
       */
      z: [{
        z: ["auto", ot, k]
      }],
      // Flexbox and Grid
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: P()
      }],
      /**
       * Flex Direction
       * @see https://tailwindcss.com/docs/flex-direction
       */
      "flex-direction": [{
        flex: ["row", "row-reverse", "col", "col-reverse"]
      }],
      /**
       * Flex Wrap
       * @see https://tailwindcss.com/docs/flex-wrap
       */
      "flex-wrap": [{
        flex: ["wrap", "wrap-reverse", "nowrap"]
      }],
      /**
       * Flex
       * @see https://tailwindcss.com/docs/flex
       */
      flex: [{
        flex: ["1", "auto", "initial", "none", k]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: B()
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: B()
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: ["first", "last", "none", ot, k]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": [st]
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: ["auto", {
          span: ["full", ot, k]
        }, k]
      }],
      /**
       * Grid Column Start
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start": [{
        "col-start": F()
      }],
      /**
       * Grid Column End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-end": [{
        "col-end": F()
      }],
      /**
       * Grid Template Rows
       * @see https://tailwindcss.com/docs/grid-template-rows
       */
      "grid-rows": [{
        "grid-rows": [st]
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: ["auto", {
          span: [ot, k]
        }, k]
      }],
      /**
       * Grid Row Start
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start": [{
        "row-start": F()
      }],
      /**
       * Grid Row End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-end": [{
        "row-end": F()
      }],
      /**
       * Grid Auto Flow
       * @see https://tailwindcss.com/docs/grid-auto-flow
       */
      "grid-flow": [{
        "grid-flow": ["row", "col", "dense", "row-dense", "col-dense"]
      }],
      /**
       * Grid Auto Columns
       * @see https://tailwindcss.com/docs/grid-auto-columns
       */
      "auto-cols": [{
        "auto-cols": ["auto", "min", "max", "fr", k]
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": ["auto", "min", "max", "fr", k]
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: [m]
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": [m]
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": [m]
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: ["normal", ...A()]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": ["start", "end", "center", "stretch"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", "start", "end", "center", "stretch"]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...A(), "baseline"]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: ["start", "end", "center", "baseline", "stretch"]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", "start", "end", "center", "stretch", "baseline"]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": [...A(), "baseline"]
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": ["start", "end", "center", "baseline", "stretch"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", "start", "end", "center", "stretch"]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: [x]
      }],
      /**
       * Padding X
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: [x]
      }],
      /**
       * Padding Y
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: [x]
      }],
      /**
       * Padding Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: [x]
      }],
      /**
       * Padding End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: [x]
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: [x]
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: [x]
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: [x]
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: [x]
      }],
      /**
       * Margin
       * @see https://tailwindcss.com/docs/margin
       */
      m: [{
        m: [h]
      }],
      /**
       * Margin X
       * @see https://tailwindcss.com/docs/margin
       */
      mx: [{
        mx: [h]
      }],
      /**
       * Margin Y
       * @see https://tailwindcss.com/docs/margin
       */
      my: [{
        my: [h]
      }],
      /**
       * Margin Start
       * @see https://tailwindcss.com/docs/margin
       */
      ms: [{
        ms: [h]
      }],
      /**
       * Margin End
       * @see https://tailwindcss.com/docs/margin
       */
      me: [{
        me: [h]
      }],
      /**
       * Margin Top
       * @see https://tailwindcss.com/docs/margin
       */
      mt: [{
        mt: [h]
      }],
      /**
       * Margin Right
       * @see https://tailwindcss.com/docs/margin
       */
      mr: [{
        mr: [h]
      }],
      /**
       * Margin Bottom
       * @see https://tailwindcss.com/docs/margin
       */
      mb: [{
        mb: [h]
      }],
      /**
       * Margin Left
       * @see https://tailwindcss.com/docs/margin
       */
      ml: [{
        ml: [h]
      }],
      /**
       * Space Between X
       * @see https://tailwindcss.com/docs/space
       */
      "space-x": [{
        "space-x": [E]
      }],
      /**
       * Space Between X Reverse
       * @see https://tailwindcss.com/docs/space
       */
      "space-x-reverse": ["space-x-reverse"],
      /**
       * Space Between Y
       * @see https://tailwindcss.com/docs/space
       */
      "space-y": [{
        "space-y": [E]
      }],
      /**
       * Space Between Y Reverse
       * @see https://tailwindcss.com/docs/space
       */
      "space-y-reverse": ["space-y-reverse"],
      // Sizing
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: ["auto", "min", "max", "fit", "svw", "lvw", "dvw", k, t]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [k, t, "min", "max", "fit"]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [k, t, "none", "full", "min", "max", "fit", "prose", {
          screen: [Ee]
        }, Ee]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: [k, t, "auto", "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": [k, t, "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": [k, t, "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Size
       * @see https://tailwindcss.com/docs/size
       */
      size: [{
        size: [k, t, "auto", "min", "max", "fit"]
      }],
      // Typography
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", Ee, Re]
      }],
      /**
       * Font Smoothing
       * @see https://tailwindcss.com/docs/font-smoothing
       */
      "font-smoothing": ["antialiased", "subpixel-antialiased"],
      /**
       * Font Style
       * @see https://tailwindcss.com/docs/font-style
       */
      "font-style": ["italic", "not-italic"],
      /**
       * Font Weight
       * @see https://tailwindcss.com/docs/font-weight
       */
      "font-weight": [{
        font: ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black", sn]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [st]
      }],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-normal": ["normal-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-ordinal": ["ordinal"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-slashed-zero": ["slashed-zero"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-figure": ["lining-nums", "oldstyle-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-spacing": ["proportional-nums", "tabular-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-fraction": ["diagonal-fractions", "stacked-fractions"],
      /**
       * Letter Spacing
       * @see https://tailwindcss.com/docs/letter-spacing
       */
      tracking: [{
        tracking: ["tighter", "tight", "normal", "wide", "wider", "widest", k]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": ["none", Ge, sn]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: ["none", "tight", "snug", "normal", "relaxed", "loose", we, k]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", k]
      }],
      /**
       * List Style Type
       * @see https://tailwindcss.com/docs/list-style-type
       */
      "list-style-type": [{
        list: ["none", "disc", "decimal", k]
      }],
      /**
       * List Style Position
       * @see https://tailwindcss.com/docs/list-style-position
       */
      "list-style-position": [{
        list: ["inside", "outside"]
      }],
      /**
       * Placeholder Color
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/placeholder-color
       */
      "placeholder-color": [{
        placeholder: [e]
      }],
      /**
       * Placeholder Opacity
       * @see https://tailwindcss.com/docs/placeholder-opacity
       */
      "placeholder-opacity": [{
        "placeholder-opacity": [b]
      }],
      /**
       * Text Alignment
       * @see https://tailwindcss.com/docs/text-align
       */
      "text-alignment": [{
        text: ["left", "center", "right", "justify", "start", "end"]
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: [e]
      }],
      /**
       * Text Opacity
       * @see https://tailwindcss.com/docs/text-opacity
       */
      "text-opacity": [{
        "text-opacity": [b]
      }],
      /**
       * Text Decoration
       * @see https://tailwindcss.com/docs/text-decoration
       */
      "text-decoration": ["underline", "overline", "line-through", "no-underline"],
      /**
       * Text Decoration Style
       * @see https://tailwindcss.com/docs/text-decoration-style
       */
      "text-decoration-style": [{
        decoration: [...I(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: ["auto", "from-font", we, Re]
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": ["auto", we, k]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: [e]
      }],
      /**
       * Text Transform
       * @see https://tailwindcss.com/docs/text-transform
       */
      "text-transform": ["uppercase", "lowercase", "capitalize", "normal-case"],
      /**
       * Text Overflow
       * @see https://tailwindcss.com/docs/text-overflow
       */
      "text-overflow": ["truncate", "text-ellipsis", "text-clip"],
      /**
       * Text Wrap
       * @see https://tailwindcss.com/docs/text-wrap
       */
      "text-wrap": [{
        text: ["wrap", "nowrap", "balance", "pretty"]
      }],
      /**
       * Text Indent
       * @see https://tailwindcss.com/docs/text-indent
       */
      indent: [{
        indent: N()
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", k]
      }],
      /**
       * Whitespace
       * @see https://tailwindcss.com/docs/whitespace
       */
      whitespace: [{
        whitespace: ["normal", "nowrap", "pre", "pre-line", "pre-wrap", "break-spaces"]
      }],
      /**
       * Word Break
       * @see https://tailwindcss.com/docs/word-break
       */
      break: [{
        break: ["normal", "words", "all", "keep"]
      }],
      /**
       * Hyphens
       * @see https://tailwindcss.com/docs/hyphens
       */
      hyphens: [{
        hyphens: ["none", "manual", "auto"]
      }],
      /**
       * Content
       * @see https://tailwindcss.com/docs/content
       */
      content: [{
        content: ["none", k]
      }],
      // Backgrounds
      /**
       * Background Attachment
       * @see https://tailwindcss.com/docs/background-attachment
       */
      "bg-attachment": [{
        bg: ["fixed", "local", "scroll"]
      }],
      /**
       * Background Clip
       * @see https://tailwindcss.com/docs/background-clip
       */
      "bg-clip": [{
        "bg-clip": ["border", "padding", "content", "text"]
      }],
      /**
       * Background Opacity
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/background-opacity
       */
      "bg-opacity": [{
        "bg-opacity": [b]
      }],
      /**
       * Background Origin
       * @see https://tailwindcss.com/docs/background-origin
       */
      "bg-origin": [{
        "bg-origin": ["border", "padding", "content"]
      }],
      /**
       * Background Position
       * @see https://tailwindcss.com/docs/background-position
       */
      "bg-position": [{
        bg: [...z(), pa]
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: ["no-repeat", {
          repeat: ["", "x", "y", "round", "space"]
        }]
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: ["auto", "cover", "contain", fa]
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          "gradient-to": ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
        }, ga]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: [e]
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: [y]
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: [y]
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: [y]
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: [v]
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: [v]
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: [v]
      }],
      // Borders
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: [s]
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": [s]
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": [s]
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": [s]
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": [s]
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": [s]
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": [s]
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": [s]
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": [s]
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": [s]
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": [s]
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": [s]
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": [s]
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": [s]
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": [s]
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: [a]
      }],
      /**
       * Border Width X
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": [a]
      }],
      /**
       * Border Width Y
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": [a]
      }],
      /**
       * Border Width Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": [a]
      }],
      /**
       * Border Width End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": [a]
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": [a]
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": [a]
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": [a]
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": [a]
      }],
      /**
       * Border Opacity
       * @see https://tailwindcss.com/docs/border-opacity
       */
      "border-opacity": [{
        "border-opacity": [b]
      }],
      /**
       * Border Style
       * @see https://tailwindcss.com/docs/border-style
       */
      "border-style": [{
        border: [...I(), "hidden"]
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-x": [{
        "divide-x": [a]
      }],
      /**
       * Divide Width X Reverse
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-x-reverse": ["divide-x-reverse"],
      /**
       * Divide Width Y
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-y": [{
        "divide-y": [a]
      }],
      /**
       * Divide Width Y Reverse
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-y-reverse": ["divide-y-reverse"],
      /**
       * Divide Opacity
       * @see https://tailwindcss.com/docs/divide-opacity
       */
      "divide-opacity": [{
        "divide-opacity": [b]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/divide-style
       */
      "divide-style": [{
        divide: I()
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: [o]
      }],
      /**
       * Border Color X
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": [o]
      }],
      /**
       * Border Color Y
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": [o]
      }],
      /**
       * Border Color S
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": [o]
      }],
      /**
       * Border Color E
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": [o]
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": [o]
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": [o]
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": [o]
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": [o]
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: [o]
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: ["", ...I()]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [we, k]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: [we, Re]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: [e]
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/ring-width
       */
      "ring-w": [{
        ring: $()
      }],
      /**
       * Ring Width Inset
       * @see https://tailwindcss.com/docs/ring-width
       */
      "ring-w-inset": ["ring-inset"],
      /**
       * Ring Color
       * @see https://tailwindcss.com/docs/ring-color
       */
      "ring-color": [{
        ring: [e]
      }],
      /**
       * Ring Opacity
       * @see https://tailwindcss.com/docs/ring-opacity
       */
      "ring-opacity": [{
        "ring-opacity": [b]
      }],
      /**
       * Ring Offset Width
       * @see https://tailwindcss.com/docs/ring-offset-width
       */
      "ring-offset-w": [{
        "ring-offset": [we, Re]
      }],
      /**
       * Ring Offset Color
       * @see https://tailwindcss.com/docs/ring-offset-color
       */
      "ring-offset-color": [{
        "ring-offset": [e]
      }],
      // Effects
      /**
       * Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow
       */
      shadow: [{
        shadow: ["", "inner", "none", Ee, va]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow-color
       */
      "shadow-color": [{
        shadow: [st]
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [b]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...W(), "plus-lighter", "plus-darker"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": W()
      }],
      // Filters
      /**
       * Filter
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/filter
       */
      filter: [{
        filter: ["", "none"]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: [n]
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [r]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [l]
      }],
      /**
       * Drop Shadow
       * @see https://tailwindcss.com/docs/drop-shadow
       */
      "drop-shadow": [{
        "drop-shadow": ["", "none", Ee, k]
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: [f]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [u]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: [d]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [w]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: [S]
      }],
      /**
       * Backdrop Filter
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/backdrop-filter
       */
      "backdrop-filter": [{
        "backdrop-filter": ["", "none"]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": [n]
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [r]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [l]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": [f]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [u]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": [d]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [b]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [w]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": [S]
      }],
      // Tables
      /**
       * Border Collapse
       * @see https://tailwindcss.com/docs/border-collapse
       */
      "border-collapse": [{
        border: ["collapse", "separate"]
      }],
      /**
       * Border Spacing
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing": [{
        "border-spacing": [i]
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": [i]
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": [i]
      }],
      /**
       * Table Layout
       * @see https://tailwindcss.com/docs/table-layout
       */
      "table-layout": [{
        table: ["auto", "fixed"]
      }],
      /**
       * Caption Side
       * @see https://tailwindcss.com/docs/caption-side
       */
      caption: [{
        caption: ["top", "bottom"]
      }],
      // Transitions and Animation
      /**
       * Tranisition Property
       * @see https://tailwindcss.com/docs/transition-property
       */
      transition: [{
        transition: ["none", "all", "", "colors", "opacity", "shadow", "transform", k]
      }],
      /**
       * Transition Duration
       * @see https://tailwindcss.com/docs/transition-duration
       */
      duration: [{
        duration: q()
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "in", "out", "in-out", k]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: q()
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", "spin", "ping", "pulse", "bounce", k]
      }],
      // Transforms
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: ["", "gpu", "none"]
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: [C]
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": [C]
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": [C]
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: [ot, k]
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": [T]
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": [T]
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": [R]
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": [R]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: ["center", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left", "top-left", k]
      }],
      // Interactivity
      /**
       * Accent Color
       * @see https://tailwindcss.com/docs/accent-color
       */
      accent: [{
        accent: ["auto", e]
      }],
      /**
       * Appearance
       * @see https://tailwindcss.com/docs/appearance
       */
      appearance: [{
        appearance: ["none", "auto"]
      }],
      /**
       * Cursor
       * @see https://tailwindcss.com/docs/cursor
       */
      cursor: [{
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", k]
      }],
      /**
       * Caret Color
       * @see https://tailwindcss.com/docs/just-in-time-mode#caret-color-utilities
       */
      "caret-color": [{
        caret: [e]
      }],
      /**
       * Pointer Events
       * @see https://tailwindcss.com/docs/pointer-events
       */
      "pointer-events": [{
        "pointer-events": ["none", "auto"]
      }],
      /**
       * Resize
       * @see https://tailwindcss.com/docs/resize
       */
      resize: [{
        resize: ["none", "y", "x", ""]
      }],
      /**
       * Scroll Behavior
       * @see https://tailwindcss.com/docs/scroll-behavior
       */
      "scroll-behavior": [{
        scroll: ["auto", "smooth"]
      }],
      /**
       * Scroll Margin
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-m": [{
        "scroll-m": N()
      }],
      /**
       * Scroll Margin X
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": N()
      }],
      /**
       * Scroll Margin Y
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": N()
      }],
      /**
       * Scroll Margin Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": N()
      }],
      /**
       * Scroll Margin End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": N()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": N()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": N()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": N()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": N()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": N()
      }],
      /**
       * Scroll Padding X
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": N()
      }],
      /**
       * Scroll Padding Y
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": N()
      }],
      /**
       * Scroll Padding Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": N()
      }],
      /**
       * Scroll Padding End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": N()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": N()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": N()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": N()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": N()
      }],
      /**
       * Scroll Snap Align
       * @see https://tailwindcss.com/docs/scroll-snap-align
       */
      "snap-align": [{
        snap: ["start", "end", "center", "align-none"]
      }],
      /**
       * Scroll Snap Stop
       * @see https://tailwindcss.com/docs/scroll-snap-stop
       */
      "snap-stop": [{
        snap: ["normal", "always"]
      }],
      /**
       * Scroll Snap Type
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-type": [{
        snap: ["none", "x", "y", "both"]
      }],
      /**
       * Scroll Snap Type Strictness
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-strictness": [{
        snap: ["mandatory", "proximity"]
      }],
      /**
       * Touch Action
       * @see https://tailwindcss.com/docs/touch-action
       */
      touch: [{
        touch: ["auto", "none", "manipulation"]
      }],
      /**
       * Touch Action X
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-x": [{
        "touch-pan": ["x", "left", "right"]
      }],
      /**
       * Touch Action Y
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-y": [{
        "touch-pan": ["y", "up", "down"]
      }],
      /**
       * Touch Action Pinch Zoom
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-pz": ["touch-pinch-zoom"],
      /**
       * User Select
       * @see https://tailwindcss.com/docs/user-select
       */
      select: [{
        select: ["none", "text", "all", "auto"]
      }],
      /**
       * Will Change
       * @see https://tailwindcss.com/docs/will-change
       */
      "will-change": [{
        "will-change": ["auto", "scroll", "contents", "transform", k]
      }],
      // SVG
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: [e, "none"]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [we, Re, sn]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: [e, "none"]
      }],
      // Accessibility
      /**
       * Screen Readers
       * @see https://tailwindcss.com/docs/screen-readers
       */
      sr: ["sr-only", "not-sr-only"],
      /**
       * Forced Color Adjust
       * @see https://tailwindcss.com/docs/forced-color-adjust
       */
      "forced-color-adjust": [{
        "forced-color-adjust": ["auto", "none"]
      }]
    },
    conflictingClassGroups: {
      overflow: ["overflow-x", "overflow-y"],
      overscroll: ["overscroll-x", "overscroll-y"],
      inset: ["inset-x", "inset-y", "start", "end", "top", "right", "bottom", "left"],
      "inset-x": ["right", "left"],
      "inset-y": ["top", "bottom"],
      flex: ["basis", "grow", "shrink"],
      gap: ["gap-x", "gap-y"],
      p: ["px", "py", "ps", "pe", "pt", "pr", "pb", "pl"],
      px: ["pr", "pl"],
      py: ["pt", "pb"],
      m: ["mx", "my", "ms", "me", "mt", "mr", "mb", "ml"],
      mx: ["mr", "ml"],
      my: ["mt", "mb"],
      size: ["w", "h"],
      "font-size": ["leading"],
      "fvn-normal": ["fvn-ordinal", "fvn-slashed-zero", "fvn-figure", "fvn-spacing", "fvn-fraction"],
      "fvn-ordinal": ["fvn-normal"],
      "fvn-slashed-zero": ["fvn-normal"],
      "fvn-figure": ["fvn-normal"],
      "fvn-spacing": ["fvn-normal"],
      "fvn-fraction": ["fvn-normal"],
      "line-clamp": ["display", "overflow"],
      rounded: ["rounded-s", "rounded-e", "rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-ss", "rounded-se", "rounded-ee", "rounded-es", "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"],
      "rounded-s": ["rounded-ss", "rounded-es"],
      "rounded-e": ["rounded-se", "rounded-ee"],
      "rounded-t": ["rounded-tl", "rounded-tr"],
      "rounded-r": ["rounded-tr", "rounded-br"],
      "rounded-b": ["rounded-br", "rounded-bl"],
      "rounded-l": ["rounded-tl", "rounded-bl"],
      "border-spacing": ["border-spacing-x", "border-spacing-y"],
      "border-w": ["border-w-s", "border-w-e", "border-w-t", "border-w-r", "border-w-b", "border-w-l"],
      "border-w-x": ["border-w-r", "border-w-l"],
      "border-w-y": ["border-w-t", "border-w-b"],
      "border-color": ["border-color-s", "border-color-e", "border-color-t", "border-color-r", "border-color-b", "border-color-l"],
      "border-color-x": ["border-color-r", "border-color-l"],
      "border-color-y": ["border-color-t", "border-color-b"],
      "scroll-m": ["scroll-mx", "scroll-my", "scroll-ms", "scroll-me", "scroll-mt", "scroll-mr", "scroll-mb", "scroll-ml"],
      "scroll-mx": ["scroll-mr", "scroll-ml"],
      "scroll-my": ["scroll-mt", "scroll-mb"],
      "scroll-p": ["scroll-px", "scroll-py", "scroll-ps", "scroll-pe", "scroll-pt", "scroll-pr", "scroll-pb", "scroll-pl"],
      "scroll-px": ["scroll-pr", "scroll-pl"],
      "scroll-py": ["scroll-pt", "scroll-pb"],
      touch: ["touch-x", "touch-y", "touch-pz"],
      "touch-x": ["touch"],
      "touch-y": ["touch"],
      "touch-pz": ["touch"]
    },
    conflictingClassGroupModifiers: {
      "font-size": ["leading"]
    }
  };
}, xa = /* @__PURE__ */ na(wa);
function _(...e) {
  return xa(ro(e));
}
const Ca = _n(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
), Sa = c.forwardRef(
  ({ className: e, variant: t, size: n, asChild: r = !1, ...o }, s) => /* @__PURE__ */ g(
    r ? Di : "button",
    {
      className: _(Ca({ variant: t, size: n, className: e })),
      ref: s,
      ...o
    }
  )
);
Sa.displayName = "Button";
const Ra = _n(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        // Status family - the StatusPill / PriorityFlag pattern (the fleet's
        // #1 usage). All fills are WCAG-AA verified in src/styles/theme.css.
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        info: "border-transparent bg-info text-info-foreground",
        // Runtime-tinted family - the color is supplied at render time via the
        // `tone` prop (see Badge below), not baked into a token. The class only
        // clears the default border so the inline color/tint stands alone. This
        // is the ~151-hex `hexA(color, ~0.14)` pattern the fleet's status/track/
        // fit vocabularies drive, which a fixed solid variant cannot express.
        tone: "border-transparent"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);
function Lf({ className: e, variant: t, tone: n, style: r, ...o }) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _(Ra({ variant: n ? "tone" : t }), e),
      style: n ? {
        color: n,
        background: "color-mix(in srgb, currentColor 14%, transparent)",
        ...r
      } : r,
      ...o
    }
  );
}
const Ea = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  "div",
  {
    ref: n,
    className: _(
      "rounded-lg border bg-card text-card-foreground shadow-sm",
      e
    ),
    ...t
  }
));
Ea.displayName = "Card";
const Pa = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  "div",
  {
    ref: n,
    className: _("flex flex-col space-y-1.5 p-6", e),
    ...t
  }
));
Pa.displayName = "CardHeader";
const Na = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  "div",
  {
    ref: n,
    className: _(
      "text-lg font-semibold leading-none tracking-tight",
      e
    ),
    ...t
  }
));
Na.displayName = "CardTitle";
const Ta = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  "div",
  {
    ref: n,
    className: _("text-sm text-muted-foreground", e),
    ...t
  }
));
Ta.displayName = "CardDescription";
const Aa = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g("div", { ref: n, className: _("p-6 pt-0", e), ...t }));
Aa.displayName = "CardContent";
const Oa = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  "div",
  {
    ref: n,
    className: _("flex items-center p-6 pt-0", e),
    ...t
  }
));
Oa.displayName = "CardFooter";
const Ia = c.forwardRef(({ className: e, type: t, ...n }, r) => /* @__PURE__ */ g(
  "input",
  {
    type: t,
    className: _(
      "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      e
    ),
    ref: r,
    ...n
  }
));
Ia.displayName = "Input";
const _a = c.forwardRef(
  ({ className: e, autoResize: t, rows: n = 3, onInput: r, value: o, defaultValue: s, ...i }, a) => {
    const l = c.useRef(null), f = c.useCallback(
      (d) => {
        l.current = d, typeof a == "function" ? a(d) : a && (a.current = d);
      },
      [a]
    ), u = c.useCallback(() => {
      const d = l.current;
      !d || !t || (d.style.height = "auto", d.style.height = `${d.scrollHeight}px`);
    }, [t]);
    return c.useLayoutEffect(() => {
      u();
    }, [u, o, s]), /* @__PURE__ */ g(
      "textarea",
      {
        ref: f,
        rows: n,
        value: o,
        defaultValue: s,
        onInput: (d) => {
          u(), r == null || r(d);
        },
        className: _(
          "flex min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          t ? "resize-none overflow-hidden" : "resize-y",
          e
        ),
        ...i
      }
    );
  }
);
_a.displayName = "Textarea";
var Ma = [
  "a",
  "button",
  "div",
  "form",
  "h2",
  "h3",
  "img",
  "input",
  "label",
  "li",
  "nav",
  "ol",
  "p",
  "select",
  "span",
  "svg",
  "ul"
], M = Ma.reduce((e, t) => {
  const n = /* @__PURE__ */ ke(`Primitive.${t}`), r = c.forwardRef((o, s) => {
    const { asChild: i, ...a } = o, l = i ? n : t;
    return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ g(l, { ...a, ref: s });
  });
  return r.displayName = `Primitive.${t}`, { ...e, [t]: r };
}, {});
function Da(e, t) {
  e && ut.flushSync(() => e.dispatchEvent(t));
}
var ka = "Label", lo = c.forwardRef((e, t) => /* @__PURE__ */ g(
  M.label,
  {
    ...e,
    ref: t,
    onMouseDown: (n) => {
      var o;
      n.target.closest("button, input, select, textarea") || ((o = e.onMouseDown) == null || o.call(e, n), !n.defaultPrevented && n.detail > 1 && n.preventDefault());
    }
  }
));
lo.displayName = ka;
var uo = lo;
const fo = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  uo,
  {
    ref: n,
    className: _(
      "text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      e
    ),
    ...t
  }
));
fo.displayName = uo.displayName;
const La = c.forwardRef(
  ({ className: e, label: t, htmlFor: n, description: r, error: o, required: s, children: i, ...a }, l) => {
    const f = c.useId(), u = n ?? f, d = r ? `${u}-description` : void 0, m = o ? `${u}-error` : void 0, v = [d, m].filter(Boolean).join(" ") || void 0, y = c.isValidElement(i) ? c.cloneElement(i, {
      id: i.props.id ?? u,
      "aria-describedby": [i.props["aria-describedby"], v].filter(Boolean).join(" ") || void 0,
      "aria-invalid": o ? !0 : i.props["aria-invalid"]
    }) : i;
    return /* @__PURE__ */ J("div", { ref: l, className: _("space-y-2", e), ...a, children: [
      t ? /* @__PURE__ */ J(fo, { htmlFor: u, children: [
        t,
        s ? /* @__PURE__ */ J("span", { className: "text-destructive", "aria-hidden": "true", children: [
          " ",
          "*"
        ] }) : null
      ] }) : null,
      y,
      r && !o ? /* @__PURE__ */ g("p", { id: d, className: "text-sm text-muted-foreground", children: r }) : null,
      o ? /* @__PURE__ */ g("p", { id: m, className: "text-sm font-medium text-destructive", children: o }) : null
    ] });
  }
);
La.displayName = "Field";
var Fa = "Separator", Er = "horizontal", $a = ["horizontal", "vertical"], po = c.forwardRef((e, t) => {
  const { decorative: n, orientation: r = Er, ...o } = e, s = Va(r) ? r : Er, a = n ? { role: "none" } : { "aria-orientation": s === "vertical" ? s : void 0, role: "separator" };
  return /* @__PURE__ */ g(
    M.div,
    {
      "data-orientation": s,
      ...a,
      ...o,
      ref: t
    }
  );
});
po.displayName = Fa;
function Va(e) {
  return $a.includes(e);
}
var mo = po;
const Ba = c.forwardRef(
  ({ className: e, orientation: t = "horizontal", decorative: n = !0, ...r }, o) => /* @__PURE__ */ g(
    mo,
    {
      ref: o,
      decorative: n,
      orientation: t,
      className: _(
        "shrink-0 bg-border",
        t === "horizontal" ? "h-px w-full" : "h-full w-px",
        e
      ),
      ...r
    }
  )
);
Ba.displayName = mo.displayName;
function Ff({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _("animate-pulse rounded-md bg-muted", e),
      ...t
    }
  );
}
function O(e, t, { checkForDefaultPrevented: n = !0 } = {}) {
  return function(o) {
    if (e == null || e(o), n === !1 || !o || !o.defaultPrevented)
      return t == null ? void 0 : t(o);
  };
}
function he(e, t = []) {
  let n = [];
  function r(s, i) {
    const a = c.createContext(i);
    a.displayName = s + "Context";
    const l = n.length;
    n = [...n, i];
    const f = (d) => {
      var b;
      const { scope: m, children: v, ...y } = d, p = ((b = m == null ? void 0 : m[e]) == null ? void 0 : b[l]) || a, h = c.useMemo(() => y, Object.values(y));
      return /* @__PURE__ */ g(p.Provider, { value: h, children: v });
    };
    f.displayName = s + "Provider";
    function u(d, m, v = {}) {
      var b;
      const { optional: y = !1 } = v, p = ((b = m == null ? void 0 : m[e]) == null ? void 0 : b[l]) || a, h = c.useContext(p);
      if (h) return h;
      if (i !== void 0) return i;
      if (!y)
        throw new Error(`\`${d}\` must be used within \`${s}\``);
    }
    return [f, u];
  }
  const o = () => {
    const s = n.map((i) => c.createContext(i));
    return function(a) {
      const l = (a == null ? void 0 : a[e]) || s;
      return c.useMemo(
        () => ({ [`__scope${e}`]: { ...a, [e]: l } }),
        [a, l]
      );
    };
  };
  return o.scopeName = e, [r, Wa(o, ...t)];
}
function Wa(...e) {
  const t = e[0];
  if (e.length === 1) return t;
  const n = () => {
    const r = e.map((o) => ({
      useScope: o(),
      scopeName: o.scopeName
    }));
    return function(s) {
      const i = r.reduce((a, { useScope: l, scopeName: f }) => {
        const d = l(s)[`__scope${f}`];
        return { ...a, ...d };
      }, {});
      return c.useMemo(() => ({ [`__scope${t.scopeName}`]: i }), [i]);
    };
  };
  return n.scopeName = t.scopeName, n;
}
var Z = globalThis != null && globalThis.document ? c.useLayoutEffect : () => {
}, Ha = c[" useId ".trim().toString()] || (() => {
}), za = 0;
function ge(e) {
  const [t, n] = c.useState(Ha());
  return Z(() => {
    n((r) => r ?? String(za++));
  }, [e]), e || (t ? `radix-${t}` : "");
}
var Ua = c[" useInsertionEffect ".trim().toString()] || Z;
function Le({
  prop: e,
  defaultProp: t,
  onChange: n = () => {
  },
  caller: r
}) {
  const [o, s, i] = Ga({
    defaultProp: t,
    onChange: n
  }), a = e !== void 0, l = a ? e : o;
  {
    const u = c.useRef(e !== void 0);
    c.useEffect(() => {
      const d = u.current;
      d !== a && console.warn(
        `${r} is changing from ${d ? "controlled" : "uncontrolled"} to ${a ? "controlled" : "uncontrolled"}. Components should not switch from controlled to uncontrolled (or vice versa). Decide between using a controlled or uncontrolled value for the lifetime of the component.`
      ), u.current = a;
    }, [a, r]);
  }
  const f = c.useCallback(
    (u) => {
      var d;
      if (a) {
        const m = ja(u) ? u(e) : u;
        m !== e && ((d = i.current) == null || d.call(i, m));
      } else
        s(u);
    },
    [a, e, s, i]
  );
  return [l, f];
}
function Ga({
  defaultProp: e,
  onChange: t
}) {
  const [n, r] = c.useState(e), o = c.useRef(n), s = c.useRef(t);
  return Ua(() => {
    s.current = t;
  }, [t]), c.useEffect(() => {
    var i;
    o.current !== n && ((i = s.current) == null || i.call(s, n), o.current = n);
  }, [n, o]), [n, r, s];
}
function ja(e) {
  return typeof e == "function";
}
function ae(e) {
  const t = c.useRef(e);
  return c.useEffect(() => {
    t.current = e;
  }), c.useMemo(() => ((...n) => {
    var r;
    return (r = t.current) == null ? void 0 : r.call(t, ...n);
  }), []);
}
var Ka = "DismissableLayer", wn = "dismissableLayer.update", Ya = "dismissableLayer.pointerDownOutside", Xa = "dismissableLayer.focusOutside", Pr, Dn = c.createContext({
  layers: /* @__PURE__ */ new Set(),
  layersWithOutsidePointerEventsDisabled: /* @__PURE__ */ new Set(),
  branches: /* @__PURE__ */ new Set(),
  // Outside elements that belong to a layer's own dismiss affordance (eg, a
  // dialog overlay). Pressing them should dismiss the layer regardless of
  // whether or not they stop propagation.
  //
  // See https://github.com/radix-ui/primitives/issues/3346
  dismissableSurfaces: /* @__PURE__ */ new Set()
}), dt = c.forwardRef(
  (e, t) => {
    const {
      disableOutsidePointerEvents: n = !1,
      deferPointerDownOutside: r = !1,
      onEscapeKeyDown: o,
      onPointerDownOutside: s,
      onFocusOutside: i,
      onInteractOutside: a,
      onDismiss: l,
      ...f
    } = e, u = c.useContext(Dn), [d, m] = c.useState(null), v = (d == null ? void 0 : d.ownerDocument) ?? (globalThis == null ? void 0 : globalThis.document), [, y] = c.useState({}), p = j(t, m), h = Array.from(u.layers), [b] = [
      ...u.layersWithOutsidePointerEventsDisabled
    ].slice(-1), x = b ? h.indexOf(b) : -1, w = d ? h.indexOf(d) : -1, C = u.layersWithOutsidePointerEventsDisabled.size > 0, S = w >= x, R = c.useRef(!1), E = ec(
      (P) => {
        s == null || s(P), a == null || a(P), P.defaultPrevented || l == null || l();
      },
      {
        ownerDocument: v,
        deferPointerDownOutside: r,
        isDeferredPointerDownOutsideRef: R,
        dismissableSurfaces: u.dismissableSurfaces,
        shouldHandlePointerDownOutside: c.useCallback(
          (P) => {
            if (!(P instanceof Node))
              return !1;
            const N = [...u.branches].some(
              ($) => $.contains(P)
            );
            return S && !N;
          },
          [u.branches, S]
        )
      }
    ), T = tc((P) => {
      if (r && R.current)
        return;
      const N = P.target;
      [...u.branches].some((F) => F.contains(N)) || (i == null || i(P), a == null || a(P), P.defaultPrevented || l == null || l());
    }, v), V = d ? w === h.length - 1 : !1, L = ae((P) => {
      P.key === "Escape" && (o == null || o(P), !P.defaultPrevented && l && (P.preventDefault(), l()));
    });
    return c.useEffect(() => {
      if (V)
        return v.addEventListener("keydown", L, { capture: !0 }), () => v.removeEventListener("keydown", L, { capture: !0 });
    }, [v, V, L]), c.useEffect(() => {
      if (d)
        return n && (u.layersWithOutsidePointerEventsDisabled.size === 0 && (Pr = v.body.style.pointerEvents, v.body.style.pointerEvents = "none"), u.layersWithOutsidePointerEventsDisabled.add(d)), u.layers.add(d), Nr(), () => {
          n && (u.layersWithOutsidePointerEventsDisabled.delete(d), u.layersWithOutsidePointerEventsDisabled.size === 0 && (v.body.style.pointerEvents = Pr));
        };
    }, [d, v, n, u]), c.useEffect(() => () => {
      d && (u.layers.delete(d), u.layersWithOutsidePointerEventsDisabled.delete(d), Nr());
    }, [d, u]), c.useEffect(() => {
      const P = () => y({});
      return document.addEventListener(wn, P), () => document.removeEventListener(wn, P);
    }, []), /* @__PURE__ */ g(
      M.div,
      {
        ...f,
        ref: p,
        style: {
          pointerEvents: C ? S ? "auto" : "none" : void 0,
          ...e.style
        },
        onFocusCapture: O(e.onFocusCapture, T.onFocusCapture),
        onBlurCapture: O(e.onBlurCapture, T.onBlurCapture),
        onPointerDownCapture: O(
          e.onPointerDownCapture,
          E.onPointerDownCapture
        )
      }
    );
  }
);
dt.displayName = Ka;
var qa = "DismissableLayerBranch", Za = c.forwardRef((e, t) => {
  const n = c.useContext(Dn), r = c.useRef(null), o = j(t, r);
  return c.useEffect(() => {
    const s = r.current;
    if (s)
      return n.branches.add(s), () => {
        n.branches.delete(s);
      };
  }, [n.branches]), /* @__PURE__ */ g(M.div, { ...e, ref: o });
});
Za.displayName = qa;
function Qa() {
  const e = c.useContext(Dn), [t, n] = c.useState(null);
  return c.useEffect(() => {
    if (t)
      return e.dismissableSurfaces.add(t), () => {
        e.dismissableSurfaces.delete(t);
      };
  }, [t, e.dismissableSurfaces]), n;
}
var Ja = () => !0;
function ec(e, t) {
  const {
    ownerDocument: n = globalThis == null ? void 0 : globalThis.document,
    deferPointerDownOutside: r = !1,
    isDeferredPointerDownOutsideRef: o,
    dismissableSurfaces: s,
    shouldHandlePointerDownOutside: i = Ja
  } = t, a = ae(e), l = c.useRef(!1), f = c.useRef(!1), u = c.useRef(/* @__PURE__ */ new Map()), d = c.useRef(() => {
  });
  return c.useEffect(() => {
    function m() {
      f.current = !1, o.current = !1, u.current.clear();
    }
    function v() {
      return Array.from(u.current.values()).some(Boolean);
    }
    function y(w) {
      if (!f.current)
        return;
      const C = w.target;
      C instanceof Node && [...s].some((R) => R.contains(C)) || u.current.set(w.type, !0), w.type === "click" && window.setTimeout(() => {
        f.current && d.current();
      }, 0);
    }
    function p(w) {
      f.current && u.current.set(w.type, !1);
    }
    const h = (w) => {
      if (w.target && !l.current) {
        let C = function() {
          n.removeEventListener("click", d.current);
          const R = v();
          m(), R || go(
            Ya,
            a,
            S,
            { discrete: !0 }
          );
        };
        if (!i(w.target)) {
          n.removeEventListener("click", d.current), m(), l.current = !1;
          return;
        }
        const S = { originalEvent: w };
        f.current = !0, o.current = r && w.button === 0, u.current.clear(), !r || w.button !== 0 ? C() : (n.removeEventListener("click", d.current), d.current = C, n.addEventListener("click", d.current, { once: !0 }));
      } else
        n.removeEventListener("click", d.current), m();
      l.current = !1;
    }, b = [
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click"
    ];
    for (const w of b)
      n.addEventListener(w, y, !0), n.addEventListener(w, p);
    const x = window.setTimeout(() => {
      n.addEventListener("pointerdown", h);
    }, 0);
    return () => {
      window.clearTimeout(x), n.removeEventListener("pointerdown", h), n.removeEventListener("click", d.current);
      for (const w of b)
        n.removeEventListener(w, y, !0), n.removeEventListener(w, p);
    };
  }, [
    n,
    a,
    r,
    o,
    s,
    i
  ]), {
    // ensures we check React component tree (not just DOM tree)
    onPointerDownCapture: () => l.current = !0
  };
}
function tc(e, t = globalThis == null ? void 0 : globalThis.document) {
  const n = ae(e), r = c.useRef(!1);
  return c.useEffect(() => {
    const o = (s) => {
      s.target && !r.current && go(Xa, n, { originalEvent: s }, {
        discrete: !1
      });
    };
    return t.addEventListener("focusin", o), () => t.removeEventListener("focusin", o);
  }, [t, n]), {
    onFocusCapture: () => r.current = !0,
    onBlurCapture: () => r.current = !1
  };
}
function Nr() {
  const e = new CustomEvent(wn);
  document.dispatchEvent(e);
}
function go(e, t, n, { discrete: r }) {
  const o = n.originalEvent.target, s = new CustomEvent(e, { bubbles: !1, cancelable: !0, detail: n });
  t && o.addEventListener(e, t, { once: !0 }), r ? Da(o, s) : o.dispatchEvent(s);
}
var an = "focusScope.autoFocusOnMount", cn = "focusScope.autoFocusOnUnmount", Tr = { bubbles: !1, cancelable: !0 }, nc = "FocusScope", Wt = c.forwardRef((e, t) => {
  const {
    loop: n = !1,
    trapped: r = !1,
    onMountAutoFocus: o,
    onUnmountAutoFocus: s,
    ...i
  } = e, [a, l] = c.useState(null), f = ae(o), u = ae(s), d = c.useRef(null), m = j(t, l), v = c.useRef({
    paused: !1,
    pause() {
      this.paused = !0;
    },
    resume() {
      this.paused = !1;
    }
  }).current;
  c.useEffect(() => {
    if (r) {
      let p = function(w) {
        if (v.paused || !a) return;
        const C = w.target;
        a.contains(C) ? d.current = C : Pe(d.current, { select: !0 });
      }, h = function(w) {
        if (v.paused || !a) return;
        const C = w.relatedTarget;
        C !== null && (a.contains(C) || Pe(d.current, { select: !0 }));
      }, b = function(w) {
        if (document.activeElement === document.body)
          for (const S of w)
            S.removedNodes.length > 0 && Pe(a);
      };
      document.addEventListener("focusin", p), document.addEventListener("focusout", h);
      const x = new MutationObserver(b);
      return a && x.observe(a, { childList: !0, subtree: !0 }), () => {
        document.removeEventListener("focusin", p), document.removeEventListener("focusout", h), x.disconnect();
      };
    }
  }, [r, a, v.paused]), c.useEffect(() => {
    if (a) {
      Or.add(v);
      const p = document.activeElement;
      if (!a.contains(p)) {
        const b = new CustomEvent(an, Tr);
        a.addEventListener(an, f), a.dispatchEvent(b), b.defaultPrevented || (rc(cc(vo(a)), { select: !0 }), document.activeElement === p && Pe(a));
      }
      return () => {
        a.removeEventListener(an, f), setTimeout(() => {
          const b = new CustomEvent(cn, Tr);
          a.addEventListener(cn, u), a.dispatchEvent(b), b.defaultPrevented || Pe(p ?? document.body, { select: !0 }), a.removeEventListener(cn, u), Or.remove(v);
        }, 0);
      };
    }
  }, [a, f, u, v]);
  const y = c.useCallback(
    (p) => {
      if (!n && !r || v.paused) return;
      const h = p.key === "Tab" && !p.altKey && !p.ctrlKey && !p.metaKey, b = document.activeElement;
      if (h && b) {
        const x = p.currentTarget, [w, C] = oc(x);
        w && C ? !p.shiftKey && b === C ? (p.preventDefault(), n && Pe(w, { select: !0 })) : p.shiftKey && b === w && (p.preventDefault(), n && Pe(C, { select: !0 })) : b === x && p.preventDefault();
      }
    },
    [n, r, v.paused]
  );
  return /* @__PURE__ */ g(M.div, { tabIndex: -1, ...i, ref: m, onKeyDown: y });
});
Wt.displayName = nc;
function rc(e, { select: t = !1 } = {}) {
  const n = document.activeElement;
  for (const r of e)
    if (Pe(r, { select: t }), document.activeElement !== n) return;
}
function oc(e) {
  const t = vo(e), n = Ar(t, e), r = Ar(t.reverse(), e);
  return [n, r];
}
function vo(e) {
  const t = [], n = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (r) => {
      const o = r.tagName === "INPUT" && r.type === "hidden";
      return r.disabled || r.hidden || o ? NodeFilter.FILTER_SKIP : r.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  for (; n.nextNode(); ) t.push(n.currentNode);
  return t;
}
function Ar(e, t) {
  const n = typeof t.checkVisibility == "function" && t.checkVisibility({ checkVisibilityCSS: !0 });
  for (const r of e)
    if (!(n ? !r.checkVisibility({ checkVisibilityCSS: !0 }) : sc(r, { upTo: t })))
      return r;
}
function sc(e, { upTo: t }) {
  if (getComputedStyle(e).visibility === "hidden") return !0;
  for (; e; ) {
    if (t !== void 0 && e === t) return !1;
    if (getComputedStyle(e).display === "none") return !0;
    e = e.parentElement;
  }
  return !1;
}
function ic(e) {
  return e instanceof HTMLInputElement && "select" in e;
}
function Pe(e, { select: t = !1 } = {}) {
  if (e && e.focus) {
    const n = document.activeElement;
    e.focus({ preventScroll: !0 }), e !== n && ic(e) && t && e.select();
  }
}
var Or = ac();
function ac() {
  let e = [];
  return {
    add(t) {
      const n = e[0];
      t !== n && (n == null || n.pause()), e = Ir(e, t), e.unshift(t);
    },
    remove(t) {
      var n;
      e = Ir(e, t), (n = e[0]) == null || n.resume();
    }
  };
}
function Ir(e, t) {
  const n = [...e], r = n.indexOf(t);
  return r !== -1 && n.splice(r, 1), n;
}
function cc(e) {
  return e.filter((t) => t.tagName !== "A");
}
var lc = "Portal", ft = c.forwardRef((e, t) => {
  var a;
  const { container: n, ...r } = e, [o, s] = c.useState(!1);
  Z(() => s(!0), []);
  const i = n || o && ((a = globalThis == null ? void 0 : globalThis.document) == null ? void 0 : a.body);
  return i ? ut.createPortal(/* @__PURE__ */ g(M.div, { ...r, ref: t }), i) : null;
});
ft.displayName = lc;
function uc(e, t) {
  return c.useReducer((n, r) => t[n][r] ?? n, e);
}
var be = (e) => {
  const { present: t, children: n } = e, r = dc(t), o = typeof n == "function" ? n({ present: r.isPresent }) : c.Children.only(n), s = fc(r.ref, pc(o));
  return typeof n == "function" || r.isPresent ? c.cloneElement(o, { ref: s }) : null;
};
be.displayName = "Presence";
function dc(e) {
  const [t, n] = c.useState(), r = c.useRef(null), o = c.useRef(e), s = c.useRef("none"), i = c.useRef(void 0), a = e ? "mounted" : "unmounted", [l, f] = uc(a, {
    mounted: {
      UNMOUNT: "unmounted",
      ANIMATION_OUT: "unmountSuspended"
    },
    unmountSuspended: {
      MOUNT: "mounted",
      ANIMATION_END: "unmounted"
    },
    unmounted: {
      MOUNT: "mounted"
    }
  });
  return c.useEffect(() => {
    l === "mounted" ? (s.current = i.current ?? it(r.current), i.current = void 0) : s.current = "none";
  }, [l]), Z(() => {
    const u = r.current, d = o.current;
    if (d !== e) {
      const v = s.current, y = it(u);
      e ? (i.current = y, f("MOUNT")) : y === "none" || (u == null ? void 0 : u.display) === "none" ? f("UNMOUNT") : f(d && v !== y ? "ANIMATION_OUT" : "UNMOUNT"), o.current = e;
    }
  }, [e, f]), Z(() => {
    if (t) {
      let u;
      const d = t.ownerDocument.defaultView ?? window, m = (y) => {
        const h = it(r.current).includes(CSS.escape(y.animationName));
        if (y.target === t && h && (f("ANIMATION_END"), !o.current)) {
          const b = t.style.animationFillMode;
          t.style.animationFillMode = "forwards", u = d.setTimeout(() => {
            t.style.animationFillMode === "forwards" && (t.style.animationFillMode = b);
          });
        }
      }, v = (y) => {
        y.target === t && (s.current = it(r.current));
      };
      return t.addEventListener("animationstart", v), t.addEventListener("animationcancel", m), t.addEventListener("animationend", m), () => {
        d.clearTimeout(u), t.removeEventListener("animationstart", v), t.removeEventListener("animationcancel", m), t.removeEventListener("animationend", m);
      };
    } else
      f("ANIMATION_END");
  }, [t, f]), {
    isPresent: ["mounted", "unmountSuspended"].includes(l),
    ref: c.useCallback((u) => {
      if (u) {
        const d = getComputedStyle(u);
        r.current = d, i.current = it(d);
      } else
        r.current = null;
      n(u);
    }, [])
  };
}
function _r(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
function fc(...e) {
  const t = c.useRef(e);
  return t.current = e, c.useCallback((n) => {
    const r = t.current;
    let o = !1;
    const s = r.map((i) => {
      const a = _r(i, n);
      return !o && typeof a == "function" && (o = !0), a;
    });
    if (o)
      return () => {
        for (let i = 0; i < s.length; i++) {
          const a = s[i];
          typeof a == "function" ? a() : _r(r[i], null);
        }
      };
  }, []);
}
function it(e) {
  return (e == null ? void 0 : e.animationName) || "none";
}
function pc(e) {
  var r, o;
  let t = (r = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (o = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
var Rt = 0, fe = null;
function kn() {
  c.useEffect(() => {
    fe || (fe = { start: Mr(), end: Mr() });
    const { start: e, end: t } = fe;
    return document.body.firstElementChild !== e && document.body.insertAdjacentElement("afterbegin", e), document.body.lastElementChild !== t && document.body.insertAdjacentElement("beforeend", t), Rt++, () => {
      Rt === 1 && (fe == null || fe.start.remove(), fe == null || fe.end.remove(), fe = null), Rt = Math.max(0, Rt - 1);
    };
  }, []);
}
function Mr() {
  const e = document.createElement("span");
  return e.setAttribute("data-radix-focus-guard", ""), e.tabIndex = 0, e.style.outline = "none", e.style.opacity = "0", e.style.position = "fixed", e.style.pointerEvents = "none", e;
}
var pe = function() {
  return pe = Object.assign || function(t) {
    for (var n, r = 1, o = arguments.length; r < o; r++) {
      n = arguments[r];
      for (var s in n) Object.prototype.hasOwnProperty.call(n, s) && (t[s] = n[s]);
    }
    return t;
  }, pe.apply(this, arguments);
};
function ho(e, t) {
  var n = {};
  for (var r in e) Object.prototype.hasOwnProperty.call(e, r) && t.indexOf(r) < 0 && (n[r] = e[r]);
  if (e != null && typeof Object.getOwnPropertySymbols == "function")
    for (var o = 0, r = Object.getOwnPropertySymbols(e); o < r.length; o++)
      t.indexOf(r[o]) < 0 && Object.prototype.propertyIsEnumerable.call(e, r[o]) && (n[r[o]] = e[r[o]]);
  return n;
}
function mc(e, t, n) {
  if (n || arguments.length === 2) for (var r = 0, o = t.length, s; r < o; r++)
    (s || !(r in t)) && (s || (s = Array.prototype.slice.call(t, 0, r)), s[r] = t[r]);
  return e.concat(s || Array.prototype.slice.call(t));
}
var Ot = "right-scroll-bar-position", It = "width-before-scroll-bar", gc = "with-scroll-bars-hidden", vc = "--removed-body-scroll-bar-size";
function ln(e, t) {
  return typeof e == "function" ? e(t) : e && (e.current = t), e;
}
function hc(e, t) {
  var n = Ii(function() {
    return {
      // value
      value: e,
      // last callback
      callback: t,
      // "memoized" public interface
      facade: {
        get current() {
          return n.value;
        },
        set current(r) {
          var o = n.value;
          o !== r && (n.value = r, n.callback(r, o));
        }
      }
    };
  })[0];
  return n.callback = t, n.facade;
}
var bc = typeof window < "u" ? c.useLayoutEffect : c.useEffect, Dr = /* @__PURE__ */ new WeakMap();
function yc(e, t) {
  var n = hc(null, function(r) {
    return e.forEach(function(o) {
      return ln(o, r);
    });
  });
  return bc(function() {
    var r = Dr.get(n);
    if (r) {
      var o = new Set(r), s = new Set(e), i = n.current;
      o.forEach(function(a) {
        s.has(a) || ln(a, null);
      }), s.forEach(function(a) {
        o.has(a) || ln(a, i);
      });
    }
    Dr.set(n, e);
  }, [e]), n;
}
function wc(e) {
  return e;
}
function xc(e, t) {
  t === void 0 && (t = wc);
  var n = [], r = !1, o = {
    read: function() {
      if (r)
        throw new Error("Sidecar: could not `read` from an `assigned` medium. `read` could be used only with `useMedium`.");
      return n.length ? n[n.length - 1] : e;
    },
    useMedium: function(s) {
      var i = t(s, r);
      return n.push(i), function() {
        n = n.filter(function(a) {
          return a !== i;
        });
      };
    },
    assignSyncMedium: function(s) {
      for (r = !0; n.length; ) {
        var i = n;
        n = [], i.forEach(s);
      }
      n = {
        push: function(a) {
          return s(a);
        },
        filter: function() {
          return n;
        }
      };
    },
    assignMedium: function(s) {
      r = !0;
      var i = [];
      if (n.length) {
        var a = n;
        n = [], a.forEach(s), i = n;
      }
      var l = function() {
        var u = i;
        i = [], u.forEach(s);
      }, f = function() {
        return Promise.resolve().then(l);
      };
      f(), n = {
        push: function(u) {
          i.push(u), f();
        },
        filter: function(u) {
          return i = i.filter(u), n;
        }
      };
    }
  };
  return o;
}
function Cc(e) {
  e === void 0 && (e = {});
  var t = xc(null);
  return t.options = pe({ async: !0, ssr: !1 }, e), t;
}
var bo = function(e) {
  var t = e.sideCar, n = ho(e, ["sideCar"]);
  if (!t)
    throw new Error("Sidecar: please provide `sideCar` property to import the right car");
  var r = t.read();
  if (!r)
    throw new Error("Sidecar medium not found");
  return c.createElement(r, pe({}, n));
};
bo.isSideCarExport = !0;
function Sc(e, t) {
  return e.useMedium(t), bo;
}
var yo = Cc(), un = function() {
}, Ht = c.forwardRef(function(e, t) {
  var n = c.useRef(null), r = c.useState({
    onScrollCapture: un,
    onWheelCapture: un,
    onTouchMoveCapture: un
  }), o = r[0], s = r[1], i = e.forwardProps, a = e.children, l = e.className, f = e.removeScrollBar, u = e.enabled, d = e.shards, m = e.sideCar, v = e.noRelative, y = e.noIsolation, p = e.inert, h = e.allowPinchZoom, b = e.as, x = b === void 0 ? "div" : b, w = e.gapMode, C = ho(e, ["forwardProps", "children", "className", "removeScrollBar", "enabled", "shards", "sideCar", "noRelative", "noIsolation", "inert", "allowPinchZoom", "as", "gapMode"]), S = m, R = yc([n, t]), E = pe(pe({}, C), o);
  return c.createElement(
    c.Fragment,
    null,
    u && c.createElement(S, { sideCar: yo, removeScrollBar: f, shards: d, noRelative: v, noIsolation: y, inert: p, setCallbacks: s, allowPinchZoom: !!h, lockRef: n, gapMode: w }),
    i ? c.cloneElement(c.Children.only(a), pe(pe({}, E), { ref: R })) : c.createElement(x, pe({}, E, { className: l, ref: R }), a)
  );
});
Ht.defaultProps = {
  enabled: !0,
  removeScrollBar: !0,
  inert: !1
};
Ht.classNames = {
  fullWidth: It,
  zeroRight: Ot
};
var Rc = function() {
  if (typeof __webpack_nonce__ < "u")
    return __webpack_nonce__;
};
function Ec() {
  if (!document)
    return null;
  var e = document.createElement("style");
  e.type = "text/css";
  var t = Rc();
  return t && e.setAttribute("nonce", t), e;
}
function Pc(e, t) {
  e.styleSheet ? e.styleSheet.cssText = t : e.appendChild(document.createTextNode(t));
}
function Nc(e) {
  var t = document.head || document.getElementsByTagName("head")[0];
  t.appendChild(e);
}
var Tc = function() {
  var e = 0, t = null;
  return {
    add: function(n) {
      e == 0 && (t = Ec()) && (Pc(t, n), Nc(t)), e++;
    },
    remove: function() {
      e--, !e && t && (t.parentNode && t.parentNode.removeChild(t), t = null);
    }
  };
}, Ac = function() {
  var e = Tc();
  return function(t, n) {
    c.useEffect(function() {
      return e.add(t), function() {
        e.remove();
      };
    }, [t && n]);
  };
}, wo = function() {
  var e = Ac(), t = function(n) {
    var r = n.styles, o = n.dynamic;
    return e(r, o), null;
  };
  return t;
}, Oc = {
  left: 0,
  top: 0,
  right: 0,
  gap: 0
}, dn = function(e) {
  return parseInt(e || "", 10) || 0;
}, Ic = function(e) {
  var t = window.getComputedStyle(document.body), n = t[e === "padding" ? "paddingLeft" : "marginLeft"], r = t[e === "padding" ? "paddingTop" : "marginTop"], o = t[e === "padding" ? "paddingRight" : "marginRight"];
  return [dn(n), dn(r), dn(o)];
}, _c = function(e) {
  if (e === void 0 && (e = "margin"), typeof window > "u")
    return Oc;
  var t = Ic(e), n = document.documentElement.clientWidth, r = window.innerWidth;
  return {
    left: t[0],
    top: t[1],
    right: t[2],
    gap: Math.max(0, r - n + t[2] - t[0])
  };
}, Mc = wo(), je = "data-scroll-locked", Dc = function(e, t, n, r) {
  var o = e.left, s = e.top, i = e.right, a = e.gap;
  return n === void 0 && (n = "margin"), `
  .`.concat(gc, ` {
   overflow: hidden `).concat(r, `;
   padding-right: `).concat(a, "px ").concat(r, `;
  }
  body[`).concat(je, `] {
    overflow: hidden `).concat(r, `;
    overscroll-behavior: contain;
    `).concat([
    t && "position: relative ".concat(r, ";"),
    n === "margin" && `
    padding-left: `.concat(o, `px;
    padding-top: `).concat(s, `px;
    padding-right: `).concat(i, `px;
    margin-left:0;
    margin-top:0;
    margin-right: `).concat(a, "px ").concat(r, `;
    `),
    n === "padding" && "padding-right: ".concat(a, "px ").concat(r, ";")
  ].filter(Boolean).join(""), `
  }
  
  .`).concat(Ot, ` {
    right: `).concat(a, "px ").concat(r, `;
  }
  
  .`).concat(It, ` {
    margin-right: `).concat(a, "px ").concat(r, `;
  }
  
  .`).concat(Ot, " .").concat(Ot, ` {
    right: 0 `).concat(r, `;
  }
  
  .`).concat(It, " .").concat(It, ` {
    margin-right: 0 `).concat(r, `;
  }
  
  body[`).concat(je, `] {
    `).concat(vc, ": ").concat(a, `px;
  }
`);
}, kr = function() {
  var e = parseInt(document.body.getAttribute(je) || "0", 10);
  return isFinite(e) ? e : 0;
}, kc = function() {
  c.useEffect(function() {
    return document.body.setAttribute(je, (kr() + 1).toString()), function() {
      var e = kr() - 1;
      e <= 0 ? document.body.removeAttribute(je) : document.body.setAttribute(je, e.toString());
    };
  }, []);
}, Lc = function(e) {
  var t = e.noRelative, n = e.noImportant, r = e.gapMode, o = r === void 0 ? "margin" : r;
  kc();
  var s = c.useMemo(function() {
    return _c(o);
  }, [o]);
  return c.createElement(Mc, { styles: Dc(s, !t, o, n ? "" : "!important") });
}, xn = !1;
if (typeof window < "u")
  try {
    var Et = Object.defineProperty({}, "passive", {
      get: function() {
        return xn = !0, !0;
      }
    });
    window.addEventListener("test", Et, Et), window.removeEventListener("test", Et, Et);
  } catch {
    xn = !1;
  }
var He = xn ? { passive: !1 } : !1, Fc = function(e) {
  return e.tagName === "TEXTAREA";
}, xo = function(e, t) {
  if (!(e instanceof Element))
    return !1;
  var n = window.getComputedStyle(e);
  return (
    // not-not-scrollable
    n[t] !== "hidden" && // contains scroll inside self
    !(n.overflowY === n.overflowX && !Fc(e) && n[t] === "visible")
  );
}, $c = function(e) {
  return xo(e, "overflowY");
}, Vc = function(e) {
  return xo(e, "overflowX");
}, Lr = function(e, t) {
  var n = t.ownerDocument, r = t;
  do {
    typeof ShadowRoot < "u" && r instanceof ShadowRoot && (r = r.host);
    var o = Co(e, r);
    if (o) {
      var s = So(e, r), i = s[1], a = s[2];
      if (i > a)
        return !0;
    }
    r = r.parentNode;
  } while (r && r !== n.body);
  return !1;
}, Bc = function(e) {
  var t = e.scrollTop, n = e.scrollHeight, r = e.clientHeight;
  return [
    t,
    n,
    r
  ];
}, Wc = function(e) {
  var t = e.scrollLeft, n = e.scrollWidth, r = e.clientWidth;
  return [
    t,
    n,
    r
  ];
}, Co = function(e, t) {
  return e === "v" ? $c(t) : Vc(t);
}, So = function(e, t) {
  return e === "v" ? Bc(t) : Wc(t);
}, Hc = function(e, t) {
  return e === "h" && t === "rtl" ? -1 : 1;
}, zc = function(e, t, n, r, o) {
  var s = Hc(e, window.getComputedStyle(t).direction), i = s * r, a = n.target, l = t.contains(a), f = !1, u = i > 0, d = 0, m = 0;
  do {
    if (!a)
      break;
    var v = So(e, a), y = v[0], p = v[1], h = v[2], b = p - h - s * y;
    (y || b) && Co(e, a) && (d += b, m += y);
    var x = a.parentNode;
    a = x && x.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? x.host : x;
  } while (
    // portaled content
    !l && a !== document.body || // self content
    l && (t.contains(a) || t === a)
  );
  return (u && Math.abs(d) < 1 || !u && Math.abs(m) < 1) && (f = !0), f;
}, Pt = function(e) {
  return "changedTouches" in e ? [e.changedTouches[0].clientX, e.changedTouches[0].clientY] : [0, 0];
}, Fr = function(e) {
  return [e.deltaX, e.deltaY];
}, $r = function(e) {
  return e && "current" in e ? e.current : e;
}, Uc = function(e, t) {
  return e[0] === t[0] && e[1] === t[1];
}, Gc = function(e) {
  return `
  .block-interactivity-`.concat(e, ` {pointer-events: none;}
  .allow-interactivity-`).concat(e, ` {pointer-events: all;}
`);
}, jc = 0, ze = [];
function Kc(e) {
  var t = c.useRef([]), n = c.useRef([0, 0]), r = c.useRef(), o = c.useState(jc++)[0], s = c.useState(wo)[0], i = c.useRef(e);
  c.useEffect(function() {
    i.current = e;
  }, [e]), c.useEffect(function() {
    if (e.inert) {
      document.body.classList.add("block-interactivity-".concat(o));
      var p = mc([e.lockRef.current], (e.shards || []).map($r), !0).filter(Boolean);
      return p.forEach(function(h) {
        return h.classList.add("allow-interactivity-".concat(o));
      }), function() {
        document.body.classList.remove("block-interactivity-".concat(o)), p.forEach(function(h) {
          return h.classList.remove("allow-interactivity-".concat(o));
        });
      };
    }
  }, [e.inert, e.lockRef.current, e.shards]);
  var a = c.useCallback(function(p, h) {
    if ("touches" in p && p.touches.length === 2 || p.type === "wheel" && p.ctrlKey)
      return !i.current.allowPinchZoom;
    var b = Pt(p), x = n.current, w = "deltaX" in p ? p.deltaX : x[0] - b[0], C = "deltaY" in p ? p.deltaY : x[1] - b[1], S, R = p.target, E = Math.abs(w) > Math.abs(C) ? "h" : "v";
    if ("touches" in p && E === "h" && R.type === "range")
      return !1;
    var T = window.getSelection(), V = T && T.anchorNode, L = V ? V === R || V.contains(R) : !1;
    if (L)
      return !1;
    var P = Lr(E, R);
    if (!P)
      return !0;
    if (P ? S = E : (S = E === "v" ? "h" : "v", P = Lr(E, R)), !P)
      return !1;
    if (!r.current && "changedTouches" in p && (w || C) && (r.current = S), !S)
      return !0;
    var N = r.current || S;
    return zc(N, h, p, N === "h" ? w : C);
  }, []), l = c.useCallback(function(p) {
    var h = p;
    if (!(!ze.length || ze[ze.length - 1] !== s)) {
      var b = "deltaY" in h ? Fr(h) : Pt(h), x = t.current.filter(function(S) {
        return S.name === h.type && (S.target === h.target || h.target === S.shadowParent) && Uc(S.delta, b);
      })[0];
      if (x && x.should) {
        h.cancelable && h.preventDefault();
        return;
      }
      if (!x) {
        var w = (i.current.shards || []).map($r).filter(Boolean).filter(function(S) {
          return S.contains(h.target);
        }), C = w.length > 0 ? a(h, w[0]) : !i.current.noIsolation;
        C && h.cancelable && h.preventDefault();
      }
    }
  }, []), f = c.useCallback(function(p, h, b, x) {
    var w = { name: p, delta: h, target: b, should: x, shadowParent: Yc(b) };
    t.current.push(w), setTimeout(function() {
      t.current = t.current.filter(function(C) {
        return C !== w;
      });
    }, 1);
  }, []), u = c.useCallback(function(p) {
    n.current = Pt(p), r.current = void 0;
  }, []), d = c.useCallback(function(p) {
    f(p.type, Fr(p), p.target, a(p, e.lockRef.current));
  }, []), m = c.useCallback(function(p) {
    f(p.type, Pt(p), p.target, a(p, e.lockRef.current));
  }, []);
  c.useEffect(function() {
    return ze.push(s), e.setCallbacks({
      onScrollCapture: d,
      onWheelCapture: d,
      onTouchMoveCapture: m
    }), document.addEventListener("wheel", l, He), document.addEventListener("touchmove", l, He), document.addEventListener("touchstart", u, He), function() {
      ze = ze.filter(function(p) {
        return p !== s;
      }), document.removeEventListener("wheel", l, He), document.removeEventListener("touchmove", l, He), document.removeEventListener("touchstart", u, He);
    };
  }, []);
  var v = e.removeScrollBar, y = e.inert;
  return c.createElement(
    c.Fragment,
    null,
    y ? c.createElement(s, { styles: Gc(o) }) : null,
    v ? c.createElement(Lc, { noRelative: e.noRelative, gapMode: e.gapMode }) : null
  );
}
function Yc(e) {
  for (var t = null; e !== null; )
    e instanceof ShadowRoot && (t = e.host, e = e.host), e = e.parentNode;
  return t;
}
const Xc = Sc(yo, Kc);
var zt = c.forwardRef(function(e, t) {
  return c.createElement(Ht, pe({}, e, { ref: t, sideCar: Xc }));
});
zt.classNames = Ht.classNames;
var qc = function(e) {
  if (typeof document > "u")
    return null;
  var t = Array.isArray(e) ? e[0] : e;
  return t.ownerDocument.body;
}, Ue = /* @__PURE__ */ new WeakMap(), Nt = /* @__PURE__ */ new WeakMap(), Tt = {}, fn = 0, Ro = function(e) {
  return e && (e.host || Ro(e.parentNode));
}, Zc = function(e, t) {
  return t.map(function(n) {
    if (e.contains(n))
      return n;
    var r = Ro(n);
    return r && e.contains(r) ? r : (console.error("aria-hidden", n, "in not contained inside", e, ". Doing nothing"), null);
  }).filter(function(n) {
    return !!n;
  });
}, Qc = function(e, t, n, r) {
  var o = Zc(t, Array.isArray(e) ? e : [e]);
  Tt[n] || (Tt[n] = /* @__PURE__ */ new WeakMap());
  var s = Tt[n], i = [], a = /* @__PURE__ */ new Set(), l = new Set(o), f = function(d) {
    !d || a.has(d) || (a.add(d), f(d.parentNode));
  };
  o.forEach(f);
  var u = function(d) {
    !d || l.has(d) || Array.prototype.forEach.call(d.children, function(m) {
      if (a.has(m))
        u(m);
      else
        try {
          var v = m.getAttribute(r), y = v !== null && v !== "false", p = (Ue.get(m) || 0) + 1, h = (s.get(m) || 0) + 1;
          Ue.set(m, p), s.set(m, h), i.push(m), p === 1 && y && Nt.set(m, !0), h === 1 && m.setAttribute(n, "true"), y || m.setAttribute(r, "true");
        } catch (b) {
          console.error("aria-hidden: cannot operate on ", m, b);
        }
    });
  };
  return u(t), a.clear(), fn++, function() {
    i.forEach(function(d) {
      var m = Ue.get(d) - 1, v = s.get(d) - 1;
      Ue.set(d, m), s.set(d, v), m || (Nt.has(d) || d.removeAttribute(r), Nt.delete(d)), v || d.removeAttribute(n);
    }), fn--, fn || (Ue = /* @__PURE__ */ new WeakMap(), Ue = /* @__PURE__ */ new WeakMap(), Nt = /* @__PURE__ */ new WeakMap(), Tt = {});
  };
}, Ln = function(e, t, n) {
  n === void 0 && (n = "data-aria-hidden");
  var r = Array.from(Array.isArray(e) ? e : [e]), o = qc(e);
  return o ? (r.push.apply(r, Array.from(o.querySelectorAll("[aria-live], script"))), Qc(r, o, n, "aria-hidden")) : function() {
    return null;
  };
}, Ut = "Dialog", [Eo] = he(Ut), [Jc, ue] = Eo(Ut), Fn = (e) => {
  const {
    __scopeDialog: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    modal: i = !0
  } = e, a = c.useRef(null), l = c.useRef(null), [f, u] = Le({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: Ut
  });
  return /* @__PURE__ */ g(
    Jc,
    {
      scope: t,
      triggerRef: a,
      contentRef: l,
      contentId: ge(),
      titleId: ge(),
      descriptionId: ge(),
      open: f,
      onOpenChange: u,
      onOpenToggle: c.useCallback(() => u((d) => !d), [u]),
      modal: i,
      children: n
    }
  );
};
Fn.displayName = Ut;
var Po = "DialogTrigger", $n = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, ...r } = e, o = ue(Po, n), s = j(t, o.triggerRef);
    return /* @__PURE__ */ g(
      M.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": o.open,
        "aria-controls": o.open ? o.contentId : void 0,
        "data-state": Wn(o.open),
        ...r,
        ref: s,
        onClick: O(e.onClick, o.onOpenToggle)
      }
    );
  }
);
$n.displayName = Po;
var Vn = "DialogPortal", [el, No] = Eo(Vn, {
  forceMount: void 0
}), Bn = (e) => {
  const { __scopeDialog: t, forceMount: n, children: r, container: o } = e, s = ue(Vn, t);
  return /* @__PURE__ */ g(el, { scope: t, forceMount: n, children: c.Children.map(r, (i) => /* @__PURE__ */ g(be, { present: n || s.open, children: /* @__PURE__ */ g(ft, { asChild: !0, container: o, children: i }) })) });
};
Bn.displayName = Vn;
var Mt = "DialogOverlay", pt = c.forwardRef(
  (e, t) => {
    const n = No(Mt, e.__scopeDialog), { forceMount: r = n.forceMount, ...o } = e, s = ue(Mt, e.__scopeDialog);
    return s.modal ? /* @__PURE__ */ g(be, { present: r || s.open, children: /* @__PURE__ */ g(nl, { ...o, ref: t }) }) : null;
  }
);
pt.displayName = Mt;
var tl = /* @__PURE__ */ ke("DialogOverlay.RemoveScroll"), nl = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, ...r } = e, o = ue(Mt, n), s = Qa(), i = j(t, s);
    return (
      // Make sure `Content` is scrollable even when it doesn't live inside `RemoveScroll`
      // ie. when `Overlay` and `Content` are siblings
      /* @__PURE__ */ g(zt, { as: tl, allowPinchZoom: !0, shards: [o.contentRef], children: /* @__PURE__ */ g(
        M.div,
        {
          "data-state": Wn(o.open),
          ...r,
          ref: i,
          style: { pointerEvents: "auto", ...r.style }
        }
      ) })
    );
  }
), Ye = "DialogContent", mt = c.forwardRef(
  (e, t) => {
    const n = No(Ye, e.__scopeDialog), { forceMount: r = n.forceMount, ...o } = e, s = ue(Ye, e.__scopeDialog);
    return /* @__PURE__ */ g(be, { present: r || s.open, children: s.modal ? /* @__PURE__ */ g(rl, { ...o, ref: t }) : /* @__PURE__ */ g(ol, { ...o, ref: t }) });
  }
);
mt.displayName = Ye;
var rl = c.forwardRef(
  (e, t) => {
    const n = ue(Ye, e.__scopeDialog), r = c.useRef(null), o = j(t, n.contentRef, r);
    return c.useEffect(() => {
      const s = r.current;
      if (s) return Ln(s);
    }, []), /* @__PURE__ */ g(
      To,
      {
        ...e,
        ref: o,
        trapFocus: n.open,
        disableOutsidePointerEvents: n.open,
        onCloseAutoFocus: O(e.onCloseAutoFocus, (s) => {
          var i;
          s.preventDefault(), (i = n.triggerRef.current) == null || i.focus();
        }),
        onPointerDownOutside: O(e.onPointerDownOutside, (s) => {
          const i = s.detail.originalEvent, a = i.button === 0 && i.ctrlKey === !0;
          (i.button === 2 || a) && s.preventDefault();
        }),
        onFocusOutside: O(
          e.onFocusOutside,
          (s) => s.preventDefault()
        )
      }
    );
  }
), ol = c.forwardRef(
  (e, t) => {
    const n = ue(Ye, e.__scopeDialog), r = c.useRef(!1), o = c.useRef(!1);
    return /* @__PURE__ */ g(
      To,
      {
        ...e,
        ref: t,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (s) => {
          var i, a;
          (i = e.onCloseAutoFocus) == null || i.call(e, s), s.defaultPrevented || (r.current || (a = n.triggerRef.current) == null || a.focus(), s.preventDefault()), r.current = !1, o.current = !1;
        },
        onInteractOutside: (s) => {
          var l, f;
          (l = e.onInteractOutside) == null || l.call(e, s), s.defaultPrevented || (r.current = !0, s.detail.originalEvent.type === "pointerdown" && (o.current = !0));
          const i = s.target;
          ((f = n.triggerRef.current) == null ? void 0 : f.contains(i)) && s.preventDefault(), s.detail.originalEvent.type === "focusin" && o.current && s.preventDefault();
        }
      }
    );
  }
), To = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, trapFocus: r, onOpenAutoFocus: o, onCloseAutoFocus: s, ...i } = e, a = ue(Ye, n);
    return kn(), /* @__PURE__ */ g(Bt, { children: /* @__PURE__ */ g(
      Wt,
      {
        asChild: !0,
        loop: !0,
        trapped: r,
        onMountAutoFocus: o,
        onUnmountAutoFocus: s,
        children: /* @__PURE__ */ g(
          dt,
          {
            role: "dialog",
            id: a.contentId,
            "aria-describedby": a.descriptionId,
            "aria-labelledby": a.titleId,
            "data-state": Wn(a.open),
            ...i,
            ref: t,
            deferPointerDownOutside: !0,
            onDismiss: () => a.onOpenChange(!1)
          }
        )
      }
    ) });
  }
), Ao = "DialogTitle", gt = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, ...r } = e, o = ue(Ao, n);
    return /* @__PURE__ */ g(M.h2, { id: o.titleId, ...r, ref: t });
  }
);
gt.displayName = Ao;
var Oo = "DialogDescription", vt = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, ...r } = e, o = ue(Oo, n);
    return /* @__PURE__ */ g(M.p, { id: o.descriptionId, ...r, ref: t });
  }
);
vt.displayName = Oo;
var Io = "DialogClose", ht = c.forwardRef(
  (e, t) => {
    const { __scopeDialog: n, ...r } = e, o = ue(Io, n);
    return /* @__PURE__ */ g(
      M.button,
      {
        type: "button",
        ...r,
        ref: t,
        onClick: O(e.onClick, () => o.onOpenChange(!1))
      }
    );
  }
);
ht.displayName = Io;
function Wn(e) {
  return e ? "open" : "closed";
}
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const sl = (e) => e.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), _o = (...e) => e.filter((t, n, r) => !!t && t.trim() !== "" && r.indexOf(t) === n).join(" ").trim();
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var il = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const al = eo(
  ({
    color: e = "currentColor",
    size: t = 24,
    strokeWidth: n = 2,
    absoluteStrokeWidth: r,
    className: o = "",
    children: s,
    iconNode: i,
    ...a
  }, l) => bn(
    "svg",
    {
      ref: l,
      ...il,
      width: t,
      height: t,
      stroke: e,
      strokeWidth: r ? Number(n) * 24 / Number(t) : n,
      className: _o("lucide", o),
      ...a
    },
    [
      ...i.map(([f, u]) => bn(f, u)),
      ...Array.isArray(s) ? s : [s]
    ]
  )
);
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Gt = (e, t) => {
  const n = eo(
    ({ className: r, ...o }, s) => bn(al, {
      ref: s,
      iconNode: t,
      className: _o(`lucide-${sl(e)}`, r),
      ...o
    })
  );
  return n.displayName = `${e}`, n;
};
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const cl = Gt("Check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Mo = Gt("ChevronDown", [
  ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
]);
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ll = Gt("ChevronUp", [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]]);
/**
 * @license lucide-react v0.462.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Do = Gt("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]), $f = Fn, Vf = $n, ul = Bn, Bf = ht, ko = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  pt,
  {
    ref: n,
    className: _("fixed inset-0 z-50 bg-black/80", e),
    ...t
  }
));
ko.displayName = pt.displayName;
const dl = c.forwardRef(({ className: e, children: t, ...n }, r) => /* @__PURE__ */ J(ul, { children: [
  /* @__PURE__ */ g(ko, {}),
  /* @__PURE__ */ J(
    mt,
    {
      ref: r,
      className: _(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-background p-6 text-foreground shadow-lg sm:rounded-lg",
        e
      ),
      ...n,
      children: [
        t,
        /* @__PURE__ */ J(ht, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none [&_svg]:size-4", children: [
          /* @__PURE__ */ g(Do, {}),
          /* @__PURE__ */ g("span", { className: "sr-only", children: "Close" })
        ] })
      ]
    }
  )
] }));
dl.displayName = mt.displayName;
function fl({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        e
      ),
      ...t
    }
  );
}
fl.displayName = "DialogHeader";
function pl({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        e
      ),
      ...t
    }
  );
}
pl.displayName = "DialogFooter";
const ml = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  gt,
  {
    ref: n,
    className: _(
      "text-lg font-semibold leading-none tracking-tight",
      e
    ),
    ...t
  }
));
ml.displayName = gt.displayName;
const gl = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  vt,
  {
    ref: n,
    className: _("text-sm text-muted-foreground", e),
    ...t
  }
));
gl.displayName = vt.displayName;
const Wf = Fn, Hf = $n, zf = ht, vl = Bn, Lo = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  pt,
  {
    className: _("fixed inset-0 z-50 bg-black/80", e),
    ...t,
    ref: n
  }
));
Lo.displayName = pt.displayName;
const hl = _n(
  "fixed z-50 gap-4 bg-background p-6 text-foreground shadow-lg",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b border-border",
        bottom: "inset-x-0 bottom-0 border-t border-border",
        left: "inset-y-0 left-0 h-full w-3/4 border-r border-border sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l border-border sm:max-w-sm"
      }
    },
    defaultVariants: {
      side: "right"
    }
  }
), bl = c.forwardRef(({ side: e = "right", className: t, children: n, ...r }, o) => /* @__PURE__ */ J(vl, { children: [
  /* @__PURE__ */ g(Lo, {}),
  /* @__PURE__ */ J(
    mt,
    {
      ref: o,
      className: _(hl({ side: e }), t),
      ...r,
      children: [
        n,
        /* @__PURE__ */ J(ht, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none [&_svg]:size-4", children: [
          /* @__PURE__ */ g(Do, {}),
          /* @__PURE__ */ g("span", { className: "sr-only", children: "Close" })
        ] })
      ]
    }
  )
] }));
bl.displayName = mt.displayName;
function yl({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _(
        "flex flex-col space-y-2 text-center sm:text-left",
        e
      ),
      ...t
    }
  );
}
yl.displayName = "SheetHeader";
function wl({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ g(
    "div",
    {
      className: _(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        e
      ),
      ...t
    }
  );
}
wl.displayName = "SheetFooter";
const xl = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  gt,
  {
    ref: n,
    className: _("text-lg font-semibold text-foreground", e),
    ...t
  }
));
xl.displayName = gt.displayName;
const Cl = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  vt,
  {
    ref: n,
    className: _("text-sm text-muted-foreground", e),
    ...t
  }
));
Cl.displayName = vt.displayName;
const Sl = ["top", "right", "bottom", "left"], Ne = Math.min, te = Math.max, Dt = Math.round, At = Math.floor, ve = (e) => ({
  x: e,
  y: e
}), Rl = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom"
};
function Cn(e, t, n) {
  return te(e, Ne(t, n));
}
function xe(e, t) {
  return typeof e == "function" ? e(t) : e;
}
function Ce(e) {
  return e.split("-")[0];
}
function Je(e) {
  return e.split("-")[1];
}
function Hn(e) {
  return e === "x" ? "y" : "x";
}
function zn(e) {
  return e === "y" ? "height" : "width";
}
function me(e) {
  const t = e[0];
  return t === "t" || t === "b" ? "y" : "x";
}
function Un(e) {
  return Hn(me(e));
}
function El(e, t, n) {
  n === void 0 && (n = !1);
  const r = Je(e), o = Un(e), s = zn(o);
  let i = o === "x" ? r === (n ? "end" : "start") ? "right" : "left" : r === "start" ? "bottom" : "top";
  return t.reference[s] > t.floating[s] && (i = kt(i)), [i, kt(i)];
}
function Pl(e) {
  const t = kt(e);
  return [Sn(e), t, Sn(t)];
}
function Sn(e) {
  return e.includes("start") ? e.replace("start", "end") : e.replace("end", "start");
}
const Vr = ["left", "right"], Br = ["right", "left"], Nl = ["top", "bottom"], Tl = ["bottom", "top"];
function Al(e, t, n) {
  switch (e) {
    case "top":
    case "bottom":
      return n ? t ? Br : Vr : t ? Vr : Br;
    case "left":
    case "right":
      return t ? Nl : Tl;
    default:
      return [];
  }
}
function Ol(e, t, n, r) {
  const o = Je(e);
  let s = Al(Ce(e), n === "start", r);
  return o && (s = s.map((i) => i + "-" + o), t && (s = s.concat(s.map(Sn)))), s;
}
function kt(e) {
  const t = Ce(e);
  return Rl[t] + e.slice(t.length);
}
function Il(e) {
  return {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    ...e
  };
}
function Fo(e) {
  return typeof e != "number" ? Il(e) : {
    top: e,
    right: e,
    bottom: e,
    left: e
  };
}
function Lt(e) {
  const {
    x: t,
    y: n,
    width: r,
    height: o
  } = e;
  return {
    width: r,
    height: o,
    top: n,
    left: t,
    right: t + r,
    bottom: n + o,
    x: t,
    y: n
  };
}
function Wr(e, t, n) {
  let {
    reference: r,
    floating: o
  } = e;
  const s = me(t), i = Un(t), a = zn(i), l = Ce(t), f = s === "y", u = r.x + r.width / 2 - o.width / 2, d = r.y + r.height / 2 - o.height / 2, m = r[a] / 2 - o[a] / 2;
  let v;
  switch (l) {
    case "top":
      v = {
        x: u,
        y: r.y - o.height
      };
      break;
    case "bottom":
      v = {
        x: u,
        y: r.y + r.height
      };
      break;
    case "right":
      v = {
        x: r.x + r.width,
        y: d
      };
      break;
    case "left":
      v = {
        x: r.x - o.width,
        y: d
      };
      break;
    default:
      v = {
        x: r.x,
        y: r.y
      };
  }
  switch (Je(t)) {
    case "start":
      v[i] -= m * (n && f ? -1 : 1);
      break;
    case "end":
      v[i] += m * (n && f ? -1 : 1);
      break;
  }
  return v;
}
async function _l(e, t) {
  var n;
  t === void 0 && (t = {});
  const {
    x: r,
    y: o,
    platform: s,
    rects: i,
    elements: a,
    strategy: l
  } = e, {
    boundary: f = "clippingAncestors",
    rootBoundary: u = "viewport",
    elementContext: d = "floating",
    altBoundary: m = !1,
    padding: v = 0
  } = xe(t, e), y = Fo(v), h = a[m ? d === "floating" ? "reference" : "floating" : d], b = Lt(await s.getClippingRect({
    element: (n = await (s.isElement == null ? void 0 : s.isElement(h))) == null || n ? h : h.contextElement || await (s.getDocumentElement == null ? void 0 : s.getDocumentElement(a.floating)),
    boundary: f,
    rootBoundary: u,
    strategy: l
  })), x = d === "floating" ? {
    x: r,
    y: o,
    width: i.floating.width,
    height: i.floating.height
  } : i.reference, w = await (s.getOffsetParent == null ? void 0 : s.getOffsetParent(a.floating)), C = await (s.isElement == null ? void 0 : s.isElement(w)) ? await (s.getScale == null ? void 0 : s.getScale(w)) || {
    x: 1,
    y: 1
  } : {
    x: 1,
    y: 1
  }, S = Lt(s.convertOffsetParentRelativeRectToViewportRelativeRect ? await s.convertOffsetParentRelativeRectToViewportRelativeRect({
    elements: a,
    rect: x,
    offsetParent: w,
    strategy: l
  }) : x);
  return {
    top: (b.top - S.top + y.top) / C.y,
    bottom: (S.bottom - b.bottom + y.bottom) / C.y,
    left: (b.left - S.left + y.left) / C.x,
    right: (S.right - b.right + y.right) / C.x
  };
}
const Ml = 50, Dl = async (e, t, n) => {
  const {
    placement: r = "bottom",
    strategy: o = "absolute",
    middleware: s = [],
    platform: i
  } = n, a = i.detectOverflow ? i : {
    ...i,
    detectOverflow: _l
  }, l = await (i.isRTL == null ? void 0 : i.isRTL(t));
  let f = await i.getElementRects({
    reference: e,
    floating: t,
    strategy: o
  }), {
    x: u,
    y: d
  } = Wr(f, r, l), m = r, v = 0;
  const y = {};
  for (let p = 0; p < s.length; p++) {
    const h = s[p];
    if (!h)
      continue;
    const {
      name: b,
      fn: x
    } = h, {
      x: w,
      y: C,
      data: S,
      reset: R
    } = await x({
      x: u,
      y: d,
      initialPlacement: r,
      placement: m,
      strategy: o,
      middlewareData: y,
      rects: f,
      platform: a,
      elements: {
        reference: e,
        floating: t
      }
    });
    u = w ?? u, d = C ?? d, y[b] = {
      ...y[b],
      ...S
    }, R && v < Ml && (v++, typeof R == "object" && (R.placement && (m = R.placement), R.rects && (f = R.rects === !0 ? await i.getElementRects({
      reference: e,
      floating: t,
      strategy: o
    }) : R.rects), {
      x: u,
      y: d
    } = Wr(f, m, l)), p = -1);
  }
  return {
    x: u,
    y: d,
    placement: m,
    strategy: o,
    middlewareData: y
  };
}, kl = (e) => ({
  name: "arrow",
  options: e,
  async fn(t) {
    const {
      x: n,
      y: r,
      placement: o,
      rects: s,
      platform: i,
      elements: a,
      middlewareData: l
    } = t, {
      element: f,
      padding: u = 0
    } = xe(e, t) || {};
    if (f == null)
      return {};
    const d = Fo(u), m = {
      x: n,
      y: r
    }, v = Un(o), y = zn(v), p = await i.getDimensions(f), h = v === "y", b = h ? "top" : "left", x = h ? "bottom" : "right", w = h ? "clientHeight" : "clientWidth", C = s.reference[y] + s.reference[v] - m[v] - s.floating[y], S = m[v] - s.reference[v], R = await (i.getOffsetParent == null ? void 0 : i.getOffsetParent(f));
    let E = R ? R[w] : 0;
    (!E || !await (i.isElement == null ? void 0 : i.isElement(R))) && (E = a.floating[w] || s.floating[y]);
    const T = C / 2 - S / 2, V = E / 2 - p[y] / 2 - 1, L = Ne(d[b], V), P = Ne(d[x], V), N = L, $ = E - p[y] - P, F = E / 2 - p[y] / 2 + T, z = Cn(N, F, $), I = !l.arrow && Je(o) != null && F !== z && s.reference[y] / 2 - (F < N ? L : P) - p[y] / 2 < 0, W = I ? F < N ? F - N : F - $ : 0;
    return {
      [v]: m[v] + W,
      data: {
        [v]: z,
        centerOffset: F - z - W,
        ...I && {
          alignmentOffset: W
        }
      },
      reset: I
    };
  }
}), Ll = function(e) {
  return e === void 0 && (e = {}), {
    name: "flip",
    options: e,
    async fn(t) {
      var n, r;
      const {
        placement: o,
        middlewareData: s,
        rects: i,
        initialPlacement: a,
        platform: l,
        elements: f
      } = t, {
        mainAxis: u = !0,
        crossAxis: d = !0,
        fallbackPlacements: m,
        fallbackStrategy: v = "bestFit",
        fallbackAxisSideDirection: y = "none",
        flipAlignment: p = !0,
        ...h
      } = xe(e, t);
      if ((n = s.arrow) != null && n.alignmentOffset)
        return {};
      const b = Ce(o), x = me(a), w = Ce(a) === a, C = await (l.isRTL == null ? void 0 : l.isRTL(f.floating)), S = m || (w || !p ? [kt(a)] : Pl(a)), R = y !== "none";
      !m && R && S.push(...Ol(a, p, y, C));
      const E = [a, ...S], T = await l.detectOverflow(t, h), V = [];
      let L = ((r = s.flip) == null ? void 0 : r.overflows) || [];
      if (u && V.push(T[b]), d) {
        const F = El(o, i, C);
        V.push(T[F[0]], T[F[1]]);
      }
      if (L = [...L, {
        placement: o,
        overflows: V
      }], !V.every((F) => F <= 0)) {
        var P, N;
        const F = (((P = s.flip) == null ? void 0 : P.index) || 0) + 1, z = E[F];
        if (z && (!(d === "alignment" ? x !== me(z) : !1) || // We leave the current main axis only if every placement on that axis
        // overflows the main axis.
        L.every((A) => me(A.placement) === x ? A.overflows[0] > 0 : !0)))
          return {
            data: {
              index: F,
              overflows: L
            },
            reset: {
              placement: z
            }
          };
        let I = (N = L.filter((W) => W.overflows[0] <= 0).sort((W, A) => W.overflows[1] - A.overflows[1])[0]) == null ? void 0 : N.placement;
        if (!I)
          switch (v) {
            case "bestFit": {
              var $;
              const W = ($ = L.filter((A) => {
                if (R) {
                  const B = me(A.placement);
                  return B === x || // Create a bias to the `y` side axis due to horizontal
                  // reading directions favoring greater width.
                  B === "y";
                }
                return !0;
              }).map((A) => [A.placement, A.overflows.filter((B) => B > 0).reduce((B, X) => B + X, 0)]).sort((A, B) => A[1] - B[1])[0]) == null ? void 0 : $[0];
              W && (I = W);
              break;
            }
            case "initialPlacement":
              I = a;
              break;
          }
        if (o !== I)
          return {
            reset: {
              placement: I
            }
          };
      }
      return {};
    }
  };
};
function Hr(e, t) {
  return {
    top: e.top - t.height,
    right: e.right - t.width,
    bottom: e.bottom - t.height,
    left: e.left - t.width
  };
}
function zr(e) {
  return Sl.some((t) => e[t] >= 0);
}
const Fl = function(e) {
  return e === void 0 && (e = {}), {
    name: "hide",
    options: e,
    async fn(t) {
      const {
        rects: n,
        platform: r
      } = t, {
        strategy: o = "referenceHidden",
        ...s
      } = xe(e, t);
      switch (o) {
        case "referenceHidden": {
          const i = await r.detectOverflow(t, {
            ...s,
            elementContext: "reference"
          }), a = Hr(i, n.reference);
          return {
            data: {
              referenceHiddenOffsets: a,
              referenceHidden: zr(a)
            }
          };
        }
        case "escaped": {
          const i = await r.detectOverflow(t, {
            ...s,
            altBoundary: !0
          }), a = Hr(i, n.floating);
          return {
            data: {
              escapedOffsets: a,
              escaped: zr(a)
            }
          };
        }
        default:
          return {};
      }
    }
  };
}, $o = /* @__PURE__ */ new Set(["left", "top"]);
async function $l(e, t) {
  const {
    placement: n,
    platform: r,
    elements: o
  } = e, s = await (r.isRTL == null ? void 0 : r.isRTL(o.floating)), i = Ce(n), a = Je(n), l = me(n) === "y", f = $o.has(i) ? -1 : 1, u = s && l ? -1 : 1, d = xe(t, e);
  let {
    mainAxis: m,
    crossAxis: v,
    alignmentAxis: y
  } = typeof d == "number" ? {
    mainAxis: d,
    crossAxis: 0,
    alignmentAxis: null
  } : {
    mainAxis: d.mainAxis || 0,
    crossAxis: d.crossAxis || 0,
    alignmentAxis: d.alignmentAxis
  };
  return a && typeof y == "number" && (v = a === "end" ? y * -1 : y), l ? {
    x: v * u,
    y: m * f
  } : {
    x: m * f,
    y: v * u
  };
}
const Vl = function(e) {
  return e === void 0 && (e = 0), {
    name: "offset",
    options: e,
    async fn(t) {
      var n, r;
      const {
        x: o,
        y: s,
        placement: i,
        middlewareData: a
      } = t, l = await $l(t, e);
      return i === ((n = a.offset) == null ? void 0 : n.placement) && (r = a.arrow) != null && r.alignmentOffset ? {} : {
        x: o + l.x,
        y: s + l.y,
        data: {
          ...l,
          placement: i
        }
      };
    }
  };
}, Bl = function(e) {
  return e === void 0 && (e = {}), {
    name: "shift",
    options: e,
    async fn(t) {
      const {
        x: n,
        y: r,
        placement: o,
        platform: s
      } = t, {
        mainAxis: i = !0,
        crossAxis: a = !1,
        limiter: l = {
          fn: (b) => {
            let {
              x,
              y: w
            } = b;
            return {
              x,
              y: w
            };
          }
        },
        ...f
      } = xe(e, t), u = {
        x: n,
        y: r
      }, d = await s.detectOverflow(t, f), m = me(Ce(o)), v = Hn(m);
      let y = u[v], p = u[m];
      if (i) {
        const b = v === "y" ? "top" : "left", x = v === "y" ? "bottom" : "right", w = y + d[b], C = y - d[x];
        y = Cn(w, y, C);
      }
      if (a) {
        const b = m === "y" ? "top" : "left", x = m === "y" ? "bottom" : "right", w = p + d[b], C = p - d[x];
        p = Cn(w, p, C);
      }
      const h = l.fn({
        ...t,
        [v]: y,
        [m]: p
      });
      return {
        ...h,
        data: {
          x: h.x - n,
          y: h.y - r,
          enabled: {
            [v]: i,
            [m]: a
          }
        }
      };
    }
  };
}, Wl = function(e) {
  return e === void 0 && (e = {}), {
    options: e,
    fn(t) {
      const {
        x: n,
        y: r,
        placement: o,
        rects: s,
        middlewareData: i
      } = t, {
        offset: a = 0,
        mainAxis: l = !0,
        crossAxis: f = !0
      } = xe(e, t), u = {
        x: n,
        y: r
      }, d = me(o), m = Hn(d);
      let v = u[m], y = u[d];
      const p = xe(a, t), h = typeof p == "number" ? {
        mainAxis: p,
        crossAxis: 0
      } : {
        mainAxis: 0,
        crossAxis: 0,
        ...p
      };
      if (l) {
        const w = m === "y" ? "height" : "width", C = s.reference[m] - s.floating[w] + h.mainAxis, S = s.reference[m] + s.reference[w] - h.mainAxis;
        v < C ? v = C : v > S && (v = S);
      }
      if (f) {
        var b, x;
        const w = m === "y" ? "width" : "height", C = $o.has(Ce(o)), S = s.reference[d] - s.floating[w] + (C && ((b = i.offset) == null ? void 0 : b[d]) || 0) + (C ? 0 : h.crossAxis), R = s.reference[d] + s.reference[w] + (C ? 0 : ((x = i.offset) == null ? void 0 : x[d]) || 0) - (C ? h.crossAxis : 0);
        y < S ? y = S : y > R && (y = R);
      }
      return {
        [m]: v,
        [d]: y
      };
    }
  };
}, Hl = function(e) {
  return e === void 0 && (e = {}), {
    name: "size",
    options: e,
    async fn(t) {
      var n, r;
      const {
        placement: o,
        rects: s,
        platform: i,
        elements: a
      } = t, {
        apply: l = () => {
        },
        ...f
      } = xe(e, t), u = await i.detectOverflow(t, f), d = Ce(o), m = Je(o), v = me(o) === "y", {
        width: y,
        height: p
      } = s.floating;
      let h, b;
      d === "top" || d === "bottom" ? (h = d, b = m === (await (i.isRTL == null ? void 0 : i.isRTL(a.floating)) ? "start" : "end") ? "left" : "right") : (b = d, h = m === "end" ? "top" : "bottom");
      const x = p - u.top - u.bottom, w = y - u.left - u.right, C = Ne(p - u[h], x), S = Ne(y - u[b], w), R = !t.middlewareData.shift;
      let E = C, T = S;
      if ((n = t.middlewareData.shift) != null && n.enabled.x && (T = w), (r = t.middlewareData.shift) != null && r.enabled.y && (E = x), R && !m) {
        const L = te(u.left, 0), P = te(u.right, 0), N = te(u.top, 0), $ = te(u.bottom, 0);
        v ? T = y - 2 * (L !== 0 || P !== 0 ? L + P : te(u.left, u.right)) : E = p - 2 * (N !== 0 || $ !== 0 ? N + $ : te(u.top, u.bottom));
      }
      await l({
        ...t,
        availableWidth: T,
        availableHeight: E
      });
      const V = await i.getDimensions(a.floating);
      return y !== V.width || p !== V.height ? {
        reset: {
          rects: !0
        }
      } : {};
    }
  };
};
function jt() {
  return typeof window < "u";
}
function et(e) {
  return Vo(e) ? (e.nodeName || "").toLowerCase() : "#document";
}
function ne(e) {
  var t;
  return (e == null || (t = e.ownerDocument) == null ? void 0 : t.defaultView) || window;
}
function ye(e) {
  var t;
  return (t = (Vo(e) ? e.ownerDocument : e.document) || window.document) == null ? void 0 : t.documentElement;
}
function Vo(e) {
  return jt() ? e instanceof Node || e instanceof ne(e).Node : !1;
}
function ce(e) {
  return jt() ? e instanceof Element || e instanceof ne(e).Element : !1;
}
function Se(e) {
  return jt() ? e instanceof HTMLElement || e instanceof ne(e).HTMLElement : !1;
}
function Ur(e) {
  return !jt() || typeof ShadowRoot > "u" ? !1 : e instanceof ShadowRoot || e instanceof ne(e).ShadowRoot;
}
function bt(e) {
  const {
    overflow: t,
    overflowX: n,
    overflowY: r,
    display: o
  } = le(e);
  return /auto|scroll|overlay|hidden|clip/.test(t + r + n) && o !== "inline" && o !== "contents";
}
function zl(e) {
  return /^(table|td|th)$/.test(et(e));
}
function Kt(e) {
  try {
    if (e.matches(":popover-open"))
      return !0;
  } catch {
  }
  try {
    return e.matches(":modal");
  } catch {
    return !1;
  }
}
const Ul = /transform|translate|scale|rotate|perspective|filter/, Gl = /paint|layout|strict|content/, De = (e) => !!e && e !== "none";
let pn;
function Gn(e) {
  const t = ce(e) ? le(e) : e;
  return De(t.transform) || De(t.translate) || De(t.scale) || De(t.rotate) || De(t.perspective) || !jn() && (De(t.backdropFilter) || De(t.filter)) || Ul.test(t.willChange || "") || Gl.test(t.contain || "");
}
function jl(e) {
  let t = Te(e);
  for (; Se(t) && !Xe(t); ) {
    if (Gn(t))
      return t;
    if (Kt(t))
      return null;
    t = Te(t);
  }
  return null;
}
function jn() {
  return pn == null && (pn = typeof CSS < "u" && CSS.supports && CSS.supports("-webkit-backdrop-filter", "none")), pn;
}
function Xe(e) {
  return /^(html|body|#document)$/.test(et(e));
}
function le(e) {
  return ne(e).getComputedStyle(e);
}
function Yt(e) {
  return ce(e) ? {
    scrollLeft: e.scrollLeft,
    scrollTop: e.scrollTop
  } : {
    scrollLeft: e.scrollX,
    scrollTop: e.scrollY
  };
}
function Te(e) {
  if (et(e) === "html")
    return e;
  const t = (
    // Step into the shadow DOM of the parent of a slotted node.
    e.assignedSlot || // DOM Element detected.
    e.parentNode || // ShadowRoot detected.
    Ur(e) && e.host || // Fallback.
    ye(e)
  );
  return Ur(t) ? t.host : t;
}
function Bo(e) {
  const t = Te(e);
  return Xe(t) ? e.ownerDocument ? e.ownerDocument.body : e.body : Se(t) && bt(t) ? t : Bo(t);
}
function ct(e, t, n) {
  var r;
  t === void 0 && (t = []), n === void 0 && (n = !0);
  const o = Bo(e), s = o === ((r = e.ownerDocument) == null ? void 0 : r.body), i = ne(o);
  if (s) {
    const a = Rn(i);
    return t.concat(i, i.visualViewport || [], bt(o) ? o : [], a && n ? ct(a) : []);
  } else
    return t.concat(o, ct(o, [], n));
}
function Rn(e) {
  return e.parent && Object.getPrototypeOf(e.parent) ? e.frameElement : null;
}
function Wo(e) {
  const t = le(e);
  let n = parseFloat(t.width) || 0, r = parseFloat(t.height) || 0;
  const o = Se(e), s = o ? e.offsetWidth : n, i = o ? e.offsetHeight : r, a = Dt(n) !== s || Dt(r) !== i;
  return a && (n = s, r = i), {
    width: n,
    height: r,
    $: a
  };
}
function Kn(e) {
  return ce(e) ? e : e.contextElement;
}
function Ke(e) {
  const t = Kn(e);
  if (!Se(t))
    return ve(1);
  const n = t.getBoundingClientRect(), {
    width: r,
    height: o,
    $: s
  } = Wo(t);
  let i = (s ? Dt(n.width) : n.width) / r, a = (s ? Dt(n.height) : n.height) / o;
  return (!i || !Number.isFinite(i)) && (i = 1), (!a || !Number.isFinite(a)) && (a = 1), {
    x: i,
    y: a
  };
}
const Kl = /* @__PURE__ */ ve(0);
function Ho(e) {
  const t = ne(e);
  return !jn() || !t.visualViewport ? Kl : {
    x: t.visualViewport.offsetLeft,
    y: t.visualViewport.offsetTop
  };
}
function Yl(e, t, n) {
  return t === void 0 && (t = !1), !n || t && n !== ne(e) ? !1 : t;
}
function Fe(e, t, n, r) {
  t === void 0 && (t = !1), n === void 0 && (n = !1);
  const o = e.getBoundingClientRect(), s = Kn(e);
  let i = ve(1);
  t && (r ? ce(r) && (i = Ke(r)) : i = Ke(e));
  const a = Yl(s, n, r) ? Ho(s) : ve(0);
  let l = (o.left + a.x) / i.x, f = (o.top + a.y) / i.y, u = o.width / i.x, d = o.height / i.y;
  if (s) {
    const m = ne(s), v = r && ce(r) ? ne(r) : r;
    let y = m, p = Rn(y);
    for (; p && r && v !== y; ) {
      const h = Ke(p), b = p.getBoundingClientRect(), x = le(p), w = b.left + (p.clientLeft + parseFloat(x.paddingLeft)) * h.x, C = b.top + (p.clientTop + parseFloat(x.paddingTop)) * h.y;
      l *= h.x, f *= h.y, u *= h.x, d *= h.y, l += w, f += C, y = ne(p), p = Rn(y);
    }
  }
  return Lt({
    width: u,
    height: d,
    x: l,
    y: f
  });
}
function Xt(e, t) {
  const n = Yt(e).scrollLeft;
  return t ? t.left + n : Fe(ye(e)).left + n;
}
function zo(e, t) {
  const n = e.getBoundingClientRect(), r = n.left + t.scrollLeft - Xt(e, n), o = n.top + t.scrollTop;
  return {
    x: r,
    y: o
  };
}
function Xl(e) {
  let {
    elements: t,
    rect: n,
    offsetParent: r,
    strategy: o
  } = e;
  const s = o === "fixed", i = ye(r), a = t ? Kt(t.floating) : !1;
  if (r === i || a && s)
    return n;
  let l = {
    scrollLeft: 0,
    scrollTop: 0
  }, f = ve(1);
  const u = ve(0), d = Se(r);
  if ((d || !d && !s) && ((et(r) !== "body" || bt(i)) && (l = Yt(r)), d)) {
    const v = Fe(r);
    f = Ke(r), u.x = v.x + r.clientLeft, u.y = v.y + r.clientTop;
  }
  const m = i && !d && !s ? zo(i, l) : ve(0);
  return {
    width: n.width * f.x,
    height: n.height * f.y,
    x: n.x * f.x - l.scrollLeft * f.x + u.x + m.x,
    y: n.y * f.y - l.scrollTop * f.y + u.y + m.y
  };
}
function ql(e) {
  return Array.from(e.getClientRects());
}
function Zl(e) {
  const t = ye(e), n = Yt(e), r = e.ownerDocument.body, o = te(t.scrollWidth, t.clientWidth, r.scrollWidth, r.clientWidth), s = te(t.scrollHeight, t.clientHeight, r.scrollHeight, r.clientHeight);
  let i = -n.scrollLeft + Xt(e);
  const a = -n.scrollTop;
  return le(r).direction === "rtl" && (i += te(t.clientWidth, r.clientWidth) - o), {
    width: o,
    height: s,
    x: i,
    y: a
  };
}
const Gr = 25;
function Ql(e, t) {
  const n = ne(e), r = ye(e), o = n.visualViewport;
  let s = r.clientWidth, i = r.clientHeight, a = 0, l = 0;
  if (o) {
    s = o.width, i = o.height;
    const u = jn();
    (!u || u && t === "fixed") && (a = o.offsetLeft, l = o.offsetTop);
  }
  const f = Xt(r);
  if (f <= 0) {
    const u = r.ownerDocument, d = u.body, m = getComputedStyle(d), v = u.compatMode === "CSS1Compat" && parseFloat(m.marginLeft) + parseFloat(m.marginRight) || 0, y = Math.abs(r.clientWidth - d.clientWidth - v);
    y <= Gr && (s -= y);
  } else f <= Gr && (s += f);
  return {
    width: s,
    height: i,
    x: a,
    y: l
  };
}
function Jl(e, t) {
  const n = Fe(e, !0, t === "fixed"), r = n.top + e.clientTop, o = n.left + e.clientLeft, s = Se(e) ? Ke(e) : ve(1), i = e.clientWidth * s.x, a = e.clientHeight * s.y, l = o * s.x, f = r * s.y;
  return {
    width: i,
    height: a,
    x: l,
    y: f
  };
}
function jr(e, t, n) {
  let r;
  if (t === "viewport")
    r = Ql(e, n);
  else if (t === "document")
    r = Zl(ye(e));
  else if (ce(t))
    r = Jl(t, n);
  else {
    const o = Ho(e);
    r = {
      x: t.x - o.x,
      y: t.y - o.y,
      width: t.width,
      height: t.height
    };
  }
  return Lt(r);
}
function Uo(e, t) {
  const n = Te(e);
  return n === t || !ce(n) || Xe(n) ? !1 : le(n).position === "fixed" || Uo(n, t);
}
function eu(e, t) {
  const n = t.get(e);
  if (n)
    return n;
  let r = ct(e, [], !1).filter((a) => ce(a) && et(a) !== "body"), o = null;
  const s = le(e).position === "fixed";
  let i = s ? Te(e) : e;
  for (; ce(i) && !Xe(i); ) {
    const a = le(i), l = Gn(i);
    !l && a.position === "fixed" && (o = null), (s ? !l && !o : !l && a.position === "static" && !!o && (o.position === "absolute" || o.position === "fixed") || bt(i) && !l && Uo(e, i)) ? r = r.filter((u) => u !== i) : o = a, i = Te(i);
  }
  return t.set(e, r), r;
}
function tu(e) {
  let {
    element: t,
    boundary: n,
    rootBoundary: r,
    strategy: o
  } = e;
  const i = [...n === "clippingAncestors" ? Kt(t) ? [] : eu(t, this._c) : [].concat(n), r], a = jr(t, i[0], o);
  let l = a.top, f = a.right, u = a.bottom, d = a.left;
  for (let m = 1; m < i.length; m++) {
    const v = jr(t, i[m], o);
    l = te(v.top, l), f = Ne(v.right, f), u = Ne(v.bottom, u), d = te(v.left, d);
  }
  return {
    width: f - d,
    height: u - l,
    x: d,
    y: l
  };
}
function nu(e) {
  const {
    width: t,
    height: n
  } = Wo(e);
  return {
    width: t,
    height: n
  };
}
function ru(e, t, n) {
  const r = Se(t), o = ye(t), s = n === "fixed", i = Fe(e, !0, s, t);
  let a = {
    scrollLeft: 0,
    scrollTop: 0
  };
  const l = ve(0);
  function f() {
    l.x = Xt(o);
  }
  if (r || !r && !s)
    if ((et(t) !== "body" || bt(o)) && (a = Yt(t)), r) {
      const v = Fe(t, !0, s, t);
      l.x = v.x + t.clientLeft, l.y = v.y + t.clientTop;
    } else o && f();
  s && !r && o && f();
  const u = o && !r && !s ? zo(o, a) : ve(0), d = i.left + a.scrollLeft - l.x - u.x, m = i.top + a.scrollTop - l.y - u.y;
  return {
    x: d,
    y: m,
    width: i.width,
    height: i.height
  };
}
function mn(e) {
  return le(e).position === "static";
}
function Kr(e, t) {
  if (!Se(e) || le(e).position === "fixed")
    return null;
  if (t)
    return t(e);
  let n = e.offsetParent;
  return ye(e) === n && (n = n.ownerDocument.body), n;
}
function Go(e, t) {
  const n = ne(e);
  if (Kt(e))
    return n;
  if (!Se(e)) {
    let o = Te(e);
    for (; o && !Xe(o); ) {
      if (ce(o) && !mn(o))
        return o;
      o = Te(o);
    }
    return n;
  }
  let r = Kr(e, t);
  for (; r && zl(r) && mn(r); )
    r = Kr(r, t);
  return r && Xe(r) && mn(r) && !Gn(r) ? n : r || jl(e) || n;
}
const ou = async function(e) {
  const t = this.getOffsetParent || Go, n = this.getDimensions, r = await n(e.floating);
  return {
    reference: ru(e.reference, await t(e.floating), e.strategy),
    floating: {
      x: 0,
      y: 0,
      width: r.width,
      height: r.height
    }
  };
};
function su(e) {
  return le(e).direction === "rtl";
}
const iu = {
  convertOffsetParentRelativeRectToViewportRelativeRect: Xl,
  getDocumentElement: ye,
  getClippingRect: tu,
  getOffsetParent: Go,
  getElementRects: ou,
  getClientRects: ql,
  getDimensions: nu,
  getScale: Ke,
  isElement: ce,
  isRTL: su
};
function jo(e, t) {
  return e.x === t.x && e.y === t.y && e.width === t.width && e.height === t.height;
}
function au(e, t) {
  let n = null, r;
  const o = ye(e);
  function s() {
    var a;
    clearTimeout(r), (a = n) == null || a.disconnect(), n = null;
  }
  function i(a, l) {
    a === void 0 && (a = !1), l === void 0 && (l = 1), s();
    const f = e.getBoundingClientRect(), {
      left: u,
      top: d,
      width: m,
      height: v
    } = f;
    if (a || t(), !m || !v)
      return;
    const y = At(d), p = At(o.clientWidth - (u + m)), h = At(o.clientHeight - (d + v)), b = At(u), w = {
      rootMargin: -y + "px " + -p + "px " + -h + "px " + -b + "px",
      threshold: te(0, Ne(1, l)) || 1
    };
    let C = !0;
    function S(R) {
      const E = R[0].intersectionRatio;
      if (E !== l) {
        if (!C)
          return i();
        E ? i(!1, E) : r = setTimeout(() => {
          i(!1, 1e-7);
        }, 1e3);
      }
      E === 1 && !jo(f, e.getBoundingClientRect()) && i(), C = !1;
    }
    try {
      n = new IntersectionObserver(S, {
        ...w,
        // Handle <iframe>s
        root: o.ownerDocument
      });
    } catch {
      n = new IntersectionObserver(S, w);
    }
    n.observe(e);
  }
  return i(!0), s;
}
function cu(e, t, n, r) {
  r === void 0 && (r = {});
  const {
    ancestorScroll: o = !0,
    ancestorResize: s = !0,
    elementResize: i = typeof ResizeObserver == "function",
    layoutShift: a = typeof IntersectionObserver == "function",
    animationFrame: l = !1
  } = r, f = Kn(e), u = o || s ? [...f ? ct(f) : [], ...t ? ct(t) : []] : [];
  u.forEach((b) => {
    o && b.addEventListener("scroll", n, {
      passive: !0
    }), s && b.addEventListener("resize", n);
  });
  const d = f && a ? au(f, n) : null;
  let m = -1, v = null;
  i && (v = new ResizeObserver((b) => {
    let [x] = b;
    x && x.target === f && v && t && (v.unobserve(t), cancelAnimationFrame(m), m = requestAnimationFrame(() => {
      var w;
      (w = v) == null || w.observe(t);
    })), n();
  }), f && !l && v.observe(f), t && v.observe(t));
  let y, p = l ? Fe(e) : null;
  l && h();
  function h() {
    const b = Fe(e);
    p && !jo(p, b) && n(), p = b, y = requestAnimationFrame(h);
  }
  return n(), () => {
    var b;
    u.forEach((x) => {
      o && x.removeEventListener("scroll", n), s && x.removeEventListener("resize", n);
    }), d == null || d(), (b = v) == null || b.disconnect(), v = null, l && cancelAnimationFrame(y);
  };
}
const lu = Vl, uu = Bl, du = Ll, fu = Hl, pu = Fl, Yr = kl, mu = Wl, gu = (e, t, n) => {
  const r = /* @__PURE__ */ new Map(), o = {
    platform: iu,
    ...n
  }, s = {
    ...o.platform,
    _c: r
  };
  return Dl(e, t, {
    ...o,
    platform: s
  });
};
var vu = typeof document < "u", hu = function() {
}, _t = vu ? _i : hu;
function Ft(e, t) {
  if (e === t)
    return !0;
  if (typeof e != typeof t)
    return !1;
  if (typeof e == "function" && e.toString() === t.toString())
    return !0;
  let n, r, o;
  if (e && t && typeof e == "object") {
    if (Array.isArray(e)) {
      if (n = e.length, n !== t.length) return !1;
      for (r = n; r-- !== 0; )
        if (!Ft(e[r], t[r]))
          return !1;
      return !0;
    }
    if (o = Object.keys(e), n = o.length, n !== Object.keys(t).length)
      return !1;
    for (r = n; r-- !== 0; )
      if (!{}.hasOwnProperty.call(t, o[r]))
        return !1;
    for (r = n; r-- !== 0; ) {
      const s = o[r];
      if (!(s === "_owner" && e.$$typeof) && !Ft(e[s], t[s]))
        return !1;
    }
    return !0;
  }
  return e !== e && t !== t;
}
function Ko(e) {
  return typeof window > "u" ? 1 : (e.ownerDocument.defaultView || window).devicePixelRatio || 1;
}
function Xr(e, t) {
  const n = Ko(e);
  return Math.round(t * n) / n;
}
function gn(e) {
  const t = c.useRef(e);
  return _t(() => {
    t.current = e;
  }), t;
}
function bu(e) {
  e === void 0 && (e = {});
  const {
    placement: t = "bottom",
    strategy: n = "absolute",
    middleware: r = [],
    platform: o,
    elements: {
      reference: s,
      floating: i
    } = {},
    transform: a = !0,
    whileElementsMounted: l,
    open: f
  } = e, [u, d] = c.useState({
    x: 0,
    y: 0,
    strategy: n,
    placement: t,
    middlewareData: {},
    isPositioned: !1
  }), [m, v] = c.useState(r);
  Ft(m, r) || v(r);
  const [y, p] = c.useState(null), [h, b] = c.useState(null), x = c.useCallback((A) => {
    A !== R.current && (R.current = A, p(A));
  }, []), w = c.useCallback((A) => {
    A !== E.current && (E.current = A, b(A));
  }, []), C = s || y, S = i || h, R = c.useRef(null), E = c.useRef(null), T = c.useRef(u), V = l != null, L = gn(l), P = gn(o), N = gn(f), $ = c.useCallback(() => {
    if (!R.current || !E.current)
      return;
    const A = {
      placement: t,
      strategy: n,
      middleware: m
    };
    P.current && (A.platform = P.current), gu(R.current, E.current, A).then((B) => {
      const X = {
        ...B,
        // The floating element's position may be recomputed while it's closed
        // but still mounted (such as when transitioning out). To ensure
        // `isPositioned` will be `false` initially on the next open, avoid
        // setting it to `true` when `open === false` (must be specified).
        isPositioned: N.current !== !1
      };
      F.current && !Ft(T.current, X) && (T.current = X, ut.flushSync(() => {
        d(X);
      }));
    });
  }, [m, t, n, P, N]);
  _t(() => {
    f === !1 && T.current.isPositioned && (T.current.isPositioned = !1, d((A) => ({
      ...A,
      isPositioned: !1
    })));
  }, [f]);
  const F = c.useRef(!1);
  _t(() => (F.current = !0, () => {
    F.current = !1;
  }), []), _t(() => {
    if (C && (R.current = C), S && (E.current = S), C && S) {
      if (L.current)
        return L.current(C, S, $);
      $();
    }
  }, [C, S, $, L, V]);
  const z = c.useMemo(() => ({
    reference: R,
    floating: E,
    setReference: x,
    setFloating: w
  }), [x, w]), I = c.useMemo(() => ({
    reference: C,
    floating: S
  }), [C, S]), W = c.useMemo(() => {
    const A = {
      position: n,
      left: 0,
      top: 0
    };
    if (!I.floating)
      return A;
    const B = Xr(I.floating, u.x), X = Xr(I.floating, u.y);
    return a ? {
      ...A,
      transform: "translate(" + B + "px, " + X + "px)",
      ...Ko(I.floating) >= 1.5 && {
        willChange: "transform"
      }
    } : {
      position: n,
      left: B,
      top: X
    };
  }, [n, a, I.floating, u.x, u.y]);
  return c.useMemo(() => ({
    ...u,
    update: $,
    refs: z,
    elements: I,
    floatingStyles: W
  }), [u, $, z, I, W]);
}
const yu = (e) => {
  function t(n) {
    return {}.hasOwnProperty.call(n, "current");
  }
  return {
    name: "arrow",
    options: e,
    fn(n) {
      const {
        element: r,
        padding: o
      } = typeof e == "function" ? e(n) : e;
      return r && t(r) ? r.current != null ? Yr({
        element: r.current,
        padding: o
      }).fn(n) : {} : r ? Yr({
        element: r,
        padding: o
      }).fn(n) : {};
    }
  };
}, wu = (e, t) => {
  const n = lu(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, xu = (e, t) => {
  const n = uu(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Cu = (e, t) => ({
  fn: mu(e).fn,
  options: [e, t]
}), Su = (e, t) => {
  const n = du(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Ru = (e, t) => {
  const n = fu(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Eu = (e, t) => {
  const n = pu(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Pu = (e, t) => {
  const n = yu(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
};
var Nu = "Arrow", Yo = c.forwardRef((e, t) => {
  const { children: n, width: r = 10, height: o = 5, ...s } = e;
  return /* @__PURE__ */ g(
    M.svg,
    {
      ...s,
      ref: t,
      width: r,
      height: o,
      viewBox: "0 0 30 10",
      preserveAspectRatio: "none",
      children: e.asChild ? n : /* @__PURE__ */ g("polygon", { points: "0,0 30,0 15,10" })
    }
  );
});
Yo.displayName = Nu;
var Tu = Yo;
function Au(e) {
  const [t, n] = c.useState(void 0);
  return Z(() => {
    if (e) {
      n({ width: e.offsetWidth, height: e.offsetHeight });
      const r = new ResizeObserver((o) => {
        if (!Array.isArray(o) || !o.length)
          return;
        const s = o[0];
        let i, a;
        if ("borderBoxSize" in s) {
          const l = s.borderBoxSize, f = Array.isArray(l) ? l[0] : l;
          i = f.inlineSize, a = f.blockSize;
        } else
          i = e.offsetWidth, a = e.offsetHeight;
        n({ width: i, height: a });
      });
      return r.observe(e, { box: "border-box" }), () => r.unobserve(e);
    } else
      n(void 0);
  }, [e]), t;
}
var Yn = "Popper", [Xo, tt] = he(Yn), [Ou, qo] = Xo(Yn), Zo = (e) => {
  const { __scopePopper: t, children: n } = e, [r, o] = c.useState(null), [s, i] = c.useState(void 0);
  return /* @__PURE__ */ g(
    Ou,
    {
      scope: t,
      anchor: r,
      onAnchorChange: o,
      placementState: s,
      setPlacementState: i,
      children: n
    }
  );
};
Zo.displayName = Yn;
var Qo = "PopperAnchor", Jo = c.forwardRef(
  (e, t) => {
    const { __scopePopper: n, virtualRef: r, ...o } = e, s = qo(Qo, n), i = c.useRef(null), a = s.onAnchorChange, l = c.useCallback(
      (y) => {
        i.current = y, y && a(y);
      },
      [a]
    ), f = j(t, l), u = c.useRef(null);
    c.useEffect(() => {
      if (!r)
        return;
      const y = u.current;
      u.current = r.current, y !== u.current && a(u.current);
    });
    const d = s.placementState && qn(s.placementState), m = d == null ? void 0 : d[0], v = d == null ? void 0 : d[1];
    return r ? null : /* @__PURE__ */ g(
      M.div,
      {
        "data-radix-popper-side": m,
        "data-radix-popper-align": v,
        ...o,
        ref: f
      }
    );
  }
);
Jo.displayName = Qo;
var Xn = "PopperContent", [Iu, _u] = Xo(Xn), es = c.forwardRef(
  (e, t) => {
    var K, ee, G, H, U, de;
    const {
      __scopePopper: n,
      side: r = "bottom",
      sideOffset: o = 0,
      align: s = "center",
      alignOffset: i = 0,
      arrowPadding: a = 0,
      avoidCollisions: l = !0,
      collisionBoundary: f = [],
      collisionPadding: u = 0,
      sticky: d = "partial",
      hideWhenDetached: m = !1,
      updatePositionStrategy: v = "optimized",
      onPlaced: y,
      ...p
    } = e, h = qo(Xn, n), [b, x] = c.useState(null), w = j(t, x), [C, S] = c.useState(null), R = Au(C), E = (R == null ? void 0 : R.width) ?? 0, T = (R == null ? void 0 : R.height) ?? 0, V = r + (s !== "center" ? "-" + s : ""), L = typeof u == "number" ? u : { top: 0, right: 0, bottom: 0, left: 0, ...u }, P = Array.isArray(f) ? f : [f], N = P.length > 0, $ = {
      padding: L,
      boundary: P.filter(Du),
      // with `strategy: 'fixed'`, this is the only way to get it to respect boundaries
      altBoundary: N
    }, { refs: F, floatingStyles: z, placement: I, isPositioned: W, middlewareData: A } = bu({
      // default to `fixed` strategy so users don't have to pick and we also avoid focus scroll issues
      strategy: "fixed",
      placement: V,
      whileElementsMounted: (...se) => cu(...se, {
        animationFrame: v === "always"
      }),
      elements: {
        reference: h.anchor
      },
      middleware: [
        wu({ mainAxis: o + T, alignmentAxis: i }),
        l && xu({
          mainAxis: !0,
          crossAxis: !1,
          limiter: d === "partial" ? Cu() : void 0,
          ...$
        }),
        l && Su({ ...$ }),
        Ru({
          ...$,
          apply: ({ elements: se, rects: We, availableWidth: nt, availableHeight: rt }) => {
            const { width: Ai, height: Oi } = We.reference, Ct = se.floating.style;
            Ct.setProperty("--radix-popper-available-width", `${nt}px`), Ct.setProperty("--radix-popper-available-height", `${rt}px`), Ct.setProperty("--radix-popper-anchor-width", `${Ai}px`), Ct.setProperty("--radix-popper-anchor-height", `${Oi}px`);
          }
        }),
        C && Pu({ element: C, padding: a }),
        ku({ arrowWidth: E, arrowHeight: T }),
        m && Eu({
          strategy: "referenceHidden",
          ...$,
          // `hide` detects whether the anchor (reference) is clipped, so when
          // no explicit `collisionBoundary` is set we fall back to Floating
          // UI's default clipping ancestors (e.g. a scrollable menu). This
          // lets an occluded submenu hide once its anchor scrolls out of view
          // (#3237). The collision/size middlewares deliberately keep the
          // viewport-based default to avoid clamping content rendered inside
          // transformed or overflow-clipping portal containers.
          boundary: N ? $.boundary : void 0
        })
      ]
    }), B = h.setPlacementState;
    Z(() => (B(I), () => {
      B(void 0);
    }), [I, B]);
    const [X, q] = qn(I), Q = ae(y);
    Z(() => {
      W && (Q == null || Q());
    }, [W, Q]);
    const re = (K = A.arrow) == null ? void 0 : K.x, oe = (ee = A.arrow) == null ? void 0 : ee.y, Be = ((G = A.arrow) == null ? void 0 : G.centerOffset) !== 0, [Me, D] = c.useState();
    return Z(() => {
      b && D(window.getComputedStyle(b).zIndex);
    }, [b]), /* @__PURE__ */ g(
      "div",
      {
        ref: F.setFloating,
        "data-radix-popper-content-wrapper": "",
        style: {
          ...z,
          transform: W ? z.transform : "translate(0, -200%)",
          // keep off the page when measuring
          minWidth: "max-content",
          zIndex: Me,
          "--radix-popper-transform-origin": [
            (H = A.transformOrigin) == null ? void 0 : H.x,
            (U = A.transformOrigin) == null ? void 0 : U.y
          ].join(" "),
          // hide the content if using the hide middleware and should be hidden
          // set visibility to hidden and disable pointer events so the UI behaves
          // as if the PopperContent isn't there at all
          ...((de = A.hide) == null ? void 0 : de.referenceHidden) && {
            visibility: "hidden",
            pointerEvents: "none"
          }
        },
        dir: e.dir,
        children: /* @__PURE__ */ g(
          Iu,
          {
            scope: n,
            placedSide: X,
            placedAlign: q,
            onArrowChange: S,
            arrowX: re,
            arrowY: oe,
            shouldHideArrow: Be,
            children: /* @__PURE__ */ g(
              M.div,
              {
                "data-side": X,
                "data-align": q,
                ...p,
                ref: w,
                style: {
                  ...p.style,
                  // if the PopperContent hasn't been placed yet (not all measurements done)
                  // we prevent animations so that users's animation don't kick in too early referring wrong sides
                  animation: W ? void 0 : "none"
                }
              }
            )
          }
        )
      }
    );
  }
);
es.displayName = Xn;
var ts = "PopperArrow", Mu = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right"
}, ns = c.forwardRef(function(t, n) {
  const { __scopePopper: r, ...o } = t, s = _u(ts, r), i = Mu[s.placedSide];
  return (
    // we have to use an extra wrapper because `ResizeObserver` (used by `useSize`)
    // doesn't report size as we'd expect on SVG elements.
    // it reports their bounding box which is effectively the largest path inside the SVG.
    /* @__PURE__ */ g(
      "span",
      {
        ref: s.onArrowChange,
        style: {
          position: "absolute",
          left: s.arrowX,
          top: s.arrowY,
          [i]: 0,
          transformOrigin: {
            top: "",
            right: "0 0",
            bottom: "center 0",
            left: "100% 0"
          }[s.placedSide],
          transform: {
            top: "translateY(100%)",
            right: "translateY(50%) rotate(90deg) translateX(-50%)",
            bottom: "rotate(180deg)",
            left: "translateY(50%) rotate(-90deg) translateX(50%)"
          }[s.placedSide],
          visibility: s.shouldHideArrow ? "hidden" : void 0
        },
        children: /* @__PURE__ */ g(
          Tu,
          {
            ...o,
            ref: n,
            style: {
              ...o.style,
              // ensures the element can be measured correctly (mostly for if SVG)
              display: "block"
            }
          }
        )
      }
    )
  );
});
ns.displayName = ts;
function Du(e) {
  return e !== null;
}
var ku = (e) => ({
  name: "transformOrigin",
  options: e,
  fn(t) {
    var h, b, x;
    const { placement: n, rects: r, middlewareData: o } = t, i = ((h = o.arrow) == null ? void 0 : h.centerOffset) !== 0, a = i ? 0 : e.arrowWidth, l = i ? 0 : e.arrowHeight, [f, u] = qn(n), d = { start: "0%", center: "50%", end: "100%" }[u], m = (((b = o.arrow) == null ? void 0 : b.x) ?? 0) + a / 2, v = (((x = o.arrow) == null ? void 0 : x.y) ?? 0) + l / 2;
    let y = "", p = "";
    return f === "bottom" ? (y = i ? d : `${m}px`, p = `${-l}px`) : f === "top" ? (y = i ? d : `${m}px`, p = `${r.floating.height + l}px`) : f === "right" ? (y = `${-l}px`, p = i ? d : `${v}px`) : f === "left" && (y = `${r.floating.width + l}px`, p = i ? d : `${v}px`), { data: { x: y, y: p } };
  }
});
function qn(e) {
  const [t, n = "center"] = e.split("-");
  return [t, n];
}
var Zn = Zo, qt = Jo, Qn = es, Jn = ns, Zt = "Popover", [rs] = he(Zt, [
  tt
]), yt = tt(), [Lu, Oe] = rs(Zt), os = (e) => {
  const {
    __scopePopover: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    modal: i = !1
  } = e, a = yt(t), l = c.useRef(null), [f, u] = c.useState(!1), [d, m] = Le({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: Zt
  });
  return /* @__PURE__ */ g(Zn, { ...a, children: /* @__PURE__ */ g(
    Lu,
    {
      scope: t,
      contentId: ge(),
      triggerRef: l,
      open: d,
      onOpenChange: m,
      onOpenToggle: c.useCallback(() => m((v) => !v), [m]),
      hasCustomAnchor: f,
      onCustomAnchorAdd: c.useCallback(() => u(!0), []),
      onCustomAnchorRemove: c.useCallback(() => u(!1), []),
      modal: i,
      children: n
    }
  ) });
};
os.displayName = Zt;
var ss = "PopoverAnchor", is = c.forwardRef(
  (e, t) => {
    const { __scopePopover: n, ...r } = e, o = Oe(ss, n), s = yt(n), { onCustomAnchorAdd: i, onCustomAnchorRemove: a } = o;
    return c.useEffect(() => (i(), () => a()), [i, a]), /* @__PURE__ */ g(qt, { ...s, ...r, ref: t });
  }
);
is.displayName = ss;
var as = "PopoverTrigger", cs = c.forwardRef(
  (e, t) => {
    const { __scopePopover: n, ...r } = e, o = Oe(as, n), s = yt(n), i = j(t, o.triggerRef), a = /* @__PURE__ */ g(
      M.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": o.open,
        "aria-controls": o.open ? o.contentId : void 0,
        "data-state": ps(o.open),
        ...r,
        ref: i,
        onClick: O(e.onClick, o.onOpenToggle)
      }
    );
    return o.hasCustomAnchor ? a : /* @__PURE__ */ g(qt, { asChild: !0, ...s, children: a });
  }
);
cs.displayName = as;
var er = "PopoverPortal", [Fu, $u] = rs(er, {
  forceMount: void 0
}), ls = (e) => {
  const { __scopePopover: t, forceMount: n, children: r, container: o } = e, s = Oe(er, t);
  return /* @__PURE__ */ g(Fu, { scope: t, forceMount: n, children: /* @__PURE__ */ g(be, { present: n || s.open, children: /* @__PURE__ */ g(ft, { asChild: !0, container: o, children: r }) }) });
};
ls.displayName = er;
var qe = "PopoverContent", us = c.forwardRef(
  (e, t) => {
    const n = $u(qe, e.__scopePopover), { forceMount: r = n.forceMount, ...o } = e, s = Oe(qe, e.__scopePopover);
    return /* @__PURE__ */ g(be, { present: r || s.open, children: s.modal ? /* @__PURE__ */ g(Bu, { ...o, ref: t }) : /* @__PURE__ */ g(Wu, { ...o, ref: t }) });
  }
);
us.displayName = qe;
var Vu = /* @__PURE__ */ ke("PopoverContent.RemoveScroll"), Bu = c.forwardRef(
  (e, t) => {
    const n = Oe(qe, e.__scopePopover), r = c.useRef(null), o = j(t, r), s = c.useRef(!1);
    return c.useEffect(() => {
      const i = r.current;
      if (i) return Ln(i);
    }, []), /* @__PURE__ */ g(zt, { as: Vu, allowPinchZoom: !0, children: /* @__PURE__ */ g(
      ds,
      {
        ...e,
        ref: o,
        trapFocus: n.open,
        disableOutsidePointerEvents: !0,
        onCloseAutoFocus: O(e.onCloseAutoFocus, (i) => {
          var a;
          i.preventDefault(), s.current || (a = n.triggerRef.current) == null || a.focus();
        }),
        onPointerDownOutside: O(
          e.onPointerDownOutside,
          (i) => {
            const a = i.detail.originalEvent, l = a.button === 0 && a.ctrlKey === !0, f = a.button === 2 || l;
            s.current = f;
          },
          { checkForDefaultPrevented: !1 }
        ),
        onFocusOutside: O(
          e.onFocusOutside,
          (i) => i.preventDefault(),
          { checkForDefaultPrevented: !1 }
        )
      }
    ) });
  }
), Wu = c.forwardRef(
  (e, t) => {
    const n = Oe(qe, e.__scopePopover), r = c.useRef(!1), o = c.useRef(!1);
    return /* @__PURE__ */ g(
      ds,
      {
        ...e,
        ref: t,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (s) => {
          var i, a;
          (i = e.onCloseAutoFocus) == null || i.call(e, s), s.defaultPrevented || (r.current || (a = n.triggerRef.current) == null || a.focus(), s.preventDefault()), r.current = !1, o.current = !1;
        },
        onInteractOutside: (s) => {
          var l, f;
          (l = e.onInteractOutside) == null || l.call(e, s), s.defaultPrevented || (r.current = !0, s.detail.originalEvent.type === "pointerdown" && (o.current = !0));
          const i = s.target;
          ((f = n.triggerRef.current) == null ? void 0 : f.contains(i)) && s.preventDefault(), s.detail.originalEvent.type === "focusin" && o.current && s.preventDefault();
        }
      }
    );
  }
), ds = c.forwardRef(
  (e, t) => {
    const {
      __scopePopover: n,
      trapFocus: r,
      onOpenAutoFocus: o,
      onCloseAutoFocus: s,
      disableOutsidePointerEvents: i,
      onEscapeKeyDown: a,
      onPointerDownOutside: l,
      onFocusOutside: f,
      onInteractOutside: u,
      ...d
    } = e, m = Oe(qe, n), v = yt(n);
    return kn(), /* @__PURE__ */ g(
      Wt,
      {
        asChild: !0,
        loop: !0,
        trapped: r,
        onMountAutoFocus: o,
        onUnmountAutoFocus: s,
        children: /* @__PURE__ */ g(
          dt,
          {
            asChild: !0,
            disableOutsidePointerEvents: i,
            onInteractOutside: u,
            onEscapeKeyDown: a,
            onPointerDownOutside: l,
            onFocusOutside: f,
            onDismiss: () => m.onOpenChange(!1),
            deferPointerDownOutside: !0,
            children: /* @__PURE__ */ g(
              Qn,
              {
                "data-state": ps(m.open),
                role: "dialog",
                id: m.contentId,
                ...v,
                ...d,
                ref: t,
                style: {
                  ...d.style,
                  "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
                  "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
                  "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
                  "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
                  "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)"
                }
              }
            )
          }
        )
      }
    );
  }
), fs = "PopoverClose", Hu = c.forwardRef(
  (e, t) => {
    const { __scopePopover: n, ...r } = e, o = Oe(fs, n);
    return /* @__PURE__ */ g(
      M.button,
      {
        type: "button",
        ...r,
        ref: t,
        onClick: O(e.onClick, () => o.onOpenChange(!1))
      }
    );
  }
);
Hu.displayName = fs;
var zu = "PopoverArrow", Uu = c.forwardRef(
  (e, t) => {
    const { __scopePopover: n, ...r } = e, o = yt(n);
    return /* @__PURE__ */ g(Jn, { ...o, ...r, ref: t });
  }
);
Uu.displayName = zu;
function ps(e) {
  return e ? "open" : "closed";
}
var Gu = os, ju = is, Ku = cs, Yu = ls, ms = us;
const Uf = Gu, Gf = Ku, jf = ju, Xu = c.forwardRef(({ className: e, align: t = "center", sideOffset: n = 4, ...r }, o) => /* @__PURE__ */ g(Yu, { children: /* @__PURE__ */ g(
  ms,
  {
    ref: o,
    align: t,
    sideOffset: n,
    className: _(
      "z-50 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
      e
    ),
    ...r
  }
) }));
Xu.displayName = ms.displayName;
function qr(e, [t, n]) {
  return Math.min(n, Math.max(t, e));
}
function gs(e) {
  const t = e + "CollectionProvider", [n, r] = he(t), [o, s] = n(
    t,
    { collectionRef: { current: null }, itemMap: /* @__PURE__ */ new Map() }
  ), i = (p) => {
    const { scope: h, children: b } = p, x = c.useRef(null), w = c.useRef(/* @__PURE__ */ new Map()).current;
    return /* @__PURE__ */ g(o, { scope: h, itemMap: w, collectionRef: x, children: b });
  };
  i.displayName = t;
  const a = e + "CollectionSlot", l = /* @__PURE__ */ ke(a), f = c.forwardRef(
    (p, h) => {
      const { scope: b, children: x } = p, w = s(a, b), C = j(h, w.collectionRef);
      return /* @__PURE__ */ g(l, { ref: C, children: x });
    }
  );
  f.displayName = a;
  const u = e + "CollectionItemSlot", d = "data-radix-collection-item", m = /* @__PURE__ */ ke(u), v = c.forwardRef(
    (p, h) => {
      const { scope: b, children: x, ...w } = p, C = c.useRef(null), S = j(h, C), R = s(u, b);
      return c.useEffect(() => (R.itemMap.set(C, { ref: C, ...w }), () => void R.itemMap.delete(C))), /* @__PURE__ */ g(m, { [d]: "", ref: S, children: x });
    }
  );
  v.displayName = u;
  function y(p) {
    const h = s(e + "CollectionConsumer", p);
    return c.useCallback(() => {
      const x = h.collectionRef.current;
      if (!x) return [];
      const w = Array.from(x.querySelectorAll(`[${d}]`));
      return Array.from(h.itemMap.values()).sort(
        (R, E) => w.indexOf(R.ref.current) - w.indexOf(E.ref.current)
      );
    }, [h.collectionRef, h.itemMap]);
  }
  return [
    { Provider: i, Slot: f, ItemSlot: v },
    y,
    r
  ];
}
var qu = c.createContext(void 0);
function tr(e) {
  const t = c.useContext(qu);
  return e || t || "ltr";
}
function Zu(e) {
  const t = c.useRef({ value: e, previous: e });
  return c.useMemo(() => (t.current.value !== e && (t.current.previous = t.current.value, t.current.value = e), t.current.previous), [e]);
}
var vs = Object.freeze({
  // See: https://github.com/twbs/bootstrap/blob/main/scss/mixins/_visually-hidden.scss
  position: "absolute",
  border: 0,
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  wordWrap: "normal"
}), Qu = "VisuallyHidden", hs = c.forwardRef(
  (e, t) => /* @__PURE__ */ g(
    M.span,
    {
      ...e,
      ref: t,
      style: { ...vs, ...e.style }
    }
  )
);
hs.displayName = Qu;
var Ju = hs, ed = [" ", "Enter", "ArrowUp", "ArrowDown"], td = [" ", "Enter"], $e = "Select", [Qt, Jt, nd] = gs($e), [Ve] = he($e, [
  nd,
  tt
]), en = tt(), [rd, Ie] = Ve($e), [od, sd] = Ve($e), id = "SelectProvider";
function bs(e) {
  const {
    __scopeSelect: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    value: i,
    defaultValue: a,
    onValueChange: l,
    dir: f,
    name: u,
    autoComplete: d,
    disabled: m,
    required: v,
    form: y,
    // @ts-expect-error internal render prop used by `Select` to compose its default parts
    internal_do_not_use_render: p
  } = e, h = en(t), [b, x] = c.useState(null), [w, C] = c.useState(null), [S, R] = c.useState(!1), E = tr(f), [T, V] = Le({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: $e
  }), [L, P] = Le({
    prop: i,
    defaultProp: a,
    onChange: l,
    caller: $e
  }), N = c.useRef(null), $ = c.useRef(L);
  c.useEffect(() => {
    const Q = y ? b == null ? void 0 : b.ownerDocument.getElementById(y) : b == null ? void 0 : b.form;
    if (Q instanceof HTMLFormElement) {
      const re = () => P($.current);
      return Q.addEventListener("reset", re), () => Q.removeEventListener("reset", re);
    }
  }, [y, b, P]);
  const F = b ? !!y || !!b.closest("form") : !0, [z, I] = c.useState(/* @__PURE__ */ new Set()), W = ge(), A = Array.from(z).map((Q) => Q.props.value).join(";"), B = c.useCallback((Q) => {
    I((re) => new Set(re).add(Q));
  }, []), X = c.useCallback((Q) => {
    I((re) => {
      const oe = new Set(re);
      return oe.delete(Q), oe;
    });
  }, []), q = {
    required: v,
    trigger: b,
    onTriggerChange: x,
    valueNode: w,
    onValueNodeChange: C,
    valueNodeHasChildren: S,
    onValueNodeHasChildrenChange: R,
    contentId: W,
    value: L,
    onValueChange: P,
    open: T,
    onOpenChange: V,
    dir: E,
    triggerPointerDownPosRef: N,
    disabled: m,
    name: u,
    autoComplete: d,
    form: y,
    nativeOptions: z,
    nativeSelectKey: A,
    isFormControl: F
  };
  return /* @__PURE__ */ g(Zn, { ...h, children: /* @__PURE__ */ g(rd, { scope: t, ...q, children: /* @__PURE__ */ g(Qt.Provider, { scope: t, children: /* @__PURE__ */ g(
    od,
    {
      scope: t,
      onNativeOptionAdd: B,
      onNativeOptionRemove: X,
      children: wd(p) ? p(q) : n
    }
  ) }) }) });
}
bs.displayName = id;
var ys = (e) => {
  const { __scopeSelect: t, children: n, ...r } = e;
  return /* @__PURE__ */ g(
    bs,
    {
      __scopeSelect: t,
      ...r,
      internal_do_not_use_render: ({ isFormControl: o }) => /* @__PURE__ */ J(Bt, { children: [
        n,
        o ? /* @__PURE__ */ g(
          Ws,
          {
            __scopeSelect: t
          }
        ) : null
      ] })
    }
  );
};
ys.displayName = $e;
var ws = "SelectTrigger", nr = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, disabled: r = !1, ...o } = e, s = en(n), i = Ie(ws, n), a = i.disabled || r, l = j(t, i.onTriggerChange), f = Jt(n), u = c.useRef("touch"), [d, m, v] = Hs((p) => {
      const h = f().filter((w) => !w.disabled), b = h.find((w) => w.value === i.value), x = zs(h, p, b);
      x !== void 0 && i.onValueChange(x.value);
    }), y = (p) => {
      a || (i.onOpenChange(!0), v()), p && (i.triggerPointerDownPosRef.current = {
        x: Math.round(p.pageX),
        y: Math.round(p.pageY)
      });
    };
    return /* @__PURE__ */ g(qt, { asChild: !0, ...s, children: /* @__PURE__ */ g(
      M.button,
      {
        type: "button",
        role: "combobox",
        "aria-controls": i.open ? i.contentId : void 0,
        "aria-expanded": i.open,
        "aria-required": i.required,
        "aria-autocomplete": "none",
        dir: i.dir,
        "data-state": i.open ? "open" : "closed",
        disabled: a,
        "data-disabled": a ? "" : void 0,
        "data-placeholder": tn(i.value) ? "" : void 0,
        ...o,
        ref: l,
        onClick: O(o.onClick, (p) => {
          p.currentTarget.focus(), u.current !== "mouse" && y(p);
        }),
        onPointerDown: O(o.onPointerDown, (p) => {
          u.current = p.pointerType;
          const h = p.target;
          h.hasPointerCapture(p.pointerId) && h.releasePointerCapture(p.pointerId), p.button === 0 && p.ctrlKey === !1 && p.pointerType === "mouse" && (y(p), p.preventDefault());
        }),
        onKeyDown: O(o.onKeyDown, (p) => {
          const h = d.current !== "";
          !(p.ctrlKey || p.altKey || p.metaKey) && p.key.length === 1 && m(p.key), !(h && p.key === " ") && ed.includes(p.key) && (y(), p.preventDefault());
        })
      }
    ) });
  }
);
nr.displayName = ws;
var xs = "SelectValue", Cs = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, className: r, style: o, children: s, placeholder: i = "", ...a } = e, l = Ie(xs, n), { onValueNodeHasChildrenChange: f } = l, u = s !== void 0, d = j(t, l.onValueNodeChange);
    Z(() => {
      f(u);
    }, [f, u]);
    const m = tn(l.value);
    return /* @__PURE__ */ g(
      M.span,
      {
        ...a,
        asChild: m ? !1 : a.asChild,
        ref: d,
        style: { pointerEvents: "none" },
        children: /* @__PURE__ */ g(c.Fragment, { children: m ? i : s }, m ? "placeholder" : "value")
      }
    );
  }
);
Cs.displayName = xs;
var ad = "SelectIcon", Ss = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, children: r, ...o } = e;
    return /* @__PURE__ */ g(M.span, { "aria-hidden": !0, ...o, ref: t, children: r || "▼" });
  }
);
Ss.displayName = ad;
var Rs = "SelectPortal", [cd, ld] = Ve(Rs, {
  forceMount: void 0
}), Es = (e) => {
  const { __scopeSelect: t, forceMount: n, ...r } = e;
  return /* @__PURE__ */ g(cd, { scope: e.__scopeSelect, forceMount: n, children: /* @__PURE__ */ g(ft, { asChild: !0, ...r }) });
};
Es.displayName = Rs;
var Ae = "SelectContent", rr = c.forwardRef(
  (e, t) => {
    const n = ld(Ae, e.__scopeSelect), { forceMount: r = n.forceMount, ...o } = e, s = Ie(Ae, e.__scopeSelect), [i, a] = c.useState();
    return Z(() => {
      a(new DocumentFragment());
    }, []), /* @__PURE__ */ g(be, { present: r || s.open, children: ({ present: l }) => l ? /* @__PURE__ */ g(Ts, { ...o, ref: t }) : /* @__PURE__ */ g(Ps, { ...o, fragment: i }) });
  }
);
rr.displayName = Ae;
var Ps = c.forwardRef((e, t) => {
  const { __scopeSelect: n, children: r, fragment: o } = e;
  return o ? ut.createPortal(
    /* @__PURE__ */ g(Ns, { scope: n, children: /* @__PURE__ */ g(Qt.Slot, { scope: n, children: /* @__PURE__ */ g("div", { ref: t, children: r }) }) }),
    o
  ) : null;
});
Ps.displayName = "SelectContentFragment";
var ie = 10, [Ns, _e] = Ve(Ae), ud = "SelectContentImpl", dd = /* @__PURE__ */ ke("SelectContent.RemoveScroll"), Ts = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n } = e, {
      position: r = "item-aligned",
      onCloseAutoFocus: o,
      onEscapeKeyDown: s,
      onPointerDownOutside: i,
      //
      // PopperContent props
      side: a,
      sideOffset: l,
      align: f,
      alignOffset: u,
      arrowPadding: d,
      collisionBoundary: m,
      collisionPadding: v,
      sticky: y,
      hideWhenDetached: p,
      avoidCollisions: h,
      //
      ...b
    } = e, x = Ie(Ae, n), [w, C] = c.useState(null), [S, R] = c.useState(null), E = j(t, C), [T, V] = c.useState(null), [L, P] = c.useState(
      null
    ), N = Jt(n), [$, F] = c.useState(!1), z = c.useRef(!1);
    c.useEffect(() => {
      if (w) return Ln(w);
    }, [w]), kn();
    const I = c.useCallback(
      (D) => {
        const [K, ...ee] = N().map((U) => U.ref.current), [G] = ee.slice(-1), H = document.activeElement;
        for (const U of D)
          if (U === H || (U == null || U.scrollIntoView({ block: "nearest" }), U === K && S && (S.scrollTop = 0), U === G && S && (S.scrollTop = S.scrollHeight), U == null || U.focus(), document.activeElement !== H)) return;
      },
      [N, S]
    ), W = c.useCallback(
      () => I([T, w]),
      [I, T, w]
    );
    c.useEffect(() => {
      $ && W();
    }, [$, W]);
    const { onOpenChange: A, triggerPointerDownPosRef: B } = x;
    c.useEffect(() => {
      if (w) {
        let D = { x: 0, y: 0 };
        const K = (G) => {
          var H, U;
          D = {
            x: Math.abs(Math.round(G.pageX) - (((H = B.current) == null ? void 0 : H.x) ?? 0)),
            y: Math.abs(Math.round(G.pageY) - (((U = B.current) == null ? void 0 : U.y) ?? 0))
          };
        }, ee = (G) => {
          D.x <= 10 && D.y <= 10 ? G.preventDefault() : G.composedPath().includes(w) || A(!1), document.removeEventListener("pointermove", K), B.current = null;
        };
        return B.current !== null && (document.addEventListener("pointermove", K), document.addEventListener("pointerup", ee, { capture: !0, once: !0 })), () => {
          document.removeEventListener("pointermove", K), document.removeEventListener("pointerup", ee, { capture: !0 });
        };
      }
    }, [w, A, B]), c.useEffect(() => {
      const D = () => A(!1);
      return window.addEventListener("blur", D), window.addEventListener("resize", D), () => {
        window.removeEventListener("blur", D), window.removeEventListener("resize", D);
      };
    }, [A]);
    const [X, q] = Hs((D) => {
      const K = N().filter((H) => !H.disabled), ee = K.find((H) => H.ref.current === document.activeElement), G = zs(K, D, ee);
      G && setTimeout(() => {
        var H;
        return (H = G.ref.current) == null ? void 0 : H.focus();
      });
    }), Q = c.useCallback(
      (D, K, ee) => {
        const G = !z.current && !ee;
        (x.value !== void 0 && x.value === K || G) && (V(D), G && (z.current = !0));
      },
      [x.value]
    ), re = c.useCallback(() => w == null ? void 0 : w.focus(), [w]), oe = c.useCallback(
      (D, K, ee) => {
        const G = !z.current && !ee;
        (x.value !== void 0 && x.value === K || G) && P(D);
      },
      [x.value]
    ), Be = r === "popper" ? En : As, Me = Be === En ? {
      side: a,
      sideOffset: l,
      align: f,
      alignOffset: u,
      arrowPadding: d,
      collisionBoundary: m,
      collisionPadding: v,
      sticky: y,
      hideWhenDetached: p,
      avoidCollisions: h
    } : {};
    return /* @__PURE__ */ g(
      Ns,
      {
        scope: n,
        content: w,
        viewport: S,
        onViewportChange: R,
        itemRefCallback: Q,
        selectedItem: T,
        onItemLeave: re,
        itemTextRefCallback: oe,
        focusSelectedItem: W,
        selectedItemText: L,
        position: r,
        isPositioned: $,
        searchRef: X,
        children: /* @__PURE__ */ g(zt, { as: dd, allowPinchZoom: !0, children: /* @__PURE__ */ g(
          Wt,
          {
            asChild: !0,
            trapped: x.open,
            onMountAutoFocus: (D) => {
              D.preventDefault();
            },
            onUnmountAutoFocus: O(o, (D) => {
              var K;
              (K = x.trigger) == null || K.focus({ preventScroll: !0 }), D.preventDefault();
            }),
            children: /* @__PURE__ */ g(
              dt,
              {
                asChild: !0,
                disableOutsidePointerEvents: !0,
                onEscapeKeyDown: s,
                onPointerDownOutside: i,
                onFocusOutside: (D) => D.preventDefault(),
                onDismiss: () => x.onOpenChange(!1),
                children: /* @__PURE__ */ g(
                  Be,
                  {
                    role: "listbox",
                    id: x.contentId,
                    "data-state": x.open ? "open" : "closed",
                    dir: x.dir,
                    onContextMenu: (D) => D.preventDefault(),
                    ...b,
                    ...Me,
                    onPlaced: () => F(!0),
                    ref: E,
                    style: {
                      // flex layout so we can place the scroll buttons properly
                      display: "flex",
                      flexDirection: "column",
                      // reset the outline by default as the content MAY get focused
                      outline: "none",
                      ...b.style
                    },
                    onKeyDown: O(b.onKeyDown, (D) => {
                      const K = D.ctrlKey || D.altKey || D.metaKey;
                      if (D.key === "Tab" && D.preventDefault(), !K && D.key.length === 1 && q(D.key), ["ArrowUp", "ArrowDown", "Home", "End"].includes(D.key)) {
                        let G = N().filter((H) => !H.disabled).map((H) => H.ref.current);
                        if (["ArrowUp", "End"].includes(D.key) && (G = G.slice().reverse()), ["ArrowUp", "ArrowDown"].includes(D.key)) {
                          const H = D.target, U = G.indexOf(H);
                          G = G.slice(U + 1);
                        }
                        setTimeout(() => I(G)), D.preventDefault();
                      }
                    })
                  }
                )
              }
            )
          }
        ) })
      }
    );
  }
);
Ts.displayName = ud;
var fd = "SelectItemAlignedPosition", As = c.forwardRef((e, t) => {
  const { __scopeSelect: n, onPlaced: r, ...o } = e, s = Ie(Ae, n), i = _e(Ae, n), [a, l] = c.useState(null), [f, u] = c.useState(null), d = j(t, u), m = Jt(n), v = c.useRef(!1), y = c.useRef(!0), { viewport: p, selectedItem: h, selectedItemText: b, focusSelectedItem: x } = i, w = c.useCallback(() => {
    if (s.trigger && s.valueNode && a && f && p && h && b) {
      const E = s.trigger.getBoundingClientRect(), T = f.getBoundingClientRect(), V = s.valueNode.getBoundingClientRect(), L = b.getBoundingClientRect();
      if (s.dir !== "rtl") {
        const H = L.left - T.left, U = V.left - H, de = E.left - U, se = E.width + de, We = Math.max(se, T.width), nt = window.innerWidth - ie, rt = qr(U, [
          ie,
          // Prevents the content from going off the starting edge of the
          // viewport. It may still go off the ending edge, but this can be
          // controlled by the user since they may want to manage overflow in a
          // specific way.
          // https://github.com/radix-ui/primitives/issues/2049
          Math.max(ie, nt - We)
        ]);
        a.style.minWidth = se + "px", a.style.left = rt + "px";
      } else {
        const H = T.right - L.right, U = window.innerWidth - V.right - H, de = window.innerWidth - E.right - U, se = E.width + de, We = Math.max(se, T.width), nt = window.innerWidth - ie, rt = qr(U, [
          ie,
          Math.max(ie, nt - We)
        ]);
        a.style.minWidth = se + "px", a.style.right = rt + "px";
      }
      const P = m(), N = window.innerHeight - ie * 2, $ = p.scrollHeight, F = window.getComputedStyle(f), z = parseInt(F.borderTopWidth, 10), I = parseInt(F.paddingTop, 10), W = parseInt(F.borderBottomWidth, 10), A = parseInt(F.paddingBottom, 10), B = z + I + $ + A + W, X = Math.min(h.offsetHeight * 5, B), q = window.getComputedStyle(p), Q = parseInt(q.paddingTop, 10), re = parseInt(q.paddingBottom, 10), oe = E.top + E.height / 2 - ie, Be = N - oe, Me = h.offsetHeight / 2, D = h.offsetTop + Me, K = z + I + D, ee = B - K;
      if (K <= oe) {
        const H = P.length > 0 && h === P[P.length - 1].ref.current;
        a.style.bottom = "0px";
        const U = f.clientHeight - p.offsetTop - p.offsetHeight, de = Math.max(
          Be,
          Me + // viewport might have padding bottom, include it to avoid a scrollable viewport
          (H ? re : 0) + U + W
        ), se = K + de;
        a.style.height = se + "px";
      } else {
        const H = P.length > 0 && h === P[0].ref.current;
        a.style.top = "0px";
        const de = Math.max(
          oe,
          z + p.offsetTop + // viewport might have padding top, include it to avoid a scrollable viewport
          (H ? Q : 0) + Me
        ) + ee;
        a.style.height = de + "px", p.scrollTop = K - oe + p.offsetTop;
      }
      a.style.margin = `${ie}px 0`, a.style.minHeight = X + "px", a.style.maxHeight = N + "px", r == null || r(), requestAnimationFrame(() => v.current = !0);
    }
  }, [
    m,
    s.trigger,
    s.valueNode,
    a,
    f,
    p,
    h,
    b,
    s.dir,
    r
  ]);
  Z(() => w(), [w]);
  const [C, S] = c.useState();
  Z(() => {
    f && S(window.getComputedStyle(f).zIndex);
  }, [f]);
  const R = c.useCallback(
    (E) => {
      E && y.current === !0 && (w(), x == null || x(), y.current = !1);
    },
    [w, x]
  );
  return /* @__PURE__ */ g(
    md,
    {
      scope: n,
      contentWrapper: a,
      shouldExpandOnScrollRef: v,
      onScrollButtonChange: R,
      children: /* @__PURE__ */ g(
        "div",
        {
          ref: l,
          style: {
            display: "flex",
            flexDirection: "column",
            position: "fixed",
            zIndex: C
          },
          children: /* @__PURE__ */ g(
            M.div,
            {
              ...o,
              ref: d,
              style: {
                // When we get the height of the content, it includes borders. If we were to set
                // the height without having `boxSizing: 'border-box'` it would be too big.
                boxSizing: "border-box",
                // We need to ensure the content doesn't get taller than the wrapper
                maxHeight: "100%",
                ...o.style
              }
            }
          )
        }
      )
    }
  );
});
As.displayName = fd;
var pd = "SelectPopperPosition", En = c.forwardRef((e, t) => {
  const {
    __scopeSelect: n,
    align: r = "start",
    collisionPadding: o = ie,
    ...s
  } = e, i = en(n);
  return /* @__PURE__ */ g(
    Qn,
    {
      ...i,
      ...s,
      ref: t,
      align: r,
      collisionPadding: o,
      style: {
        // Ensure border-box for floating-ui calculations
        boxSizing: "border-box",
        ...s.style,
        "--radix-select-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-select-content-available-width": "var(--radix-popper-available-width)",
        "--radix-select-content-available-height": "var(--radix-popper-available-height)",
        "--radix-select-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-select-trigger-height": "var(--radix-popper-anchor-height)"
      }
    }
  );
});
En.displayName = pd;
var [md, or] = Ve(Ae, {}), Pn = "SelectViewport", Os = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, nonce: r, ...o } = e, s = _e(Pn, n), i = or(Pn, n), a = j(t, s.onViewportChange), l = c.useRef(0);
    return /* @__PURE__ */ J(Bt, { children: [
      /* @__PURE__ */ g(
        "style",
        {
          dangerouslySetInnerHTML: {
            __html: "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}"
          },
          nonce: r
        }
      ),
      /* @__PURE__ */ g(Qt.Slot, { scope: n, children: /* @__PURE__ */ g(
        M.div,
        {
          "data-radix-select-viewport": "",
          role: "presentation",
          ...o,
          ref: a,
          style: {
            // we use position: 'relative' here on the `viewport` so that when we call
            // `selectedItem.offsetTop` in calculations, the offset is relative to the viewport
            // (independent of the scrollUpButton).
            position: "relative",
            flex: 1,
            // Viewport should only be scrollable in the vertical direction.
            // This won't work in vertical writing modes, so we'll need to
            // revisit this if/when that is supported
            // https://developer.chrome.com/blog/vertical-form-controls
            overflow: "hidden auto",
            ...o.style
          },
          onScroll: O(o.onScroll, (f) => {
            const u = f.currentTarget, { contentWrapper: d, shouldExpandOnScrollRef: m } = i;
            if (m != null && m.current && d) {
              const v = Math.abs(l.current - u.scrollTop);
              if (v > 0) {
                const y = window.innerHeight - ie * 2, p = parseFloat(d.style.minHeight), h = parseFloat(d.style.height), b = Math.max(p, h);
                if (b < y) {
                  const x = b + v, w = Math.min(y, x), C = x - w;
                  d.style.height = w + "px", d.style.bottom === "0px" && (u.scrollTop = C > 0 ? C : 0, d.style.justifyContent = "flex-end");
                }
              }
            }
            l.current = u.scrollTop;
          })
        }
      ) })
    ] });
  }
);
Os.displayName = Pn;
var Is = "SelectGroup", [gd, vd] = Ve(Is), _s = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, ...r } = e, o = ge();
    return /* @__PURE__ */ g(gd, { scope: n, id: o, children: /* @__PURE__ */ g(M.div, { role: "group", "aria-labelledby": o, ...r, ref: t }) });
  }
);
_s.displayName = Is;
var Ms = "SelectLabel", sr = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, ...r } = e, o = vd(Ms, n);
    return /* @__PURE__ */ g(M.div, { id: o.id, ...r, ref: t });
  }
);
sr.displayName = Ms;
var $t = "SelectItem", [hd, Ds] = Ve($t), ir = c.forwardRef(
  (e, t) => {
    const {
      __scopeSelect: n,
      value: r,
      disabled: o = !1,
      textValue: s,
      ...i
    } = e, a = Ie($t, n), l = _e($t, n), f = a.value === r, [u, d] = c.useState(s ?? ""), [m, v] = c.useState(!1), y = ae(
      (w) => {
        var C;
        return (C = l.itemRefCallback) == null ? void 0 : C.call(l, w, r, o);
      }
    ), p = j(t, y), h = ge(), b = c.useRef("touch"), x = () => {
      o || (a.onValueChange(r), a.onOpenChange(!1));
    };
    return /* @__PURE__ */ g(
      hd,
      {
        scope: n,
        value: r,
        disabled: o,
        textId: h,
        isSelected: f,
        onItemTextChange: c.useCallback((w) => {
          d((C) => C || ((w == null ? void 0 : w.textContent) ?? "").trim());
        }, []),
        children: /* @__PURE__ */ g(
          Qt.ItemSlot,
          {
            scope: n,
            value: r,
            disabled: o,
            textValue: u,
            children: /* @__PURE__ */ g(
              M.div,
              {
                role: "option",
                "aria-labelledby": h,
                "data-highlighted": m ? "" : void 0,
                "aria-selected": f && m,
                "data-state": f ? "checked" : "unchecked",
                "aria-disabled": o || void 0,
                "data-disabled": o ? "" : void 0,
                tabIndex: o ? void 0 : -1,
                ...i,
                ref: p,
                onFocus: O(i.onFocus, () => v(!0)),
                onBlur: O(i.onBlur, () => v(!1)),
                onClick: O(i.onClick, () => {
                  b.current !== "mouse" && x();
                }),
                onPointerUp: O(i.onPointerUp, () => {
                  b.current === "mouse" && x();
                }),
                onPointerDown: O(i.onPointerDown, (w) => {
                  b.current = w.pointerType;
                }),
                onPointerMove: O(i.onPointerMove, (w) => {
                  var C;
                  b.current = w.pointerType, o ? (C = l.onItemLeave) == null || C.call(l) : b.current === "mouse" && w.currentTarget.focus({ preventScroll: !0 });
                }),
                onPointerLeave: O(i.onPointerLeave, (w) => {
                  var C;
                  w.currentTarget === document.activeElement && ((C = l.onItemLeave) == null || C.call(l));
                }),
                onKeyDown: O(i.onKeyDown, (w) => {
                  var S;
                  o || w.target !== w.currentTarget || ((S = l.searchRef) == null ? void 0 : S.current) !== "" && w.key === " " || (td.includes(w.key) && x(), w.key === " " && w.preventDefault());
                })
              }
            )
          }
        )
      }
    );
  }
);
ir.displayName = $t;
var at = "SelectItemText", ks = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, className: r, style: o, ...s } = e, i = Ie(at, n), a = _e(at, n), l = Ds(at, n), f = sd(at, n), [u, d] = c.useState(null), m = ae(
      (x) => {
        var w;
        return (w = a.itemTextRefCallback) == null ? void 0 : w.call(a, x, l.value, l.disabled);
      }
    ), v = j(
      t,
      d,
      l.onItemTextChange,
      m
    ), y = u == null ? void 0 : u.textContent, p = c.useMemo(
      () => /* @__PURE__ */ g("option", { value: l.value, disabled: l.disabled, children: y }, l.value),
      [l.disabled, l.value, y]
    ), { onNativeOptionAdd: h, onNativeOptionRemove: b } = f;
    return Z(() => (h(p), () => b(p)), [h, b, p]), /* @__PURE__ */ J(Bt, { children: [
      /* @__PURE__ */ g(M.span, { id: l.textId, ...s, ref: v }),
      l.isSelected && i.valueNode && !i.valueNodeHasChildren && !tn(i.value) ? ut.createPortal(s.children, i.valueNode) : null
    ] });
  }
);
ks.displayName = at;
var Ls = "SelectItemIndicator", Fs = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, ...r } = e;
    return Ds(Ls, n).isSelected ? /* @__PURE__ */ g(M.span, { "aria-hidden": !0, ...r, ref: t }) : null;
  }
);
Fs.displayName = Ls;
var Nn = "SelectScrollUpButton", ar = c.forwardRef((e, t) => {
  const n = _e(Nn, e.__scopeSelect), r = or(Nn, e.__scopeSelect), [o, s] = c.useState(!1), i = j(t, r.onScrollButtonChange);
  return Z(() => {
    if (n.viewport && n.isPositioned) {
      let a = function() {
        const f = l.scrollTop > 0;
        s(f);
      };
      const l = n.viewport;
      return a(), l.addEventListener("scroll", a), () => l.removeEventListener("scroll", a);
    }
  }, [n.viewport, n.isPositioned]), o ? /* @__PURE__ */ g(
    $s,
    {
      ...e,
      ref: i,
      onAutoScroll: () => {
        const { viewport: a, selectedItem: l } = n;
        a && l && (a.scrollTop = a.scrollTop - l.offsetHeight);
      }
    }
  ) : null;
});
ar.displayName = Nn;
var Tn = "SelectScrollDownButton", cr = c.forwardRef((e, t) => {
  const n = _e(Tn, e.__scopeSelect), r = or(Tn, e.__scopeSelect), [o, s] = c.useState(!1), i = j(t, r.onScrollButtonChange);
  return Z(() => {
    if (n.viewport && n.isPositioned) {
      let a = function() {
        const f = l.scrollHeight - l.clientHeight, u = Math.ceil(l.scrollTop) < f;
        s(u);
      };
      const l = n.viewport;
      return a(), l.addEventListener("scroll", a), () => l.removeEventListener("scroll", a);
    }
  }, [n.viewport, n.isPositioned]), o ? /* @__PURE__ */ g(
    $s,
    {
      ...e,
      ref: i,
      onAutoScroll: () => {
        const { viewport: a, selectedItem: l } = n;
        a && l && (a.scrollTop = a.scrollTop + l.offsetHeight);
      }
    }
  ) : null;
});
cr.displayName = Tn;
var $s = c.forwardRef((e, t) => {
  const { __scopeSelect: n, onAutoScroll: r, ...o } = e, s = _e("SelectScrollButton", n), i = c.useRef(null), a = Jt(n), l = c.useCallback(() => {
    i.current !== null && (window.clearInterval(i.current), i.current = null);
  }, []);
  return c.useEffect(() => () => l(), [l]), Z(() => {
    var u;
    const f = a().find((d) => d.ref.current === document.activeElement);
    (u = f == null ? void 0 : f.ref.current) == null || u.scrollIntoView({ block: "nearest" });
  }, [a]), /* @__PURE__ */ g(
    M.div,
    {
      "aria-hidden": !0,
      ...o,
      ref: t,
      style: { flexShrink: 0, ...o.style },
      onPointerDown: O(o.onPointerDown, () => {
        i.current === null && (i.current = window.setInterval(r, 50));
      }),
      onPointerMove: O(o.onPointerMove, () => {
        var f;
        (f = s.onItemLeave) == null || f.call(s), i.current === null && (i.current = window.setInterval(r, 50));
      }),
      onPointerLeave: O(o.onPointerLeave, () => {
        l();
      })
    }
  );
}), bd = "SelectSeparator", lr = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, ...r } = e;
    return /* @__PURE__ */ g(M.div, { "aria-hidden": !0, ...r, ref: t });
  }
);
lr.displayName = bd;
var Vs = "SelectArrow", yd = c.forwardRef(
  (e, t) => {
    const { __scopeSelect: n, ...r } = e, o = en(n);
    return _e(Vs, n).position === "popper" ? /* @__PURE__ */ g(Jn, { ...o, ...r, ref: t }) : null;
  }
);
yd.displayName = Vs;
var Bs = "SelectBubbleInput", Ws = c.forwardRef(
  ({ __scopeSelect: e, ...t }, n) => {
    const r = Ie(Bs, e), { value: o, onValueChange: s, required: i, disabled: a, name: l, autoComplete: f, form: u } = r, { nativeOptions: d, nativeSelectKey: m } = r, v = c.useRef(null), y = j(n, v), p = o ?? "", h = Zu(p), b = Array.from(d).some(
      (x) => (x.props.value ?? "") === ""
    );
    return c.useEffect(() => {
      const x = v.current;
      if (!x) return;
      const w = window.HTMLSelectElement.prototype, S = Object.getOwnPropertyDescriptor(
        w,
        "value"
      ).set;
      if (h !== p && S) {
        const R = new Event("change", { bubbles: !0 });
        S.call(x, p), x.dispatchEvent(R);
      }
    }, [h, p]), /* @__PURE__ */ J(
      M.select,
      {
        "aria-hidden": !0,
        required: i,
        tabIndex: -1,
        name: l,
        autoComplete: f,
        disabled: a,
        form: u,
        onChange: (x) => s(x.target.value),
        ...t,
        style: { ...vs, ...t.style },
        ref: y,
        defaultValue: p,
        children: [
          tn(o) && !b ? /* @__PURE__ */ g("option", { value: "" }) : null,
          Array.from(d)
        ]
      },
      m
    );
  }
);
Ws.displayName = Bs;
function wd(e) {
  return typeof e == "function";
}
function tn(e) {
  return e === "" || e === void 0;
}
function Hs(e) {
  const t = ae(e), n = c.useRef(""), r = c.useRef(0), o = c.useCallback(
    (i) => {
      const a = n.current + i;
      t(a), (function l(f) {
        n.current = f, window.clearTimeout(r.current), f !== "" && (r.current = window.setTimeout(() => l(""), 1e3));
      })(a);
    },
    [t]
  ), s = c.useCallback(() => {
    n.current = "", window.clearTimeout(r.current);
  }, []);
  return c.useEffect(() => () => window.clearTimeout(r.current), []), [n, o, s];
}
function zs(e, t, n) {
  const o = t.length > 1 && Array.from(t).every((f) => f === t[0]) ? t[0] : t, s = n ? e.indexOf(n) : -1;
  let i = xd(e, Math.max(s, 0));
  o.length === 1 && (i = i.filter((f) => f !== n));
  const l = i.find(
    (f) => f.textValue.toLowerCase().startsWith(o.toLowerCase())
  );
  return l !== n ? l : void 0;
}
function xd(e, t) {
  return e.map((n, r) => e[(t + r) % e.length]);
}
const Kf = ys, Yf = _s, Xf = Cs, Cd = c.forwardRef(({ className: e, children: t, ...n }, r) => /* @__PURE__ */ J(
  nr,
  {
    ref: r,
    className: _(
      "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 [&_svg]:size-4 [&_svg]:shrink-0",
      e
    ),
    ...n,
    children: [
      t,
      /* @__PURE__ */ g(Ss, { asChild: !0, children: /* @__PURE__ */ g(Mo, { className: "opacity-50" }) })
    ]
  }
));
Cd.displayName = nr.displayName;
const Us = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  ar,
  {
    ref: n,
    className: _(
      "flex cursor-default items-center justify-center py-1 [&_svg]:size-4",
      e
    ),
    ...t,
    children: /* @__PURE__ */ g(ll, {})
  }
));
Us.displayName = ar.displayName;
const Gs = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  cr,
  {
    ref: n,
    className: _(
      "flex cursor-default items-center justify-center py-1 [&_svg]:size-4",
      e
    ),
    ...t,
    children: /* @__PURE__ */ g(Mo, {})
  }
));
Gs.displayName = cr.displayName;
const Sd = c.forwardRef(({ className: e, children: t, position: n = "popper", ...r }, o) => /* @__PURE__ */ g(Es, { children: /* @__PURE__ */ J(
  rr,
  {
    ref: o,
    className: _(
      "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md",
      n === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
      e
    ),
    position: n,
    ...r,
    children: [
      /* @__PURE__ */ g(Us, {}),
      /* @__PURE__ */ g(
        Os,
        {
          className: _(
            "p-1",
            n === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"
          ),
          children: t
        }
      ),
      /* @__PURE__ */ g(Gs, {})
    ]
  }
) }));
Sd.displayName = rr.displayName;
const Rd = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  sr,
  {
    ref: n,
    className: _(
      "px-2 py-1.5 text-xs font-semibold text-muted-foreground",
      e
    ),
    ...t
  }
));
Rd.displayName = sr.displayName;
const Ed = c.forwardRef(({ className: e, children: t, ...n }, r) => /* @__PURE__ */ J(
  ir,
  {
    ref: r,
    className: _(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm text-popover-foreground outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      e
    ),
    ...n,
    children: [
      /* @__PURE__ */ g("span", { className: "absolute right-2 flex h-3.5 w-3.5 items-center justify-center [&_svg]:size-4", children: /* @__PURE__ */ g(Fs, { children: /* @__PURE__ */ g(cl, {}) }) }),
      /* @__PURE__ */ g(ks, { children: t })
    ]
  }
));
Ed.displayName = ir.displayName;
const Pd = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  lr,
  {
    ref: n,
    className: _("-mx-1 my-1 h-px bg-border", e),
    ...t
  }
));
Pd.displayName = lr.displayName;
var [nn] = he("Tooltip", [
  tt
]), rn = tt(), js = "TooltipProvider", Nd = 700, An = "tooltip.open", [Td, ur] = nn(js), Ks = (e) => {
  const {
    __scopeTooltip: t,
    delayDuration: n = Nd,
    skipDelayDuration: r = 300,
    disableHoverableContent: o = !1,
    children: s
  } = e, i = c.useRef(!0), a = c.useRef(!1), l = c.useRef(0);
  return c.useEffect(() => {
    const f = l.current;
    return () => window.clearTimeout(f);
  }, []), /* @__PURE__ */ g(
    Td,
    {
      scope: t,
      isOpenDelayedRef: i,
      delayDuration: n,
      onOpen: c.useCallback(() => {
        r <= 0 || (window.clearTimeout(l.current), i.current = !1);
      }, [r]),
      onClose: c.useCallback(() => {
        r <= 0 || (window.clearTimeout(l.current), l.current = window.setTimeout(
          () => i.current = !0,
          r
        ));
      }, [r]),
      isPointerInTransitRef: a,
      onPointerInTransitChange: c.useCallback((f) => {
        a.current = f;
      }, []),
      disableHoverableContent: o,
      children: s
    }
  );
};
Ks.displayName = js;
var lt = "Tooltip", [Ad, wt] = nn(lt), Ys = (e) => {
  const {
    __scopeTooltip: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    disableHoverableContent: i,
    delayDuration: a
  } = e, l = ur(lt, e.__scopeTooltip), f = rn(t), [u, d] = c.useState(null), m = ge(), v = c.useRef(0), y = i ?? l.disableHoverableContent, p = a ?? l.delayDuration, h = c.useRef(!1), [b, x] = Le({
    prop: r,
    defaultProp: o ?? !1,
    onChange: (E) => {
      E ? (l.onOpen(), document.dispatchEvent(new CustomEvent(An))) : l.onClose(), s == null || s(E);
    },
    caller: lt
  }), w = c.useMemo(() => b ? h.current ? "delayed-open" : "instant-open" : "closed", [b]), C = c.useCallback(() => {
    window.clearTimeout(v.current), v.current = 0, h.current = !1, x(!0);
  }, [x]), S = c.useCallback(() => {
    window.clearTimeout(v.current), v.current = 0, x(!1);
  }, [x]), R = c.useCallback(() => {
    window.clearTimeout(v.current), v.current = window.setTimeout(() => {
      h.current = !0, x(!0), v.current = 0;
    }, p);
  }, [p, x]);
  return c.useEffect(() => () => {
    v.current && (window.clearTimeout(v.current), v.current = 0);
  }, []), /* @__PURE__ */ g(Zn, { ...f, children: /* @__PURE__ */ g(
    Ad,
    {
      scope: t,
      contentId: m,
      open: b,
      stateAttribute: w,
      trigger: u,
      onTriggerChange: d,
      onTriggerEnter: c.useCallback(() => {
        l.isOpenDelayedRef.current ? R() : C();
      }, [l.isOpenDelayedRef, R, C]),
      onTriggerLeave: c.useCallback(() => {
        y ? S() : (window.clearTimeout(v.current), v.current = 0);
      }, [S, y]),
      onOpen: C,
      onClose: S,
      disableHoverableContent: y,
      children: n
    }
  ) });
};
Ys.displayName = lt;
var On = "TooltipTrigger", Xs = c.forwardRef(
  (e, t) => {
    const { __scopeTooltip: n, ...r } = e, o = wt(On, n), s = ur(On, n), i = rn(n), a = c.useRef(null), l = j(t, a, o.onTriggerChange), f = c.useRef(!1), u = c.useRef(!1), d = c.useCallback(() => f.current = !1, []);
    return c.useEffect(() => () => document.removeEventListener("pointerup", d), [d]), /* @__PURE__ */ g(qt, { asChild: !0, ...i, children: /* @__PURE__ */ g(
      M.button,
      {
        "aria-describedby": o.open ? o.contentId : void 0,
        "data-state": o.stateAttribute,
        ...r,
        ref: l,
        onPointerMove: O(e.onPointerMove, (m) => {
          m.pointerType !== "touch" && !u.current && !s.isPointerInTransitRef.current && (o.onTriggerEnter(), u.current = !0);
        }),
        onPointerLeave: O(e.onPointerLeave, () => {
          o.onTriggerLeave(), u.current = !1;
        }),
        onPointerDown: O(e.onPointerDown, () => {
          o.open && o.onClose(), f.current = !0, document.addEventListener("pointerup", d, { once: !0 });
        }),
        onFocus: O(e.onFocus, () => {
          f.current || o.onOpen();
        }),
        onBlur: O(e.onBlur, o.onClose),
        onClick: O(e.onClick, o.onClose)
      }
    ) });
  }
);
Xs.displayName = On;
var dr = "TooltipPortal", [Od, Id] = nn(dr, {
  forceMount: void 0
}), qs = (e) => {
  const { __scopeTooltip: t, forceMount: n, children: r, container: o } = e, s = wt(dr, t);
  return /* @__PURE__ */ g(Od, { scope: t, forceMount: n, children: /* @__PURE__ */ g(be, { present: n || s.open, children: /* @__PURE__ */ g(ft, { asChild: !0, container: o, children: r }) }) });
};
qs.displayName = dr;
var Ze = "TooltipContent", Zs = c.forwardRef(
  (e, t) => {
    const n = Id(Ze, e.__scopeTooltip), { forceMount: r = n.forceMount, side: o = "top", ...s } = e, i = wt(Ze, e.__scopeTooltip);
    return /* @__PURE__ */ g(be, { present: r || i.open, children: i.disableHoverableContent ? /* @__PURE__ */ g(Qs, { side: o, ...s, ref: t }) : /* @__PURE__ */ g(_d, { side: o, ...s, ref: t }) });
  }
), _d = c.forwardRef((e, t) => {
  const n = wt(Ze, e.__scopeTooltip), r = ur(Ze, e.__scopeTooltip), o = c.useRef(null), s = j(t, o), [i, a] = c.useState(null), { trigger: l, onClose: f } = n, u = o.current, { onPointerInTransitChange: d } = r, m = c.useCallback(() => {
    a(null), d(!1);
  }, [d]), v = c.useCallback(
    (y, p) => {
      const h = y.currentTarget, b = { x: y.clientX, y: y.clientY }, x = Fd(b, h.getBoundingClientRect()), w = $d(b, x), C = Vd(p.getBoundingClientRect()), S = Wd([...w, ...C]);
      a(S), d(!0);
    },
    [d]
  );
  return c.useEffect(() => () => m(), [m]), c.useEffect(() => {
    if (l && u) {
      const y = (h) => v(h, u), p = (h) => v(h, l);
      return l.addEventListener("pointerleave", y), u.addEventListener("pointerleave", p), () => {
        l.removeEventListener("pointerleave", y), u.removeEventListener("pointerleave", p);
      };
    }
  }, [l, u, v, m]), c.useEffect(() => {
    if (i) {
      const y = (p) => {
        const h = p.target, b = { x: p.clientX, y: p.clientY }, x = (l == null ? void 0 : l.contains(h)) || (u == null ? void 0 : u.contains(h)), w = !Bd(b, i);
        x ? m() : w && (m(), f());
      };
      return document.addEventListener("pointermove", y), () => document.removeEventListener("pointermove", y);
    }
  }, [l, u, i, f, m]), /* @__PURE__ */ g(Qs, { ...e, ref: s });
}), [Md, Dd] = nn(lt, { isInside: !1 }), kd = /* @__PURE__ */ ki("TooltipContent"), Qs = c.forwardRef(
  (e, t) => {
    const {
      __scopeTooltip: n,
      children: r,
      "aria-label": o,
      onEscapeKeyDown: s,
      onPointerDownOutside: i,
      ...a
    } = e, l = wt(Ze, n), f = rn(n), { onClose: u } = l;
    return c.useEffect(() => (document.addEventListener(An, u), () => document.removeEventListener(An, u)), [u]), c.useEffect(() => {
      if (l.trigger) {
        const d = (m) => {
          m.target instanceof Node && m.target.contains(l.trigger) && u();
        };
        return window.addEventListener("scroll", d, { capture: !0 }), () => window.removeEventListener("scroll", d, { capture: !0 });
      }
    }, [l.trigger, u]), /* @__PURE__ */ g(
      dt,
      {
        asChild: !0,
        disableOutsidePointerEvents: !1,
        onEscapeKeyDown: s,
        onPointerDownOutside: i,
        onFocusOutside: (d) => d.preventDefault(),
        onDismiss: u,
        children: /* @__PURE__ */ J(
          Qn,
          {
            "data-state": l.stateAttribute,
            ...f,
            ...a,
            ref: t,
            style: {
              ...a.style,
              "--radix-tooltip-content-transform-origin": "var(--radix-popper-transform-origin)",
              "--radix-tooltip-content-available-width": "var(--radix-popper-available-width)",
              "--radix-tooltip-content-available-height": "var(--radix-popper-available-height)",
              "--radix-tooltip-trigger-width": "var(--radix-popper-anchor-width)",
              "--radix-tooltip-trigger-height": "var(--radix-popper-anchor-height)"
            },
            children: [
              /* @__PURE__ */ g(kd, { children: r }),
              /* @__PURE__ */ g(Md, { scope: n, isInside: !0, children: /* @__PURE__ */ g(Ju, { id: l.contentId, role: "tooltip", children: o || r }) })
            ]
          }
        )
      }
    );
  }
);
Zs.displayName = Ze;
var Js = "TooltipArrow", Ld = c.forwardRef(
  (e, t) => {
    const { __scopeTooltip: n, ...r } = e, o = rn(n);
    return Dd(
      Js,
      n
    ).isInside ? null : /* @__PURE__ */ g(Jn, { ...o, ...r, ref: t });
  }
);
Ld.displayName = Js;
function Fd(e, t) {
  const n = Math.abs(t.top - e.y), r = Math.abs(t.bottom - e.y), o = Math.abs(t.right - e.x), s = Math.abs(t.left - e.x);
  switch (Math.min(n, r, o, s)) {
    case s:
      return "left";
    case o:
      return "right";
    case n:
      return "top";
    case r:
      return "bottom";
    default:
      throw new Error("unreachable");
  }
}
function $d(e, t, n = 5) {
  const r = [];
  switch (t) {
    case "top":
      r.push(
        { x: e.x - n, y: e.y + n },
        { x: e.x + n, y: e.y + n }
      );
      break;
    case "bottom":
      r.push(
        { x: e.x - n, y: e.y - n },
        { x: e.x + n, y: e.y - n }
      );
      break;
    case "left":
      r.push(
        { x: e.x + n, y: e.y - n },
        { x: e.x + n, y: e.y + n }
      );
      break;
    case "right":
      r.push(
        { x: e.x - n, y: e.y - n },
        { x: e.x - n, y: e.y + n }
      );
      break;
  }
  return r;
}
function Vd(e) {
  const { top: t, right: n, bottom: r, left: o } = e;
  return [
    { x: o, y: t },
    { x: n, y: t },
    { x: n, y: r },
    { x: o, y: r }
  ];
}
function Bd(e, t) {
  const { x: n, y: r } = e;
  let o = !1;
  for (let s = 0, i = t.length - 1; s < t.length; i = s++) {
    const a = t[s], l = t[i], f = a.x, u = a.y, d = l.x, m = l.y;
    u > r != m > r && n < (d - f) * (r - u) / (m - u) + f && (o = !o);
  }
  return o;
}
function Wd(e) {
  const t = e.slice();
  return t.sort((n, r) => n.x < r.x ? -1 : n.x > r.x ? 1 : n.y < r.y ? -1 : n.y > r.y ? 1 : 0), Hd(t);
}
function Hd(e) {
  if (e.length <= 1) return e.slice();
  const t = [];
  for (let r = 0; r < e.length; r++) {
    const o = e[r];
    for (; t.length >= 2; ) {
      const s = t[t.length - 1], i = t[t.length - 2];
      if ((s.x - i.x) * (o.y - i.y) >= (s.y - i.y) * (o.x - i.x)) t.pop();
      else break;
    }
    t.push(o);
  }
  t.pop();
  const n = [];
  for (let r = e.length - 1; r >= 0; r--) {
    const o = e[r];
    for (; n.length >= 2; ) {
      const s = n[n.length - 1], i = n[n.length - 2];
      if ((s.x - i.x) * (o.y - i.y) >= (s.y - i.y) * (o.x - i.x)) n.pop();
      else break;
    }
    n.push(o);
  }
  return n.pop(), t.length === 1 && n.length === 1 && t[0].x === n[0].x && t[0].y === n[0].y ? t : t.concat(n);
}
var zd = Ks, Ud = Ys, Gd = Xs, jd = qs, ei = Zs;
const qf = zd, Zf = Ud, Qf = Gd, Kd = c.forwardRef(({ className: e, sideOffset: t = 4, ...n }, r) => /* @__PURE__ */ g(jd, { children: /* @__PURE__ */ g(
  ei,
  {
    ref: r,
    sideOffset: t,
    className: _(
      // Inverted, high-contrast tooltip: flips with the theme via the
      // foreground/background tokens (dark chip in light mode, light chip
      // in dark mode).
      "z-50 overflow-hidden rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md",
      e
    ),
    ...n
  }
) }));
Kd.displayName = ei.displayName;
var fr = "Avatar", [Yd] = he(fr), Xd = [
  0,
  () => {
  }
], [qd, ti] = Yd(fr), pr = c.forwardRef(
  (e, t) => {
    const { __scopeAvatar: n, ...r } = e, [o, s] = c.useState("idle"), [i, a] = Qd();
    return /* @__PURE__ */ g(
      qd,
      {
        scope: n,
        imageLoadingStatus: o,
        setImageLoadingStatus: s,
        imageCount: i,
        setImageCount: a,
        children: /* @__PURE__ */ g(M.span, { ...r, ref: t })
      }
    );
  }
);
pr.displayName = fr;
var ni = "AvatarImage", mr = c.forwardRef(
  (e, t) => {
    const { __scopeAvatar: n, src: r, onLoadingStatusChange: o, ...s } = e, i = ti(ni, n);
    Jd(i.setImageCount);
    const a = Zd(r, {
      referrerPolicy: s.referrerPolicy,
      crossOrigin: s.crossOrigin,
      loadingStatus: i.imageLoadingStatus,
      setLoadingStatus: i.setImageLoadingStatus
    }), l = ae((u) => {
      o == null || o(u);
    }), f = c.useRef(a);
    return Z(() => {
      const u = f.current;
      f.current = a, a !== u && l(a);
    }, [a, l]), a === "loaded" ? /* @__PURE__ */ g(M.img, { ...s, ref: t, src: r }) : null;
  }
);
mr.displayName = ni;
var ri = "AvatarFallback", gr = c.forwardRef(
  (e, t) => {
    const { __scopeAvatar: n, delayMs: r, ...o } = e, s = ti(ri, n), [i, a] = c.useState(r === void 0);
    return c.useEffect(() => {
      if (r !== void 0) {
        const l = window.setTimeout(() => a(!0), r);
        return () => window.clearTimeout(l);
      }
    }, [r]), i && s.imageLoadingStatus !== "loaded" ? /* @__PURE__ */ g(M.span, { ...o, ref: t }) : null;
  }
);
gr.displayName = ri;
function Zd(e, {
  loadingStatus: t,
  setLoadingStatus: n,
  referrerPolicy: r,
  crossOrigin: o
}) {
  return Z(() => {
    if (!e) {
      n("error");
      return;
    }
    const s = new window.Image(), i = (l) => {
      const f = l.currentTarget;
      n(Zr(f));
    }, a = () => n("error");
    return s.addEventListener("load", i), s.addEventListener("error", a), r && (s.referrerPolicy = r), s.crossOrigin = o ?? null, s.src = e, n(Zr(s)), () => {
      s.removeEventListener("load", i), s.removeEventListener("error", a), n("idle");
    };
  }, [e, o, r, n]), t;
}
function Zr(e) {
  return e.complete ? e.naturalWidth > 0 ? "loaded" : "error" : "loading";
}
function Qd() {
  let e = Xd;
  {
    e = c.useState(0);
    const [t] = e, n = c.useRef(!1);
    c.useEffect(() => {
      t > 1 && !n.current && (n.current = !0, console.warn(
        "Avatar: Only one `Avatar.Image` component should be rendered per `Avatar.Root`, but multiple were detected. This will lead to unexpected behavior."
      ));
    }, [t]);
  }
  return e;
}
function Jd(e) {
  c.useEffect(() => (e((t) => t + 1), () => {
    e((t) => t - 1);
  }), [e]);
}
const ef = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  pr,
  {
    ref: n,
    className: _(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      e
    ),
    ...t
  }
));
ef.displayName = pr.displayName;
const tf = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  mr,
  {
    ref: n,
    className: _("aspect-square h-full w-full", e),
    ...t
  }
));
tf.displayName = mr.displayName;
const nf = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  gr,
  {
    ref: n,
    className: _(
      "flex h-full w-full items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground",
      e
    ),
    ...t
  }
));
nf.displayName = gr.displayName;
var vr = "Progress", hr = 100, [rf] = he(vr), [of, sf] = rf(vr), oi = c.forwardRef(
  (e, t) => {
    const {
      __scopeProgress: n,
      value: r = null,
      max: o,
      getValueLabel: s = af,
      ...i
    } = e;
    (o || o === 0) && !Qr(o) && console.error(cf(`${o}`, "Progress"));
    const a = Qr(o) ? o : hr;
    r !== null && !Jr(r, a) && console.error(lf(`${r}`, "Progress"));
    const l = Jr(r, a) ? r : null, f = Vt(l) ? s(l, a) : void 0;
    return /* @__PURE__ */ g(of, { scope: n, value: l, max: a, children: /* @__PURE__ */ g(
      M.div,
      {
        "aria-valuemax": a,
        "aria-valuemin": 0,
        "aria-valuenow": Vt(l) ? l : void 0,
        "aria-valuetext": f,
        role: "progressbar",
        "data-state": ai(l, a),
        "data-value": l ?? void 0,
        "data-max": a,
        ...i,
        ref: t
      }
    ) });
  }
);
oi.displayName = vr;
var si = "ProgressIndicator", ii = c.forwardRef(
  (e, t) => {
    const { __scopeProgress: n, ...r } = e, o = sf(si, n);
    return /* @__PURE__ */ g(
      M.div,
      {
        "data-state": ai(o.value, o.max),
        "data-value": o.value ?? void 0,
        "data-max": o.max,
        ...r,
        ref: t
      }
    );
  }
);
ii.displayName = si;
function af(e, t) {
  return `${Math.round(e / t * 100)}%`;
}
function ai(e, t) {
  return e == null ? "indeterminate" : e === t ? "complete" : "loading";
}
function Vt(e) {
  return typeof e == "number";
}
function Qr(e) {
  return Vt(e) && !isNaN(e) && e > 0;
}
function Jr(e, t) {
  return Vt(e) && !isNaN(e) && e <= t && e >= 0;
}
function cf(e, t) {
  return `Invalid prop \`max\` of value \`${e}\` supplied to \`${t}\`. Only numbers greater than 0 are valid max values. Defaulting to \`${hr}\`.`;
}
function lf(e, t) {
  return `Invalid prop \`value\` of value \`${e}\` supplied to \`${t}\`. The \`value\` prop must be:
  - a positive number
  - less than the value passed to \`max\` (or ${hr} if no \`max\` prop is set)
  - \`null\` or \`undefined\` if the progress is indeterminate.

Defaulting to \`null\`.`;
}
var ci = oi, uf = ii;
const df = c.forwardRef(({ className: e, value: t, ...n }, r) => /* @__PURE__ */ g(
  ci,
  {
    ref: r,
    className: _(
      "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
      e
    ),
    ...n,
    children: /* @__PURE__ */ g(
      uf,
      {
        className: "h-full w-full flex-1 bg-primary transition-transform",
        style: { transform: `translateX(-${100 - (t ?? 0)}%)` }
      }
    )
  }
));
df.displayName = ci.displayName;
var vn = !1;
function ff() {
  const [e, t] = c.useState(vn);
  return c.useEffect(() => {
    vn || (vn = !0, t(!0));
  }, []), e;
}
var li = c[" useSyncExternalStore ".trim().toString()];
function pf() {
  return () => {
  };
}
function mf() {
  return li(
    pf,
    () => !0,
    () => !1
  );
}
var gf = typeof li == "function" ? mf : ff, hn = "rovingFocusGroup.onEntryFocus", vf = { bubbles: !1, cancelable: !0 }, xt = "RovingFocusGroup", [In, ui, hf] = gs(xt), [bf, di] = he(
  xt,
  [hf]
), [yf, wf] = bf(xt), fi = c.forwardRef(
  (e, t) => /* @__PURE__ */ g(In.Provider, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ g(In.Slot, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ g(xf, { ...e, ref: t }) }) })
);
fi.displayName = xt;
var xf = c.forwardRef((e, t) => {
  const {
    __scopeRovingFocusGroup: n,
    orientation: r,
    loop: o = !1,
    dir: s,
    currentTabStopId: i,
    defaultCurrentTabStopId: a,
    onCurrentTabStopIdChange: l,
    onEntryFocus: f,
    preventScrollOnEntryFocus: u = !1,
    ...d
  } = e, m = c.useRef(null), v = j(t, m), y = tr(s), [p, h] = Le({
    prop: i,
    defaultProp: a ?? null,
    onChange: l,
    caller: xt
  }), [b, x] = c.useState(!1), w = ae(f), C = ui(n), S = c.useRef(!1), [R, E] = c.useState(0);
  return c.useEffect(() => {
    const T = m.current;
    if (T)
      return T.addEventListener(hn, w), () => T.removeEventListener(hn, w);
  }, [w]), /* @__PURE__ */ g(
    yf,
    {
      scope: n,
      orientation: r,
      dir: y,
      loop: o,
      currentTabStopId: p,
      onItemFocus: c.useCallback(
        (T) => h(T),
        [h]
      ),
      onItemShiftTab: c.useCallback(() => x(!0), []),
      onFocusableItemAdd: c.useCallback(
        () => E((T) => T + 1),
        []
      ),
      onFocusableItemRemove: c.useCallback(
        () => E((T) => T - 1),
        []
      ),
      children: /* @__PURE__ */ g(
        M.div,
        {
          tabIndex: b || R === 0 ? -1 : 0,
          "data-orientation": r,
          ...d,
          ref: v,
          style: { outline: "none", ...e.style },
          onMouseDown: O(e.onMouseDown, () => {
            S.current = !0;
          }),
          onFocus: O(e.onFocus, (T) => {
            const V = !S.current;
            if (T.target === T.currentTarget && V && !b) {
              const L = new CustomEvent(hn, vf);
              if (T.currentTarget.dispatchEvent(L), !L.defaultPrevented) {
                const P = C().filter((I) => I.focusable), N = P.find((I) => I.active), $ = P.find((I) => I.id === p), z = [N, $, ...P].filter(
                  Boolean
                ).map((I) => I.ref.current);
                gi(z, u);
              }
            }
            S.current = !1;
          }),
          onBlur: O(e.onBlur, () => x(!1))
        }
      )
    }
  );
}), pi = "RovingFocusGroupItem", mi = c.forwardRef(
  (e, t) => {
    const {
      __scopeRovingFocusGroup: n,
      focusable: r = !0,
      active: o = !1,
      tabStopId: s,
      children: i,
      ...a
    } = e, l = ge(), f = s || l, u = wf(pi, n), d = u.currentTabStopId === f, m = ui(n), { onFocusableItemAdd: v, onFocusableItemRemove: y, currentTabStopId: p } = u, h = gf();
    return Z(() => {
      if (!(!h || !r))
        return v(), () => y();
    }, [h, r, v, y]), c.useEffect(() => {
      if (!(h || !r))
        return v(), () => y();
    }, [h, r, v, y]), /* @__PURE__ */ g(
      In.ItemSlot,
      {
        scope: n,
        id: f,
        focusable: r,
        active: o,
        children: /* @__PURE__ */ g(
          M.span,
          {
            tabIndex: d ? 0 : -1,
            "data-orientation": u.orientation,
            ...a,
            ref: t,
            onMouseDown: O(e.onMouseDown, (b) => {
              r ? u.onItemFocus(f) : b.preventDefault();
            }),
            onFocus: O(e.onFocus, () => u.onItemFocus(f)),
            onKeyDown: O(e.onKeyDown, (b) => {
              if (b.key === "Tab" && b.shiftKey) {
                u.onItemShiftTab();
                return;
              }
              if (b.target !== b.currentTarget) return;
              const x = Rf(b, u.orientation, u.dir);
              if (x !== void 0) {
                if (b.metaKey || b.ctrlKey || b.altKey || b.shiftKey) return;
                b.preventDefault();
                let C = m().filter((S) => S.focusable).map((S) => S.ref.current);
                if (x === "last") C.reverse();
                else if (x === "prev" || x === "next") {
                  x === "prev" && C.reverse();
                  const S = C.indexOf(b.currentTarget);
                  C = u.loop ? Ef(C, S + 1) : C.slice(S + 1);
                }
                setTimeout(() => gi(C));
              }
            }),
            children: typeof i == "function" ? i({ isCurrentTabStop: d, hasTabStop: p != null }) : i
          }
        )
      }
    );
  }
);
mi.displayName = pi;
var Cf = {
  ArrowLeft: "prev",
  ArrowUp: "prev",
  ArrowRight: "next",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last"
};
function Sf(e, t) {
  return t !== "rtl" ? e : e === "ArrowLeft" ? "ArrowRight" : e === "ArrowRight" ? "ArrowLeft" : e;
}
function Rf(e, t, n) {
  const r = Sf(e.key, n);
  if (!(t === "vertical" && ["ArrowLeft", "ArrowRight"].includes(r)) && !(t === "horizontal" && ["ArrowUp", "ArrowDown"].includes(r)))
    return Cf[r];
}
function gi(e, t = !1) {
  const n = document.activeElement;
  for (const r of e)
    if (r === n || (r.focus({ preventScroll: t }), document.activeElement !== n)) return;
}
function Ef(e, t) {
  return e.map((n, r) => e[(t + r) % e.length]);
}
var Pf = fi, Nf = mi, on = "Tabs", [Tf] = he(on, [
  di
]), vi = di(), [Af, br] = Tf(on), hi = c.forwardRef(
  (e, t) => {
    const {
      __scopeTabs: n,
      value: r,
      onValueChange: o,
      defaultValue: s,
      orientation: i = "horizontal",
      dir: a,
      activationMode: l = "automatic",
      ...f
    } = e, u = tr(a), [d, m] = Le({
      prop: r,
      onChange: o,
      defaultProp: s ?? "",
      caller: on
    });
    return /* @__PURE__ */ g(
      Af,
      {
        scope: n,
        baseId: ge(),
        value: d,
        onValueChange: m,
        orientation: i,
        dir: u,
        activationMode: l,
        children: /* @__PURE__ */ g(
          M.div,
          {
            dir: u,
            "data-orientation": i,
            ...f,
            ref: t
          }
        )
      }
    );
  }
);
hi.displayName = on;
var bi = "TabsList", yi = c.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, loop: r = !0, ...o } = e, s = br(bi, n), i = vi(n);
    return /* @__PURE__ */ g(
      Pf,
      {
        asChild: !0,
        ...i,
        orientation: s.orientation,
        dir: s.dir,
        loop: r,
        children: /* @__PURE__ */ g(
          M.div,
          {
            role: "tablist",
            "aria-orientation": s.orientation,
            ...o,
            ref: t
          }
        )
      }
    );
  }
);
yi.displayName = bi;
var wi = "TabsTrigger", xi = c.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: r, disabled: o = !1, ...s } = e, i = br(wi, n), a = vi(n), l = Ri(i.baseId, r), f = Ei(i.baseId, r), u = r === i.value;
    return /* @__PURE__ */ g(
      Nf,
      {
        asChild: !0,
        ...a,
        focusable: !o,
        active: u,
        children: /* @__PURE__ */ g(
          M.button,
          {
            type: "button",
            role: "tab",
            "aria-selected": u,
            "aria-controls": f,
            "data-state": u ? "active" : "inactive",
            "data-disabled": o ? "" : void 0,
            disabled: o,
            id: l,
            ...s,
            ref: t,
            onMouseDown: O(e.onMouseDown, (d) => {
              !o && d.button === 0 && d.ctrlKey === !1 ? i.onValueChange(r) : d.preventDefault();
            }),
            onKeyDown: O(e.onKeyDown, (d) => {
              o || d.target !== d.currentTarget || [" ", "Enter"].includes(d.key) && i.onValueChange(r);
            }),
            onFocus: O(e.onFocus, () => {
              const d = i.activationMode !== "manual";
              !u && !o && d && i.onValueChange(r);
            })
          }
        )
      }
    );
  }
);
xi.displayName = wi;
var Ci = "TabsContent", Si = c.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: r, forceMount: o, children: s, ...i } = e, a = br(Ci, n), l = Ri(a.baseId, r), f = Ei(a.baseId, r), u = r === a.value, d = c.useRef(u);
    return c.useEffect(() => {
      const m = requestAnimationFrame(() => d.current = !1);
      return () => cancelAnimationFrame(m);
    }, []), /* @__PURE__ */ g(be, { present: o || u, children: ({ present: m }) => /* @__PURE__ */ g(
      M.div,
      {
        "data-state": u ? "active" : "inactive",
        "data-orientation": a.orientation,
        role: "tabpanel",
        "aria-labelledby": l,
        hidden: !m,
        id: f,
        tabIndex: 0,
        ...i,
        ref: t,
        style: {
          ...e.style,
          animationDuration: d.current ? "0s" : void 0
        },
        children: m && s
      }
    ) });
  }
);
Si.displayName = Ci;
function Ri(e, t) {
  return `${e}-trigger-${t}`;
}
function Ei(e, t) {
  return `${e}-content-${t}`;
}
var Of = hi, Pi = yi, Ni = xi, Ti = Si;
const Jf = Of, If = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  Pi,
  {
    ref: n,
    className: _(
      "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
      e
    ),
    ...t
  }
));
If.displayName = Pi.displayName;
const _f = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  Ni,
  {
    ref: n,
    className: _(
      "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow [&_svg]:size-4 [&_svg]:shrink-0",
      e
    ),
    ...t
  }
));
_f.displayName = Ni.displayName;
const Mf = c.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ g(
  Ti,
  {
    ref: n,
    className: _(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      e
    ),
    ...t
  }
));
Mf.displayName = Ti.displayName;
export {
  ef as Avatar,
  nf as AvatarFallback,
  tf as AvatarImage,
  Lf as Badge,
  Sa as Button,
  Ea as Card,
  Aa as CardContent,
  Ta as CardDescription,
  Oa as CardFooter,
  Pa as CardHeader,
  Na as CardTitle,
  $f as Dialog,
  Bf as DialogClose,
  dl as DialogContent,
  gl as DialogDescription,
  pl as DialogFooter,
  fl as DialogHeader,
  ko as DialogOverlay,
  ul as DialogPortal,
  ml as DialogTitle,
  Vf as DialogTrigger,
  La as Field,
  Ia as Input,
  fo as Label,
  Uf as Popover,
  jf as PopoverAnchor,
  Xu as PopoverContent,
  Gf as PopoverTrigger,
  df as Progress,
  Kf as Select,
  Sd as SelectContent,
  Yf as SelectGroup,
  Ed as SelectItem,
  Rd as SelectLabel,
  Gs as SelectScrollDownButton,
  Us as SelectScrollUpButton,
  Pd as SelectSeparator,
  Cd as SelectTrigger,
  Xf as SelectValue,
  Ba as Separator,
  Wf as Sheet,
  zf as SheetClose,
  bl as SheetContent,
  Cl as SheetDescription,
  wl as SheetFooter,
  yl as SheetHeader,
  Lo as SheetOverlay,
  vl as SheetPortal,
  xl as SheetTitle,
  Hf as SheetTrigger,
  Ff as Skeleton,
  Jf as Tabs,
  Mf as TabsContent,
  If as TabsList,
  _f as TabsTrigger,
  _a as Textarea,
  Zf as Tooltip,
  Kd as TooltipContent,
  qf as TooltipProvider,
  Qf as TooltipTrigger,
  Ra as badgeVariants,
  Ca as buttonVariants,
  _ as cn
};
//# sourceMappingURL=ssc-ui.js.map
