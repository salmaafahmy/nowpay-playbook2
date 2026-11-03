/* =========================================================
   NowPay Knowledge Portal — Supabase auth + shared data + in-site editor
   - Login / Logout (Supabase Auth, email + password, persisted session)
   - Loads the 18 data groups from public.kb_data after authentication
   - Lets signed-in team members add / edit knowledge; every change is saved to kb_data
   - Falls back to the data embedded in index.html (read-only) if Supabase is unreachable
   Only the publishable key is used here. Never put a secret / service-role key in this file.
   ========================================================= */
(function(){
  "use strict";

  var SUPABASE_URL = "https://jubjcrwsmhfcnkxhhqkm.supabase.co";
  var SUPABASE_KEY = "sb_publishable_yOcwh1QlWTetDCHuBSbWWw_KMIFeCEE";
  var TABLE = "kb_data";
  var AUTO_REFRESH_MS = 3 * 60 * 1000;

  /* Pristine copy of the data that ships inside index.html (fallback + safety net). */
  var EMBEDDED = JSON.parse(JSON.stringify(window.__NOWPAY_DATA__ || {}));

  var S = { client:null, session:null, rows:{}, started:false, readOnly:false, editorOpen:false, lastLoad:0, loading:false };

  var GROUP_LABELS = {
    topics:"المواضيع (صفحات الموقع)", kb_faqs_full:"بنك الأسئلة الشائعة", kb_faqs:"الأسئلة الشائعة (نسخة قديمة)",
    fees_5m:"جدول الرسوم 5M", fees_10m:"جدول الرسوم 10M", companies:"الشركات", sla:"اتفاقيات الخدمة (SLA)",
    banks:"تنسيقات البنوك", channels:"قنوات التواصل", validation_policy:"سياسة التحقق", scripts:"سكريبتات المكالمات",
    revisit_plan:"خطة إعادة المراجعة", actions:"الإجراءات (الكل - قديم)", actions_all:"الإجراءات (الكل)",
    actions_increase_max_balance:"إجراءات: زيادة الحد الأقصى للرصيد", actions_block:"إجراءات: الحظر",
    actions_deposit:"إجراءات: الإيداع", actions_update_data:"إجراءات: تحديث البيانات"
  };
  var GROUP_ORDER = ["topics","kb_faqs_full","fees_5m","fees_10m","sla","banks","channels","validation_policy","actions_all",
    "actions_increase_max_balance","actions_block","actions_deposit","actions_update_data","companies","scripts","revisit_plan","actions","kb_faqs"];
  var FIELD_LABELS = {
    min:"من", max:"إلى", fee:"الرسوم", name:"الاسم", group:"المجموعة", note:"ملاحظات", fees_model:"نموذج الرسوم",
    item:"الخدمة / الإجراء", sla:"المدة (SLA)", abbr:"الاختصار", name_ar:"الاسم بالعربي", format:"تنسيق الرقم",
    digits:"عدد الأرقام", phone:"الهاتف", label:"العنوان", value:"القيمة", call_status:"حالة المكالمة", case_type:"نوع الحالة",
    sub:"فرعي", validation:"التحقق", type:"النوع", status:"الحالة", action_by:"المُنفِّذ", data_verification:"البيانات المطلوبة",
    quality_point:"خطوات الجودة", ops_tool_record:"تسجيل Ops Tool", deadline:"الموعد النهائي", action:"الإجراء",
    ar:"النص بالعربي", en:"النص بالإنجليزي", question_ar:"السؤال", answer_ar:"الإجابة بالعربي", answer_en:"الإجابة بالإنجليزي", video:"رابط فيديو"
  };
  var SECTION_TYPES = {
    overview:"نظرة عامة (نص)", list:"قائمة نقاط", steps:"خطوات مرقمة", notes:"ملاحظات هامة", validation:"قائمة تحقق",
    faq:"أسئلة وأجوبة", statuses:"حالات (اسم + وصف)", videos:"روابط فيديو", link_cards:"روابط/أدوات", related:"مواضيع ذات صلة",
    table_ref:"جدول مرتبط"
  };
  var ADDABLE = ["overview","list","steps","notes","validation","faq","statuses","videos","link_cards","related"];
  var DEFAULT_SEC_CAT = { overview:"overview", list:"business_rules", steps:"agent_actions", notes:"notes", validation:"validation",
    faq:"faqs", statuses:"business_rules", videos:"videos", link_cards:"ops_tool", table_ref:"ticket_info" };

  /* ---------------- tiny helpers ---------------- */
  function h(tag, attrs){
    var e = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v === null || v === undefined || v === false) return;
      if(k === "class") e.className = v;
      else if(k === "text") e.textContent = v;
      else if(k === "value") e.value = v;
      else if(k.slice(0,2) === "on" && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    });
    for(var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  /* add(parent, child, child, ...) — children may be nodes, strings, arrays or null */
  function add(parent){
    for(var i = 1; i < arguments.length; i++){
      var c = arguments[i];
      if(c === null || c === undefined || c === false) continue;
      if(Array.isArray(c)) c.forEach(function(x){ add(parent, x); });
      else if(typeof c === "string") parent.appendChild(document.createTextNode(c));
      else parent.appendChild(c);
    }
  }
  function clone(x){ return JSON.parse(JSON.stringify(x)); }
  function deepEq(a, b){
    if(a === b) return true;
    if(typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if(Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if(ka.length !== kb.length) return false;
    for(var i = 0; i < ka.length; i++){ if(!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepEq(a[ka[i]], b[ka[i]])) return false; }
    return true;
  }
  function isArr(x){ return Array.isArray(x); }
  function isObj(x){ return x && typeof x === "object" && !Array.isArray(x); }
  function trunc(s, n){ s = String(s == null ? "" : s).replace(/\s+/g, " "); return s.length > n ? s.slice(0, n) + "…" : s; }

  /* ---------------- toasts ---------------- */
  var toastBox = null;
  function toast(msg, kind, ms){
    if(!toastBox){ toastBox = h("div", {class:"kb-toasts", role:"status", "aria-live":"polite"}); document.body.appendChild(toastBox); }
    var t = h("div", {class:"kb-toast " + (kind || ""), text:msg});
    toastBox.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, ms || 4200);
  }

  /* ---------------- gate (login / loading / error) ---------------- */
  var gate = null;
  function ensureGate(){
    if(gate) return gate;
    gate = h("div", {class:"kb-gate", id:"kb-gate", role:"dialog", "aria-modal":"true"});
    document.body.appendChild(gate);
    return gate;
  }
  function gateShell(){
    var g = ensureGate();
    g.hidden = false; g.innerHTML = "";
    var card = h("div", {class:"kb-gate-card"},
      h("div", {class:"kb-gate-logo", text:"NP"}),
      h("h1", {class:"kb-gate-title", text:"بوابة معرفة NowPay"}));
    g.appendChild(card);
    return card;
  }
  function gateHide(){ if(gate) gate.hidden = true; }
  function gateLoading(msg){
    var c = gateShell();
    add(c, h("p", {class:"kb-gate-sub", text:"خدمة العملاء الداخلية"}), h("div", {class:"kb-spinner"}), h("p", {class:"kb-gate-msg", text:msg || "جاري التحميل…"}));
  }
  function gateError(msg, buttons){
    var c = gateShell();
    add(c, h("p", {class:"kb-gate-msg err", text:msg}), h("div", {class:"kb-gate-actions"}, buttons || []));
  }
  function gateLogin(message, kind){
    var c = gateShell();
    var email = h("input", {class:"kb-input", type:"email", autocomplete:"username", dir:"ltr", required:"", placeholder:"name@company.com"});
    var pass = h("input", {class:"kb-input", type:"password", autocomplete:"current-password", dir:"ltr", required:"", placeholder:"••••••••"});
    var msg = h("p", {class:"kb-gate-msg " + (kind || "err"), text:message || ""});
    msg.hidden = !message;
    var btn = h("button", {class:"kb-btn block", type:"submit", text:"تسجيل الدخول"});
    var form = h("form", {novalidate:""},
      h("label", {class:"kb-field"}, h("span", {text:"البريد الإلكتروني"}), email),
      h("label", {class:"kb-field"}, h("span", {text:"كلمة المرور"}), pass),
      msg, btn);
    var busy = false;
    form.addEventListener("submit", function(ev){
      ev.preventDefault();
      if(busy) return;
      var em = email.value.trim(), pw = pass.value;
      if(!em || !pw){ msg.hidden = false; msg.className = "kb-gate-msg err"; msg.textContent = "من فضلك أدخل البريد الإلكتروني وكلمة المرور."; return; }
      busy = true; btn.disabled = true; btn.textContent = "جاري تسجيل الدخول…"; msg.hidden = true;
      S.client.auth.signInWithPassword({ email:em, password:pw }).then(function(res){
        if(res.error) throw res.error;
        S.session = res.data.session;
        return onAuthenticated();
      }).catch(function(err){
        busy = false; btn.disabled = false; btn.textContent = "تسجيل الدخول";
        msg.hidden = false; msg.className = "kb-gate-msg err"; msg.textContent = authErrorText(err);
      });
    });
    add(c, h("p", {class:"kb-gate-sub", text:"سجّل الدخول للوصول إلى دليل خدمة العملاء"}), form);
    setTimeout(function(){ email.focus(); }, 30);
  }
  function authErrorText(err){
    var m = String((err && err.message) || err || "");
    if(/invalid login credentials|invalid.*credentials/i.test(m)) return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
    if(/email not confirmed/i.test(m)) return "لم يتم تأكيد هذا البريد الإلكتروني بعد.";
    if(err && (err.status === 429 || /rate limit|too many/i.test(m))) return "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.";
    if(/failed to fetch|network|load failed|retryable/i.test(m) || (err && err.name === "AuthRetryableFetchError")) return "تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.";
    return "تعذر تسجيل الدخول: " + m;
  }
  function isAuthError(err){
    if(!err) return false;
    var m = String(err.message || "");
    return err.status === 401 || err.code === "PGRST301" || err.code === "PGRST303" || /jwt|token.*expired|not authenticated/i.test(m);
  }

  /* ---------------- data loading ---------------- */
  function fetchRows(){
    return S.client.from(TABLE).select("id,content,updated_at").then(function(r){
      if(r.error) throw r.error;
      return r.data || [];
    });
  }
  function buildData(rows){
    var d = clone(EMBEDDED), warns = [];
    S.rows = {};
    rows.forEach(function(row){
      var k = row.id, c = row.content;
      S.rows[k] = { content:c, updated_at:row.updated_at };
      if(Object.prototype.hasOwnProperty.call(EMBEDDED, k)){
        var ok = c !== null && c !== undefined && isArr(c) === isArr(EMBEDDED[k]);
        if(ok && k === "topics" && (!isArr(c) || !c.length)) ok = false;
        if(ok) d[k] = c; else warns.push(k);
      } else if(c !== null && c !== undefined){ d[k] = c; }
    });
    Object.keys(EMBEDDED).forEach(function(k){ if(!S.rows[k]) warns.push(k + " (غير موجود في Supabase)"); });
    return { data:d, warns:warns };
  }
  function applyData(d){
    window.NowPayApp.setData(d);
    if(!S.started){ S.started = true; window.NowPayApp.start(); } else window.NowPayApp.rebuild();
  }
  function loadAndShow(silent){
    if(S.loading) return Promise.resolve();
    S.loading = true;
    if(!silent) gateLoading("جاري تحميل المعرفة…");
    return fetchRows().then(function(rows){
      S.loading = false;
      if(!rows.length) throw Object.assign(new Error("empty"), { empty:true });
      var b = buildData(rows);
      applyData(b.data);
      S.lastLoad = Date.now();
      S.readOnly = false;
      gateHide();
      mountUserBar();
      if(b.warns.length) toast("تنبيه: تم استخدام النسخة المدمجة لـ: " + b.warns.join("، "), "err", 8000);
      else if(silent) toast("تم تحديث البيانات", "ok", 2000);
    }).catch(function(err){
      S.loading = false;
      if(isAuthError(err)){ return signOutSilently().then(function(){ gateLogin("انتهت الجلسة. سجّل الدخول مرة أخرى.", "warn"); }); }
      if(silent){ toast("تعذر تحديث البيانات: " + (err.message || err), "err"); return; }
      var txt = err.empty
        ? "لم يتم العثور على بيانات في Supabase (الجدول فارغ أو لا توجد صلاحية قراءة لهذا الحساب)."
        : "تعذر تحميل البيانات من Supabase: " + (err.message || err);
      gateError(txt, [
        h("button", {class:"kb-btn", type:"button", text:"إعادة المحاولة", onclick:function(){ loadAndShow(false); }}),
        h("button", {class:"kb-btn ghost", type:"button", text:"عرض النسخة المدمجة (قراءة فقط)", onclick:openReadOnly}),
        h("button", {class:"kb-btn ghost", type:"button", text:"تسجيل الخروج", onclick:doLogout})
      ]);
    });
  }
  function openReadOnly(){
    S.readOnly = true;
    applyData(clone(EMBEDDED));
    gateHide();
    mountUserBar();
  }

  /* ---------------- session handling ---------------- */
  function signOutSilently(){
    return S.client.auth.signOut().catch(function(){}).then(function(){ S.session = null; });
  }
  function doLogout(){
    S.client.auth.signOut().catch(function(){}).then(function(){ window.location.reload(); });
  }
  function onAuthenticated(){ return loadAndShow(false); }
  function ensureSession(){
    return S.client.auth.getSession().then(function(r){
      if(r.data && r.data.session) return r.data.session;
      return S.client.auth.refreshSession().then(function(x){ return x.data && x.data.session ? x.data.session : null; });
    });
  }

  /* ---------------- header user bar ---------------- */
  var bar = null, editBtn = null;
  function mountUserBar(){
    if(bar && bar.parentNode) bar.parentNode.removeChild(bar);
    var anchor = document.querySelector(".topbar-inner .notif-bell-wrap");
    var host = document.querySelector(".topbar-inner");
    if(!host) return;
    var email = (S.session && S.session.user && S.session.user.email) || "";
    editBtn = h("button", {class:"kb-edit-btn", type:"button", title:"إضافة وتعديل المعرفة", onclick:openEditor, disabled:S.readOnly},
      "✏️ ", h("span", {class:"kb-lbl", text:"تحرير"}));
    var refresh = h("button", {type:"button", title:"تحديث البيانات", "aria-label":"تحديث البيانات", text:"⟳",
      onclick:function(){ if(S.readOnly) { loadAndShow(false); } else loadAndShow(true); }});
    var out = h("button", {type:"button", title:"تسجيل الخروج", onclick:doLogout}, "⎋ ", h("span", {class:"kb-lbl", text:"خروج"}));
    bar = h("div", {class:"kb-userbar"}, email ? h("span", {class:"kb-user", title:email, text:email}) : null,
      S.readOnly ? null : editBtn, refresh, out);
    if(anchor) host.insertBefore(bar, anchor); else host.appendChild(bar);
    var old = document.getElementById("kb-banner");
    if(old) old.parentNode.removeChild(old);
    if(S.readOnly){
      var b = h("div", {class:"kb-banner", id:"kb-banner", text:"وضع القراءة فقط: يتم عرض النسخة المدمجة لأن الاتصال بـ Supabase غير متاح. التعديلات معطّلة."});
      var topbar = document.querySelector(".topbar");
      if(topbar && topbar.parentNode) topbar.parentNode.insertBefore(b, topbar.nextSibling);
    }
  }

  /* =========================================================
     Saving (optimistic concurrency, row/topic level merge)
     ========================================================= */
  function conflict(msg){ var e = new Error(msg); e.conflict = true; return e; }
  function currentContent(gid){
    if(S.rows[gid]) return clone(S.rows[gid].content);
    return clone(window.NowPayApp.getData()[gid]);
  }
  /* mutate(freshContent) -> newContent ; throws conflict() when someone else changed the same item. */
  function saveGroup(gid, mutate){
    var tries = 0;
    function attempt(){
      tries++;
      var cur = S.rows[gid];
      var next;
      try { next = mutate(currentContent(gid)); } catch(e){ return Promise.reject(e); }
      var now = new Date().toISOString();
      var req;
      if(cur){
        req = S.client.from(TABLE).update({ content:next, updated_at:now }).eq("id", gid).eq("updated_at", cur.updated_at).select("id,updated_at");
      } else {
        req = S.client.from(TABLE).insert({ id:gid, content:next, updated_at:now }).select("id,updated_at");
      }
      return req.then(function(r){
        if(r.error){
          if(r.error.code === "23505" && tries < 4) return refetch(gid).then(attempt);
          throw r.error;
        }
        if(!r.data || !r.data.length){
          /* 0 rows: either someone changed the row first, or RLS blocked the update. */
          return refetch(gid).then(function(fresh){
            if(!fresh) throw new Error("لا توجد صلاحية لتعديل هذه البيانات.");
            if(cur && fresh.updated_at === cur.updated_at) throw new Error("لم يتم الحفظ: لا توجد صلاحية تعديل لهذا الحساب.");
            if(tries >= 4) throw conflict("تم تعديل هذه المجموعة من شخص آخر أثناء الحفظ. حدّث الصفحة وحاول مرة أخرى.");
            return attempt();
          });
        }
        var saved = r.data[0];
        S.rows[gid] = { content:next, updated_at:saved.updated_at || now };
        var d = window.NowPayApp.getData();
        d[gid] = next;
        window.NowPayApp.setData(d);
        window.NowPayApp.rebuild();
        S.lastLoad = Date.now();
        return next;
      });
    }
    function withAuthRetry(){
      return attempt().catch(function(err){
        if(isAuthError(err)){
          return ensureSession().then(function(sess){
            if(!sess){ gateLogin("انتهت الجلسة. سجّل الدخول ثم أعد المحاولة (لن تضيع تعديلاتك المفتوحة).", "warn"); throw new Error("انتهت الجلسة. سجّل الدخول ثم اضغط حفظ مرة أخرى."); }
            S.session = sess;
            return attempt();
          });
        }
        throw err;
      });
    }
    return withAuthRetry();
  }
  function refetch(gid){
    return S.client.from(TABLE).select("id,content,updated_at").eq("id", gid).maybeSingle().then(function(r){
      if(r.error) throw r.error;
      if(r.data) S.rows[gid] = { content:r.data.content, updated_at:r.data.updated_at };
      return r.data || null;
    });
  }
  function friendlyError(err){
    var m = String((err && err.message) || err);
    if(/failed to fetch|network/i.test(m)) return "تعذر الاتصال بالخادم. لم يتم الحفظ — تحقق من الإنترنت وحاول مرة أخرى.";
    if(err && err.code === "42501") return "لا توجد صلاحية لحفظ هذه البيانات (RLS).";
    return m;
  }

  /* =========================================================
     Editor
     ========================================================= */
  var ed = null, edSide = null, edPane = null, activeGroup = null;

  function groupKeys(){
    var d = window.NowPayApp.getData();
    var keys = GROUP_ORDER.filter(function(k){ return d[k] !== undefined; });
    Object.keys(d).forEach(function(k){ if(keys.indexOf(k) < 0) keys.push(k); });
    return keys;
  }
  function displayedGroups(){
    var shown = { topics:true }, d = window.NowPayApp.getData();
    (d.topics || []).forEach(function(t){ (t.sections || []).forEach(function(s){ if(s.type === "table_ref" && s.ref) shown[s.ref] = true; }); });
    return shown;
  }
  function openEditor(){
    if(S.readOnly) return;
    if(!ed){
      edSide = h("div", {class:"kb-ed-side"});
      edPane = h("div", {class:"kb-ed-pane"});
      ed = h("div", {class:"kb-editor", id:"kb-editor", hidden:true},
        h("div", {class:"kb-ed-box", role:"dialog", "aria-modal":"true", "aria-label":"تحرير المعرفة"},
          h("div", {class:"kb-ed-head"},
            h("h2", {text:"✏️ تحرير المعرفة"}),
            h("button", {class:"kb-btn", type:"button", text:"⬇ نسخة احتياطية JSON", onclick:exportBackup}),
            h("button", {class:"kb-btn", type:"button", text:"✕ إغلاق", onclick:closeEditor})),
          h("div", {class:"kb-ed-main"}, edSide, edPane)));
      document.body.appendChild(ed);
      document.addEventListener("keydown", function(e){ if(e.key === "Escape" && S.editorOpen && !document.querySelector(".kb-form-overlay")) closeEditor(); });
    }
    ed.hidden = false; S.editorOpen = true;
    document.body.style.overflow = "hidden";
    renderSide();
    if(!activeGroup) activeGroup = "topics";
    openGroup(activeGroup);
  }
  function closeEditor(){
    if(!ed) return;
    ed.hidden = true; S.editorOpen = false; document.body.style.overflow = "";
  }
  function renderSide(){
    edSide.innerHTML = "";
    var d = window.NowPayApp.getData(), shown = displayedGroups();
    groupKeys().forEach(function(k){
      var v = d[k];
      var n = isArr(v) ? v.length : "";
      edSide.appendChild(h("button", {class:"kb-ed-group" + (k === activeGroup ? " active" : ""), type:"button", onclick:function(){ openGroup(k); }},
        h("span", {text:GROUP_LABELS[k] || k}),
        shown[k] ? null : h("span", {class:"tag", title:"هذه المجموعة محفوظة لكنها غير معروضة حالياً في أي صفحة من الموقع", text:"غير معروضة"}),
        h("span", {class:"n", text:String(n)})));
    });
  }
  function openGroup(gid){
    activeGroup = gid; renderSide();
    var v = window.NowPayApp.getData()[gid];
    edPane.innerHTML = ""; edPane.scrollTop = 0;
    if(gid === "topics") topicsView();
    else if(isArr(v) && v.every(isObj)) rowsView(gid);
    else jsonView(gid);
  }
  function exportBackup(){
    var d = window.NowPayApp.getData();
    var blob = new Blob([JSON.stringify({ exported_at:new Date().toISOString(), source:"supabase:" + TABLE, groups:d }, null, 2)], { type:"application/json" });
    var a = h("a", { href:URL.createObjectURL(blob), download:"nowpay-kb-backup-" + new Date().toISOString().slice(0, 10) + ".json" });
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- generic modal form ---------- */
  function openForm(title, body, opts){
    var overlay = h("div", {class:"kb-form-overlay"});
    var err = h("div", {class:"kb-form-err", hidden:true, role:"alert"});
    var dirty = false;
    body.addEventListener("input", function(){ dirty = true; });
    body.addEventListener("change", function(){ dirty = true; });
    var saveBtn = h("button", {class:"kb-btn", type:"button", text:opts.saveLabel || "حفظ"});
    var cancel = h("button", {class:"kb-btn ghost", type:"button", text:"إلغاء"});
    function close(force){
      if(!force && dirty && !window.confirm("لديك تغييرات لم تُحفظ. هل تريد الإغلاق؟")) return;
      overlay.remove();
    }
    cancel.addEventListener("click", function(){ close(false); });
    saveBtn.addEventListener("click", function(){
      err.hidden = true;
      var result;
      try { result = opts.onSave(); }
      catch(e){ err.textContent = e.message; err.hidden = false; return; }
      saveBtn.disabled = true; cancel.disabled = true; saveBtn.textContent = "جاري الحفظ…";
      Promise.resolve(result).then(function(){
        toast("تم الحفظ ✓", "ok", 2200);
        close(true);
        if(opts.after) opts.after();
      }).catch(function(e){
        saveBtn.disabled = false; cancel.disabled = false; saveBtn.textContent = opts.saveLabel || "حفظ";
        err.textContent = friendlyError(e); err.hidden = false;
      });
    });
    var foot = h("div", {class:"kb-form-foot"}, saveBtn, cancel, h("span", {class:"spacer"}), opts.footExtra || null);
    overlay.appendChild(h("div", {class:"kb-form", role:"dialog", "aria-modal":"true"},
      h("div", {class:"kb-form-head", text:title}), h("div", {class:"kb-form-body"}, body), err, foot));
    document.body.appendChild(overlay);
    return { overlay:overlay, close:close };
  }
  function field(label, input, hint){
    return h("label", {class:"kb-field"}, h("span", {text:label}), input, hint ? h("div", {class:"kb-note", text:hint}) : null);
  }

  /* ---------- flat table groups ---------- */
  function schemaOf(rows){
    var keys = [], info = {};
    rows.forEach(function(r){
      Object.keys(r).forEach(function(k){
        if(!info[k]){ info[k] = { num:true, long:false, nulls:false, seen:0 }; keys.push(k); }
        var v = r[k], f = info[k];
        if(v === null || v === undefined){ f.nulls = true; return; }
        f.seen++;
        if(typeof v !== "number") f.num = false;
        if(typeof v === "string" && (v.indexOf("\n") >= 0 || v.length > 70)) f.long = true;
      });
    });
    keys.forEach(function(k){ if(!info[k].seen) info[k].num = false; });
    return { keys:keys, info:info };
  }
  function rowTitle(gid, r){
    var keys = Object.keys(r);
    var pref = ["name","question_ar","item","label","type","call_status","min"].filter(function(k){ return r[k] !== undefined && r[k] !== null && r[k] !== ""; })[0] || keys[0];
    var main = r[pref];
    if(gid.indexOf("fees_") === 0) main = r.min + " → " + r.max;
    return trunc(main, 80);
  }
  function rowSub(gid, r){
    if(gid.indexOf("fees_") === 0) return "الرسوم: " + r.fee;
    var parts = [];
    Object.keys(r).forEach(function(k){
      if(parts.length >= 3) return;
      var v = r[k];
      if(v === null || v === undefined || v === "") return;
      var s = trunc(v, 40);
      if(s === trunc(rowTitle(gid, r), 40)) return;
      parts.push(s);
    });
    return parts.join(" · ");
  }
  function rowsView(gid){
    var rows = window.NowPayApp.getData()[gid];
    var sc = schemaOf(rows);
    var shownMax = 60;
    var q = h("input", {class:"kb-input", type:"search", placeholder:"بحث داخل الصفوف…"});
    var list = h("div");
    function draw(){
      list.innerHTML = "";
      var data = window.NowPayApp.getData()[gid], term = q.value.trim().toLowerCase(), n = 0, matched = 0;
      data.forEach(function(r, i){
        if(term && JSON.stringify(r).toLowerCase().indexOf(term) < 0) return;
        matched++;
        if(n >= shownMax) return;
        n++;
        list.appendChild(h("div", {class:"kb-row-card"},
          h("div", {class:"kb-row-text"}, h("b", {text:rowTitle(gid, r)}), h("span", {text:rowSub(gid, r)})),
          h("button", {class:"kb-btn small ghost", type:"button", text:"تعديل", onclick:function(){ rowForm(gid, sc, i); }})));
      });
      if(matched > n) list.appendChild(h("p", {class:"kb-note", text:"يتم عرض أول " + n + " من " + matched + " — استخدم البحث لتضييق النتائج."}));
      if(!matched) list.appendChild(h("p", {class:"kb-note", text:"لا توجد نتائج."}));
    }
    q.addEventListener("input", draw);
    add(edPane,
      h("h3", {text:GROUP_LABELS[gid] || gid}),
      h("p", {class:"kb-ed-hint", text:"عدد الصفوف: " + rows.length + ". أي تعديل أو إضافة يُحفظ في Supabase ويظهر لكل أعضاء الفريق."}),
      h("div", {class:"kb-ed-toolbar"}, q,
        h("button", {class:"kb-btn", type:"button", text:"＋ إضافة صف جديد", onclick:function(){ rowForm(gid, sc, -1); }}),
        h("button", {class:"kb-btn ghost", type:"button", text:"{ } تحرير JSON للمجموعة", onclick:function(){ jsonView(gid); }})),
      list);
    draw();
  }
  function rowForm(gid, sc, index){
    var isNew = index < 0;
    var base = isNew ? null : clone(window.NowPayApp.getData()[gid][index]);
    var inputs = {};
    var grid = h("div", {class:"kb-grid2"});
    sc.keys.forEach(function(k){
      var f = sc.info[k], val = base ? base[k] : "";
      var el;
      if(f.num) el = h("input", {class:"kb-input", type:"number", step:"any", dir:"ltr", value:val === null || val === undefined ? "" : String(val)});
      else if(f.long) el = h("textarea", {class:"kb-textarea", rows:"4", value:val === null || val === undefined ? "" : String(val)});
      else el = h("input", {class:"kb-input", type:"text", value:val === null || val === undefined ? "" : String(val)});
      inputs[k] = el;
      var wrapper = field((FIELD_LABELS[k] || k) + (FIELD_LABELS[k] ? "  (" + k + ")" : ""), el);
      if(f.long) wrapper.style.gridColumn = "1 / -1";
      grid.appendChild(wrapper);
    });
    function collect(){
      var out = {};
      sc.keys.forEach(function(k){
        var f = sc.info[k], raw = inputs[k].value;
        if(f.num){
          if(raw.trim() === ""){
            if(isNew || !(base && (base[k] === null || base[k] === undefined))) throw new Error("الحقل «" + (FIELD_LABELS[k] || k) + "» مطلوب (رقم).");
            out[k] = null; return;
          }
          var n = Number(raw);
          if(!isFinite(n)) throw new Error("الحقل «" + (FIELD_LABELS[k] || k) + "» يجب أن يكون رقماً صحيحاً.");
          out[k] = n;
        } else {
          var t = raw.replace(/\s+$/g, "");
          if(t.trim() === "") out[k] = (base && (base[k] === null || base[k] === undefined) || isNew && f.nulls) ? null : "";
          else out[k] = t;
        }
      });
      /* keep any extra keys the row already had that the schema form doesn't show */
      if(base) Object.keys(base).forEach(function(k){ if(!(k in out)) out[k] = base[k]; });
      var mainKey = sc.keys.filter(function(k){ return !sc.info[k].num; })[0];
      if(mainKey && !out[mainKey] && isNew) throw new Error("الحقل «" + (FIELD_LABELS[mainKey] || mainKey) + "» مطلوب.");
      if(gid.indexOf("fees_") === 0 && out.min > out.max) throw new Error("قيمة «من» يجب ألا تكون أكبر من «إلى».");
      return out;
    }
    openForm(isNew ? "إضافة صف — " + (GROUP_LABELS[gid] || gid) : "تعديل صف — " + (GROUP_LABELS[gid] || gid), grid, {
      onSave:function(){
        var next = collect();
        if(!isNew && deepEq(next, base)) throw new Error("لم يتم تغيير أي شيء.");
        return saveGroup(gid, function(content){
          if(isNew){ content.push(next); return content; }
          var i = -1;
          for(var j = 0; j < content.length; j++){ if(deepEq(content[j], base)) { i = j; break; } }
          if(i < 0){
            for(var m = 0; m < content.length; m++){ if(deepEq(content[m], next)) return content; }
            throw conflict("تم تعديل هذا الصف من شخص آخر. أغلق النافذة وحدّث البيانات ثم أعد المحاولة.");
          }
          content[i] = next; return content;
        });
      },
      after:function(){ openGroup(gid); }
    });
  }

  /* ---------- raw JSON editor for a whole group (advanced) ---------- */
  function jsonView(gid){
    edPane.innerHTML = ""; edPane.scrollTop = 0;
    var d = window.NowPayApp.getData();
    var baseContent = clone(d[gid]);
    var ta = h("textarea", {class:"kb-textarea kb-json", spellcheck:"false", value:JSON.stringify(baseContent, null, 2)});
    var err = h("div", {class:"kb-form-err", hidden:true, style:"margin:10px 0"});
    var btn = h("button", {class:"kb-btn", type:"button", text:"حفظ JSON"});
    btn.addEventListener("click", function(){
      err.hidden = true;
      var parsed;
      try { parsed = JSON.parse(ta.value); } catch(e){ err.textContent = "JSON غير صالح: " + e.message; err.hidden = false; return; }
      if(isArr(baseContent) !== isArr(parsed)){ err.textContent = "نوع البيانات يجب أن يبقى " + (isArr(baseContent) ? "قائمة [ ]" : "كائن { }") + " كما هو."; err.hidden = false; return; }
      if(isArr(parsed) && gid === "topics" && !parsed.length){ err.textContent = "لا يمكن حفظ قائمة مواضيع فارغة."; err.hidden = false; return; }
      if(deepEq(parsed, baseContent)){ err.textContent = "لم يتم تغيير أي شيء."; err.hidden = false; return; }
      if(!window.confirm("سيتم استبدال بيانات «" + (GROUP_LABELS[gid] || gid) + "» بالكامل بهذا الـ JSON. هل أنت متأكد؟ (يُنصح بتنزيل نسخة احتياطية أولاً)")) return;
      btn.disabled = true; btn.textContent = "جاري الحفظ…";
      saveGroup(gid, function(content){
        if(!deepEq(content, baseContent)) throw conflict("تم تعديل هذه المجموعة من شخص آخر. أعد التحميل ثم حاول مرة أخرى.");
        return parsed;
      }).then(function(){ toast("تم الحفظ ✓", "ok", 2200); openGroup(gid); })
        .catch(function(e){ btn.disabled = false; btn.textContent = "حفظ JSON"; err.textContent = friendlyError(e); err.hidden = false; });
    });
    add(edPane, h("h3", {text:"JSON — " + (GROUP_LABELS[gid] || gid)}),
      h("p", {class:"kb-ed-hint", text:"للمستخدمين المتقدمين: تحرير مباشر للبيانات الخام بنفس هيكل الموقع. الحفظ يستبدل المجموعة بالكامل."}),
      ta, err, h("div", {class:"kb-ed-toolbar", style:"margin-top:10px"}, btn,
        h("button", {class:"kb-btn ghost", type:"button", text:"رجوع", onclick:function(){ openGroup(gid); }})));
  }

  /* ---------- topics ---------- */
  function topicsView(){
    var M = window.NowPayApp.meta, d = window.NowPayApp.getData();
    add(edPane, h("h3", {text:"المواضيع (صفحات الموقع)"}),
      h("p", {class:"kb-ed-hint", text:"اختر موضوعاً لتعديل عنوانه وأقسامه، أو أضف موضوعاً جديداً. الموضوع الجديد يظهر تلقائياً في القائمة الجانبية وفي البحث."}),
      h("div", {class:"kb-ed-toolbar"},
        h("button", {class:"kb-btn", type:"button", text:"＋ موضوع جديد", onclick:function(){ topicForm(null); }}),
        h("button", {class:"kb-btn ghost", type:"button", text:"{ } تحرير JSON للمجموعة", onclick:function(){ jsonView("topics"); }})));
    var cats = M.CAT_ORDER.slice();
    d.topics.forEach(function(t){ if(cats.indexOf(t.cat) < 0) cats.push(t.cat); });
    cats.forEach(function(cat){
      var items = d.topics.filter(function(t){ return t.cat === cat; });
      if(!items.length) return;
      edPane.appendChild(h("div", {class:"kb-cat-label", text:(M.CAT_ICON[cat] || "📁") + " " + cat}));
      items.forEach(function(t){
        edPane.appendChild(h("div", {class:"kb-row-card"},
          h("div", {class:"kb-row-text"}, h("b", {text:(t.icon || "") + " " + t.title}), h("span", {text:t.sections.length + " قسم · " + t.id})),
          h("button", {class:"kb-btn small ghost", type:"button", text:"تعديل", onclick:function(){ topicForm(t.id); }})));
      });
    });
  }

  function newSection(type){
    var s = newSection0(type); s._new = true; return s;
  }
  function newSection0(type){
    var cat = DEFAULT_SEC_CAT[type];
    switch(type){
      case "overview": return { type:type, text:"", cat:cat };
      case "faq": return { type:type, title:"", items:[{ q:"", a:"", video:null }], cat:cat };
      case "statuses": return { type:type, title:"", items:[{ name:"", desc:"" }], cat:cat };
      case "link_cards": return { type:type, title:"", items:[{ name:"", url:"", purpose:"", uses:[] }], cat:cat };
      case "related": return { type:type, items:[] };
      default: return { type:type, title:"", items:[""], cat:cat };
    }
  }
  function topicForm(topicId){
    var M = window.NowPayApp.meta, all = window.NowPayApp.getData().topics;
    var isNew = !topicId;
    var base = isNew ? null : clone(all.filter(function(t){ return t.id === topicId; })[0]);
    var work = isNew ? { id:"", cat:M.CAT_ORDER[0], title:"", icon:"📄", keywords:"", sections:[] } : clone(base);
    /* Freeze each section's category from the built-in map so reordering / adding never changes where content shows. */
    if(!isNew){
      var map = M.TOPIC_CATMAP[work.id] || {};
      work.sections.forEach(function(s, i){ if(!s.cat && s.type !== "related" && map[i]) s.cat = map[i]; });
    }
    var body = h("div"), secBox = h("div"), jsonBox = null;

    var idIn = h("input", {class:"kb-input", type:"text", dir:"ltr", value:work.id, disabled:!isNew, placeholder:"مثال: new-topic (حروف إنجليزية صغيرة وأرقام و -)"});
    var catSel = h("select", {class:"kb-select"});
    M.CAT_ORDER.concat(M.CAT_ORDER.indexOf(work.cat) < 0 ? [work.cat] : []).forEach(function(c){
      var o = h("option", {value:c, text:c}); if(c === work.cat) o.selected = true; catSel.appendChild(o);
    });
    var iconIn = h("input", {class:"kb-input", type:"text", value:work.icon});
    var titleIn = h("input", {class:"kb-input", type:"text", value:work.title});
    var kwIn = h("textarea", {class:"kb-textarea", rows:"2", value:work.keywords || ""});
    idIn.addEventListener("input", function(){ work.id = idIn.value.trim(); });
    catSel.addEventListener("change", function(){ work.cat = catSel.value; });
    iconIn.addEventListener("input", function(){ work.icon = iconIn.value; });
    titleIn.addEventListener("input", function(){ work.title = titleIn.value; });
    kwIn.addEventListener("input", function(){ work.keywords = kwIn.value; });

    add(body,
      h("div", {class:"kb-grid2"}, field("معرّف الموضوع (id)", idIn, isNew ? "لا يمكن تغييره لاحقاً." : "ثابت ولا يمكن تغييره."), field("التصنيف", catSel),
        field("العنوان", titleIn), field("الأيقونة (إيموجي)", iconIn)),
      field("كلمات البحث (keywords)", kwIn, "كلمات إضافية تساعد البحث على إيجاد هذا الموضوع."),
      h("div", {class:"kb-cat-label", text:"الأقسام"}), secBox,
      h("div", {class:"kb-ed-toolbar"},
        (function(){
          var sel = h("select", {class:"kb-select", style:"max-width:220px"});
          ADDABLE.forEach(function(t){ sel.appendChild(h("option", {value:t, text:SECTION_TYPES[t]})); });
          var addBtn = h("button", {class:"kb-btn ghost", type:"button", text:"＋ إضافة قسم", onclick:function(){
            if(sel.value === "related" && work.sections.some(function(s){ return s.type === "related"; })){ toast("يوجد قسم «مواضيع ذات صلة» بالفعل.", "err"); return; }
            work.sections.push(newSection(sel.value)); drawSecs(); body.dispatchEvent(new Event("input"));
          }});
          return h("span", {style:"display:flex;gap:8px;align-items:center"}, sel, addBtn);
        })(),
        h("button", {class:"kb-btn ghost small", type:"button", text:"{ } JSON متقدم لهذا الموضوع", onclick:function(){ toggleJson(); }})));

    function toggleJson(){
      if(jsonBox){ jsonBox.remove(); jsonBox = null; return; }
      var ta = h("textarea", {class:"kb-textarea kb-json", spellcheck:"false", value:JSON.stringify(work, null, 2)});
      var msg = h("div", {class:"kb-note"});
      jsonBox = h("div", {class:"kb-sec"}, h("div", {class:"kb-sec-head", text:"JSON الخام لهذا الموضوع"}),
        h("div", {class:"kb-sec-body"}, ta, msg, h("button", {class:"kb-btn small", type:"button", text:"تطبيق على النموذج", onclick:function(){
          try {
            var p = JSON.parse(ta.value);
            if(!isObj(p) || !isArr(p.sections)) throw new Error("يجب أن يكون كائناً يحتوي على مصفوفة sections.");
            if(!isNew && p.id !== work.id) throw new Error("لا يمكن تغيير id الموضوع.");
            work = p; idIn.value = p.id || ""; titleIn.value = p.title || ""; iconIn.value = p.icon || ""; kwIn.value = p.keywords || "";
            catSel.value = p.cat; drawSecs(); msg.textContent = "تم التطبيق ✓";
          } catch(e){ msg.textContent = "خطأ: " + e.message; }
        }})));
      body.appendChild(jsonBox);
    }

    function itemList(sec, key, placeholder, long){
      var wrap = h("div");
      function draw(){
        wrap.innerHTML = "";
        sec[key].forEach(function(v, i){
          var inp = long ? h("textarea", {class:"kb-textarea", rows:"2", value:v, placeholder:placeholder || ""}) : h("input", {class:"kb-input", type:"text", value:v, placeholder:placeholder || ""});
          inp.addEventListener("input", function(){ sec[key][i] = inp.value; });
          wrap.appendChild(h("div", {class:"kb-item-row"}, inp));
        });
        wrap.appendChild(h("button", {class:"kb-btn small ghost", type:"button", text:"＋ بند جديد", onclick:function(){ sec[key].push(""); draw(); }}));
      }
      draw(); return wrap;
    }
    function objItems(sec, defs, makeNew){
      var wrap = h("div");
      function draw(){
        wrap.innerHTML = "";
        sec.items.forEach(function(it){
          var box = h("div", {class:"kb-subitem"});
          defs.forEach(function(df){
            var cur = df.list ? (it[df.k] || []).join("\n") : (it[df.k] == null ? "" : it[df.k]);
            var inp = df.long || df.list ? h("textarea", {class:"kb-textarea", rows:df.list ? "3" : "3", value:cur}) : h("input", {class:"kb-input", type:"text", value:cur, dir:df.ltr ? "ltr" : null});
            inp.addEventListener("input", function(){
              if(df.list) it[df.k] = inp.value.split("\n").map(function(x){ return x.trim(); }).filter(Boolean);
              else if(df.nullable && inp.value.trim() === "") it[df.k] = null;
              else it[df.k] = inp.value;
            });
            box.appendChild(field(df.label, inp));
          });
          wrap.appendChild(box);
        });
        wrap.appendChild(h("button", {class:"kb-btn small ghost", type:"button", text:"＋ عنصر جديد", onclick:function(){ sec.items.push(makeNew()); draw(); }}));
      }
      draw(); return wrap;
    }
    function secBody(sec){
      switch(sec.type){
        case "overview": {
          var ta = h("textarea", {class:"kb-textarea", rows:"5", value:sec.text || ""});
          ta.addEventListener("input", function(){ sec.text = ta.value; });
          return ta;
        }
        case "list": case "steps": case "notes": case "validation": case "videos": {
          var t = h("input", {class:"kb-input", type:"text", value:sec.title || "", placeholder:"عنوان القسم (اختياري)"});
          t.addEventListener("input", function(){ sec.title = t.value; });
          if(!isArr(sec.items)) sec.items = [];
          return h("div", null, sec.type === "videos" ? null : field("العنوان", t),
            itemList(sec, "items", sec.type === "videos" ? "https://…" : "", sec.type !== "videos"));
        }
        case "faq": {
          var ft = h("input", {class:"kb-input", type:"text", value:sec.title || ""});
          ft.addEventListener("input", function(){ sec.title = ft.value; });
          return h("div", null, field("العنوان", ft), objItems(sec, [
            { k:"q", label:"السؤال" }, { k:"a", label:"الإجابة", long:true }, { k:"video", label:"رابط فيديو (اختياري)", ltr:true, nullable:true }
          ], function(){ return { q:"", a:"", video:null }; }));
        }
        case "statuses": {
          var st = h("input", {class:"kb-input", type:"text", value:sec.title || ""});
          st.addEventListener("input", function(){ sec.title = st.value; });
          return h("div", null, field("العنوان", st), objItems(sec, [{ k:"name", label:"الاسم" }, { k:"desc", label:"الوصف", long:true }], function(){ return { name:"", desc:"" }; }));
        }
        case "link_cards": {
          var lt = h("input", {class:"kb-input", type:"text", value:sec.title || ""});
          lt.addEventListener("input", function(){ sec.title = lt.value; });
          return h("div", null, field("العنوان", lt), objItems(sec, [
            { k:"name", label:"الاسم" }, { k:"url", label:"الرابط", ltr:true }, { k:"purpose", label:"الغرض", long:true }, { k:"uses", label:"يُستخدم من أجل (سطر لكل بند)", list:true }
          ], function(){ return { name:"", url:"", purpose:"", uses:[] }; }));
        }
        case "related": {
          var ids = h("input", {class:"kb-input", type:"text", dir:"ltr", value:(sec.items || []).join(", ")});
          ids.addEventListener("input", function(){ sec.items = ids.value.split(",").map(function(x){ return x.trim(); }).filter(Boolean); });
          return field("معرّفات المواضيع (مفصولة بفاصلة)", ids, "المعرّفات المتاحة: " + all.map(function(t){ return t.id; }).join(", "));
        }
        case "table_ref":
          return h("p", {class:"kb-note", text:"جدول مرتبط بالمجموعة «" + (GROUP_LABELS[sec.ref] || sec.ref) + "» — يُعدَّل محتواه من هذه المجموعة في القائمة الجانبية للمحرر."});
        default:
          return h("p", {class:"kb-note", text:"نوع قسم غير معروف (" + sec.type + ") — يمكن تعديله من «JSON متقدم»."});
      }
    }
    function drawSecs(){
      secBox.innerHTML = "";
      work.sections.forEach(function(sec, i){
        var catSelS = null;
        if(sec.type !== "related" && !(sec.type === "table_ref" && String(sec.ref).indexOf("actions_") === 0)){
          catSelS = h("select", {class:"kb-select", title:"أين يظهر هذا القسم داخل الصفحة"});
          M.SEC_CAT_ORDER.forEach(function(c){ var o = h("option", {value:c, text:M.SEC_CAT_LABEL[c]}); if(c === sec.cat) o.selected = true; catSelS.appendChild(o); });
          if(!sec.cat){ catSelS.insertBefore(h("option", {value:"", text:"— غير محدد (لن يظهر) —", selected:true}), catSelS.firstChild); }
          catSelS.addEventListener("change", function(){ sec.cat = catSelS.value; });
        }
        var up = h("button", {class:"kb-btn small ghost", type:"button", text:"↑", title:"تحريك لأعلى", disabled:i === 0, onclick:function(){ swap(i, i - 1); }});
        var down = h("button", {class:"kb-btn small ghost", type:"button", text:"↓", title:"تحريك لأسفل", disabled:i === work.sections.length - 1, onclick:function(){ swap(i, i + 1); }});
        secBox.appendChild(h("div", {class:"kb-sec"},
          h("div", {class:"kb-sec-head"}, h("span", {text:(i + 1) + ". " + (SECTION_TYPES[sec.type] || sec.type)}), h("span", {class:"spacer"}), catSelS, up, down),
          h("div", {class:"kb-sec-body"}, secBody(sec))));
      });
      if(!work.sections.length) secBox.appendChild(h("p", {class:"kb-note", text:"لا توجد أقسام بعد."}));
    }
    function swap(a, b){ var x = work.sections[a]; work.sections[a] = work.sections[b]; work.sections[b] = x; drawSecs(); body.dispatchEvent(new Event("input")); }
    drawSecs();

    function finalize(){
      var t = clone(work);
      t.id = String(t.id || "").trim(); t.title = String(t.title || "").trim();
      if(!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) throw new Error("معرّف الموضوع يجب أن يكون حروفاً إنجليزية صغيرة وأرقاماً و - فقط.");
      if(isNew && all.some(function(x){ return x.id === t.id; })) throw new Error("هذا المعرّف مستخدم بالفعل لموضوع آخر.");
      if(!t.title) throw new Error("العنوان مطلوب.");
      if(!t.cat) throw new Error("التصنيف مطلوب.");
      t.icon = t.icon || "📄"; t.keywords = t.keywords || "";
      var ids = {}; all.forEach(function(x){ ids[x.id] = true; }); ids[t.id] = true;
      var out = [];
      t.sections.forEach(function(s, i){
        var n = i + 1, lab = SECTION_TYPES[s.type] || s.type;
        if(s.type === "overview"){ s.text = String(s.text || "").trim(); if(!s.text) return; }
        else if(["list","steps","notes","validation","videos"].indexOf(s.type) >= 0){
          s.items = (s.items || []).map(function(x){ return String(x).trim(); }).filter(Boolean);
          if(!s.items.length) return;
          if(s.type === "videos") s.items.forEach(function(u){ if(!/^https?:\/\/\S+$/i.test(u)) throw new Error("القسم " + n + " (" + lab + "): رابط غير صالح: " + u); });
          if(s.title !== undefined) s.title = String(s.title).trim();
        }
        else if(s.type === "faq"){
          s.items = (s.items || []).filter(function(x){ return String(x.q || "").trim() || String(x.a || "").trim(); });
          s.items.forEach(function(x){ if(!String(x.q || "").trim() || !String(x.a || "").trim()) throw new Error("القسم " + n + " (أسئلة): كل سؤال يحتاج سؤالاً وإجابة."); });
          if(!s.items.length) return;
        }
        else if(s.type === "statuses"){
          s.items = (s.items || []).filter(function(x){ return String(x.name || "").trim() || String(x.desc || "").trim(); });
          s.items.forEach(function(x){ if(!String(x.name || "").trim()) throw new Error("القسم " + n + " (حالات): كل حالة تحتاج اسماً."); });
          if(!s.items.length) return;
        }
        else if(s.type === "link_cards"){
          s.items = (s.items || []).filter(function(x){ return String(x.name || "").trim() || String(x.url || "").trim(); });
          s.items.forEach(function(x){ if(!String(x.name || "").trim() || !/^https?:\/\/\S+$/i.test(String(x.url || "").trim())) throw new Error("القسم " + n + " (روابط): كل عنصر يحتاج اسماً ورابطاً يبدأ بـ http."); x.url = x.url.trim(); });
          if(!s.items.length) return;
        }
        else if(s.type === "related"){
          s.items = (s.items || []).map(String).filter(Boolean);
          s.items.forEach(function(id){ if(!ids[id]) throw new Error("مواضيع ذات صلة: المعرّف غير موجود: " + id); });
          if(!s.items.length && s._new) return;   /* an existing (even empty) related block is always kept */
        }
        if(!s.cat) delete s.cat;
        if(s._new && s.type !== "related" && !s.cat) throw new Error("القسم " + n + " (" + lab + "): اختر مكان ظهور القسم داخل الصفحة.");
        delete s._new;
        out.push(s);
      });
      t.sections = out;
      return t;
    }

    openForm(isNew ? "موضوع جديد" : "تعديل الموضوع: " + base.title, body, {
      onSave:function(){
        var next = finalize();
        if(!isNew && deepEq(next, base)) throw new Error("لم يتم تغيير أي شيء.");
        return saveGroup("topics", function(content){
          if(isNew){
            if(content.some(function(x){ return x.id === next.id; })) throw conflict("تمت إضافة موضوع بنفس المعرّف من شخص آخر. اختر معرّفاً مختلفاً.");
            content.push(next); return content;
          }
          var i = -1;
          for(var j = 0; j < content.length; j++){ if(content[j].id === next.id) { i = j; break; } }
          if(i < 0) throw conflict("لم يتم العثور على الموضوع. حدّث البيانات وحاول مرة أخرى.");
          if(!deepEq(stripCats(content[i]), stripCats(base)) && !deepEq(content[i], next)) throw conflict("تم تعديل هذا الموضوع من شخص آخر أثناء عملك. أغلق النافذة وحدّث البيانات ثم أعد المحاولة.");
          content[i] = next; return content;
        });
      },
      after:function(){ openGroup("topics"); }
    });
  }
  /* base (as loaded) vs fresh row from DB: compare ignoring the `cat` we froze into sections. */
  function stripCats(t){ var c = clone(t); (c.sections || []).forEach(function(s){ delete s.cat; }); return c; }

  /* ---------------- boot ---------------- */
  function boot(){
    if(!window.supabase || !window.supabase.createClient){
      gateError("تعذر تحميل مكتبة Supabase (قد يكون الاتصال بالإنترنت أو مانع الإعلانات هو السبب).", [
        h("button", {class:"kb-btn", type:"button", text:"إعادة تحميل الصفحة", onclick:function(){ window.location.reload(); }}),
        h("button", {class:"kb-btn ghost", type:"button", text:"عرض النسخة المدمجة (قراءة فقط)", onclick:openReadOnly})
      ]);
      return;
    }
    gateLoading("جاري التحقق من الجلسة…");
    S.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false }
    });
    S.client.auth.onAuthStateChange(function(event, session){
      /* never await supabase calls inside this callback — defer them */
      setTimeout(function(){
        if(event === "SIGNED_OUT" && S.started && !S.readOnly) window.location.reload();
        else if(session) S.session = session;
      }, 0);
    });
    S.client.auth.getSession().then(function(r){
      if(r.error) throw r.error;
      if(r.data && r.data.session){ S.session = r.data.session; return onAuthenticated(); }
      gateLogin("");
    }).catch(function(err){
      gateError("تعذر التحقق من الجلسة: " + (err.message || err), [
        h("button", {class:"kb-btn", type:"button", text:"إعادة المحاولة", onclick:boot}),
        h("button", {class:"kb-btn ghost", type:"button", text:"تسجيل الدخول", onclick:function(){ gateLogin(""); }})
      ]);
    });
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible" && S.started && !S.readOnly && !S.editorOpen && S.session && Date.now() - S.lastLoad > AUTO_REFRESH_MS)
        loadAndShow(true);
    });
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
