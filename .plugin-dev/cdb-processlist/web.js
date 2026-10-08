var R = globalThis.React, RD = globalThis.ReactDOM;
var { useState: S, useCallback: E, useMemo: M, useEffect: F, useRef: G } = R;

var PLUG = "cdb-processlist", INJ = ["pageEditor", "uiActions"], UIA;
var MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
var COLS = ["ID", "USER", "HOST", "db", "COMMAND", "TIME", "STATE", "INFO"];

var C = {
  wrap: { margin: "12px 0", fontFamily: MONO, fontSize: 13, lineHeight: 1.45, width: "100%" },
  bar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-surface, var(--dsw-bg, rgba(0,0,0,.015)))" },
  sep: { width: 1, height: 18, background: "var(--dsw-border, #e3e3e8)", flex: "none", margin: "0 2px" },
  inp: { padding: "3px 8px", borderRadius: 5, border: "1px solid var(--dsw-border, #d6d6dd)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, outline: "none", fontFamily: "inherit" },
  btn: function (on) { return { padding: "4px 12px", borderRadius: 5, border: "1px solid " + (on ? "var(--dsw-pick, #4a6cf7)" : "var(--dsw-border, #d6d6dd)"), background: on ? "var(--dsw-pick, #4a6cf7)" : "transparent", color: on ? "#fff" : "var(--dsw-label, inherit)", cursor: on ? "pointer" : "default", font: "inherit", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "all .15s" }; },
  chip: function (on) { return { padding: "2px 10px", borderRadius: 999, border: "1px solid var(--dsw-border, #d6d6dd)", fontSize: 11, background: on ? "var(--dsw-pick-fill, rgba(74,108,247,.16))" : "transparent", color: on ? "var(--dsw-pick, #4a6cf7)" : "var(--dsw-label-3, #8a8f98)", cursor: "pointer", whiteSpace: "nowrap", transition: "all .15s" }; },
  muted: { fontSize: 10, color: "var(--dsw-label-3, #8a8f98)" },
  err: { color: "var(--dsw-danger, #d9534f)", fontSize: 11, whiteSpace: "pre-wrap", marginBottom: 6, padding: "8px 10px", borderRadius: 6, background: "rgba(217,83,79,.08)", border: "1px solid rgba(217,83,79,.2)" },
  entry: { minWidth: 0, overflow: "hidden", borderRadius: 8, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-surface, var(--dsw-bg, transparent))" },
  eHead: { display: "flex", minHeight: 32, alignItems: "center", gap: 8, padding: "4px 10px", borderBottom: "1px solid var(--dsw-border, #e3e3e8)" },
  eOrd: { color: "var(--dsw-label-3, #8a8f98)", fontSize: 10, flex: "none" },
  eName: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontSize: 12 },
  eCtx: { maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-label-3, #8a8f98)", fontSize: 10, flex: "none" },
  eBody: { minWidth: 0, padding: 8 },
  eBar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  // processlist terminal: pre-wrap to match slowlog/errorlog
  term: { maxWidth: "100%", overflow: "auto", margin: 0, padding: "10px 12px", borderRadius: 6, border: "1px solid #303642", background: "#17191f", color: "#f3f5f8", fontFamily: MONO, fontSize: 12.5, fontWeight: 500, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", letterSpacing: ".01em" },
  empty: { margin: 0, padding: "20px 12px", borderRadius: 6, border: "1px dashed var(--dsw-border, #d6d6dd)", background: "var(--dsw-surface, var(--dsw-bg, transparent))", color: "var(--dsw-label-3, #8a8f98)", fontSize: 11, textAlign: "center", lineHeight: 1.6 },
  ovr: { position: "fixed", inset: 0, zIndex: 3e3, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "stretch", justifyContent: "center", padding: 20 },
  ovrP: { display: "flex", minHeight: 0, width: "100%", maxWidth: 1600, flexDirection: "column", borderRadius: 10, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-bg, #fff)", overflow: "hidden" },
  ovrH: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-border, #e3e3e8)", fontFamily: MONO, fontSize: 12 },
  ovrB: { minHeight: 0, flex: 1, overflow: "auto", padding: 12 }
};

function str(v) { return v == null ? "" : typeof v == "string" ? v : String(v); }
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(d) { return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
function nextTs(s) { if (!s) return ""; var o = new Date(s.replace(/-/g, "/")); return Number.isNaN(o.getTime()) ? "" : fmtTime(new Date(o.getTime() + 1e3)); }
function clean(v) { var o = v == null ? "" : String(v); o = o.replace(/#X_X#Y_Y#/g, " "); o = o.replace(/-{6,}/g, " "); o = o.replace(/[\r\n\t]+/g, " "); o = o.replace(/\s+/g, " ").trim(); return o === "NULL" ? "" : o; }
function csv(v) { return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function fmtSnap(ts, rows, title, cont) {
  var idx = COLS.map(function (c) { return title.findIndex(function (t) { return String(t).toLowerCase() === c.toLowerCase(); }); });
  var header = "---------------" + ts + (cont ? "（接上页）" : "") + "---------------";
  var lines = rows.map(function (r) { return COLS.map(function (c, i) { return csv(clean(idx[i] >= 0 ? r[idx[i]] : "")); }).join(","); });
  return [header, COLS.join(","), ...lines].join("\n");
}
function getResult(d) { var r = d.result ?? null; return r && typeof r == "object" ? r : typeof d.ok == "boolean" ? d : null; }

function View(_a) {
  var data = _a.data, update = _a.update, writable = _a.writable;
  var ro = writable === false;
  var res0 = getResult(data);

  var [product, setProduct] = S(str(data.product ?? "CDB"));
  var [ip, setIp] = S(str(data.ip ?? ""));
  var [port, setPort] = S(str(data.port ?? "3306"));
  var [st, setSt] = S(str(data.startTime ?? fmtTime(new Date(Date.now() - 6e5))));
  var [et, setEt] = S(str(data.endTime ?? fmtTime(new Date())));
  var [limit, setLimit] = S(str(data.limit ?? 10));
  var [loading, setLoading] = S(false);
  var [error, setError] = S("");
  var [view, setView] = S("all");
  var [page, setPage] = S(0);
  var [per, setPer] = S(200);
  var [fs, setFs] = S(false);
  var actionId = G("cdb-processlist-" + crypto.randomUUID());
  var actionState = G({});
  var runRef = G(async function () {});

  F(function () { if (!fs) return; var fn = function (e) { if (e.key === "Escape") setFs(false); }; document.addEventListener("keydown", fn); return function () { document.removeEventListener("keydown", fn); }; }, [fs]);

  var snaps = M(function () { return [...(Array.isArray(res0?.snapshots) ? res0.snapshots : [])].sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); }); }, [res0]);
  var title = res0?.title?.length ? res0.title : ["timestamp", ...COLS];
  var flat = M(function () { var t = []; snaps.forEach(function (s, i) { if (!(view !== "all" && view !== i)) for (var r of s.rows) t.push({ snapshot: s.timestamp, cells: r }); }); return t; }, [snaps, view]);
  var total = snaps.reduce(function (t, s) { return t + s.rows.length; }, 0);
  var pages = Math.max(1, Math.ceil(flat.length / per));
  var cp = Math.min(page, pages - 1);
  var rows = flat.slice(cp * per, cp * per + per);
  var lastTs = snaps.length ? snaps[snaps.length - 1].timestamp : "";

  var shown = M(function () { var m = new Map(), ks = new Map(); for (var i = 0; i < cp * per; i++) { var x = flat[i]; if (x) ks.set(x.snapshot, (ks.get(x.snapshot) ?? 0) + 1); } for (var r of rows) { if (!m.has(r.snapshot)) { m.set(r.snapshot, []); ks.delete(r.snapshot); } m.get(r.snapshot).push(r.cells); } var keys = []; m.forEach(function (v, k) { keys.push(k); }); return keys.map(function (k) { return fmtSnap(k, m.get(k), title, (ks.get(k) ?? 0) > 0); }).join("\n\n"); }, [flat, rows, cp, per, title]);
  var allText = M(function () { return snaps.map(function (s) { return fmtSnap(s.timestamp, s.rows, title, false); }).join("\n\n"); }, [snaps, title]);
  actionState.current = {
    query: { product: product, ip: ip, port: port, startTime: st, endTime: et, limit: Number(limit) || 10 },
    loading: loading, error: error, page: cp + 1, pageCount: pages,
    snapshots: snaps, rows: rows, total: total, text: shown
  };

  var run = E(async function (newSt) {
    setLoading(true); setError("");
    var realSt = newSt ?? st;
    try {
      var res = await (await fetch("/api/cdb-processlist/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: product, ip: ip, port: port, startTime: realSt, endTime: et, limit: Number(limit) || 10 }) })).json();
      if (!res.ok) throw new Error(res.error || "查询失败");
      var x = { ...res, at: new Date().toISOString() };
      update({ product: product, ip: ip, port: port, startTime: realSt, endTime: et, limit: Number(limit) || 10, result: x });
      setSt(realSt); setView("all"); setPage(0);
    } catch (e) { setError("查询失败：" + String(e)); }
    finally { setLoading(false); }
  }, [product, ip, port, st, et, limit, update]);

  var copy = E(function () { try { navigator.clipboard?.writeText(allText); } catch {} }, [allText]);
  runRef.current = run;
  F(function () {
    if (!UIA) return;
    return UIA.register({
      plugin: PLUG, instanceId: actionId.current, kind: "cdb-processlist", label: "Processlist 原始快照", surface: "main",
      state: function () { return actionState.current; },
      actions: {
        set_query: {
          description: "设置实例和采样时间范围", risk: "write",
          inputSchema: { type: "object", properties: { product: { type: "string" }, ip: { type: "string" }, port: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, limit: { type: "number" } } },
          run: function (a) {
            if (ro) throw new Error("Processlist 块当前为只读态");
            if (typeof a.product === "string") setProduct(a.product);
            if (typeof a.ip === "string") setIp(a.ip);
            if (typeof a.port === "string") setPort(a.port);
            if (typeof a.startTime === "string") setSt(a.startTime);
            if (typeof a.endTime === "string") setEt(a.endTime);
            if (typeof a.limit === "number") setLimit(String(a.limit));
            return a;
          }
        },
        query: { description: "按当前条件查询 Processlist 快照", risk: "submit", run: function () { return runRef.current(); } },
        next_batch: { description: "从最后采样时间继续查询下一批", risk: "submit", run: function () { var t = nextTs(actionState.current.snapshots.at(-1)?.timestamp || ""); if (!t) throw new Error("没有可续查的采样时间"); return runRef.current(t); } },
        previous_page: { description: "打开上一页缓存结果", risk: "navigate", run: function () { setPage(function (v) { return Math.max(0, v - 1); }); } },
        next_page: { description: "打开下一页缓存结果", risk: "navigate", run: function () { setPage(function (v) { return Math.min(Math.max(0, actionState.current.pageCount - 1), v + 1); }); } },
        read_result: { description: "读取当前 Processlist 快照和 CSV 文本", risk: "read", run: function () { return actionState.current; } },
        fullscreen: { description: "全屏查看 Processlist", risk: "navigate", run: function () { setFs(true); } }
      }
    });
  }, []);
  var ctx = res0 ? [ip ? ip + ":" + port : "", res0.startTime && res0.endTime ? res0.startTime + " ~ " + res0.endTime : "", snaps.length + " 采样点", total + " 行"].filter(Boolean).join(" · ") : "";

  var el = R.createElement;
  var Term = function (txt, mh) { return el("pre", { style: { ...C.term, ...(mh ? { maxHeight: mh } : {}) }, "data-testid": "cdb-processlist-term" }, txt); };

  return el("div", { style: C.wrap, "data-testid": "cdb-processlist-block", onMouseDown: function (e) { e.target?.closest?.("input, select, button, a, pre") && e.stopPropagation(); } },
    // toolbar
    el("div", { style: C.bar },
      el("b", { style: { fontSize: 12, flex: "none" } }, "📋 Processlist"),
      el("div", { style: C.sep }),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: product, disabled: ro, onChange: function (e) { setProduct(e.target.value); } }, ["CDB", "TDSQL-C", "TDSQL"].map(function (v) { return el("option", { key: v, value: v }, v); })),
      el("input", { style: { ...C.inp, width: 130 }, placeholder: "IP", value: ip, disabled: ro, onChange: function (e) { setIp(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 60 }, placeholder: "端口", value: port, disabled: ro, onChange: function (e) { setPort(e.target.value); } }),
      el("div", { style: C.sep }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "开始时间", value: st, disabled: ro, onChange: function (e) { setSt(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "结束时间", value: et, disabled: ro, onChange: function (e) { setEt(e.target.value); } }),
      el("div", { style: C.sep }),
      el("span", { style: C.muted }, "TopN/点"),
      el("input", { style: { ...C.inp, width: 50 }, value: limit, disabled: ro, onChange: function (e) { setLimit(e.target.value); } }),
      el("button", { style: { ...C.btn(!ro && !loading), flex: "none" }, disabled: ro || loading, onClick: function () { var d = new Date(); setEt(fmtTime(d)); setSt(fmtTime(new Date(d.getTime() - 6e5))); } }, "最近10min"),
      el("button", { style: C.btn(!ro && !loading), disabled: ro || loading, onClick: function () { run(); }, "data-testid": "cdb-processlist-run" }, loading ? "查询中…" : "查询"),
      lastTs && !ro ? el("button", { style: C.btn(!loading && !!lastTs), disabled: loading || !lastTs, onClick: function () { var t = nextTs(lastTs); if (t) run(t); } }, "下一批采样点") : null,
      res0 ? el("span", { style: C.muted }, "data_status=", res0.dataStatus || "-", res0.truncation?.truncated ? " · 已截断" : "") : null
    ),
    // error
    error ? el("div", { style: C.err }, error) : null,
    // empty
    !res0 ? el("div", { style: C.empty, "data-testid": "cdb-processlist-empty-hint" }, "填 IP / 端口 / 时间范围后点「查询」。", el("br"), "时间点模式（开始=结束）拿整份快照；时间窗模式取前 4 个采样点，每点按 TIME 降序取 TopN。") : null,
    res0 && !snaps.length ? el("div", { style: C.empty, "data-testid": "cdb-processlist-empty" }, "原始 processlist 为空（data_status=", str(res0.dataStatus) || "empty", "）。") : null,
    // result
    snaps.length ? el("div", { style: C.entry },
      el("div", { style: C.eHead },
        el("span", { style: C.eOrd }, "#1"),
        el("span", { style: C.eName }, "cdb.processlist.query_processlist_raw_logs"),
        el("span", { style: C.eCtx }, ctx),
        el("button", { style: { flex: "none", width: 22, height: 22, padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--dsw-label-3, #8a8f98)", font: "13px/1 " + MONO, cursor: "pointer", opacity: .55 }, title: "全屏", onClick: function () { setFs(true); }, "data-testid": "cdb-processlist-zoom" }, "⤢")
      ),
      el("div", { style: C.eBody },
        // snapshot tabs
        el("div", { style: C.eBar },
          el("span", { style: C.muted }, "采样点"),
          el("span", { style: C.chip(view === "all"), onClick: function () { setView("all"); setPage(0); } }, "全部（", total, " 行）"),
          snaps.map(function (s, i) { return el("span", { key: i, style: C.chip(view === i), onClick: function () { setView(i); setPage(0); } }, s.timestamp, " · ", s.rows.length, "/", s.total); })
        ),
        // pagination
        el("div", { style: C.eBar },
          el("span", { style: C.muted }, "每页"),
          [100, 200, 500].map(function (v) { return el("span", { key: v, style: C.chip(per === v), onClick: function () { setPer(v); setPage(0); } }, v, " 行"); }),
          el("button", { style: { ...C.btn(cp > 0), padding: "2px 9px", fontSize: 11 }, disabled: cp === 0, onClick: function () { setPage(cp - 1); } }, "‹ 上页"),
          el("button", { style: { ...C.btn(cp < pages - 1), padding: "2px 9px", fontSize: 11 }, disabled: cp >= pages - 1, onClick: function () { setPage(cp + 1); } }, "下页 ›"),
          el("span", { style: C.muted, "data-testid": "cdb-processlist-page" }, "第 ", cp + 1, " / ", pages, " 页 · 本页 ", rows.length, " 行 / 共 ", flat.length, " 行"),
          el("span", { style: C.chip(false), onClick: copy }, "复制 CSV")
        ),
        Term(shown, 420)
      )
    ) : null,
    // fullscreen
    fs ? RD.createPortal(el("div", { style: C.ovr, onMouseDown: function (e) { e.target === e.currentTarget && setFs(false); } },
      el("div", { style: C.ovrP },
        el("div", { style: C.ovrH },
          el("b", null, "cdb.processlist.query_processlist_raw_logs"),
          el("span", { style: { color: "var(--dsw-label-3, #8a8f98)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, ctx),
          el("span", { style: C.chip(false), onClick: copy }, "复制 CSV"),
          el("span", { style: C.chip(false), onClick: function () { setFs(false); } }, "Esc 关闭")
        ),
        el("div", { style: C.ovrB }, Term(allText))
      )
    ), document.body) : null
  );
}

function apply(ctx) {
  UIA = ctx.uiActions;
  ctx.pageEditor.registerBlock({ kind: "cdb-processlist", plugin: PLUG, label: "Processlist 原始快照", blockType: "ops", blockTypeLabel: "运维", hint: "填 IP/端口/时间范围，拉原始 processlist 快照，按采样点分段 CSV 展示，支持分页与全屏", aliases: ["cdb", "processlist", "session", "会话", "连接", "快照"], defaults: { product: "CDB", ip: "", port: "3306", startTime: "", endTime: "", limit: 10 }, View: View });
}
export { apply as apply, INJ as inject, PLUG as name };
