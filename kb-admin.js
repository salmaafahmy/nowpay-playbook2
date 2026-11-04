/* =========================================================
   NowPay Knowledge Portal — public read + PIN-protected in-site editor
   - NO login. Everyone sees the full Knowledge Base immediately (embedded copy first, then the latest
     version from Supabase `kb_data`, read-only through the publishable key).
   - Edit / Add buttons are visible next to every section and item. Clicking one asks for a numeric PIN.
   - The PIN is checked ONLY by the `kb-editor` Edge Function (secret stored server-side). It is never in
     this file. A correct PIN returns a short-lived signed token that is kept in memory only.
   - Every save goes through the Edge Function, which backs up the previous content first.
   Only the publishable key is used here. Never put a secret / service-role key in this file.
   ========================================================= */
(function(){
  "use strict";
  if(!window.NowPayApp){ return; }

  var SUPABASE_URL = "https://jubjcrwsmhfcnkxhhqkm.supabase.co";
  var SUPABASE_KEY = "sb_publishable_yOcwh1QlWTetDCHuBSbWWw_KMIFeCEE";
  var CFG = window.NOWPAY_CONFIG || {};               /* optional override (used by tests / staging) */
  if(CFG.url) SUPABASE_URL = CFG.url;
  if(CFG.key) SUPABASE_KEY = CFG.key;
  var TABLE = "kb_data";
  var FN_URL = SUPABASE_URL + "/functions/v1/kb-editor";
  var AUTO_REFRESH_MS = 3 * 60 * 1000;

  var App = window.NowPayApp;
  /* Pristine copy of the data that ships inside index.html (fallback + safety net). */
  var EMBEDDED = JSON.parse(JSON.stringify(window.__NOWPAY_DATA__ || {}));

  var S = { rows:{}, loaded:false, loading:false, lastLoad:0, token:null, tokenExp:0, pinPromise:null, editorOpen:false, lockTimer:null };

  var GROUP_LABELS = {
    topics:"المواضيع (صفحات الموقع)", kb_faqs_full:"بنك الأسئلة الشائعة", kb_faqs:"الأسئلة الشائعة (نسخة قديمة)",
    fees_5m:"جدول الرسوم 5M", fees_10m:"جدول الرسوم 10M", companies:"الشركات", sla:"اتفاقيات الخدمة (SLA)",
    banks:"تنسيقات البنوك", channels:"قنوات التواصل", validation_policy:"سياسة التحقق", scripts:"سكريبتات المكالمات",
    revisit_plan:"خطة إعادة المراجعة", actions:"الإجراءات (الكل - قديم)", actions_all:"الإجراءات (الكل)",
    actions_increase_max_balance:"إجراءات: زيادة الحد الأقصى للرصيد", actions_block:"إجراءات: الحظر",
    actions_deposit:"إجراءات: الإيداع", actions_update_data:"إجراءات: تحديث البيانات", kb_meta:"التصنيفات المضافة"
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
  var STRING_ITEM_TYPES = ["list","steps","notes","validation","videos"];
  var HAS_TITLE = ["list","steps","notes","validation","faq","statuses","link_cards","table_ref"];
  /* field definitions for ONE item of each item-based section type (k = null means the item itself is a string) */
  var ITEM_DEFS = {
    list:[{ k:null, label:"النص", long:true }], steps:[{ k:null, label:"النص", long:true }],
    notes:[{ k:null, label:"النص", long:true }], validation:[{ k:null, label:"النص", long:true }],
    videos:[{ k:null, label:"رابط الفيديو", ltr:true, url:true }],
    faq:[{ k:"q", label:"السؤال" }, { k:"a", label:"الإجابة", long:true }, { k:"video", label:"رابط فيديو (اختياري)", ltr:true, url:true, nullable:true }],
    statuses:[{ k:"name", label:"الاسم" }, { k:"desc", label:"الوصف", long:true }],
    link_cards:[{ k:"name", label:"الاسم" }, { k:"url", label:"الرابط", ltr:true, url:true, required:true }, { k:"purpose", label:"الغرض", long:true, optional:true },
      { k:"uses", label:"يُستخدم من أجل (سطر لكل بند)", list:true, optional:true }]
  };

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
  function D(){ return App.getData(); }
  function isHttp(u){ return /^https?:\/\/\S+$/i.test(String(u || "").trim()); }

  /* ---------------- toasts ---------------- */
  var toastBox = null;
  function toast(msg, kind, ms){
    if(!toastBox){ toastBox = h("div", {class:"kb-toasts", role:"status", "aria-live":"polite"}); document.body.appendChild(toastBox); }
    var t = h("div", {class:"kb-toast " + (kind || ""), text:msg});
    toastBox.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, ms || 4200);
  }

  /* =========================================================
     Reading (public, read-only)
     ========================================================= */
  function restGet(query){
    return fetch(SUPABASE_URL + "/rest/v1/" + TABLE + "?" + query, { headers:{ apikey:SUPABASE_KEY, Accept:"application/json" }, cache:"no-store" })
      .then(function(r){
        if(!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
  }
  function fetchRows(){ return restGet("select=id,content,updated_at"); }
  function refetch(gid){
    return restGet("select=id,content,updated_at&id=eq." + encodeURIComponent(gid)).then(function(rows){
      var r = rows && rows[0];
      if(r) S.rows[gid] = { content:r.content, updated_at:r.updated_at };
      return r || null;
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
    return { data:d, warns:warns };
  }
  /* Load the latest data. Never blocks the page: the embedded copy is already on screen. */
  function loadLatest(silent){
    if(S.loading) return Promise.resolve();
    S.loading = true;
    return fetchRows().then(function(rows){
      S.loading = false;
      S.loaded = true; S.lastLoad = Date.now();
      setBanner(null);
      var b = buildData(rows);
      if(!deepEq(b.data, D())){ App.setData(b.data); App.rebuild(); }
      if(b.warns.length && !silent) toast("تنبيه: تم استخدام النسخة المدمجة لـ: " + b.warns.join("، "), "err", 7000);
    }).catch(function(err){
      S.loading = false;
      setBanner("تعذر الاتصال بالخادم، يتم عرض آخر نسخة متاحة. التعديل غير متاح مؤقتاً.");
      if(silent === false) toast("تعذر تحديث البيانات: " + (err.message || err), "err");
    });
  }
  function setBanner(msg){
    var old = document.getElementById("kb-banner");
    if(old) old.parentNode.removeChild(old);
    if(!msg) return;
    var b = h("div", {class:"kb-banner", id:"kb-banner", role:"status", text:msg});
    var topbar = document.querySelector(".topbar");
    if(topbar && topbar.parentNode) topbar.parentNode.insertBefore(b, topbar.nextSibling);
  }

  /* =========================================================
     PIN prompt + session token (memory only)
     ========================================================= */
  function callFn(body){
    return fetch(FN_URL, { method:"POST", headers:{ "Content-Type":"application/json", apikey:SUPABASE_KEY }, body:JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status:r.status, body:j || {} }; }); });
  }
  function hasToken(){ return !!S.token && Date.now() < S.tokenExp - 3000; }
  function setToken(tok, secs){
    S.token = tok; S.tokenExp = tok ? Date.now() + secs * 1000 : 0;
    clearTimeout(S.lockTimer);
    if(tok) S.lockTimer = setTimeout(function(){ S.token = null; updateLockUi(); }, Math.max(1000, secs * 1000 - 2000));
    updateLockUi();
  }
  function requirePin(){
    if(hasToken()) return Promise.resolve();
    return pinDialog();
  }
  /* run fn after the PIN has been accepted (no PIN needed again while the 30-minute session is open) */
  function unlockThen(fn){
    requirePin().then(function(){ return fn(); }, function(e){ if(e && !e.cancelled) toast(String(e.message || e), "err"); });
  }
  function fmtWait(s){
    s = Math.max(0, Math.ceil(s));
    return s >= 60 ? Math.ceil(s / 60) + " دقيقة" : s + " ثانية";
  }
  function pinDialog(){
    if(S.pinPromise) return S.pinPromise;
    S.pinPromise = new Promise(function(resolve, reject){
      var input = h("input", {class:"kb-pin-input", type:"password", inputmode:"numeric", pattern:"[0-9]*", autocomplete:"off",
        maxlength:"8", dir:"ltr", "aria-label":"رمز التعديل", placeholder:"••••••", id:"kb-pin-input"});
      var msg = h("p", {class:"kb-pin-msg", role:"alert", hidden:true});
      var okBtn = h("button", {class:"kb-btn", type:"submit", text:"تأكيد"});
      var cancel = h("button", {class:"kb-btn ghost", type:"button", text:"إلغاء"});
      var form = h("form", {novalidate:"", autocomplete:"off"}, input, msg, h("div", {class:"kb-pin-actions"}, okBtn, cancel));
      var box = h("div", {class:"kb-pin-box", role:"dialog", "aria-modal":"true", "aria-labelledby":"kb-pin-title"},
        h("div", {class:"kb-pin-icon", text:"🔒"}),
        h("h2", {id:"kb-pin-title", text:"رمز التعديل"}),
        h("p", {class:"kb-note", text:"أدخل رمز التعديل (أرقام فقط) للمتابعة. عرض المحتوى متاح للجميع بدون رمز."}),
        form);
      var overlay = h("div", {class:"kb-pin-overlay"}, box);
      var busy = false, waitTimer = null;
      function done(){ clearInterval(waitTimer); document.removeEventListener("keydown", onKey, true); overlay.remove(); S.pinPromise = null; }
      function say(text, kind){ msg.hidden = !text; msg.textContent = text || ""; msg.className = "kb-pin-msg " + (kind || "err"); }
      function onKey(e){ if(e.key === "Escape"){ e.stopPropagation(); done(); reject(Object.assign(new Error("cancelled"), { cancelled:true })); } }
      function lockFor(secs){
        var until = Date.now() + secs * 1000;
        input.disabled = true; okBtn.disabled = true;
        function tick(){
          var left = (until - Date.now()) / 1000;
          if(left <= 0){ clearInterval(waitTimer); input.disabled = false; okBtn.disabled = false; say("", ""); input.focus(); return; }
          say("محاولات كثيرة. حاول مرة أخرى بعد " + fmtWait(left) + ".", "warn");
        }
        tick(); clearInterval(waitTimer); waitTimer = setInterval(tick, 1000);
      }
      input.addEventListener("input", function(){ var c = input.value.replace(/\D+/g, ""); if(c !== input.value) input.value = c; });
      cancel.addEventListener("click", function(){ done(); reject(Object.assign(new Error("cancelled"), { cancelled:true })); });
      form.addEventListener("submit", function(ev){
        ev.preventDefault();
        if(busy) return;
        var pin = input.value.trim();
        if(!/^\d{4,8}$/.test(pin)){ say("أدخل رمزاً مكوّناً من 4 إلى 8 أرقام.", "err"); input.focus(); return; }
        busy = true; okBtn.disabled = true; okBtn.textContent = "جاري التحقق…"; say("", "");
        callFn({ action:"verify", pin:pin }).then(function(res){
          busy = false; okBtn.disabled = false; okBtn.textContent = "تأكيد";
          var b = res.body;
          if(res.status === 200 && b.ok && b.token){ setToken(b.token, b.expires_in || 1800); done(); resolve(); return; }
          input.value = "";
          if(b.error === "bad_pin"){ say("الرمز غير صحيح. المحاولات المتبقية: " + b.attempts_left, "err"); input.focus(); }
          else if(b.error === "rate_limited"){ lockFor(b.retry_after || 60); }
          else if(b.error === "not_configured"){ say("التعديل غير مفعّل بعد على الخادم. تواصل مع مسؤول النظام.", "err"); }
          else if(b.error === "bad_format"){ say("أدخل رمزاً مكوّناً من 4 إلى 8 أرقام.", "err"); }
          else { say("تعذر التحقق الآن. حاول مرة أخرى بعد قليل.", "err"); }
        }).catch(function(){
          busy = false; okBtn.disabled = false; okBtn.textContent = "تأكيد";
          say("تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.", "err");
        });
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      setTimeout(function(){ input.focus(); }, 30);
    });
    return S.pinPromise;
  }

  /* ---------------- top bar: manage + lock ---------------- */
  var manageBtn = null, lockBtn = null;
  function mountTopbar(){
    var host = document.querySelector(".topbar-inner");
    if(!host || document.getElementById("kb-userbar")) return;
    var anchor = host.querySelector(".notif-bell-wrap");
    manageBtn = h("button", {class:"kb-edit-btn", id:"kb-manage-btn", type:"button", title:"إدارة كل بيانات الموقع (يتطلب رمز التعديل)",
      onclick:function(){ unlockThen(function(){ openEditor(); }); }}, "✏️ ", h("span", {class:"kb-lbl", text:"إدارة البيانات"}));
    lockBtn = h("button", {id:"kb-lock-btn", type:"button", hidden:true, title:"إنهاء جلسة التعديل الآن",
      onclick:function(){ setToken(null, 0); toast("تم قفل التعديل.", "ok", 1800); }}, "🔓 ", h("span", {class:"kb-lbl", text:"قفل التعديل"}));
    var bar = h("div", {class:"kb-userbar", id:"kb-userbar"}, manageBtn, lockBtn);
    if(anchor) host.insertBefore(bar, anchor); else host.appendChild(bar);
    updateLockUi();
  }
  function updateLockUi(){
    if(lockBtn) lockBtn.hidden = !hasToken();
    document.body.classList.toggle("kb-unlocked", hasToken());
  }

  /* =========================================================
     Saving: Edge Function only (optimistic concurrency + automatic backup on the server)
     ========================================================= */
  function conflict(msg){ var e = new Error(msg); e.conflict = true; return e; }
  function currentContent(gid){
    if(S.rows[gid]) return clone(S.rows[gid].content);
    var d = D()[gid];
    if(d === undefined && gid === "kb_meta") return { categories:[] };
    return clone(d);
  }
  var SERVER_MSG = {
    rows_cannot_be_removed:"غير مسموح بحذف محتوى موجود.", topics_cannot_be_removed:"غير مسموح بحذف موضوع موجود.",
    sections_cannot_be_removed:"غير مسموح بحذف قسم موجود.", categories_cannot_be_removed:"غير مسموح بحذف تصنيف موجود.",
    invalid_link:"يوجد رابط غير صالح (يجب أن يبدأ بـ http:// أو https://).", string_too_long:"أحد النصوص طويل جداً.",
    content_too_large:"حجم البيانات كبير جداً.", unknown_group:"مجموعة بيانات غير معروفة.", topic_id_duplicate:"معرّف الموضوع مستخدم بالفعل.",
    meta_category_duplicate:"اسم التصنيف مستخدم بالفعل."
  };
  function serverError(res){
    var b = res.body || {}, d = String(b.detail || "").split(":")[0];
    if(SERVER_MSG[d]) return new Error(SERVER_MSG[d]);
    if(res.status === 429) return new Error("محاولات كثيرة. حاول لاحقاً.");
    if(res.status === 413) return new Error("حجم البيانات كبير جداً.");
    if(res.status === 503) return new Error("التعديل غير مفعّل بعد على الخادم.");
    return new Error("رفض الخادم الحفظ" + (b.detail || b.error ? " (" + (b.detail || b.error) + ")" : "") + ".");
  }
  /* mutate(freshContent) -> newContent ; throws conflict() when someone else changed the same item. */
  function saveGroup(gid, mutate, label){
    var tries = 0;
    function attempt(){
      tries++;
      if(tries > 5) return Promise.reject(conflict("تم تعديل هذه البيانات من شخص آخر أثناء الحفظ. حدّث الصفحة وحاول مرة أخرى."));
      var cur = S.rows[gid], next;
      try { next = mutate(currentContent(gid)); } catch(e){ return Promise.reject(e); }
      return callFn({ action:"save", token:S.token, group:gid, content:next, expected_updated_at:cur ? cur.updated_at : null, label:label || "edit" }).then(function(res){
        var b = res.body || {};
        if(res.status === 200 && b.ok){
          S.rows[gid] = { content:next, updated_at:b.updated_at };
          var d = D(); d[gid] = next; App.setData(d); App.rebuild();
          S.lastLoad = Date.now();
          return next;
        }
        if(res.status === 401){            /* token missing / expired -> ask for the PIN again, then retry (the open form is kept) */
          setToken(null, 0);
          return pinDialog().then(attempt);
        }
        if(res.status === 409){            /* someone saved first -> fetch the newest version and re-apply this edit on top of it */
          return refetch(gid).then(attempt);
        }
        throw serverError(res);
      });
    }
    if(!hasToken()) return pinDialog().then(attempt);
    return attempt();
  }
  function friendlyError(err){
    var m = String((err && err.message) || err);
    if(/failed to fetch|network|load failed/i.test(m)) return "تعذر الاتصال بالخادم. لم يتم الحفظ — تحقق من الإنترنت وحاول مرة أخرى.";
    if(err && err.cancelled) return "تم إلغاء إدخال الرمز. لم يتم الحفظ.";
    return m;
  }
  function mutateTopic(topicId, fn, label){
    return saveGroup("topics", function(content){
      var i = -1;
      for(var j = 0; j < content.length; j++){ if(content[j].id === topicId){ i = j; break; } }
      if(i < 0) throw conflict("لم يتم العثور على الموضوع. حدّث الصفحة وحاول مرة أخرى.");
      fn(content[i], content);
      return content;
    }, label);
  }
  function findTopic(id){
    var all = D().topics || [];
    for(var i = 0; i < all.length; i++) if(all[i].id === id) return all[i];
    return null;
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
    var first = overlay.querySelector("input:not([disabled]), textarea, select");
    if(first) setTimeout(function(){ try{ first.focus(); }catch(e){} }, 30);
    return { overlay:overlay, close:close };
  }
  function field(label, input, hint){
    return h("label", {class:"kb-field"}, h("span", {text:label}), input, hint ? h("div", {class:"kb-note", text:hint}) : null);
  }
  function catSelect(current){
    var sel = h("select", {class:"kb-select"});
    var cats = App.meta.catList();
    if(current && cats.indexOf(current) < 0) cats.push(current);
    cats.forEach(function(c){ var o = h("option", {value:c, text:(App.meta.catIcon(c) || "") + " " + c}); if(c === current) o.selected = true; sel.appendChild(o); });
    return sel;
  }
  function placementSelect(current){
    var M = App.meta, sel = h("select", {class:"kb-select"});
    M.SEC_CAT_ORDER.forEach(function(c){ var o = h("option", {value:c, text:M.SEC_CAT_LABEL[c]}); if(c === current) o.selected = true; sel.appendChild(o); });
    return sel;
  }
  function afterTopicSaved(id){
    setTimeout(function(){
      var d = document.getElementById("topic-" + id);
      if(d){ d.setAttribute("open", ""); d.scrollIntoView({ behavior:"smooth", block:"start" }); }
    }, 60);
  }

  /* =========================================================
     Inline Edit / Add buttons (rendered next to every section and item for everyone)
     ========================================================= */
  function ib(label, title, fn, cls){
    return h("button", {class:"kb-ib " + (cls || ""), type:"button", title:title, "aria-label":title + " — " + label,
      onclick:function(ev){ ev.preventDefault(); ev.stopPropagation(); unlockThen(fn); }}, label);
  }
  function tools(cls){ return h("div", {class:"kb-tools " + (cls || "")}); }

  App.hooks.topic = function(details, body, t){
    var bar = tools("kb-topic-tools");
    add(bar,
      ib("✏️ تعديل الموضوع", "تعديل عنوان الموضوع وتصنيفه", function(){ topicForm(t.id); }),
      ib("＋ إضافة قسم", "إضافة قسم جديد داخل هذا الموضوع", function(){ addSectionForm(t.id); }));
    body.insertBefore(bar, body.firstChild);
  };
  App.hooks.category = function(heading, cat){
    heading.appendChild(h("span", {class:"kb-tools kb-cat-tools"}, ib("＋ موضوع جديد", "إضافة موضوع جديد في هذا التصنيف", function(){ topicForm(null, cat); })));
  };
  App.hooks.page = function(main){
    main.appendChild(h("div", {class:"kb-page-tools"},
      ib("＋ إضافة فرع / تصنيف جديد", "إنشاء تصنيف جديد يظهر في القائمة الجانبية", function(){ categoryForm(); }, "big")));
  };
  App.hooks.sidebar = function(nav){
    nav.appendChild(h("div", {class:"kb-side-tools"}, ib("＋ فرع جديد", "إنشاء تصنيف جديد", function(){ categoryForm(); }, "big")));
  };

  function itemNodes(sec, node){
    var q = function(sel){ return Array.prototype.slice.call(node.querySelectorAll(sel)); };
    switch(sec.type){
      case "steps": return q(".step-cards > .step-card");
      case "list": case "notes": return q("ul.bul-list > li");
      case "validation": return q("ul.check-list > li");
      case "statuses": return q(".status-grid > .status-card");
      case "faq": return q(".faq-acc > .faq-item");
      case "videos": return q(".video-row > a");
      case "link_cards": return q(".channel-grid > .action-card");
      default: return [];
    }
  }
  function tableNodes(ref, node){
    var q = function(sel){ return Array.prototype.slice.call(node.querySelectorAll(sel)); };
    switch(ref){
      case "fees_5m": case "fees_10m": case "companies": case "sla": case "banks": case "validation_policy": return q("tbody tr");
      case "channels": return q(".channel-card");
      case "scripts": return q(".script-card");
      case "kb_faqs_full": return q(".faq-acc > .faq-item");
      default: return ref && ref.indexOf("actions_") === 0 ? q(".action-grid > .action-card") : [];
    }
  }

  App.hooks.section = function(node, t, sec){
    var idx = t.sections.indexOf(sec);
    var bar = tools("kb-sec-tools");
    var type = sec.type;
    /* ---- sections that show a shared data group (tables, cards, actions) ---- */
    var ref = (type === "table_ref" || type.indexOf("actions_") === 0) ? sec.ref : null;
    if(ref){
      var rows = D()[ref];
      var gl = GROUP_LABELS[ref] || ref;
      if(type === "actions_validation" || type === "actions_steps" || type === "actions_chips"){
        bar.appendChild(ib("✏️ تعديل بيانات الإجراءات", "هذا القسم مبني من جدول الإجراءات: تعديل «" + gl + "»", function(){ openEditor(ref); }));
      } else {
        bar.appendChild(ib("＋ إضافة صف", "إضافة صف جديد إلى «" + gl + "»", function(){ rowForm(ref, schemaOf(D()[ref] || []), -1); }));
        if(idx >= 0 && HAS_TITLE.indexOf(type) >= 0) bar.appendChild(ib("✏️ تعديل القسم", "تعديل عنوان القسم ومكانه", function(){ sectionForm(t.id, idx); }));
        var nodes = tableNodes(ref, node);
        if(isArr(rows) && nodes.length === rows.length){
          var isTable = nodes.length && nodes[0].tagName === "TR";
          if(isTable){
            var thr = node.querySelector("thead tr");
            if(thr) thr.appendChild(h("th", {class:"kb-th-edit", "aria-label":"تعديل"}));
          }
          nodes.forEach(function(n, i){
            var btn = ib("✏️", "تعديل هذا العنصر", function(){ rowForm(ref, schemaOf(D()[ref]), i); }, isTable ? "" : "abs");
            if(isTable) n.appendChild(h("td", {class:"kb-td-edit"}, btn));
            else { n.classList.add("kb-has-ib"); n.appendChild(btn); }
          });
        }
      }
      node.insertBefore(bar, node.firstChild);
      return;
    }
    if(idx < 0) return;
    /* ---- normal content sections ---- */
    bar.appendChild(ib("✏️ تعديل القسم", "تعديل عنوان القسم ومكانه" + (type === "overview" ? " ونصه" : ""), function(){ sectionForm(t.id, idx); }));
    if(ITEM_DEFS[type]) bar.appendChild(ib("＋ إضافة عنصر", "إضافة عنصر جديد إلى هذا القسم", function(){ itemForm(t.id, idx, -1); }));
    node.insertBefore(bar, node.firstChild);
    if(ITEM_DEFS[type]){
      var nodes2 = itemNodes(sec, node);
      if(nodes2.length === (sec.items || []).length){
        nodes2.forEach(function(n, i){
          var btn = ib("✏️", "تعديل هذا العنصر", function(){ itemForm(t.id, idx, i); }, type === "faq" || type === "statuses" || type === "link_cards" ? "abs" : "inline");
          if(type === "videos") n.parentNode.insertBefore(btn, n.nextSibling);
          else { n.classList.add("kb-has-ib"); n.appendChild(btn); }
        });
      }
    }
  };

  /* =========================================================
     Forms
     ========================================================= */
  function blankItem(type){
    if(STRING_ITEM_TYPES.indexOf(type) >= 0) return "";
    if(type === "faq") return { q:"", a:"", video:null };
    if(type === "statuses") return { name:"", desc:"" };
    return { name:"", url:"", purpose:"", uses:[] };
  }
  function itemInputs(type, base){
    var defs = ITEM_DEFS[type], inputs = [], nodes = [];
    defs.forEach(function(df){
      var cur = df.k === null ? base : base[df.k];
      if(df.list) cur = (cur || []).join("\n");
      cur = cur === null || cur === undefined ? "" : String(cur);
      var el = (df.long || df.list) ? h("textarea", {class:"kb-textarea", rows:df.list ? "3" : "4", value:cur, dir:df.ltr ? "ltr" : null})
                                    : h("input", {class:"kb-input", type:"text", value:cur, dir:df.ltr ? "ltr" : null});
      inputs.push(el); nodes.push(field(df.label, el));
    });
    function collect(strict){
      var out = ITEM_DEFS[type][0].k === null ? "" : {};
      for(var i = 0; i < defs.length; i++){
        var df = defs[i], raw = inputs[i].value, v;
        if(df.list) v = raw.split("\n").map(function(x){ return x.trim(); }).filter(Boolean);
        else v = raw.replace(/\s+$/g, "");
        if(df.url && String(raw).trim() !== "" && !isHttp(raw)) throw new Error("الرابط في «" + df.label + "» غير صالح. يجب أن يبدأ بـ http:// أو https://");
        if(df.k === null){ out = v; }
        else if(df.list){ out[df.k] = v; }
        else if(df.url) out[df.k] = String(raw).trim() === "" ? (df.nullable ? null : "") : String(raw).trim();
        else out[df.k] = v;
      }
      return out;
    }
    return { nodes:nodes, inputs:inputs, collect:collect };
  }
  function itemIsEmpty(type, it){
    if(STRING_ITEM_TYPES.indexOf(type) >= 0) return !String(it || "").trim();
    var df = ITEM_DEFS[type][0];
    return !String(it[df.k] || "").trim();
  }

  /* ---- add / edit ONE item of a section ---- */
  function itemForm(topicId, secIdx, itemIdx){
    var t = findTopic(topicId);
    if(!t || !t.sections[secIdx]) return toast("تعذر العثور على القسم. حدّث الصفحة.", "err");
    var sec = t.sections[secIdx], type = sec.type, isNew = itemIdx < 0;
    var base = isNew ? blankItem(type) : clone(sec.items[itemIdx]);
    var ui = itemInputs(type, base);
    var body = h("div", null, ui.nodes);
    openForm((isNew ? "إضافة عنصر — " : "تعديل عنصر — ") + (SECTION_TYPES[type] || type) + (sec.title ? " · " + trunc(sec.title, 40) : ""), body, {
      onSave:function(){
        var next = ui.collect();
        if(itemIsEmpty(type, next)) throw new Error("الحقل «" + ITEM_DEFS[type][0].label + "» مطلوب.");
        if(type === "faq" && !String(next.a || "").trim()) throw new Error("الإجابة مطلوبة.");
        if(type === "link_cards" && !isHttp(next.url)) throw new Error("الرابط مطلوب ويجب أن يبدأ بـ http:// أو https://");
        if(!isNew && deepEq(next, base)) throw new Error("لم يتم تغيير أي شيء.");
        return mutateTopic(topicId, function(topic){
          var s = topic.sections[secIdx];
          if(!s || s.type !== type || !isArr(s.items)) throw conflict("تم تغيير هذا القسم من شخص آخر. حدّث الصفحة وحاول مرة أخرى.");
          if(isNew){ s.items.push(next); return; }
          if(!deepEq(s.items[itemIdx], base)){
            if(deepEq(s.items[itemIdx], next)) return;
            throw conflict("تم تعديل هذا العنصر من شخص آخر. أغلق النافذة وحدّث الصفحة ثم أعد المحاولة.");
          }
          s.items[itemIdx] = next;
        }, isNew ? "add-item" : "edit-item");
      },
      after:function(){ afterTopicSaved(topicId); }
    });
  }

  /* ---- edit a section's own properties: title, placement, overview text, related ids ---- */
  function sectionForm(topicId, secIdx){
    var t = findTopic(topicId);
    if(!t || !t.sections[secIdx]) return toast("تعذر العثور على القسم. حدّث الصفحة.", "err");
    var M = App.meta, sec = t.sections[secIdx], type = sec.type, base = clone(sec);
    var effCat = sec.cat || (M.TOPIC_CATMAP[t.id] || {})[secIdx];
    var body = h("div"), titleIn = null, textIn = null, idsIn = null, placeSel = null;
    if(HAS_TITLE.indexOf(type) >= 0){ titleIn = h("input", {class:"kb-input", type:"text", value:sec.title || "", placeholder:"عنوان القسم (اختياري)"}); body.appendChild(field("عنوان القسم", titleIn)); }
    if(type === "overview"){ textIn = h("textarea", {class:"kb-textarea", rows:"7", value:sec.text || ""}); body.appendChild(field("النص", textIn)); }
    if(type === "related"){
      idsIn = h("input", {class:"kb-input", type:"text", dir:"ltr", value:(sec.items || []).join(", ")});
      body.appendChild(field("معرّفات المواضيع (مفصولة بفاصلة)", idsIn, "المعرّفات المتاحة: " + D().topics.map(function(x){ return x.id; }).join(", ")));
    }
    if(type !== "related" && effCat !== "actions_ref" && !(type === "table_ref" && String(sec.ref).indexOf("actions_") === 0)){
      placeSel = placementSelect(effCat);
      body.appendChild(field("مكان ظهور القسم داخل الصفحة", placeSel));
    }
    if(!body.firstChild) body.appendChild(h("p", {class:"kb-note", text:"لا توجد خصائص قابلة للتعديل هنا. استخدم أزرار ✏️ بجانب كل عنصر."}));
    openForm("تعديل القسم — " + (SECTION_TYPES[type] || type), body, {
      onSave:function(){
        var next = clone(sec);
        if(titleIn){ next.title = titleIn.value.trim(); }
        if(textIn){
          next.text = textIn.value.replace(/\s+$/g, "");
          if(!next.text.trim()) throw new Error("النص مطلوب.");
        }
        if(idsIn){
          next.items = idsIn.value.split(",").map(function(x){ return x.trim(); }).filter(Boolean);
          var known = {}; D().topics.forEach(function(x){ known[x.id] = true; });
          next.items.forEach(function(id){ if(!known[id]) throw new Error("المعرّف غير موجود: " + id); });
        }
        if(placeSel && placeSel.value !== effCat) next.cat = placeSel.value;
        else if(placeSel && sec.cat) next.cat = sec.cat;
        if(deepEq(next, base)) throw new Error("لم يتم تغيير أي شيء.");
        return mutateTopic(topicId, function(topic){
          var s = topic.sections[secIdx];
          if(!s || s.type !== type) throw conflict("تم تغيير هذا القسم من شخص آخر. حدّث الصفحة وحاول مرة أخرى.");
          if(!deepEq(s, base) && !deepEq(s, next)) throw conflict("تم تعديل هذا القسم من شخص آخر. أغلق النافذة وحدّث الصفحة ثم أعد المحاولة.");
          /* keep everything else in the section (e.g. items) exactly as it is on the server */
          if(titleIn) s.title = next.title;
          if(textIn) s.text = next.text;
          if(idsIn) s.items = next.items;
          if(next.cat) s.cat = next.cat;
        }, "edit-section");
      },
      after:function(){ afterTopicSaved(topicId); }
    });
  }

  /* ---- add a NEW section to a topic ---- */
  function addSectionForm(topicId){
    var t = findTopic(topicId);
    if(!t) return toast("تعذر العثور على الموضوع. حدّث الصفحة.", "err");
    var hasRelated = t.sections.some(function(s){ return s.type === "related"; });
    var typeSel = h("select", {class:"kb-select"});
    ADDABLE.forEach(function(k){ if(k === "related" && hasRelated) return; typeSel.appendChild(h("option", {value:k, text:SECTION_TYPES[k]})); });
    var holder = h("div"), titleIn = null, placeSel = null, ui = null, linesIn = null, textIn = null, idsIn = null;
    function draw(){
      holder.innerHTML = ""; titleIn = placeSel = ui = linesIn = textIn = idsIn = null;
      var type = typeSel.value;
      if(HAS_TITLE.indexOf(type) >= 0){ titleIn = h("input", {class:"kb-input", type:"text", placeholder:"عنوان القسم (اختياري)"}); holder.appendChild(field("عنوان القسم", titleIn)); }
      if(type === "overview"){ textIn = h("textarea", {class:"kb-textarea", rows:"6"}); holder.appendChild(field("النص", textIn)); }
      else if(type === "related"){ idsIn = h("input", {class:"kb-input", type:"text", dir:"ltr"}); holder.appendChild(field("معرّفات المواضيع (مفصولة بفاصلة)", idsIn, "المعرّفات المتاحة: " + D().topics.map(function(x){ return x.id; }).join(", "))); }
      else if(STRING_ITEM_TYPES.indexOf(type) >= 0){
        linesIn = h("textarea", {class:"kb-textarea", rows:"6", dir:type === "videos" ? "ltr" : null});
        holder.appendChild(field(type === "videos" ? "روابط الفيديو (رابط في كل سطر)" : "العناصر (عنصر في كل سطر)", linesIn, "يمكنك إضافة المزيد لاحقاً بزر «＋ إضافة عنصر» داخل القسم."));
      } else { ui = itemInputs(type, blankItem(type)); holder.appendChild(h("div", {class:"kb-subitem"}, ui.nodes)); }
      if(type !== "related"){ placeSel = placementSelect(DEFAULT_SEC_CAT[type]); holder.appendChild(field("مكان ظهور القسم داخل الصفحة", placeSel)); }
    }
    typeSel.addEventListener("change", draw); draw();
    var body = h("div", null, field("نوع القسم", typeSel), holder);
    openForm("إضافة قسم جديد — " + t.title, body, {
      onSave:function(){
        var type = typeSel.value, s = { type:type };
        if(type === "overview"){ s.text = textIn.value.replace(/\s+$/g, ""); if(!s.text.trim()) throw new Error("النص مطلوب."); }
        else if(type === "related"){
          s.items = idsIn.value.split(",").map(function(x){ return x.trim(); }).filter(Boolean);
          var known = {}; D().topics.forEach(function(x){ known[x.id] = true; });
          if(!s.items.length) throw new Error("أدخل معرّف موضوع واحد على الأقل.");
          s.items.forEach(function(id){ if(!known[id]) throw new Error("المعرّف غير موجود: " + id); });
        } else if(STRING_ITEM_TYPES.indexOf(type) >= 0){
          s.items = linesIn.value.split("\n").map(function(x){ return x.trim(); }).filter(Boolean);
          if(!s.items.length) throw new Error("أدخل عنصراً واحداً على الأقل.");
          if(type === "videos") s.items.forEach(function(u){ if(!isHttp(u)) throw new Error("رابط غير صالح: " + u); });
        } else {
          var it = ui.collect();
          if(itemIsEmpty(type, it)) throw new Error("الحقل «" + ITEM_DEFS[type][0].label + "» مطلوب.");
          if(type === "faq" && !String(it.a || "").trim()) throw new Error("الإجابة مطلوبة.");
          if(type === "link_cards" && !isHttp(it.url)) throw new Error("الرابط مطلوب ويجب أن يبدأ بـ http:// أو https://");
          s.items = [it];
        }
        if(titleIn && titleIn.value.trim()) s.title = titleIn.value.trim();
        if(placeSel) s.cat = placeSel.value;
        return mutateTopic(topicId, function(topic){ topic.sections.push(s); }, "add-section");   /* appended: existing sections keep their positions */
      },
      after:function(){ afterTopicSaved(topicId); }
    });
  }

  /* ---- add / edit a topic (a "branch" of the tree) ---- */
  function genId(){ return "topic-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function topicForm(topicId, presetCat){
    var all = D().topics, isNew = !topicId;
    var base = isNew ? null : clone(findTopic(topicId));
    if(!isNew && !base) return toast("تعذر العثور على الموضوع. حدّث الصفحة.", "err");
    var idIn = h("input", {class:"kb-input", type:"text", dir:"ltr", value:isNew ? "" : base.id, disabled:!isNew, placeholder:"اتركه فارغاً ليتم إنشاؤه تلقائياً (حروف إنجليزية صغيرة وأرقام و -)"});
    var catSel = catSelect(isNew ? (presetCat || App.meta.CAT_ORDER[0]) : base.cat);
    var iconIn = h("input", {class:"kb-input", type:"text", value:isNew ? "📄" : (base.icon || "")});
    var titleIn = h("input", {class:"kb-input", type:"text", value:isNew ? "" : base.title});
    var kwIn = h("textarea", {class:"kb-textarea", rows:"2", value:isNew ? "" : (base.keywords || "")});
    var introIn = isNew ? h("textarea", {class:"kb-textarea", rows:"5", placeholder:"اختياري — يمكنك إضافة باقي الأقسام بعد الحفظ بزر «＋ إضافة قسم»"}) : null;
    var body = h("div", null,
      h("div", {class:"kb-grid2"}, field("معرّف الموضوع (id)", idIn, isNew ? "لا يمكن تغييره لاحقاً." : "ثابت ولا يمكن تغييره."), field("التصنيف", catSel),
        field("العنوان", titleIn), field("الأيقونة (إيموجي)", iconIn)),
      field("كلمات البحث (keywords)", kwIn, "كلمات إضافية تساعد البحث على إيجاد هذا الموضوع."),
      introIn ? field("نظرة عامة عن الموضوع", introIn) : null);
    openForm(isNew ? "موضوع جديد" : "تعديل الموضوع: " + base.title, body, {
      onSave:function(){
        var id = isNew ? (idIn.value.trim() || genId()) : base.id, title = titleIn.value.trim();
        if(!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("معرّف الموضوع يجب أن يكون حروفاً إنجليزية صغيرة وأرقاماً و - فقط.");
        if(isNew && all.some(function(x){ return x.id === id; })) throw new Error("هذا المعرّف مستخدم بالفعل لموضوع آخر.");
        if(!title) throw new Error("العنوان مطلوب.");
        var meta = { cat:catSel.value, title:title, icon:iconIn.value.trim() || "📄", keywords:kwIn.value.trim() };
        if(isNew){
          var topic = { id:id, cat:meta.cat, title:meta.title, icon:meta.icon, keywords:meta.keywords, sections:[] };
          var intro = introIn.value.replace(/\s+$/g, "");
          if(intro.trim()) topic.sections.push({ type:"overview", text:intro, cat:"overview" });
          return saveGroup("topics", function(content){
            if(content.some(function(x){ return x.id === id; })) throw conflict("تمت إضافة موضوع بنفس المعرّف من شخص آخر. اختر معرّفاً مختلفاً.");
            content.push(topic); return content;
          }, "add-topic").then(function(){ afterTopicSaved(id); });
        }
        if(meta.cat === base.cat && meta.title === base.title && meta.icon === (base.icon || "") && meta.keywords === (base.keywords || "")) throw new Error("لم يتم تغيير أي شيء.");
        return mutateTopic(id, function(t){
          if(t.cat !== base.cat || t.title !== base.title) throw conflict("تم تعديل هذا الموضوع من شخص آخر. أغلق النافذة وحدّث الصفحة ثم أعد المحاولة.");
          /* sections that rely on the built-in category map keep their place when the topic is edited */
          var map = App.meta.TOPIC_CATMAP[t.id] || {};
          t.sections.forEach(function(s, i){ if(!s.cat && s.type !== "related" && map[i]) s.cat = map[i]; });
          t.cat = meta.cat; t.title = meta.title; t.icon = meta.icon; t.keywords = meta.keywords;
        }, "edit-topic").then(function(){ afterTopicSaved(id); });
      },
      after:function(){ if(S.editorOpen) openGroup("topics"); }
    });
  }

  /* ---- add a new top-level category ("branch") ---- */
  function categoryForm(){
    var nameIn = h("input", {class:"kb-input", type:"text", placeholder:"مثال: الدعم الفني"});
    var iconIn = h("input", {class:"kb-input", type:"text", value:"📁"});
    var body = h("div", null, h("div", {class:"kb-grid2"}, field("اسم التصنيف", nameIn), field("الأيقونة (إيموجي)", iconIn)),
      h("p", {class:"kb-note", text:"التصنيف الجديد يظهر في الصفحة. بعد إنشائه أضف إليه المواضيع بزر «＋ موضوع جديد» بجانب عنوانه، وسيظهر في القائمة الجانبية بمجرد إضافة أول موضوع."}));
    openForm("تصنيف جديد", body, {
      onSave:function(){
        var name = nameIn.value.trim().replace(/\s+/g, " "), icon = iconIn.value.trim() || "📁";
        if(!name) throw new Error("اسم التصنيف مطلوب.");
        if(name.length > 60) throw new Error("اسم التصنيف طويل جداً.");
        if(App.meta.catList().indexOf(name) >= 0) throw new Error("يوجد تصنيف بنفس الاسم بالفعل.");
        return saveGroup("kb_meta", function(content){
          if(!isObj(content) || !isArr(content.categories)) content = { categories:[] };
          if(content.categories.some(function(c){ return c.name === name; })) throw conflict("تمت إضافة تصنيف بنفس الاسم من شخص آخر.");
          content.categories.push({ name:name, icon:icon });
          return content;
        }, "add-category").then(function(){
          setTimeout(function(){ var hd = document.getElementById("cat-" + String(name).replace(/[^a-zA-Z0-9\u0600-\u06FF_-]/g, "-")); if(hd) hd.scrollIntoView({ behavior:"smooth", block:"start" }); }, 80);
        });
      }
    });
  }

  /* =========================================================
     Flat table groups (rows) — used by the inline row buttons and the data manager
     ========================================================= */
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
  function rowForm(gid, sc, index){
    var isNew = index < 0;
    var list = D()[gid];
    if(!isArr(list)) return toast("تعذر فتح هذه البيانات.", "err");
    var base = isNew ? null : clone(list[index]);
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
          if(k === "video" && t.trim() !== "" && !isHttp(t)) throw new Error("رابط الفيديو يجب أن يبدأ بـ http:// أو https://");
          if(t.trim() === "") out[k] = ((base && (base[k] === null || base[k] === undefined)) || (isNew && f.nulls)) ? null : "";
          else out[k] = t;
        }
      });
      if(base) Object.keys(base).forEach(function(k){ if(!(k in out)) out[k] = base[k]; });   /* keep columns the form does not show */
      var mainKey = sc.keys.filter(function(k){ return !sc.info[k].num; })[0];
      if(mainKey && !out[mainKey] && isNew) throw new Error("الحقل «" + (FIELD_LABELS[mainKey] || mainKey) + "» مطلوب.");
      if(gid.indexOf("fees_") === 0 && out.min > out.max) throw new Error("قيمة «من» يجب ألا تكون أكبر من «إلى».");
      return out;
    }
    openForm((isNew ? "إضافة صف — " : "تعديل صف — ") + (GROUP_LABELS[gid] || gid), grid, {
      onSave:function(){
        var next = collect();
        if(!isNew && deepEq(next, base)) throw new Error("لم يتم تغيير أي شيء.");
        return saveGroup(gid, function(content){
          if(isNew){ content.push(next); return content; }
          var i = -1;
          for(var j = 0; j < content.length; j++){ if(deepEq(content[j], base)){ i = j; break; } }
          if(i < 0){
            for(var m = 0; m < content.length; m++){ if(deepEq(content[m], next)) return content; }
            throw conflict("تم تعديل هذا الصف من شخص آخر. أغلق النافذة وحدّث الصفحة ثم أعد المحاولة.");
          }
          content[i] = next; return content;
        }, isNew ? "add-row" : "edit-row");
      },
      after:function(){ if(S.editorOpen) openGroup(gid); }
    });
  }

  /* =========================================================
     Data manager (all 18 groups, including the ones not shown on any page)
     ========================================================= */
  var ed = null, edSide = null, edPane = null, activeGroup = null;
  function groupKeys(){
    var d = D();
    var keys = GROUP_ORDER.filter(function(k){ return d[k] !== undefined; });
    Object.keys(d).forEach(function(k){ if(keys.indexOf(k) < 0 && k !== "kb_meta") keys.push(k); });
    return keys;
  }
  function displayedGroups(){
    var shown = { topics:true }, d = D();
    (d.topics || []).forEach(function(t){ (t.sections || []).forEach(function(s){ if(s.type === "table_ref" && s.ref) shown[s.ref] = true; }); });
    return shown;
  }
  function openEditor(gid){
    if(!ed){
      edSide = h("div", {class:"kb-ed-side"});
      edPane = h("div", {class:"kb-ed-pane"});
      ed = h("div", {class:"kb-editor", id:"kb-editor", hidden:true},
        h("div", {class:"kb-ed-box", role:"dialog", "aria-modal":"true", "aria-label":"إدارة بيانات الموقع"},
          h("div", {class:"kb-ed-head"},
            h("h2", {text:"✏️ إدارة بيانات الموقع"}),
            h("button", {class:"kb-btn", type:"button", text:"⬇ نسخة احتياطية JSON", onclick:exportBackup}),
            h("button", {class:"kb-btn", type:"button", text:"✕ إغلاق", onclick:closeEditor})),
          h("div", {class:"kb-ed-main"}, edSide, edPane)));
      document.body.appendChild(ed);
      document.addEventListener("keydown", function(e){ if(e.key === "Escape" && S.editorOpen && !document.querySelector(".kb-form-overlay, .kb-pin-overlay")) closeEditor(); });
    }
    ed.hidden = false; S.editorOpen = true;
    document.body.style.overflow = "hidden";
    if(gid) activeGroup = gid;
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
    var d = D(), shown = displayedGroups();
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
    var v = D()[gid];
    edPane.innerHTML = ""; edPane.scrollTop = 0;
    if(gid === "topics") topicsView();
    else if(isArr(v) && v.every(isObj)) rowsView(gid);
    else add(edPane, h("p", {class:"kb-note", text:"لا يمكن عرض هذه المجموعة هنا."}));
  }
  function exportBackup(){
    var blob = new Blob([JSON.stringify({ exported_at:new Date().toISOString(), source:"supabase:" + TABLE, groups:D() }, null, 2)], { type:"application/json" });
    var a = h("a", { href:URL.createObjectURL(blob), download:"nowpay-kb-backup-" + new Date().toISOString().slice(0, 10) + ".json" });
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
    var rows = D()[gid];
    var sc = schemaOf(rows);
    var shownMax = 60;
    var q = h("input", {class:"kb-input", type:"search", placeholder:"بحث داخل الصفوف…"});
    var list = h("div");
    function draw(){
      list.innerHTML = "";
      var data = D()[gid], term = q.value.trim().toLowerCase(), n = 0, matched = 0;
      data.forEach(function(r, i){
        if(term && JSON.stringify(r).toLowerCase().indexOf(term) < 0) return;
        matched++;
        if(n >= shownMax) return;
        n++;
        list.appendChild(h("div", {class:"kb-row-card"},
          h("div", {class:"kb-row-text"}, h("b", {text:rowTitle(gid, r)}), h("span", {text:rowSub(gid, r)})),
          h("button", {class:"kb-btn small ghost", type:"button", text:"تعديل", onclick:function(){ unlockThen(function(){ rowForm(gid, sc, i); }); }})));
      });
      if(matched > n) list.appendChild(h("p", {class:"kb-note", text:"يتم عرض أول " + n + " من " + matched + " — استخدم البحث لتضييق النتائج."}));
      if(!matched) list.appendChild(h("p", {class:"kb-note", text:"لا توجد نتائج."}));
    }
    q.addEventListener("input", draw);
    add(edPane,
      h("h3", {text:GROUP_LABELS[gid] || gid}),
      h("p", {class:"kb-ed-hint", text:"عدد الصفوف: " + rows.length + ". أي تعديل أو إضافة يُحفظ في Supabase ويظهر لكل أعضاء الفريق، ويُحفظ قبلها نسخة احتياطية تلقائية."}),
      h("div", {class:"kb-ed-toolbar"}, q,
        h("button", {class:"kb-btn", type:"button", text:"＋ إضافة صف جديد", onclick:function(){ unlockThen(function(){ rowForm(gid, sc, -1); }); }})),
      list);
    draw();
  }
  function topicsView(){
    var M = App.meta, d = D();
    add(edPane, h("h3", {text:"المواضيع (صفحات الموقع)"}),
      h("p", {class:"kb-ed-hint", text:"اختر موضوعاً لتعديل عنوانه وتصنيفه، أو أضف موضوعاً جديداً. لتعديل الأقسام والعناصر استخدم أزرار ✏️ و＋ داخل صفحة الموضوع نفسها."}),
      h("div", {class:"kb-ed-toolbar"},
        h("button", {class:"kb-btn", type:"button", text:"＋ موضوع جديد", onclick:function(){ unlockThen(function(){ topicForm(null); }); }}),
        h("button", {class:"kb-btn ghost", type:"button", text:"＋ تصنيف جديد", onclick:function(){ unlockThen(function(){ categoryForm(); }); }})));
    M.catList().forEach(function(cat){
      var items = d.topics.filter(function(t){ return t.cat === cat; });
      if(!items.length) return;
      edPane.appendChild(h("div", {class:"kb-cat-label", text:(M.catIcon(cat) || "📁") + " " + cat}));
      items.forEach(function(t){
        edPane.appendChild(h("div", {class:"kb-row-card"},
          h("div", {class:"kb-row-text"}, h("b", {text:(t.icon || "") + " " + t.title}), h("span", {text:t.sections.length + " قسم · " + t.id})),
          h("button", {class:"kb-btn small ghost", type:"button", text:"تعديل", onclick:function(){ unlockThen(function(){ topicForm(t.id); }); }})));
      });
    });
  }

  /* ---------------- boot ---------------- */
  function boot(){
    mountTopbar();
    loadLatest(true);
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible" && !S.editorOpen && !document.querySelector(".kb-form-overlay, .kb-pin-overlay") && Date.now() - S.lastLoad > AUTO_REFRESH_MS) loadLatest(true);
    });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  window.NowPayAdmin = { reload:function(){ return loadLatest(false); }, isUnlocked:hasToken };   /* small public surface (no secrets) */
})();
