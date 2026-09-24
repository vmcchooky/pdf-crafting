/**
 * PDF Craft - Interactive Drag & Drop Web Application
 * Powered by PDF.js (rendering) and pdf-lib (client-side assembly).
 */

// Configure PDF.js worker (sử dụng worker nội bộ offline)
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

// Nạp lười (Lazy Load) thư viện nặng pdf-lib khi cần xuất file hoặc ký tên
let pdfLibPromise = null;
function ensurePdfLibLoaded() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/pdf-lib.min.js';
    script.onload = () => resolve(window.PDFLib);
    script.onerror = (e) => {
      pdfLibPromise = null;
      reject(new Error('Không thể tải thư viện pdf-lib: ' + e));
    };
    document.head.appendChild(script);
  });
  return pdfLibPromise;
}

// Nạp lười font nghệ thuật Google Fonts chỉ khi mở Studio Ký tên / Con dấu
let cursiveFontsLoaded = false;
function ensureCursiveFontsLoaded() {
  if (cursiveFontsLoaded) return;
  cursiveFontsLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Alex+Brush&family=Caveat:wght@600;700&family=Dancing+Script:wght@600;700&family=Great+Vibes&family=Montserrat:wght@600;700;800&family=Pacifico&display=swap';
  document.head.appendChild(link);
}

// escapeHtml, LRUCache: dùng chung từ utils.js (nạp trước app.js).
// (Xem web/utils.js - cũng được test tự động bằng Node.)

// Group Colors Palette
const GROUP_COLORS = [
  '#6366f1', // Indigo
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#06b6d4', // Cyan
  '#8b5cf6', // Purple
  '#f97316', // Orange
  '#14b8a6', // Teal
];
let selectedGroupColor = GROUP_COLORS[0];
let targetSinglePageForAssign = null; // Used when assigning group from a card directly

// Global Application State
const state = {
  sources: new Map(), // sourceId -> { name, bytes, pdfLibDoc, pdfJsDoc, fileSize }
  pages: [],          // [{ id, sourceId, pageIndex, title, rotation, width, height, isSelected, groupIds: [] }]
  groups: [],         // [{ id, name, color }]
  activeGroupFilter: null, // null = all, or groupId
  draggedIndex: null,
  currentModalIndex: null,
  docMeta: { title: '', author: '', subject: '', keywords: '', creator: '' }, // metadata ghi đè khi xuất file (trống = giữ gốc)
};

let nextId = 1;
// Thứ tự gốc khi nạp trang — dùng cho nút "Thứ tự gốc" (khôi phục)
let nextOriginalIndex = 1;

// Undo / Redo History Stacks (tối đa 20 trạng thái gần nhất mỗi chiều)
const historyStack = [];
const redoStack = [];
const MAX_HISTORY = 20;
let lastSelectedPageIndex = null;

// Thumbnail image render cache (ImageBitmap / Canvas) sử dụng Bounded LRU Cache để giới hạn VRAM và tự thu hồi bitmap.close()
// key: `${pageId}_${rotation}` -> { bitmap, canvas, width, height }
const thumbnailCache = new LRUCache(48);

// Concurrency queue for background thumbnail rendering
const thumbnailRenderQueue = [];
let activeThumbnailRenders = 0;
const MAX_CONCURRENT_THUMBNAILS = 2;
let isUserInteracting = false;
let userInteractionTimeout = null;

// Tạm hoãn hàng đợi thumbnail khi người dùng đang cuộn trang nhanh để giữ 60-120 FPS
window.addEventListener('scroll', () => {
  isUserInteracting = true;
  clearTimeout(userInteractionTimeout);
  userInteractionTimeout = setTimeout(() => {
    isUserInteracting = false;
    processThumbnailQueue();
  }, 120);
}, { passive: true });

// IntersectionObserver theo dõi 2 chiều: Render lười khi vào khung nhìn & Thu hồi bộ nhớ Canvas khi ra xa
const thumbnailObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const card = entry.target.closest('.page-card');
    if (!card || !card.dataset.pageId) return;
    const pageItem = state.pages.find(p => p.id === card.dataset.pageId);
    const canvas = card.querySelector('.card-thumbnail-wrapper canvas');
    if (!pageItem || !canvas) return;

    if (entry.isIntersecting) {
      // 1. Thẻ tiến vào khung nhìn (hoặc vùng đệm 500px):
      const isActuallyVisible = entry.intersectionRatio > 0;
      if (!card.dataset.thumbRendered) {
        enqueueThumbnailRender(pageItem, canvas, card, isActuallyVisible);
      } else if (canvas.width === 0) {
        // Đã từng render nhưng vừa được thu hồi bộ nhớ khi ở xa -> vẽ lại siêu tốc (<0.5ms) từ LRU Cache
        const cacheKey = `${pageItem.id}_${pageItem.rotation}`;
        if (thumbnailCache.has(cacheKey)) {
          const cached = thumbnailCache.get(cacheKey);
          canvas.width = cached.width;
          canvas.height = cached.height;
          const ctx = canvas.getContext('2d');
          if (cached.bitmap) {
            ctx.drawImage(cached.bitmap, 0, 0);
          } else if (cached.canvas) {
            ctx.drawImage(cached.canvas, 0, 0);
          }
          if (pageItem.stamps && pageItem.stamps.length > 0) {
            drawStampsOnCanvas(ctx, pageItem.stamps, canvas.width, canvas.height);
          }
          canvas.style.opacity = '1';
          const skel = card.querySelector('.card-thumbnail-skeleton');
          if (skel) skel.style.display = 'none';
        } else {
          // Bị giải phóng khỏi LRU Cache -> nạp lại bình thường
          delete card.dataset.thumbRendered;
          enqueueThumbnailRender(pageItem, canvas, card, isActuallyVisible);
        }
      }
    } else {
      // 2. Thẻ đã cuộn ra xa khỏi khung nhìn (> 500px):
      // Thu hồi ngay lập tức bộ đệm pixel buffer của Canvas khỏi GPU Process của Chrome/Edge
      if (card.dataset.thumbRendered && canvas.width > 0) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.opacity = '0';
        const skel = card.querySelector('.card-thumbnail-skeleton');
        if (skel) skel.style.display = 'flex';
      }
      // HỦY TÁC VỤ ĐANG XẾP HÀNG CHỜ RENDER NẾU ĐÃ CUỘN RA XA:
      // Không tốn CPU/GPU decode các trang người dùng đã cuộn qua!
      const qIdx = thumbnailRenderQueue.findIndex(t => t.card === card);
      if (qIdx !== -1) {
        thumbnailRenderQueue.splice(qIdx, 1);
      }
    }
  });
}, { rootMargin: '500px 0px 500px 0px' });

// High-resolution preview LRU cache (capped at 12 pages for instant zero-reload browsing with low RAM)
const previewCache = new LRUCache(12);
let currentModalRenderIndex = null;

// DOM Elements
const uploadContainer = document.getElementById('uploadContainer');
const workspaceContainer = document.getElementById('workspaceContainer');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const insertFileInput = document.getElementById('insertFileInput');
const pagesGrid = document.getElementById('pagesGrid');

// Header elements
const docStats = document.getElementById('docStats');
const statPageCount = document.getElementById('statPageCount');
const statFileSize = document.getElementById('statFileSize');
const btnUploadNew = document.getElementById('btnUploadNew');
const btnExportPdf = document.getElementById('btnExportPdf');
const btnOpenCompressModal = document.getElementById('btnOpenCompressModal');

// Toolbar elements
const btnSelectAll = document.getElementById('btnSelectAll');
const chkSelectAll = document.getElementById('chkSelectAll');
const txtSelectCount = document.getElementById('txtSelectCount');
const btnDeleteSelected = document.getElementById('btnDeleteSelected');
const btnExtractSelected = document.getElementById('btnExtractSelected');
const btnRotateSelected = document.getElementById('btnRotateSelected');
const btnReverseOrder = document.getElementById('btnReverseOrder');
const btnMoveStart = document.getElementById('btnMoveStart');
const btnMoveLeft = document.getElementById('btnMoveLeft');
const btnMoveRight = document.getElementById('btnMoveRight');
const btnMoveEnd = document.getElementById('btnMoveEnd');
const btnMoveToPos = document.getElementById('btnMoveToPos');
const btnRestoreOrder = document.getElementById('btnRestoreOrder');
const btnUndo = document.getElementById('btnUndo');
const btnRedo = document.getElementById('btnRedo');
const btnSplitAll = document.getElementById('btnSplitAll');
const btnExportGroups = document.getElementById('btnExportGroups');

// Grid sizing buttons
const btnViewCompact = document.getElementById('btnViewCompact');
const btnViewStandard = document.getElementById('btnViewStandard');
const btnViewLarge = document.getElementById('btnViewLarge');

// Group Bar elements
const groupChips = document.getElementById('groupChips');
const btnNewGroup = document.getElementById('btnNewGroup');
const btnAssignGroup = document.getElementById('btnAssignGroup');
const btnMoveGroup = document.getElementById('btnMoveGroup');
const btnMoveGroupLabel = document.getElementById('btnMoveGroupLabel');

// Preview Modal elements
const previewModal = document.getElementById('previewModal');
const modalClose = document.getElementById('modalClose');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalCanvas = document.getElementById('modalCanvas');
const modalPageNumBadge = document.getElementById('modalPageNumBadge');
const modalTitleInput = document.getElementById('modalTitleInput');
const modalPageInfo = document.getElementById('modalPageInfo');
const modalOpenTab = document.getElementById('modalOpenTab');
const modalPrevPage = document.getElementById('modalPrevPage');
const modalNextPage = document.getElementById('modalNextPage');
const modalSpinner = document.getElementById('modalSpinner');

// Group Creation Modal elements
const groupModal = document.getElementById('groupModal');
const groupModalClose = document.getElementById('groupModalClose');
const groupModalBackdrop = document.getElementById('groupModalBackdrop');
const inputGroupName = document.getElementById('inputGroupName');
const colorPickerGrid = document.getElementById('colorPickerGrid');
const btnCancelGroupModal = document.getElementById('btnCancelGroupModal');
const btnSaveGroup = document.getElementById('btnSaveGroup');

// Assign Group Modal elements
const assignGroupModal = document.getElementById('assignGroupModal');
const assignGroupClose = document.getElementById('assignGroupClose');
const assignGroupBackdrop = document.getElementById('assignGroupBackdrop');
const groupChecklist = document.getElementById('groupChecklist');
const btnCancelAssignModal = document.getElementById('btnCancelAssignModal');
const btnConfirmAssignGroup = document.getElementById('btnConfirmAssignGroup');

// Move Group Modal elements
const moveGroupModal = document.getElementById('moveGroupModal');
const moveGroupClose = document.getElementById('moveGroupClose');
const moveGroupBackdrop = document.getElementById('moveGroupBackdrop');
const moveGroupDesc = document.getElementById('moveGroupDesc');
const btnMoveGroupToStart = document.getElementById('btnMoveGroupToStart');
const btnMoveGroupToEnd = document.getElementById('btnMoveGroupToEnd');
const inputMoveGroupTarget = document.getElementById('inputMoveGroupTarget');
const btnConfirmMoveGroup = document.getElementById('btnConfirmMoveGroup');

// Compression Modal elements
const compressModal = document.getElementById('compressModal');
const compressModalClose = document.getElementById('compressModalClose');
const compressModalBackdrop = document.getElementById('compressModalBackdrop');
const btnCancelCompress = document.getElementById('btnCancelCompress');
const btnExecuteCompress = document.getElementById('btnExecuteCompress');
const presetBalanced = document.getElementById('presetBalanced');
const presetMaxCompress = document.getElementById('presetMaxCompress');
const presetHighQuality = document.getElementById('presetHighQuality');
const dpiRange = document.getElementById('dpiRange');
const dpiDisplayValue = document.getElementById('dpiDisplayValue');
const dpiQuickBtns = document.querySelectorAll('.dpi-btn');
const qualityRange = document.getElementById('qualityRange');
const qualityDisplayValue = document.getElementById('qualityDisplayValue');
const qualityStatusText = document.getElementById('qualityStatusText');
const compressProgressBox = document.getElementById('compressProgressBox');
const compressProgressText = document.getElementById('compressProgressText');
const compressProgressPercent = document.getElementById('compressProgressPercent');
const compressProgressFill = document.getElementById('compressProgressFill');

// 14 Advanced Compression Options
const optRemoveThumbnails = document.getElementById('optRemoveThumbnails');
const optDedupStreams = document.getElementById('optDedupStreams');
const optRasterizeHeavy = document.getElementById('optRasterizeHeavy');
const optSubsetFonts = document.getElementById('optSubsetFonts');
const optModernCompression = document.getElementById('optModernCompression');
const optGrayscale = document.getElementById('optGrayscale');
const optMaxFlate = document.getElementById('optMaxFlate');
const optFlattenForms = document.getElementById('optFlattenForms');
const optRemoveOutputIntents = document.getElementById('optRemoveOutputIntents');
const optRemoveAttachments = document.getElementById('optRemoveAttachments');
const optRemoveAnnotations = document.getElementById('optRemoveAnnotations');
const optRemoveOutlines = document.getElementById('optRemoveOutlines');
const optRemoveMetadata = document.getElementById('optRemoveMetadata');
const optRemoveStructureTree = document.getElementById('optRemoveStructureTree');

const toast = document.getElementById('toast');

// Signature & Stamp Placement Studio elements
const signModal = document.getElementById('signModal');
const signModalBackdrop = document.getElementById('signModalBackdrop');
const signModalClose = document.getElementById('signModalClose');
const signDocInfo = document.getElementById('signDocInfo');
const btnOpenSignStudio = document.getElementById('btnOpenSignStudio');
const modalSignThisPage = document.getElementById('modalSignThisPage');

// Tabs & Panes (3 tabs)
const tabUpload = document.getElementById('tabUpload');
const tabType = document.getElementById('tabType');
const tabOfficial = document.getElementById('tabOfficial');
const paneUpload = document.getElementById('paneUpload');
const paneType = document.getElementById('paneType');
const paneOfficial = document.getElementById('paneOfficial');

// Tab 1 Upload & Stamp Library
const signUploadDrop = document.getElementById('signUploadDrop');
const signImageInput = document.getElementById('signImageInput');
const stampLibraryGrid = document.getElementById('stampLibraryGrid');
const libStampCountBadge = document.getElementById('libStampCountBadge');
const btnClearStampLibrary = document.getElementById('btnClearStampLibrary');

// Tab 2 Type
const signTypeName = document.getElementById('signTypeName');
const btnSaveTypeToLib = document.getElementById('btnSaveTypeToLib');

// Tab 3 Official Vietnamese Stamp
const groupOfficialTitle = document.getElementById('groupOfficialTitle');
const stampOfficialTitle = document.getElementById('stampOfficialTitle');
const lblOfficialTitle = document.getElementById('lblOfficialTitle');
const stampOfficialName = document.getElementById('stampOfficialName');
const lblOfficialName = document.getElementById('lblOfficialName');
const groupOfficialExtra = document.getElementById('groupOfficialExtra');
const stampOfficialExtra = document.getElementById('stampOfficialExtra');
const lblOfficialExtra = document.getElementById('lblOfficialExtra');
const chkOfficialDate = document.getElementById('chkOfficialDate');
const selOfficialDateFormat = document.getElementById('selOfficialDateFormat');
const rowOfficialDateInput = document.getElementById('rowOfficialDateInput');
const inputOfficialDate = document.getElementById('inputOfficialDate');
const stampBorderType = document.getElementById('stampBorderType');
const chkOfficialGrunge = document.getElementById('chkOfficialGrunge');
const rngOfficialAngle = document.getElementById('rngOfficialAngle');
const lblOfficialAngle = document.getElementById('lblOfficialAngle');
const officialStampDisplay = document.getElementById('officialStampDisplay');
const officialStampBox = document.getElementById('officialStampBox');
const previewOfficialTitle = document.getElementById('previewOfficialTitle');
const previewOfficialName = document.getElementById('previewOfficialName');
const previewOfficialExtra = document.getElementById('previewOfficialExtra');
const previewOfficialDate = document.getElementById('previewOfficialDate');
const btnSaveOfficialToLib = document.getElementById('btnSaveOfficialToLib');

// Placement & Stamps props
const signOpacity = document.getElementById('signOpacity');
const signOpacityVal = document.getElementById('signOpacityVal');
const btnPlaceStampOnPage = document.getElementById('btnPlaceStampOnPage');
const signStampCountBadge = document.getElementById('signStampCountBadge');
const signStampsList = document.getElementById('signStampsList');
const btnClearPageStamps = document.getElementById('btnClearPageStamps');

function syncRangeFill(el) {
  if (!el || el.type !== 'range') return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value) || 0;
  const pct = max === min ? 100 : ((val - min) / (max - min)) * 100;
  el.style.setProperty('--range-pct', `${pct}%`);
}

// Stage Navigation, Viewport & Zoom
const btnSignPrevPage = document.getElementById('btnSignPrevPage');
const btnSignNextPage = document.getElementById('btnSignNextPage');
const signPageSelect = document.getElementById('signPageSelect');
const chkApplyAllPages = document.getElementById('chkApplyAllPages');
const signStageViewport = document.getElementById('signStageViewport');
const signStageContainer = document.getElementById('signStageContainer');
const signStageCanvas = document.getElementById('signStageCanvas');
const signStageOverlay = document.getElementById('signStageOverlay');
const btnStageZoomOut = document.getElementById('btnStageZoomOut');
const btnStageZoomIn = document.getElementById('btnStageZoomIn');
const btnStageZoomFit = document.getElementById('btnStageZoomFit');
const btnStageZoomFitWidth = document.getElementById('btnStageZoomFitWidth');
const inputStageZoom = document.getElementById('inputStageZoom');
const btnStageZoomPresets = document.getElementById('btnStageZoomPresets');
const stageZoomMenu = document.getElementById('stageZoomMenu');

// Floating Mini Toolbar
const stampFloatingToolbar = document.getElementById('stampFloatingToolbar');
const btnFloatRotZero = document.getElementById('btnFloatRotZero');
const btnFloatDuplicate = document.getElementById('btnFloatDuplicate');
const btnFloatDelete = document.getElementById('btnFloatDelete');

// Context Menu Elements
const btnToggleContextMenu = document.getElementById('btnToggleContextMenu');
const txtContextMenu = document.getElementById('txtContextMenu');

// Metadata Editor Modal elements
const metaModal = document.getElementById('metaModal');
const metaModalBackdrop = document.getElementById('metaModalBackdrop');
const metaModalClose = document.getElementById('metaModalClose');
const btnMetaEdit = document.getElementById('btnMetaEdit');
const btnCancelMetaModal = document.getElementById('btnCancelMetaModal');
const btnSaveMeta = document.getElementById('btnSaveMeta');
const inputMetaTitle = document.getElementById('inputMetaTitle');
const inputMetaAuthor = document.getElementById('inputMetaAuthor');
const inputMetaSubject = document.getElementById('inputMetaSubject');
const inputMetaKeywords = document.getElementById('inputMetaKeywords');
const inputMetaCreator = document.getElementById('inputMetaCreator');

// Encrypted PDF password prompt elements
const passwordModal = document.getElementById('passwordModal');
const passwordModalBackdrop = document.getElementById('passwordModalBackdrop');
const passwordModalClose = document.getElementById('passwordModalClose');
const passwordFileName = document.getElementById('passwordFileName');
const passwordInput = document.getElementById('passwordInput');
const passwordError = document.getElementById('passwordError');
const btnCancelPasswordModal = document.getElementById('btnCancelPasswordModal');
const btnUnlockPdf = document.getElementById('btnUnlockPdf');

// Document outline (bookmarks) viewer elements (chỉ đọc; thêm/sửa dùng CLI `bookmark`)
const btnOutline = document.getElementById('btnOutline');
const outlineModal = document.getElementById('outlineModal');
const outlineModalBackdrop = document.getElementById('outlineModalBackdrop');
const outlineModalClose = document.getElementById('outlineModalClose');
const outlineList = document.getElementById('outlineList');
const btnCloseOutlineModal = document.getElementById('btnCloseOutlineModal');

async function resolveOutlineItems(pdfJsDoc, items) {
  const out = [];
  for (const item of items || []) {
    let pageIndex = null;
    try {
      // dest dạng chuỗi = named destination (cần resolve), mảng = explicit (dùng trực tiếp —
      // getDestination của pdf.js KHÔNG nhận explicit array)
      let dest = item.dest || null;
      if (typeof dest === 'string') dest = await pdfJsDoc.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) pageIndex = await pdfJsDoc.getPageIndex(dest[0]);
    } catch (e) { /* dest hỏng: vẫn hiện tiêu đề, không nhảy được */ }
    out.push({
      title: item.title || '(không tên)',
      pageIndex,
      kids: await resolveOutlineItems(pdfJsDoc, item.items || []),
    });
  }
  return out;
}

function appendOutlineNodes(container, items, sourceId, level) {
  for (const item of items) {
    const globalIdx = item.pageIndex === null ? -1 :
      state.pages.findIndex(p => p.sourceId === sourceId && p.pageIndex === item.pageIndex);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'outline-item';
    row.style.paddingLeft = `${8 + level * 18}px`;
    const titleSpan = document.createElement('span');
    titleSpan.className = 'outline-title';
    titleSpan.textContent = item.title;
    row.appendChild(titleSpan);
    if (globalIdx >= 0) {
      const pageSpan = document.createElement('span');
      pageSpan.className = 'outline-page';
      pageSpan.textContent = `#${globalIdx + 1}`;
      row.appendChild(pageSpan);
      row.addEventListener('click', () => {
        outlineModal.classList.remove('active');
        openPreviewModal(globalIdx);
      });
    } else {
      row.disabled = true;
    }
    container.appendChild(row);
    if (item.kids && item.kids.length > 0) appendOutlineNodes(container, item.kids, sourceId, level + 1);
  }
}

async function openOutlineModal() {
  if (!outlineModal || !outlineList) return;
  outlineList.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'dialog-subtext';
  loading.textContent = 'Đang đọc mục lục...';
  outlineList.appendChild(loading);
  outlineModal.classList.add('active');

  outlineList.innerHTML = '';
  let total = 0;
  for (const [sourceId, srcObj] of state.sources) {
    if (!srcObj || !srcObj.pdfJsDoc) continue;
    let items = [];
    try {
      items = await resolveOutlineItems(srcObj.pdfJsDoc, await srcObj.pdfJsDoc.getOutline());
    } catch (e) { continue; }
    if (items.length === 0) continue;
    total += items.length;
    const section = document.createElement('div');
    section.className = 'outline-source';
    const head = document.createElement('div');
    head.className = 'outline-source-title';
    head.textContent = srcObj.name || sourceId;
    section.appendChild(head);
    appendOutlineNodes(section, items, sourceId, 0);
    outlineList.appendChild(section);
  }
  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'dialog-subtext';
    empty.textContent = 'Tài liệu không có bookmark nào.';
    outlineList.appendChild(empty);
  }
}

function setupOutlineEvents() {
  if (!btnOutline || !outlineModal) return;
  const close = () => outlineModal.classList.remove('active');
  btnOutline.addEventListener('click', openOutlineModal);
  if (outlineModalClose) outlineModalClose.addEventListener('click', close);
  if (outlineModalBackdrop) outlineModalBackdrop.addEventListener('click', close);
  if (btnCloseOutlineModal) btnCloseOutlineModal.addEventListener('click', close);
}

// Office -> PDF elements
const btnConvertOffice = document.getElementById('btnConvertOffice');
const convertFileInput = document.getElementById('convertFileInput');

const OFFICE_EXTS = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp'];

function setupConvertEvents() {
  if (!btnConvertOffice || !convertFileInput) return;
  btnConvertOffice.addEventListener('click', () => convertFileInput.click());
  convertFileInput.addEventListener('change', () => {
    const files = Array.from(convertFileInput.files || []);
    convertFileInput.value = '';
    if (files.length === 0) return;
    convertOfficeFiles(files);
  });
}

async function convertOfficeFiles(files) {
  const valid = files.filter(f => OFFICE_EXTS.includes(((f.name.split('.').pop() || '').toLowerCase())));
  if (valid.length === 0) {
    showToast('Không tìm thấy file Office hợp lệ (docx, xlsx, pptx...)!', 'danger');
    return;
  }
  if (valid.length > 10) {
    showToast('Tối đa 10 file mỗi lần chuyển đổi!', 'danger');
    return;
  }
  btnConvertOffice.disabled = true;
  showToast(`Đang chuyển đổi ${valid.length} file Office sang PDF... (cần LibreOffice)`, 'success');
  try {
    const form = new FormData();
    valid.forEach(f => form.append('files', f, f.name));
    const res = await fetch('/api/convert', { method: 'POST', body: form });
    if (!res.ok) {
      let msg = `Chuyển đổi thất bại (HTTP ${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) msg = errJson.error;
      } catch (e) { /* giữ message mặc định */ }
      showToast(msg, 'danger');
      return;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/pdf')) {
      const buf = await res.arrayBuffer();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="?([^";]+)"?/);
      const name = (m && m[1]) || 'converted.pdf';
      await loadPdfFiles([new File([buf], name, { type: 'application/pdf' })], true);
      showToast(`Đã chuyển đổi và nạp: ${name}`, 'success');
    } else {
      // ZIP nhiều file -> tải về máy
      const buf = await res.arrayBuffer();
      downloadBlob(buf, 'pdfcraft_converted.zip', 'application/zip');
      showToast(`Đã chuyển đổi ${valid.length} file, đang tải file ZIP...`, 'success');
    }
  } catch (err) {
    console.error('Lỗi chuyển Office sang PDF:', err);
    showToast('Lỗi chuyển đổi: ' + (err.message || err), 'danger');
  } finally {
    btnConvertOffice.disabled = false;
  }
}

// Modal Footer actions
const btnCancelSign = document.getElementById('btnCancelSign');
const btnSaveSignDone = document.getElementById('btnSaveSignDone');

// ==========================================================================
// Initialization & Event Listeners
// ==========================================================================

function init() {
  setupUploadEvents();
  setupToolbarEvents();
  setupPagesGridDelegation();
  setupGroupEvents();
  setupModalEvents();
  setupCompressEvents();
  setupSignatureEvents();
  setupMetaEvents();
setupPasswordEvents();
setupOutlineEvents();
setupConvertEvents();
  setupSearchEvents();
  setupProjectEvents();
  initColorPicker();
  setupContextMenuEvents();
  checkContextMenuStatus();
  checkInitialFile();
  setupMarqueeSelection();
}

// Check and load initial file from native backend (e.g. opened via Windows Context Menu or CLI)
async function checkInitialFile() {
  try {
    const res = await fetch('/api/initial-file');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.has_file && data.filename) {
      // Đảm bảo không tự động nạp lại file cũ nếu người dùng đã tải trang trong cùng phiên
      const sessionKey = 'pdfcraft_init_file_' + data.filename + '_' + data.size;
      if (sessionStorage.getItem(sessionKey)) {
        return;
      }
      sessionStorage.setItem(sessionKey, '1');

      showToast(`Đang nạp tệp "${data.filename}" từ Windows...`, 'success');
      const contentRes = await fetch('/api/initial-file/content');
      if (!contentRes.ok) return;
      const blob = await contentRes.blob();
      const file = new File([blob], data.filename, { type: 'application/pdf', lastModified: Date.now() });
      await loadPdfFiles([file], false);
      showToast(`✨ Đã mở thành công tệp: ${data.filename}`, 'success');
    }
  } catch (err) {
    // Ignore when offline or in static file mode
  }
}

// ==========================================================================
// Marquee Selection Box (Drag-to-select multiple pages)
// ==========================================================================

function setupMarqueeSelection() {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let latestX = 0;
  let latestY = 0;
  let animFrameId = null;
  let isCtrlOrShift = false;
  let cardRects = [];
  let initialSelectedMap = new Map();
  let marqueeEl = null;

  function ensureMarqueeEl() {
    if (!marqueeEl) {
      marqueeEl = document.createElement('div');
      marqueeEl.className = 'selection-marquee';
      document.body.appendChild(marqueeEl);
    }
    return marqueeEl;
  }

  workspaceContainer.addEventListener('mousedown', (e) => {
    // Chỉ kích hoạt bằng chuột trái
    if (e.button !== 0) return;
    if (state.pages.length === 0) return;

    // Không kích hoạt nếu nhấp trúng thẻ trang (để dành cho kéo thẻ đổi vị trí), nút, thanh công cụ hoặc modal
    if (e.target.closest('.page-card') ||
        e.target.closest('.toolbar') ||
        e.target.closest('.group-bar') ||
        e.target.closest('.modal') ||
        e.target.closest('button') ||
        e.target.closest('input')) {
      return;
    }

    startX = e.clientX;
    startY = e.clientY;
    latestX = startX;
    latestY = startY;
    isDragging = false;
    isCtrlOrShift = e.ctrlKey || e.metaKey || e.shiftKey;

    // Lưu trạng thái đã chọn ban đầu của các trang
    initialSelectedMap = new Map(state.pages.map(p => [p.id, !!p.isSelected]));

    // Lưu bộ đệm tọa độ màn hình và tham chiếu O(1) của các thẻ một lần duy nhất lúc mousedown (chống Layout Thrashing)
    const cards = Array.from(pagesGrid.querySelectorAll('.page-card'));
    cardRects = cards.map(card => {
      const r = card.getBoundingClientRect();
      const pageId = card.dataset.pageId;
      const pageItem = state.pages.find(p => p.id === pageId);
      return {
        id: pageId,
        pageItem: pageItem,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        card,
        chk: card.querySelector('.custom-checkbox')
      };
    });

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    latestX = e.clientX;
    latestY = e.clientY;
    if (!animFrameId) {
      animFrameId = requestAnimationFrame(updateMarqueeFrame);
    }
  }

  function updateMarqueeFrame() {
    animFrameId = null;
    const dx = latestX - startX;
    const dy = latestY - startY;

    // Chỉ bật khung marquee khi chuột dịch chuyển hơn 6px (tránh nhầm lẫn với thao tác click đơn)
    if (!isDragging) {
      if (Math.hypot(dx, dy) > 6) {
        isDragging = true;
        document.body.classList.add('is-marquee-selecting');
        const m = ensureMarqueeEl();
        m.style.display = 'block';
      } else {
        return;
      }
    }

    const mLeft = Math.min(startX, latestX);
    const mTop = Math.min(startY, latestY);
    const mWidth = Math.abs(dx);
    const mHeight = Math.abs(dy);
    const mRight = mLeft + mWidth;
    const mBottom = mTop + mHeight;

    const m = ensureMarqueeEl();
    m.style.left = `${mLeft}px`;
    m.style.top = `${mTop}px`;
    m.style.width = `${mWidth}px`;
    m.style.height = `${mHeight}px`;

    // Thuật toán kiểm tra va chạm hình học (AABB Collision) O(1) trực tiếp với từng thẻ trang
    let anyChanged = false;
    for (let i = 0; i < cardRects.length; i++) {
      const item = cardRects[i];
      const pageItem = item.pageItem;
      if (!pageItem) continue;

      const isHit = !(
        item.left > mRight ||
        item.right < mLeft ||
        item.top > mBottom ||
        item.bottom < mTop
      );

      const newSelected = isCtrlOrShift ? (initialSelectedMap.get(item.id) || isHit) : isHit;

      if (pageItem.isSelected !== newSelected) {
        pageItem.isSelected = newSelected;
        item.card.classList.toggle('selected', newSelected);
        if (item.chk) item.chk.checked = newSelected;
        anyChanged = true;
      }
    }

    if (anyChanged) {
      updateSelectionUI();
    }
  }

  function onMouseUp(e) {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    if (isDragging) {
      isDragging = false;
      document.body.classList.remove('is-marquee-selecting');
      if (marqueeEl) {
        marqueeEl.style.display = 'none';
      }
      updateSelectionUI();
    } else {
      // Nhấp chuột vào khoảng trống mà không kéo (và không giữ Ctrl/Shift):
      // Bỏ chọn tất cả các trang (chuẩn hành vi Desktop Explorer)
      if (!isCtrlOrShift) {
        const anySelected = state.pages.some(p => p.isSelected);
        if (anySelected) {
          state.pages.forEach(p => p.isSelected = false);
          pagesGrid.querySelectorAll('.page-card.selected').forEach(c => {
            c.classList.remove('selected');
            const chk = c.querySelector('.custom-checkbox');
            if (chk) chk.checked = false;
          });
          updateSelectionUI();
        }
      }
    }
  }
}

// Check Windows Context Menu integration status
async function checkContextMenuStatus() {
  if (!btnToggleContextMenu || !txtContextMenu) return;
  try {
    const res = await fetch('/api/context-menu/status');
    if (!res.ok) return;
    const data = await res.json();
    updateContextMenuButton(data.installed);
  } catch (err) {
    // Server endpoint not available
  }
}

function updateContextMenuButton(isInstalled) {
  if (!btnToggleContextMenu || !txtContextMenu) return;
  if (isInstalled) {
    btnToggleContextMenu.classList.add('installed');
    txtContextMenu.innerHTML = '✓ Đã tích hợp Menu chuột phải Windows (<b>Open with PDF Craft</b>)';
    btnToggleContextMenu.title = 'Nhấp để gỡ bỏ khỏi Menu chuột phải Windows';
  } else {
    btnToggleContextMenu.classList.remove('installed');
    txtContextMenu.innerHTML = '🖱️ Thêm vào Menu chuột phải Windows (<b>Open with PDF Craft</b>)';
    btnToggleContextMenu.title = 'Nhấp để đăng ký "Open with PDF Craft" vào Menu chuột phải Windows';
  }
}

function setupContextMenuEvents() {
  if (!btnToggleContextMenu) return;
  btnToggleContextMenu.addEventListener('click', async () => {
    try {
      const isInstalled = btnToggleContextMenu.classList.contains('installed');
      const endpoint = isInstalled ? '/api/context-menu/uninstall' : '/api/context-menu/install';
      btnToggleContextMenu.disabled = true;
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      btnToggleContextMenu.disabled = false;
      if (data.success) {
        updateContextMenuButton(!isInstalled);
        if (!isInstalled) {
          showToast('✓ Đã thêm "Open with PDF Craft" vào Menu chuột phải Windows!', 'success');
        } else {
          showToast('Đã gỡ bỏ "Open with PDF Craft" khỏi Menu chuột phải Windows.', 'success');
        }
      } else {
        showToast('Không thể cập nhật cấu hình: ' + (data.error || 'Lỗi không xác định'), 'danger');
      }
    } catch (err) {
      if (btnToggleContextMenu) btnToggleContextMenu.disabled = false;
      showToast('Lỗi khi gửi yêu cầu tới máy chủ nội bộ', 'danger');
    }
  });
}

// Áp metadata do người dùng đặt lên tài liệu xuất (trường trống = giữ nguyên)
function applyDocMeta(outPdf) {
  const m = state.docMeta || {};
  try {
    if (m.title) outPdf.setTitle(m.title);
    if (m.author) outPdf.setAuthor(m.author);
    if (m.subject) outPdf.setSubject(m.subject);
    if (m.keywords) {
      const arr = String(m.keywords).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      if (arr.length > 0) outPdf.setKeywords(arr);
    }
    if (m.creator) outPdf.setCreator(m.creator);
  } catch (e) {
    console.warn('Không áp được metadata:', e);
  }
}

function setupMetaEvents() {
  if (!btnMetaEdit || !metaModal) return;

  const closeMetaModal = () => metaModal.classList.remove('active');
  if (metaModalClose) metaModalClose.addEventListener('click', closeMetaModal);
  if (metaModalBackdrop) metaModalBackdrop.addEventListener('click', closeMetaModal);
  if (btnCancelMetaModal) btnCancelMetaModal.addEventListener('click', closeMetaModal);

  btnMetaEdit.addEventListener('click', async () => {
    // Điền sẵn từ file nguồn đầu tiên (nếu có) để người dùng sửa tiếp
    try {
      await ensurePdfLibLoaded();
      const firstSrc = state.sources.values().next().value;
      if (firstSrc) {
        const d = await getSourcePdfLibDoc(firstSrc);
        if (d) {
          if (inputMetaTitle) inputMetaTitle.value = state.docMeta.title || d.getTitle() || '';
          if (inputMetaAuthor) inputMetaAuthor.value = state.docMeta.author || d.getAuthor() || '';
          if (inputMetaSubject) inputMetaSubject.value = state.docMeta.subject || d.getSubject() || '';
          if (inputMetaKeywords) inputMetaKeywords.value = state.docMeta.keywords || d.getKeywords() || '';
          if (inputMetaCreator) inputMetaCreator.value = state.docMeta.creator || d.getCreator() || '';
        }
      }
    } catch (e) {
      console.warn('Không đọc được metadata gốc:', e);
    }
    metaModal.classList.add('active');
    if (inputMetaTitle) inputMetaTitle.focus();
  });

  if (btnSaveMeta) {
    btnSaveMeta.addEventListener('click', () => {
      state.docMeta = {
        title: inputMetaTitle ? inputMetaTitle.value.trim() : '',
        author: inputMetaAuthor ? inputMetaAuthor.value.trim() : '',
        subject: inputMetaSubject ? inputMetaSubject.value.trim() : '',
        keywords: inputMetaKeywords ? inputMetaKeywords.value.trim() : '',
        creator: inputMetaCreator ? inputMetaCreator.value.trim() : '',
      };
      const hasAny = Object.values(state.docMeta).some(v => !!v);
      btnMetaEdit.classList.toggle('btn-accent', hasAny);
      closeMetaModal();
      showToast(hasAny ? 'Đã lưu metadata, sẽ áp dụng cho mọi file xuất ra!' : 'Đã xóa metadata tùy chỉnh (giữ nguyên gốc)!', 'success');
    });
  }
}

// ==========================================================================
// In-Document Text Search (không phân biệt dấu, dùng findTextMatches từ utils.js)
// ==========================================================================

const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const btnSearchPrev = document.getElementById('btnSearchPrev');
const btnSearchNext = document.getElementById('btnSearchNext');
const btnSearchClear = document.getElementById('btnSearchClear');

const pageTextCache = new Map(); // pageId -> trích xuất text (cache suốt phiên)
const pageNormCache = new Map(); // pageId -> text đã chuẩn hóa không dấu (tính 1 lần, tìm kiếm dùng lại)
const searchState = { query: '', hits: [], total: 0, cursor: -1 };
let searchDebounce = null;
let searchRunToken = 0;

async function getPageText(pageItem) {
  if (!pageItem) return '';
  if (pageTextCache.has(pageItem.id)) return pageTextCache.get(pageItem.id);
  try {
    const srcObj = state.sources.get(pageItem.sourceId);
    if (!srcObj || !srcObj.pdfJsDoc) return '';
    const page = await srcObj.pdfJsDoc.getPage(pageItem.pageIndex + 1);
    const tc = await page.getTextContent();
    const text = ((tc && tc.items) || []).map(it => (it && it.str) || '').join(' ');
    pageTextCache.set(pageItem.id, text);
    pageNormCache.set(pageItem.id, normalizeText(text));
    return text;
  } catch (e) {
    return '';
  }
}

function clearSearchMarks() {
  pagesGrid.querySelectorAll('.page-card.search-hit, .page-card.search-current').forEach(c => {
    c.classList.remove('search-hit', 'search-current');
  });
}

function clearSearch() {
  searchRunToken++;
  searchState.query = '';
  searchState.hits = [];
  searchState.total = 0;
  searchState.cursor = -1;
  clearSearchMarks();
  if (searchCount) searchCount.textContent = '';
}

function updateSearchCount() {
  if (!searchCount) return;
  if (searchState.hits.length === 0) {
    searchCount.textContent = searchState.query ? '0 kết quả' : '';
    return;
  }
  searchCount.textContent = `${searchState.cursor + 1}/${searchState.hits.length} trang • ${searchState.total} kq`;
}

function focusSearchHit() {
  pagesGrid.querySelectorAll('.page-card.search-current').forEach(c => c.classList.remove('search-current'));
  if (searchState.cursor < 0 || searchState.cursor >= searchState.hits.length) return;
  const hitId = searchState.hits[searchState.cursor].id;
  updateSearchCount();
  const card = pagesGrid.querySelector(`.page-card[data-page-id="${hitId}"]`);
  if (card) {
    // Bỏ lọc nhóm đang che trang kết quả để người dùng thấy được
    if (card.style.display === 'none' && state.activeGroupFilter) {
      state.activeGroupFilter = null;
      renderGrid();
      renderGroupBar();
    }
    const fresh = pagesGrid.querySelector(`.page-card[data-page-id="${hitId}"]`);
    if (fresh) {
      fresh.classList.add('search-current');
      fresh.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function stepSearch(dir) {
  if (searchState.hits.length === 0) return;
  searchState.cursor = (searchState.cursor + dir + searchState.hits.length) % searchState.hits.length;
  focusSearchHit();
}

let backgroundIndexingToken = 0;
function startBackgroundTextIndexing() {
  const currentToken = ++backgroundIndexingToken;
  if (!('requestIdleCallback' in window)) return;

  let pageIndex = 0;
  function scheduleNext() {
    window.requestIdleCallback((deadline) => {
      if (currentToken !== backgroundIndexingToken) return;
      while (pageIndex < state.pages.length && deadline.timeRemaining() > 5) {
        const pageItem = state.pages[pageIndex++];
        if (pageItem && !pageNormCache.has(pageItem.id)) {
          getPageText(pageItem).catch(() => {});
        }
      }
      if (pageIndex < state.pages.length && currentToken === backgroundIndexingToken) {
        scheduleNext();
      }
    }, { timeout: 3000 });
  }

  scheduleNext();
}

async function runSearch() {
  if (!searchInput) return;
  const token = ++searchRunToken;
  const q = searchInput.value.trim();
  clearSearchMarks();
  searchState.query = q;
  searchState.hits = [];
  searchState.total = 0;
  searchState.cursor = -1;
  if (!q) {
    if (searchCount) searchCount.textContent = '';
    return;
  }
  if (searchCount) searchCount.textContent = 'Đang tìm…';

  // Gom các trang chưa trích xuất văn bản để nạp song song bằng Concurrency Pool (4 trang/đợt)
  const uncached = state.pages.filter(p => !pageNormCache.has(p.id));
  if (uncached.length > 0) {
    const CONCURRENCY = 4;
    for (let i = 0; i < uncached.length; i += CONCURRENCY) {
      if (token !== searchRunToken) return;
      const batch = uncached.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(p => getPageText(p)));
    }
  }
  if (token !== searchRunToken) return;

  const pages = [];
  for (const p of state.pages) {
    if (token !== searchRunToken) return; // truy vấn mới hơn đã tới, bỏ lượt này
    // Dùng bản chuẩn hóa đã cache (tính 1 lần khi trích xuất) thay vì normalize lại mỗi lần gõ
    let norm = pageNormCache.get(p.id);
    if (norm === undefined) norm = normalizeText(await getPageText(p));
    pages.push({ id: p.id, text: norm });
  }
  if (token !== searchRunToken) return;

  // Query chuẩn hóa trước (1 lần), trang đã chuẩn hóa sẵn -> so khớp thuần túy, kết quả đồng nhất với trước đây
  const hits = findTextMatches(pages, normalizeText(q), { accentInsensitive: false });
  searchState.hits = hits;
  searchState.total = hits.reduce((a, h) => a + h.matches, 0);
  const hitIds = new Set(hits.map(h => h.id));
  pagesGrid.querySelectorAll('.page-card').forEach(card => {
    if (hitIds.has(card.dataset.pageId)) card.classList.add('search-hit');
  });
  if (hits.length > 0) {
    searchState.cursor = 0;
    focusSearchHit();
  } else {
    updateSearchCount();
  }
}

function setupSearchEvents() {
  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runSearch, 350);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchDebounce);
      if (searchState.query === searchInput.value.trim() && searchState.hits.length > 0) {
        stepSearch(e.shiftKey ? -1 : 1);
      } else {
        runSearch();
      }
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      clearSearch();
      searchInput.blur();
    }
  });

  if (btnSearchNext) btnSearchNext.addEventListener('click', () => {
    if (searchState.hits.length > 0) stepSearch(1);
    else runSearch();
  });
  if (btnSearchPrev) btnSearchPrev.addEventListener('click', () => stepSearch(-1));
  if (btnSearchClear) btnSearchClear.addEventListener('click', () => {
    searchInput.value = '';
    clearSearch();
    searchInput.focus();
  });
}

// ==========================================================================
// Project Session: lưu/tải toàn bộ phiên làm việc (.pdfcraft.json)
// ==========================================================================

const btnSaveProject = document.getElementById('btnSaveProject');
const btnLoadProject = document.getElementById('btnLoadProject');
const projectFileInput = document.getElementById('projectFileInput');

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Bỏ các trường runtime (khóa _img, _*) để JSON hóa được
function stripRuntimeFields(obj) {
  const out = {};
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && !k.startsWith('_')) {
      out[k] = obj[k];
    }
  }
  return out;
}

function showWorkspaceUI() {
  uploadContainer.style.display = 'none';
  workspaceContainer.style.display = 'block';
  btnUploadNew.style.display = 'inline-flex';
  btnExportPdf.style.display = 'inline-flex';
  btnOpenCompressModal.style.display = 'inline-flex';
  if (btnSaveProject) btnSaveProject.style.display = 'inline-flex';
  docStats.style.display = 'flex';
}

async function saveProject() {
  if (state.pages.length === 0) {
    alert('Chưa có trang nào để lưu project!');
    return;
  }
  try {
    showToast('Đang đóng gói project...', 'success');
    const sources = [];
    const idMap = new Map();
    for (const [oldId, s] of state.sources) {
      idMap.set(oldId, sources.length);
      sources.push({
        name: s.name,
        fileSize: s.fileSize,
        data: arrayBufferToBase64(s.bytes),
      });
    }
    const stampCount = state.pages.reduce((a, p) => a + (p.stamps ? p.stamps.length : 0), 0);
    const project = {
      app: 'pdfcraft',
      kind: 'project',
      version: 1,
      savedAt: new Date().toISOString(),
      docMeta: { ...state.docMeta },
      groups: state.groups.map(g => ({ id: g.id, name: g.name, color: g.color })),
      pages: state.pages.map(p => ({
        source: idMap.get(p.sourceId),
        pageIndex: p.pageIndex,
        title: p.title,
        rotation: p.rotation || 0,
        isSelected: !!p.isSelected,
        groupIds: [...(p.groupIds || [])],
        stamps: (p.stamps || []).map(stripRuntimeFields),
        originalIndex: typeof p.originalIndex === 'number' ? p.originalIndex : 0,
      })),
    };
    const json = JSON.stringify(project);
    const detail = `${state.pages.length} trang, ${sources.length} file PDF gốc` +
      (stampCount > 0 ? `, ${stampCount} chữ ký/dấu` : '') +
      ` (≈ ${formatBytes(json.length)})`;
    if (!confirm(`Lưu project gồm ${detail}?`)) return;
    downloadBlob(new TextEncoder().encode(json), `pdfcraft_project_${Date.now()}.pdfcraft.json`, 'application/json');
    showToast('Đã lưu project thành công!', 'success');
  } catch (err) {
    console.error('Lỗi khi lưu project:', err);
    showToast('Lỗi khi lưu project: ' + err.message, 'danger');
  }
}

function bumpNextIdFromLoaded() {
  // Tránh đụng id mới (p_N/src_N/g_N) với id đã lưu trong project
  let maxNum = nextId;
  const scan = (id) => {
    const m = String(id || '').match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10) + 1);
  };
  state.groups.forEach(g => scan(g.id));
  state.pages.forEach(p => scan(p.id));
  nextId = maxNum;
  let maxOrig = nextOriginalIndex;
  state.pages.forEach(p => {
    if (typeof p.originalIndex === 'number' && p.originalIndex >= maxOrig) maxOrig = p.originalIndex + 1;
  });
  nextOriginalIndex = maxOrig;
}

async function loadProjectFile(file) {
  let project = null;
  try {
    project = JSON.parse(await file.text());
  } catch (e) {
    showToast('File project không đọc được (không phải JSON)!', 'danger');
    return;
  }
  if (!project || project.app !== 'pdfcraft' || !Array.isArray(project.sources) || !Array.isArray(project.pages)) {
    showToast('File không đúng định dạng project PDF Craft!', 'danger');
    return;
  }
  if ((project.version || 1) > 1) {
    if (!confirm('File project từ phiên bản PDF Craft mới hơn. Vẫn thử mở?')) return;
  }
  if (state.pages.length > 0) {
    if (!confirm(`Mở project sẽ thay thế ${state.pages.length} trang đang làm việc. Tiếp tục?`)) return;
  }

  showToast('Đang khôi phục project...', 'success');

  // Reset toàn bộ trạng thái
  state.sources.clear();
  state.pages = [];
  state.groups = [];
  state.activeGroupFilter = null;
  state.docMeta = { title: '', author: '', subject: '', keywords: '', creator: '', ...(project.docMeta || {}) };
  historyStack.length = 0;
  redoStack.length = 0;
  updateUndoButtonUI();
  updateRedoButtonUI();
  thumbnailCache.clear();
  previewCache.clear();
  pageTextCache.clear();
  pageNormCache.clear();
  if (searchInput) {
    searchInput.value = '';
    clearSearch();
  }
  // Ngắt observer trước khi xóa hàng loạt để detached DOM không bị giữ tham chiếu
  thumbnailObserver.disconnect();
  pagesGrid.innerHTML = '';

  try {
    const newSourceIds = [];
    const dimsBySource = [];
    for (const s of project.sources) {
      const bytes = base64ToArrayBuffer(s.data);
      const pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const sourceId = 'src_' + (nextId++);
      state.sources.set(sourceId, {
        name: s.name || 'document.pdf',
        bytes: bytes,
        pdfJsDoc: pdfJsDoc,
        pdfLibDoc: null,
        fileSize: s.fileSize || bytes.byteLength,
      });
      newSourceIds.push(sourceId);
      // Kích thước chuẩn theo trang đầu (giống lúc nạp file)
      let w = 595, h = 842;
      try {
        const vp = (await pdfJsDoc.getPage(1)).getViewport({ scale: 1 });
        w = Math.round(vp.width);
        h = Math.round(vp.height);
      } catch (e) { /* fallback A4 */ }
      dimsBySource.push({ width: w, height: h });
    }

    const validGroupIds = new Set((project.groups || []).map(g => g.id));
    state.groups = (project.groups || []).map(g => ({ id: g.id, name: g.name, color: g.color }));

    project.pages.forEach((sp, idx) => {
      const sourceId = newSourceIds[sp.source];
      if (!sourceId || !state.sources.has(sourceId)) return;
      const dims = dimsBySource[sp.source] || { width: 595, height: 842 };
      state.pages.push({
        id: 'p_' + (nextId++),
        sourceId: sourceId,
        pageIndex: sp.pageIndex,
        title: sp.title || `#${idx + 1}`,
        rotation: sp.rotation || 0,
        width: dims.width,
        height: dims.height,
        isSelected: !!sp.isSelected,
        groupIds: (sp.groupIds || []).filter(gid => validGroupIds.has(gid)),
        stamps: sp.stamps || [],
        originalIndex: typeof sp.originalIndex === 'number' ? sp.originalIndex : nextOriginalIndex++,
      });
    });
    bumpNextIdFromLoaded();

    let totalBytes = 0;
    for (const src of state.sources.values()) {
      totalBytes += src.fileSize || 0;
    }
    statFileSize.textContent = formatBytes(totalBytes);

    const hasMeta = Object.values(state.docMeta).some(v => !!v);
    if (btnMetaEdit) btnMetaEdit.classList.toggle('btn-accent', hasMeta);

    showWorkspaceUI();
    updateSelectionUI();
    renderGrid();
    renderGroupBar();
    startBackgroundTextIndexing();
    showToast(`Đã khôi phục project: ${state.pages.length} trang từ ${newSourceIds.length} file!`, 'success');
  } catch (err) {
    console.error('Lỗi khi mở project:', err);
    showToast('Lỗi khi mở project: ' + err.message, 'danger');
  }
}

function setupProjectEvents() {
  if (btnSaveProject) {
    btnSaveProject.addEventListener('click', saveProject);
  }
  if (btnLoadProject && projectFileInput) {
    btnLoadProject.addEventListener('click', () => projectFileInput.click());
    projectFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        loadProjectFile(e.target.files[0]);
      }
      projectFileInput.value = '';
    });
  }
}

function setupUploadEvents() {
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      loadPdfFiles(Array.from(e.target.files), false);
    }
    fileInput.value = '';
  });

  insertFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      loadPdfFiles(Array.from(e.target.files), true);
    }
    insertFileInput.value = '';
  });

  btnUploadNew.addEventListener('click', () => {
    fileInput.click();
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const rawFiles = Array.from(e.dataTransfer.files || []);
    const pdfFiles = rawFiles.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length > 0) {
      loadPdfFiles(pdfFiles, false);
    } else {
      showToast('Vui lòng kéo thả tệp PDF hợp lệ', 'danger');
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    workspaceContainer.addEventListener(eventName, (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        workspaceContainer.classList.add('drag-over');
      }
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    workspaceContainer.addEventListener(eventName, (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        workspaceContainer.classList.remove('drag-over');
      }
    });
  });

  workspaceContainer.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const rawFiles = Array.from(e.dataTransfer.files);
      const pdfFiles = rawFiles.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (pdfFiles.length > 0) {
        loadPdfFiles(pdfFiles, true);
      }
    }
  });
}

// ==========================================================================
// Undo / Redo History Management
// ==========================================================================

function snapshotPages() {
  return state.pages.map(p => ({
    ...p,
    groupIds: [...(p.groupIds || [])],
    // Bỏ trường runtime _img (Image đã decode, tốn RAM) — vẽ lại lười từ dataUrl khi undo (xem drawStampsOnCanvas)
    stamps: (p.stamps || []).map(s => stripRuntimeFields(s))
  }));
}

function saveHistoryState() {
  historyStack.push(snapshotPages());
  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
  }
  // Thao tác mới làm mất hiệu lực chuỗi redo
  redoStack.length = 0;
  updateUndoButtonUI();
  updateRedoButtonUI();
}

function restoreSnapshot(snapshot) {
  state.pages = snapshot;
  updateUndoButtonUI();
  updateRedoButtonUI();
  updateSelectionUI();
  renderGrid();
  renderGroupBar();
}

// ==========================================================================
// Arrange: di chuyển trang đã chọn (không cần kéo thả)
// ==========================================================================

function moveSelectedPages(mode) {
  const selected = state.pages.filter(p => p.isSelected);
  if (selected.length === 0 || selected.length === state.pages.length) return;
  const selectedSet = new Set(selected.map(p => p.id));
  const arr = [...state.pages];
  let moved = false;

  if (mode === 'left') {
    // Quét trái→phải: mỗi trang đã chọn lùi 1 bước; trang không chọn tự né sang phải tạo khoảng trống
    for (let i = 0; i < arr.length; i++) {
      if (!selectedSet.has(arr[i].id)) continue;
      if (i === 0) continue;
      if (selectedSet.has(arr[i - 1].id)) continue;
      const tmp = arr[i - 1];
      arr[i - 1] = arr[i];
      arr[i] = tmp;
      moved = true;
    }
  } else if (mode === 'right') {
    // Quét phải→trái: mỗi trang đã chọn tiến 1 bước; trang không chọn tự né sang trái tạo khoảng trống
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!selectedSet.has(arr[i].id)) continue;
      if (i === arr.length - 1) continue;
      if (selectedSet.has(arr[i + 1].id)) continue;
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i];
      arr[i] = tmp;
      moved = true;
    }
  } else if (mode === 'start') {
    const firstIdx = arr.findIndex(p => selectedSet.has(p.id));
    if (firstIdx === 0) return;
    const rest = arr.filter(p => !selectedSet.has(p.id));
    arr.splice(0, arr.length, ...selected, ...rest);
    moved = true;
  } else if (mode === 'end') {
    let lastIdx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (selectedSet.has(arr[i].id)) { lastIdx = i; break; }
    }
    if (lastIdx === arr.length - 1) return;
    const rest = arr.filter(p => !selectedSet.has(p.id));
    arr.splice(0, arr.length, ...rest, ...selected);
    moved = true;
  } else if (typeof mode === 'number' && Number.isFinite(mode)) {
    const rest = arr.filter(p => !selectedSet.has(p.id));
    const insertAt = Math.max(0, Math.min(mode, rest.length));
    rest.splice(insertAt, 0, ...selected);
    const same = arr.every((p, i) => p.id === rest[i].id);
    if (same) return;
    arr.splice(0, arr.length, ...rest);
    moved = true;
  } else {
    return;
  }

  if (!moved) {
    showToast(mode === 'left' ? 'Đã ở vị trí đầu tiên — không thể di chuyển trái hơn!' : 'Đã ở vị trí cuối cùng — không thể di chuyển phải hơn!', 'info');
    return;
  }

  saveHistoryState();
  state.pages = arr;
  renderGrid();
  updateSelectionUI();

  // Nhấn nhá các thẻ vừa di chuyển
  selected.forEach(p => {
    const card = pagesGrid.querySelector(`.page-card[data-page-id="${p.id}"]`);
    if (card) {
      card.classList.remove('just-moved');
      void card.offsetWidth;
      card.classList.add('just-moved');
      setTimeout(() => card.classList.remove('just-moved'), 750);
    }
  });

  const labels = { start: 'đầu danh sách', end: 'cuối danh sách', left: 'sang trái', right: 'sang phải' };
  const label = labels[mode] || (typeof mode === 'number' ? `vị trí #${mode + 1}` : '');
  showToast(`Đã di chuyển ${selected.length} trang${label ? ' ' + label : ''}`, 'success');
}

function restoreOriginalOrder() {
  if (state.pages.length < 2) return;
  const sorted = [...state.pages].sort((a, b) => {
    const ao = typeof a.originalIndex === 'number' ? a.originalIndex : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.originalIndex === 'number' ? b.originalIndex : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  if (sorted.every((p, i) => p.id === state.pages[i].id)) {
    showToast('Thứ tự đã là thứ tự gốc!', 'info');
    return;
  }
  saveHistoryState();
  state.pages = sorted;
  renderGrid();
  showToast('Đã khôi phục thứ tự gốc khi nạp file', 'success');
}

function undo() {
  if (historyStack.length === 0) return;
  redoStack.push(snapshotPages());
  if (redoStack.length > MAX_HISTORY) {
    redoStack.shift();
  }
  restoreSnapshot(historyStack.pop());
  showToast('Đã hoàn tác thao tác gần nhất!', 'success');
}

function redo() {
  if (redoStack.length === 0) return;
  historyStack.push(snapshotPages());
  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
  }
  restoreSnapshot(redoStack.pop());
  showToast('Đã làm lại thao tác!', 'success');
}

function updateUndoButtonUI() {
  if (btnUndo) {
    btnUndo.disabled = historyStack.length === 0;
  }
}

function updateRedoButtonUI() {
  if (btnRedo) {
    btnRedo.disabled = redoStack.length === 0;
  }
}

function setupToolbarEvents() {
  btnSelectAll.addEventListener('click', (e) => {
    if (e.target !== chkSelectAll) {
      chkSelectAll.checked = !chkSelectAll.checked;
    }
    const isChecked = chkSelectAll.checked;
    state.pages.forEach(p => p.isSelected = isChecked);
    updateSelectionUI();

    // Cập nhật trực tiếp DOM trong < 2ms, không phá hủy và render lại lưới
    const cards = pagesGrid.querySelectorAll('.page-card');
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      c.classList.toggle('selected', isChecked);
      const chk = c.querySelector('.custom-checkbox');
      if (chk) chk.checked = isChecked;
    }
  });

  btnDeleteSelected.addEventListener('click', () => {
    const selectedCount = state.pages.filter(p => p.isSelected).length;
    if (selectedCount === 0) return;

    if (selectedCount === state.pages.length) {
      alert('Không thể xóa toàn bộ các trang trong tài liệu!');
      return;
    }

    if (confirm(`Bạn có chắc chắn muốn xóa ${selectedCount} trang đã chọn?`)) {
      saveHistoryState();
      state.pages.filter(p => p.isSelected).forEach(p => { pageTextCache.delete(p.id); pageNormCache.delete(p.id); });
      state.pages = state.pages.filter(p => !p.isSelected);
      updateSelectionUI();
      renderGrid();
      renderGroupBar();
      showToast(`Đã xóa ${selectedCount} trang thành công`, 'success');
    }
  });

  btnReverseOrder.addEventListener('click', () => {
    saveHistoryState();
    state.pages.reverse();

    // In-place đảo thứ tự thẻ DOM bằng DocumentFragment (tốc độ < 5ms)
    const cards = Array.from(pagesGrid.children);
    cards.reverse();
    const fragment = document.createDocumentFragment();
    cards.forEach((c, idx) => {
      c.dataset.index = idx;
      const badge = c.querySelector('.card-num-badge');
      if (badge) badge.textContent = `#${idx + 1}`;
      fragment.appendChild(c);
    });
    pagesGrid.appendChild(fragment);
    showToast('Đã đảo ngược thứ tự toàn bộ các trang', 'success');
  });

  if (btnMoveStart) btnMoveStart.addEventListener('click', () => moveSelectedPages('start'));
  if (btnMoveLeft) btnMoveLeft.addEventListener('click', () => moveSelectedPages('left'));
  if (btnMoveRight) btnMoveRight.addEventListener('click', () => moveSelectedPages('right'));
  if (btnMoveEnd) btnMoveEnd.addEventListener('click', () => moveSelectedPages('end'));
  if (btnMoveToPos) {
    btnMoveToPos.addEventListener('click', () => {
      const selectedCount = state.pages.filter(p => p.isSelected).length;
      if (selectedCount === 0) return;
      const raw = prompt(`Chuyển ${selectedCount} trang đã chọn tới vị trí số (1 – ${state.pages.length - selectedCount + 1}):`, '1');
      if (raw === null) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        showToast('Vị trí không hợp lệ!', 'danger');
        return;
      }
      moveSelectedPages(n - 1);
    });
  }
  if (btnRestoreOrder) btnRestoreOrder.addEventListener('click', restoreOriginalOrder);

  if (btnUndo) {
    btnUndo.addEventListener('click', undo);
  }

  if (btnRedo) {
    btnRedo.addEventListener('click', redo);
  }

  btnExtractSelected.addEventListener('click', () => {
    const selectedPages = state.pages.filter(p => p.isSelected);
    if (selectedPages.length === 0) return;
    exportPdfFromPages(selectedPages, 'extracted_pages.pdf');
  });

  if (btnRotateSelected) {
    btnRotateSelected.addEventListener('click', rotateSelectedPages);
  }

  if (btnOpenSignStudio) {
    btnOpenSignStudio.addEventListener('click', () => {
      openSignStudio();
    });
  }

  // Split all pages with custom page titles
  btnSplitAll.addEventListener('click', async () => {
    if (state.pages.length > 20) {
      if (!confirm(`Tài liệu có ${state.pages.length} trang. Bạn có muốn tải về từng file một không?`)) {
        return;
      }
    }
    showToast('Đang tiến hành tách các trang theo tên...', 'success');
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      const safeName = (p.title || `trang_${i + 1}`).replace(/[\\/:*?"<>|]/g, '_');
      await exportPdfFromPages([p], `${safeName}.pdf`, false);
    }
    showToast(`Đã tách thành công ${state.pages.length} tệp PDF!`, 'success');
  });

  // Export by Groups
  btnExportGroups.addEventListener('click', async () => {
    if (state.groups.length === 0) {
      alert('Bạn chưa tạo nhóm nào! Hãy bấm "+ Tạo nhóm" để gom nhóm các trang trước khi xuất.');
      return;
    }

    let exportedCount = 0;
    showToast('Đang xuất các tệp PDF theo từng nhóm...', 'success');

    for (const group of state.groups) {
      const groupPages = state.pages.filter(p => p.groupIds && p.groupIds.includes(group.id));
      if (groupPages.length > 0) {
        const safeName = group.name.replace(/[\\/:*?"<>|]/g, '_');
        await exportPdfFromPages(groupPages, `${safeName}.pdf`, false);
        exportedCount++;
      }
    }

    if (exportedCount > 0) {
      showToast(`Đã xuất thành công ${exportedCount} tệp PDF theo nhóm!`, 'success');
    } else {
      showToast('Các nhóm hiện tại chưa có trang nào được gán!', 'danger');
    }
  });

  btnExportPdf.addEventListener('click', () => {
    exportPdfFromPages(state.pages, 'crafted_document.pdf');
  });

  // Grid Sizing Handlers
  const setGridSize = (size) => {
    pagesGrid.classList.remove('grid-compact', 'grid-large');
    [btnViewCompact, btnViewStandard, btnViewLarge].forEach(b => {
      if (b) b.classList.remove('active');
    });
    if (size === 'compact') {
      pagesGrid.classList.add('grid-compact');
      if (btnViewCompact) btnViewCompact.classList.add('active');
    } else if (size === 'large') {
      pagesGrid.classList.add('grid-large');
      if (btnViewLarge) btnViewLarge.classList.add('active');
    } else {
      if (btnViewStandard) btnViewStandard.classList.add('active');
    }
  };

  if (btnViewCompact) btnViewCompact.addEventListener('click', () => setGridSize('compact'));
  if (btnViewStandard) btnViewStandard.addEventListener('click', () => setGridSize('standard'));
  if (btnViewLarge) btnViewLarge.addEventListener('click', () => setGridSize('large'));

  // Global Keyboard Shortcuts (Ctrl+A, Delete, Ctrl+Z)
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable)) {
      return;
    }
    if (workspaceContainer.style.display === 'none') return;
    if (previewModal.classList.contains('active') || (signModal && signModal.classList.contains('active')) || compressModal.classList.contains('active') || groupModal.classList.contains('active') || assignGroupModal.classList.contains('active') || moveGroupModal.classList.contains('active')) {
      return;
    }

    // Ctrl+A / Cmd+A: Toggle Select All
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      const allSelected = state.pages.length > 0 && state.pages.every(p => p.isSelected);
      state.pages.forEach(p => p.isSelected = !allSelected);
      updateSelectionUI();
      renderGrid();
      return;
    }

    // Ctrl+Z / Cmd+Z: Undo (Shift+Ctrl+Z = Redo)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    // Ctrl+Y: Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }

    // Delete / Backspace: Delete selected
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selectedCount = state.pages.filter(p => p.isSelected).length;
      if (selectedCount > 0) {
        e.preventDefault();
        btnDeleteSelected.click();
      }
      return;
    }

    // R: Rotate selected 90° clockwise
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const selectedCount = state.pages.filter(p => p.isSelected).length;
      if (selectedCount > 0) {
        e.preventDefault();
        rotateSelectedPages();
      }
      return;
    }

    // Alt+← / Alt+→ : Di chuyển trang đã chọn
    // Alt+Home / Alt+End : Về đầu / cuối
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const selectedCount = state.pages.filter(p => p.isSelected).length;
      if (selectedCount === 0) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveSelectedPages('left');
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveSelectedPages('right');
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        moveSelectedPages('start');
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        moveSelectedPages('end');
        return;
      }
    }

    // /: Focus document search
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });
}

// ==========================================================================
// Group System Events & Management
// ==========================================================================

function initColorPicker() {
  colorPickerGrid.innerHTML = '';
  GROUP_COLORS.forEach((color, idx) => {
    const opt = document.createElement('div');
    opt.className = 'color-option' + (idx === 0 ? ' selected' : '');
    opt.style.backgroundColor = color;
    opt.dataset.color = color;
    opt.addEventListener('click', () => {
      colorPickerGrid.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedGroupColor = color;
    });
    colorPickerGrid.appendChild(opt);
  });
}

function setupGroupEvents() {
  // Open create group modal
  btnNewGroup.addEventListener('click', () => {
    inputGroupName.value = '';
    selectedGroupColor = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    colorPickerGrid.querySelectorAll('.color-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.color === selectedGroupColor);
    });
    groupModal.classList.add('active');
    inputGroupName.focus();
  });

  const closeGroupModal = () => groupModal.classList.remove('active');
  groupModalClose.addEventListener('click', closeGroupModal);
  groupModalBackdrop.addEventListener('click', closeGroupModal);
  btnCancelGroupModal.addEventListener('click', closeGroupModal);

  btnSaveGroup.addEventListener('click', () => {
    const name = inputGroupName.value.trim();
    if (!name) {
      alert('Vui lòng nhập tên nhóm!');
      return;
    }
    const newGroup = {
      id: 'g_' + (nextId++),
      name: name,
      color: selectedGroupColor,
    };
    state.groups.push(newGroup);
    closeGroupModal();
    renderGroupBar();
    showToast(`Đã tạo nhóm "${name}" thành công!`, 'success');
  });

  // Open Assign Groups modal
  btnAssignGroup.addEventListener('click', () => {
    targetSinglePageForAssign = null;
    openAssignModal();
  });

  const closeAssignModal = () => {
    assignGroupModal.classList.remove('active');
    targetSinglePageForAssign = null;
  };
  assignGroupClose.addEventListener('click', closeAssignModal);
  assignGroupBackdrop.addEventListener('click', closeAssignModal);
  btnCancelAssignModal.addEventListener('click', closeAssignModal);

  btnConfirmAssignGroup.addEventListener('click', () => {
    const selectedGroupIds = Array.from(groupChecklist.querySelectorAll('input:checked')).map(cb => cb.value);

    if (targetSinglePageForAssign) {
      // Single page assign
      targetSinglePageForAssign.groupIds = selectedGroupIds;
    } else {
      // Batch assign for checked pages
      state.pages.filter(p => p.isSelected).forEach(p => {
        p.groupIds = [...new Set([...p.groupIds, ...selectedGroupIds])];
      });
    }

    closeAssignModal();
    renderGrid();
    renderGroupBar();
    showToast('Đã cập nhật nhóm cho các trang!', 'success');
  });

  // Move group modal
  btnMoveGroup.addEventListener('click', () => {
    if (!state.activeGroupFilter) return;
    const activeGroup = state.groups.find(g => g.id === state.activeGroupFilter);
    if (!activeGroup) return;

    moveGroupDesc.textContent = `Di chuyển toàn bộ các trang trong nhóm "${activeGroup.name}" đến vị trí mới:`;
    moveGroupModal.classList.add('active');
  });

  const closeMoveModal = () => moveGroupModal.classList.remove('active');
  moveGroupClose.addEventListener('click', closeMoveModal);
  moveGroupBackdrop.addEventListener('click', closeMoveModal);

  btnMoveGroupToStart.addEventListener('click', () => {
    moveEntireGroupToPosition(0);
    closeMoveModal();
  });

  btnMoveGroupToEnd.addEventListener('click', () => {
    moveEntireGroupToPosition(state.pages.length);
    closeMoveModal();
  });

  btnConfirmMoveGroup.addEventListener('click', () => {
    const target = parseInt(inputMoveGroupTarget.value, 10);
    if (isNaN(target) || target < 1) {
      alert('Vui lòng nhập số vị trí hợp lệ!');
      return;
    }
    moveEntireGroupToPosition(target - 1);
    closeMoveModal();
  });
}

function openAssignModal(singlePage = null) {
  if (state.groups.length === 0) {
    alert('Bạn chưa tạo nhóm nào! Vui lòng tạo nhóm trước.');
    return;
  }

  targetSinglePageForAssign = singlePage;
  groupChecklist.innerHTML = '';

  state.groups.forEach(g => {
    const label = document.createElement('label');
    label.className = 'group-check-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'custom-checkbox';
    chk.value = g.id;

    if (singlePage) {
      chk.checked = singlePage.groupIds && singlePage.groupIds.includes(g.id);
    } else {
      // Check if all selected pages have this group
      const selectedPages = state.pages.filter(p => p.isSelected);
      chk.checked = selectedPages.length > 0 && selectedPages.every(p => p.groupIds && p.groupIds.includes(g.id));
    }

    const dot = document.createElement('span');
    dot.className = 'group-chip-dot';
    dot.style.backgroundColor = g.color;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = g.name;
    nameSpan.style.flex = '1';

    label.appendChild(chk);
    label.appendChild(dot);
    label.appendChild(nameSpan);

    groupChecklist.appendChild(label);
  });

  assignGroupModal.classList.add('active');
}

function moveEntireGroupToPosition(targetIndex) {
  const groupId = state.activeGroupFilter;
  if (!groupId) return;

  const groupPages = state.pages.filter(p => p.groupIds && p.groupIds.includes(groupId));
  if (groupPages.length === 0) {
    showToast('Nhóm này không có trang nào để di chuyển!', 'danger');
    return;
  }

  saveHistoryState();

  // Remove group pages from current list
  const otherPages = state.pages.filter(p => !p.groupIds || !p.groupIds.includes(groupId));

  // Constrain targetIndex
  const safeTarget = Math.max(0, Math.min(targetIndex, otherPages.length));

  // Insert group pages at safeTarget
  otherPages.splice(safeTarget, 0, ...groupPages);
  state.pages = otherPages;

  renderGrid();
  renderGroupBar();
  showToast(`Đã di chuyển nhóm đến vị trí #${safeTarget + 1}!`, 'success');
}

function renderGroupBar() {
  groupChips.innerHTML = '';

  // "Tất cả" chip
  const allChip = document.createElement('div');
  allChip.className = 'group-chip' + (state.activeGroupFilter === null ? ' active' : '');
  allChip.innerHTML = `
    <span>Tất cả</span>
    <span class="group-chip-count">${state.pages.length}</span>
  `;
  allChip.addEventListener('click', () => {
    state.activeGroupFilter = null;
    renderGrid();
    renderGroupBar();
  });
  groupChips.appendChild(allChip);

  // Chips for user groups
  state.groups.forEach(g => {
    const count = state.pages.filter(p => p.groupIds && p.groupIds.includes(g.id)).length;
    const chip = document.createElement('div');
    chip.className = 'group-chip' + (state.activeGroupFilter === g.id ? ' active' : '');

    chip.innerHTML = `
      <span class="group-chip-dot" style="background-color: ${g.color};"></span>
      <span>${g.name}</span>
      <span class="group-chip-count">${count}</span>
      <button class="group-chip-delete" title="Xóa nhóm này">×</button>
    `;

    chip.querySelector('.group-chip-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Bạn có chắc chắn muốn xóa nhóm "${g.name}"?`)) {
        state.groups = state.groups.filter(grp => grp.id !== g.id);
        state.pages.forEach(p => {
          if (p.groupIds) p.groupIds = p.groupIds.filter(gid => gid !== g.id);
        });
        if (state.activeGroupFilter === g.id) {
          state.activeGroupFilter = null;
        }
        renderGrid();
        renderGroupBar();
        showToast(`Đã xóa nhóm "${g.name}"`, 'success');
      }
    });

    chip.addEventListener('click', () => {
      if (state.activeGroupFilter === g.id) {
        state.activeGroupFilter = null; // Toggle off
      } else {
        state.activeGroupFilter = g.id; // Filter to this group
      }
      renderGrid();
      renderGroupBar();
    });

    groupChips.appendChild(chip);
  });

  // Update Move Group button
  if (state.activeGroupFilter) {
    const activeGroup = state.groups.find(g => g.id === state.activeGroupFilter);
    if (activeGroup) {
      btnMoveGroup.style.display = 'inline-flex';
      btnMoveGroupLabel.textContent = `Di chuyển nhóm "${activeGroup.name}"`;
    } else {
      btnMoveGroup.style.display = 'none';
    }
  } else {
    btnMoveGroup.style.display = 'none';
  }
}

// ==========================================================================
// Modal Detail Events
// ==========================================================================

function setupModalEvents() {
  const closeModal = () => {
    previewModal.classList.remove('active');
    state.currentModalIndex = null;
    currentModalRenderIndex = null;
  };

  modalClose.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', closeModal);

  // Sync title edit from modal
  modalTitleInput.addEventListener('change', () => {
    if (state.currentModalIndex !== null && state.pages[state.currentModalIndex]) {
      const item = state.pages[state.currentModalIndex];
      item.title = modalTitleInput.value.trim() || `#${state.currentModalIndex + 1}`;
      // Update card title input in grid
      const card = pagesGrid.querySelector(`.page-card[data-page-id="${item.id}"]`);
      if (card) {
        const input = card.querySelector('.card-title-input');
        if (input) input.value = item.title;
      }
    }
  });

  modalTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalTitleInput.blur();
  });

  if (modalOpenTab) {
    modalOpenTab.addEventListener('click', () => {
      if (state.currentModalIndex !== null && state.pages[state.currentModalIndex]) {
        const item = state.pages[state.currentModalIndex];
        openPageInNewTab(item, state.currentModalIndex + 1);
      }
    });
  }

  if (modalSignThisPage) {
    modalSignThisPage.addEventListener('click', () => {
      if (state.currentModalIndex !== null) {
        const targetIdx = state.currentModalIndex;
        closeModal();
        openSignStudio(targetIdx);
      }
    });
  }

  if (modalPrevPage) {
    modalPrevPage.addEventListener('click', () => {
      if (state.currentModalIndex !== null && state.currentModalIndex > 0) {
        openPreviewModal(state.currentModalIndex - 1);
      }
    });
  }

  if (modalNextPage) {
    modalNextPage.addEventListener('click', () => {
      if (state.currentModalIndex !== null && state.currentModalIndex < state.pages.length - 1) {
        openPreviewModal(state.currentModalIndex + 1);
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (!previewModal.classList.contains('active')) return;
    if (e.target === modalTitleInput) return; // Don't trigger arrows if typing in input
    if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'ArrowLeft' && state.currentModalIndex !== null && state.currentModalIndex > 0) {
      openPreviewModal(state.currentModalIndex - 1);
    } else if (e.key === 'ArrowRight' && state.currentModalIndex !== null && state.currentModalIndex < state.pages.length - 1) {
      openPreviewModal(state.currentModalIndex + 1);
    }
  });
}

// ==========================================================================
// Loading & Multi-File Ingestion
// ==========================================================================

// Mở file PDF mã hóa: bắt PasswordException của pdf.js -> hỏi mật khẩu -> thử lại.
// Trả về { doc, password } hoặc null khi người dùng bỏ qua file.
function isPasswordException(err) {
  return !!err && (err.name === 'PasswordException' ||
    (typeof err.message === 'string' && /password/i.test(err.message)));
}

let passwordModalResolve = null;

function setupPasswordEvents() {
  if (!passwordModal) return;
  const cancel = () => {
    passwordModal.classList.remove('active');
    if (passwordModalResolve) { passwordModalResolve(null); passwordModalResolve = null; }
  };
  const unlock = () => {
    if (!passwordInput) return;
    passwordModal.classList.remove('active');
    if (passwordModalResolve) { passwordModalResolve(passwordInput.value || ''); passwordModalResolve = null; }
  };
  if (passwordModalClose) passwordModalClose.addEventListener('click', cancel);
  if (passwordModalBackdrop) passwordModalBackdrop.addEventListener('click', cancel);
  if (btnCancelPasswordModal) btnCancelPasswordModal.addEventListener('click', cancel);
  if (btnUnlockPdf) btnUnlockPdf.addEventListener('click', unlock);
  if (passwordInput) passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); unlock(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

function promptPdfPassword(fileName, wasWrong) {
  return new Promise((resolve) => {
    if (!passwordModal || !passwordInput) { resolve(null); return; }
    passwordModalResolve = resolve;
    if (passwordFileName) passwordFileName.textContent = `\u201C${fileName}\u201D yêu cầu mật khẩu để mở.`;
    if (passwordError) passwordError.style.display = wasWrong ? 'block' : 'none';
    passwordInput.value = '';
    passwordModal.classList.add('active');
    setTimeout(() => passwordInput.focus(), 50);
  });
}

async function openPdfWithPassword(fileName, masterBuffer) {
  try {
    const doc = await pdfjsLib.getDocument({ data: masterBuffer.slice(0) }).promise;
    return { doc, password: '' };
  } catch (err) {
    if (!isPasswordException(err)) throw err;
  }
  let wasWrong = false;
  while (true) {
    const pw = await promptPdfPassword(fileName, wasWrong);
    if (pw === null) return null; // người dùng bỏ qua file
    try {
      const doc = await pdfjsLib.getDocument({ data: masterBuffer.slice(0), password: pw }).promise;
      return { doc, password: pw };
    } catch (err) {
      if (!isPasswordException(err)) throw err;
      wasWrong = true; // sai mật khẩu, hỏi lại
    }
  }
}

// formatBytes: dùng chung từ utils.js.
// Nạp lười (Lazy Load) tài liệu pdf-lib theo yêu cầu khi xuất PDF, không chặn luồng vẽ ban đầu
async function getSourcePdfLibDoc(srcObj) {
  if (!srcObj) return null;
  await ensurePdfLibLoaded();
  if (!srcObj.pdfLibDoc) {
    try {
      srcObj.pdfLibDoc = await PDFLib.PDFDocument.load(srcObj.bytes.slice(0));
    } catch (err) {
      if (srcObj.password) {
        throw new Error('File mã hóa: Web UI chưa hỗ trợ xuất file có mật khẩu, hãy giải mã trước bằng lệnh `pdfcraft decrypt`');
      }
      throw err;
    }
  }
  return srcObj.pdfLibDoc;
}

async function loadPdfFiles(files, isAppend = false) {
  if (!files || files.length === 0) return;

  const validFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (validFiles.length === 0) {
    showToast('Không tìm thấy tệp PDF hợp lệ trong danh sách đã chọn!', 'danger');
    return;
  }

  showToast(`Đang chuẩn bị xử lý ${validFiles.length} tệp PDF...`, 'success');

  if (!isAppend) {
    // Giải phóng worker + bộ nhớ pdf.js của phiên cũ trước khi nạp mới (tránh leak RAM khi mở file khác)
    for (const src of state.sources.values()) {
      try {
        if (src.pdfJsDoc && typeof src.pdfJsDoc.destroy === 'function') await src.pdfJsDoc.destroy();
      } catch (e) { /* bỏ qua: doc có thể đã được destroy */ }
    }
    state.sources.clear();
    state.pages = [];
    state.groups = [];
    state.activeGroupFilter = null;
    historyStack.length = 0;
    redoStack.length = 0;
    updateUndoButtonUI();
    updateRedoButtonUI();
    pageTextCache.clear();
    pageNormCache.clear();
    if (typeof clearSearch === 'function' && searchInput) {
      searchInput.value = '';
      clearSearch();
    }
    thumbnailCache.clear();
    previewCache.clear();
    // Ngắt observer trước khi xóa hàng loạt để detached DOM không bị giữ tham chiếu
    thumbnailObserver.disconnect();
    pagesGrid.innerHTML = '';
  }

  let totalNewPages = 0;
  let loadedCount = 0;

  for (let fIdx = 0; fIdx < validFiles.length; fIdx++) {
    const file = validFiles[fIdx];
    try {
      showToast(`Đang nạp (${fIdx + 1}/${validFiles.length}): ${file.name}...`, 'success');
      const arrayBuffer = await file.arrayBuffer();
      const sourceId = 'src_' + (nextId++);

      // File mã hóa: hỏi mật khẩu (thử lại khi sai, bỏ qua khi hủy)
      // Truyền bản sao slice(0) cho Worker của pdf.js để tránh Worker chiếm và detach master buffer
      const opened = await openPdfWithPassword(file.name, arrayBuffer);
      if (!opened) {
        showToast(`Đã bỏ qua file mã hóa: ${file.name}`, 'success');
        continue;
      }
      const pdfJsDoc = opened.doc;

      const srcObj = {
        name: file.name,
        bytes: arrayBuffer,
        password: opened.password,
        pdfJsDoc,
        pdfLibDoc: null, // Nạp lười khi xuất PDF
        fileSize: file.size,
      };
      state.sources.set(sourceId, srcObj);

      // Nạp lười trước PDFLib trong thời gian rảnh rỗi của trình duyệt
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => {
          ensurePdfLibLoaded().then(() => getSourcePdfLibDoc(srcObj)).catch(() => {});
        });
      }

      // Lấy kích thước trang 1 làm kích thước ban đầu (mở file siêu tốc < 50ms, không lặp tuần tự getPage)
      let defaultWidth = 595;
      let defaultHeight = 842;
      try {
        const firstPage = await pdfJsDoc.getPage(1);
        const vp = firstPage.getViewport({ scale: 1 });
        defaultWidth = Math.round(vp.width);
        defaultHeight = Math.round(vp.height);
      } catch (e) {
        // fallback chuẩn A4
      }

      const newPages = [];
      const startIndex = state.pages.length;
      for (let i = 1; i <= pdfJsDoc.numPages; i++) {
        newPages.push({
          id: 'p_' + (nextId++),
          sourceId: sourceId,
          pageIndex: i - 1,
          title: `#${startIndex + i}`,
          rotation: 0,
          width: defaultWidth,
          height: defaultHeight,
          isSelected: false,
          groupIds: [],
          stamps: [],
          originalIndex: nextOriginalIndex++,
        });
      }

      state.pages.push(...newPages);
      totalNewPages += newPages.length;
      loadedCount++;
    } catch (err) {
      console.error(`Lỗi khi đọc file ${file.name}:`, err);
      showToast(`Lỗi khi đọc ${file.name}: ${err.message}`, 'danger');
    }
  }

  let totalBytes = 0;
  for (const src of state.sources.values()) {
    totalBytes += src.fileSize || 0;
  }
  statFileSize.textContent = formatBytes(totalBytes);

  uploadContainer.style.display = 'none';
  workspaceContainer.style.display = 'block';
  btnUploadNew.style.display = 'inline-flex';
  btnExportPdf.style.display = 'inline-flex';
  btnOpenCompressModal.style.display = 'inline-flex';
  docStats.style.display = 'flex';

  updateSelectionUI();
  renderGrid();
  renderGroupBar();
  startBackgroundTextIndexing();

  if (isAppend) {
    showToast(`Đã thêm ${totalNewPages} trang từ ${loadedCount} tệp PDF vào tài liệu!`, 'success');
  } else {
    showToast(`Đã nạp thành công ${state.pages.length} trang từ ${loadedCount} tệp PDF!`, 'success');
  }
}

// ==========================================================================
// Grid Rendering & Page Thumbnails with In-Place DOM Recycling
// ==========================================================================

function updateSelectionUI() {
  const selectedCount = state.pages.filter(p => p.isSelected).length;
  const totalCount = state.pages.length;

  statPageCount.textContent = totalCount;
  btnDeleteSelected.disabled = selectedCount === 0;
  btnExtractSelected.disabled = selectedCount === 0;
  if (btnRotateSelected) btnRotateSelected.disabled = selectedCount === 0;
  btnAssignGroup.disabled = selectedCount === 0;
  if (btnMoveStart) btnMoveStart.disabled = selectedCount === 0;
  if (btnMoveLeft) btnMoveLeft.disabled = selectedCount === 0;
  if (btnMoveRight) btnMoveRight.disabled = selectedCount === 0;
  if (btnMoveEnd) btnMoveEnd.disabled = selectedCount === 0;
  if (btnMoveToPos) btnMoveToPos.disabled = selectedCount === 0;

  if (selectedCount === 0) {
    chkSelectAll.checked = false;
    chkSelectAll.indeterminate = false;
    txtSelectCount.textContent = 'Chọn tất cả';
  } else if (selectedCount === totalCount) {
    chkSelectAll.checked = true;
    chkSelectAll.indeterminate = false;
    txtSelectCount.textContent = `Bỏ chọn (${totalCount})`;
  } else {
    chkSelectAll.indeterminate = true;
    txtSelectCount.textContent = `Đã chọn (${selectedCount}/${totalCount})`;
  }
}

function renderGrid() {
  const existingCards = new Map();
  pagesGrid.querySelectorAll('.page-card').forEach(c => {
    if (c.dataset.pageId) {
      existingCards.set(c.dataset.pageId, c);
    }
  });

  const currentPageIds = new Set(state.pages.map(p => p.id));

  existingCards.forEach((card, pageId) => {
    if (!currentPageIds.has(pageId)) {
      // Gỡ observer + hủy render dở để detached DOM không bị observer/queue giữ tham chiếu (leak)
      const wrapper = card.querySelector('.card-thumbnail-wrapper');
      if (wrapper) { try { thumbnailObserver.unobserve(wrapper); } catch (e) {} }
      const deadCanvas = card.querySelector('canvas');
      if (deadCanvas && deadCanvas._pdfRenderTask && typeof deadCanvas._pdfRenderTask.cancel === 'function') {
        try { deadCanvas._pdfRenderTask.cancel(); } catch (e) {}
        deadCanvas._pdfRenderTask = null;
      }
      card.remove();
      existingCards.delete(pageId);
    }
  });

  // Vứt tác vụ thumbnail của card đã rời DOM (tránh decode frame vô ích khi xóa/lọc trang)
  for (let i = thumbnailRenderQueue.length - 1; i >= 0; i--) {
    if (!document.body.contains(thumbnailRenderQueue[i].canvas)) thumbnailRenderQueue.splice(i, 1);
  }

  const fragment = document.createDocumentFragment();

  state.pages.forEach((pageItem, index) => {
    let card = existingCards.get(pageItem.id);

    if (!card) {
      card = createCardElement(pageItem, index);
    } else {
      card.dataset.index = index;
      const badge = card.querySelector('.card-num-badge');
      if (badge) badge.textContent = `#${index + 1}`;

      const titleInput = card.querySelector('.card-title-input');
      if (titleInput && document.activeElement !== titleInput) {
        titleInput.value = pageItem.title || `#${index + 1}`;
      }

      const checkbox = card.querySelector('.custom-checkbox');
      if (checkbox) checkbox.checked = pageItem.isSelected;
      card.classList.toggle('selected', pageItem.isSelected);

      // Đồng bộ badge chữ ký/con dấu khi card được tái sử dụng (renderGrid không recreate)
      const leftHeader = card.querySelector('.card-header-left');
      if (leftHeader) {
        let signedBadge = leftHeader.querySelector('.card-signed-badge');
        const stampCount = (pageItem.stamps && pageItem.stamps.length) || 0;
        if (stampCount > 0) {
          if (!signedBadge) {
            signedBadge = document.createElement('span');
            signedBadge.className = 'card-signed-badge';
            leftHeader.appendChild(signedBadge);
          }
          signedBadge.title = `Trang này có ${stampCount} chữ ký / con dấu`;
          signedBadge.innerHTML = `🖋️ ${stampCount}`;
        } else if (signedBadge) {
          signedBadge.remove();
        }
      }

      // Re-render group pills
      const groupWrapper = card.querySelector('.card-groups-wrapper');
      if (groupWrapper) renderCardGroupPills(pageItem, groupWrapper);

      // Cập nhật lại kích thước hiển thị theo góc xoay trang
      const dimTag = card.querySelector('.card-dim-tag');
      if (dimTag) {
        const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
        const currentW = isSwapped ? pageItem.height : pageItem.width;
        const currentH = isSwapped ? pageItem.width : pageItem.height;
        dimTag.textContent = `${currentW} × ${currentH} pt`;
      }
    }

    // Filter visibility
    if (state.activeGroupFilter && (!pageItem.groupIds || !pageItem.groupIds.includes(state.activeGroupFilter))) {
      card.style.display = 'none';
    } else {
      card.style.display = 'flex';
    }

    fragment.appendChild(card);
  });

  // Chèn một lần duy nhất vào DOM để triệt tiêu reflow/layout thrashing
  pagesGrid.appendChild(fragment);
}

function renderCardGroupPills(pageItem, container) {
  container.innerHTML = '';

  if (pageItem.groupIds && pageItem.groupIds.length > 0) {
    pageItem.groupIds.forEach(gid => {
      const g = state.groups.find(grp => grp.id === gid);
      if (g) {
        const pill = document.createElement('span');
        pill.className = 'card-group-pill';
        pill.style.backgroundColor = g.color;
        pill.textContent = g.name;
        container.appendChild(pill);
      }
    });
  }

  // "+ Nhóm" button on card (sử dụng Event Delegation)
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'card-group-add-btn';
  addBtn.dataset.action = 'assign-group';
  addBtn.title = 'Gán nhóm cho trang này';
  addBtn.innerHTML = `+ Nhóm`;
  container.appendChild(addBtn);
}

function rotateCard(card, pageItem) {
  saveHistoryState();
  const oldKey = `${pageItem.id}_${pageItem.rotation}`;
  const oldHdKey = `${pageItem.id}_${pageItem.rotation}_hd`;
  thumbnailCache.delete(oldKey);
  previewCache.delete(oldHdKey);

  pageItem.rotation = (pageItem.rotation + 90) % 360;

  // Cập nhật kích thước hiển thị theo góc xoay mới
  const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
  const currentW = isSwapped ? pageItem.height : pageItem.width;
  const currentH = isSwapped ? pageItem.width : pageItem.height;
  const dimTag = card.querySelector('.card-dim-tag');
  if (dimTag) dimTag.textContent = `${currentW} × ${currentH} pt`;

  delete card.dataset.thumbRendered;
  const canvas = card.querySelector('canvas');
  if (canvas) {
    canvas.style.opacity = '0.35';
    enqueueThumbnailRender(pageItem, canvas, card);
  }
}

function rotateSelectedPages() {
  const selected = state.pages.filter(p => p.isSelected);
  if (selected.length === 0) return;
  saveHistoryState();

  const selectedIds = new Set(selected.map(p => p.id));
  selected.forEach(pageItem => {
    thumbnailCache.delete(`${pageItem.id}_${pageItem.rotation}`);
    previewCache.delete(`${pageItem.id}_${pageItem.rotation}_hd`);
    pageItem.rotation = ((pageItem.rotation || 0) + 90) % 360;
  });

  // Cập nhật trực tiếp các thẻ đang hiển thị, không render lại toàn bộ lưới
  pagesGrid.querySelectorAll('.page-card').forEach(card => {
    const pid = card.dataset.pageId;
    if (!pid || !selectedIds.has(pid)) return;
    const pageItem = state.pages.find(p => p.id === pid);
    if (!pageItem) return;
    const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
    const dimTag = card.querySelector('.card-dim-tag');
    if (dimTag) {
      const cw = isSwapped ? pageItem.height : pageItem.width;
      const ch = isSwapped ? pageItem.width : pageItem.height;
      dimTag.textContent = `${cw} × ${ch} pt`;
    }
    delete card.dataset.thumbRendered;
    const canvas = card.querySelector('canvas');
    if (canvas) {
      canvas.style.opacity = '0.35';
      enqueueThumbnailRender(pageItem, canvas, card);
    }
  });

  showToast(`Đã xoay ${selected.length} trang đã chọn thêm 90°`, 'success');
}

function deleteSinglePage(card, curIdx) {
  if (state.pages.length <= 1) {
    alert('Tài liệu phải có ít nhất 1 trang!');
    return;
  }
  saveHistoryState();
  const removedItem = state.pages.splice(curIdx, 1)[0];
  if (removedItem) {
    thumbnailCache.delete(`${removedItem.id}_${removedItem.rotation}`);
    previewCache.delete(`${removedItem.id}_${removedItem.rotation}_hd`);
    pageTextCache.delete(removedItem.id);
    pageNormCache.delete(removedItem.id);
  }
  updateSelectionUI();
  renderGrid();
  renderGroupBar();
  showToast(`Đã xóa trang #${curIdx + 1}`, 'success');
}

function toggleCardSelection(card, pageItem, e) {
  const checkbox = card.querySelector('.custom-checkbox');
  const curIndex = parseInt(card.dataset.index, 10);
  if (e.target !== checkbox) {
    checkbox.checked = !checkbox.checked;
  }
  const targetState = checkbox.checked;

  if (e.shiftKey && lastSelectedPageIndex !== null && lastSelectedPageIndex !== curIndex) {
    const start = Math.min(lastSelectedPageIndex, curIndex);
    const end = Math.max(lastSelectedPageIndex, curIndex);
    for (let i = start; i <= end; i++) {
      if (state.pages[i]) {
        state.pages[i].isSelected = targetState;
        const c = pagesGrid.querySelector(`.page-card[data-index="${i}"]`);
        if (c) {
          c.classList.toggle('selected', targetState);
          const chk = c.querySelector('.custom-checkbox');
          if (chk) chk.checked = targetState;
        }
      }
    }
  } else {
    pageItem.isSelected = targetState;
    card.classList.toggle('selected', targetState);
    lastSelectedPageIndex = curIndex;
  }
  updateSelectionUI();
}

function setupPagesGridDelegation() {
  pagesGrid.addEventListener('click', (e) => {
    if (e.target.classList.contains('card-title-input')) return;

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const card = actionEl.closest('.page-card');
    if (!card) return;
    const curIdx = parseInt(card.dataset.index, 10);
    const pageItem = state.pages[curIdx];
    if (!pageItem) return;

    const action = actionEl.dataset.action;
    e.stopPropagation();

    switch (action) {
      case 'open-tab':
        openPageInNewTab(pageItem, curIdx + 1);
        break;
      case 'rotate':
        rotateCard(card, pageItem);
        break;
      case 'sign':
        openSignStudio(curIdx);
        break;
      case 'zoom':
        openPreviewModal(curIdx);
        break;
      case 'delete':
        deleteSinglePage(card, curIdx);
        break;
      case 'select-card':
        toggleCardSelection(card, pageItem, e);
        break;
      case 'assign-group':
        openAssignModal(pageItem);
        break;
    }
  });

  pagesGrid.addEventListener('change', (e) => {
    if (e.target.classList.contains('card-title-input')) {
      const card = e.target.closest('.page-card');
      if (!card) return;
      const curIdx = parseInt(card.dataset.index, 10);
      const pageItem = state.pages[curIdx];
      if (pageItem) {
        pageItem.title = e.target.value.trim() || `#${curIdx + 1}`;
        if (state.currentModalIndex === curIdx) {
          modalTitleInput.value = pageItem.title;
        }
      }
    }
  });

  pagesGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('card-title-input')) {
      e.target.blur();
    }
  });

  // Kéo-thả sắp xếp trang bằng Event Delegation: 6 listener duy nhất cho cả lưới,
  // thay vì 6 listener/card (500 trang = 3000 listener). Hành vi giữ nguyên bản per-card.
  const resolveDragCard = (e) => (e.target && e.target.closest ? e.target.closest('.page-card') : null);

  pagesGrid.addEventListener('dragstart', (e) => {
    const card = resolveDragCard(e);
    if (!card) return;
    isUserInteracting = true;
    const idx = parseInt(card.dataset.index, 10);
    const draggedPage = state.pages[idx];

    state.draggedIndex = idx;

    // Check if dragging a selected card while multiple cards are selected
    if (draggedPage && draggedPage.isSelected) {
      const selectedPages = state.pages.filter(p => p.isSelected);
      if (selectedPages.length > 1) {
        state.isMultiDragging = true;
        // Mark all selected cards with .dragging
        pagesGrid.querySelectorAll('.page-card.selected').forEach(c => c.classList.add('dragging'));

        // Custom drag ghost badge
        if (e.dataTransfer && e.dataTransfer.setDragImage) {
          const dragGhost = document.createElement('div');
          dragGhost.className = 'multi-drag-badge';
          dragGhost.textContent = `Di chuyển ${selectedPages.length} trang`;
          document.body.appendChild(dragGhost);
          e.dataTransfer.setDragImage(dragGhost, 20, 20);
          setTimeout(() => dragGhost.remove(), 0);
        }
      } else {
        state.isMultiDragging = false;
        card.classList.add('dragging');
      }
    } else {
      state.isMultiDragging = false;
      card.classList.add('dragging');
    }

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', idx);
  });

  pagesGrid.addEventListener('dragend', () => {
    pagesGrid.querySelectorAll('.page-card.dragging, .page-card.drag-over-left, .page-card.drag-over-right').forEach(c => {
      c.classList.remove('dragging', 'drag-over-left', 'drag-over-right');
    });
    state.draggedIndex = null;
    state.isMultiDragging = false;
    isUserInteracting = false;
    setTimeout(() => {
      if (!isUserInteracting) processThumbnailQueue();
    }, 150);
  });

  pagesGrid.addEventListener('dragenter', (e) => {
    const card = resolveDragCard(e);
    if (!card) return;
    // Đệm điểm giữa thẻ để dragover không phải gọi getBoundingClientRect() liên tục
    const rect = card.getBoundingClientRect();
    card._dragMidX = rect.left + rect.width / 2;
  });

  pagesGrid.addEventListener('dragover', (e) => {
    const card = resolveDragCard(e);
    if (!card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const curIndex = parseInt(card.dataset.index, 10);
    if (state.draggedIndex === null || state.draggedIndex === curIndex) {
      return;
    }

    const targetPage = state.pages[curIndex];
    if (state.isMultiDragging && targetPage && targetPage.isSelected) {
      card.classList.remove('drag-over-left', 'drag-over-right');
      return;
    }

    // So sánh toạ độ chuột với điểm giữa thẻ đã lưu đệm từ dragenter, KHÔNG gọi getBoundingClientRect() lặp lại
    const isLeftHalf = card._dragMidX > 0 ? (e.clientX < card._dragMidX) : (e.offsetX < card.offsetWidth / 2);

    if (isLeftHalf) {
      if (!card.classList.contains('drag-over-left')) {
        card.classList.add('drag-over-left');
        card.classList.remove('drag-over-right');
      }
    } else {
      if (!card.classList.contains('drag-over-right')) {
        card.classList.add('drag-over-right');
        card.classList.remove('drag-over-left');
      }
    }
  });

  pagesGrid.addEventListener('dragleave', (e) => {
    const card = resolveDragCard(e);
    if (!card) return;
    card.classList.remove('drag-over-left', 'drag-over-right');
  });

  pagesGrid.addEventListener('drop', (e) => {
    const card = resolveDragCard(e);
    if (!card) return;
    e.preventDefault();
    card.classList.remove('drag-over-left', 'drag-over-right');

    const toIndex = parseInt(card.dataset.index, 10);
    const targetPage = state.pages[toIndex];
    if (!targetPage) return;

    saveHistoryState();

    const isLeftHalf = card._dragMidX > 0 ? (e.clientX < card._dragMidX) : (e.offsetX < card.offsetWidth / 2);

    if (state.isMultiDragging) {
      // Multi-page drag & drop: In-Place DOM Reorder bằng DocumentFragment (<16ms, không renderGrid)
      if (targetPage.isSelected) return; // Dropping on self

      const selectedPages = state.pages.filter(p => p.isSelected);
      const otherPages = state.pages.filter(p => !p.isSelected);

      let targetPos = otherPages.indexOf(targetPage);
      if (targetPos === -1) return;

      if (!isLeftHalf) {
        targetPos += 1;
      }

      // Gom các thẻ DOM đang chọn và di chuyển trực tiếp
      const selectedCards = selectedPages.map(p => pagesGrid.querySelector(`.page-card[data-page-id="${p.id}"]`)).filter(Boolean);
      const fragment = document.createDocumentFragment();
      selectedCards.forEach(c => fragment.appendChild(c));

      if (isLeftHalf) {
        card.before(fragment);
      } else {
        card.after(fragment);
      }

      otherPages.splice(targetPos, 0, ...selectedPages);
      state.pages = otherPages;

      // Cập nhật lại chỉ số dataset.index và số thứ tự trang cho toàn bộ thẻ DOM
      const allCards = pagesGrid.querySelectorAll('.page-card');
      for (let i = 0; i < allCards.length; i++) {
        const c = allCards[i];
        c.dataset.index = i;
        const badge = c.querySelector('.card-num-badge');
        if (badge) badge.textContent = `#${i + 1}`;
        const titleInput = c.querySelector('.card-title-input');
        const pageObj = state.pages[i];
        if (titleInput && pageObj && (!pageObj.title || pageObj.title.startsWith('#'))) {
          pageObj.title = `#${i + 1}`;
          titleInput.value = pageObj.title;
        }
      }

      showToast(`Đã di chuyển ${selectedPages.length} trang tới vị trí mới!`, 'success');
    } else {
      // Single-page drag & drop: Cập nhật DOM trực tiếp (In-Place DOM Reorder)
      const fromIndex = state.draggedIndex;
      if (fromIndex === null || fromIndex === toIndex) return;

      let targetIndex = isLeftHalf ? toIndex : toIndex + 1;
      if (fromIndex < targetIndex) {
        targetIndex--;
      }

      if (fromIndex === targetIndex) return;

      const [movedPage] = state.pages.splice(fromIndex, 1);
      state.pages.splice(targetIndex, 0, movedPage);

      const draggedCard = pagesGrid.querySelector(`.page-card[data-page-id="${movedPage.id}"]`);
      if (draggedCard && card) {
        if (fromIndex < targetIndex) {
          card.after(draggedCard);
        } else {
          card.before(draggedCard);
        }

        // Cập nhật lại chỉ số dataset.index và số thứ tự trang cho dải thẻ bị ảnh hưởng
        const minIdx = Math.min(fromIndex, targetIndex);
        const maxIdx = Math.max(fromIndex, targetIndex);
        const allCards = pagesGrid.querySelectorAll('.page-card');
        for (let i = minIdx; i <= maxIdx; i++) {
          const c = allCards[i];
          if (c) {
            c.dataset.index = i;
            const badge = c.querySelector('.card-num-badge');
            if (badge) badge.textContent = `#${i + 1}`;
            const titleInput = c.querySelector('.card-title-input');
            const pageObj = state.pages[i];
            if (titleInput && pageObj && (!pageObj.title || pageObj.title.startsWith('#'))) {
              pageObj.title = `#${i + 1}`;
              titleInput.value = pageObj.title;
            }
          }
        }
      } else {
        renderGrid();
      }

      showToast(`Đã di chuyển trang tới vị trí #${targetIndex + 1}`, 'success');
    }
  });
}

function createCardElement(pageItem, index) {
  const cardTemplate = document.getElementById('cardTemplate');
  let card;
  if (cardTemplate && cardTemplate.content && cardTemplate.content.firstElementChild) {
    card = cardTemplate.content.firstElementChild.cloneNode(true);
  } else {
    card = document.createElement('div');
    card.className = 'page-card';
    card.draggable = true;
  }
  if (pageItem.isSelected) card.classList.add('selected');
  card.dataset.index = index;
  card.dataset.pageId = pageItem.id;

  const checkbox = card.querySelector('.custom-checkbox');
  if (checkbox) checkbox.checked = pageItem.isSelected;

  const badge = card.querySelector('.card-num-badge');
  if (badge) badge.textContent = `#${index + 1}`;

  if (pageItem.stamps && pageItem.stamps.length > 0) {
    const leftHeader = card.querySelector('.card-header-left');
    if (leftHeader) {
      const signedBadge = document.createElement('span');
      signedBadge.className = 'card-signed-badge';
      signedBadge.title = `Trang này có ${pageItem.stamps.length} chữ ký / con dấu`;
      signedBadge.innerHTML = `🖋️ ${pageItem.stamps.length}`;
      leftHeader.appendChild(signedBadge);
    }
  }

  const titleInput = card.querySelector('.card-title-input');
  if (titleInput) titleInput.value = pageItem.title || `#${index + 1}`;

  const skelSpan = card.querySelector('.card-thumbnail-skeleton span');
  if (skelSpan) skelSpan.textContent = `#${index + 1}`;

  const thumbWrapper = card.querySelector('.card-thumbnail-wrapper');
  if (thumbWrapper) thumbnailObserver.observe(thumbWrapper);

  const groupWrapper = card.querySelector('.card-groups-wrapper');
  if (groupWrapper) renderCardGroupPills(pageItem, groupWrapper);

  const srcObj = state.sources.get(pageItem.sourceId);
  const sourceTag = card.querySelector('.card-source-tag');
  if (sourceTag && srcObj) {
    sourceTag.textContent = srcObj.name;
    sourceTag.title = srcObj.name;
  }

  const dimTag = card.querySelector('.card-dim-tag');
  if (dimTag) {
    const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
    const currentW = isSwapped ? pageItem.height : pageItem.width;
    const currentH = isSwapped ? pageItem.width : pageItem.height;
    dimTag.textContent = `${currentW} × ${currentH} pt`;
  }

  return card;
}

// ==========================================================================
// Concurrency-Limited Background Thumbnail Rendering with ImageBitmap
// ==========================================================================

function enqueueThumbnailRender(pageItem, canvas, card, highPriority = false) {
  if (!pageItem || !canvas || !card) return;
  const cacheKey = `${pageItem.id}_${pageItem.rotation}`;

  if (thumbnailCache.has(cacheKey)) {
    const cached = thumbnailCache.get(cacheKey);
    requestAnimationFrame(() => {
      if (!document.body.contains(canvas)) return;
      canvas.width = cached.width;
      canvas.height = cached.height;
      const ctx = canvas.getContext('2d');
      if (cached.bitmap) {
        ctx.drawImage(cached.bitmap, 0, 0);
      } else if (cached.canvas) {
        ctx.drawImage(cached.canvas, 0, 0);
      }
      if (pageItem.stamps && pageItem.stamps.length > 0) {
        drawStampsOnCanvas(ctx, pageItem.stamps, canvas.width, canvas.height);
      }
      const skeleton = card.querySelector('.card-thumbnail-skeleton');
      if (skeleton) skeleton.style.display = 'none';
      canvas.style.opacity = '1';
      card.dataset.thumbRendered = 'true';
    });
    return;
  }

  // Tránh lặp tác vụ trong hàng đợi, ưu tiên đưa lên đầu nếu thẻ nhìn thấy thực tế
  const existingIdx = thumbnailRenderQueue.findIndex(t => t.pageItem.id === pageItem.id && t.pageItem.rotation === pageItem.rotation);
  if (existingIdx !== -1) {
    if (highPriority && existingIdx > 0) {
      const [t] = thumbnailRenderQueue.splice(existingIdx, 1);
      thumbnailRenderQueue.unshift(t);
    }
    return;
  }

  if (highPriority) {
    thumbnailRenderQueue.unshift({ pageItem, canvas, card });
  } else {
    thumbnailRenderQueue.push({ pageItem, canvas, card });
  }
  processThumbnailQueue();
}

async function processThumbnailQueue() {
  if (isUserInteracting || activeThumbnailRenders >= MAX_CONCURRENT_THUMBNAILS || thumbnailRenderQueue.length === 0) {
    return;
  }

  activeThumbnailRenders++;
  const task = thumbnailRenderQueue.shift();
  // Card đã rời DOM trong lúc chờ (xóa/lọc trang) -> bỏ qua, không decode vô ích
  if (!document.body.contains(task.canvas)) {
    activeThumbnailRenders--;
    processThumbnailQueue();
    return;
  }

  try {
    await renderThumbnailAsync(task.pageItem, task.canvas, task.card);
  } catch (err) {
    console.error('Lỗi khi render thumbnail:', err);
  } finally {
    activeThumbnailRenders--;
    processThumbnailQueue();
  }
}

async function renderThumbnailAsync(pageItem, canvas, card) {
  const srcObj = state.sources.get(pageItem.sourceId);
  if (!srcObj) return;

  const cacheKey = `${pageItem.id}_${pageItem.rotation}`;
  const page = await srcObj.pdfJsDoc.getPage(pageItem.pageIndex + 1);

  // Cập nhật kích thước thực tế trang
  const unscaledVp = page.getViewport({ scale: 1.0 });
  pageItem.width = Math.round(unscaledVp.width);
  pageItem.height = Math.round(unscaledVp.height);

  const dimTag = card.querySelector('.card-dim-tag');
  if (dimTag) {
    const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
    const currentW = isSwapped ? pageItem.height : pageItem.width;
    const currentH = isSwapped ? pageItem.width : pageItem.height;
    dimTag.textContent = `${currentW} × ${currentH} pt`;
  }

  const rotation = (page.rotate + pageItem.rotation) % 360;
  // Giảm scale từ 0.45 xuống 0.32 giúp tiết kiệm ~50% VRAM/RAM và tăng tốc render PDF.js ~40%
  const viewport = page.getViewport({ scale: 0.32, rotation });

  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const offW = Math.max(1, Math.floor(viewport.width));
  const offH = Math.max(1, Math.floor(viewport.height));
  const offscreen = useOffscreen ? new OffscreenCanvas(offW, offH) : document.createElement('canvas');
  if (!useOffscreen) {
    offscreen.width = offW;
    offscreen.height = offH;
  }
  const offCtx = offscreen.getContext('2d');

  // Hủy render cũ còn dở trên cùng canvas (cuộn nhanh) để GPU không decode frame sẽ bị vứt đi
  try {
    if (canvas._pdfRenderTask && typeof canvas._pdfRenderTask.cancel === 'function') canvas._pdfRenderTask.cancel();
  } catch (e) { /* bỏ qua */ }

  const renderTask = page.render({
    canvasContext: offCtx,
    viewport: viewport,
  });
  canvas._pdfRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    throw e;
  } finally {
    if (typeof page.cleanup === 'function') { try { page.cleanup(); } catch (_) {} }
    if (canvas._pdfRenderTask === renderTask) canvas._pdfRenderTask = null;
  }
  // Tác vụ mới hơn đã chiếm canvas trong lúc chờ -> bỏ kết quả cũ, tránh vẽ đè frame mới
  if (canvas._pdfRenderTask) return;

  let bitmap = null;
  if (window.createImageBitmap) {
    try {
      bitmap = await createImageBitmap(offscreen);
    } catch (e) {
      bitmap = null;
    }
  }

  const entry = {
    bitmap: bitmap,
    canvas: bitmap ? null : offscreen,
    width: offscreen.width,
    height: offscreen.height
  };
  thumbnailCache.set(cacheKey, entry);

  // Giải phóng ngay bề mặt offscreen canvas để GPU process của Chrome thu hồi VRAM lập tức
  if (bitmap) {
    offscreen.width = 0;
    offscreen.height = 0;
  }

  if (document.body.contains(canvas)) {
    requestAnimationFrame(() => {
      if (!document.body.contains(canvas)) return;
      canvas.width = entry.width;
      canvas.height = entry.height;
      const ctx = canvas.getContext('2d');
      if (entry.bitmap) {
        ctx.drawImage(entry.bitmap, 0, 0);
      } else if (entry.canvas) {
        ctx.drawImage(entry.canvas, 0, 0);
      }
      if (pageItem.stamps && pageItem.stamps.length > 0) {
        drawStampsOnCanvas(ctx, pageItem.stamps, canvas.width, canvas.height);
      }
      canvas.style.opacity = '1';
      const skeleton = card.querySelector('.card-thumbnail-skeleton');
      if (skeleton) skeleton.style.display = 'none';
      card.dataset.thumbRendered = 'true';
    });
  }
}

// ==========================================================================
// Smooth Drag and Drop Logic
// ==========================================================================

// (đã chuyển sang event delegation trong setupPagesGridDelegation — 0 listener/card)

// ==========================================================================
// Fullscreen Preview Modal, LRU Cache & Open Single Page in New Tab
// ==========================================================================

async function renderPageToCache(pageIndex) {
  if (pageIndex < 0 || pageIndex >= state.pages.length) return null;
  const pageItem = state.pages[pageIndex];
  const srcObj = state.sources.get(pageItem.sourceId);
  if (!srcObj) return null;

  const cacheKey = `${pageItem.id}_${pageItem.rotation}_hd`;
  if (previewCache.has(cacheKey)) {
    return previewCache.get(cacheKey);
  }

  let page = null;
  try {
    page = await srcObj.pdfJsDoc.getPage(pageItem.pageIndex + 1);
    const rotation = (page.rotate + pageItem.rotation) % 360;

    // Giới hạn scale thông minh: Tối đa 1920px để tránh ngốn bộ nhớ GPU/RAM trong Chrome
    const unscaledVp = page.getViewport({ scale: 1.0, rotation });
    const maxDim = Math.max(unscaledVp.width, unscaledVp.height);
    const targetScale = Math.min(2.0, Math.max(1.2, 1920 / maxDim));
    const viewport = page.getViewport({ scale: targetScale, rotation });

    const useOffscreen = typeof OffscreenCanvas !== 'undefined';
    const offW = Math.max(1, Math.floor(viewport.width));
    const offH = Math.max(1, Math.floor(viewport.height));
    const offscreen = useOffscreen ? new OffscreenCanvas(offW, offH) : document.createElement('canvas');
    if (!useOffscreen) {
      offscreen.width = offW;
      offscreen.height = offH;
    }
    const offCtx = offscreen.getContext('2d');

    await page.render({
      canvasContext: offCtx,
      viewport: viewport,
    }).promise;

    let bitmap = null;
    if (window.createImageBitmap) {
      try {
        bitmap = await createImageBitmap(offscreen);
      } catch (e) {
        bitmap = null;
      }
    }

    // Chỉ giữ 1 bản: bitmap (GPU) hoặc canvas (fallback) — không giữ cả hai để giảm ~50% RAM preview HD
    const entry = {
      canvas: bitmap ? null : offscreen,
      bitmap: bitmap,
      width: viewport.width,
      height: viewport.height,
    };
    if (bitmap) {
      offscreen.width = 0;
      offscreen.height = 0;
    }
    previewCache.set(cacheKey, entry);
    return entry;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') {
      return null;
    }
    console.error('Error rendering page to cache:', err);
    return null;
  } finally {
    if (page && typeof page.cleanup === 'function') {
      try { page.cleanup(); } catch (_) {}
    }
  }
}

function prefetchAdjacentPages(currentIndex) {
  const runPrefetch = () => {
    const nextIdx = currentIndex + 1;
    const prevIdx = currentIndex - 1;

    if (nextIdx < state.pages.length) {
      const nextItem = state.pages[nextIdx];
      const nextKey = `${nextItem.id}_${nextItem.rotation}_hd`;
      if (!previewCache.has(nextKey)) {
        renderPageToCache(nextIdx);
      }
    }

    if (prevIdx >= 0) {
      const prevItem = state.pages[prevIdx];
      const prevKey = `${prevItem.id}_${prevItem.rotation}_hd`;
      if (!previewCache.has(prevKey)) {
        renderPageToCache(prevIdx);
      }
    }
  };

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(runPrefetch, { timeout: 1000 });
  } else {
    setTimeout(runPrefetch, 80);
  }
}

async function openPageInNewTab(pageItem, pageNum) {
  try {
    showToast(`Đang mở trang #${pageNum} trong tab mới...`, 'success');
    const srcObj = state.sources.get(pageItem.sourceId);
    if (!srcObj) return;

    await ensurePdfLibLoaded();
    const outPdf = await PDFLib.PDFDocument.create();
    const pdfLibDoc = await getSourcePdfLibDoc(srcObj);
    const [copiedPage] = await outPdf.copyPages(pdfLibDoc, [pageItem.pageIndex]);

    if (pageItem.rotation !== 0) {
      const currentRot = copiedPage.getRotation().angle;
      copiedPage.setRotation(PDFLib.degrees((currentRot + pageItem.rotation) % 360));
    }

    if (pageItem.stamps && pageItem.stamps.length > 0) {
      await embedStampsOnPdfPage(outPdf, copiedPage, pageItem.stamps);
    }

    outPdf.addPage(copiedPage);
    const pdfBytes = await outPdf.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Tab mới cần thời gian tải blob -> thu hồi muộn (60s) để không leak URL/blob mỗi lần mở
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.error('Lỗi khi mở trang trong tab mới:', err);
    showToast('Lỗi khi mở trang: ' + err.message, 'danger');
  }
}

async function openPreviewModal(pageIndex) {
  if (pageIndex < 0 || pageIndex >= state.pages.length) return;

  state.currentModalIndex = pageIndex;
  currentModalRenderIndex = pageIndex;
  const pageItem = state.pages[pageIndex];
  const pageNum = pageIndex + 1;
  const srcObj = state.sources.get(pageItem.sourceId);
  if (!srcObj) return;

  modalPageNumBadge.textContent = `#${pageNum}`;
  modalTitleInput.value = pageItem.title || `#${pageNum}`;
  if (modalPageInfo) {
    modalPageInfo.textContent = `${srcObj.name} • ${pageNum}/${state.pages.length}`;
  }

  if (modalPrevPage) modalPrevPage.disabled = pageIndex === 0;
  if (modalNextPage) modalNextPage.disabled = pageIndex === state.pages.length - 1;

  previewModal.classList.add('active');

  const cacheKey = `${pageItem.id}_${pageItem.rotation}_hd`;

  // 1. Nếu đã có bản HD sắc nét trong previewCache -> Hiển thị ngay
  if (previewCache.has(cacheKey)) {
    const cached = previewCache.get(cacheKey);
    if (modalSpinner) modalSpinner.style.display = 'none';
    modalCanvas.style.opacity = '1';
    modalCanvas.width = cached.width;
    modalCanvas.height = cached.height;
    const ctx = modalCanvas.getContext('2d');
    if (cached.bitmap) {
      ctx.drawImage(cached.bitmap, 0, 0);
    } else {
      ctx.drawImage(cached.canvas, 0, 0);
    }
    if (pageItem.stamps && pageItem.stamps.length > 0) {
      drawStampsOnCanvas(ctx, pageItem.stamps, modalCanvas.width, modalCanvas.height);
    }
    prefetchAdjacentPages(pageIndex);
    return;
  }

  // 2. Nếu chưa có HD, kiểm tra xem đã có ảnh thumbnail chưa -> HIỂN THỊ NGAY TỨC THÌ (0ms lag!)
  const thumbKey = `${pageItem.id}_${pageItem.rotation}`;
  if (thumbnailCache.has(thumbKey)) {
    const thumb = thumbnailCache.get(thumbKey);
    modalCanvas.width = thumb.width;
    modalCanvas.height = thumb.height;
    const ctx = modalCanvas.getContext('2d');
    if (thumb.bitmap) {
      ctx.drawImage(thumb.bitmap, 0, 0);
    } else if (thumb.canvas) {
      ctx.drawImage(thumb.canvas, 0, 0);
    }
    if (pageItem.stamps && pageItem.stamps.length > 0) {
      drawStampsOnCanvas(ctx, pageItem.stamps, modalCanvas.width, modalCanvas.height);
    }
    modalCanvas.style.opacity = '1';
    if (modalSpinner) modalSpinner.style.display = 'none';
  } else {
    modalCanvas.style.opacity = '0.2';
    if (modalSpinner) modalSpinner.style.display = 'flex';
  }

  // 3. Tiến hành render bản HD trong nền và thay thế mượt mà khi hoàn tất
  try {
    const entry = await renderPageToCache(pageIndex);
    if (state.currentModalIndex !== pageIndex || currentModalRenderIndex !== pageIndex) {
      return;
    }

    if (entry) {
      modalCanvas.width = entry.width;
      modalCanvas.height = entry.height;
      const ctx = modalCanvas.getContext('2d');
      if (entry.bitmap) {
        ctx.drawImage(entry.bitmap, 0, 0);
      } else {
        ctx.drawImage(entry.canvas, 0, 0);
      }
      if (pageItem.stamps && pageItem.stamps.length > 0) {
        drawStampsOnCanvas(ctx, pageItem.stamps, modalCanvas.width, modalCanvas.height);
      }
      modalCanvas.style.opacity = '1';
    }

    if (modalSpinner) modalSpinner.style.display = 'none';
    prefetchAdjacentPages(pageIndex);
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('Lỗi khi hiển thị trang xem trước:', err);
    if (modalSpinner) modalSpinner.style.display = 'none';
  }
}

// ==========================================================================
// Exporting PDF
// ==========================================================================

async function exportPdfFromPages(pagesToExport, outputFileName, showNotification = true) {
  if (pagesToExport.length === 0) {
    alert('Không có trang nào để xuất!');
    return;
  }

  if (showNotification) {
    showToast('Đang tạo và xử lý tệp PDF...', 'success');
  }

  try {
    await ensurePdfLibLoaded();
    const outPdf = await PDFLib.PDFDocument.create();

    // Gom nhóm các trang theo tài liệu nguồn để batch copyPages một lần duy nhất (nhanh gấp 3-5 lần)
    const pagesBySource = new Map();
    pagesToExport.forEach(item => {
      if (!pagesBySource.has(item.sourceId)) {
        pagesBySource.set(item.sourceId, []);
      }
      pagesBySource.get(item.sourceId).push(item);
    });

    const copiedPagesMap = new Map();
    for (const [sourceId, items] of pagesBySource.entries()) {
      const srcObj = state.sources.get(sourceId);
      if (!srcObj) continue;
      const pdfLibDoc = await getSourcePdfLibDoc(srcObj);
      const uniqueIndices = Array.from(new Set(items.map(it => it.pageIndex)));
      const copiedBatch = await outPdf.copyPages(pdfLibDoc, uniqueIndices);
      uniqueIndices.forEach((pIdx, idx) => {
        copiedPagesMap.set(`${sourceId}_${pIdx}`, copiedBatch[idx]);
      });
    }

    for (const item of pagesToExport) {
      let copiedPage = copiedPagesMap.get(`${item.sourceId}_${item.pageIndex}`);
      if (!copiedPage) {
        const srcObj = state.sources.get(item.sourceId);
        const pdfLibDoc = await getSourcePdfLibDoc(srcObj);
        [copiedPage] = await outPdf.copyPages(pdfLibDoc, [item.pageIndex]);
      }

      if (item.rotation !== 0) {
        const currentRot = copiedPage.getRotation().angle;
        copiedPage.setRotation(PDFLib.degrees((currentRot + item.rotation) % 360));
      }

      if (item.stamps && item.stamps.length > 0) {
        await embedStampsOnPdfPage(outPdf, copiedPage, item.stamps);
      }

      outPdf.addPage(copiedPage);
    }

    applyDocMeta(outPdf);
    const pdfBytes = await outPdf.save();
    downloadBlob(pdfBytes, outputFileName);

    if (showNotification) {
      showToast(`Đã xuất thành công tệp: ${outputFileName}!`, 'success');
    }
  } catch (err) {
    console.error('Lỗi khi xuất PDF:', err);
    showToast('Lỗi khi xuất file: ' + err.message, 'danger');
  }
}

function downloadBlob(data, fileName, mimeType) {
  const blob = new Blob([data], { type: mimeType || 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================================================
// PDF Compression & Optimization Engine
// ==========================================================================

function setupCompressEvents() {
  if (!btnOpenCompressModal) return;

  const closeCompressModal = () => {
    if (btnExecuteCompress && btnExecuteCompress.disabled) {
      // Currently processing compression, prevent accidental close
      return;
    }
    compressModal.classList.remove('active');
  };

  btnOpenCompressModal.addEventListener('click', () => {
    if (state.pages.length === 0) {
      showToast('Chưa có trang nào trong tài liệu để nén và xuất!', 'danger');
      return;
    }
    compressProgressBox.style.display = 'none';
    btnExecuteCompress.disabled = false;
    btnCancelCompress.disabled = false;
    compressModal.classList.add('active');
  });

  compressModalClose.addEventListener('click', closeCompressModal);
  compressModalBackdrop.addEventListener('click', closeCompressModal);
  btnCancelCompress.addEventListener('click', closeCompressModal);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && compressModal.classList.contains('active')) {
      closeCompressModal();
    }
  });

  // DPI Range Slider & Quick Buttons
  dpiRange.addEventListener('input', () => {
    const val = dpiRange.value;
    dpiDisplayValue.textContent = `${val} DPI`;
    dpiQuickBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.dpi === String(val));
    });
    updatePresetActiveStatus(null);
  });

  dpiQuickBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const dpi = btn.dataset.dpi;
      dpiRange.value = dpi;
      dpiDisplayValue.textContent = `${dpi} DPI`;
      dpiQuickBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updatePresetActiveStatus(null);
    });
  });

  // Quality Range Slider
  const updateQualityDesc = (val) => {
    qualityDisplayValue.textContent = `${val}%`;
    if (val < 40) {
      qualityStatusText.textContent = `${val}% (Nén tối đa - Dung lượng siêu nhỏ)`;
      qualityStatusText.style.color = '#fbbf24';
    } else if (val <= 65) {
      qualityStatusText.textContent = `${val}% (Tiết kiệm dung lượng - Vừa phải)`;
      qualityStatusText.style.color = '#38bdf8';
    } else if (val <= 85) {
      qualityStatusText.textContent = `${val}% (Cân bằng tối ưu - Khuyên dùng)`;
      qualityStatusText.style.color = '#a5b4fc';
    } else {
      qualityStatusText.textContent = `${val}% (Chất lượng rất cao - Gần nguyên bản)`;
      qualityStatusText.style.color = '#34d399';
    }
  };

  qualityRange.addEventListener('input', () => {
    updateQualityDesc(qualityRange.value);
    updatePresetActiveStatus(null);
  });

  // Preset Handlers
  const setPreset = (presetName, dpiVal, qualityVal, isGrayscale) => {
    dpiRange.value = dpiVal;
    dpiDisplayValue.textContent = `${dpiVal} DPI`;
    dpiQuickBtns.forEach(b => b.classList.toggle('active', b.dataset.dpi === String(dpiVal)));

    qualityRange.value = qualityVal;
    updateQualityDesc(qualityVal);

    if (optGrayscale) optGrayscale.checked = isGrayscale;
    // Set all other 13 advanced options to active
    [
      optRemoveThumbnails, optDedupStreams, optRasterizeHeavy, optSubsetFonts,
      optModernCompression, optMaxFlate, optFlattenForms, optRemoveOutputIntents,
      optRemoveAttachments, optRemoveAnnotations, optRemoveOutlines,
      optRemoveMetadata, optRemoveStructureTree
    ].forEach(chk => { if (chk) chk.checked = true; });

    updatePresetActiveStatus(presetName);
  };

  const updatePresetActiveStatus = (activePreset) => {
    [presetBalanced, presetMaxCompress, presetHighQuality].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
    if (activePreset === 'balanced' && presetBalanced) presetBalanced.classList.add('active');
    if (activePreset === 'max' && presetMaxCompress) presetMaxCompress.classList.add('active');
    if (activePreset === 'hq' && presetHighQuality) presetHighQuality.classList.add('active');
  };

  presetBalanced.addEventListener('click', () => {
    setPreset('balanced', 150, 75, false);
  });

  presetMaxCompress.addEventListener('click', () => {
    setPreset('max', 96, 40, true);
  });

  presetHighQuality.addEventListener('click', () => {
    setPreset('hq', 300, 90, false);
  });

  // Execute Compression Button
  btnExecuteCompress.addEventListener('click', () => {
    if (state.pages.length === 0) {
      showToast('Chưa có trang nào để nén và xuất!', 'danger');
      return;
    }

    const options = {
      dpi: parseInt(dpiRange.value, 10) || 150,
      quality: (parseInt(qualityRange.value, 10) || 75) / 100.0,
      removeThumbnails: optRemoveThumbnails ? optRemoveThumbnails.checked : true,
      dedupStreams: optDedupStreams ? optDedupStreams.checked : true,
      rasterizeHeavy: optRasterizeHeavy ? optRasterizeHeavy.checked : true,
      subsetFonts: optSubsetFonts ? optSubsetFonts.checked : true,
      modernCompression: optModernCompression ? optModernCompression.checked : true,
      grayscale: optGrayscale ? optGrayscale.checked : false,
      maxFlate: optMaxFlate ? optMaxFlate.checked : true,
      flattenForms: optFlattenForms ? optFlattenForms.checked : true,
      removeOutputIntents: optRemoveOutputIntents ? optRemoveOutputIntents.checked : true,
      removeAttachments: optRemoveAttachments ? optRemoveAttachments.checked : true,
      removeAnnotations: optRemoveAnnotations ? optRemoveAnnotations.checked : true,
      removeOutlines: optRemoveOutlines ? optRemoveOutlines.checked : true,
      removeMetadata: optRemoveMetadata ? optRemoveMetadata.checked : true,
      removeStructureTree: optRemoveStructureTree ? optRemoveStructureTree.checked : true,
    };

    let fileName = 'crafted_document_compressed.pdf';
    if (state.sources.size === 1) {
      const srcName = Array.from(state.sources.values())[0].name;
      const baseName = srcName.replace(/\.pdf$/i, '');
      fileName = `${baseName}_compressed.pdf`;
    }

    executeCompressAndExport(state.pages, fileName, options);
  });
}

async function executeCompressAndExport(pagesToExport, outputFileName, options) {
  if (pagesToExport.length === 0) {
    showToast('Không có trang nào để xuất!', 'danger');
    return;
  }

  compressProgressBox.style.display = 'block';
  btnExecuteCompress.disabled = true;
  btnCancelCompress.disabled = true;

  const updateProgress = (current, total, text) => {
    const pct = Math.round((current / total) * 100);
    compressProgressText.textContent = text || `Đang nén song song trang ${current}/${total}...`;
    compressProgressPercent.textContent = `${pct}%`;
    compressProgressFill.style.width = `${pct}%`;
  };

  updateProgress(0, pagesToExport.length, 'Khởi động hồ tiến trình song song (Concurrency Pool)...');
  await new Promise(r => setTimeout(r, 40));

  try {
    await ensurePdfLibLoaded();
    const outPdf = await PDFLib.PDFDocument.create();

    // Bounded Concurrency Pool: Chạy tối đa 3 worker song song
    // Vừa tăng tốc gấp 2.5x-3x, vừa kiểm soát RAM và CPU chặt chẽ, không gây giật lag
    const maxConcurrent = Math.min(
      navigator.hardwareConcurrency ? Math.max(2, navigator.hardwareConcurrency - 1) : 3,
      3
    );

    const renderedPages = new Array(pagesToExport.length);
    let nextTaskIdx = 0;
    let completedCount = 0;

    const processWorker = async () => {
      while (nextTaskIdx < pagesToExport.length) {
        const taskIndex = nextTaskIdx++;
        const item = pagesToExport[taskIndex];
        const srcObj = state.sources.get(item.sourceId);

        if (options.rasterizeHeavy) {
          const pdfJsDoc = srcObj.pdfJsDoc;
          const page = await pdfJsDoc.getPage(item.pageIndex + 1);
          try {
            const dpi = options.dpi || 150;
            const scale = dpi / 72.0;
            const totalRotation = ((item.rotation || 0) % 360 + 360) % 360;

            const viewport = page.getViewport({ scale: scale, rotation: totalRotation });

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            const ctx = canvas.getContext('2d', { alpha: false });

            // Nền trắng tinh khôi chuẩn nén JPEG
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({
              canvasContext: ctx,
              viewport: viewport
            }).promise;

            if (item.stamps && item.stamps.length > 0) {
              await drawStampsOnCanvasAsync(ctx, item.stamps, canvas.width, canvas.height);
            }

            // Chuyển sang thang xám bằng GPU shader native filter (tối ưu hóa 100% phần cứng, không dùng CPU loop)
            if (options.grayscale) {
              const grayCanvas = document.createElement('canvas');
              grayCanvas.width = canvas.width;
              grayCanvas.height = canvas.height;
              const grayCtx = grayCanvas.getContext('2d');
              grayCtx.filter = 'grayscale(100%)';
              grayCtx.drawImage(canvas, 0, 0);
              ctx.drawImage(grayCanvas, 0, 0);
              grayCanvas.width = 0;
              grayCanvas.height = 0;
            }

            // Nén ảnh JPEG ở mức chất lượng yêu cầu bằng native toBlob (tối ưu hóa luồng bộ nhớ, không tạo chuỗi Base64)
            const quality = Math.max(0.1, Math.min(1.0, options.quality || 0.75));
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            const arrayBuffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);

            const unscaledViewport = page.getViewport({ scale: 1.0, rotation: totalRotation });
            renderedPages[taskIndex] = {
              type: 'raster',
              bytes: bytes,
              width: unscaledViewport.width,
              height: unscaledViewport.height
            };

            // Giải phóng canvas ngay lập tức để tiết kiệm bộ nhớ RAM
            canvas.width = 0;
            canvas.height = 0;
          } finally {
            if (page && typeof page.cleanup === 'function') {
              try { page.cleanup(); } catch (_) {}
            }
          }
        } else {
          renderedPages[taskIndex] = {
            type: 'vector',
            item: item,
            srcObj: srcObj
          };
        }

        completedCount++;
        updateProgress(
          completedCount,
          pagesToExport.length,
          `Đang xử lý song song trang ${completedCount}/${pagesToExport.length}...`
        );
        await new Promise(r => setTimeout(r, 5));
      }
    };

    // Khởi động các worker song song
    const workerPromises = [];
    const numWorkers = Math.min(maxConcurrent, pagesToExport.length);
    for (let w = 0; w < numWorkers; w++) {
      workerPromises.push(processWorker());
    }
    await Promise.all(workerPromises);

    // Ghép nối các trang vào tài liệu theo đúng thứ tự ban đầu
    updateProgress(pagesToExport.length, pagesToExport.length, 'Đang ghép nối các trang tài liệu...');
    await new Promise(r => setTimeout(r, 10));

    for (let i = 0; i < renderedPages.length; i++) {
      const pageResult = renderedPages[i];
      if (pageResult.type === 'raster') {
        const embeddedImg = await outPdf.embedJpg(pageResult.bytes);
        const newPage = outPdf.addPage([pageResult.width, pageResult.height]);
        newPage.drawImage(embeddedImg, {
          x: 0,
          y: 0,
          width: pageResult.width,
          height: pageResult.height,
        });
      } else {
        const item = pageResult.item;
        const srcObj = pageResult.srcObj;
        const pdfLibDoc = await getSourcePdfLibDoc(srcObj);
        const [copiedPage] = await outPdf.copyPages(pdfLibDoc, [item.pageIndex]);
        if (item.rotation !== 0) {
          const currentRot = copiedPage.getRotation().angle;
          copiedPage.setRotation(PDFLib.degrees((currentRot + item.rotation) % 360));
        }
        if (item.stamps && item.stamps.length > 0) {
          await embedStampsOnPdfPage(outPdf, copiedPage, item.stamps);
        }
        outPdf.addPage(copiedPage);
      }
    }

    updateProgress(pagesToExport.length, pagesToExport.length, 'Đang loại bỏ siêu dữ liệu và tối ưu cấu trúc...');
    await new Promise(r => setTimeout(r, 15));

    // Advanced Dictionary & Metadata stripping
    if (options.removeMetadata) {
      try {
        outPdf.setTitle('');
        outPdf.setAuthor('');
        outPdf.setSubject('');
        outPdf.setKeywords([]);
        outPdf.setProducer('PDF Craft Optimizer');
        outPdf.setCreator('PDF Craft');
        if (outPdf.catalog && typeof outPdf.catalog.delete === 'function' && PDFLib.PDFName) {
          outPdf.catalog.delete(PDFLib.PDFName.of('Metadata'));
        }
      } catch (e) {
        console.warn('Bỏ qua Metadata:', e);
      }
    }

    if (options.removeOutlines) {
      try {
        if (outPdf.catalog && typeof outPdf.catalog.delete === 'function' && PDFLib.PDFName) {
          outPdf.catalog.delete(PDFLib.PDFName.of('Outlines'));
        }
      } catch (e) {
        console.warn('Bỏ qua Outlines:', e);
      }
    }

    if (options.removeStructureTree) {
      try {
        if (outPdf.catalog && typeof outPdf.catalog.delete === 'function' && PDFLib.PDFName) {
          outPdf.catalog.delete(PDFLib.PDFName.of('StructTreeRoot'));
        }
      } catch (e) {
        console.warn('Bỏ qua StructTreeRoot:', e);
      }
    }

    if (options.removeOutputIntents) {
      try {
        if (outPdf.catalog && typeof outPdf.catalog.delete === 'function' && PDFLib.PDFName) {
          outPdf.catalog.delete(PDFLib.PDFName.of('OutputIntents'));
        }
      } catch (e) {
        console.warn('Bỏ qua OutputIntents:', e);
      }
    }

    if (options.removeAttachments) {
      try {
        if (outPdf.catalog && typeof outPdf.catalog.delete === 'function' && PDFLib.PDFName) {
          outPdf.catalog.delete(PDFLib.PDFName.of('Names'));
          outPdf.catalog.delete(PDFLib.PDFName.of('EmbeddedFiles'));
        }
      } catch (e) {
        console.warn('Bỏ qua EmbeddedFiles:', e);
      }
    }

    if (options.flattenForms) {
      try {
        const form = outPdf.getForm();
        if (form && typeof form.flatten === 'function') {
          form.flatten();
        }
      } catch (e) {
        // No forms to flatten
      }
    }

    if (options.removeAnnotations) {
      try {
        outPdf.getPages().forEach(page => {
          if (page.node && typeof page.node.delete === 'function' && PDFLib.PDFName) {
            page.node.delete(PDFLib.PDFName.of('Annots'));
          }
        });
      } catch (e) {
        console.warn('Bỏ qua Annots:', e);
      }
    }

    // Áp metadata tùy chỉnh sau khi strip (giá trị người dùng đặt luôn thắng)
    applyDocMeta(outPdf);

    // Maximum Flate Stream compression
    updateProgress(pagesToExport.length, pagesToExport.length, 'Đang nén Flate luồng dữ liệu & đóng gói...');
    await new Promise(r => setTimeout(r, 15));

    const saveOptions = {
      useObjectStreams: options.maxFlate !== false
    };
    let pdfBytes = await outPdf.save(saveOptions);

    // Tối ưu hóa sâu bằng Goroutine backend qua /api/optimize
    try {
      updateProgress(pagesToExport.length, pagesToExport.length, 'Đang tăng tốc tối ưu bằng Goroutine backend...');
      const resp = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: pdfBytes
      });
      if (resp.ok) {
        const optimizedBuffer = await resp.arrayBuffer();
        if (optimizedBuffer && optimizedBuffer.byteLength > 0) {
          pdfBytes = new Uint8Array(optimizedBuffer);
        }
      }
    } catch (backendErr) {
      console.warn('Goroutine backend optimize bỏ qua, dùng bản nén frontend:', backendErr);
    }

    const compressedSize = pdfBytes.byteLength;
    const formattedSize = formatBytes(compressedSize);

    updateProgress(pagesToExport.length, pagesToExport.length, `Hoàn tất! Dung lượng mới: ${formattedSize}`);
    await new Promise(r => setTimeout(r, 350));

    downloadBlob(pdfBytes, outputFileName);
    showToast(`Đã nén & xuất thành công tệp: ${outputFileName} (${formattedSize})!`, 'success');

    setTimeout(() => {
      compressModal.classList.remove('active');
      btnExecuteCompress.disabled = false;
      btnCancelCompress.disabled = false;
      compressProgressBox.style.display = 'none';
    }, 850);

  } catch (err) {
    console.error('Lỗi trong quá trình nén PDF:', err);
    showToast('Lỗi khi nén PDF: ' + err.message, 'danger');
    compressProgressText.textContent = 'Đã xảy ra lỗi: ' + err.message;
    btnExecuteCompress.disabled = false;
    btnCancelCompress.disabled = false;
  }
}

// ==========================================================================
// Toast Helper
// ==========================================================================

let toastTimer = null;
function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast active toast-${type}`;

  toastTimer = setTimeout(() => {
    toast.classList.remove('active');
  }, 3500);
}

// Xử lý nút Thoát ứng dụng
function setupQuitButton() {
  const btnQuit = document.getElementById('btnQuitApp');
  if (!btnQuit) return;

  btnQuit.addEventListener('click', async () => {
    if (confirm('Bạn có muốn đóng và thoát phần mềm PDF Craft không?')) {
      try {
        await fetch('/api/shutdown', { method: 'POST' });
      } catch (e) {}

      document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#090d16;color:#f8fafc;font-family:'Plus Jakarta Sans',sans-serif;text-align:center;padding:24px;">
          <div style="font-size:54px;margin-bottom:20px;">✨</div>
          <h2 style="font-size:26px;margin-bottom:12px;font-weight:700;background:linear-gradient(135deg, #6366f1, #ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Đã đóng ứng dụng PDF Craft</h2>
          <p style="color:#94a3b8;font-size:16px;max-width:440px;line-height:1.6;margin-bottom:24px;">Máy chủ nội bộ đã ngừng hoạt động thành công. Bạn có thể đóng tab trình duyệt này một cách an toàn.</p>
          <div style="font-size:13px;color:#64748b;padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);">Cảm ơn bạn đã sử dụng PDF Craft!</div>
        </div>
      `;
    }
  });
}

// ==========================================================================
// Digital Signature & Stamp Placement Studio Engine
// ==========================================================================

const signStudioState = {
  activeTab: 'upload',
  pageIndex: 0,
  inkColor: '#0f172a',
  typeInkColor: '#0f172a',
  selectedFont: 'dancing',
  strokeWidth: 2.5,
  uploadedDataUrl: null,
  selectedLibId: null, // selected stamp library item for "Đưa lên trang"
  officialPreset: 'title_name',
  officialTitle: 'GIÁM ĐỐC',
  officialName: 'NGUYỄN VĂN AN',
  officialExtra: '',
  officialBorder: 'single',
  officialColor: '#c81e1e',
  stageZoom: 1.0,
  selectedStampId: null,
  currentStamps: [], // working array of stamps for currently active stage page
};

const STAMP_LIB_STORAGE_KEY = 'pdfcraft_stamp_library';

function getStoredStampLibrary() {
  try {
    const raw = localStorage.getItem(STAMP_LIB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveStoredStampLibrary(list) {
  const arr = Array.isArray(list) ? list.slice(0, 25) : [];
  // Thử lưu toàn bộ; nếu bộ nhớ trình duyệt đầy (QuotaExceededError) thì
  // giữ lại dần các mục mới nhất thay vì để lỗi văng ra gây "crash".
  const attempts = [arr, arr.slice(0, 15), arr.slice(0, 8), arr.slice(0, 3)];
  for (let i = 0; i < attempts.length; i++) {
    try {
      localStorage.setItem(STAMP_LIB_STORAGE_KEY, JSON.stringify(attempts[i]));
      if (i > 0) {
        showToast(`Bộ nhớ thư viện đầy, chỉ giữ lại ${attempts[i].length} con dấu mới nhất. Hãy xóa bớt dấu cũ!`, 'danger');
      }
      return true;
    } catch (e) {
      const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      if (!isQuota) {
        console.warn('Không thể lưu thư viện con dấu vào localStorage:', e);
        return false;
      }
      // Còn quota error -> thử mức ít hơn ở vòng lặp tiếp theo.
    }
  }
  console.warn('Không thể lưu thư viện con dấu: bộ nhớ trình duyệt đã đầy.');
  showToast('Không lưu được thư viện: bộ nhớ trình duyệt đã đầy. Hãy xóa bớt ảnh con dấu cũ!', 'danger');
  return false;
}

// Chroma & luminance background removal for photos of stamps on white paper
function filterWhiteBackground(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const diffRG = Math.abs(r - g);
        const diffRB = Math.abs(r - b);
        const diffGB = Math.abs(g - b);

        // Filter neutral bright paper / white background
        if (lum > 175 && diffRG < 35 && diffRB < 35 && diffGB < 35) {
          if (lum >= 220) {
            d[i+3] = 0; // Completely transparent
          } else {
            // Smooth edge feathering
            const alphaFactor = 1 - (lum - 175) / 45;
            d[i+3] = Math.round(d[i+3] * Math.max(0, Math.min(1, alphaFactor)));
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function resizeImageForLibrary(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Nén dần: ảnh quá lớn (PNG 900px có thể > 2MB) vừa tốn RAM vừa làm
        // đầy localStorage (quota ~5MB) -> tự hạ kích thước tới khi đủ nhỏ.
        const steps = [900, 640, 450];
        let stepIdx = 0;
        const tryEncode = () => {
          const maxDim = steps[Math.min(stepIdx, steps.length - 1)];
          let w = img.naturalWidth || maxDim;
          let h = img.naturalHeight || maxDim;
          if (!w || !h) {
            resolve(ev.target.result);
            return;
          }
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const c = document.createElement('canvas');
          c.width = Math.max(1, w);
          c.height = Math.max(1, h);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL('image/png');
          // Giới hạn ~900KB/ảnh để 25 ảnh không vượt quota localStorage.
          if (url.length > 900 * 1024 && stepIdx < steps.length - 1) {
            stepIdx++;
            tryEncode();
          } else {
            resolve(url);
          }
        };
        tryEncode();
      };
      img.onerror = () => resolve(ev.target.result);
      img.src = ev.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Draw stamps onto 2D canvas (for thumbnails & modal preview)
function drawStampsOnCanvas(ctx, stamps, canvasWidth, canvasHeight) {
  if (!stamps || stamps.length === 0) return;
  for (const stamp of stamps) {
    if (!stamp.dataUrl) continue;
    if (!stamp._img) {
      stamp._img = new Image();
      stamp._img.src = stamp.dataUrl;
    }
    const draw = () => {
      ctx.save();
      ctx.globalAlpha = stamp.opacity !== undefined ? stamp.opacity : 1.0;
      const x = stamp.relX * canvasWidth;
      const y = stamp.relY * canvasHeight;
      const w = stamp.relW * canvasWidth;
      const h = stamp.relH * canvasHeight;
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.translate(cx, cy);
      if (stamp.rotation) {
        ctx.rotate((stamp.rotation * Math.PI) / 180);
      }
      ctx.drawImage(stamp._img, -w / 2, -h / 2, w, h);
      ctx.restore();
    };
    if (stamp._img.complete && stamp._img.naturalWidth > 0) {
      draw();
    } else {
      stamp._img.onload = () => draw();
    }
  }
}

// Asynchronously draw stamps onto canvas (for raster compression export)
async function drawStampsOnCanvasAsync(ctx, stamps, canvasWidth, canvasHeight) {
  if (!stamps || stamps.length === 0) return;
  for (const stamp of stamps) {
    if (!stamp.dataUrl) continue;
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.save();
        ctx.globalAlpha = stamp.opacity !== undefined ? stamp.opacity : 1.0;
        const x = stamp.relX * canvasWidth;
        const y = stamp.relY * canvasHeight;
        const w = stamp.relW * canvasWidth;
        const h = stamp.relH * canvasHeight;
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.translate(cx, cy);
        if (stamp.rotation) {
          ctx.rotate((stamp.rotation * Math.PI) / 180);
        }
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
        resolve();
      };
      img.onerror = () => resolve();
      img.src = stamp.dataUrl;
    });
  }
}

// Embed stamps as vector images into a PDF page using pdf-lib
async function embedStampsOnPdfPage(outPdf, pdfPage, stamps) {
  if (!stamps || stamps.length === 0) return;
  const pageWidth = pdfPage.getWidth();
  const pageHeight = pdfPage.getHeight();

  for (const stamp of stamps) {
    if (!stamp.dataUrl) continue;
    try {
      const parts = stamp.dataUrl.split(',');
      if (parts.length < 2) continue;
      const binaryString = atob(parts[1]);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const isPng = stamp.dataUrl.startsWith('data:image/png');
      const embeddedImg = isPng
        ? await outPdf.embedPng(bytes)
        : await outPdf.embedJpg(bytes);

      const pdfW = stamp.relW * pageWidth;
      const pdfH = stamp.relH * pageHeight;
      const pdfX = stamp.relX * pageWidth;
      // In PDF coordinate system, origin (0,0) is at BOTTOM-LEFT
      const pdfY = pageHeight - (stamp.relY * pageHeight) - pdfH;

      const rotDeg = stamp.rotation || 0;
      if (rotDeg === 0) {
        pdfPage.drawImage(embeddedImg, {
          x: pdfX,
          y: pdfY,
          width: pdfW,
          height: pdfH,
          opacity: stamp.opacity !== undefined ? stamp.opacity : 1.0,
        });
      } else {
        const theta = -rotDeg;
        const rad = (theta * Math.PI) / 180;
        const cx = pdfX + pdfW / 2;
        const cy = pdfY + pdfH / 2;
        const dx = (pdfW / 2) * Math.cos(rad) - (pdfH / 2) * Math.sin(rad);
        const dy = (pdfW / 2) * Math.sin(rad) + (pdfH / 2) * Math.cos(rad);
        const newX = cx - dx;
        const newY = cy - dy;

        pdfPage.drawImage(embeddedImg, {
          x: newX,
          y: newY,
          width: pdfW,
          height: pdfH,
          rotate: PDFLib.degrees(theta),
          opacity: stamp.opacity !== undefined ? stamp.opacity : 1.0,
        });
      }
    } catch (err) {
      console.error('Lỗi khi nhúng con dấu vào trang PDF:', err);
    }
  }
}

// Auto-crop whitespace from canvas to keep signature tightly bounded
function cropCanvasBoundingBox(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (d[idx + 3] > 15) { // alpha threshold
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;

  const pad = 10;
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(w - cropX, (maxX - minX) + pad * 2);
  const cropH = Math.min(h - cropY, (maxY - minY) + pad * 2);

  const cropped = document.createElement('canvas');
  cropped.width = cropW;
  cropped.height = cropH;
  const cCtx = cropped.getContext('2d');
  cCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return cropped.toDataURL('image/png');
}

// Helpers for Official Vietnamese Stamp Generator
function formatOfficialDateString(dateVal, formatType) {
  let d;
  if (dateVal && typeof dateVal === 'string' && dateVal.includes('-')) {
    const parts = dateVal.split('-');
    d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  } else {
    d = new Date();
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  if (formatType === 'slash') {
    return `${day} / ${month} / ${year}`;
  } else if (formatType === 'dash') {
    return `${day} - ${month} - ${year}`;
  }
  return `Ngày ${day} tháng ${month} năm ${year}`;
}

function drawStampStar(ctx, cx, cy, spikes, outerRadius, innerRadius, color) {
  let rot = (Math.PI / 2) * 3;
  let x = cx;
  let y = cy;
  const step = Math.PI / spikes;

  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);
  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerRadius;
    y = cy + Math.sin(rot) * outerRadius;
    ctx.lineTo(x, y);
    rot += step;

    x = cx + Math.cos(rot) * innerRadius;
    y = cy + Math.sin(rot) * innerRadius;
    ctx.lineTo(x, y);
    rot += step;
  }
  ctx.lineTo(cx, cy - outerRadius);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Comprehensive Vietnamese Official & Business Stamp Generator (Canvas 2x DPI)
function generateOfficialStampDataUrl(opts) {
  if (typeof opts !== 'object' || opts === null) {
    opts = {
      title: arguments[0] || '',
      name: arguments[1] || '',
      borderType: arguments[2] || 'single',
      color: arguments[3] || '#c81e1e',
    };
  }

  const {
    title = '',
    name = '',
    extra = '',
    borderType = 'single',
    color = '#c81e1e',
    hasDate = false,
    dateText = '',
    hasGrunge = true,
    angle = 0,
  } = opts;

  const canvas = document.createElement('canvas');
  const dpr = 2;

  if (borderType === 'round') {
    // ==========================================
    // 1. CON DẤU TRÒN NỘI BỘ (Round Stamp 300x300)
    // ==========================================
    const size = 300;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;

    if (angle !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    // Circles: Outer & Inner concentric rings
    const rOuter = 138;
    const rInner = 128;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
    ctx.stroke();

    // Top Curved Text (Organization / Header)
    const topText = (title || 'CÔNG TY TNHH PHÁT TRIỂN CÔNG NGHỆ').toUpperCase();
    ctx.fillStyle = color;
    ctx.font = 'bold 15px "Montserrat", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const topRadius = 108;
    const topCharCount = topText.length;
    const topTotalAngle = Math.min(3.5, Math.max(1.5, topCharCount * 0.12));
    const topStartAngle = -Math.PI / 2 - topTotalAngle / 2;
    const topStep = topTotalAngle / Math.max(1, topCharCount - 1);

    for (let i = 0; i < topCharCount; i++) {
      const char = topText[i];
      const charAngle = topStartAngle + i * topStep;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(charAngle + Math.PI / 2);
      ctx.translate(0, -topRadius);
      ctx.fillText(char, 0, 0);
      ctx.restore();
    }

    // Center Element: 5-Pointed Star & MST / Sub-line
    drawStampStar(ctx, cx, cy - 12, 5, 18, 8, color);

    if (extra) {
      ctx.font = 'bold 13px "Montserrat", Arial, sans-serif';
      ctx.fillText(extra.toUpperCase(), cx, cy + 18);
    } else if (hasDate && dateText) {
      ctx.font = 'italic 12px "Montserrat", Arial, sans-serif';
      ctx.fillText(dateText, cx, cy + 18);
    }

    // Bottom Curved Text (Location / Subtitle)
    const bottomText = (name || 'THÀNH PHỐ HÀ NỘI').toUpperCase();
    ctx.font = 'bold 15px "Montserrat", Arial, sans-serif';
    const btmRadius = 110;
    const btmCharCount = bottomText.length;
    const btmTotalAngle = Math.min(2.5, Math.max(1.0, btmCharCount * 0.13));
    const btmStartAngle = Math.PI / 2 + btmTotalAngle / 2;
    const btmStep = btmTotalAngle / Math.max(1, btmCharCount - 1);

    for (let i = 0; i < btmCharCount; i++) {
      const char = bottomText[i];
      const charAngle = btmStartAngle - i * btmStep;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(charAngle - Math.PI / 2);
      ctx.translate(0, btmRadius);
      ctx.fillText(char, 0, 0);
      ctx.restore();
    }

  } else {
    // ==========================================
    // 2. CON DẤU VUÔNG / CHỮ NHẬT / 1-3 DÒNG / NGÀY THÁNG
    // ==========================================
    const hasTitle = Boolean(title && title.trim());
    const hasExtra = Boolean(extra && extra.trim());
    const linesCount = (hasTitle ? 1 : 0) + 1 + (hasExtra ? 1 : 0) + (hasDate ? 1 : 0);

    const baseW = 360;
    let baseH = 88;
    if (linesCount === 2) baseH = 125;
    else if (linesCount === 3) baseH = 155;
    else if (linesCount >= 4) baseH = 190;

    canvas.width = baseW * dpr;
    canvas.height = baseH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, baseW, baseH);

    const centerX = baseW / 2;
    const centerY = baseH / 2;

    if (angle !== 0) {
      ctx.translate(centerX, centerY);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);
    }

    const pad = 6;
    const rectX = pad;
    const rectY = pad;
    const rectW = baseW - pad * 2;
    const rectH = baseH - pad * 2;

    // Draw Border
    if (borderType === 'single') {
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = color;
      ctx.strokeRect(rectX, rectY, rectW, rectH);
    } else if (borderType === 'double') {
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = color;
      ctx.strokeRect(rectX, rectY, rectW, rectH);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rectX + 4.5, rectY + 4.5, rectW - 9, rectH - 9);
    } else if (borderType === 'rounded') {
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = color;
      const r = 12;
      ctx.beginPath();
      ctx.moveTo(rectX + r, rectY);
      ctx.lineTo(rectX + rectW - r, rectY);
      ctx.arcTo(rectX + rectW, rectY, rectX + rectW, rectY + r, r);
      ctx.lineTo(rectX + rectW, rectY + rectH - r);
      ctx.arcTo(rectX + rectW, rectY + rectH, rectX + rectW - r, rectY + rectH, r);
      ctx.lineTo(rectX + r, rectY + rectH);
      ctx.arcTo(rectX, rectY + rectH, rectX, rectY + rectH - r, r);
      ctx.lineTo(rectX, rectY + r);
      ctx.arcTo(rectX, rectY, rectX + r, rectY, r);
      ctx.closePath();
      ctx.stroke();
    }

    // Compute Lines Layout
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = [];
    if (hasTitle) {
      lines.push({ text: title.toUpperCase(), font: 'bold 20px "Montserrat", Arial, sans-serif' });
    }
    lines.push({ text: (name || '').toUpperCase(), font: 'bold 23px "Montserrat", Arial, sans-serif' });
    if (hasExtra) {
      lines.push({ text: extra, font: 'bold 15px "Montserrat", Arial, sans-serif' });
    }
    if (hasDate && dateText) {
      lines.push({ text: dateText, font: 'italic 15px "Montserrat", Arial, sans-serif' });
    }

    const n = lines.length;
    const stepY = rectH / (n + 1);
    lines.forEach((line, idx) => {
      ctx.font = line.font;
      const y = rectY + stepY * (idx + 1);
      ctx.fillText(line.text, centerX, y);
    });
  }

  // 3. Realistic Stamp Grunge / Ink Bleed Texture (Porous stamp on paper effect)
  if (hasGrunge) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const len = data.length;
    for (let i = 0; i < len; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 40) {
        const rand = Math.random();
        if (rand < 0.08) {
          data[i + 3] = Math.max(0, alpha - Math.floor(Math.random() * 180 + 50));
        } else if (rand < 0.18) {
          data[i + 3] = Math.floor(alpha * (0.8 + Math.random() * 0.2));
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  return cropCanvasBoundingBox(canvas) || canvas.toDataURL('image/png');
}

function updateOfficialStampPreview() {
  if (!officialStampBox) return;

  const preset = signStudioState.officialPreset || 'title_name';
  const isRound = stampBorderType && stampBorderType.value === 'round';
  const border = stampBorderType ? stampBorderType.value : 'single';
  const color = signStudioState.officialColor || '#c81e1e';
  const angle = rngOfficialAngle ? (parseFloat(rngOfficialAngle.value) || 0) : 0;
  const hasDate = chkOfficialDate ? chkOfficialDate.checked : false;

  let title = (stampOfficialTitle ? stampOfficialTitle.value : '').trim();
  let name = (stampOfficialName ? stampOfficialName.value : '').trim() || 'NGUYỄN VĂN AN';
  let extra = (stampOfficialExtra ? stampOfficialExtra.value : '').trim();
  let dateText = '';

  if (hasDate) {
    const dateVal = inputOfficialDate ? inputOfficialDate.value : '';
    const formatType = selOfficialDateFormat ? selOfficialDateFormat.value : 'full';
    dateText = formatOfficialDateString(dateVal, formatType);
  }

  officialStampBox.style.color = color;
  officialStampBox.style.borderColor = color;
  officialStampBox.style.transform = `rotate(${angle}deg)`;

  officialStampBox.classList.remove(
    'official-border-single',
    'official-border-double',
    'official-border-rounded',
    'official-border-round',
    'official-border-none'
  );
  officialStampBox.classList.add(`official-border-${border}`);

  if (isRound) {
    if (previewOfficialTitle) {
      previewOfficialTitle.style.display = 'block';
      previewOfficialTitle.style.fontSize = '0.72rem';
      previewOfficialTitle.textContent = (title || 'CÔNG TY TNHH PHÁT TRIỂN').toUpperCase();
    }
    if (previewOfficialName) {
      previewOfficialName.style.display = 'block';
      previewOfficialName.style.fontSize = '0.72rem';
      previewOfficialName.textContent = (name || 'THÀNH PHỐ HÀ NỘI').toUpperCase();
    }
    if (previewOfficialExtra) {
      previewOfficialExtra.style.display = 'block';
      previewOfficialExtra.innerHTML = `<div class="official-stamp-star" style="color: ${color};">★</div>` +
        (extra ? `<div>${escapeHtml(extra)}</div>` : (hasDate && dateText ? `<div style="font-size: 0.66rem; font-style: italic;">${escapeHtml(dateText)}</div>` : ''));
    }
    if (previewOfficialDate) {
      previewOfficialDate.style.display = 'none';
    }
  } else {
    if (previewOfficialTitle) {
      previewOfficialTitle.style.fontSize = '0.92rem';
      if (title && (preset === 'title_name' || preset === 'business_tax' || preset === 'doc_incoming' || (groupOfficialTitle && groupOfficialTitle.style.display !== 'none'))) {
        previewOfficialTitle.style.display = 'block';
        previewOfficialTitle.textContent = title.toUpperCase();
      } else {
        previewOfficialTitle.style.display = 'none';
      }
    }

    if (previewOfficialName) {
      previewOfficialName.style.display = 'block';
      previewOfficialName.style.fontSize = '1.12rem';
      previewOfficialName.textContent = name.toUpperCase();
    }

    if (previewOfficialExtra) {
      if (extra && (preset === 'business_tax' || (groupOfficialExtra && groupOfficialExtra.style.display !== 'none'))) {
        previewOfficialExtra.style.display = 'block';
        previewOfficialExtra.textContent = extra;
      } else {
        previewOfficialExtra.style.display = 'none';
      }
    }

    if (previewOfficialDate) {
      if (hasDate && dateText) {
        previewOfficialDate.style.display = 'block';
        previewOfficialDate.textContent = dateText;
      } else {
        previewOfficialDate.style.display = 'none';
      }
    }
  }

  if (lblOfficialAngle) {
    lblOfficialAngle.textContent = `${angle > 0 ? '+' : ''}${angle}°`;
  }
}

function renderStampLibrary() {
  if (!stampLibraryGrid) return;
  const list = getStoredStampLibrary();
  if (libStampCountBadge) {
    libStampCountBadge.textContent = `${list.length} dấu`;
  }

  if (list.length === 0) {
    signStudioState.selectedLibId = null;
    stampLibraryGrid.innerHTML = `
      <div class="stamp-lib-empty">
        Chưa có ảnh con dấu nào trong thư viện. Bạn có thể tải lên nhiều ảnh (dấu công ty, dấu chức danh, chữ ký scan...) để dùng lại bất kỳ lúc nào!
      </div>
    `;
    updateSignPlaceButton();
    return;
  }

  // Giữ selection hợp lệ: ưu tiên selection cũ, không thì chọn thẻ đầu.
  if (!list.some(x => x.id === signStudioState.selectedLibId)) {
    signStudioState.selectedLibId = list[0].id;
  }
  updateSignPlaceButton();

  stampLibraryGrid.innerHTML = '';
  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'stamp-lib-card';
    if (item.id === signStudioState.selectedLibId) {
      card.classList.add('selected');
    }
    card.dataset.libId = item.id;
    card.title = 'Nhấp để chọn con dấu này, rồi bấm "Đưa lên trang"';
    card.innerHTML = `
      <div class="stamp-lib-thumb">
        <img src="${item.dataUrl}" alt="${escapeHtml(item.name || 'Con dấu')}">
      </div>
      <div class="stamp-lib-title" title="${escapeHtml(item.name || 'Con dấu')}">${escapeHtml(item.name || 'Con dấu')}</div>
      <div class="stamp-lib-actions">
        <button type="button" class="btn btn-primary btn-sm btn-use-stamp" title="Đưa con dấu này lên trang PDF">Dùng dấu</button>
        <button type="button" class="btn btn-tool btn-sm btn-filter-white" title="Lọc bỏ nền giấy trắng để con dấu trong suốt">⚡ Lọc</button>
        <button type="button" class="btn btn-tool btn-danger btn-sm btn-del-stamp" title="Xóa khỏi thư viện">Xóa</button>
      </div>
    `;

    // Chọn thẻ (không đặt dấu ngay) — nút "Đưa lên trang" sẽ dùng thẻ này.
    const selectThis = () => {
      signStudioState.selectedLibId = item.id;
      stampLibraryGrid.querySelectorAll('.stamp-lib-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.libId === signStudioState.selectedLibId);
      });
      updateSignPlaceButton();
    };
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectThis();
    });
    // Double-click = đặt ngay lên trang (shortcut phổ biến với thư viện ảnh)
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      selectThis();
      addStampToCurrentPage(item.dataUrl);
    });
    card.querySelector('.stamp-lib-thumb').addEventListener('click', selectThis);
    card.querySelector('.stamp-lib-title').addEventListener('click', selectThis);

    // Action: Dùng dấu
    card.querySelector('.btn-use-stamp').addEventListener('click', (e) => {
      e.stopPropagation();
      selectThis();
      addStampToCurrentPage(item.dataUrl);
    });

    // Action: Lọc nền trắng
    card.querySelector('.btn-filter-white').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const originalText = btn.textContent;
      btn.textContent = 'Đang lọc...';
      btn.disabled = true;
      try {
        const transparentDataUrl = await filterWhiteBackground(item.dataUrl);
        item.dataUrl = transparentDataUrl;
        const currentList = getStoredStampLibrary();
        const found = currentList.find(x => x.id === item.id);
        if (found) {
          found.dataUrl = transparentDataUrl;
          saveStoredStampLibrary(currentList);
        }
        renderStampLibrary();
        showToast('Đã lọc sạch nền giấy trắng thành trong suốt!', 'success');
      } catch (err) {
        showToast('Lỗi khi xử lý nền trắng!', 'danger');
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });

    // Action: Xóa
    card.querySelector('.btn-del-stamp').addEventListener('click', (e) => {
      e.stopPropagation();
      const currentList = getStoredStampLibrary().filter(x => x.id !== item.id);
      saveStoredStampLibrary(currentList);
      if (signStudioState.selectedLibId === item.id) {
        signStudioState.selectedLibId = null;
      }
      renderStampLibrary();
      showToast('Đã xóa con dấu khỏi thư viện!', 'info');
    });

    stampLibraryGrid.appendChild(card);
  });
}

let signStageRenderToken = 0;

function applyStageZoom(newZoom, opts = {}) {
  const prevZoom = signStudioState._lastAppliedZoom || signStudioState.stageZoom || 1.0;
  signStudioState.stageZoom = Math.max(0.25, Math.min(4.0, newZoom));
  const zoom = signStudioState.stageZoom;
  if (signStageContainer && signStageCanvas) {
    // Zoom theo kích thước layout thật (KHÔNG dùng transform: scale).
    // transform: scale chỉ phóng to mặt hình ảnh nhưng khung cuộn vẫn tính
    // theo kích thước gốc + origin center đẩy nội dung nở đều 2 phía,
    // khiến đầu trang bị che và không thể cuộn lên xem được.
    const baseW = signStageCanvas.width || 0;
    const baseH = signStageCanvas.height || 0;
    if (baseW > 0 && baseH > 0) {
      let anchorRX = 0.5;
      let anchorRY = 0.0;
      if (signStageViewport && opts.anchor !== 'top') {
        const oldContentW = Math.max(1, baseW * prevZoom);
        const oldContentH = Math.max(1, baseH * prevZoom);
        anchorRX = (signStageViewport.scrollLeft + signStageViewport.clientWidth / 2) / oldContentW;
        anchorRY = (signStageViewport.scrollTop + signStageViewport.clientHeight / 2) / oldContentH;
        anchorRX = Math.max(0, Math.min(1, anchorRX));
        anchorRY = Math.max(0, Math.min(1, anchorRY));
      }
      const cssW = Math.max(1, Math.round(baseW * zoom));
      const cssH = Math.max(1, Math.round(baseH * zoom));
      signStageContainer.style.width = `${cssW}px`;
      signStageContainer.style.height = `${cssH}px`;
      signStageContainer.style.transform = '';
      signStageContainer.style.transformOrigin = '';
      if (signStageViewport && opts.anchor !== 'top') {
        const newScrollLeft = anchorRX * cssW - signStageViewport.clientWidth / 2;
        const newScrollTop = anchorRY * cssH - signStageViewport.clientHeight / 2;
        signStageViewport.scrollLeft = Math.max(0, newScrollLeft);
        signStageViewport.scrollTop = Math.max(0, newScrollTop);
      } else if (signStageViewport && opts.anchor === 'top') {
        signStageViewport.scrollTop = 0;
        signStageViewport.scrollLeft = 0;
      }
    }
  }
  signStudioState._lastAppliedZoom = zoom;
  const pctStr = `${Math.round(signStudioState.stageZoom * 100)}%`;
  if (inputStageZoom && document.activeElement !== inputStageZoom) {
    inputStageZoom.value = pctStr;
  }
  if (stageZoomMenu) {
    stageZoomMenu.querySelectorAll('.zoom-menu-item').forEach(item => {
      const zVal = parseFloat(item.dataset.zoom);
      item.classList.toggle('active', Math.abs(zVal - signStudioState.stageZoom) < 0.03);
    });
  }
  updateFloatingToolbarPosition();
}

function fitStageZoom() {
  if (signStageViewport && signStageCanvas) {
    const vpRect = signStageViewport.getBoundingClientRect();
    const cHeight = signStageCanvas.height || 1;
    const cWidth = signStageCanvas.width || 1;
    const scaleH = (vpRect.height - 48) / cHeight;
    const scaleW = (vpRect.width - 48) / cWidth;
    const fitScale = Math.max(0.25, Math.min(2.5, Math.min(scaleH, scaleW)));
    applyStageZoom(fitScale);
  }
}

function fitWidthStageZoom() {
  if (signStageViewport && signStageCanvas) {
    const vpRect = signStageViewport.getBoundingClientRect();
    const cWidth = signStageCanvas.width || 1;
    const scaleW = (vpRect.width - 64) / cWidth;
    const fitScale = Math.max(0.25, Math.min(3.0, scaleW));
    applyStageZoom(fitScale);
  }
}

function updateFloatingToolbarPosition() {
  if (!stampFloatingToolbar) return;
  if (!signStudioState.selectedStampId) {
    stampFloatingToolbar.style.display = 'none';
    return;
  }
  const activeBox = signStageOverlay ? signStageOverlay.querySelector(`.stamp-box[data-stamp-id="${signStudioState.selectedStampId}"]`) : null;
  if (!activeBox) {
    stampFloatingToolbar.style.display = 'none';
    return;
  }

  const boxRect = activeBox.getBoundingClientRect();
  const vpRect = signStageViewport.getBoundingClientRect();

  const left = boxRect.left + boxRect.width / 2 - vpRect.left + signStageViewport.scrollLeft;
  const top = boxRect.top - vpRect.top + signStageViewport.scrollTop - 10;

  stampFloatingToolbar.style.left = `${left}px`;
  stampFloatingToolbar.style.top = `${top}px`;
  stampFloatingToolbar.style.display = 'flex';
}

function selectStamp(stampId) {
  signStudioState.selectedStampId = stampId;
  if (signStageOverlay) {
    signStageOverlay.querySelectorAll('.stamp-box').forEach(box => {
      box.classList.toggle('active', box.dataset.stampId === stampId);
    });
  }
  // Đồng bộ thanh opacity với dấu đang chọn để người dùng chỉnh ngay được
  const stamp = signStudioState.currentStamps.find(s => s.id === stampId);
  if (stamp && signOpacity) {
    const pct = Math.round((stamp.opacity !== undefined ? stamp.opacity : 1) * 100);
    signOpacity.value = String(Math.max(20, Math.min(100, pct)));
    syncRangeFill(signOpacity);
    if (signOpacityVal) signOpacityVal.textContent = `${pct}%`;
  }
  const listItems = document.querySelectorAll('.sign-stamp-item');
  listItems.forEach(el => {
    el.classList.toggle('selected', el.dataset.stampId === stampId);
  });
  updateFloatingToolbarPosition();
}

function deselectStamps() {
  signStudioState.selectedStampId = null;
  if (signStageOverlay) {
    signStageOverlay.querySelectorAll('.stamp-box').forEach(box => box.classList.remove('active'));
  }
  if (stampFloatingToolbar) {
    stampFloatingToolbar.style.display = 'none';
  }
  document.querySelectorAll('.sign-stamp-item.selected').forEach(el => el.classList.remove('selected'));
}

function updateSignPlaceButton() {
  if (!btnPlaceStampOnPage) return;
  const tab = signStudioState.activeTab;
  let ready = false;
  let hint = 'Đưa lên trang';

  if (tab === 'upload') {
    const list = getStoredStampLibrary();
    ready = list.length > 0;
    const picked = list.find(x => x.id === signStudioState.selectedLibId) || list[0];
    hint = ready && picked
      ? `Đưa “${picked.name || 'Con dấu'}” lên trang (Enter)`
      : 'Chưa có ảnh trong thư viện — hãy tải ảnh trước';
  } else if (tab === 'type') {
    const name = ((signTypeName && signTypeName.value) || '').trim();
    ready = !!name;
    hint = ready
      ? `Đưa chữ ký “${name}” lên trang (Enter)`
      : 'Nhập họ và tên để tạo chữ ký';
  } else if (tab === 'official') {
    const title = ((stampOfficialTitle && stampOfficialTitle.value) || '').trim();
    const name = ((stampOfficialName && stampOfficialName.value) || '').trim();
    ready = !!(name || title);
    hint = ready ? 'Đưa con dấu nghiệp vụ lên trang (Enter)' : 'Nhập nội dung con dấu';
  }

  btnPlaceStampOnPage.disabled = !ready;
  btnPlaceStampOnPage.title = hint;
  btnPlaceStampOnPage.setAttribute('aria-label', hint);
  btnPlaceStampOnPage.classList.toggle('is-ready', ready);
}

function updateStageEmptyHint() {
  const hint = document.getElementById('signStageEmptyHint');
  if (!hint) return;
  const has = signStudioState.currentStamps.length > 0;
  hint.hidden = has;
}

function flashStampPlaced(stampId) {
  if (!signStageOverlay) return;
  const box = signStageOverlay.querySelector(`.stamp-box[data-stamp-id="${stampId}"]`);
  if (!box) return;
  box.classList.remove('just-placed');
  // force reflow để animation chạy lại khi đặt liên tiếp
  void box.offsetWidth;
  box.classList.add('just-placed');
  box.addEventListener('animationend', () => box.classList.remove('just-placed'), { once: true });
  // Cuộn viewport về gần dấu vừa đặt nếu đang bị khuất
  if (signStageViewport) {
    const boxRect = box.getBoundingClientRect();
    const vpRect = signStageViewport.getBoundingClientRect();
    if (boxRect.bottom < vpRect.top + 40 || boxRect.top > vpRect.bottom - 40 ||
        boxRect.right < vpRect.left + 40 || boxRect.left > vpRect.right - 40) {
      box.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }
}

function updateTypeSignatureLivePreview() {
  const text = ((signTypeName && signTypeName.value) || '').trim() || 'Nguyễn Văn An';
  const samples = paneType ? paneType.querySelectorAll('.sign-font-sample') : [];
  samples.forEach(s => {
    s.textContent = text;
    s.style.color = signStudioState.typeInkColor || '#0f172a';
  });
  const live = document.getElementById('signTypeLiveSample');
  if (live && signStudioState.selectedFont) {
    const fontMap = {
      dancing: "'Dancing Script', cursive",
      greatvibes: "'Great Vibes', cursive",
      alexbrush: "'Alex Brush', cursive",
      caveat: "'Caveat', cursive",
      pacifico: "'Pacifico', cursive",
    };
    live.style.fontFamily = fontMap[signStudioState.selectedFont] || fontMap.dancing;
  }
}

function setupSignatureEvents() {
  if (!signModal) return;

  // 1. Tab Switching (vertical rail: Upload/Library, Type, Official Stamp)
  const tabs = [
    { btn: tabUpload, pane: paneUpload, id: 'upload' },
    { btn: tabType, pane: paneType, id: 'type' },
    { btn: tabOfficial, pane: paneOfficial, id: 'official' },
  ];

  tabs.forEach(t => {
    if (!t.btn) return;
    t.btn.addEventListener('click', () => {
      tabs.forEach(other => {
        if (other.btn) {
          const on = other.id === t.id;
          other.btn.classList.toggle('active', on);
          other.btn.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        if (other.pane) other.pane.style.display = other.id === t.id ? 'flex' : 'none';
      });
      signStudioState.activeTab = t.id;
      // Luôn về đầu panel khi đổi công cụ để thấy preview/ngữ cảnh mới ngay
      const scroller = document.querySelector('.sign-panel-scroll');
      if (scroller) scroller.scrollTop = 0;
      if (t.id === 'upload') {
        renderStampLibrary();
      } else if (t.id === 'official') {
        updateOfficialStampPreview();
      } else if (t.id === 'type') {
        updateTypeSignatureLivePreview();
      }
      updateSignPlaceButton();
    });
  });

  // Rail keyboard: ↑/↓ chuyển tab khi đang focus rail (a11y)
  const rail = document.querySelector('.sign-rail');
  if (rail) {
    rail.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const btns = tabs.map(t => t.btn).filter(Boolean);
      const idx = btns.indexOf(document.activeElement);
      if (idx < 0) return;
      e.preventDefault();
      const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      const next = btns[(idx + dir + btns.length) % btns.length];
      if (next) {
        next.focus();
        next.click();
      }
    });
  }

  // Enter = Đưa lên trang (khi không đang gõ trong input)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!signModal || !signModal.classList.contains('active')) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
    if (activeEl === btnPlaceStampOnPage) return; // button native click
    if (btnPlaceStampOnPage && !btnPlaceStampOnPage.disabled) {
      e.preventDefault();
      handlePlaceStampOnPage();
    }
  });

  // 2. Tab 1: Upload Multiple Images to Library
  const handleUploadFiles = async (files) => {
    if (!files || files.length === 0) return;
    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (validFiles.length === 0) {
      showToast('Vui lòng chọn tệp hình ảnh hợp lệ (PNG, JPG, WebP)!', 'danger');
      return;
    }
    const currentList = getStoredStampLibrary();
    let addedCount = 0;
    for (const file of validFiles) {
      const resizedDataUrl = await resizeImageForLibrary(file);
      if (!resizedDataUrl) continue;
      currentList.unshift({
        id: 'stamp_lib_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
        name: file.name.replace(/\.[^/.]+$/, ''),
        dataUrl: resizedDataUrl,
        createdAt: Date.now(),
      });
      addedCount++;
    }
    saveStoredStampLibrary(currentList);
    renderStampLibrary();
    if (addedCount === 0) {
      showToast('Không đọc được ảnh nào, vui lòng thử tệp khác!', 'danger');
    } else {
      showToast(`Đã thêm ${addedCount} ảnh vào thư viện con dấu!`, 'success');
    }
  };

  if (signImageInput) {
    signImageInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleUploadFiles(e.target.files);
      }
      signImageInput.value = '';
    });
  }

  if (signUploadDrop) {
    ['dragenter', 'dragover'].forEach(name => {
      signUploadDrop.addEventListener(name, (e) => {
        e.preventDefault();
        signUploadDrop.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      signUploadDrop.addEventListener(name, (e) => {
        e.preventDefault();
        signUploadDrop.classList.remove('drag-over');
      });
    });
    signUploadDrop.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleUploadFiles(e.dataTransfer.files);
      }
    });
  }

  if (btnClearStampLibrary) {
    btnClearStampLibrary.addEventListener('click', () => {
      if (getStoredStampLibrary().length === 0) return;
      if (confirm('Bạn có chắc muốn xóa tất cả con dấu trong thư viện?')) {
        saveStoredStampLibrary([]);
        renderStampLibrary();
        showToast('Đã làm trống thư viện con dấu!', 'info');
      }
    });
  }

  // 3. Tab 2: Type Signature Logic (5 Cursive Fonts)
  if (signTypeName) {
    signTypeName.addEventListener('input', () => {
      updateTypeSignatureLivePreview();
      updateSignPlaceButton();
    });
  }

  const fontCards = paneType ? paneType.querySelectorAll('.sign-font-card') : [];
  fontCards.forEach(card => {
    card.addEventListener('click', () => {
      fontCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      signStudioState.selectedFont = card.dataset.font || 'dancing';
      updateTypeSignatureLivePreview();
    });
  });

  const typeColorDots = paneType ? paneType.querySelectorAll('.sign-color-dot[data-type-color]') : [];
  typeColorDots.forEach(dot => {
    dot.addEventListener('click', () => {
      typeColorDots.forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      signStudioState.typeInkColor = dot.dataset.typeColor || '#0f172a';
      updateTypeSignatureLivePreview();
    });
  });

  if (btnSaveTypeToLib) {
    btnSaveTypeToLib.addEventListener('click', () => {
      const name = (signTypeName ? signTypeName.value : '').trim();
      if (!name) {
        showToast('Vui lòng nhập họ tên trước khi lưu vào thư viện!', 'danger');
        return;
      }
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 900;
      tempCanvas.height = 280;
      const tCtx = tempCanvas.getContext('2d');
      const fontMap = {
        dancing: 'bold 64px "Dancing Script", cursive',
        greatvibes: '68px "Great Vibes", cursive',
        alexbrush: 'bold 64px "Alex Brush", cursive',
        caveat: 'bold 68px "Caveat", cursive',
        pacifico: '56px "Pacifico", cursive',
      };
      tCtx.font = fontMap[signStudioState.selectedFont] || fontMap.dancing;
      tCtx.fillStyle = signStudioState.typeInkColor || '#0f172a';
      tCtx.textAlign = 'center';
      tCtx.textBaseline = 'middle';
      tCtx.fillText(name, tempCanvas.width / 2, tempCanvas.height / 2);
      const dataUrl = cropCanvasBoundingBox(tempCanvas);
      if (!dataUrl) return;

      const list = getStoredStampLibrary();
      list.unshift({
        id: 'stamp_lib_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
        name: `Chữ ký: ${name}`,
        dataUrl: dataUrl,
        createdAt: Date.now(),
      });
      saveStoredStampLibrary(list);
      renderStampLibrary();
      showToast('Đã lưu chữ ký nghệ thuật vào thư viện!', 'success');
    });
  }

  // 4. Tab 3: Official Vietnamese Stamp Presets & Events
  if (inputOfficialDate && !inputOfficialDate.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    inputOfficialDate.value = `${yyyy}-${mm}-${dd}`;
  }

  const presetChips = paneOfficial ? paneOfficial.querySelectorAll('.btn-preset-chip[data-preset]') : [];
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      presetChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const preset = chip.dataset.preset;
      signStudioState.officialPreset = preset;

      if (preset === 'title_name') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'block';
        if (lblOfficialTitle) lblOfficialTitle.textContent = 'Chức danh / Dòng trên (In hoa):';
        if (stampOfficialTitle) stampOfficialTitle.value = 'GIÁM ĐỐC';
        if (lblOfficialName) lblOfficialName.textContent = 'Họ và tên / Dòng dưới:';
        if (stampOfficialName) stampOfficialName.value = 'NGUYỄN VĂN AN';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'name_only') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Họ và tên:';
        if (stampOfficialName) stampOfficialName.value = 'NGUYỄN VĂN AN';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'business_tax') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'block';
        if (lblOfficialTitle) lblOfficialTitle.textContent = 'Tên đơn vị / Cửa hàng (In hoa):';
        if (stampOfficialTitle) stampOfficialTitle.value = 'HỘ KINH DOANH HOÀNG PHÁT';
        if (lblOfficialName) lblOfficialName.textContent = 'Mã số thuế / Số ĐKKD:';
        if (stampOfficialName) stampOfficialName.value = 'MST: 0312345678';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'block';
        if (lblOfficialExtra) lblOfficialExtra.textContent = 'Địa chỉ & Hotline:';
        if (stampOfficialExtra) stampOfficialExtra.value = 'ĐC: 123 Lê Lợi, Q.1, TP.HCM - ĐT: 0908.123.456';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'round_stamp') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'block';
        if (lblOfficialTitle) lblOfficialTitle.textContent = 'Vòng trên: Tên đơn vị / Tổ chức:';
        if (stampOfficialTitle) stampOfficialTitle.value = 'CÔNG TY TNHH PHÁT TRIỂN CÔNG NGHỆ';
        if (lblOfficialName) lblOfficialName.textContent = 'Vòng dưới: Tỉnh / Thành phố:';
        if (stampOfficialName) stampOfficialName.value = 'THÀNH PHỐ HÀ NỘI';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'block';
        if (lblOfficialExtra) lblOfficialExtra.textContent = 'Dòng giữa (MST / Mã hiệu):';
        if (stampOfficialExtra) stampOfficialExtra.value = 'MST: 0101234567';
        if (stampBorderType) stampBorderType.value = 'round';
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'paid') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ THU TIỀN';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'cash_out') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ CHI TIỀN';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'invoice_paid') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ THANH TOÁN';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'double';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'void') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'HỦY (VOID)';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'double';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#dc2626';
      } else if (preset === 'copy') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'SAO Y BẢN CHÍNH';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'double';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'duplicate') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'BẢN SAO';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'doc_incoming') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'block';
        if (lblOfficialTitle) lblOfficialTitle.textContent = 'Tiêu đề:';
        if (stampOfficialTitle) stampOfficialTitle.value = 'CÔNG VĂN ĐẾN';
        if (lblOfficialName) lblOfficialName.textContent = 'Số công văn:';
        if (stampOfficialName) stampOfficialName.value = 'Số: ........ / Đến ngày: ........';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#c81e1e';
      } else if (preset === 'secret') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'MẬT / HỎA TỐC';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'double';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#dc2626';
      } else if (preset === 'stock_in') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ NHẬP KHO';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#003399';
      } else if (preset === 'stock_out') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ XUẤT KHO';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#003399';
      } else if (preset === 'phone') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'BÁN HÀNG QUA ĐT';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'single';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#003399';
      } else if (preset === 'checked') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'ĐÃ ĐỐI CHIẾU';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'rounded';
        if (chkOfficialDate) chkOfficialDate.checked = false;
        signStudioState.officialColor = '#003399';
      } else if (preset === 'approved') {
        if (groupOfficialTitle) groupOfficialTitle.style.display = 'none';
        if (lblOfficialName) lblOfficialName.textContent = 'Nội dung con dấu:';
        if (stampOfficialName) stampOfficialName.value = 'GIÁM ĐỐC ĐÃ DUYỆT';
        if (groupOfficialExtra) groupOfficialExtra.style.display = 'none';
        if (stampBorderType) stampBorderType.value = 'double';
        if (chkOfficialDate) chkOfficialDate.checked = true;
        signStudioState.officialColor = '#c81e1e';
      }

      // Sync color dots
      const offDots = paneOfficial ? paneOfficial.querySelectorAll('.sign-color-dot[data-official-color]') : [];
      offDots.forEach(d => d.classList.toggle('active', d.dataset.officialColor === signStudioState.officialColor));

      // Show/hide date sub-controls based on chkOfficialDate
      if (chkOfficialDate) {
        if (selOfficialDateFormat) selOfficialDateFormat.style.display = chkOfficialDate.checked ? 'block' : 'none';
        if (rowOfficialDateInput) rowOfficialDateInput.style.display = chkOfficialDate.checked ? 'block' : 'none';
      }

      updateOfficialStampPreview();
      updateSignPlaceButton();
    });
  });

  const syncOfficialAndPlace = () => {
    updateOfficialStampPreview();
    updateSignPlaceButton();
  };
  if (stampOfficialTitle) stampOfficialTitle.addEventListener('input', syncOfficialAndPlace);
  if (stampOfficialName) stampOfficialName.addEventListener('input', syncOfficialAndPlace);
  if (stampOfficialExtra) stampOfficialExtra.addEventListener('input', syncOfficialAndPlace);
  if (stampBorderType) stampBorderType.addEventListener('change', syncOfficialAndPlace);

  if (chkOfficialDate) {
    chkOfficialDate.addEventListener('change', () => {
      if (selOfficialDateFormat) selOfficialDateFormat.style.display = chkOfficialDate.checked ? 'block' : 'none';
      if (rowOfficialDateInput) rowOfficialDateInput.style.display = chkOfficialDate.checked ? 'block' : 'none';
      updateOfficialStampPreview();
    });
  }
  if (selOfficialDateFormat) selOfficialDateFormat.addEventListener('change', updateOfficialStampPreview);
  if (inputOfficialDate) inputOfficialDate.addEventListener('input', updateOfficialStampPreview);

  if (chkOfficialGrunge) chkOfficialGrunge.addEventListener('change', updateOfficialStampPreview);
  if (rngOfficialAngle) {
    syncRangeFill(rngOfficialAngle);
    rngOfficialAngle.addEventListener('input', () => {
      syncRangeFill(rngOfficialAngle);
      updateOfficialStampPreview();
    });
  }

  // Apply-all: nhãn cảnh báo trực quan khi bật (rủi ro cao nếu copy nhầm)
  if (chkApplyAllPages) {
    const syncApplyAll = () => {
      const wrap = chkApplyAllPages.closest('.sign-apply-all');
      if (wrap) wrap.classList.toggle('is-on', chkApplyAllPages.checked);
    };
    chkApplyAllPages.addEventListener('change', syncApplyAll);
    syncApplyAll();
  }

  const officialColorDots = paneOfficial ? paneOfficial.querySelectorAll('.sign-color-dot[data-official-color]') : [];
  officialColorDots.forEach(dot => {
    dot.addEventListener('click', () => {
      officialColorDots.forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      signStudioState.officialColor = dot.dataset.officialColor || '#c81e1e';
      updateOfficialStampPreview();
    });
  });

  if (btnSaveOfficialToLib) {
    btnSaveOfficialToLib.addEventListener('click', () => {
      const isRound = stampBorderType && stampBorderType.value === 'round';
      const title = (stampOfficialTitle ? stampOfficialTitle.value : '').trim();
      const name = (stampOfficialName ? stampOfficialName.value : '').trim();
      const extra = (stampOfficialExtra ? stampOfficialExtra.value : '').trim();
      if (!name && !title) {
        showToast('Vui lòng nhập nội dung con dấu trước khi lưu!', 'danger');
        return;
      }
      const border = stampBorderType ? stampBorderType.value : 'single';
      const color = signStudioState.officialColor || '#c81e1e';
      const hasDate = chkOfficialDate ? chkOfficialDate.checked : false;
      const dateVal = inputOfficialDate ? inputOfficialDate.value : '';
      const formatType = selOfficialDateFormat ? selOfficialDateFormat.value : 'full';
      const dateText = hasDate ? formatOfficialDateString(dateVal, formatType) : '';
      const hasGrunge = chkOfficialGrunge ? chkOfficialGrunge.checked : true;
      const angle = rngOfficialAngle ? (parseFloat(rngOfficialAngle.value) || 0) : 0;

      let dataUrl = null;
      try {
        dataUrl = generateOfficialStampDataUrl({
          title,
          name,
          extra,
          borderType: border,
          color,
          hasDate,
          dateText,
          hasGrunge,
          angle,
        });
      } catch (genErr) {
        console.error('Lỗi khi tạo ảnh con dấu:', genErr);
        showToast('Không tạo được ảnh con dấu, vui lòng thử nội dung ngắn hơn!', 'danger');
        return;
      }
      if (!dataUrl) return;

      const list = getStoredStampLibrary();
      const stampName = title ? `${title} - ${name}` : name;
      list.unshift({
        id: 'stamp_lib_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
        name: `Dấu: ${stampName || 'Nghiệp vụ'}`,
        dataUrl: dataUrl,
        createdAt: Date.now(),
      });
      saveStoredStampLibrary(list);
      renderStampLibrary();
      showToast('Đã lưu con dấu nghiệp vụ vào thư viện!', 'success');
    });
  }

  // 6. Opacity Slider — áp ngay cho dấu đang chọn (không chỉ khi đặt mới)
  if (signOpacity) {
    syncRangeFill(signOpacity);
    signOpacity.addEventListener('input', () => {
      const val = parseInt(signOpacity.value, 10) || 100;
      syncRangeFill(signOpacity);
      if (signOpacityVal) signOpacityVal.textContent = `${val}%`;
      if (!signStudioState.selectedStampId) return;
      const stamp = signStudioState.currentStamps.find(s => s.id === signStudioState.selectedStampId);
      if (!stamp) return;
      stamp.opacity = val / 100;
      if (signStageOverlay) {
        const box = signStageOverlay.querySelector(`.stamp-box[data-stamp-id="${stamp.id}"]`);
        if (box) box.style.opacity = String(stamp.opacity);
      }
      const item = document.querySelector(`.sign-stamp-item[data-stamp-id="${stamp.id}"] .sign-stamp-opacity`);
      if (item) item.textContent = `${val}%`;
    });
  }

  // 7. Button: Place Stamp On Page
  if (btnPlaceStampOnPage) {
    btnPlaceStampOnPage.addEventListener('click', handlePlaceStampOnPage);
  }

  // 8. Button: Clear All Page Stamps
  if (btnClearPageStamps) {
    btnClearPageStamps.addEventListener('click', () => {
      if (signStudioState.currentStamps.length === 0) return;
      if (confirm('Bạn có chắc muốn xóa tất cả chữ ký và con dấu trên trang này?')) {
        signStudioState.currentStamps = [];
        deselectStamps();
        renderSignStageStamps();
        renderSignStampsList();
      }
    });
  }

  // 9. Stage Navigation
  if (signPageSelect) {
    signPageSelect.addEventListener('change', () => {
      const newIdx = parseInt(signPageSelect.value, 10);
      switchSignPage(newIdx);
    });
  }

  if (btnSignPrevPage) {
    btnSignPrevPage.addEventListener('click', () => {
      if (signStudioState.pageIndex > 0) {
        switchSignPage(signStudioState.pageIndex - 1);
      }
    });
  }

  if (btnSignNextPage) {
    btnSignNextPage.addEventListener('click', () => {
      if (signStudioState.pageIndex < state.pages.length - 1) {
        switchSignPage(signStudioState.pageIndex + 1);
      }
    });
  }

  // 10. Stage Zoom Controls (Interactive Input, Presets, Wheel Zoom)
  if (btnStageZoomIn) {
    btnStageZoomIn.addEventListener('click', () => {
      applyStageZoom(signStudioState.stageZoom + 0.15);
    });
  }
  if (btnStageZoomOut) {
    btnStageZoomOut.addEventListener('click', () => {
      applyStageZoom(signStudioState.stageZoom - 0.15);
    });
  }
  if (btnStageZoomFit) {
    btnStageZoomFit.addEventListener('click', () => {
      fitStageZoom();
    });
  }
  if (btnStageZoomFitWidth) {
    btnStageZoomFitWidth.addEventListener('click', () => {
      fitWidthStageZoom();
    });
  }

  // Editable Zoom Input
  if (inputStageZoom) {
    inputStageZoom.addEventListener('focus', () => {
      inputStageZoom.select();
    });

    const handleZoomInputSubmit = () => {
      let raw = inputStageZoom.value.replace(/%/g, '').trim();
      let num = parseFloat(raw);
      if (!isNaN(num) && num > 0) {
        applyStageZoom(num / 100);
      } else {
        inputStageZoom.value = `${Math.round(signStudioState.stageZoom * 100)}%`;
      }
    };

    inputStageZoom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleZoomInputSubmit();
        inputStageZoom.blur();
      }
    });

    inputStageZoom.addEventListener('blur', handleZoomInputSubmit);
  }

  // Preset Dropdown Menu
  if (btnStageZoomPresets && stageZoomMenu) {
    btnStageZoomPresets.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = stageZoomMenu.style.display !== 'none';
      stageZoomMenu.style.display = isVisible ? 'none' : 'flex';
    });

    stageZoomMenu.querySelectorAll('.zoom-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.dataset.zoom;
        if (val === 'fit') {
          fitStageZoom();
        } else if (val === 'fit-width') {
          fitWidthStageZoom();
        } else {
          applyStageZoom(parseFloat(val));
        }
        stageZoomMenu.style.display = 'none';
      });
    });

    document.addEventListener('click', (e) => {
      if (stageZoomMenu && !e.target.closest('#stageZoomWrap')) {
        stageZoomMenu.style.display = 'none';
      }
    });
  }

  // Wheel Zoom & Double click
  if (signStageViewport) {
    signStageViewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.12 : -0.12;
        applyStageZoom(signStudioState.stageZoom + delta);
      }
    }, { passive: false });

    signStageViewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.stamp-box') || e.target.closest('.stamp-floating-toolbar')) return;
      if (Math.abs(signStudioState.stageZoom - 1.0) < 0.08) {
        fitStageZoom();
      } else {
        applyStageZoom(1.0);
      }
    });

    signStageViewport.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.stamp-box') || e.target.closest('.stamp-floating-toolbar')) return;
      deselectStamps();
    });
  }

  // Floating Mini-Toolbar Actions
  if (btnFloatRotZero) {
    btnFloatRotZero.addEventListener('click', () => {
      const stamp = signStudioState.currentStamps.find(s => s.id === signStudioState.selectedStampId);
      if (stamp) {
        stamp.rotation = 0;
        const box = signStageOverlay.querySelector(`.stamp-box[data-stamp-id="${stamp.id}"]`);
        if (box) box.style.transform = 'rotate(0deg)';
        updateFloatingToolbarPosition();
        showToast('Đã đặt lại góc thẳng 0°', 'info');
      }
    });
  }

  if (btnFloatDuplicate) {
    btnFloatDuplicate.addEventListener('click', () => {
      const stamp = signStudioState.currentStamps.find(s => s.id === signStudioState.selectedStampId);
      if (stamp) {
        const dup = {
          ...stamp,
          id: 'stamp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          relX: Math.min(0.9 - stamp.relW, stamp.relX + 0.02),
          relY: Math.min(0.9 - stamp.relH, stamp.relY + 0.02),
        };
        signStudioState.currentStamps.push(dup);
        renderSignStageStamps();
        renderSignStampsList();
        selectStamp(dup.id);
        showToast('Đã nhân bản con dấu!', 'success');
      }
    });
  }

  if (btnFloatDelete) {
    btnFloatDelete.addEventListener('click', () => {
      if (signStudioState.selectedStampId) {
        signStudioState.currentStamps = signStudioState.currentStamps.filter(s => s.id !== signStudioState.selectedStampId);
        deselectStamps();
        renderSignStageStamps();
        renderSignStampsList();
        showToast('Đã xóa con dấu khỏi trang!', 'info');
      }
    });
  }

  // 11. Close & Save Modal Actions
  const closeStudio = () => closeSignStudio();
  if (signModalClose) signModalClose.addEventListener('click', closeStudio);
  if (signModalBackdrop) signModalBackdrop.addEventListener('click', closeStudio);
  if (btnCancelSign) btnCancelSign.addEventListener('click', closeStudio);
  if (btnSaveSignDone) btnSaveSignDone.addEventListener('click', saveAndCloseSignStudio);

  // Keyboard Shortcuts (Arrow Nudge, Delete, Ctrl+D, Escape)
  window.addEventListener('keydown', (e) => {
    if (!signModal.classList.contains('active')) return;

    if (e.key === 'Escape') {
      closeStudio();
      return;
    }

    // Ignore shortcuts when editing an input or select
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
      return;
    }

    if (signStudioState.selectedStampId) {
      const stamp = signStudioState.currentStamps.find(s => s.id === signStudioState.selectedStampId);
      if (!stamp) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        signStudioState.currentStamps = signStudioState.currentStamps.filter(s => s.id !== stamp.id);
        deselectStamps();
        renderSignStageStamps();
        renderSignStampsList();
        showToast('Đã xóa con dấu!', 'info');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const dup = {
          ...stamp,
          id: 'stamp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          relX: Math.min(0.9 - stamp.relW, stamp.relX + 0.02),
          relY: Math.min(0.9 - stamp.relH, stamp.relY + 0.02),
        };
        signStudioState.currentStamps.push(dup);
        renderSignStageStamps();
        renderSignStampsList();
        selectStamp(dup.id);
        showToast('Đã nhân bản con dấu!', 'success');
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const cW = signStageCanvas.width || 800;
        const cH = signStageCanvas.height || 1100;
        const dx = step / cW;
        const dy = step / cH;

        if (e.key === 'ArrowLeft') stamp.relX = Math.max(0, stamp.relX - dx);
        if (e.key === 'ArrowRight') stamp.relX = Math.min(1 - stamp.relW, stamp.relX + dx);
        if (e.key === 'ArrowUp') stamp.relY = Math.max(0, stamp.relY - dy);
        if (e.key === 'ArrowDown') stamp.relY = Math.min(1 - stamp.relH, stamp.relY + dy);

        const box = signStageOverlay.querySelector(`.stamp-box[data-stamp-id="${stamp.id}"]`);
        if (box) {
          box.style.left = `${stamp.relX * 100}%`;
          box.style.top = `${stamp.relY * 100}%`;
        }
        updateFloatingToolbarPosition();
      }
    }
  });
}

function handlePlaceStampOnPage() {
  if (btnPlaceStampOnPage && btnPlaceStampOnPage.disabled) return;
  let dataUrl = null;

  if (signStudioState.activeTab === 'upload') {
    const list = getStoredStampLibrary();
    if (list.length === 0) {
      showToast('Vui lòng tải lên ít nhất 1 ảnh con dấu trong thư viện hoặc nhấn "Dùng dấu"!', 'danger');
      return;
    }
    // Dùng đúng thẻ đang chọn (không còn hardcode list[0]).
    const picked = list.find(x => x.id === signStudioState.selectedLibId) || list[0];
    if (signStudioState.selectedLibId !== picked.id) {
      signStudioState.selectedLibId = picked.id;
      renderStampLibrary();
    }
    dataUrl = picked.dataUrl;
  } else if (signStudioState.activeTab === 'type') {
    const name = (signTypeName ? signTypeName.value : '').trim();
    if (!name) {
      showToast('Vui lòng nhập họ và tên để tạo chữ ký!', 'danger');
      return;
    }
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 900;
    tempCanvas.height = 280;
    const tCtx = tempCanvas.getContext('2d');
    const fontMap = {
      dancing: 'bold 64px "Dancing Script", cursive',
      greatvibes: '68px "Great Vibes", cursive',
      alexbrush: 'bold 64px "Alex Brush", cursive',
      caveat: 'bold 68px "Caveat", cursive',
      pacifico: '56px "Pacifico", cursive',
    };
    tCtx.font = fontMap[signStudioState.selectedFont] || fontMap.dancing;
    tCtx.fillStyle = signStudioState.typeInkColor || '#0f172a';
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    tCtx.fillText(name, tempCanvas.width / 2, tempCanvas.height / 2);
    dataUrl = cropCanvasBoundingBox(tempCanvas);
  } else if (signStudioState.activeTab === 'official') {
    const isRound = stampBorderType && stampBorderType.value === 'round';
    const title = (stampOfficialTitle ? stampOfficialTitle.value : '').trim();
    const name = (stampOfficialName ? stampOfficialName.value : '').trim();
    const extra = (stampOfficialExtra ? stampOfficialExtra.value : '').trim();
    if (!name && !title) {
      showToast('Vui lòng nhập nội dung con dấu!', 'danger');
      return;
    }
    const border = stampBorderType ? stampBorderType.value : 'single';
    const color = signStudioState.officialColor || '#c81e1e';
    const hasDate = chkOfficialDate ? chkOfficialDate.checked : false;
    const dateVal = inputOfficialDate ? inputOfficialDate.value : '';
    const formatType = selOfficialDateFormat ? selOfficialDateFormat.value : 'full';
    const dateText = hasDate ? formatOfficialDateString(dateVal, formatType) : '';
    const hasGrunge = chkOfficialGrunge ? chkOfficialGrunge.checked : true;
    const angle = rngOfficialAngle ? (parseFloat(rngOfficialAngle.value) || 0) : 0;

    try {
      dataUrl = generateOfficialStampDataUrl({
        title,
        name,
        extra,
        borderType: border,
        color,
        hasDate,
        dateText,
        hasGrunge,
        angle,
      });
    } catch (genErr) {
      console.error('Lỗi khi tạo ảnh con dấu:', genErr);
      showToast('Không tạo được ảnh con dấu, vui lòng thử nội dung ngắn hơn!', 'danger');
      return;
    }
  }

  if (!dataUrl) return;
  addStampToCurrentPage(dataUrl);
}

function addStampToCurrentPage(dataUrl) {
  const pageItem = state.pages[signStudioState.pageIndex];
  if (!pageItem) return;

  const img = new Image();
  img.onload = () => {
    const pageW = pageItem.width || 595;
    const pageH = pageItem.height || 842;
    const isSwapped = (pageItem.rotation / 90) % 2 !== 0;
    const displayW = isSwapped ? pageH : pageW;
    const displayH = isSwapped ? pageW : pageH;

    const aspect = (img.naturalWidth && img.naturalHeight) ? (img.naturalWidth / img.naturalHeight) : 2.0;
    const relW = 0.28; // ~28% of page width
    const pixelW = relW * displayW;
    const pixelH = pixelW / aspect;
    const relH = Math.min(0.45, pixelH / displayH);

    const relX = Math.max(0.04, Math.min(0.66, 0.96 - relW));
    const relY = Math.max(0.04, Math.min(0.72, 0.96 - relH));
    const opacity = (parseInt(signOpacity ? signOpacity.value : 100, 10) || 100) / 100.0;

    const newStamp = {
      id: 'stamp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      dataUrl: dataUrl,
      relX: relX,
      relY: relY,
      relW: relW,
      relH: relH,
      rotation: 0,
      opacity: opacity,
      _img: img,
    };

    signStudioState.currentStamps.push(newStamp);
    renderSignStageStamps();
    renderSignStampsList();
    selectStamp(newStamp.id);
    flashStampPlaced(newStamp.id);
    showToast('Đã đặt con dấu / chữ ký lên trang! Hãy kéo di chuyển, xoay hoặc co giãn.', 'success');
  };
  img.src = dataUrl;
}

function openSignStudio(pageIndex) {
  if (state.pages.length === 0) {
    showToast('Vui lòng mở ít nhất 1 tệp PDF trước khi ký hoặc đóng dấu!', 'danger');
    return;
  }

  // Tải lười font chữ ký nghệ thuật và thư viện pdf-lib khi người dùng mở Sign Studio
  ensureCursiveFontsLoaded();
  ensurePdfLibLoaded().catch(() => {});

  if (pageIndex === undefined || pageIndex === null || pageIndex < 0 || pageIndex >= state.pages.length) {
    const selIdx = state.pages.findIndex(p => p.isSelected);
    pageIndex = selIdx >= 0 ? selIdx : 0;
  }

  signStudioState.pageIndex = pageIndex;
  const p = state.pages[pageIndex];
  signStudioState.currentStamps = (p.stamps || []).map(s => ({ ...s }));
  signStudioState.selectedStampId = null;

  // Populate signPageSelect
  if (signPageSelect) {
    signPageSelect.innerHTML = '';
    state.pages.forEach((page, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      const label = page.title && page.title.trim() && page.title !== `Trang ${i + 1}`
        ? `${i + 1}. ${page.title}`
        : `Trang ${i + 1}`;
      opt.textContent = label;
      signPageSelect.appendChild(opt);
    });
    signPageSelect.value = String(pageIndex);
  }

  if (btnSignPrevPage) btnSignPrevPage.disabled = pageIndex === 0;
  if (btnSignNextPage) btnSignNextPage.disabled = pageIndex === state.pages.length - 1;
  if (signDocInfo) signDocInfo.textContent = `• Trang ${pageIndex + 1}/${state.pages.length}`;
  if (chkApplyAllPages) {
    chkApplyAllPages.checked = false;
    const applyWrap = chkApplyAllPages.closest('.sign-apply-all');
    if (applyWrap) applyWrap.classList.remove('is-on');
  }

  // Mở modal ngay lập tức để người dùng thấy giao diện phản hồi tức thì
  if (signModal) {
    signModal.classList.add('active');
  }

  try {
    applyStageZoom(1.0);
  } catch (err) {
    console.warn('Lỗi khi thiết lập zoom ban đầu:', err);
  }

  try {
    renderStampLibrary();
  } catch (err) {
    console.warn('Lỗi khi nạp thư viện con dấu:', err);
  }

  try {
    updateSignPlaceButton();
    updateStageEmptyHint();
  } catch (err) {
    console.warn('Lỗi khi cập nhật nút Place:', err);
  }

  try {
    updateOfficialStampPreview();
  } catch (err) {
    console.warn('Lỗi khi cập nhật xem trước con dấu:', err);
  }

  try {
    renderSignStage().then(() => {
      fitStageZoom();
    }).catch(err => {
      console.warn('Lỗi khi vẽ sân khấu ký:', err);
    });
  } catch (err) {
    console.warn('Lỗi khi khởi chạy render sân khấu ký:', err);
  }

  try {
    renderSignStampsList();
  } catch (err) {
    console.warn('Lỗi khi nạp danh sách con dấu trên trang:', err);
  }
}

function closeSignStudio() {
  deselectStamps();
  if (signModal) signModal.classList.remove('active');
}

function switchSignPage(newIndex) {
  if (newIndex < 0 || newIndex >= state.pages.length) return;
  // Save current working stamps to the current page in state
  if (state.pages[signStudioState.pageIndex]) {
    state.pages[signStudioState.pageIndex].stamps = signStudioState.currentStamps.map(s => ({ ...s }));
  }

  signStudioState.pageIndex = newIndex;
  const p = state.pages[newIndex];
  signStudioState.currentStamps = (p.stamps || []).map(s => ({ ...s }));
  deselectStamps();

  if (signPageSelect) signPageSelect.value = String(newIndex);
  if (btnSignPrevPage) btnSignPrevPage.disabled = newIndex === 0;
  if (btnSignNextPage) btnSignNextPage.disabled = newIndex === state.pages.length - 1;
  if (signDocInfo) signDocInfo.textContent = `• Trang ${newIndex + 1}/${state.pages.length}`;

  renderSignStage();
  renderSignStampsList();
}

function saveAndCloseSignStudio() {
  if (state.pages[signStudioState.pageIndex]) {
    state.pages[signStudioState.pageIndex].stamps = signStudioState.currentStamps.map(s => ({ ...s }));
  }

  saveHistoryState();

  if (chkApplyAllPages && chkApplyAllPages.checked) {
    const stampsToCopy = signStudioState.currentStamps.map(s => ({ ...s }));
    state.pages.forEach(p => {
      p.stamps = stampsToCopy.map(s => ({ ...s }));
      thumbnailCache.delete(`${p.id}_${p.rotation}`);
      previewCache.delete(`${p.id}_${p.rotation}_hd`);
    });
    showToast(`Đã áp dụng ${stampsToCopy.length} con dấu cho toàn bộ ${state.pages.length} trang!`, 'success');
  } else {
    const p = state.pages[signStudioState.pageIndex];
    if (p) {
      thumbnailCache.delete(`${p.id}_${p.rotation}`);
      previewCache.delete(`${p.id}_${p.rotation}_hd`);
    }
    showToast(`Đã lưu chữ ký và con dấu cho trang #${signStudioState.pageIndex + 1}!`, 'success');
  }

  renderGrid();
  closeSignStudio();
}

async function renderSignStage() {
  if (signStudioState.pageIndex < 0 || signStudioState.pageIndex >= state.pages.length) return;
  const myToken = ++signStageRenderToken;
  // Hủy tác vụ vẽ cũ còn dở để chuyển trang nhanh không bị race / crash.
  if (signStageCanvas && signStageCanvas._pdfRenderTask && typeof signStageCanvas._pdfRenderTask.cancel === 'function') {
    try { signStageCanvas._pdfRenderTask.cancel(); } catch (e) {}
    signStageCanvas._pdfRenderTask = null;
  }
  const pageItem = state.pages[signStudioState.pageIndex];
  const srcObj = state.sources.get(pageItem.sourceId);
  if (!srcObj) return;

  try {
    const page = await srcObj.pdfJsDoc.getPage(pageItem.pageIndex + 1);
    if (myToken !== signStageRenderToken) { try { page.cleanup(); } catch (e) {} return; }
    const totalRot = (page.rotate + pageItem.rotation) % 360;
    const unscaled = page.getViewport({ scale: 1.0, rotation: totalRot });
    const maxDim = Math.max(unscaled.width, unscaled.height);
    const stageScale = Math.min(1.6, Math.max(1.0, 1100 / maxDim));
    const viewport = page.getViewport({ scale: stageScale, rotation: totalRot });

    signStageCanvas.width = Math.max(1, Math.floor(viewport.width));
    signStageCanvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = signStageCanvas.getContext('2d');
    const renderTask = page.render({ canvasContext: ctx, viewport });
    signStageCanvas._pdfRenderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (renderErr) {
      // Bỏ qua lỗi hủy render do chuyển trang/zoom nhanh (không phải crash thật).
      if (renderErr && (renderErr.name === 'RenderingCancelledException' || /cancel/i.test(renderErr.message || ''))) {
        return;
      }
      throw renderErr;
    } finally {
      if (signStageCanvas._pdfRenderTask === renderTask) signStageCanvas._pdfRenderTask = null;
    }
    if (myToken !== signStageRenderToken) return;
    // Đồng bộ lại kích thước layout theo zoom hiện tại (giữ nguyên mức zoom).
    applyStageZoom(signStudioState.stageZoom, { anchor: 'top' });

    renderSignStageStamps();
  } catch (err) {
    if (myToken !== signStageRenderToken) return;
    console.error('Lỗi khi hiển thị trang trong Studio ký:', err);
  }
}

function renderSignStageStamps() {
  if (!signStageOverlay) return;
  signStageOverlay.innerHTML = '';

  signStudioState.currentStamps.forEach(stamp => {
    const box = document.createElement('div');
    box.className = 'stamp-box';
    if (stamp.id === signStudioState.selectedStampId) {
      box.classList.add('active');
    }
    box.dataset.stampId = stamp.id;
    box.style.left = `${stamp.relX * 100}%`;
    box.style.top = `${stamp.relY * 100}%`;
    box.style.width = `${stamp.relW * 100}%`;
    box.style.height = `${stamp.relH * 100}%`;
    box.style.opacity = stamp.opacity !== undefined ? stamp.opacity : 1.0;
    box.style.transform = `rotate(${stamp.rotation || 0}deg)`;

    box.innerHTML = `
      <img class="stamp-box-img" src="${stamp.dataUrl}" alt="Chữ ký / con dấu">
      <div class="stamp-del-btn" title="Xóa con dấu này">×</div>
      <div class="stamp-handle-rot" data-handle="rot" title="Kéo để xoay con dấu"></div>
      <div class="stamp-handle stamp-handle-nw" data-handle="nw"></div>
      <div class="stamp-handle stamp-handle-ne" data-handle="ne"></div>
      <div class="stamp-handle stamp-handle-sw" data-handle="sw"></div>
      <div class="stamp-handle stamp-handle-se" data-handle="se"></div>
    `;

    setupStampBoxInteractivity(box, stamp);
    signStageOverlay.appendChild(box);
  });

  updateStageEmptyHint();
  updateFloatingToolbarPosition();
}

function setupStampBoxInteractivity(boxEl, stamp) {
  let startPointerX = 0;
  let startPointerY = 0;
  let startRelX = stamp.relX;
  let startRelY = stamp.relY;
  let startRelW = stamp.relW;
  let startRelH = stamp.relH;
  let isDragging = false;
  let isResizing = false;
  let isRotating = false;
  let currentHandle = null;

  // Click on stamp to select
  boxEl.addEventListener('click', (e) => {
    e.stopPropagation();
    selectStamp(stamp.id);
  });

  // Gộp nhiều pointermove trong 1 frame: mỗi frame chỉ đọc layout + vẽ 1 lần (chống giật khi kéo nhanh)
  let moveRaf = 0;
  let pendingMoveEvent = null;
  const onPointerMove = (e) => {
    pendingMoveEvent = e;
    if (!moveRaf) moveRaf = requestAnimationFrame(flushPointerMove);
  };
  const flushPointerMove = () => {
    moveRaf = 0;
    const e = pendingMoveEvent;
    pendingMoveEvent = null;
    if (!e) return;
    const overlayRect = signStageOverlay.getBoundingClientRect();
    if (!overlayRect.width || !overlayRect.height) return;

    const deltaX = (e.clientX - startPointerX) / overlayRect.width;
    const deltaY = (e.clientY - startPointerY) / overlayRect.height;

    if (isDragging) {
      let newX = Math.max(0, Math.min(1 - stamp.relW, startRelX + deltaX));
      let newY = Math.max(0, Math.min(1 - stamp.relH, startRelY + deltaY));
      stamp.relX = newX;
      stamp.relY = newY;
      boxEl.style.left = `${newX * 100}%`;
      boxEl.style.top = `${newY * 100}%`;
      updateFloatingToolbarPosition();
    } else if (isResizing && currentHandle) {
      const minW = 0.04;
      const aspect = Math.max(0.2, startRelW / (startRelH || 0.1));

      if (currentHandle === 'se') {
        let newW = Math.max(minW, Math.min(1 - startRelX, startRelW + deltaX));
        let newH = newW / aspect;
        if (startRelY + newH > 1) {
          newH = 1 - startRelY;
          newW = newH * aspect;
        }
        stamp.relW = newW;
        stamp.relH = newH;
        boxEl.style.width = `${newW * 100}%`;
        boxEl.style.height = `${newH * 100}%`;
      } else if (currentHandle === 'sw') {
        let newW = Math.max(minW, Math.min(startRelX + startRelW, startRelW - deltaX));
        let newH = newW / aspect;
        if (startRelY + newH > 1) {
          newH = 1 - startRelY;
          newW = newH * aspect;
        }
        let newX = startRelX + (startRelW - newW);
        stamp.relX = newX;
        stamp.relW = newW;
        stamp.relH = newH;
        boxEl.style.left = `${newX * 100}%`;
        boxEl.style.width = `${newW * 100}%`;
        boxEl.style.height = `${newH * 100}%`;
      } else if (currentHandle === 'ne') {
        let newW = Math.max(minW, Math.min(1 - startRelX, startRelW + deltaX));
        let newH = newW / aspect;
        let newY = startRelY + (startRelH - newH);
        if (newY < 0) {
          newY = 0;
          newH = startRelY + startRelH;
          newW = newH * aspect;
        }
        stamp.relY = newY;
        stamp.relW = newW;
        stamp.relH = newH;
        boxEl.style.top = `${newY * 100}%`;
        boxEl.style.width = `${newW * 100}%`;
        boxEl.style.height = `${newH * 100}%`;
      } else if (currentHandle === 'nw') {
        let newW = Math.max(minW, Math.min(startRelX + startRelW, startRelW - deltaX));
        let newH = newW / aspect;
        let newX = startRelX + (startRelW - newW);
        let newY = startRelY + (startRelH - newH);
        if (newY < 0) {
          newY = 0;
          newH = startRelY + startRelH;
          newW = newH * aspect;
          newX = startRelX + (startRelW - newW);
        }
        stamp.relX = newX;
        stamp.relY = newY;
        stamp.relW = newW;
        stamp.relH = newH;
        boxEl.style.left = `${newX * 100}%`;
        boxEl.style.top = `${newY * 100}%`;
        boxEl.style.width = `${newW * 100}%`;
        boxEl.style.height = `${newH * 100}%`;
      }
      updateFloatingToolbarPosition();
    }
  };

  const onPointerUp = () => {
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; pendingMoveEvent = null; }
    if (isDragging) {
      isDragging = false;
      boxEl.classList.remove('dragging');
      updateFloatingToolbarPosition();
    }
    if (isResizing) {
      isResizing = false;
      currentHandle = null;
      updateFloatingToolbarPosition();
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  // Drag move listener
  boxEl.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('stamp-handle') || e.target.classList.contains('stamp-handle-rot') || e.target.classList.contains('stamp-del-btn')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectStamp(stamp.id);
    isDragging = true;
    boxEl.classList.add('dragging');
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    startRelX = stamp.relX;
    startRelY = stamp.relY;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  // Rotate handle listener
  const rotHandle = boxEl.querySelector('.stamp-handle-rot');
  if (rotHandle) {
    rotHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectStamp(stamp.id);
      isRotating = true;
      try { rotHandle.setPointerCapture(e.pointerId); } catch (err) {}

      // Gộp xoay theo frame để không đọc layout + vẽ quá 1 lần/frame
      let rotRaf = 0;
      let pendingRotEvent = null;
      const onRotMove = (ev) => {
        pendingRotEvent = ev;
        if (!rotRaf) rotRaf = requestAnimationFrame(flushRotMove);
      };
      const flushRotMove = () => {
        rotRaf = 0;
        const ev = pendingRotEvent;
        pendingRotEvent = null;
        if (!isRotating || !ev) return;
        const rect = boxEl.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const rad = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
        let deg = (rad * 180 / Math.PI) + 90;
        if (deg < 0) deg += 360;

        const snapAngles = [0, 90, 180, 270, 360];
        for (const sa of snapAngles) {
          if (Math.abs(deg - sa) < 4) {
            deg = sa === 360 ? 0 : sa;
            break;
          }
        }
        stamp.rotation = Math.round(deg);
        boxEl.style.transform = `rotate(${stamp.rotation}deg)`;
        updateFloatingToolbarPosition();
      };

      const onRotUp = (ev) => {
        isRotating = false;
        if (rotRaf) { cancelAnimationFrame(rotRaf); rotRaf = 0; pendingRotEvent = null; }
        try { rotHandle.releasePointerCapture(ev.pointerId); } catch (err) {}
        window.removeEventListener('pointermove', onRotMove);
        window.removeEventListener('pointerup', onRotUp);
        updateFloatingToolbarPosition();
      };

      window.addEventListener('pointermove', onRotMove);
      window.addEventListener('pointerup', onRotUp);
    });
  }

  // Resize handles listeners
  boxEl.querySelectorAll('.stamp-handle').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectStamp(stamp.id);
      isResizing = true;
      currentHandle = handle.dataset.handle;
      startPointerX = e.clientX;
      startPointerY = e.clientY;
      startRelX = stamp.relX;
      startRelY = stamp.relY;
      startRelW = stamp.relW;
      startRelH = stamp.relH;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });
  });

  // Delete button listener
  const delBtn = boxEl.querySelector('.stamp-del-btn');
  if (delBtn) {
    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      signStudioState.currentStamps = signStudioState.currentStamps.filter(s => s.id !== stamp.id);
      deselectStamps();
      renderSignStageStamps();
      renderSignStampsList();
      showToast('Đã xóa con dấu!', 'info');
    });
  }
}

function renderSignStampsList() {
  if (!signStampsList) return;
  const count = signStudioState.currentStamps.length;
  if (signStampCountBadge) {
    signStampCountBadge.textContent = `${count} dấu`;
  }

  if (count === 0) {
    signStampsList.innerHTML = '<div class="sign-empty-hint">Chưa có chữ ký hoặc con dấu nào trên trang này.</div>';
    if (btnClearPageStamps) btnClearPageStamps.style.display = 'none';
    return;
  }

  if (btnClearPageStamps) btnClearPageStamps.style.display = 'flex';
  signStampsList.innerHTML = '';

  signStudioState.currentStamps.forEach((stamp, idx) => {
    const item = document.createElement('div');
    item.className = 'sign-stamp-item';
    if (stamp.id === signStudioState.selectedStampId) item.classList.add('selected');
    item.dataset.stampId = stamp.id;
    const opPct = Math.round((stamp.opacity !== undefined ? stamp.opacity : 1) * 100);
    item.innerHTML = `
      <div class="sign-stamp-item-left">
        <img src="${stamp.dataUrl}" alt="Dấu #${idx + 1}">
        <span>Dấu #${idx + 1} · <span class="sign-stamp-opacity">${opPct}%</span></span>
      </div>
      <button type="button" class="btn btn-tool btn-danger btn-sm" title="Xóa">Xóa</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') {
        selectStamp(stamp.id);
      }
    });

    const btnDel = item.querySelector('button');
    if (btnDel) {
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        signStudioState.currentStamps = signStudioState.currentStamps.filter(s => s.id !== stamp.id);
        deselectStamps();
        renderSignStageStamps();
        renderSignStampsList();
      });
    }
    signStampsList.appendChild(item);
  });
}

// Start application
window.addEventListener('DOMContentLoaded', () => {
  init();
  setupQuitButton();
});
