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
    leq: "≤", leqq: "≤", geq: "≥", geqq: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼",
    to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", Leftarrow: "⇐",
    in: "∈", subset: "⊂", supset: "⊃", subseteq: "⊆", cup: "∪", cap: "∩",
    sum: "∑", prod: "∏", int: "∫", infty: "∞", partial: "∂",
    ldots: "…", cdots: "⋯", dots: "…", forall: "∀", exists: "∃",
    therefore: "∴", because: "∵", ast: "∗", circ: "∘", bullet: "•",
    parallel: "∥", perp: "⊥", angle: "∠", triangle: "△",
    simeq: "≃", cong: "≅", equiv: "≡", propto: "∝",
    langle: "⟨", rangle: "⟩",
    sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", max: "max", min: "min",
    lim: "lim", det: "det", rank: "rank", tr: "tr"
  };
  const P0 = String.fromCharCode(0xE100); // 占位符
  const P1 = String.fromCharCode(0xE101);
  const PLACE_RE = new RegExp(P0 + "(\\d+)" + P1, "g");

  // 矩阵环境：提取为 stash 占位（& 分列，\\ 换行）
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
      const inner = out.slice(brace + 1, endIdx).trim();
      const rows = inner.split("\\\\").map(function (r) { return r.trim().split("&").map(function (c) { return c.trim(); }); });
      let html = '<span class="lmatrix">';
      rows.forEach(function (row) {
        html += '<span class="lrow">' + row.map(function (c) { return '<span class="lcell">' + esc(c) + "</span>"; }).join("") + "</span>";
      });
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

  function latexToHtml(latexInput) {
    let s = String(latexInput || "").trim();
    if (!s) return "";
    s = s.replace(/^\$+|\$+$/g, "").trim();

    // 矩阵先提取（原始文本），再转义其余内容
    const stash = [];
    s = renderEnv(s, stash);
    s = esc(s);

    s = loopReplace(s, /\\text\{([^{}]*)\}/g, function (m, t) { return '<span class="ltext">' + esc(t) + "</span>"; });
    s = loopReplace(s, /\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span class="lfrac"><span class="lnum">' + a + '</span><span class="lbar"></span><span class="lden">' + b + "</span></span>";
    });
    s = loopReplace(s, /\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span class="lsq"><span class="lsq-sign">√</span><span class="lsq-rad">' + a + "</span></span>";
    });
    s = applyCommand(s, "left", "");
    s = applyCommand(s, "right", "");
    s = s.split("\\big").join("").split("\\Big").join("");
    s = loopReplace(s, /\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, b, e) { return b + "<sup>" + e + "</sup>"; });
    s = loopReplace(s, /\{([^{}]*)\}_\{([^{}]*)\}/g, function (m, b, e) { return b + "<sub>" + e + "</sub>"; });
    s = loopReplace(s, /([A-Za-z0-9α-ωΑ-Ω)])\^\{([^{}]*)\}/g, function (m, b, e) { return b + "<sup>" + e + "</sup>"; });
    s = loopReplace(s, /([A-Za-z0-9α-ωΑ-Ω)])\_\{([^{}]*)\}/g, function (m, b, e) { return b + "<sub>" + e + "</sub>"; });
    s = loopReplace(s, /([A-Za-z0-9α-ωΑ-Ω)\)])\^([0-9A-Za-zα-ωΑ-Ω])/g, function (m, b, e) { return b + "<sup>" + e + "</sup>"; });
    s = loopReplace(s, /([A-Za-z0-9α-ωΑ-Ω)\)])\_([0-9A-Za-zα-ωΑ-Ω])/g, function (m, b, e) { return b + "<sub>" + e + "</sub>"; });
    Object.keys(GREEK).forEach(function (k) { s = applyCommand(s, k, GREEK[k]); });
    Object.keys(SYMBOLS).forEach(function (k) { if (k.length > 1) s = applyCommand(s, k, SYMBOLS[k]); });
    s = s.split("\\|").join("‖");
    s = s.replace(/\\[,;:!]/g, " ").replace(/\{/g, "").replace(/\}/g, "");
    // 还原矩阵占位（矩阵 HTML 已自身转义安全）
    s = s.replace(PLACE_RE, function (m, i) { return stash[Number(i)] || ""; });
    return '<span class="latex-inline">' + s + "</span>";
  }

  const api = { latexToHtml, esc, GREEK, SYMBOLS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LatexLib = api;
})(typeof self !== "undefined" ? self : this);
