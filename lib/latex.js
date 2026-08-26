// B站字幕 AI 助手 - lib/latex.js
// 零依赖迷你 LaTeX→HTML 渲染器（课程常用公式：希腊字母/分数/根号/上下标/矩阵/符号）。
// UMD：浏览器全局 LatexLib 与 node require 均可用。
(function (global) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
    pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ",
    psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω"
  };

  const SYMBOLS = {
    cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓",
    le: "≤", leq: "≤", leqq: "≤", ge: "≥", geq: "≥", geqq: "≥", lt: "<", gt: ">",
    neq: "≠", ne: "≠", approx: "≈", sim: "∼",
    to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", Leftarrow: "⇐",
    leftrightarrow: "↔", Leftrightarrow: "⇔",
    Longleftrightarrow: "⇔", Longrightarrow: "⇒", Longleftarrow: "⇐",
    implies: "⇒", iff: "⇔",
    in: "∈", subset: "⊂", supset: "⊃", subseteq: "⊆", cup: "∪", cap: "∩",
    sum: "∑", prod: "∏", int: "∫", infty: "∞", partial: "∂",
    ldots: "…", cdots: "⋯", dots: "…", forall: "∀", exists: "∃",
    therefore: "∴", because: "∵", ast: "∗", circ: "∘", bullet: "•",
    parallel: "∥", perp: "⊥", angle: "∠", triangle: "△",
    simeq: "≃", cong: "≅", equiv: "≡", propto: "∝",
    langle: "⟨", rangle: "⟩",
    lvert: "|", rvert: "|", vert: "|", Vert: "‖", lVert: "‖", rVert: "‖", mid: "|",
    sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", max: "max", min: "min",
    lim: "lim", det: "det", rank: "rank", tr: "tr"
  };

  const P0 = String.fromCharCode(0xE100); // 占位符
  const P1 = String.fromCharCode(0xE101);
  const PLACE_RE = new RegExp(P0 + "(\\d+)" + P1, "g");

  // 矩阵环境：提取为 stash 占位（& 分列，\\ 换行）。
  // 单元格内容递归走完整渲染管线，因此 \alpha^T 这类表达式在矩阵里也能正确渲染。
  const ENV_DELIM = {
    pmatrix: { open: "(", close: ")", cls: "lpmatrix" },
    bmatrix: { open: "[", close: "]", cls: "lbmatrix" },
    Bmatrix: { open: "{", close: "}", cls: "lBmatrix" },
    vmatrix: { open: "", close: "", cls: "lvmatrix" },
    Vmatrix: { open: "‖", close: "‖", cls: "lVmatrix" },
    matrix: { open: "", close: "", cls: "" },
    smallmatrix: { open: "", close: "", cls: "" },
    array: { open: "", close: "", cls: "" },
    cases: { open: "{", close: "", cls: "lcases" }
  };

  function renderEnv(s, stash) {
    let out = s;
    while (true) {
      const beginTag = "\\begin{";
      const idx = out.indexOf(beginTag);
      if (idx < 0) return out;
      const brace = out.indexOf("}", idx + beginTag.length);
      if (brace < 0) return out;
      const envName = out.slice(idx + beginTag.length, brace);
      const endTag = "\\end{" + envName + "}";
      const endIdx = out.indexOf(endTag, brace + 1);
      if (endIdx < 0) return out;
      let inner = out.slice(brace + 1, endIdx).trim();
      // array 的列说明 {cc} 不是内容，去掉
      if (envName === "array" && inner.startsWith("{")) {
        const close = inner.indexOf("}");
        if (close >= 0) inner = inner.slice(close + 1).trim();
      }
      const rows = inner.split("\\\\").map(function (r) { return r.trim().split("&").map(function (c) { return c.trim(); }); });
      const meta = ENV_DELIM[envName] || { open: "", close: "", cls: "" };
      let mcls = "lmatrix";
      if (meta.cls) mcls += " " + meta.cls;
      let html = '<span class="lmath">';
      if (meta.open) html += '<span class="ldelim">' + esc(meta.open) + "</span>";
      html += '<span class="' + mcls + '">';
      rows.forEach(function (row) {
        html += '<span class="lrow">' + row.map(function (c) { return '<span class="lcell">' + renderCore(c, stash) + "</span>"; }).join("") + "</span>";
      });
      html += "</span>";
      if (meta.close) html += '<span class="ldelim">' + esc(meta.close) + "</span>";
      html += "</span>";
      stash.push(html);
      out = out.slice(0, idx) + P0 + (stash.length - 1) + P1 + out.slice(endIdx + endTag.length);
    }
  }

  function loopReplace(s, re, fn) {
    let out = s, prev = null;
    while (out !== prev) {
      prev = out;
      out = out.replace(re, fn);
    }
    return out;
  }

  // 词边界命令替换：匹配 \\name，后随字母不算（避免 \\rightarrow 被 \\right/\\left 误删）
  function applyCommand(s, name, value) {
    const re = new RegExp("\\\\" + name + "(?![a-zA-Z])", "g");
    return s.replace(re, value);
  }

  function renderCore(s, stash) {
    let out = renderEnv(s, stash);
    out = esc(out);

    // \text、\operatorname 与常用字体命令
    out = loopReplace(out, /\\text\{([^{}]*)\}/g, function (m, t) { return '<span class="ltext">' + t + "</span>"; });
    out = loopReplace(out, /\\operatorname\{([^{}]*)\}/g, function (m, t) { return '<span class="lop">' + t + "</span>"; });
    out = loopReplace(out, /\\mathrm\{([^{}]*)\}/g, function (m, t) { return '<span class="lop">' + t + "</span>"; });
    out = loopReplace(out, /\\mathbb\{([^{}]*)\}/g, function (m, t) { return '<span class="lbb">' + t + "</span>"; });
    out = loopReplace(out, /\\mathcal\{([^{}]*)\}/g, function (m, t) { return '<span class="lcal">' + t + "</span>"; });
    out = loopReplace(out, /\\mathbf\{([^{}]*)\}/g, function (m, t) { return "<strong>" + t + "</strong>"; });
    out = loopReplace(out, /\\mathit\{([^{}]*)\}/g, function (m, t) { return "<em>" + t + "</em>"; });
    out = loopReplace(out, /\\mathsf\{([^{}]*)\}/g, function (m, t) { return '<span class="lop">' + t + "</span>"; });
    out = loopReplace(out, /\\mathtt\{([^{}]*)\}/g, function (m, t) { return '<span class="lop">' + t + "</span>"; });

    // 分数 / 根号
    out = loopReplace(out, /\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span class="lfrac"><span class="lnum">' + a + '</span><span class="lbar"></span><span class="lden">' + b + "</span></span>";
    });
    out = loopReplace(out, /\\dfrac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span class="lfrac"><span class="lnum">' + a + '</span><span class="lbar"></span><span class="lden">' + b + "</span></span>";
    });
    out = loopReplace(out, /\\tfrac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span class="lfrac"><span class="lnum">' + a + '</span><span class="lbar"></span><span class="lden">' + b + "</span></span>";
    });
    out = loopReplace(out, /\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span class="lsq"><span class="lsq-sign">√</span><span class="lsq-rad">' + a + "</span></span>";
    });

    // 去掉定界符大小命令（左右括号本身保留）
    ["left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr"].forEach(function (name) {
      out = applyCommand(out, name, "");
    });

    // 希腊字母与符号先于上下标解析：\alpha^T 先变 α^T，再变 α<sup>T</sup>
    Object.keys(GREEK).forEach(function (k) { out = applyCommand(out, k, GREEK[k]); });
    Object.keys(SYMBOLS).forEach(function (k) { if (k.length > 1) out = applyCommand(out, k, SYMBOLS[k]); });

    // 上下标（通用版：{base}^{exp}、^{exp}、A^2、A_1）
    out = loopReplace(out, /\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, b, e) { return b + "<sup>" + e + "</sup>"; });
    out = loopReplace(out, /\^\{([^{}]*)\}/g, function (m, e) { return "<sup>" + e + "</sup>"; });
    out = loopReplace(out, /\{([^{}]*)\}_\{([^{}]*)\}/g, function (m, b, e) { return b + "<sub>" + e + "</sub>"; });
    out = loopReplace(out, /_\{([^{}]*)\}/g, function (m, e) { return "<sub>" + e + "</sub>"; });
    out = loopReplace(out, /([^\s<>&])\^([0-9A-Za-zα-ωΑ-Ω])/g, function (m, b, e) { return b + "<sup>" + e + "</sup>"; });
    out = loopReplace(out, /([^\s<>&])\_([0-9A-Za-zα-ωΑ-Ω])/g, function (m, b, e) { return b + "<sub>" + e + "</sub>"; });

    // 重音 / 横线（放在上下标之后，避免打断 ^ 解析）
    out = loopReplace(out, /\\overline\{([^{}]*)\}/g, function (m, a) { return '<span class="loverline">' + a + "</span>"; });
    out = loopReplace(out, /\\underline\{([^{}]*)\}/g, function (m, a) { return '<span class="lunderline">' + a + "</span>"; });
    out = loopReplace(out, /\\bar\{([^{}]*)\}/g, function (m, a) { return '<span class="loverline">' + a + "</span>"; });
    out = loopReplace(out, /\\vec\{([^{}]*)\}/g, function (m, a) { return '<span class="lvec">' + a + "</span>"; });
    out = loopReplace(out, /\\hat\{([^{}]*)\}/g, function (m, a) { return '<span class="lhat">' + a + "</span>"; });
    out = loopReplace(out, /\\tilde\{([^{}]*)\}/g, function (m, a) { return '<span class="ltilde">' + a + "</span>"; });
    out = loopReplace(out, /\\dot\{([^{}]*)\}/g, function (m, a) { return '<span class="ldot">' + a + "</span>"; });

    // 空白与残留命令
    out = out.split("\\quad").join(" ").split("\\qquad").join(" ");
    out = out.replace(/\\limits/g, "").replace(/\\nolimits/g, "");
    out = out.split("\\|").join("‖");
    out = out.replace(/\\[,;:!]/g, " ").replace(/\{/g, "").replace(/\}/g, "");
    // 还原矩阵占位（矩阵 HTML 已自身转义安全）
    out = out.replace(PLACE_RE, function (m, i) { return stash[Number(i)] || ""; });
    return out;
  }

  function latexToHtml(latexInput) {
    let s = String(latexInput || "").trim();
    if (!s) return "";
    s = s.replace(/^\$+|\$+$/g, "").trim();
    const stash = [];
    return '<span class="latex-inline">' + renderCore(s, stash) + "</span>";
  }

  const api = { latexToHtml, esc, GREEK, SYMBOLS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LatexLib = api;
})(typeof self !== "undefined" ? self : this);
