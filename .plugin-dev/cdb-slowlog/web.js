var R = globalThis.React, RD = globalThis.ReactDOM;
var { useState: S, useCallback: E, useMemo: M, useEffect: F, useRef: G } = R;

var PLUG = "cdb-slowlog", INJ = ["pageEditor", "uiActions"], UIA;
var MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
var TIMEOUT = 12e4;

// ── shared style ──
var C = {
  wrap: { margin: "12px 0", fontFamily: MONO, fontSize: 13, lineHeight: 1.45, width: "100%" },
  // toolbar
  bar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-surface, var(--dsw-bg, rgba(0,0,0,.015)))" },
  grp: { display: "flex", alignItems: "center", gap: 4 },
  sep: { width: 1, height: 18, background: "var(--dsw-border, #e3e3e8)", flex: "none", margin: "0 2px" },
  inp: { padding: "3px 8px", borderRadius: 5, border: "1px solid var(--dsw-border, #d6d6dd)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, outline: "none", fontFamily: "inherit" },
  btn: function (on) { return { padding: "4px 12px", borderRadius: 5, border: "1px solid " + (on ? "var(--dsw-pick, #4a6cf7)" : "var(--dsw-border, #d6d6dd)"), background: on ? "var(--dsw-pick, #4a6cf7)" : "transparent", color: on ? "#fff" : "var(--dsw-label, inherit)", cursor: on ? "pointer" : "default", font: "inherit", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "all .15s" }; },
  chip: function (on) { return { padding: "2px 10px", borderRadius: 999, border: "1px solid var(--dsw-border, #d6d6dd)", fontSize: 11, background: on ? "var(--dsw-pick-fill, rgba(74,108,247,.16))" : "transparent", color: on ? "var(--dsw-pick, #4a6cf7)" : "var(--dsw-label-3, #8a8f98)", cursor: "pointer", whiteSpace: "nowrap", transition: "all .15s" }; },
  muted: { fontSize: 10, color: "var(--dsw-label-3, #8a8f98)" },
  err: { color: "var(--dsw-danger, #d9534f)", fontSize: 11, whiteSpace: "pre-wrap", marginBottom: 6, padding: "8px 10px", borderRadius: 6, background: "rgba(217,83,79,.08)", border: "1px solid rgba(217,83,79,.2)" },
  // card
  entry: { minWidth: 0, overflow: "hidden", borderRadius: 8, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-surface, var(--dsw-bg, transparent))" },
  eHead: { display: "flex", minHeight: 32, alignItems: "center", gap: 8, padding: "4px 10px", borderBottom: "1px solid var(--dsw-border, #e3e3e8)" },
  eOrd: { color: "var(--dsw-label-3, #8a8f98)", fontSize: 10, flex: "none" },
  eName: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontSize: 12 },
  eCtx: { maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-label-3, #8a8f98)", fontSize: 10, flex: "none" },
  eBody: { minWidth: 0, padding: 8 },
  eBar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  // terminal
  term: { maxWidth: "100%", overflow: "auto", margin: 0, padding: "10px 12px", borderRadius: 6, border: "1px solid #303642", background: "#17191f", color: "#f3f5f8", fontFamily: MONO, fontSize: 12.5, fontWeight: 500, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", letterSpacing: ".01em" },
  // states
  empty: { margin: 0, padding: "20px 12px", borderRadius: 6, border: "1px dashed var(--dsw-border, #d6d6dd)", background: "var(--dsw-surface, var(--dsw-bg, transparent))", color: "var(--dsw-label-3, #8a8f98)", fontSize: 11, textAlign: "center", lineHeight: 1.6 },
  // overlay
  ovr: { position: "fixed", inset: 0, zIndex: 3e3, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "stretch", justifyContent: "center", padding: 20 },
  ovrP: { display: "flex", minHeight: 0, width: "100%", maxWidth: 1600, flexDirection: "column", borderRadius: 10, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-bg, #fff)", overflow: "hidden" },
  ovrH: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-border, #e3e3e8)", fontFamily: MONO, fontSize: 12 },
  ovrB: { minHeight: 0, flex: 1, overflow: "auto", padding: 12 }
};

// ── helpers ──
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(d) { return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
function str(v) { return v == null ? "" : typeof v == "string" ? v : String(v); }
function fmtSlowTs(v) { var r = str(v).trim(), m = r.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/); return m ? m[1].slice(2)+m[2]+m[3]+"  "+Number(m[4])+":"+m[5]+":"+m[6] : r; }
function toUnix(v) { if (typeof v == "number" && Number.isFinite(v)) return Math.floor(v > 1e12 ? v/1e3 : v); var r = str(v).trim(); if (!r) return null; var d = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(r) ? r : r.replace(" ", "T")+"+08:00"); return Number.isNaN(d) ? null : Math.floor(d/1e3); }
function fmtUserHost(e) { var r = str(e.user_host).trim(); if (r.includes("@") || r.includes("[")) return r; var u = str(e.user_name).trim(); return !u && !r ? "" : (u||"unknown")+"["+(u||"unknown")+"] @  ["+r+"]"; }
function renderSlow(e) {
  var lines = [];
  var ts = e.log_timestamp ?? e.timestamp;
  if (ts != null && str(ts).trim()) lines.push("# Time: " + fmtSlowTs(ts));
  var uh = fmtUserHost(e), tid = e.thread_id ?? e.id;
  if (uh || tid != null) lines.push("# User@Host: " + uh + (tid != null ? "  Id: " + str(tid) : ""));
  var q = "";
  if (e.query_time != null) q += "Query_time: " + str(e.query_time);
  if (e.lock_time != null) q += (q ? "  " : "") + "Lock_time: " + str(e.lock_time);
  if (e.rows_sent != null) q += (q ? " " : "") + "Rows_sent: " + str(e.rows_sent);
  if (e.rows_examined != null) q += (q ? "  " : "") + "Rows_examined: " + str(e.rows_examined);
  if (q) lines.push("# " + q);
  var u = toUnix(ts); if (u != null) lines.push("SET timestamp=" + u + ";");
  var sql = e.sql_raw_text ?? e.sql_text ?? e.content;
  if (sql != null && str(sql).trim()) lines.push(str(sql).trim());
  return lines.join("\n");
}
function renderAll(records) { return records.map(renderSlow).join("\n\n"); }

// ── component ──
function View(_a) {
  var data = _a.data, update = _a.update, writable = _a.writable;
  var ro = writable === false;

  var [product, setProduct] = S(str(data.product ?? "CDB"));
  var [ip, setIp] = S(str(data.ip ?? ""));
  var [port, setPort] = S(str(data.port ?? "3306"));
  var [region, setRegion] = S(str(data.region ?? ""));
  var [role, setRole] = S(str(data.role ?? "master"));
  var [longId, setLongId] = S(str(data.longInstanceId ?? ""));
  var [nodeUuid, setNodeUuid] = S(str(data.nodeUuid ?? ""));
  var [st, setSt] = S(str(data.startTime ?? fmtTime(new Date(Date.now() - 36e5))));
  var [et, setEt] = S(str(data.endTime ?? fmtTime(new Date())));
  var [ps, setPs] = S(str(data.pageSize ?? 50));
  var [mqt, setMqt] = S(str(data.minQueryTime ?? ""));
  var [ob, setOb] = S(str(data.orderBy ?? "log_timestamp asc"));
  var [adv, setAdv] = S(false);
  var [loading, setLoading] = S(false);
  var [error, setError] = S("");
  var [notice, setNotice] = S("");
  var [pages, setPages] = S(Array.isArray(data.pages) ? data.pages : []);
  var [pi, setPi] = S(0);
  var [fs, setFs] = S(false);
  var alive = G(true);
  var actionId = G("cdb-slowlog-" + crypto.randomUUID());
  var actionState = G({});
  var runRef = G(async function () {});
  var nextRef = G(async function () {});

  F(function () { return function () { alive.current = false; }; }, []);

  var cur = pages[Math.min(pi, Math.max(0, pages.length - 1))]?.result;
  var records = M(function () { return cur && Array.isArray(cur.records) ? cur.records : []; }, [cur]);
  var isLast = records.length < (cur?.pageSize ?? 50);
  var text = M(function () { return renderAll(records); }, [records]);
  actionState.current = {
    query: { product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, nodeUuid: nodeUuid, startTime: st, endTime: et, pageSize: Number(ps) || 50, minQueryTime: mqt, orderBy: ob },
    loading: loading, error: error, notice: notice, page: pi + 1, pageCount: pages.length,
    isLast: isLast, result: cur || null, records: records, text: text
  };

  F(function () { if (pi > pages.length - 1) setPi(Math.max(0, pages.length - 1)); }, [pages.length, pi]);

  var doFetch = E(async function (cursor) {
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, TIMEOUT);
    try {
      var res = await fetch("/api/cdb-slowlog/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, nodeUuid: nodeUuid, startTime: st, endTime: et, cursor: cursor, pageSize: Number(ps) || 50, minQueryTime: mqt.trim() === "" ? void 0 : Number(mqt), orderBy: ob }), signal: ac.signal });
      var json = await res.json();
      if (!alive.current) return;
      return json;
    } catch (e) {
      if (!alive.current) return;
      throw new Error(ac.signal.aborted ? "查询超时（120 秒未返回）" : "请求失败：" + String(e && e.message ? e.message : e));
    } finally { clearTimeout(timer); }
  }, [product, ip, port, region, role, longId, nodeUuid, st, et, ps, mqt, ob]);

  var runQuery = E(async function () {
    setLoading(true); setError(""); setNotice("");
    try {
      var r = await doFetch("");
      if (!alive.current) return;
      if (!r.ok) throw new Error(r.error || "查询失败");
      var p = [{ cursor: "", result: { ...r, at: new Date().toISOString() } }];
      setPages(p); setPi(0);
      update({ product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, nodeUuid: nodeUuid, startTime: st, endTime: et, pageSize: Number(ps) || 50, minQueryTime: mqt, orderBy: ob, pages: p });
    } catch (e) { if (alive.current) setError("查询失败：" + String(e)); }
    finally { if (alive.current) setLoading(false); }
  }, [doFetch, update, product, ip, port, region, role, longId, nodeUuid, st, et, ps, mqt, ob]);

  var nextPage = E(async function () {
    var cp = pages[pi]; if (!cp) return;
    if (pages[pi + 1]) { setPi(pi + 1); return; }
    var nc = cp.result.nextCursor || ""; if (!nc) { setNotice("已经到尾了"); return; }
    setLoading(true); setError(""); setNotice("");
    try {
      var r = await doFetch(nc);
      if (!alive.current) return;
      if (!r.ok) throw new Error(r.error || "查询失败");
      var np = [...pages, { cursor: nc, result: { ...r, at: new Date().toISOString() } }];
      setPages(np); setPi(np.length - 1); update({ pages: np });
    } catch (e) { if (alive.current) setError("翻页失败：" + String(e)); }
    finally { if (alive.current) setLoading(false); }
  }, [doFetch, pages, pi, update]);

  var save = E(function (v) { try { update(v); } catch {} }, [update]);
  F(function () { var t = setTimeout(function () { save({ product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, nodeUuid: nodeUuid, startTime: st, endTime: et, pageSize: Number(ps) || 50, minQueryTime: mqt, orderBy: ob }); }, 500); return function () { clearTimeout(t); }; }, [product, ip, port, region, role, longId, nodeUuid, st, et, ps, mqt, ob, save]);

  var copy = E(function () { try { navigator.clipboard?.writeText(text); } catch {} }, [text]);
  runRef.current = runQuery;
  nextRef.current = nextPage;

  F(function () {
    if (!UIA) return;
    return UIA.register({
      plugin: PLUG, instanceId: actionId.current, kind: "cdb-slowlog", label: "原始慢日志", surface: "main",
      state: function () { return actionState.current; },
      actions: {
        set_query: {
          description: "设置慢日志实例、时间范围和过滤条件", risk: "write",
          inputSchema: { type: "object", properties: { product: { type: "string" }, ip: { type: "string" }, port: { type: "string" }, region: { type: "string" }, role: { type: "string" }, longInstanceId: { type: "string" }, nodeUuid: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, pageSize: { type: "number" }, minQueryTime: { type: "number" }, orderBy: { type: "string" } } },
          run: function (a) {
            if (ro) throw new Error("慢日志块当前为只读态");
            if (typeof a.product === "string") setProduct(a.product);
            if (typeof a.ip === "string") setIp(a.ip);
            if (typeof a.port === "string") setPort(a.port);
            if (typeof a.region === "string") setRegion(a.region);
            if (typeof a.role === "string") setRole(a.role);
            if (typeof a.longInstanceId === "string") setLongId(a.longInstanceId);
            if (typeof a.nodeUuid === "string") setNodeUuid(a.nodeUuid);
            if (typeof a.startTime === "string") setSt(a.startTime);
            if (typeof a.endTime === "string") setEt(a.endTime);
            if (typeof a.pageSize === "number") setPs(String(a.pageSize));
            if (typeof a.minQueryTime === "number") setMqt(String(a.minQueryTime));
            if (typeof a.orderBy === "string") setOb(a.orderBy);
            return a;
          }
        },
        query: { description: "按当前条件查询第一页慢日志", risk: "submit", run: function () { return runRef.current(); } },
        next_page: { description: "查询或打开下一页慢日志", risk: "submit", run: function () { return nextRef.current(); } },
        previous_page: { description: "打开已缓存的上一页", risk: "navigate", run: function () { setPi(function (v) { return Math.max(0, v - 1); }); } },
        first_page: { description: "回到第一页", risk: "navigate", run: function () { setPi(0); } },
        read_page: { description: "读取当前页慢日志记录和文本", risk: "read", run: function () { return actionState.current; } },
        fullscreen: { description: "全屏查看当前页慢日志", risk: "navigate", run: function () { setFs(true); } }
      }
    });
  }, []);

  F(function () { if (!fs) return; var fn = function (e) { if (e.key === "Escape") setFs(false); }; document.addEventListener("keydown", fn); return function () { document.removeEventListener("keydown", fn); }; }, [fs]);

  var ctx = cur ? [cur.meta?.longInstanceId ? String(cur.meta.longInstanceId).slice(0, 8) + "…" : ip ? ip + ":" + port : "", cur.startTime && cur.endTime ? cur.startTime + " ~ " + cur.endTime : "", cur.meta?.region ? String(cur.meta.region) : "", records.length + " 条"].filter(Boolean).join(" · ") : "";

  var el = R.createElement;
  return el("div", { style: C.wrap, "data-testid": "cdb-slowlog-block", onMouseDown: function (e) { e.target?.closest?.("input, select, button, a, pre") && e.stopPropagation(); } },
    // toolbar
    el("div", { style: C.bar },
      el("b", { style: { fontSize: 12, flex: "none" } }, "⏱ Slow Log"),
      el(C.sep ? "div" : "div", { style: C.sep }),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: product, disabled: ro, onChange: function (e) { setProduct(e.target.value); } }, ["CDB", "TDSQL-C", "TDSQL"].map(function (v) { return el("option", { key: v, value: v }, v); })),
      product === "TDSQL-C"
        ? el("input", { style: { ...C.inp, width: 200 }, placeholder: "node_uuid", value: nodeUuid, disabled: ro, onChange: function (e) { setNodeUuid(e.target.value); } })
        : el("input", { style: { ...C.inp, width: 130 }, placeholder: "IP", value: ip, disabled: ro, onChange: function (e) { setIp(e.target.value); } }),
      product !== "TDSQL-C" ? el("input", { style: { ...C.inp, width: 60 }, placeholder: "端口", value: port, disabled: ro, onChange: function (e) { setPort(e.target.value); } }) : null,
      product !== "TDSQL" ? el("input", { style: { ...C.inp, width: 100 }, placeholder: "region（自动）", value: region, disabled: ro, onChange: function (e) { setRegion(e.target.value); } }) : null,
      el("div", { style: C.sep }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "开始时间", value: st, disabled: ro, onChange: function (e) { setSt(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "结束时间", value: et, disabled: ro, onChange: function (e) { setEt(e.target.value); } }),
      el("div", { style: C.sep }),
      el("input", { style: { ...C.inp, width: 50 }, placeholder: "条数", value: ps, disabled: ro, onChange: function (e) { setPs(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 70 }, placeholder: "query_time≥", value: mqt, disabled: ro, onChange: function (e) { setMqt(e.target.value); } }),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: ob, disabled: ro, onChange: function (e) { setOb(e.target.value); } }, [
        el("option", { value: "log_timestamp asc" }, "时间升序"),
        el("option", { value: "log_timestamp desc" }, "时间降序"),
        el("option", { value: "query_time desc" }, "耗时降序")
      ]),
      el("span", { style: C.chip(adv), onClick: function () { setAdv(!adv); } }, adv ? "收起" : "高级"),
      el("button", { style: { ...C.btn(!ro && !loading), flex: "none" }, disabled: ro || loading, onClick: function () { var d = new Date(); setEt(fmtTime(d)); setSt(fmtTime(new Date(d.getTime() - 36e5))); } }, "最近1h"),
      el("button", { style: C.btn(!ro && !loading), disabled: ro || loading, onClick: runQuery, "data-testid": "cdb-slowlog-run" }, loading ? "查询中…" : "查询"),
      cur ? el("span", { style: C.muted }, "data_status=" + (cur.dataStatus || "-")) : null
    ),
    // advanced
    adv && !ro ? el("div", { style: C.bar },
      el("span", { style: C.muted }, "role"),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: role, onChange: function (e) { setRole(e.target.value); } }, ["master", "slave", "slave1", "ro"].map(function (v) { return el("option", { key: v, value: v }, v); })),
      el("input", { style: { ...C.inp, width: 300 }, placeholder: "long_instance_id（留空则按 ip+port 自动反查）", value: longId, onChange: function (e) { setLongId(e.target.value); } })
    ) : null,
    // error
    error ? el("div", { style: C.err, "data-testid": "cdb-slowlog-error" }, error, el("button", { style: { ...C.btn(true), padding: "1px 8px", fontSize: 11, marginLeft: 8 }, onClick: runQuery }, "重试")) : null,
    notice ? el("div", { style: C.muted }, notice) : null,
    // empty
    !cur ? el("div", { style: C.empty, "data-testid": "cdb-slowlog-hint" }, "填 IP / 端口 / 时间范围，点「查询」拉取原始慢日志。", el("br"), "结果按 MySQL 原始慢日志文本展示（# Time / # User@Host / # Query_time / SET timestamp / SQL）。") : null,
    cur && !records.length ? el("div", { style: C.empty, "data-testid": "cdb-slowlog-empty" }, "原始慢日志为空（data_status=", str(cur.dataStatus) || "empty", "）", cur.meta?.longInstanceId ? " · instance " + String(cur.meta.longInstanceId) : "", el("br"), "换时间窗，或用 query_time≥N 缩小范围。") : null,
    // result
    records.length ? el("div", { style: C.entry },
      el("div", { style: C.eHead },
        el("span", { style: C.eOrd }, "#", pi + 1),
        el("span", { style: C.eName }, "cdb.slow.export_raw_slow_log"),
        el("span", { style: C.eCtx }, ctx),
        el("button", { style: { flex: "none", width: 22, height: 22, padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--dsw-label-3, #8a8f98)", font: "13px/1 " + MONO, cursor: "pointer", opacity: .55 }, title: "全屏", onClick: function () { setFs(true); }, "data-testid": "cdb-slowlog-zoom" }, "⤢")
      ),
      el("div", { style: C.eBody },
        el("div", { style: C.eBar },
          el("button", { style: { ...C.btn(pi > 0), padding: "2px 9px", fontSize: 11 }, disabled: loading || pi === 0, onClick: function () { setPi(0); } }, "首页"),
          el("button", { style: { ...C.btn(pi > 0), padding: "2px 9px", fontSize: 11 }, disabled: loading || pi === 0, onClick: function () { setPi(pi - 1); } }, "‹ 上页"),
          el("button", { style: { ...C.btn(!isLast), padding: "2px 9px", fontSize: 11 }, disabled: loading || isLast, onClick: nextPage, "data-testid": "cdb-slowlog-next" }, loading ? "加载中…" : "下页 ›"),
          el("span", { style: C.muted, "data-testid": "cdb-slowlog-page" }, "第 ", pi + 1, " / ", Math.max(1, pages.length), " 页 · 本页 ", records.length, " 条", isLast ? " · 已到底" : " · 还有下一页"),
          el("span", { style: C.chip(false), onClick: copy }, "复制慢日志")
        ),
        el("pre", { style: { ...C.term, maxHeight: 460 }, "data-testid": "cdb-slowlog-term" }, text)
      )
    ) : null,
    // fullscreen
    fs ? RD.createPortal(el("div", { style: C.ovr, onMouseDown: function (e) { e.target === e.currentTarget && setFs(false); } },
      el("div", { style: C.ovrP },
        el("div", { style: C.ovrH },
          el("b", null, "cdb.slow.export_raw_slow_log"),
          el("span", { style: { color: "var(--dsw-label-3, #8a8f98)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, ctx),
          el("span", { style: C.chip(false), onClick: copy }, "复制慢日志"),
          el("span", { style: C.chip(false), onClick: function () { setFs(false); } }, "Esc 关闭")
        ),
        el("div", { style: C.ovrB }, el("pre", { style: { ...C.term, maxHeight: "none" } }, text))
      )
    ), document.body) : null
  );
}

function apply(ctx) {
  UIA = ctx.uiActions;
  ctx.pageEditor.registerBlock({ kind: "cdb-slowlog", plugin: PLUG, label: "原始慢日志", blockType: "ops", blockTypeLabel: "运维", hint: "填 IP/端口/时间范围，拉原始慢日志（不做模板聚合），按 MySQL 原始慢日志文本展示，支持翻页与全屏", aliases: ["cdb", "slow", "slowlog", "慢日志", "慢查询", "慢sql"], defaults: { product: "CDB", ip: "", port: "3306", region: "", role: "master", longInstanceId: "", nodeUuid: "", pageSize: 50, minQueryTime: "", orderBy: "log_timestamp asc", pages: [] }, View: View });
}
export { apply as apply, INJ as inject, PLUG as name };
