// B站字幕 AI 助手 - lib/markdown.js
// 零依赖轻量 Markdown 渲染：代码块/标题/粗斜体/行内代码/列表/引用/链接/段落。
// 安全策略：先 HTML 转义再渲染语法；链接仅允许 http/https。UMD：SW importScripts 与 node require 均可用。
(function (global) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const P0 = String.fromCharCode(0xE100);
  const P1 = String.fromCharCode(0xE101);
  const PLACE_RE = new RegExp(P0 + "(\\d+)" + P1, "g");

  function latexLib() {
    return (typeof globalThis !== "undefined" && globalThis.LatexLib) || null;
  }

  // 行内语法（内部先做 HTML 转义，保证输出安全；支持 $...$ 数学公式）
  function renderInline(s) {
    const stash = [];
    const lx = latexLib();
    if (lx) {
      s = s.replace(/\$([^$\n]+)\$/g, function (m, latex) {
        stash.push(lx.latexToHtml(latex));
        return P0 + (stash.length - 1) + P1;
      });
    }
    let out = esc(s);
    // 行内代码（先处理，避免内部语法被解析）
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    // 粗体
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 斜体
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // 链接（仅 http/https，防注入）
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // 还原公式
    out = out.replace(PLACE_RE, function (_m, idx) { return stash[Number(idx)] || ""; });
    // 时间戳可点击：[mm:ss] / [h:mm:ss]（点击跳转视频，由面板事件委托处理）
    out = out.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\.\d+)?\]/g, function (_m, t) {
      const p = String(t).split(":").map(Number);
      const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
      return '<span class="ts-link" data-t="' + sec + '">[' + t + "]</span>";
    });
    return out;
  }

  function mdToHtml(text) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const out = [];
    let i = 0;
    let inCode = false;
    let codeBuf = [];
    let blockLatex = null; // {buf:[]} 多行 $$...$$
    let listBuf = null;    // {type:'ul'|'ol', items:[]}
    let quoteBuf = [];

    const flushList = () => {
      if (!listBuf) return;
      out.push("<" + listBuf.type + ">" + listBuf.items.map(it => "<li>" + renderInline(it) + "</li>").join("") + "</" + listBuf.type + ">");
      listBuf = null;
    };
    const flushQuote = () => {
      if (!quoteBuf.length) return;
      out.push("<blockquote>" + quoteBuf.map(q => "<p>" + renderInline(q) + "</p>").join("") + "</blockquote>");
      quoteBuf = [];
    };

    while (i < lines.length) {
      const raw = lines[i];

      // 代码块开关
      if (/^```/.test(raw)) {
        if (inCode) { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); codeBuf = []; inCode = false; }
        else { flushList(); flushQuote(); inCode = true; codeBuf = []; }
        i++; continue;
      }
      if (inCode) { codeBuf.push(raw); i++; continue; }

      const line = raw.trim();

      // 空行：刷新列表/引用
      if (!line) { flushList(); flushQuote(); i++; continue; }

      // 块级数学公式 $$...$$（支持单行与多行）
      if (line.startsWith("$$")) {
        flushList(); flushQuote();
        const lx = latexLib();
        if (line.endsWith("$$") && line.length > 4) {
          out.push('<div class="latex-block">' + (lx ? lx.latexToHtml(line.slice(2, -2).trim()) : esc(line)) + "</div>");
        } else {
          blockLatex = { buf: [line] };
        }
        i++; continue;
      }
      if (blockLatex) {
        blockLatex.buf.push(raw);
        if (raw.trim().endsWith("$$")) {
          const joined = blockLatex.buf.join("\n").replace(/^\$\$/g, "").replace(/\$\$$/g, "").trim();
          const lx = latexLib();
          out.push('<div class="latex-block">' + (lx ? lx.latexToHtml(joined) : esc(blockLatex.buf.join("\n"))) + "</div>");
          blockLatex = null;
        }
        i++; continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushList(); flushQuote(); const n = h[1].length; out.push("<h" + n + ">" + renderInline(h[2]) + "</h" + n + ">"); i++; continue; }

      // 引用
      const q = line.match(/^>\s?(.*)$/);
      if (q) { flushList(); quoteBuf.push(q[1]); i++; continue; }
      flushQuote();

      // 无序列表
      const ul = line.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        if (!listBuf || listBuf.type !== "ul") { flushList(); listBuf = { type: "ul", items: [] }; }
        listBuf.items.push(ul[1]); i++; continue;
      }
      // 有序列表
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        if (!listBuf || listBuf.type !== "ol") { flushList(); listBuf = { type: "ol", items: [] }; }
        listBuf.items.push(ol[1]); i++; continue;
      }
      flushList();

      // 普通段落
      out.push("<p>" + renderInline(line) + "</p>");
      i++;
    }
    if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    flushList();
    flushQuote();
    return out.join("\n");
  }

  const api = { mdToHtml, esc, renderInline };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.MarkdownLib = api;
})(typeof self !== "undefined" ? self : this);
