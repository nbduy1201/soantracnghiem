/**********************
 *  QUIZ EDITOR (JS)  *
 *  HTML/CSS/JS thuần *
 **********************/

const LS_KEY = "quizQuestions_v2";
const LS_META_KEY = "quizMeta_v1";

const typeLabels = {
  "multiple-choice": "Trắc nghiệm",
  "multiple-choice-grid": "Lưới trắc nghiệm",
  "true-false-grid": "Lưới đúng/sai",
  "matching": "Ghép nối",
  "ordering": "Sắp xếp",
  "fill-blanks": "Điền khuyết",
  "hotspot": "Hotspot",
};

let questions = [];

// Pagination (Danh sách câu hỏi)
const LIST_PER_PAGE = 20;
let listPage = 1;

let currentEditId = null;
let draftId = null; // ID nháp cho câu hỏi mới (hiển thị ngay khi chọn loại)
// media trong lúc edit (base64 đã nén)
let draftMedia = {}; // { key: base64 }
// hotspot regions trong lúc edit
let draftRegions = []; // [{id,type,label,isCorrect,...coordsPercent}]

// hotspot tool state
let currentTool = "rect";
let drawing = null;      // {type,startX,startY,el}
let polyPoints = [];     // [[x,y],...]

// list tools state
let listSearchTerm = "";

// sort state (Danh sách câu hỏi)
let listSortKey = "updatedAt"; // updatedAt | type | question | export
let listSortDir = "desc";       // asc | desc

// meta (class, names, google api)
let meta = { className: "", namesText: "", apiUrl: "" };

const APPS_SCRIPT_SNIPPET = `/**
 * Google Apps Script (Web App)
 * - Tạo 1 Google Sheet bất kỳ
 * - Extensions → Apps Script → dán code này
 * - Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * - Copy URL ("/exec") và dán vào Quiz Editor
 */

function normalize_(v){
  return (v ?? "").toString().trim().toLowerCase();
}

function ensureHeader_(sheet){
  const head = ["timestamp", "date", "class", "name", "score", "total", "timeSeconds", "mode"];
  const normHead = head.map(normalize_);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(head);
    return;
  }

  const first = sheet.getRange(1, 1, 1, head.length)
    .getValues()[0]
    .map(normalize_);

  const isHeader = normHead.every((h, i) => first[i] === h);

  if (!isHeader) {
    sheet.getRange(1, 1, 1, head.length).setValues([head]);
  }
}

function doPost(e){
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  ensureHeader_(sheet);

  let data = {};
  try {
    data = JSON.parse(e.postData.contents || "{}");
  } catch(err) {}

  const ts = new Date();
  const row = [
    ts.toISOString(),
    data.date || Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    data.className || "",
    data.name || "",
    Number(data.score || 0),
    Number(data.total || 0),
    Number(data.timeSeconds || 0),
    (data.mode || "").toString()
  ];

  sheet.appendRow(row);

  return ContentService
    .createTextOutput(JSON.stringify({ ok:true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(){
  return ContentService
    .createTextOutput(JSON.stringify({ ok:true, message:"Quiz API is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}`;
/* =======================
   Helpers
======================= */
function $(id) { return document.getElementById(id); }

function uid() {
  return "q_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round2(n) { return Math.round(n * 100) / 100; }


function activateTab(tabId){
  // dùng cơ chế tab sẵn có (click button) để giữ nguyên logic
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

function showToast(title, msgHtml) {
  const toast = $("toast");
  $("toastTitle").textContent = title;
  $("toastMsg").innerHTML = msgHtml;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

/* =======================
   Image utilities
======================= */
async function fileToBase64(file) {
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Không đọc được file"));
    r.readAsDataURL(file);
  });
}

/**
 * resizeImage(base64, maxWidth, quality)
 * - Nén ảnh để giảm dung lượng trước khi lưu localStorage (tránh vượt ~5MB)
 */
async function resizeImage(base64, maxWidth = 1280, quality = 0.82) {
  const img = new Image();
  img.src = base64;

  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Không đọc được ảnh"));
  });

  const ratio = img.naturalWidth / img.naturalHeight;
  const targetW = Math.min(maxWidth, img.naturalWidth);
  const targetH = Math.round(targetW / ratio);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, targetW, targetH);

  // png giữ alpha; jpeg thường nhẹ hơn
  const isPng = base64.startsWith("data:image/png");
  const mime = isPng ? "image/png" : "image/jpeg";
  return canvas.toDataURL(mime, quality);
}

function pickImageFor(key) {
  const input = $("file_" + key);
  if (input) input.click();
}

async function onPickFile(e, key, maxW = 1280, quality = 0.82) {
  const file = e.target.files?.[0];
  if (!file) return;

  const base64 = await fileToBase64(file);
  const resized = await resizeImage(base64, maxW, quality);
  draftMedia[key] = resized;

  renderThumb(key);
  renderThumbInline(key);

  e.target.value = "";
}

function removeImage(key) {
  delete draftMedia[key];
  renderThumb(key);
  renderThumbInline(key);

  // nếu xoá ảnh hotspot → reset vùng
  if (key === "hotspotImage") {
    draftRegions = [];
    polyPoints = [];
    drawing = null;
    renderHotspotStage();
    renderRegionList();
  }
}

/* =======================
   LocalStorage
======================= */
function saveToLocalStorage(showOkToast) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(questions));
    if (showOkToast) showToast("Đã lưu", "Dữ liệu đã được lưu vào LocalStorage.");
  } catch (e) {
    console.error(e);
    alert("❌ Không thể lưu LocalStorage. Có thể dữ liệu (ảnh) quá lớn. Hãy giảm kích thước ảnh.");
  }
}

/* =======================
   Boot
======================= */
window.addEventListener("load", () => {
  // load
  const saved = localStorage.getItem(LS_KEY) || localStorage.getItem("quizQuestions") || "[]";
  questions = safeJsonParse(saved, []);
  if (!Array.isArray(questions)) questions = [];
  questions.forEach(q => { if (typeof q.exportFlag !== "boolean") q.exportFlag = true; });

  // bind top buttons
  bindTopActions();

  // bind list controls
  bindListTools();

  // init meta (class/names/api)
  initMetaUI();

  // bind editor base
  bindEditorBase();

  renderList();
  createNewQuestion();
  bindPasteForQuestion();
});

function bindListTools(){
  const s = $("qSearch");
  const all = $("qSelectAll");
  if (s) {
    s.addEventListener("input", () => {
      listSearchTerm = (s.value || "").trim().toLowerCase();
      listPage = 1;
      renderList();
    });
  }
  if (all) {
    all.addEventListener("click", (ev) => ev.stopPropagation());
    all.addEventListener("change", () => {
      const visible = getVisibleQuestions();
      if (!visible.length) return;
      visible.forEach(q => q.exportFlag = !!all.checked);
      saveToLocalStorage(false);
      renderList();
      showToast("Đã cập nhật", `Export: <b>${all.checked ? "BẬT" : "TẮT"}</b> cho ${visible.length} câu.`);
    });
  }

  // sort
  const sortSel = $("qSort");
  if (sortSel) {
    // set current
    sortSel.value = `${listSortKey}_${listSortDir}`;
    sortSel.addEventListener("change", () => {
      const v = sortSel.value || "updatedAt_desc";
      const [k, d] = v.split("_");
      listSortKey = k || "updatedAt";
      listSortDir = d || "desc";
      listPage = 1;
      renderList();
    });
  }

}

function initMetaUI(){
  // load
  const saved = safeJsonParse(localStorage.getItem(LS_META_KEY) || "{}", {});
  meta = {
    className: (saved.className || ""),
    namesText: (saved.namesText || ""),
    apiUrl: (saved.apiUrl || "")
  };

  // fill
  const c = $("metaClass");
  const n = $("metaNames");
  const u = $("googleApiUrl");
  const codeBox = $("apiCodeBox");
  const copyBtn = $("btnCopyApiCode");

  if (c) c.value = meta.className;
  if (n) n.value = meta.namesText;
  if (u) u.value = meta.apiUrl;
  if (codeBox) codeBox.textContent = APPS_SCRIPT_SNIPPET;

  const saveMeta = () => {
    meta.className = (c?.value || "").trim();
    meta.namesText = (n?.value || "");
    meta.apiUrl = (u?.value || "").trim();
    localStorage.setItem(LS_META_KEY, JSON.stringify(meta));
  };

  const debouncedSave = () => {
    clearTimeout(initMetaUI._t);
    initMetaUI._t = setTimeout(saveMeta, 250);
  };

  c?.addEventListener("input", debouncedSave);
  n?.addEventListener("input", debouncedSave);
  u?.addEventListener("input", debouncedSave);

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT_SNIPPET);
      showToast("Đã copy", "Đã copy code Apps Script vào clipboard.");
    } catch (e) {
      console.error(e);
      alert("Không copy được. Hãy copy thủ công trong khung code.");
    }
  });
}

function getVisibleQuestions(){
  const term = (listSearchTerm || "").trim();
  if (!term) return questions;
  return questions.filter(q => {
    const t = `${q.id} ${(q.question || "")} ${(typeLabels[q.type] || q.type || "")}`.toLowerCase();
    return t.includes(term);
  });
}

function sortQuestions(arr){
  const out = [...arr];

  const dir = (listSortDir === "asc") ? 1 : -1;

  const getTypeLabel = (q) => (typeLabels[q.type] || q.type || "").toString();
  const getQuestion = (q) => (q.question || "").toString();
  const getUpdated = (q) => {
    const t = Date.parse(q.updatedAt || "");
    return Number.isFinite(t) ? t : 0;
  };
  const getExport = (q) => (q.exportFlag !== false) ? 1 : 0;

  const cmpStr = (a, b) => a.localeCompare(b, "vi", { sensitivity: "base" });

  out.sort((qa, qb) => {
    let c = 0;

    if (listSortKey === "updatedAt") {
      c = getUpdated(qa) - getUpdated(qb);
    } else if (listSortKey === "type") {
      c = cmpStr(getTypeLabel(qa), getTypeLabel(qb));
    } else if (listSortKey === "question") {
      c = cmpStr(getQuestion(qa), getQuestion(qb));
    } else if (listSortKey === "export") {
      c = getExport(qa) - getExport(qb);
    }

    if (c === 0) {
      // tie-breaker để ổn định: theo updatedAt rồi id
      c = getUpdated(qa) - getUpdated(qb);
      if (c === 0) c = cmpStr((qa.id || ""), (qb.id || ""));
    }

    return c * dir;
  });

  return out;
}


function bindTopActions() {
  $("btnLoadSample").addEventListener("click", loadSampleData);

  $("btnSaveAll").addEventListener("click", () => saveToLocalStorage(true));

  $("btnExportJSON").addEventListener("click", exportJSON);

  $("btnOpenJSON").addEventListener("click", () => $("fileInput").click());

  $("fileInput").addEventListener("change", loadJSONFile);

  $("btnExportStandalone").addEventListener("click", exportStandaloneGame);

  $("btnAddQuestion").addEventListener("click", createNewQuestion);

  $("btnClearAll").addEventListener("click", clearAll);
}

function bindEditorBase() {
  $("questionType").addEventListener("change", handleTypeChange);

  // basic formatting toolbar for question textarea
  bindQuestionFormatting();

  $("btnPickQuestionImg").addEventListener("click", () => pickImageFor("question"));
  $("file_question").addEventListener("change", (e) => onPickFile(e, "question", 1280, 0.82));

  $("btnSaveQuestion").addEventListener("click", saveQuestion);
  $("btnCancelEdit").addEventListener("click", cancelEdit);
}

function bindQuestionFormatting(){
  const ta = $("questionText");
  const bar = $("qFmtToolbar");
  if (!ta || !bar) return;

  const wrapSelection = (before, after) => {
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const val = ta.value || "";
    const sel = val.slice(start, end);
    const next = val.slice(0, start) + before + sel + after + val.slice(end);
    ta.value = next;
    const cursor = start + before.length + sel.length + after.length;
    ta.focus();
    ta.setSelectionRange(cursor, cursor);
  };

  const applyList = (prefix) => {
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const val = ta.value || "";
    const sel = val.slice(start, end) || "";
    const lines = sel.split("\n");
    const out = lines.map((l, i) => {
      const t = (l || "").trim();
      if (!t) return "";
      if (prefix === "1.") return `${i+1}. ${t}`;
      return `${prefix} ${t}`;
    }).join("\n");
    const next = val.slice(0, start) + out + val.slice(end);
    ta.value = next;
    ta.focus();
    ta.setSelectionRange(start, start + out.length);
  };

  const doFmt = (fmt) => {
    if (fmt === "bold") return wrapSelection("**", "**");
    if (fmt === "italic") return wrapSelection("*", "*");
    if (fmt === "underline") return wrapSelection("__", "__");
    if (fmt === "ul") return applyList("-");
    if (fmt === "ol") return applyList("1.");
    if (fmt === "br") return wrapSelection("\n", "");
  };

  bar.querySelectorAll("[data-fmt]").forEach(btn => {
    btn.addEventListener("click", () => doFmt(btn.getAttribute("data-fmt")));
  });

  // shortcuts
  ta.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "b") { e.preventDefault(); doFmt("bold"); }
    if (k === "i") { e.preventDefault(); doFmt("italic"); }
    if (k === "u") { e.preventDefault(); doFmt("underline"); }
  });
}

/* =======================
   Sidebar list
======================= */
function renderList() {
  const list = $("qList");
  const pager = $("qPagination");
  $("qCount").textContent = `(${questions.length})`;

  const allVisible = sortQuestions(getVisibleQuestions()); // filtered + sorted (not paged)

  // Selected count (Export)
  const selCountEl = $("qSelectedCount");
  if (selCountEl) {
    const total = allVisible.length;
    const selected = allVisible.filter(q => q.exportFlag !== false).length;
    selCountEl.textContent = total ? `Đã chọn: ${selected}/${total}` : "Đã chọn: 0";
  }

  // Select-all reflects ALL currently visible (filtered) items, not just current page.
  const selAll = $("qSelectAll");
  if (selAll) {
    if (!allVisible.length) selAll.checked = false;
    else selAll.checked = allVisible.every(q => q.exportFlag !== false);
  }

  if (!questions.length) {
    list.innerHTML = `<p class="hint" style="text-align:center;padding:1.2rem 0">Chưa có câu hỏi nào.</p>`;
    if (pager) pager.innerHTML = "";
    return;
  }

  if (!allVisible.length) {
    list.innerHTML = `<p class="hint" style="text-align:center;padding:1.2rem 0">Không tìm thấy câu hỏi phù hợp.</p>`;
    if (pager) pager.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(allVisible.length / LIST_PER_PAGE));
  listPage = Math.min(Math.max(1, listPage), totalPages);

  const start = (listPage - 1) * LIST_PER_PAGE;
  const visible = allVisible.slice(start, start + LIST_PER_PAGE);

  list.innerHTML = `
    <table class="q-table">
      <thead>
        <tr>
          <th style="width:52px" title="Chọn Export">Export</th>
          <th style="width:140px">Loại</th>
          <th>Nội dung</th>
          <th style="width:78px">Xóa</th>
        </tr>
      </thead>
      <tbody>
        ${visible.map((q) => {
          const active = q.id === currentEditId ? "active" : "";
          const exportChecked = q.exportFlag !== false ? "checked" : "";
          return `
            <tr class="${active}" data-id="${q.id}">
              <td>
                <input type="checkbox" ${exportChecked} data-export="${q.id}" title="Chọn để xuất" />
              </td>
              <td class="q-type-cell">${typeLabels[q.type] || q.type}</td>
              <td class="q-text-cell" title="${escapeHtml(q.question || "")}">
                ${escapeHtml(q.question || "(Không có nội dung)")}
              </td>
              <td>
                <button class="icon-btn danger" title="Xóa" data-del="${q.id}">🗑️</button>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  // Pagination UI
  if (pager) {
    if (totalPages <= 1) {
      pager.innerHTML = `<div class="page-info">Hiển thị ${allVisible.length} câu</div>`;
    } else {
      pager.innerHTML = `
        <div class="page-info">Trang <b>${listPage}</b> / <b>${totalPages}</b> • Tổng <b>${allVisible.length}</b> câu</div>
        <div class="pager">
          <button class="page-btn" id="btnPrevPage" ${listPage === 1 ? "disabled" : ""}>← Trước</button>
          <button class="page-btn" id="btnNextPage" ${listPage === totalPages ? "disabled" : ""}>Sau →</button>
        </div>
      `;

      $("btnPrevPage")?.addEventListener("click", () => { if (listPage > 1) { listPage--; renderList(); } });
      $("btnNextPage")?.addEventListener("click", () => { if (listPage < totalPages) { listPage++; renderList(); } });
    }
  }

  // click chọn item
  [...list.querySelectorAll("tbody tr")].forEach(el => {
    el.addEventListener("click", (ev) => {
      // chặn khi click vào checkbox / nút xoá
      const t = ev.target;
      if (t?.closest("[data-del]") || t?.closest("[data-export]")) return;
      editQuestion(el.getAttribute("data-id"));
    });
  });

  // toggle export
  [...list.querySelectorAll("[data-export]")].forEach(chk => {
    chk.addEventListener("click", (ev) => ev.stopPropagation());
    chk.addEventListener("change", () => toggleExportFlag(chk.getAttribute("data-export"), chk.checked));
  });

  // delete
  [...list.querySelectorAll("[data-del]")].forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteQuestion(btn.getAttribute("data-del"));
    });
  });
}

function toggleExportFlag(id, checked) {
  const q = questions.find(x => x.id === id);
  if (!q) return;
  q.exportFlag = !!checked;
  saveToLocalStorage(false);
  showToast("Đã cập nhật", `Export: <b>${checked ? "BẬT" : "TẮT"}</b>`);
  renderList();
}

/* =======================
   Editor flow
======================= */
function createNewQuestion() {
  activateTab("tabEditor");
  currentEditId = null;
  draftId = uid(); // tạo ID ngay lập tức cho câu hỏi mới
  draftMedia = {};
  draftRegions = [];
  polyPoints = [];
  drawing = null;

  $("editorTitle").textContent = "✏️ Tạo câu hỏi mới";
  $("saveBtnText").textContent = "💾 Lưu câu hỏi";
  $("qid").textContent = draftId; // ✅ hiện ID

  $("questionType").value = "multiple-choice";
  $("questionText").value = "";
  $("exportFlag").checked = true;

  renderThumb("question");
  handleTypeChange();
  renderList();
}

function cancelEdit() { createNewQuestion(); }

function editQuestion(id) {
  const q = questions.find(x => x.id === id);
  if (!q) return;

  activateTab("tabEditor");
  currentEditId = id;

  $("editorTitle").textContent = "✏️ Chỉnh sửa câu hỏi";
  $("saveBtnText").textContent = "💾 Cập nhật";
  $("qid").textContent = id;

  $("questionType").value = q.type;
  $("questionText").value = q.question || "";
  $("exportFlag").checked = q.exportFlag !== false;

  draftMedia = safeJsonParse(JSON.stringify(q.media || {}), {});
  draftRegions = safeJsonParse(JSON.stringify(q.hotspotRegions || []), []);
  polyPoints = [];
  drawing = null;

  renderThumb("question");
  handleTypeChange();
  loadTypeData(q);

  renderList();
}

function deleteQuestion(id) {
  if (!confirm("Xóa câu hỏi này?")) return;
  questions = questions.filter(q => q.id !== id);
  if (currentEditId === id) createNewQuestion();
  saveToLocalStorage(true);
  renderList();
}

function clearAll() {
  if (!questions.length) return;
  if (!confirm("Xóa TẤT CẢ câu hỏi?")) return;
  questions = [];
  saveToLocalStorage(true);
  createNewQuestion();
  renderList();
}

/* =======================
   Thumbnails
======================= */
function renderThumb(key) {
  const map = {
    "question": "qThumb",
    "hotspotImage": "hotspotThumb",
  };
  const hostId = map[key];
  if (!hostId) return;

  const host = $(hostId);
  if (!host) return;

  const img64 = draftMedia[key];
  if (!img64) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }

  host.style.display = "block";
  host.innerHTML = `
    <img src="${img64}" alt="thumb">
    <div class="thumb-actions">
      <button class="btn-delete" data-removeimg="${key}"><span>🗑️ Xóa ảnh</span></button>
      <span class="hint" style="opacity:.8">Ảnh đã nén</span>
    </div>
  `;

  host.querySelector("[data-removeimg]")?.addEventListener("click", () => removeImage(key));
}

function renderThumbInline(key) {
  const host = document.getElementById("thumb_" + key);
  if (!host) return;

  const img64 = draftMedia[key];
  if (!img64) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }

  host.style.display = "block";
  host.innerHTML = `
    <img src="${img64}" alt="thumb">
    <div class="thumb-actions">
      <button class="btn-delete" data-removeinline="${key}"><span>🗑️ Xóa</span></button>
      <span class="hint" style="opacity:.8">Ảnh đã nén</span>
    </div>
  `;

  host.querySelector("[data-removeinline]")?.addEventListener("click", () => {
    delete draftMedia[key];
    renderThumbInline(key);
  });
}

/* =======================
   Paste image handlers
======================= */
function bindPasteForQuestion() {
  const el = $("questionText");
  el.addEventListener("paste", async (ev) => {
    const items = ev.clipboardData?.items || [];
    const imgItem = [...items].find(it => it.type && it.type.startsWith("image/"));
    if (!imgItem) return;

    ev.preventDefault();
    const file = imgItem.getAsFile();
    const base64 = await fileToBase64(file);
    const resized = await resizeImage(base64, 1280, 0.82);
    draftMedia["question"] = resized;
    renderThumb("question");
    showToast("Đã dán ảnh", "Ảnh đã được nén & gắn vào câu hỏi.");
  });
}

/**
 * Bind paste ảnh (Ctrl+V) cho các input/textarea động
 * - selector: ".mc_text" / ".tf_text" ...
 * - keyFn: (index) => "mc_opt_0"
 */
function bindPasteOnInputs(root, selector, keyFn, maxW = 900, quality = 0.82) {
  const inputs = root.querySelectorAll(selector);
  inputs.forEach((el, i) => {
    el.addEventListener("paste", async (ev) => {
      const items = ev.clipboardData?.items || [];
      const imgItem = [...items].find(it => it.type && it.type.startsWith("image/"));
      if (!imgItem) return;

      ev.preventDefault();
      const file = imgItem.getAsFile();
      const base64 = await fileToBase64(file);
      const resized = await resizeImage(base64, maxW, quality);

      const key = keyFn(i);
      draftMedia[key] = resized;
      renderThumbInline(key);
      showToast("Đã dán ảnh", `Ảnh đã gắn vào <b>${key}</b>.`);
    });
  });
}

/* =======================
   Dynamic type rendering
======================= */
function handleTypeChange() {
  const type = $("questionType").value;
  const host = $("dynamicContent");

  host.innerHTML = "";
  if (type === "multiple-choice") host.innerHTML = renderMultipleChoiceEditor();
  if (type === "multiple-choice-grid") host.innerHTML = renderMultipleChoiceGridEditor();
  if (type === "true-false-grid") host.innerHTML = renderTrueFalseGridEditor();
  if (type === "matching") host.innerHTML = renderMatchingEditor();
  if (type === "ordering") host.innerHTML = renderOrderingEditor();
  if (type === "fill-blanks") host.innerHTML = renderFillBlanksEditor();
  if (type === "hotspot") host.innerHTML = renderHotspotEditor();

  // init defaults + bind events theo type
  if (type === "multiple-choice") mc_init(4);
  if (type === "multiple-choice-grid") mcg_init(4, 2);
  if (type === "true-false-grid") tf_init(2);
  if (type === "matching") mt_init(2);
  if (type === "ordering") or_init(2);
  if (type === "fill-blanks") fb_init(4);
  if (type === "hotspot") hs_init();
}

/* ===== Multiple Choice ===== */
function renderMultipleChoiceEditor() {
  return `
    <div class="section-title">📝 Lựa chọn</div>
    <div class="checkbox" style="margin:.2rem 0 .9rem">
      <input type="checkbox" id="mc_multi">
      <span>Cho phép chọn nhiều đáp án</span>
    </div>

    <div class="dyn-list" id="mc_list"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="mc_addBtn"><span>➕ Thêm lựa chọn</span></button>
    </div>
  `;
}

function mc_row(index, data = { text: "", isCorrect: false }) {
  const key = `mc_opt_${index}`;
  const hasImg = !!draftMedia[key];

  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Lựa chọn ${index + 1}</label>
        <input type="text" class="mc_text" value="${escapeHtml(data.text || "")}" placeholder="Nhập lựa chọn...">
        <div id="thumb_${key}" class="thumbnail-preview" style="display:${hasImg ? "block" : "none"}"></div>

        <div class="inline" style="margin-top:.55rem">
          <div class="checkbox">
            <input type="checkbox" class="mc_correct" ${data.isCorrect ? "checked" : ""}>
            <span>Đúng</span>
          </div>

          <button class="media-btn" data-pick="${key}">🖼️ Ảnh</button>
          <input type="file" id="file_${key}" accept="image/*" style="display:none">
        </div>

      </div>
      <button class="trash" data-delrow="mc" title="Xóa">🗑️</button>
    </div>
  `;
}

function mc_init(defaultCount = 4) {
  const host = $("mc_list");
  host.innerHTML = "";
  for (let i = 0; i < defaultCount; i++) host.insertAdjacentHTML("beforeend", mc_row(i));

  // bind add
  $("mc_addBtn").addEventListener("click", mc_add);

  // bind file pick buttons
  bindRowMediaPickers(host, "mc_opt_", 900, 0.82);

  // bind paste on input
  bindPasteOnInputs(host, ".mc_text", (i) => `mc_opt_${i}`);

  // bind delete row
  bindDeleteRow(host, "mc", mc_rebuild);

  // render inline thumbs
  for (let i = 0; i < defaultCount; i++) renderThumbInline(`mc_opt_${i}`);
}

function mc_add() {
  const host = $("mc_list");
  const idx = host.children.length;
  host.insertAdjacentHTML("beforeend", mc_row(idx));

  // bind newly added row events
  const row = host.lastElementChild;
  bindRowMediaPickers(row, "mc_opt_", 900, 0.82);
  bindPasteOnInputs(row, ".mc_text", () => `mc_opt_${idx}`);
  row.querySelector('[data-delrow="mc"]')?.addEventListener("click", () => {
    row.remove();
    mc_rebuild();
  });

  renderThumbInline(`mc_opt_${idx}`);
}

function mc_rebuild() {
  const host = $("mc_list");
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row, i) => ({
    text: row.querySelector(".mc_text")?.value || "",
    isCorrect: !!row.querySelector(".mc_correct")?.checked,
    img: draftMedia[`mc_opt_${i}`] || null
  }));

  // reset
  // xoá ảnh key cũ
  Object.keys(draftMedia)
    .filter(k => k.startsWith("mc_opt_"))
    .forEach(k => delete draftMedia[k]);

  host.innerHTML = "";
  old.forEach((d, i) => {
    host.insertAdjacentHTML("beforeend", mc_row(i, d));
    if (d.img) draftMedia[`mc_opt_${i}`] = d.img;
  });

  // rebind
  $("mc_addBtn").addEventListener("click", mc_add);
  bindRowMediaPickers(host, "mc_opt_", 900, 0.82);
  bindPasteOnInputs(host, ".mc_text", (i) => `mc_opt_${i}`);
  bindDeleteRow(host, "mc", mc_rebuild);
  old.forEach((_, i) => renderThumbInline(`mc_opt_${i}`));
}

/* ===== Multiple Choice Grid ===== */
function renderMultipleChoiceGridEditor(){
  return `
    <div class="section-title">🧱 Lưới trắc nghiệm</div>
    <p class="hint">
      • Mỗi dòng là 1 mệnh đề/câu con. Mỗi dòng chọn <b>1</b> đáp án theo cột.<br>
      • Cột (đáp án) áp dụng chung cho toàn bộ lưới.
    </p>

    <div class="row" style="grid-template-columns:1fr;gap:.6rem">
      <div>
        <label>Cột (mỗi dòng 1 cột)</label>
        <textarea id="mcg_cols" placeholder="A\nB\nC\nD" style="min-height:110px"></textarea>
      </div>
    </div>

    <div class="section-title" style="margin-top:1rem">📋 Dòng (mệnh đề)</div>
    <div class="dyn-list" id="mcg_rows"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="mcg_addBtn"><span>➕ Thêm dòng</span></button>
    </div>
  `;
}

function mcg_row(index, data = { text:"", correct:0 }){
  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Dòng ${index + 1}</label>
        <textarea class="mcg_text" placeholder="Nhập mệnh đề...">${escapeHtml(data.text || "")}</textarea>
        <div class="inline" style="margin-top:.55rem">
          <label style="text-transform:none;letter-spacing:0;opacity:.9;margin:0">Đáp án đúng (cột):</label>
          <input class="mcg_correct" type="number" min="1" step="1" value="${Number.isFinite(+data.correct) ? (+data.correct + 1) : 1}" style="width:90px" title="Nhập số thứ tự cột (1..N)"/>
          <span class="hint" style="margin:0">(1..N)</span>
        </div>
      </div>
      <button class="trash" data-delrow="mcg" title="Xóa">🗑️</button>
    </div>
  `;
}

function mcg_init(defaultCols = 4, defaultRows = 2){
  const colsTa = $("mcg_cols");
  const host = $("mcg_rows");
  if (colsTa) colsTa.value = "A\nB\nC\nD";
  if (!host) return;

  host.innerHTML = "";
  for (let i=0;i<defaultRows;i++) host.insertAdjacentHTML("beforeend", mcg_row(i));

  $("mcg_addBtn")?.addEventListener("click", () => {
    const idx = host.children.length;
    host.insertAdjacentHTML("beforeend", mcg_row(idx));
    bindDeleteRow(host, "mcg", mcg_rebuild);
  });

  bindDeleteRow(host, "mcg", mcg_rebuild);
}

function mcg_rebuild(){
  const host = $("mcg_rows");
  if (!host) return;
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row) => ({
    text: row.querySelector(".mcg_text")?.value || "",
    correct: Math.max(0, Number(row.querySelector(".mcg_correct")?.value || 1) - 1)
  }));

  host.innerHTML = "";
  old.forEach((d, i) => host.insertAdjacentHTML("beforeend", mcg_row(i, d)));

  $("mcg_addBtn")?.addEventListener("click", () => {
    const idx = host.children.length;
    host.insertAdjacentHTML("beforeend", mcg_row(idx));
    bindDeleteRow(host, "mcg", mcg_rebuild);
  });
  bindDeleteRow(host, "mcg", mcg_rebuild);
}

/* ===== True/False Grid ===== */
function renderTrueFalseGridEditor() {
  return `
    <div class="section-title">✅ Mệnh đề</div>
    <p class="hint">Mỗi mệnh đề có thể đính kèm ảnh (Ctrl+V / Chọn ảnh).</p>
    <div class="dyn-list" id="tf_list"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="tf_addBtn"><span>➕ Thêm mệnh đề</span></button>
    </div>
  `;
}

function tf_row(index, data = { text: "", correct: true }) {
  const key = `tf_stmt_${index}`;
  const hasImg = !!draftMedia[key];

  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Mệnh đề ${index + 1}</label>
        <textarea class="tf_text" placeholder="Nhập mệnh đề...">${escapeHtml(data.text || "")}</textarea>
        <div id="thumb_${key}" class="thumbnail-preview" style="display:${hasImg ? "block" : "none"}"></div>

        <div class="inline" style="margin-top:.55rem">
          <label style="text-transform:none;letter-spacing:0;opacity:.9;margin:0">Đáp án:</label>
          <select class="tf_correct" style="width:auto;min-width:140px">
            <option value="true" ${data.correct ? "selected" : ""}>✓ Đúng</option>
            <option value="false" ${!data.correct ? "selected" : ""}>✗ Sai</option>
          </select>

          <button class="media-btn" data-pick="${key}">🖼️ Ảnh</button>
          <input type="file" id="file_${key}" accept="image/*" style="display:none">
        </div>
      </div>

      <button class="trash" data-delrow="tf" title="Xóa">🗑️</button>
    </div>
  `;
}

function tf_init(defaultCount = 2) {
  const host = $("tf_list");
  host.innerHTML = "";
  for (let i = 0; i < defaultCount; i++) host.insertAdjacentHTML("beforeend", tf_row(i));

  $("tf_addBtn").addEventListener("click", tf_add);

  bindRowMediaPickers(host, "tf_stmt_", 1100, 0.82);
  bindPasteOnInputs(host, ".tf_text", (i) => `tf_stmt_${i}`, 1100, 0.82);
  bindDeleteRow(host, "tf", tf_rebuild);

  for (let i = 0; i < defaultCount; i++) renderThumbInline(`tf_stmt_${i}`);
}

function tf_add() {
  const host = $("tf_list");
  const idx = host.children.length;
  host.insertAdjacentHTML("beforeend", tf_row(idx));

  const row = host.lastElementChild;
  bindRowMediaPickers(row, "tf_stmt_", 1100, 0.82);
  bindPasteOnInputs(row, ".tf_text", () => `tf_stmt_${idx}`, 1100, 0.82);
  row.querySelector('[data-delrow="tf"]')?.addEventListener("click", () => {
    row.remove();
    tf_rebuild();
  });

  renderThumbInline(`tf_stmt_${idx}`);
}

function tf_rebuild() {
  const host = $("tf_list");
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row, i) => ({
    text: row.querySelector(".tf_text")?.value || "",
    correct: (row.querySelector(".tf_correct")?.value || "true") === "true",
    img: draftMedia[`tf_stmt_${i}`] || null,
  }));

  Object.keys(draftMedia)
    .filter(k => k.startsWith("tf_stmt_"))
    .forEach(k => delete draftMedia[k]);

  host.innerHTML = "";
  old.forEach((d, i) => {
    host.insertAdjacentHTML("beforeend", tf_row(i, d));
    if (d.img) draftMedia[`tf_stmt_${i}`] = d.img;
  });

  $("tf_addBtn").addEventListener("click", tf_add);
  bindRowMediaPickers(host, "tf_stmt_", 1100, 0.82);
  bindPasteOnInputs(host, ".tf_text", (i) => `tf_stmt_${i}`, 1100, 0.82);
  bindDeleteRow(host, "tf", tf_rebuild);
  old.forEach((_, i) => renderThumbInline(`tf_stmt_${i}`));
}

/* ===== Matching ===== */
function renderMatchingEditor() {
  return `
    <div class="section-title">🔗 Ghép nối</div>
    <p class="hint">Mỗi vế trái / phải có thể đính kèm ảnh.</p>
    <div class="dyn-list" id="mt_list"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="mt_addBtn"><span>➕ Thêm cặp</span></button>
    </div>
  `;
}

function mt_row(index, data = { left: "", right: "" }) {
  const keyL = `mt_l_${index}`;
  const keyR = `mt_r_${index}`;
  const hasL = !!draftMedia[keyL];
  const hasR = !!draftMedia[keyR];

  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Cặp ${index + 1}</label>

        <div class="row" style="grid-template-columns:1fr 1fr;gap:.75rem">
          <div>
            <input type="text" class="mt_left" value="${escapeHtml(data.left || "")}" placeholder="Vế trái">
            <div id="thumb_${keyL}" class="thumbnail-preview" style="display:${hasL ? "block" : "none"}"></div>
            <div class="inline" style="margin-top:.45rem">
              <button class="media-btn" data-pick="${keyL}">🖼️ Ảnh trái</button>
              <input type="file" id="file_${keyL}" accept="image/*" style="display:none">
            </div>
          </div>

          <div>
            <input type="text" class="mt_right" value="${escapeHtml(data.right || "")}" placeholder="Vế phải">
            <div id="thumb_${keyR}" class="thumbnail-preview" style="display:${hasR ? "block" : "none"}"></div>
            <div class="inline" style="margin-top:.45rem">
              <button class="media-btn" data-pick="${keyR}">🖼️ Ảnh phải</button>
              <input type="file" id="file_${keyR}" accept="image/*" style="display:none">
            </div>
          </div>
        </div>
      </div>

      <button class="trash" data-delrow="mt" title="Xóa">🗑️</button>
    </div>
  `;
}

function mt_init(defaultCount = 2) {
  const host = $("mt_list");
  host.innerHTML = "";
  for (let i = 0; i < defaultCount; i++) host.insertAdjacentHTML("beforeend", mt_row(i));

  $("mt_addBtn").addEventListener("click", mt_add);

  bindRowMediaPickers(host, "mt_l_", 900, 0.82);
  bindRowMediaPickers(host, "mt_r_", 900, 0.82);

  bindPasteOnInputs(host, ".mt_left", (i) => `mt_l_${i}`, 900, 0.82);
  bindPasteOnInputs(host, ".mt_right", (i) => `mt_r_${i}`, 900, 0.82);

  bindDeleteRow(host, "mt", mt_rebuild);

  for (let i = 0; i < defaultCount; i++) {
    renderThumbInline(`mt_l_${i}`);
    renderThumbInline(`mt_r_${i}`);
  }
}

function mt_add() {
  const host = $("mt_list");
  const idx = host.children.length;
  host.insertAdjacentHTML("beforeend", mt_row(idx));

  const row = host.lastElementChild;

  bindRowMediaPickers(row, "mt_l_", 900, 0.82);
  bindRowMediaPickers(row, "mt_r_", 900, 0.82);
  bindPasteOnInputs(row, ".mt_left", () => `mt_l_${idx}`, 900, 0.82);
  bindPasteOnInputs(row, ".mt_right", () => `mt_r_${idx}`, 900, 0.82);

  row.querySelector('[data-delrow="mt"]')?.addEventListener("click", () => {
    row.remove();
    mt_rebuild();
  });

  renderThumbInline(`mt_l_${idx}`);
  renderThumbInline(`mt_r_${idx}`);
}

function mt_rebuild() {
  const host = $("mt_list");
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row, i) => ({
    left: row.querySelector(".mt_left")?.value || "",
    right: row.querySelector(".mt_right")?.value || "",
    imgL: draftMedia[`mt_l_${i}`] || null,
    imgR: draftMedia[`mt_r_${i}`] || null,
  }));

  Object.keys(draftMedia)
    .filter(k => k.startsWith("mt_l_") || k.startsWith("mt_r_"))
    .forEach(k => delete draftMedia[k]);

  host.innerHTML = "";
  old.forEach((d, i) => {
    host.insertAdjacentHTML("beforeend", mt_row(i, d));
    if (d.imgL) draftMedia[`mt_l_${i}`] = d.imgL;
    if (d.imgR) draftMedia[`mt_r_${i}`] = d.imgR;
  });

  $("mt_addBtn").addEventListener("click", mt_add);

  bindRowMediaPickers(host, "mt_l_", 900, 0.82);
  bindRowMediaPickers(host, "mt_r_", 900, 0.82);
  bindPasteOnInputs(host, ".mt_left", (i) => `mt_l_${i}`, 900, 0.82);
  bindPasteOnInputs(host, ".mt_right", (i) => `mt_r_${i}`, 900, 0.82);
  bindDeleteRow(host, "mt", mt_rebuild);

  old.forEach((_, i) => {
    renderThumbInline(`mt_l_${i}`);
    renderThumbInline(`mt_r_${i}`);
  });
}

/* ===== Ordering ===== */
function renderOrderingEditor() {
  return `
    <div class="section-title">📊 Sắp xếp</div>
    <p class="hint">Nhập các bước theo đúng thứ tự. Mỗi mục có thể đính kèm ảnh.</p>
    <div class="dyn-list" id="or_list"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="or_addBtn"><span>➕ Thêm mục</span></button>
    </div>
  `;
}

function or_row(index, data = { text: "" }) {
  const key = `or_${index}`;
  const hasImg = !!draftMedia[key];

  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Mục ${index + 1}</label>
        <input type="text" class="or_text" value="${escapeHtml(data.text || "")}" placeholder="Nhập mục...">
        <div id="thumb_${key}" class="thumbnail-preview" style="display:${hasImg ? "block" : "none"}"></div>

        <div class="inline" style="margin-top:.45rem">
          <button class="media-btn" data-pick="${key}">🖼️ Ảnh</button>
          <input type="file" id="file_${key}" accept="image/*" style="display:none">
        </div>
      </div>

      <button class="trash" data-delrow="or" title="Xóa">🗑️</button>
    </div>
  `;
}

function or_init(defaultCount = 2) {
  const host = $("or_list");
  host.innerHTML = "";
  for (let i = 0; i < defaultCount; i++) host.insertAdjacentHTML("beforeend", or_row(i));

  $("or_addBtn").addEventListener("click", or_add);

  bindRowMediaPickers(host, "or_", 900, 0.82);
  bindPasteOnInputs(host, ".or_text", (i) => `or_${i}`, 900, 0.82);
  bindDeleteRow(host, "or", or_rebuild);

  for (let i = 0; i < defaultCount; i++) renderThumbInline(`or_${i}`);
}

function or_add() {
  const host = $("or_list");
  const idx = host.children.length;
  host.insertAdjacentHTML("beforeend", or_row(idx));

  const row = host.lastElementChild;
  bindRowMediaPickers(row, "or_", 900, 0.82);
  bindPasteOnInputs(row, ".or_text", () => `or_${idx}`, 900, 0.82);
  row.querySelector('[data-delrow="or"]')?.addEventListener("click", () => {
    row.remove();
    or_rebuild();
  });

  renderThumbInline(`or_${idx}`);
}

function or_rebuild() {
  const host = $("or_list");
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row, i) => ({
    text: row.querySelector(".or_text")?.value || "",
    img: draftMedia[`or_${i}`] || null,
  }));

  Object.keys(draftMedia)
    .filter(k => k.startsWith("or_"))
    .forEach(k => delete draftMedia[k]);

  host.innerHTML = "";
  old.forEach((d, i) => {
    host.insertAdjacentHTML("beforeend", or_row(i, d));
    if (d.img) draftMedia[`or_${i}`] = d.img;
  });

  $("or_addBtn").addEventListener("click", or_add);
  bindRowMediaPickers(host, "or_", 900, 0.82);
  bindPasteOnInputs(host, ".or_text", (i) => `or_${i}`, 900, 0.82);
  bindDeleteRow(host, "or", or_rebuild);

  old.forEach((_, i) => renderThumbInline(`or_${i}`));
}

/* ===== Fill blanks ===== */
function renderFillBlanksEditor() {
  return `
    <div class="section-title">🧩 Điền khuyết</div>
    <p class="hint">Dùng ký hiệu <b>[ans]</b> trong câu để tạo ô nhập. Ví dụ: HTML là viết tắt của [ans].</p>

    <label>Câu văn (chứa [ans])</label>
    <textarea id="fb_text" placeholder="Ví dụ: HTML là viết tắt của [ans] Markup Language."></textarea>

    <div class="section-title" style="margin-top:1rem">🏦 Ngân hàng từ</div>
    <div class="dyn-list" id="fb_words"></div>

    <div class="inline" style="margin-top:.75rem">
      <button class="btn-success" id="fb_addBtn"><span>➕ Thêm từ</span></button>
    </div>
  `;
}

function fb_row(index, data = { word: "", isAnswer: false }) {
  const key = `fb_${index}`;
  const hasImg = !!draftMedia[key];

  return `
    <div class="dyn-item" data-idx="${index}">
      <div class="left">
        <label style="text-transform:none;letter-spacing:0;opacity:.9">Từ ${index + 1}</label>
        <input type="text" class="fb_word" value="${escapeHtml(data.word || "")}" placeholder="Nhập từ...">
        <div id="thumb_${key}" class="thumbnail-preview" style="display:${hasImg ? "block" : "none"}"></div>

        <div class="inline" style="margin-top:.45rem">
          <div class="checkbox">
            <input type="checkbox" class="fb_ans" ${data.isAnswer ? "checked" : ""}>
            <span>Là đáp án</span>
          </div>

          <button class="media-btn" data-pick="${key}">🖼️ Ảnh</button>
          <input type="file" id="file_${key}" accept="image/*" style="display:none">
        </div>
      </div>

      <button class="trash" data-delrow="fb" title="Xóa">🗑️</button>
    </div>
  `;
}

function fb_init(defaultCount = 4) {
  const host = $("fb_words");
  host.innerHTML = "";
  for (let i = 0; i < defaultCount; i++) host.insertAdjacentHTML("beforeend", fb_row(i));

  $("fb_addBtn").addEventListener("click", fb_add);

  bindRowMediaPickers(host, "fb_", 900, 0.82);
  bindPasteOnInputs(host, ".fb_word", (i) => `fb_${i}`, 900, 0.82);
  bindDeleteRow(host, "fb", fb_rebuild);

  for (let i = 0; i < defaultCount; i++) renderThumbInline(`fb_${i}`);
}

function fb_add() {
  const host = $("fb_words");
  const idx = host.children.length;
  host.insertAdjacentHTML("beforeend", fb_row(idx));

  const row = host.lastElementChild;
  bindRowMediaPickers(row, "fb_", 900, 0.82);
  bindPasteOnInputs(row, ".fb_word", () => `fb_${idx}`, 900, 0.82);
  row.querySelector('[data-delrow="fb"]')?.addEventListener("click", () => {
    row.remove();
    fb_rebuild();
  });

  renderThumbInline(`fb_${idx}`);
}

function fb_rebuild() {
  const host = $("fb_words");
  const rows = [...host.querySelectorAll(".dyn-item")];

  const old = rows.map((row, i) => ({
    word: row.querySelector(".fb_word")?.value || "",
    isAnswer: !!row.querySelector(".fb_ans")?.checked,
    img: draftMedia[`fb_${i}`] || null
  }));

  Object.keys(draftMedia)
    .filter(k => k.startsWith("fb_"))
    .forEach(k => delete draftMedia[k]);

  host.innerHTML = "";
  old.forEach((d, i) => {
    host.insertAdjacentHTML("beforeend", fb_row(i, d));
    if (d.img) draftMedia[`fb_${i}`] = d.img;
  });

  $("fb_addBtn").addEventListener("click", fb_add);
  bindRowMediaPickers(host, "fb_", 900, 0.82);
  bindPasteOnInputs(host, ".fb_word", (i) => `fb_${i}`, 900, 0.82);
  bindDeleteRow(host, "fb", fb_rebuild);

  old.forEach((_, i) => renderThumbInline(`fb_${i}`));
}

/* =======================
   Generic row bindings
======================= */
function bindRowMediaPickers(scopeEl, prefix, maxW, quality) {
  const root = scopeEl instanceof Element ? scopeEl : document;
  const pickBtns = root.querySelectorAll("[data-pick]");
  pickBtns.forEach(btn => {
    const key = btn.getAttribute("data-pick");
    if (!key.startsWith(prefix)) return;

    btn.addEventListener("click", () => pickImageFor(key));

    const input = document.getElementById("file_" + key);
    if (input && !input._bound) {
      input._bound = true;
      input.addEventListener("change", async (e) => {
        await onPickFile(e, key, maxW, quality);
        renderThumbInline(key);
      });
    }
  });
}

function bindDeleteRow(host, typeKey, rebuildFn) {
  const delBtns = host.querySelectorAll(`[data-delrow="${typeKey}"]`);
  delBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".dyn-item");
      row?.remove();
      rebuildFn();
    });
  });
}

/* =======================
   Hotspot (SVG overlay)
======================= */
function renderHotspotEditor() {
  return `
    <div class="section-title">🎯 Hotspot (SVG Overlay)</div>
    <p class="hint">
      1) Chọn ảnh hotspot (hoặc paste Ctrl+V).<br>
      2) Chọn công cụ vẽ: Rect / Ellipse / Polygon.<br>
      3) Vẽ xong sẽ xuất hiện trong danh sách, tick “Là đáp án đúng” để tô viền xanh.
    </p>

    <div class="row">
      <div>
        <label>Ảnh hotspot</label>
        <div id="hotspotThumb" class="thumbnail-preview" style="display:none"></div>
      </div>

      <div class="media-tools">
        <button class="media-btn" id="btnPickHotspotImg">🖼️ Chọn ảnh</button>
        <input type="file" id="file_hotspotImage" accept="image/*" style="display:none">
      </div>
    </div>

    <div class="hotspot-wrap">
      <div class="hotspot-toolbar">
        <span class="hint">Công cụ:</span>
        <button class="pill active" id="tool_rect">⬛ Rect</button>
        <button class="pill" id="tool_ellipse">⚪ Ellipse</button>
        <button class="pill" id="tool_polygon">🔺 Polygon</button>
        <button class="pill" id="btnUndoPoint">↩️ Undo điểm</button>
        <button class="pill" id="btnFinishPoly">✅ Kết thúc Polygon</button>
        <button class="pill" id="btnClearRegions">🧹 Xóa vùng</button>
      </div>

      <div class="hotspot-stage" id="hotspotStage"></div>

      <div class="hotspot-hint">
        • Tọa độ được lưu theo <b>%</b> (0..100) so với ảnh → hiển thị đúng khi responsive.<br>
        • Polygon: click để thêm điểm, double click để kết thúc.
      </div>

      <div class="region-list" id="regionList"></div>
    </div>
  `;
}

function hs_init() {
  // bind pick/paste image
  $("btnPickHotspotImg").addEventListener("click", () => pickImageFor("hotspotImage"));
  $("file_hotspotImage").addEventListener("change", async (e) => {
    await onPickFile(e, "hotspotImage", 1600, 0.85);
    renderThumb("hotspotImage");
    draftRegions = [];
    polyPoints = [];
    drawing = null;
    renderHotspotStage();
    renderRegionList();
  });

  renderThumb("hotspotImage");
  setTool("rect");

  // bind tools
  $("tool_rect").addEventListener("click", () => setTool("rect"));
  $("tool_ellipse").addEventListener("click", () => setTool("ellipse"));
  $("tool_polygon").addEventListener("click", () => setTool("polygon"));

  $("btnUndoPoint").addEventListener("click", undoLastPoint);
  $("btnFinishPoly").addEventListener("click", finishPolygon);
  $("btnClearRegions").addEventListener("click", clearRegions);

  renderHotspotStage();
  renderRegionList();

  // paste ảnh vào stage (người dùng click vào stage rồi Ctrl+V)
  bindPasteForHotspotImage();
}

function setTool(tool) {
  currentTool = tool;
  ["rect", "ellipse", "polygon"].forEach(t => {
    const el = document.getElementById("tool_" + t);
    if (el) el.classList.toggle("active", t === tool);
  });
  drawing = null;
  polyPoints = [];
  renderHotspotStage();
}

function bindPasteForHotspotImage() {
  const stage = $("hotspotStage");
  if (!stage) return;

  stage.addEventListener("paste", async (ev) => {
    const items = ev.clipboardData?.items || [];
    const imgItem = [...items].find(it => it.type && it.type.startsWith("image/"));
    if (!imgItem) return;

    ev.preventDefault();
    const file = imgItem.getAsFile();
    const base64 = await fileToBase64(file);
    const resized = await resizeImage(base64, 1600, 0.85);

    draftMedia.hotspotImage = resized;
    renderThumb("hotspotImage");
    draftRegions = [];
    polyPoints = [];
    drawing = null;

    renderHotspotStage();
    renderRegionList();
    showToast("Đã dán ảnh", "Ảnh hotspot đã được nén & nạp vào khung vẽ.");
  });
}

function renderHotspotStage() {
  const stage = $("hotspotStage");
  if (!stage) return;

  const img64 = draftMedia.hotspotImage;
  if (!img64) {
    stage.innerHTML = `<div class="hint" style="padding:1rem">Chưa có ảnh hotspot. Hãy click khung này rồi Ctrl+V, hoặc chọn ảnh.</div>`;
    return;
  }

  stage.innerHTML = `
    <img id="hsImg" src="${img64}" alt="hotspot">
    <svg class="svg-container" id="hsSvg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
  `;

  const svg = $("hsSvg");

  // vẽ vùng đã có
  draftRegions.forEach(r => svg.appendChild(regionToSvg(r)));

  // vẽ tạm khi drag
  if (drawing?.el) svg.appendChild(drawing.el);

  // vẽ polyline tạm khi polygon
  if (currentTool === "polygon" && polyPoints.length) {
    svg.appendChild(polylineTemp(polyPoints));
  }

  // events
  svg.onmousedown = hsMouseDown;
  svg.onmousemove = hsMouseMove;
  svg.onmouseup = hsMouseUp;

  svg.onclick = (ev) => {
    if (currentTool !== "polygon") return;
    const p = svgPointPercent(ev, svg);
    polyPoints.push([p.x, p.y]);
    renderHotspotStage();
  };

  svg.ondblclick = (ev) => {
    if (currentTool === "polygon") {
      ev.preventDefault();
      finishPolygon();
    }
  };
}

function svgPointPercent(ev, svg) {
  const rect = svg.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 100;
  const y = ((ev.clientY - rect.top) / rect.height) * 100;
  return { x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
}

function hsMouseDown(ev) {
  if (currentTool === "polygon") return;

  const svg = ev.currentTarget;
  const p = svgPointPercent(ev, svg);

  if (currentTool === "rect") {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("x", p.x);
    el.setAttribute("y", p.y);
    el.setAttribute("width", 0.01);
    el.setAttribute("height", 0.01);
    styleSvgShape(el, false, true);
    drawing = { type: "rect", startX: p.x, startY: p.y, el };
  }

  if (currentTool === "ellipse") {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    el.setAttribute("cx", p.x);
    el.setAttribute("cy", p.y);
    el.setAttribute("rx", 0.01);
    el.setAttribute("ry", 0.01);
    styleSvgShape(el, false, true);
    drawing = { type: "ellipse", startX: p.x, startY: p.y, el };
  }

  renderHotspotStage();
}

function hsMouseMove(ev) {
  if (!drawing) return;
  const svg = ev.currentTarget;
  const p = svgPointPercent(ev, svg);

  if (drawing.type === "rect") {
    const x = Math.min(drawing.startX, p.x);
    const y = Math.min(drawing.startY, p.y);
    const w = Math.abs(p.x - drawing.startX);
    const h = Math.abs(p.y - drawing.startY);

    drawing.el.setAttribute("x", x);
    drawing.el.setAttribute("y", y);
    drawing.el.setAttribute("width", Math.max(0.2, w));
    drawing.el.setAttribute("height", Math.max(0.2, h));
  }

  if (drawing.type === "ellipse") {
    const cx = (drawing.startX + p.x) / 2;
    const cy = (drawing.startY + p.y) / 2;
    const rx = Math.abs(p.x - drawing.startX) / 2;
    const ry = Math.abs(p.y - drawing.startY) / 2;

    drawing.el.setAttribute("cx", cx);
    drawing.el.setAttribute("cy", cy);
    drawing.el.setAttribute("rx", Math.max(0.2, rx));
    drawing.el.setAttribute("ry", Math.max(0.2, ry));
  }
}

function hsMouseUp() {
  if (!drawing) return;

  const r = shapeFromDrawing(drawing);
  drawing = null;

  const label = prompt("Nhập tên vùng (label):", r.label || "");
  r.label = (label || "").trim() || `Vùng ${draftRegions.length + 1}`;

  draftRegions.push(r);
  renderHotspotStage();
  renderRegionList();
}

function shapeFromDrawing(d) {
  if (d.type === "rect") {
    const x = parseFloat(d.el.getAttribute("x"));
    const y = parseFloat(d.el.getAttribute("y"));
    const w = parseFloat(d.el.getAttribute("width"));
    const h = parseFloat(d.el.getAttribute("height"));
    return { id: uid(), type: "rect", x, y, w, h, isCorrect: false, label: "" };
  }
  if (d.type === "ellipse") {
    const cx = parseFloat(d.el.getAttribute("cx"));
    const cy = parseFloat(d.el.getAttribute("cy"));
    const rx = parseFloat(d.el.getAttribute("rx"));
    const ry = parseFloat(d.el.getAttribute("ry"));
    return { id: uid(), type: "ellipse", cx, cy, rx, ry, isCorrect: false, label: "" };
  }
}

function polylineTemp(points) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  el.setAttribute("points", points.map(p => `${p[0]},${p[1]}`).join(" "));
  el.setAttribute("fill", "rgba(255,255,255,0.05)");
  el.setAttribute("stroke", "rgba(253,200,48,0.95)");
  el.setAttribute("stroke-width", "0.6");
  el.setAttribute("stroke-dasharray", "1.2 1.2");
  return el;
}

function undoLastPoint() {
  if (currentTool !== "polygon") return;
  polyPoints.pop();
  renderHotspotStage();
}

function finishPolygon() {
  if (currentTool !== "polygon") return;
  if (polyPoints.length < 3) {
    showToast("Chưa đủ điểm", "Polygon cần ít nhất 3 điểm.");
    return;
  }

  const label = prompt("Nhập tên vùng (label):", `Vùng ${draftRegions.length + 1}`);
  const region = {
    id: uid(),
    type: "polygon",
    points: polyPoints.map(p => [round2(p[0]), round2(p[1])]),
    isCorrect: false,
    label: (label || "").trim() || `Vùng ${draftRegions.length + 1}`,
  };

  draftRegions.push(region);
  polyPoints = [];
  renderHotspotStage();
  renderRegionList();
}

function clearRegions() {
  if (!draftRegions.length) return;
  if (!confirm("Xóa tất cả vùng hotspot?")) return;
  draftRegions = [];
  polyPoints = [];
  drawing = null;
  renderHotspotStage();
  renderRegionList();
}

function styleSvgShape(el, isCorrect, isTemp) {
  const stroke = isCorrect ? "rgba(6,214,160,0.98)" : "rgba(255,107,53,0.95)";
  const fill = isTemp ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.06)";
  el.setAttribute("fill", fill);
  el.setAttribute("stroke", stroke);
  el.setAttribute("stroke-width", "0.7");
}

function regionToSvg(r) {
  const ns = "http://www.w3.org/2000/svg";
  let el;

  if (r.type === "rect") {
    el = document.createElementNS(ns, "rect");
    el.setAttribute("x", r.x);
    el.setAttribute("y", r.y);
    el.setAttribute("width", r.w);
    el.setAttribute("height", r.h);
  } else if (r.type === "ellipse") {
    el = document.createElementNS(ns, "ellipse");
    el.setAttribute("cx", r.cx);
    el.setAttribute("cy", r.cy);
    el.setAttribute("rx", r.rx);
    el.setAttribute("ry", r.ry);
  } else {
    el = document.createElementNS(ns, "polygon");
    el.setAttribute("points", (r.points || []).map(p => `${p[0]},${p[1]}`).join(" "));
  }

  styleSvgShape(el, !!r.isCorrect, false);
  el.setAttribute("data-id", r.id);
  el.style.cursor = "pointer";

  // Tip: Alt+Click toggles correct
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (ev.altKey) {
      const rr = draftRegions.find(x => x.id === r.id);
      if (!rr) return;
      rr.isCorrect = !rr.isCorrect;
      renderHotspotStage();
      renderRegionList();
    }
  });

  return el;
}

function renderRegionList() {
  const host = $("regionList");
  if (!host) return;

  if (!draftRegions.length) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = `
    <div class="section-title" style="margin-top:1.25rem">📍 Danh sách vùng</div>
    ${draftRegions.map((r, i) => regionRowHtml(r, i)).join("")}
    <p class="hint" style="margin-top:.6rem">Tip: <b>Alt + Click</b> lên vùng để bật/tắt “Đáp án đúng”.</p>
  `;

  // bind row actions
  draftRegions.forEach((r) => {
    host.querySelector(`[data-rlabel="${r.id}"]`)?.addEventListener("input", (ev) => {
      r.label = ev.target.value;
    });
    host.querySelector(`[data-rcorrect="${r.id}"]`)?.addEventListener("change", (ev) => {
      r.isCorrect = !!ev.target.checked;
      renderHotspotStage();
    });
    host.querySelector(`[data-rdel="${r.id}"]`)?.addEventListener("click", () => {
      draftRegions = draftRegions.filter(x => x.id !== r.id);
      renderHotspotStage();
      renderRegionList();
    });
  });
}

function regionRowHtml(r, i) {
  const checked = r.isCorrect ? "checked" : "";
  return `
    <div class="region-row">
      <div class="region-badge">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <input type="text" value="${escapeHtml(r.label || "")}" data-rlabel="${r.id}" placeholder="Nhãn vùng">
        <div class="hint" style="margin-top:.35rem">${regionCoordsText(r)}</div>
      </div>
      <div class="checkbox" title="Là đáp án đúng">
        <input type="checkbox" ${checked} data-rcorrect="${r.id}">
        <span>Đúng</span>
      </div>
      <button class="trash" data-rdel="${r.id}" title="Xóa">🗑️</button>
    </div>
  `;
}

function regionCoordsText(r) {
  if (r.type === "rect") return `Rect: x=${round2(r.x)}% y=${round2(r.y)}% w=${round2(r.w)}% h=${round2(r.h)}%`;
  if (r.type === "ellipse") return `Ellipse: cx=${round2(r.cx)}% cy=${round2(r.cy)}% rx=${round2(r.rx)}% ry=${round2(r.ry)}%`;
  const pts = (r.points || []).slice(0, 6).map(p => `(${round2(p[0])},${round2(p[1])})`).join(" ");
  return `Polygon: ${(r.points || []).length} điểm  ${pts}${(r.points || []).length > 6 ? " ..." : ""}`;
}

function normalizeRegion(r) {
  const out = { ...r };
  if (out.type === "rect") {
    out.x = round2(out.x); out.y = round2(out.y); out.w = round2(out.w); out.h = round2(out.h);
  }
  if (out.type === "ellipse") {
    out.cx = round2(out.cx); out.cy = round2(out.cy); out.rx = round2(out.rx); out.ry = round2(out.ry);
  }
  if (out.type === "polygon") {
    out.points = (out.points || []).map(p => [round2(p[0]), round2(p[1])]);
  }
  return out;
}

/* =======================
   Load type data (edit)
======================= */
function loadTypeData(q) {
  if (q.type === "multiple-choice") {
    mc_init(Math.max(2, q.options?.length || 4));
    $("mc_multi").checked = !!q.multipleAnswers;

    const rows = document.querySelectorAll("#mc_list .dyn-item");
    (q.options || []).forEach((opt, i) => {
      const row = rows[i];
      if (!row) return;

      row.querySelector(".mc_text").value = opt.text ?? opt ?? "";
      row.querySelector(".mc_correct").checked = q.correctAnswers?.includes(i) || !!opt.isCorrect;
      if (opt.image) draftMedia[`mc_opt_${i}`] = opt.image;
      renderThumbInline(`mc_opt_${i}`);
    });
  }

  if (q.type === "multiple-choice-grid") {
    // columns
    const cols = Array.isArray(q.gridColumns) ? q.gridColumns : (Array.isArray(q.columns) ? q.columns : ["A","B","C","D"]);
    const rowsData = Array.isArray(q.gridRows) ? q.gridRows : (Array.isArray(q.rows) ? q.rows : []);

    mcg_init(Math.max(2, cols.length || 4), Math.max(2, rowsData.length || 2));
    $("mcg_cols").value = (cols && cols.length) ? cols.join("\n") : "A\nB\nC\nD";

    const rows = document.querySelectorAll("#mcg_rows .dyn-item");
    rowsData.forEach((r, i) => {
      const row = rows[i];
      if (!row) return;
      row.querySelector(".mcg_text").value = r.text || "";
      const c = Number.isFinite(+r.correct) ? (+r.correct + 1) : (Number.isFinite(+r.correctIndex) ? (+r.correctIndex + 1) : 1);
      row.querySelector(".mcg_correct").value = Math.max(1, c);
    });
  }

  if (q.type === "true-false-grid") {
    tf_init(Math.max(2, q.statements?.length || 2));
    const rows = document.querySelectorAll("#tf_list .dyn-item");
    (q.statements || []).forEach((st, i) => {
      const row = rows[i];
      if (!row) return;

      row.querySelector(".tf_text").value = st.text || "";
      row.querySelector(".tf_correct").value = (st.correct ? "true" : "false");
      if (st.image) draftMedia[`tf_stmt_${i}`] = st.image;
      renderThumbInline(`tf_stmt_${i}`);
    });
  }

  if (q.type === "matching") {
    mt_init(Math.max(2, q.pairs?.length || 2));
    const rows = document.querySelectorAll("#mt_list .dyn-item");
    (q.pairs || []).forEach((p, i) => {
      const row = rows[i];
      if (!row) return;

      row.querySelector(".mt_left").value = p.left || "";
      row.querySelector(".mt_right").value = p.right || "";
      if (p.leftImage) draftMedia[`mt_l_${i}`] = p.leftImage;
      if (p.rightImage) draftMedia[`mt_r_${i}`] = p.rightImage;
      renderThumbInline(`mt_l_${i}`);
      renderThumbInline(`mt_r_${i}`);
    });
  }

  if (q.type === "ordering") {
    or_init(Math.max(2, q.items?.length || 2));
    const rows = document.querySelectorAll("#or_list .dyn-item");
    (q.items || []).forEach((it, i) => {
      const row = rows[i];
      if (!row) return;

      row.querySelector(".or_text").value = it.text ?? it ?? "";
      if (it.image) draftMedia[`or_${i}`] = it.image;
      renderThumbInline(`or_${i}`);
    });
  }

  if (q.type === "fill-blanks") {
    $("fb_text").value = q.text || "";
    fb_init(Math.max(2, q.words?.length || 4));

    const rows = document.querySelectorAll("#fb_words .dyn-item");
    (q.words || []).forEach((w, i) => {
      const row = rows[i];
      if (!row) return;

      const word = typeof w === "string" ? w : (w.word || "");
      row.querySelector(".fb_word").value = word;

      const isAns = q.blanks?.includes(word) || !!w.isAnswer;
      row.querySelector(".fb_ans").checked = isAns;

      if (w.image) draftMedia[`fb_${i}`] = w.image;
      renderThumbInline(`fb_${i}`);
    });
  }

  if (q.type === "hotspot") {
    if (q.media?.hotspotImage) draftMedia.hotspotImage = q.media.hotspotImage;
    renderThumb("hotspotImage");

    draftRegions = safeJsonParse(JSON.stringify(q.hotspotRegions || []), []);
    setTool("rect");
    renderHotspotStage();
    renderRegionList();
  }
}

/* =======================
   Save question (collect)
======================= */
function saveQuestion() {
  const type = $("questionType").value;
  const questionText = $("questionText").value.trim();
  if (!questionText) return alert("⚠️ Vui lòng nhập câu hỏi!");

  const exportFlag = $("exportFlag").checked;

  const base = {
    id: currentEditId || uid(),
    type,
    question: questionText,
    exportFlag,
    media: {},
    updatedAt: new Date().toISOString(),
  };

  if (draftMedia.question) base.media.question = draftMedia.question;

  let payload = base;

  try {
    if (type === "multiple-choice") payload = { ...base, ...collectMC() };
    if (type === "multiple-choice-grid") payload = { ...base, ...collectMCG() };
    if (type === "true-false-grid") payload = { ...base, ...collectTF() };
    if (type === "matching") payload = { ...base, ...collectMT() };
    if (type === "ordering") payload = { ...base, ...collectOR() };
    if (type === "fill-blanks") payload = { ...base, ...collectFB() };
    if (type === "hotspot") payload = { ...base, ...collectHS() };
  } catch (e) {
    alert("❌ " + e.message);
    return;
  }

  const idx = questions.findIndex(q => q.id === payload.id);
  if (idx >= 0) questions[idx] = payload;
  else questions.push(payload);

  currentEditId = payload.id;
  saveToLocalStorage(true);
  renderList();
  showToast("Thành công", idx >= 0 ? "Đã cập nhật câu hỏi." : "Đã thêm câu hỏi mới.");
}

function collectMC() {
  const multi = $("mc_multi").checked;
  const rows = [...document.querySelectorAll("#mc_list .dyn-item")];

  const options = [];
  const correctAnswers = [];

  rows.forEach((row, i) => {
    const text = row.querySelector(".mc_text")?.value.trim() || "";
    if (!text) return;

    const isCorrect = !!row.querySelector(".mc_correct")?.checked;
    const key = `mc_opt_${i}`;

    options.push({ text, image: draftMedia[key] || null, isCorrect });
    if (isCorrect) correctAnswers.push(options.length - 1);
  });

  if (options.length < 2) throw new Error("Cần ít nhất 2 lựa chọn.");
  if (!correctAnswers.length) throw new Error("Cần ít nhất 1 đáp án đúng.");

  return { multipleAnswers: multi, options, correctAnswers };
}

function collectMCG(){
  const colsRaw = ($("mcg_cols")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
  const gridColumns = colsRaw.length ? colsRaw : ["A","B","C","D"];

  const rows = [...document.querySelectorAll("#mcg_rows .dyn-item")];
  const gridRows = [];

  rows.forEach((row) => {
    const text = row.querySelector(".mcg_text")?.value.trim() || "";
    if (!text) return;
    const correct1 = Number(row.querySelector(".mcg_correct")?.value || 1);
    const correct = Math.max(0, Math.min(gridColumns.length - 1, correct1 - 1));
    gridRows.push({ text, correct });
  });

  if (gridColumns.length < 2) throw new Error("Cần ít nhất 2 cột đáp án.");
  if (gridRows.length < 2) throw new Error("Cần ít nhất 2 dòng trong lưới.");

  return { gridColumns, gridRows };
}

function collectTF() {
  const rows = [...document.querySelectorAll("#tf_list .dyn-item")];
  const statements = [];

  rows.forEach((row, i) => {
    const text = row.querySelector(".tf_text")?.value.trim() || "";
    if (!text) return;

    const correct = (row.querySelector(".tf_correct")?.value || "true") === "true";
    const key = `tf_stmt_${i}`;
    statements.push({ text, correct, image: draftMedia[key] || null });
  });

  if (statements.length < 2) throw new Error("Cần ít nhất 2 mệnh đề.");
  return { statements };
}

function collectMT() {
  const rows = [...document.querySelectorAll("#mt_list .dyn-item")];
  const pairs = [];

  rows.forEach((row, i) => {
    const left = row.querySelector(".mt_left")?.value.trim() || "";
    const right = row.querySelector(".mt_right")?.value.trim() || "";
    if (!left || !right) return;

    pairs.push({
      left, right,
      leftImage: draftMedia[`mt_l_${i}`] || null,
      rightImage: draftMedia[`mt_r_${i}`] || null
    });
  });

  if (pairs.length < 2) throw new Error("Cần ít nhất 2 cặp ghép nối.");
  return { pairs };
}

function collectOR() {
  const rows = [...document.querySelectorAll("#or_list .dyn-item")];
  const items = [];

  rows.forEach((row, i) => {
    const text = row.querySelector(".or_text")?.value.trim() || "";
    if (!text) return;
    items.push({ text, image: draftMedia[`or_${i}`] || null });
  });

  if (items.length < 2) throw new Error("Cần ít nhất 2 mục để sắp xếp.");
  return { items, correctOrder: items.map((_, i) => i) };
}

function collectFB() {
  const text = $("fb_text").value.trim();
  if (!text) throw new Error("Vui lòng nhập câu văn điền khuyết.");

  const blankCount = (text.match(/\[ans\]/g) || []).length;
  if (!blankCount) throw new Error("Câu văn cần có ít nhất 1 [ans].");

  const rows = [...document.querySelectorAll("#fb_words .dyn-item")];
  const words = [];
  const blanks = [];

  rows.forEach((row, i) => {
    const word = row.querySelector(".fb_word")?.value.trim() || "";
    if (!word) return;

    const isAnswer = !!row.querySelector(".fb_ans")?.checked;
    const image = draftMedia[`fb_${i}`] || null;

    words.push({ word, isAnswer, image });
    if (isAnswer) blanks.push(word);
  });

  if (words.length < blankCount) throw new Error("Ngân hàng từ chưa đủ.");
  if (blanks.length !== blankCount) throw new Error(`Số từ đáp án (${blanks.length}) phải bằng số [ans] (${blankCount}).`);

  return { text, blanks, words };
}

function collectHS() {
  if (!draftMedia.hotspotImage) throw new Error("Vui lòng chọn ảnh hotspot.");
  if (!draftRegions.length) throw new Error("Vui lòng vẽ ít nhất 1 vùng.");

  const anyCorrect = draftRegions.some(r => r.isCorrect);
  if (!anyCorrect) {
    if (!confirm("Bạn chưa chọn vùng nào là đáp án đúng. Vẫn lưu chứ?")) {
      throw new Error("Hãy chọn ít nhất 1 vùng đúng hoặc xác nhận lưu.");
    }
  }

  // hotspotImage nằm trong media để game dùng
  const media = { ...draftMedia };
  return {
    media,
    hotspotRegions: draftRegions.map(normalizeRegion),
  };
}

/* =======================
   JSON import/export
======================= */
function exportJSON() {
  if (!questions.length) return alert("⚠️ Chưa có dữ liệu để xuất.");

  const dataStr = JSON.stringify(questions, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `quiz-questions-${Date.now()}.json`;
  a.click();

  URL.revokeObjectURL(url);
  showToast("Xuất JSON", "Đã tải xuống file JSON.");
}

function loadJSONFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const data = safeJsonParse(reader.result, null);
    if (!Array.isArray(data)) return alert("❌ JSON không hợp lệ (cần mảng câu hỏi).");

    questions = data.map(q => ({
      exportFlag: q.exportFlag !== false,
      ...q,
      id: q.id || uid()
    }));

    saveToLocalStorage(true);
    renderList();
    createNewQuestion();
    showToast("Đã nhập JSON", `Đã nạp <b>${questions.length}</b> câu hỏi.`);
  };

  reader.readAsText(file, "utf-8");
  ev.target.value = "";
}

/* =======================
   Sample data
======================= */
function loadSampleData() {
  const sample = [
    {
      id: uid(),
      type: "multiple-choice",
      question: "Thủ đô của Việt Nam là gì?",
      exportFlag: true,
      multipleAnswers: false,
      options: [
        { text: "Hà Nội", isCorrect: true },
        { text: "Hồ Chí Minh", isCorrect: false },
        { text: "Đà Nẵng", isCorrect: false },
        { text: "Huế", isCorrect: false },
      ],
      correctAnswers: [0],
      media: {},
      updatedAt: new Date().toISOString()
    },
    {
      id: uid(),
      type: "true-false-grid",
      question: "Đánh giá các mệnh đề sau đúng hay sai:",
      exportFlag: true,
      statements: [
        { text: "HTML là ngôn ngữ đánh dấu", correct: true },
        { text: "CSS dùng để tạo cơ sở dữ liệu", correct: false },
        { text: "JavaScript chạy trên trình duyệt", correct: true },
      ],
      media: {},
      updatedAt: new Date().toISOString()
    },
    {
      id: uid(),
      type: "matching",
      question: "Nối các khái niệm với định nghĩa tương ứng:",
      exportFlag: true,
      pairs: [
        { left: "HTML", right: "Ngôn ngữ đánh dấu" },
        { left: "CSS", right: "Định dạng giao diện" },
        { left: "JavaScript", right: "Lập trình tương tác" },
      ],
      media: {},
      updatedAt: new Date().toISOString()
    },
    {
      id: uid(),
      type: "ordering",
      question: "Sắp xếp các bước phát triển web theo thứ tự:",
      exportFlag: true,
      items: [
        { text: "Thiết kế giao diện" },
        { text: "Viết HTML/CSS" },
        { text: "Thêm JavaScript" },
        { text: "Kiểm thử" },
        { text: "Triển khai" },
      ],
      correctOrder: [0, 1, 2, 3, 4],
      media: {},
      updatedAt: new Date().toISOString()
    },
    {
      id: uid(),
      type: "fill-blanks",
      question: "Điền từ vào chỗ trống:",
      exportFlag: true,
      text: "HTML là viết tắt của [ans] Markup Language. CSS dùng để tạo [ans] cho trang web.",
      blanks: ["HyperText", "giao diện"],
      words: [
        { word: "HyperText", isAnswer: true },
        { word: "giao diện", isAnswer: true },
        { word: "database", isAnswer: false },
        { word: "server", isAnswer: false },
      ],
      media: {},
      updatedAt: new Date().toISOString()
    },
  ];

  if (questions.length && !confirm("Dữ liệu hiện tại sẽ bị thay thế. Tiếp tục?")) return;
  questions = sample;
  saveToLocalStorage(true);
  renderList();
  createNewQuestion();
  showToast("Đã tải mẫu", `Có <b>${questions.length}</b> câu hỏi mẫu.`);
}

/* =======================
   Export Standalone Game
======================= */
/**
 * exportStandaloneGame()
 * - Lọc câu hỏi có exportFlag = true
 * - Cho user chọn mode: thi / luyentap
 * - Bơm config vào template quiz-game.html qua placeholder {{QUIZ_CONFIG_JSON}}
 * - Tạo Blob để tải file HTML độc lập
 */
async function exportStandaloneGame() {
  // 1) Lọc câu hỏi được tick Export
  const selectedQuestions = questions.filter(q => q.exportFlag !== false);

  if (!selectedQuestions.length) {
    alert("Không có câu hỏi nào được chọn Export.");
    return;
  }

  // 2) Hỏi mode (thi / luyentap)
  let mode = prompt("Chọn mode: thi / luyentap", "luyentap");
  if (mode === null) return;

  mode = mode.trim().toLowerCase();
  if (mode !== "thi" && mode !== "luyentap") {
    alert("Mode không hợp lệ. Chỉ nhập: thi hoặc luyentap");
    return;
  }

  // 3) Nếu mode thi -> hỏi thời gian
  let timerSeconds = 0;
  if (mode === "thi") {
    let mins = prompt("Nhập thời gian (phút). Ví dụ: 10", "10");
    if (mins === null) return;

    mins = Number(mins);
    if (!mins || mins < 1) {
      alert("Thời gian không hợp lệ. Phải >= 1 phút.");
      return;
    }

    timerSeconds = mins * 60;
  }

  // 4) Tạo config
  // lấy meta mới nhất (để khỏi phụ thuộc debounce)
  const className = ($("metaClass")?.value || meta.className || "").trim();
  const namesText = ($("metaNames")?.value || meta.namesText || "");
  const apiUrl = ($("googleApiUrl")?.value || meta.apiUrl || "").trim();

  // parse danh sách tên (mỗi dòng 1 tên)
  const studentNames = namesText
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const config = {
    mode,
    shuffleQuestions: (mode === "thi"),
    shuffleAnswers: true,
    timerSeconds,
    questions: selectedQuestions,
    className,
    studentNames,
    apiUrl
  };

  // 5) Lấy template quiz-game.html
  // - Nếu bạn đã nhúng template vào biến string thì dùng biến đó
  // - Nếu không, fetch file quiz-game.html (cần chạy bằng Live Server)
  let template = "";
  try {
    const res = await fetch("quiz-game.html");
    template = await res.text();
  } catch (err) {
    console.error(err);
    alert("Không fetch được quiz-game.html. Hãy chạy bằng Live Server.");
    return;
  }

  // 6) Replace placeholder
  if (!template.includes("{{QUIZ_CONFIG_JSON}}")) {
    alert("quiz-game.html không có placeholder {{QUIZ_CONFIG_JSON}}");
    return;
  }

  const finalHtml = template.replace("{{QUIZ_CONFIG_JSON}}", JSON.stringify(config));

  // 7) Tạo file download
  const blob = new Blob([finalHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "quiz-game-standalone.html";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast("Xuất Game", "Đã tải xuống quiz-game-standalone.html");
}

function sanitizeForExport(q) {
  // Chuẩn hoá dữ liệu để game tiêu thụ
  const out = {
    id: q.id,
    type: q.type,
    question: q.question,
  };

  // ảnh câu hỏi (nếu có)
  if (q.media?.question) out.image = q.media.question;

  if (q.type === "multiple-choice") {
    out.multipleAnswers = !!q.multipleAnswers;
    out.options = (q.options || []).map((o, i) => ({
      text: (o.text ?? o) || "",
      image: o.image || null,
      isCorrect: q.correctAnswers?.includes(i) || !!o.isCorrect
    }));
    out.correctAnswers = out.options
      .map((o, i) => o.isCorrect ? i : -1)
      .filter(i => i >= 0);
  }

  if (q.type === "true-false-grid") {
    out.statements = (q.statements || []).map(s => ({
      text: s.text,
      correct: !!s.correct,
      image: s.image || null
    }));
  }

  if (q.type === "matching") {
    out.pairs = (q.pairs || []).map(p => ({
      left: p.left,
      right: p.right,
      leftImage: p.leftImage || null,
      rightImage: p.rightImage || null
    }));
  }

  if (q.type === "ordering") {
    out.items = (q.items || []).map(it => (typeof it === "string" ? { text: it } : it));
    out.correctOrder = out.items.map((_, i) => i);
  }

  if (q.type === "fill-blanks") {
    out.text = q.text;
    out.blanks = q.blanks;
    out.words = (q.words || []).map(w => (typeof w === "string" ? { word: w } : w));
  }

  if (q.type === "hotspot") {
    out.hotspotImage = q.media?.hotspotImage || null;
    out.hotspotRegions = (q.hotspotRegions || []).map(normalizeRegion);
  }

  return out;
}


/* =======================
   Sidebar Tabs
======================= */
document.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll(".tab-btn");
  const tabs = document.querySelectorAll(".tab-content");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {

      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      tabs.forEach(t => t.classList.remove("active"));
      const id = btn.getAttribute("data-tab");
      document.getElementById(id)?.classList.add("active");

    });
  });
});
