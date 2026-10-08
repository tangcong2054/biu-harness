var R = globalThis.React, RD = globalThis.ReactDOM;
var { useState: S, useCallback: E, useMemo: M, useEffect: F, useRef: G } = R;

var PLUG = "cdb-errorlog", INJ = ["pageEditor", "uiActions"], UIA;
var MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
var TIMEOUT = 12e4;
var LEVELS = ["", "error", "warning", "note", "system"];

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
  term: { maxWidth: "100%", overflow: "auto", margin: 0, padding: "10px 12px", borderRadius: 6, border: "1px solid #303642", background: "#17191f", color: "#f3f5f8", fontFamily: MONO, fontSize: 12.5, fontWeight: 500, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", letterSpacing: ".01em" },
  empty: { margin: 0, padding: "20px 12px", borderRadius: 6, border: "1px dashed var(--dsw-border, #d6d6dd)", background: "var(--dsw-surface, var(--dsw-bg, transparent))", color: "var(--dsw-label-3, #8a8f98)", fontSize: 11, textAlign: "center", lineHeight: 1.6 },
  ovr: { position: "fixed", inset: 0, zIndex: 3e3, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "stretch", justifyContent: "center", padding: 20 },
  ovrP: { display: "flex", minHeight: 0, width: "100%", maxWidth: 1600, flexDirection: "column", borderRadius: 10, border: "1px solid var(--dsw-border, #e3e3e8)", background: "var(--dsw-bg, #fff)", overflow: "hidden" },
  ovrH: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-border, #e3e3e8)", fontFamily: MONO, fontSize: 12 },
  ovrB: { minHeight: 0, flex: 1, overflow: "auto", padding: 12 }
};

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(d) { return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
function str(v) { return v == null ? "" : typeof v == "string" ? v : String(v); }

function View(_a) {
  var data = _a.data, update = _a.update, writable = _a.writable;
  var ro = writable === false;

  var [product, setProduct] = S(str(data.product ?? "CDB"));
  var [ip, setIp] = S(str(data.ip ?? ""));
  var [port, setPort] = S(str(data.port ?? "3306"));
  var [region, setRegion] = S(str(data.region ?? ""));
  var [role, setRole] = S(str(data.role ?? "master"));
  var [longId, setLongId] = S(str(data.longInstanceId ?? ""));
  var [st, setSt] = S(str(data.startTime ?? fmtTime(new Date(Date.now() - 36e5))));
  var [et, setEt] = S(str(data.endTime ?? fmtTime(new Date())));
  var [level, setLevel] = S(str(data.level ?? ""));
  var [kw, setKw] = S(str(data.keyword ?? ""));
  var [adv, setAdv] = S(false);
  var [loading, setLoading] = S(false);
  var [error, setError] = S("");
  var [meta, setMeta] = S("");
  var [result, setResult] = S(data.result && typeof data.result == "object" ? data.result : null);
  var [fs, setFs] = S(false);
  var alive = G(true);
  var actionId = G("cdb-errorlog-" + crypto.randomUUID());
  var actionState = G({});
  var runRef = G(async function () {});

  F(function () { return function () { alive.current = false; }; }, []);

  var entries = M(function () { return result && Array.isArray(result.entries) ? result.entries : []; }, [result]);
  var text = M(function () { return entries.map(function (e) { return str(e.line); }).join("\n"); }, [entries]);
  var ctx2 = M(function () { var r = []; if (result) { r.push((result.startTime || "") + " → " + (result.endTime || "")); if (result.whereCondition) r.push(result.whereCondition); r.push("共 " + entries.length + " 条"); } return r.join(" · "); }, [result, entries.length]);
  actionState.current = {
    query: { product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, startTime: st, endTime: et, level: level, keyword: kw },
    loading: loading, error: error, result: result, entries: entries, text: text
  };

  var save = E(function (v) { try { update(v); } catch {} }, [update]);
  F(function () { var t = setTimeout(function () { save({ product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, startTime: st, endTime: et, level: level, keyword: kw }); }, 500); return function () { clearTimeout(t); }; }, [product, ip, port, region, role, longId, st, et, level, kw, save]);

  var run = E(async function () {
    setLoading(true); setError("");
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, TIMEOUT);
    try {
      var res = await fetch("/api/cdb-errorlog/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, startTime: st, endTime: et, level: level, keyword: kw }), signal: ac.signal });
      var json = await res.json();
      if (!alive.current) return;
      if (json && json.ok) {
        var r = { ok: true, tool: json.tool, args: json.args, startTime: json.startTime, endTime: json.endTime, whereCondition: json.whereCondition, dataStatus: json.dataStatus, total: json.total, entries: json.entries || [], meta: json.meta || {}, at: new Date().toISOString() };
        setResult(r);
        var m = json.meta || {};
        setMeta([m.longInstanceId ? "instance " + m.longInstanceId : "", m.region || "", m.role || ""].filter(Boolean).join(" · "));
        save({ result: r, product: product, ip: ip, port: port, region: region, role: role, longInstanceId: longId, startTime: st, endTime: et, level: level, keyword: kw });
      } else setError(str(json && json.error) || "查询失败");
    } catch (e) { if (alive.current) setError(ac.signal.aborted ? "查询超时（120 秒未返回）" : "请求失败：" + String(e && e.message ? e.message : e)); }
    finally { clearTimeout(timer); if (alive.current) setLoading(false); }
  }, [product, ip, port, region, role, longId, st, et, level, kw, save]);

  var copy = E(function () { try { navigator.clipboard?.writeText(text); } catch {} }, [text]);
  runRef.current = run;
  F(function () {
    if (!UIA) return;
    return UIA.register({
      plugin: PLUG, instanceId: actionId.current, kind: "cdb-errorlog", label: "CDB 错误日志", surface: "main",
      state: function () { return actionState.current; },
      actions: {
        set_query: {
          description: "设置错误日志实例、时间范围和过滤条件", risk: "write",
          inputSchema: { type: "object", properties: { product: { type: "string" }, ip: { type: "string" }, port: { type: "string" }, region: { type: "string" }, role: { type: "string" }, longInstanceId: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, level: { type: "string" }, keyword: { type: "string" } } },
          run: function (a) {
            if (ro) throw new Error("错误日志块当前为只读态");
            if (typeof a.product === "string") setProduct(a.product);
            if (typeof a.ip === "string") setIp(a.ip);
            if (typeof a.port === "string") setPort(a.port);
            if (typeof a.region === "string") setRegion(a.region);
            if (typeof a.role === "string") setRole(a.role);
            if (typeof a.longInstanceId === "string") setLongId(a.longInstanceId);
            if (typeof a.startTime === "string") setSt(a.startTime);
            if (typeof a.endTime === "string") setEt(a.endTime);
            if (typeof a.level === "string") setLevel(a.level);
            if (typeof a.keyword === "string") setKw(a.keyword);
            return a;
          }
        },
        query: { description: "按当前条件查询错误日志", risk: "submit", run: function () { return runRef.current(); } },
        read_result: { description: "读取错误日志结果和文本", risk: "read", run: function () { return actionState.current; } },
        fullscreen: { description: "全屏查看错误日志", risk: "navigate", run: function () { setFs(true); } }
      }
    });
  }, []);
  F(function () { if (!fs) return; var fn = function (e) { if (e.key === "Escape") setFs(false); }; document.addEventListener("keydown", fn); return function () { document.removeEventListener("keydown", fn); }; }, [fs]);

  var el = R.createElement;
  return el("div", { style: C.wrap, "data-testid": "cdb-errorlog" },
    // toolbar
    el("div", { style: C.bar },
      el("b", { style: { fontSize: 12, flex: "none" } }, "⚠ 错误日志"),
      el("div", { style: C.sep }),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: product, disabled: ro, onChange: function (e) { setProduct(e.target.value); } }, ["CDB", "TDSQL-C", "TDSQL"].map(function (v) { return el("option", { key: v, value: v }, v); })),
      el("input", { style: { ...C.inp, width: 130 }, placeholder: "IP", value: ip, disabled: ro, onChange: function (e) { setIp(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 60 }, placeholder: "端口", value: port, disabled: ro, onChange: function (e) { setPort(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 100 }, placeholder: "region（自动）", value: region, disabled: ro, onChange: function (e) { setRegion(e.target.value); } }),
      el("div", { style: C.sep }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "开始时间", value: st, disabled: ro, onChange: function (e) { setSt(e.target.value); } }),
      el("input", { style: { ...C.inp, width: 150 }, placeholder: "结束时间", value: et, disabled: ro, onChange: function (e) { setEt(e.target.value); } }),
      el("div", { style: C.sep }),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: level, disabled: ro, onChange: function (e) { setLevel(e.target.value); } }, LEVELS.map(function (v) { return el("option", { key: v, value: v }, v === "" ? "全部等级" : v); })),
      el("input", { style: { ...C.inp, width: 160 }, placeholder: "内容含（可选）", value: kw, disabled: ro, onChange: function (e) { setKw(e.target.value); } }),
      el("span", { style: C.chip(adv), onClick: function () { setAdv(!adv); } }, adv ? "收起" : "高级"),
      el("button", { style: { ...C.btn(!ro && !loading), flex: "none" }, disabled: ro || loading, onClick: function () { var d = new Date(); setEt(fmtTime(d)); setSt(fmtTime(new Date(d.getTime() - 36e5))); } }, "最近1h"),
      el("button", { style: C.btn(!ro && !loading), disabled: ro || loading, onClick: run, "data-testid": "cdb-errorlog-run" }, loading ? "查询中…" : "查询"),
      el("span", { style: C.muted }, "每次最多 200 条 / 10KB")
    ),
    // advanced
    adv && !ro ? el("div", { style: C.bar },
      el("span", { style: C.muted }, "role"),
      el("select", { style: { ...C.inp, cursor: "pointer" }, value: role, onChange: function (e) { setRole(e.target.value); } }, ["master", "slave", "slave1", "ro"].map(function (v) { return el("option", { key: v, value: v }, v); })),
      el("input", { style: { ...C.inp, width: 300 }, placeholder: "long_instance_id（留空则按 ip+port 自动反查）", value: longId, onChange: function (e) { setLongId(e.target.value); } })
    ) : null,
    // error
    error ? el("div", { style: C.err, "data-testid": "cdb-errorlog-error" }, error, el("button", { style: { ...C.btn(true), padding: "1px 8px", fontSize: 11, marginLeft: 8 }, onClick: run }, "重试")) : null,
    // empty
    !result ? el("div", { style: C.empty, "data-testid": "cdb-errorlog-hint" }, "填 IP / 端口 / 时间范围，点「查询」拉取错误日志。", el("br"), "每条报错压成一行：时间戳 [等级 错误码] 具体报错。") : null,
    result && !entries.length ? el("div", { style: C.empty, "data-testid": "cdb-errorlog-empty" }, "窗口内没有错误日志（data_status=", str(result.dataStatus) || "empty", "）", result.meta && result.meta.longInstanceId ? " · instance " + str(result.meta.longInstanceId) : "", el("br"), "换时间窗，或把「等级」放宽到「全部」，或清掉内容过滤。") : null,
    // result
    entries.length ? el("div", { style: C.entry },
      el("div", { style: C.eHead },
        el("span", { style: C.eOrd }, "#1"),
        el("span", { style: C.eName }, "cdb.error.query_error_logs"),
        el("span", { style: C.eCtx }, ctx2),
        el("button", { style: { flex: "none", width: 22, height: 22, padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--dsw-label-3, #8a8f98)", font: "13px/1 " + MONO, cursor: "pointer", opacity: .55 }, title: "全屏", onClick: function () { setFs(true); }, "data-testid": "cdb-errorlog-zoom" }, "⤢")
      ),
      el("div", { style: C.eBody },
        el("div", { style: C.eBar },
          el("button", { style: { ...C.btn(true), padding: "2px 9px", fontSize: 11 }, onClick: run }, "重跑"),
          el("span", { style: C.chip(false), onClick: copy }, "复制错误日志"),
          el("span", { style: C.muted, "data-testid": "cdb-errorlog-count" }, "共 ", entries.length, " 条 · 每条一行", meta ? " · " + meta : ""),
          result && result.dataStatus && result.dataStatus !== "ok" ? el("span", { style: C.muted }, "data_status=" + result.dataStatus) : null
        ),
        el("pre", { style: { ...C.term, maxHeight: 460 }, "data-testid": "cdb-errorlog-term" }, text)
      )
    ) : null,
    // fullscreen
    fs ? RD.createPortal(el("div", { style: C.ovr, onMouseDown: function (e) { e.target === e.currentTarget && setFs(false); } },
      el("div", { style: C.ovrP },
        el("div", { style: C.ovrH },
          el("b", null, "cdb.error.query_error_logs"),
          el("span", { style: { color: "var(--dsw-label-3, #8a8f98)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, ctx2),
          el("span", { style: C.chip(false), onClick: copy }, "复制错误日志"),
          el("span", { style: C.chip(false), onClick: function () { setFs(false); } }, "Esc 关闭")
        ),
        el("div", { style: C.ovrB }, el("pre", { style: { ...C.term, maxHeight: "none" } }, text))
      )
    ), document.body) : null
  );
}

function apply(ctx) {
  UIA = ctx.uiActions;
  ctx.pageEditor.registerBlock({ kind: "cdb-errorlog", plugin: PLUG, label: "错误日志", blockType: "ops", blockTypeLabel: "运维", hint: "填 IP/端口/时间范围，拉 MySQL 错误日志（log_timestamp + 具体报错），每条报错一行；可按等级/内容过滤，支持复制与全屏", aliases: ["cdb", "error", "errorlog", "错误日志", "报错", "err"], defaults: { product: "CDB", ip: "", port: "3306", region: "", role: "master", longInstanceId: "", startTime: "", endTime: "", level: "", keyword: "" }, View: View });
}
export { apply as apply, INJ as inject, PLUG as name };
