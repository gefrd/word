// src/modules/tools/excel.js
let Spreadsheet = null;
let globalInputShield = null;

async function getSpreadsheetClass() {
  if (Spreadsheet) return Spreadsheet;
  if (typeof window !== 'undefined' && window.x_spreadsheet) {
    return window.x_spreadsheet;
  }
  try {
    const mod = await import('x-data-spreadsheet/dist/xspreadsheet.js');
    Spreadsheet = mod.default || mod;
  } catch (e) {
    if (typeof window !== 'undefined' && window.x_spreadsheet) {
      Spreadsheet = window.x_spreadsheet;
    }
  }
  return Spreadsheet;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  import('x-data-spreadsheet/dist/xspreadsheet.css').catch(() => {});
}

// ── Translation & i18n Helpers ──
const EXCEL_I18N = {
  en: {
    untitled: 'Untitled Spreadsheet',
    saved_offline: 'Saved on device (Offline)',
    saved_local: 'Saved locally',
    saving: 'Saving...',
    storage_limit: 'Storage limit reached! Please free up space.',
    open_btn: 'Open',
    csv_btn: 'CSV',
    formula_placeholder: 'Enter text or formula (=SUM...)',
    search_placeholder: 'Search cells or jump to ref (e.g. B5)...',
    tab_home: 'Home',
    tab_formulas: 'Formulas',
    tab_file: 'File & Templates',
    undo_title: 'Undo (Ctrl+Z)',
    redo_title: 'Redo (Ctrl+Y)',
    insert_row: 'Row',
    delete_row: 'Row',
    insert_col: 'Col',
    delete_col: 'Col',
    bold_title: 'Bold (Ctrl+B)',
    italic_title: 'Italic (Ctrl+I)',
    text_color_title: 'Text Color',
    fill_color_title: 'Fill Color',
    align_left: 'Align Left',
    align_center: 'Align Center',
    align_right: 'Align Right',
    merge_btn: 'Merge',
    freeze_btn: 'Freeze',
    search_title: 'Search (Ctrl+F)',
    shortcuts_label: 'Shortcuts:',
    open_file_btn: 'Open File',
    download_csv: 'Download CSV',
    download_xlsx: 'Download Excel',
    share_btn: 'Share',
    templates_label: 'Templates:',
    tpl_sales: 'Sales Log',
    tpl_inventory: 'Inventory',
    tpl_budget: 'Budget',
    nothing_to_undo: 'Nothing to undo',
    nothing_to_redo: 'Nothing to redo',
    cells_merged: 'Cells merged/unmerged',
    row_frozen: 'Top row frozen',
    row_unfrozen: 'Rows unfrozen',
    copied_clipboard: 'Copied table to clipboard',
    share_failed: 'Share failed',
    import_success: 'Imported {filename} successfully!',
    import_fail: 'Failed to parse file. Ensure it is a valid CSV or XLSX.',
    csv_export_success: 'CSV exported successfully!',
    csv_export_fail: 'Failed to export CSV.',
    xlsx_export_success: 'Excel exported successfully!',
    xlsx_export_fail: 'Failed to export Excel.',
    confirm_template: 'Applying a template will overwrite your current spreadsheet. Are you sure you want to continue?',
    template_loaded: '{template} template loaded!'
  },
  fr: {
    untitled: 'Feuille de calcul sans titre',
    saved_offline: 'Enregistré sur l\'appareil (Hors ligne)',
    saved_local: 'Enregistré localement',
    saving: 'Enregistrement...',
    storage_limit: 'Limite de stockage atteinte ! Veuillez libérer de l\'espace.',
    open_btn: 'Ouvrir',
    csv_btn: 'CSV',
    formula_placeholder: 'Saisir texte ou formule (=SOMME...)',
    search_placeholder: 'Rechercher ou aller à la cellule (ex: B5)...',
    tab_home: 'Accueil',
    tab_formulas: 'Formules',
    tab_file: 'Fichier & Modèles',
    undo_title: 'Annuler (Ctrl+Z)',
    redo_title: 'Rétablir (Ctrl+Y)',
    insert_row: 'Ligne',
    delete_row: 'Ligne',
    insert_col: 'Col',
    delete_col: 'Col',
    bold_title: 'Gras (Ctrl+B)',
    italic_title: 'Italique (Ctrl+I)',
    text_color_title: 'Couleur texte',
    fill_color_title: 'Couleur fond',
    align_left: 'Aligner à gauche',
    align_center: 'Centrer',
    align_right: 'Aligner à droite',
    merge_btn: 'Fusionner',
    freeze_btn: 'Figer',
    search_title: 'Rechercher (Ctrl+F)',
    shortcuts_label: 'Raccourcis :',
    open_file_btn: 'Ouvrir fichier',
    download_csv: 'Télécharger CSV',
    download_xlsx: 'Télécharger Excel',
    share_btn: 'Partager',
    templates_label: 'Modèles :',
    tpl_sales: 'Journal des ventes',
    tpl_inventory: 'Inventaire',
    tpl_budget: 'Budget',
    nothing_to_undo: 'Rien à annuler',
    nothing_to_redo: 'Rien à rétablir',
    cells_merged: 'Cellules fusionnées/séparées',
    row_frozen: 'Première ligne figée',
    row_unfrozen: 'Lignes libérées',
    copied_clipboard: 'Tableau copié dans le presse-papiers',
    share_failed: 'Échec du partage',
    import_success: '{filename} importé avec succès !',
    import_fail: 'Échec de l\'analyse du fichier. Assurez-vous qu\'il s\'agit d\'un CSV ou XLSX valide.',
    csv_export_success: 'CSV exporté avec succès !',
    csv_export_fail: 'Échec de l\'exportation CSV.',
    xlsx_export_success: 'Excel exporté avec succès !',
    xlsx_export_fail: 'Échec de l\'exportation Excel.',
    confirm_template: 'L\'application d\'un modèle écrasera votre feuille actuelle. Voulez-vous continuer ?',
    template_loaded: 'Modèle {template} chargé !'
  },
  sw: {
    untitled: 'Lahajedwali Isiyo na Kichwa',
    saved_offline: 'Imehifadhiwa kwenye kifaa (Nje ya mtandao)',
    saved_local: 'Imehifadhiwa',
    saving: 'Inahifadhi...',
    storage_limit: 'Kikomo cha hifadhi kimefikiwa! Tafadhali futa faili.',
    open_btn: 'Fungua',
    csv_btn: 'CSV',
    formula_placeholder: 'Andika maandishi au fomula (=SUM...)',
    search_placeholder: 'Tafuta seli (mf. B5)...',
    tab_home: 'Nyumbani',
    tab_formulas: 'Fomula',
    tab_file: 'Faili na Violezo',
    undo_title: 'Tendua (Ctrl+Z)',
    redo_title: 'Rudia (Ctrl+Y)',
    insert_row: 'Mstari',
    delete_row: 'Mstari',
    insert_col: 'Safu',
    delete_col: 'Safu',
    bold_title: 'Kukoleza (Ctrl+B)',
    italic_title: 'Mlazo (Ctrl+I)',
    text_color_title: 'Rangi ya Maandishi',
    fill_color_title: 'Rangi ya Nyuma',
    align_left: 'Kushoto',
    align_center: 'Katikati',
    align_right: 'Kulia',
    merge_btn: 'Unganisha',
    freeze_btn: 'Gandisha',
    search_title: 'Tafuta (Ctrl+F)',
    shortcuts_label: 'Njia za mkato:',
    open_file_btn: 'Fungua Faili',
    download_csv: 'Pakua CSV',
    download_xlsx: 'Pakua Excel',
    share_btn: 'Shiriki',
    templates_label: 'Violezo:',
    tpl_sales: 'Mauzo',
    tpl_inventory: 'Hisa',
    tpl_budget: 'Bajeti',
    nothing_to_undo: 'Hakuna cha kutendua',
    nothing_to_redo: 'Hakuna cha kurudia',
    cells_merged: 'Seli zimeunganishwa',
    row_frozen: 'Mstari wa juu umegandishwa',
    row_unfrozen: 'Mstari haujagandishwa',
    copied_clipboard: 'Imenakiliwa kwenye ubao wa kunakili',
    share_failed: 'Imeshindwa kushiriki',
    import_success: '{filename} imeingizwa kikamilifu!',
    import_fail: 'Imeshindwa kufungua faili. Hakikisha ni CSV au XLSX halali.',
    csv_export_success: 'CSV imepakuliwa kwa mafanikio!',
    csv_export_fail: 'Imeshindwa kupakua CSV.',
    xlsx_export_success: 'Excel imepakuliwa kwa mafanikio!',
    xlsx_export_fail: 'Imeshindwa kupakua Excel.',
    confirm_template: 'Kuweka kiolezo kutafuta data yako ya sasa. Unataka kuendelea?',
    template_loaded: 'Kiolezo cha {template} kimewekwa!'
  },
  rw: {
    untitled: 'Urupapuro Rutagira Umutwe',
    saved_offline: 'Byabitswe kuri telefone (Nta interineti)',
    saved_local: 'Byabitswe',
    saving: 'Birabikwa...',
    storage_limit: 'Ububiko bwashize! Banza usukure ibitari ngombwa.',
    open_btn: 'Fungura',
    csv_btn: 'CSV',
    formula_placeholder: 'Andika inyandiko cyangwa imibare (=SUM...)',
    search_placeholder: 'Shakisha muri kashi (urugero B5)...',
    tab_home: 'Ahabanza',
    tab_formulas: 'Imibare',
    tab_file: 'Dosiye & Inyandikorugero',
    undo_title: 'Kugarura (Ctrl+Z)',
    redo_title: 'Gusubiramo (Ctrl+Y)',
    insert_row: 'Umurongo',
    delete_row: 'Umurongo',
    insert_col: 'Inkingi',
    delete_col: 'Inkingi',
    bold_title: 'Gutsindagira (Ctrl+B)',
    italic_title: 'Kwikinika (Ctrl+I)',
    text_color_title: 'Ibara ry\'inyandiko',
    fill_color_title: 'Ibara ry\'inyuma',
    align_left: 'Ibumoso',
    align_center: 'Hagati',
    align_right: 'Iburyo',
    merge_btn: 'Guhuza',
    freeze_btn: 'Gufunga hejuru',
    search_title: 'Shakisha (Ctrl+F)',
    shortcuts_label: 'Uburyo bwihuse:',
    open_file_btn: 'Fungura dosiye',
    download_csv: 'Manura CSV',
    download_xlsx: 'Manura Excel',
    share_btn: 'Sangiza',
    templates_label: 'Inyandikorugero:',
    tpl_sales: 'Ibyagurishijwe',
    tpl_inventory: 'Ububiko bw\'ibicuruzwa',
    tpl_budget: 'Ingengo y\'imari',
    nothing_to_undo: 'Nta cyo kugarura gihari',
    nothing_to_redo: 'Nta cyo gusubiramo gihari',
    cells_merged: 'Kashi zahujwe/zatandukanyijwe',
    row_frozen: 'Umurongo wo hejuru wafunzwe',
    row_unfrozen: 'Umurongo wo hejuru wafunguwe',
    copied_clipboard: 'Byakoporowe',
    share_failed: 'Gusangiza byanze',
    import_success: '{filename} yakiriwe neza!',
    import_fail: 'Gufungura dosiye byanze. Reba neza niba ari CSV cyangwa XLSX.',
    csv_export_success: 'CSV yamanuwe neza!',
    csv_export_fail: 'Kumanura CSV byanze.',
    xlsx_export_success: 'Excel yamanuwe neza!',
    xlsx_export_fail: 'Kumanura Excel byanze.',
    confirm_template: 'Guhitamo inyandikorugero birasiba ibiri ku rupapuro rwose. Urabyemeza?',
    template_loaded: 'Inyandikorugero {template} yinjijwe!'
  },
  ru: {
    untitled: 'Безымянная таблица',
    saved_offline: 'Сохранено на устройстве (Офлайн)',
    saved_local: 'Сохранено локально',
    saving: 'Сохранение...',
    storage_limit: 'Лимит хранилища исчерпан! Пожалуйста, освободите место.',
    open_btn: 'Открыть',
    csv_btn: 'CSV',
    formula_placeholder: 'Введите текст или формулу (=SUM...)',
    search_placeholder: 'Поиск по ячейкам (напр. B5)...',
    tab_home: 'Главная',
    tab_formulas: 'Формулы',
    tab_file: 'Файл и шаблоны',
    undo_title: 'Отменить (Ctrl+Z)',
    redo_title: 'Повторить (Ctrl+Y)',
    insert_row: 'Строка',
    delete_row: 'Строка',
    insert_col: 'Столбец',
    delete_col: 'Столбец',
    bold_title: 'Жирный (Ctrl+B)',
    italic_title: 'Курсив (Ctrl+I)',
    text_color_title: 'Цвет текста',
    fill_color_title: 'Цвет заливки',
    align_left: 'По левому краю',
    align_center: 'По центру',
    align_right: 'По правому краю',
    merge_btn: 'Объединить',
    freeze_btn: 'Закрепить',
    search_title: 'Поиск (Ctrl+F)',
    shortcuts_label: 'Быстрые функции:',
    open_file_btn: 'Открыть файл',
    download_csv: 'Скачать CSV',
    download_xlsx: 'Скачать Excel',
    share_btn: 'Поделиться',
    templates_label: 'Шаблоны:',
    tpl_sales: 'Учет продаж',
    tpl_inventory: 'Склад',
    tpl_budget: 'Бюджет',
    nothing_to_undo: 'Нечего отменять',
    nothing_to_redo: 'Нечего повторять',
    cells_merged: 'Ячейки объединены/разделены',
    row_frozen: 'Верхняя строка закреплена',
    row_unfrozen: 'Строки откреплены',
    copied_clipboard: 'Таблица скопирована в буфер',
    share_failed: 'Не удалось поделиться',
    import_success: 'Файл {filename} успешно импортирован!',
    import_fail: 'Не удалось прочитать файл. Убедитесь, что это корректный CSV или XLSX.',
    csv_export_success: 'CSV успешно экспортирован!',
    csv_export_fail: 'Ошибка экспорта CSV.',
    xlsx_export_success: 'Excel успешно экспортирован!',
    xlsx_export_fail: 'Ошибка экспорта Excel.',
    confirm_template: 'Применение шаблона заменит текущую таблицу. Продолжить?',
    template_loaded: 'Шаблон {template} загружен!'
  },
  zh: {
    untitled: '未命名电子表格',
    saved_offline: '已保存至设备 (离线)',
    saved_local: '已在本地保存',
    saving: '保存中...',
    storage_limit: '存储空间已满！请清理空间。',
    open_btn: '打开',
    csv_btn: 'CSV',
    formula_placeholder: '输入文字或公式 (=SUM...)',
    search_placeholder: '搜索单元格或输入坐标 (例如 B5)...',
    tab_home: '开始',
    tab_formulas: '公式',
    tab_file: '文件与模板',
    undo_title: '撤销 (Ctrl+Z)',
    redo_title: '重做 (Ctrl+Y)',
    insert_row: '行',
    delete_row: '行',
    insert_col: '列',
    delete_col: '列',
    bold_title: '加粗 (Ctrl+B)',
    italic_title: '斜体 (Ctrl+I)',
    text_color_title: '文字颜色',
    fill_color_title: '填充颜色',
    align_left: '左对齐',
    align_center: '居中',
    align_right: '右对齐',
    merge_btn: '合并',
    freeze_btn: '冻结首行',
    search_title: '查找 (Ctrl+F)',
    shortcuts_label: '快捷函数：',
    open_file_btn: '打开文件',
    download_csv: '下载 CSV',
    download_xlsx: '下载 Excel',
    share_btn: '分享',
    templates_label: '模板：',
    tpl_sales: '销售记录',
    tpl_inventory: '库存管理',
    tpl_budget: '收支预算',
    nothing_to_undo: '无可撤销的操作',
    nothing_to_redo: '无可重做的操作',
    cells_merged: '单元格已合并/拆分',
    row_frozen: '已冻结首行',
    row_unfrozen: '已取消冻结',
    copied_clipboard: '表格已复制到剪贴板',
    share_failed: '分享失败',
    import_success: '已成功导入 {filename}！',
    import_fail: '解析文件失败，请确保是有效的 CSV 或 XLSX 文件。',
    csv_export_success: 'CSV 导出成功！',
    csv_export_fail: '导出 CSV 失败。',
    xlsx_export_success: 'Excel 导出成功！',
    xlsx_export_fail: '导出 Excel 失败。',
    confirm_template: '应用模板将覆盖当前表格内容，是否继续？',
    template_loaded: '{template} 模板已加载！'
  }
};

function getActiveLang() {
  if (typeof window !== 'undefined' && window.state && window.state.lang) {
    return window.state.lang;
  }
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('kivu_lang');
    if (stored) return stored;
  }
  return 'en';
}

function getT(key, fallback = '') {
  const lang = getActiveLang();
  if (typeof window !== 'undefined' && typeof window.t === 'function') {
    const candidate = window.t('excel_' + key);
    if (candidate && candidate !== 'excel_' + key) {
      return candidate;
    }
  }
  const dict = EXCEL_I18N[lang] || EXCEL_I18N.en;
  return dict[key] || EXCEL_I18N.en[key] || fallback;
}

function applyTranslations(rootElement) {
  if (!rootElement) return;

  function traverse(node) {
    if (!node) return;
    if (typeof node.getAttribute === 'function') {
      const key = node.getAttribute('data-i18n');
      if (key) {
        const translation = getT(key, node.textContent);
        if (translation) node.textContent = translation;
      }

      const placeholderKey = node.getAttribute('data-i18n-placeholder');
      if (placeholderKey) {
        const translation = getT(placeholderKey, node.getAttribute('placeholder') || '');
        if (translation && typeof node.setAttribute === 'function') {
          node.setAttribute('placeholder', translation);
        }
      }

      const titleKey = node.getAttribute('data-i18n-title');
      if (titleKey) {
        const translation = getT(titleKey, node.getAttribute('title') || '');
        if (translation && typeof node.setAttribute === 'function') {
          node.setAttribute('title', translation);
        }
      }
    }

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
  }

  traverse(rootElement);
}

// ── State Variables ──
let excelInstance = null;
let currentDocId = null;
let activeCell = { ri: 0, ci: 0 };
let isInitializing = false;
let cellStore = {};
let undoStack = [];   // Snapshots for headless / fallback undo
let redoStack = [];   // Snapshots for headless / fallback redo
const MAX_HISTORY = 50;
const visitingCycleRefs = new Set(); // Circular formula dependency guard

const EXCEL_STORAGE_KEY_PREFIX = 'kivu_doc_';
const EXCEL_DOCS_INDEX = 'kivu_docs_index';

function getDocsIndex() {
  try {
    const idx = localStorage.getItem(EXCEL_DOCS_INDEX);
    return idx ? JSON.parse(idx) : [];
  } catch (e) {
    return [];
  }
}

function saveDocsIndex(index) {
  try {
    localStorage.setItem(EXCEL_DOCS_INDEX, JSON.stringify(index));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.number === -2147024882) {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(getT('storage_limit', 'Storage limit reached! Please free up space.'), true);
      }
    } else {
      console.error('Failed to save docs index:', e);
    }
  }
}

export function getMyDocuments() {
  return getDocsIndex();
}

export function deleteDocument(id) {
  try {
    localStorage.removeItem(EXCEL_STORAGE_KEY_PREFIX + id);
    const idx = getDocsIndex().filter(d => d.id !== id);
    saveDocsIndex(idx);
    if (typeof window !== 'undefined' && window.renderMyDocuments) {
      window.renderMyDocuments();
    }
  } catch (e) {
    console.error('Failed to delete document:', e);
  }
}

function colIndexToName(ci) {
  let temp = '';
  let letter = '';
  let colIndex = ci;
  while (colIndex >= 0) {
    temp = colIndex % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colIndex = Math.floor(colIndex / 26) - 1;
  }
  return letter;
}

function cellRefToCoords(ref) {
  if (!ref || typeof ref !== 'string') return { ri: 0, ci: 0 };
  const match = ref.trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return { ri: 0, ci: 0 };
  const colStr = match[1].toUpperCase();
  let ci = 0;
  for (let i = 0; i < colStr.length; i++) {
    ci = ci * 26 + (colStr.charCodeAt(i) - 64);
  }
  ci -= 1;
  const ri = parseInt(match[2], 10) - 1;
  return { ri: Math.max(0, ri), ci: Math.max(0, ci) };
}

function coordsToCellRef(ri, ci) {
  return colIndexToName(ci) + (ri + 1);
}

const excelEditorHtml = `
<div id="excel-editor-modal" class="hidden fixed inset-0 bg-white z-[9999] flex flex-col overflow-hidden transition-transform transform translate-y-full" role="dialog" aria-modal="true" aria-label="Spreadsheet Editor">
    <!-- Header -->
    <div class="h-14 flex-shrink-0 flex items-center justify-between px-3 bg-white border-b border-gray-200">
        <button id="close-excel-btn" class="text-xl text-gray-700 p-2 -ml-1 active:scale-90 transition-transform" aria-label="Close Spreadsheet">
            <i class="fas fa-arrow-left"></i>
        </button>
        <div class="flex flex-col items-center">
            <input type="text" id="excel-doc-title" value="Untitled Spreadsheet" data-i18n-placeholder="untitled" class="text-sm font-bold text-center border-none bg-transparent focus:ring-0 focus:outline-none w-44 text-gray-800" />
            <span id="excel-save-status" data-i18n="saved_offline" class="text-[10px] text-gray-400 font-medium">Saved on device (Offline)</span>
        </div>
        <div class="flex items-center gap-1.5">
            <input type="file" id="excel-file-picker" accept=".xlsx,.xls,.csv,.tsv,.txt" class="hidden" />
            <button id="excel-file-btn-import" class="text-xs text-gray-700 px-2.5 py-1.5 rounded-lg bg-gray-100 active:scale-95 transition-transform font-semibold flex items-center gap-1 border border-gray-200" title="Open .xlsx or .csv from device">
                <i class="fas fa-folder-open text-xs text-gray-500"></i><span data-i18n="open_btn">Open</span>
            </button>
            <button id="excel-file-btn-top" class="text-xs text-green-700 px-2.5 py-1.5 rounded-lg bg-green-50 active:scale-95 transition-transform font-semibold flex items-center gap-1 border border-green-200" title="Quick CSV Export">
                <i class="fas fa-file-csv text-xs text-green-600"></i><span data-i18n="csv_btn">CSV</span>
            </button>
        </div>
    </div>

    <!-- Formula Bar -->
    <div id="excel-formula-bar" class="h-10 flex-shrink-0 flex items-center px-2 sm:px-3 bg-gray-50 border-b border-gray-200 gap-1.5 sm:gap-2">
        <button type="button" id="excel-cell-position" class="w-11 h-7 bg-white border border-gray-300 rounded text-xs font-bold text-gray-700 flex items-center justify-center shrink-0 shadow-sm font-mono cursor-pointer active:bg-gray-100 hover:border-gray-400 transition-colors touch-manipulation" title="Current Cell (Tap to edit)" aria-label="Current Cell">A1</button>
        <button type="button" id="excel-formula-fx-btn" class="w-7 h-7 flex items-center justify-center text-xs font-bold italic text-green-600 shrink-0 rounded active:bg-green-100 hover:bg-green-50 transition-colors cursor-pointer touch-manipulation select-none" title="Insert Formula (=)" aria-label="Formula Bar">fx</button>
        <div class="w-px h-5 bg-gray-300 mx-0.5"></div>
        <input type="text" id="excel-formula-input" placeholder="Enter text or formula (=SUM...)" data-i18n-placeholder="formula_placeholder" class="flex-1 h-7 bg-white border border-gray-300 rounded px-2 text-xs text-gray-800 focus:outline-none focus:border-green-500 font-mono shadow-sm touch-manipulation" />
        <button type="button" id="excel-formula-apply-btn" class="w-7 h-7 flex items-center justify-center text-green-600 hover:text-green-700 active:bg-green-100 rounded transition-colors touch-manipulation shrink-0" title="Apply" aria-label="Apply formula or text"><i class="fas fa-check text-xs"></i></button>
        <button type="button" id="excel-edit-cell-btn" class="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-green-600 active:bg-gray-200 rounded transition-colors touch-manipulation shrink-0" title="Edit Cell Text" aria-label="Edit Cell Text"><i class="fas fa-pen text-[11px]"></i></button>
    </div>

    <!-- Search Bar (hidden by default) -->
    <div id="excel-search-bar" class="h-10 flex-shrink-0 items-center px-2 sm:px-3 bg-yellow-50 border-b border-yellow-200 gap-1.5 sm:gap-2 hidden">
        <i class="fas fa-search text-xs text-yellow-600 shrink-0"></i>
        <input type="text" id="excel-search-input" placeholder="Search cells or jump to ref (e.g. B5)..." data-i18n-placeholder="search_placeholder" class="flex-1 h-7 bg-white border border-yellow-300 rounded px-2 text-xs text-gray-800 focus:outline-none focus:border-yellow-500 shadow-sm font-mono touch-manipulation" />
        <span id="excel-search-count" class="text-[10px] text-yellow-600 font-mono shrink-0"></span>
        <button type="button" id="excel-search-prev" class="w-7 h-7 flex items-center justify-center rounded bg-yellow-100 active:bg-yellow-200 text-yellow-700 text-xs touch-manipulation" title="Previous match"><i class="fas fa-chevron-up"></i></button>
        <button type="button" id="excel-search-next" class="w-7 h-7 flex items-center justify-center rounded bg-yellow-100 active:bg-yellow-200 text-yellow-700 text-xs touch-manipulation" title="Next match"><i class="fas fa-chevron-down"></i></button>
        <button type="button" id="excel-search-close" class="w-7 h-7 flex items-center justify-center rounded bg-yellow-100 active:bg-yellow-200 text-yellow-700 text-xs touch-manipulation" title="Close search"><i class="fas fa-times"></i></button>
    </div>

    <!-- Editor Scroll Area -->
    <div id="excel-editor-scroll-area" class="flex-1 w-full min-h-0 relative overflow-hidden bg-gray-100">
        <div id="x-spreadsheet-container" class="w-full h-full"></div>
    </div>

    <!-- Bottom Ribbon Menu -->
    <div class="flex-shrink-0 bg-white border-t border-gray-200 flex flex-col pb-safe shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-10">
        
        <!-- Tab 1: Home / Edit -->
        <div id="excel-tab-home-content" class="h-14 flex items-center justify-start px-2 gap-1 overflow-x-auto scrollbar-hide text-gray-700">
            <!-- Undo / Redo -->
            <button id="btn-excel-undo" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Undo (Ctrl+Z)" data-i18n-title="undo_title"><i class="fas fa-undo"></i></button>
            <button id="btn-excel-redo" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Redo (Ctrl+Y)" data-i18n-title="redo_title"><i class="fas fa-redo"></i></button>
            <div class="w-px h-6 bg-gray-300 mx-1"></div>
            
            <!-- Row & Column Operations -->
            <button id="btn-excel-add-row" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-700 rounded-md text-xs font-medium active:bg-gray-200 transition-colors" title="Insert Row" data-i18n-title="insert_row"><i class="fas fa-plus text-[10px] opacity-70"></i><span data-i18n="insert_row">Row</span></button>
            <button id="btn-excel-del-row" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-md text-xs font-medium active:bg-red-200 transition-colors" title="Delete Row" data-i18n-title="delete_row"><i class="fas fa-minus text-[10px] opacity-70"></i><span data-i18n="delete_row">Row</span></button>
            <button id="btn-excel-add-col" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-700 rounded-md text-xs font-medium active:bg-gray-200 transition-colors" title="Insert Column" data-i18n-title="insert_col"><i class="fas fa-plus text-[10px] opacity-70"></i><span data-i18n="insert_col">Col</span></button>
            <button id="btn-excel-del-col" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-md text-xs font-medium active:bg-red-200 transition-colors" title="Delete Column" data-i18n-title="delete_col"><i class="fas fa-minus text-[10px] opacity-70"></i><span data-i18n="delete_col">Col</span></button>
            <div class="w-px h-6 bg-gray-300 mx-1"></div>

            <!-- Styles & Format -->
            <button id="btn-excel-bold" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Bold (Ctrl+B)" data-i18n-title="bold_title"><i class="fas fa-bold"></i></button>
            <button id="btn-excel-italic" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Italic (Ctrl+I)" data-i18n-title="italic_title"><i class="fas fa-italic"></i></button>
            
            <!-- Text & Fill Colors -->
            <div class="flex flex-col items-center justify-center h-9 relative px-1" title="Text Color" data-i18n-title="text_color_title">
                <i class="fas fa-font text-xs mb-1"></i>
                <input type="color" id="btn-excel-color" class="w-4 h-1 p-0 border-none cursor-pointer absolute bottom-1 rounded-sm" value="#000000" aria-label="Text Color">
            </div>
            <div class="flex flex-col items-center justify-center h-9 relative px-1" title="Fill Color" data-i18n-title="fill_color_title">
                <i class="fas fa-fill-drip text-xs mb-1"></i>
                <input type="color" id="btn-excel-bg-color" class="w-4 h-1 p-0 border-none cursor-pointer absolute bottom-1 rounded-sm" value="#ffffff" aria-label="Fill Color">
            </div>
            <div class="w-px h-6 bg-gray-300 mx-1"></div>

            <!-- Alignments -->
            <button id="btn-excel-align-left" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Align Left" data-i18n-title="align_left"><i class="fas fa-align-left"></i></button>
            <button id="btn-excel-align-center" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Align Center" data-i18n-title="align_center"><i class="fas fa-align-center"></i></button>
            <button id="btn-excel-align-right" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Align Right" data-i18n-title="align_right"><i class="fas fa-align-right"></i></button>
            <div class="w-px h-6 bg-gray-300 mx-1"></div>

            <!-- Merge / Freeze / Search -->
            <button id="btn-excel-merge" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-orange-50 hover:bg-orange-100 text-orange-700 border border-orange-200 rounded-md text-xs font-medium active:bg-orange-200 transition-colors" title="Merge / Unmerge Cells" data-i18n-title="merge_btn"><i class="fas fa-compress-alt text-[10px] opacity-70"></i><span data-i18n="merge_btn">Merge</span></button>
            <button id="btn-excel-freeze" class="px-3 h-8 flex-shrink-0 flex items-center justify-center gap-1.5 bg-cyan-50 hover:bg-cyan-100 text-cyan-700 border border-cyan-200 rounded-md text-xs font-medium active:bg-cyan-200 transition-colors" title="Freeze Top Row" data-i18n-title="freeze_btn"><i class="fas fa-thumbtack text-[10px] opacity-70"></i><span data-i18n="freeze_btn">Freeze</span></button>
            <button id="btn-excel-search" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded active:bg-gray-100 hover:bg-gray-50 transition-colors" title="Search (Ctrl+F)" data-i18n-title="search_title"><i class="fas fa-search"></i></button>
        </div>

        <!-- Tab 2: Formulas -->
        <div id="excel-tab-formulas-content" class="h-14 hidden items-center justify-start px-2 gap-2 overflow-x-auto scrollbar-hide text-gray-700">
            <span class="text-xs font-semibold text-gray-500 mr-1" data-i18n="shortcuts_label">Shortcuts:</span>
            <button id="btn-excel-sum" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=SUM</button>
            <button id="btn-excel-avg" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=AVERAGE</button>
            <button id="btn-excel-max" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=MAX</button>
            <button id="btn-excel-min" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=MIN</button>
            <button id="btn-excel-count" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=COUNT</button>
            <button id="btn-excel-counta" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold active:bg-green-100 transition-colors">=COUNTA</button>
        </div>

        <!-- Tab 3: File / Export & Templates -->
        <div id="excel-tab-file-content" class="h-14 hidden items-center justify-start px-2 gap-2 overflow-x-auto scrollbar-hide">
            <button id="btn-excel-tab-import" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 bg-gray-100 text-gray-700 border border-gray-300 rounded text-xs font-semibold active:bg-gray-200 transition-colors"><i class="fas fa-folder-open text-gray-500"></i> <span data-i18n="open_file_btn">Open File</span></button>
            <button id="btn-excel-export-csv" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-semibold active:bg-green-100 transition-colors"><i class="fas fa-file-csv"></i> <span data-i18n="download_csv">Download CSV</span></button>
            <button id="btn-excel-export-xlsx" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-semibold active:bg-blue-100 transition-colors"><i class="fas fa-file-excel"></i> <span data-i18n="download_xlsx">Download Excel</span></button>
            <button id="btn-excel-share" class="px-3 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 bg-teal-50 text-teal-700 border border-teal-200 rounded text-xs font-semibold active:bg-teal-100 transition-colors"><i class="fas fa-share-alt"></i> <span data-i18n="share_btn">Share</span></button>
            <div class="w-px h-6 bg-gray-300 mx-1 flex-shrink-0"></div>
            <span class="text-xs font-semibold text-gray-400 whitespace-nowrap" data-i18n="templates_label">Templates:</span>
            <button id="btn-excel-tpl-sales" class="px-2.5 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-xs font-semibold active:bg-indigo-100 transition-colors"><i class="fas fa-cash-register text-[10px]"></i> <span data-i18n="tpl_sales">Sales Log</span></button>
            <button id="btn-excel-tpl-inventory" class="px-2.5 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-amber-50 text-amber-700 border border-amber-200 rounded text-xs font-semibold active:bg-amber-100 transition-colors"><i class="fas fa-boxes text-[10px]"></i> <span data-i18n="tpl_inventory">Inventory</span></button>
            <button id="btn-excel-tpl-budget" class="px-2.5 h-9 flex-shrink-0 whitespace-nowrap flex items-center justify-center gap-1 bg-purple-50 text-purple-700 border border-purple-200 rounded text-xs font-semibold active:bg-purple-100 transition-colors"><i class="fas fa-wallet text-[10px]"></i> <span data-i18n="tpl_budget">Budget</span></button>
        </div>

        <!-- Tabs Navigation -->
        <div class="flex items-center justify-around border-t border-gray-200 bg-gray-50 h-10 shrink-0">
            <button class="excel-tab-btn active text-green-600 font-bold text-xs uppercase tracking-wider flex-1 h-full" data-target="excel-tab-home-content" data-i18n="tab_home">Home</button>
            <button class="excel-tab-btn text-gray-500 font-bold text-xs uppercase tracking-wider flex-1 h-full" data-target="excel-tab-formulas-content" data-i18n="tab_formulas">Formulas</button>
            <button class="excel-tab-btn text-gray-500 font-bold text-xs uppercase tracking-wider flex-1 h-full" data-target="excel-tab-file-content" data-i18n="tab_file">File & Templates</button>
        </div>
    </div>
</div>
<style>
.excel-tab-btn.active { border-bottom: 2px solid #16a34a; color: #16a34a; }
#x-spreadsheet-container .x-spreadsheet { width: 100% !important; height: 100% !important; }
/* Mobile touch fixes: enlarge handles for touchscreen accuracy */
#x-spreadsheet-container .x-spreadsheet-resizer,
#x-spreadsheet-container .x-spreadsheet-resizer-hover {
    touch-action: none;
}
#x-spreadsheet-container .x-spreadsheet-resizer.vertical .x-spreadsheet-resizer-hover {
    width: 24px !important;
    margin-left: -7px !important;
}
#x-spreadsheet-container .x-spreadsheet-resizer.horizontal .x-spreadsheet-resizer-hover {
    height: 24px !important;
    margin-top: -7px !important;
}
#excel-formula-bar button,
#excel-formula-bar input,
#excel-search-bar button,
#excel-search-bar input {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
}
@media (max-width: 640px) {
    #excel-formula-input, #excel-search-input, #excel-doc-title {
        font-size: 16px !important;
    }
}
</style>
`;

export async function init(docId = null) {
  return openExcelEditor(docId);
}

export async function openExcelEditor(docId = null) {
  await getSpreadsheetClass();
  if (typeof document !== 'undefined' && !document.getElementById('excel-editor-modal')) {
    document.body.insertAdjacentHTML('beforeend', excelEditorHtml);
    bindExcelEvents();
  }

  currentDocId = docId;
  const defaultTitle = getT('untitled', 'Untitled Spreadsheet');
  if (!currentDocId) {
    currentDocId = 'doc_' + Date.now();
    if (typeof document !== 'undefined' && document.getElementById('excel-doc-title')) {
      document.getElementById('excel-doc-title').value = defaultTitle;
    }
  } else {
    const idx = getDocsIndex().find(d => d.id === currentDocId);
    if (idx && typeof document !== 'undefined' && document.getElementById('excel-doc-title')) {
      document.getElementById('excel-doc-title').value = idx.title || defaultTitle;
    }
  }

  const titleVal = (typeof document !== 'undefined' && document.getElementById('excel-doc-title')) ? document.getElementById('excel-doc-title').value : defaultTitle;
  saveDocToIndex(titleVal);

  if (typeof document !== 'undefined') {
    const modal = document.getElementById('excel-editor-modal');
    if (modal) {
      applyTranslations(modal);
      modal.classList.add('translate-y-full');
      modal.classList.remove('hidden');
      void modal.offsetHeight;
      requestAnimationFrame(() => modal.classList.remove('translate-y-full'));
    }
  }

  await initSpreadsheet();
}

export function closeExcelEditor() {
  saveSpreadsheetData(false);
  if (typeof document !== 'undefined') {
    if (globalInputShield && typeof window !== 'undefined') {
      window.removeEventListener('keydown', globalInputShield, true);
      globalInputShield = null;
    }
    const modal = document.getElementById('excel-editor-modal');
    if (modal) {
      modal.classList.add('translate-y-full');
      setTimeout(() => {
        modal.classList.add('hidden');
        if (typeof window !== 'undefined' && window.renderMyDocuments) {
          window.renderMyDocuments();
        }
      }, 300);
    }
  }
}

function saveDocToIndex(title) {
  if (!currentDocId) return;
  const defaultTitle = getT('untitled', 'Untitled Spreadsheet');
  let idx = getDocsIndex();
  const existing = idx.find(d => d.id === currentDocId);
  if (existing) {
    existing.title = title || defaultTitle;
    existing.updatedAt = Date.now();
  } else {
    idx.push({
      id: currentDocId,
      title: title || defaultTitle,
      type: 'excel',
      updatedAt: Date.now()
    });
  }
  saveDocsIndex(idx);
}

function populateCellStoreFromData(data) {
  cellStore = {};
  if (!data) return;

  if (Array.isArray(data) && data[0] && data[0].rows) {
    const rows = data[0].rows;
    Object.keys(rows).forEach(rKey => {
      // Direct coordinate format, e.g. mock-dom cells['0:0'] = '10'
      if (rKey.includes(':')) {
        const val = rows[rKey];
        cellStore[rKey] = (val && typeof val === 'object' && val.text !== undefined) ? String(val.text) : String(val);
        return;
      }
      const ri = parseInt(rKey, 10);
      if (isNaN(ri)) return;
      const rowObj = rows[rKey];
      if (!rowObj || typeof rowObj !== 'object') return;
      const cells = rowObj.cells;
      if (!cells || typeof cells !== 'object') return;

      Object.keys(cells).forEach(cKey => {
        const ci = parseInt(cKey, 10);
        if (isNaN(ci)) return;
        const cellObj = cells[cKey];
        const val = (cellObj && typeof cellObj === 'object' && cellObj.text !== undefined)
          ? cellObj.text
          : (typeof cellObj === 'object' ? '' : String(cellObj));
        cellStore[`${ri}:${ci}`] = String(val);
      });
    });
  } else if (typeof data === 'object') {
    if (data.data) {
      populateCellStoreFromData(data.data);
    } else if (data.A1 !== undefined || data['0:0'] !== undefined) {
      Object.keys(data).forEach(key => {
        if (key.includes(':')) {
          cellStore[key] = String(data[key]);
        } else if (/^[A-Za-z]+\d+$/.test(key)) {
          const { ri, ci } = cellRefToCoords(key);
          cellStore[`${ri}:${ci}`] = String(data[key]);
        }
      });
    }
  }
}

function pushUndoSnapshot() {
  if (isInitializing) return;
  let fullData = null;
  if (excelInstance && typeof excelInstance.getData === 'function') {
    try { fullData = excelInstance.getData(); } catch (_) {}
  }
  const snapshot = JSON.stringify({ cellStore: { ...cellStore }, data: fullData });
  if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) return;
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

function performUndo() {
  // Use x-spreadsheet's native undo if available (preserves rich styles and cell formatting)
  if (excelInstance && excelInstance.sheet && typeof excelInstance.sheet.undo === 'function') {
    if (excelInstance.sheet.data && typeof excelInstance.sheet.data.canUndo === 'function' && !excelInstance.sheet.data.canUndo()) {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(getT('nothing_to_undo', 'Nothing to undo'), false);
      }
      return;
    }
    excelInstance.sheet.undo();
    if (typeof excelInstance.getData === 'function') {
      populateCellStoreFromData(excelInstance.getData());
    }
    const currentVal = cellStore[`${activeCell.ri}:${activeCell.ci}`] || '';
    updateFormulaBar(activeCell.ri, activeCell.ci, currentVal);
    saveSpreadsheetData(false);
    return;
  }

  // Headless / fallback undo
  if (undoStack.length === 0) {
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('nothing_to_undo', 'Nothing to undo'), false);
    }
    return;
  }
  let currentFullData = null;
  if (excelInstance && typeof excelInstance.getData === 'function') {
    try { currentFullData = excelInstance.getData(); } catch (_) {}
  }
  redoStack.push(JSON.stringify({ cellStore: { ...cellStore }, data: currentFullData }));
  const snapshotStr = undoStack.pop();
  try {
    const parsed = JSON.parse(snapshotStr);
    if (parsed.cellStore) cellStore = parsed.cellStore;
    if (parsed.data && excelInstance && typeof excelInstance.loadData === 'function') {
      excelInstance.loadData(parsed.data);
    }
  } catch (_) {}
  updateFormulaBar(activeCell.ri, activeCell.ci, cellStore[`${activeCell.ri}:${activeCell.ci}`] || '');
  saveSpreadsheetData(false);
}

function performRedo() {
  // Use x-spreadsheet's native redo if available
  if (excelInstance && excelInstance.sheet && typeof excelInstance.sheet.redo === 'function') {
    if (excelInstance.sheet.data && typeof excelInstance.sheet.data.canRedo === 'function' && !excelInstance.sheet.data.canRedo()) {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(getT('nothing_to_redo', 'Nothing to redo'), false);
      }
      return;
    }
    excelInstance.sheet.redo();
    if (typeof excelInstance.getData === 'function') {
      populateCellStoreFromData(excelInstance.getData());
    }
    const currentVal = cellStore[`${activeCell.ri}:${activeCell.ci}`] || '';
    updateFormulaBar(activeCell.ri, activeCell.ci, currentVal);
    saveSpreadsheetData(false);
    return;
  }

  // Headless / fallback redo
  if (redoStack.length === 0) {
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('nothing_to_redo', 'Nothing to redo'), false);
    }
    return;
  }
  let currentFullData = null;
  if (excelInstance && typeof excelInstance.getData === 'function') {
    try { currentFullData = excelInstance.getData(); } catch (_) {}
  }
  undoStack.push(JSON.stringify({ cellStore: { ...cellStore }, data: currentFullData }));
  const snapshotStr = redoStack.pop();
  try {
    const parsed = JSON.parse(snapshotStr);
    if (parsed.cellStore) cellStore = parsed.cellStore;
    if (parsed.data && excelInstance && typeof excelInstance.loadData === 'function') {
      excelInstance.loadData(parsed.data);
    }
  } catch (_) {}
  updateFormulaBar(activeCell.ri, activeCell.ci, cellStore[`${activeCell.ri}:${activeCell.ci}`] || '');
  saveSpreadsheetData(false);
}

function saveSpreadsheetData(throwOnQuota = false) {
  if (!currentDocId) return;
  try {
    let data = null;
    if (excelInstance && typeof excelInstance.getData === 'function') {
      try {
        data = excelInstance.getData();
      } catch (e) {
        console.warn('Could not getData from excelInstance:', e);
      }
    }

    let existingData = null;
    try {
      const raw = localStorage.getItem(EXCEL_STORAGE_KEY_PREFIX + currentDocId);
      if (raw) existingData = JSON.parse(raw);
    } catch (_) {}

    if (data && Array.isArray(data) && data[0]) {
      // Sync cellStore from live x-spreadsheet state without modifying rich styles or merges
      populateCellStoreFromData(data);
      if ((!data[0].styles || data[0].styles.length === 0) && existingData && Array.isArray(existingData) && existingData[0]?.styles?.length > 0) {
        data[0].styles = existingData[0].styles;
      }
      if ((!data[0].merges || data[0].merges.length === 0) && existingData && Array.isArray(existingData) && existingData[0]?.merges?.length > 0) {
        data[0].merges = existingData[0].merges;
      }
      if (existingData && Array.isArray(existingData) && existingData[0]?.rows) {
        const exRows = existingData[0].rows;
        Object.keys(exRows).forEach(k => {
          if (!k.includes(':')) {
            const r = parseInt(k, 10);
            if (!isNaN(r)) {
              if (!data[0].rows[r]) data[0].rows[r] = exRows[k];
            }
          }
        });
      }
      Object.keys(cellStore).forEach(key => {
        const [rStr, cStr] = key.split(':');
        const r = parseInt(rStr, 10);
        const c = parseInt(cStr, 10);
        if (!isNaN(r) && !isNaN(c)) {
          if (data[0].rows && (data[0].rows[r] || Object.keys(data[0].rows).some(k => !k.includes(':')))) {
            if (!data[0].rows[r]) data[0].rows[r] = { cells: {} };
            if (!data[0].rows[r].cells) data[0].rows[r].cells = {};
            if (!data[0].rows[r].cells[c]) data[0].rows[r].cells[c] = {};
            data[0].rows[r].cells[c].text = cellStore[key];
          }
        }
      });
    } else {

      if (Array.isArray(existingData) && existingData[0]) {
        data = existingData;
        if (!data[0].rows) data[0].rows = {};
        Object.keys(cellStore).forEach(key => {
          const [rStr, cStr] = key.split(':');
          const r = parseInt(rStr, 10);
          const c = parseInt(cStr, 10);
          if (!isNaN(r) && !isNaN(c)) {
            if (!data[0].rows[r]) data[0].rows[r] = { cells: {} };
            if (!data[0].rows[r].cells) data[0].rows[r].cells = {};
            if (!data[0].rows[r].cells[c]) data[0].rows[r].cells[c] = {};
            data[0].rows[r].cells[c].text = cellStore[key];
          }
        });
      } else {
        const rows = {};
        Object.keys(cellStore).forEach(key => {
          const [rStr, cStr] = key.split(':');
          const r = parseInt(rStr, 10);
          const c = parseInt(cStr, 10);
          if (!isNaN(r) && !isNaN(c)) {
            if (!rows[r]) rows[r] = { cells: {} };
            if (!rows[r].cells) rows[r].cells = {};
            rows[r].cells[c] = { text: cellStore[key] };
          }
        });
        data = [{ name: 'Sheet1', freeze: 'A1', styles: [], merges: [], rows, cols: { len: 26 } }];
      }
    }

    localStorage.setItem(EXCEL_STORAGE_KEY_PREFIX + currentDocId, JSON.stringify(data));
    const titleVal = (typeof document !== 'undefined' && document.getElementById('excel-doc-title'))
      ? document.getElementById('excel-doc-title').value
      : getT('untitled', 'Untitled Spreadsheet');
    saveDocToIndex(titleVal);

    if (typeof document !== 'undefined') {
      const statusLabel = document.getElementById('excel-save-status');
      if (statusLabel) {
        statusLabel.innerText = getT('saving', 'Saving...');
        setTimeout(() => {
          if (statusLabel) statusLabel.innerText = getT('saved_local', 'Saved locally');
        }, 300);
      }
    }
  } catch (err) {
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.number === -2147024882) {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(getT('storage_limit', 'Storage limit reached! Please free up space.'), true);
      }
      if (throwOnQuota) throw err;
      return;
    }
    console.error('Failed to save spreadsheet data:', err);
    if (throwOnQuota) throw err;
  }
}

function createSpreadsheetInstance(container, options) {
  if (typeof window !== 'undefined' && typeof window.x_spreadsheet === 'function') {
    try {
      return window.x_spreadsheet(container, options);
    } catch (e) {}
  }
  if (typeof Spreadsheet === 'function') {
    try {
      return new Spreadsheet(container, options);
    } catch (e) {
      if (typeof window !== 'undefined' && typeof window.x_spreadsheet === 'function') {
        return window.x_spreadsheet(container, options);
      }
      throw e;
    }
  }
  if (typeof window !== 'undefined' && typeof window.x_spreadsheet === 'function') {
    return window.x_spreadsheet(container, options);
  }
  throw new Error('x-data-spreadsheet library not found');
}

function bindSpreadsheetInstanceEvents() {
  if (excelInstance && typeof excelInstance.change === 'function') {
    excelInstance.change(() => {
      if (isInitializing) return;
      saveSpreadsheetData(false);
    });
  }

  if (excelInstance && typeof excelInstance.on === 'function') {
    excelInstance.on('cell-selected', (cell, ri, ci) => {
      activeCell = { ri, ci };
      const cellVal = cell && cell.text !== undefined ? cell.text : (cellStore[`${ri}:${ci}`] || '');
      updateFormulaBar(ri, ci, cellVal);
    });

    excelInstance.on('cell-edited', (text, ri, ci) => {
      pushUndoSnapshot();
      activeCell = { ri, ci };
      cellStore[`${ri}:${ci}`] = String(text);
      updateFormulaBar(ri, ci, text);
      saveSpreadsheetData(false);
    });
  }
}

function initSpreadsheet() {
  cellStore = {};
  undoStack = [];
  redoStack = [];

  if (typeof document === 'undefined') return;
  const container = document.getElementById('x-spreadsheet-container');
  if (!container) return;

  const saved = localStorage.getItem(EXCEL_STORAGE_KEY_PREFIX + currentDocId);
  const defaultData = [
    {
      name: 'Sheet1',
      freeze: 'A1',
      styles: [],
      merges: [],
      rows: { len: 100 },
      cols: { len: 26 }
    }
  ];

  let initialData = defaultData;
  if (saved) {
    try {
      initialData = JSON.parse(saved);
    } catch (e) {
      console.error('Failed to parse saved spreadsheet:', e);
      initialData = defaultData;
    }
  }

  populateCellStoreFromData(initialData);
  isInitializing = true;

  if (excelInstance) {
    try {
      if (typeof excelInstance.loadData === 'function') {
        excelInstance.loadData(initialData);
      }
      if (typeof excelInstance.reRender === 'function') {
        excelInstance.reRender();
      }
      if (excelInstance.sheet && typeof excelInstance.sheet.reload === 'function') {
        excelInstance.sheet.reload();
      }
      // Reset library history so undo/redo does not cross document boundaries
      if (excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.history) {
        excelInstance.sheet.data.history.undoItems = [];
        excelInstance.sheet.data.history.redoItems = [];
      }
    } catch (err) {
      console.error('Failed to reload spreadsheet data:', err);
    }
  } else {
    container.innerHTML = '';

    const rect = container.getBoundingClientRect ? container.getBoundingClientRect() : { height: 500, width: 800 };
    const viewHeight = rect.height > 100 ? rect.height : (typeof window !== 'undefined' ? window.innerHeight - 150 : 500);
    const viewWidth = rect.width > 100 ? rect.width : (typeof window !== 'undefined' ? window.innerWidth : 800);

    try {
      excelInstance = createSpreadsheetInstance(container, {
        mode: 'edit',
        showToolbar: false,
        showBottomBar: false,
        showGrid: true,
        showContextmenu: true,
        view: {
          height: () => (container.clientHeight || viewHeight),
          width: () => (container.clientWidth || viewWidth)
        },
        row: { len: 100, height: 30 },
        col: { len: 26, width: 100 }
      });

      if (excelInstance && typeof excelInstance.loadData === 'function') {
        excelInstance.loadData(initialData);
      }

      bindSpreadsheetInstanceEvents();
      setupTouchResizeSupport(container);
      setupViewportResizeSupport();

      // Mobile double-tap on spreadsheet grid → immediately focus formula bar for typing
      let lastTapTime = 0;
      let lastTapX = 0;
      let lastTapY = 0;
      container.addEventListener('touchend', (e) => {
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        const now = Date.now();
        const dist = Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY);
        if (now - lastTapTime < 350 && dist < 30) {
          focusFormulaInput(null, false);
        }
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      }, { passive: true });

      // Prevent browser context menu corruption on right-click / mobile long-press
      container.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (excelInstance && excelInstance.sheet && excelInstance.sheet.contextMenu) {
          const rect = container.getBoundingClientRect ? container.getBoundingClientRect() : { left: 0, top: 0 };
          const offsetX = e.clientX - (rect.left || 0);
          const offsetY = e.clientY - (rect.top || 0);
          try {
            excelInstance.sheet.contextMenu.setPosition(offsetX, offsetY);
          } catch (_) {}
        }
      });
    } catch (err) {
      console.error('Spreadsheet instantiation failed:', err);
    }
  }

  activeCell = { ri: 0, ci: 0 };
  updateFormulaBar(0, 0, cellStore['0:0'] || '');
  // Pass true on init so storage quota boundaries are caught in test runs
  saveSpreadsheetData(true);

  setTimeout(() => {
    isInitializing = false;
    // Set initial focusing so keyboard input works without requiring a click,
    // but only if the user hasn't already focused an input/formula bar
    if (excelInstance && excelInstance.sheet) {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (!activeEl || (activeEl.tagName !== 'INPUT' && activeEl.tagName !== 'TEXTAREA')) {
        excelInstance.sheet.focusing = true;
      }
    }
  }, 200);
}

function setupTouchResizeSupport(container) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof MouseEvent !== 'function') return;

  let resizingViaTouch = false;
  let lastTouchX = 0;
  let lastTouchY = 0;

  function dispatchMouse(target, type, clientX, clientY, extra = {}) {
    if (!target) return;
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      buttons: extra.buttons || 0,
      movementX: extra.movementX || 0,
      movementY: extra.movementY || 0
    });
    target.dispatchEvent(evt);
  }

  function findResizerHoverAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || typeof el.closest !== 'function') return null;
    return el.closest('.x-spreadsheet-resizer-hover');
  }

  container.addEventListener('touchstart', (e) => {
    if (resizingViaTouch || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const overlayerEl = container.querySelector('.x-spreadsheet-overlayer');
    if (!overlayerEl) return;

    dispatchMouse(overlayerEl, 'mousemove', touch.clientX, touch.clientY, { buttons: 0 });

    const hoverTarget = findResizerHoverAt(touch.clientX, touch.clientY);
    if (hoverTarget) {
      resizingViaTouch = true;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      dispatchMouse(hoverTarget, 'mousedown', touch.clientX, touch.clientY, { buttons: 1 });
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!resizingViaTouch || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const movementX = touch.clientX - lastTouchX;
    const movementY = touch.clientY - lastTouchY;
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
    dispatchMouse(window, 'mousemove', touch.clientX, touch.clientY, { buttons: 1, movementX, movementY });
    e.preventDefault();
  }, { passive: false });

  function endTouchResize(e) {
    if (!resizingViaTouch) return;
    resizingViaTouch = false;
    const touch = (e.changedTouches && e.changedTouches[0]) || { clientX: lastTouchX, clientY: lastTouchY };
    dispatchMouse(window, 'mouseup', touch.clientX, touch.clientY, { buttons: 0 });
  }
  document.addEventListener('touchend', endTouchResize, { passive: true });
  document.addEventListener('touchcancel', endTouchResize, { passive: true });
}

function setupViewportResizeSupport() {
  if (typeof window === 'undefined') return;
  let debounceTimer = null;
  const triggerReload = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (excelInstance && excelInstance.sheet && typeof excelInstance.sheet.reload === 'function') {
        excelInstance.sheet.reload();
      }
    }, 150);
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', triggerReload);
  }
  window.addEventListener('resize', triggerReload);
}

function updateFormulaBar(ri, ci, textVal = '') {
  if (typeof document === 'undefined') return;
  const posLabel = document.getElementById('excel-cell-position');
  const inputEl = document.getElementById('excel-formula-input');
  if (posLabel) {
    posLabel.innerText = colIndexToName(ci) + (ri + 1);
  }
  if (inputEl && document.activeElement !== inputEl) {
    inputEl.value = textVal !== undefined && textVal !== null ? String(textVal) : '';
  }
}

function focusFormulaInput(initialPrefix = null, selectAll = false) {
  if (typeof document === 'undefined') return;
  const formulaInput = document.getElementById('excel-formula-input');
  if (!formulaInput) return;
  if (excelInstance && excelInstance.sheet) {
    excelInstance.sheet.focusing = false;
  }
  formulaInput.focus();
  if (initialPrefix && !formulaInput.value) {
    formulaInput.value = initialPrefix;
    const { ri, ci } = activeCell;
    cellStore[`${ri}:${ci}`] = initialPrefix;
    if (excelInstance && typeof excelInstance.cellText === 'function') {
      excelInstance.cellText(ri, ci, initialPrefix);
      if (excelInstance.reRender) excelInstance.reRender();
    }
  }
  if (selectAll) {
    try {
      formulaInput.select();
    } catch (_) {}
  } else {
    const len = formulaInput.value ? formulaInput.value.length : 0;
    try {
      formulaInput.setSelectionRange(len, len);
    } catch (_) {}
  }
}

function applyFormulaFromInput(textVal) {
  pushUndoSnapshot();
  const { ri, ci } = activeCell;
  const valStr = String(textVal);
  cellStore[`${ri}:${ci}`] = valStr;

  if (excelInstance) {
    if (typeof excelInstance.cellText === 'function') {
      if (excelInstance.sheet && excelInstance.sheet.data && typeof excelInstance.sheet.data.changeData === 'function') {
        excelInstance.sheet.data.changeData(() => {
          excelInstance.cellText(ri, ci, valStr);
        });
      } else {
        excelInstance.cellText(ri, ci, valStr);
      }
    }
    if (excelInstance.reRender) {
      excelInstance.reRender();
    }
  }
  saveSpreadsheetData(false);
}

function insertFormulaShortcut(fnName) {
  const { ri, ci } = activeCell;
  let formulaText = `=${fnName}()`;

  // Detect if user has a multi-cell selection in x-spreadsheet
  if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.selector) {
    const sel = excelInstance.sheet.data.selector;
    if (sel.range && (sel.range.sri !== sel.range.eri || sel.range.sci !== sel.range.eci)) {
      const sRef = coordsToCellRef(sel.range.sri, sel.range.sci);
      const eRef = coordsToCellRef(sel.range.eri, sel.range.eci);
      formulaText = `=${fnName}(${sRef}:${eRef})`;
    } else if (ri > 0) {
      const colName = colIndexToName(ci);
      formulaText = `=${fnName}(${colName}1:${colName}${ri})`;
    }
  } else if (ri > 0) {
    const colName = colIndexToName(ci);
    formulaText = `=${fnName}(${colName}1:${colName}${ri})`;
  }

  if (typeof document !== 'undefined') {
    const inputEl = document.getElementById('excel-formula-input');
    if (inputEl) inputEl.value = formulaText;
  }

  applyFormulaFromInput(formulaText);
}

export function setCell(cellRef, val) {
  const { ri, ci } = cellRefToCoords(cellRef);
  const textVal = String(val);
  cellStore[`${ri}:${ci}`] = textVal;

  if (excelInstance) {
    if (typeof excelInstance.cellText === 'function') {
      if (excelInstance.sheet && excelInstance.sheet.data && typeof excelInstance.sheet.data.changeData === 'function') {
        excelInstance.sheet.data.changeData(() => {
          excelInstance.cellText(ri, ci, textVal);
        });
      } else {
        excelInstance.cellText(ri, ci, textVal);
      }
    }
    if (excelInstance.reRender) {
      excelInstance.reRender();
    }
  }
  saveSpreadsheetData(false);
}

export function getCellValue(cellRef) {
  const { ri, ci } = cellRefToCoords(cellRef);
  let rawText = '';

  if (cellStore[`${ri}:${ci}`] !== undefined) {
    rawText = cellStore[`${ri}:${ci}`];
  } else if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && typeof excelInstance.sheet.data.getCell === 'function') {
    const cell = excelInstance.sheet.data.getCell(ri, ci);
    if (cell && cell.text !== undefined) {
      rawText = cell.text;
    }
  } else if (excelInstance && typeof excelInstance.getData === 'function') {
    try {
      const data = excelInstance.getData();
      if (data && data[0] && data[0].rows) {
        const rows = data[0].rows;
        if (rows[`${ri}:${ci}`] !== undefined) {
          const val = rows[`${ri}:${ci}`];
          rawText = (val && typeof val === 'object' && val.text !== undefined) ? val.text : String(val);
        } else if (rows[ri] && rows[ri].cells && rows[ri].cells[ci]) {
          const val = rows[ri].cells[ci];
          rawText = (val && typeof val === 'object' && val.text !== undefined) ? val.text : String(val);
        }
      }
    } catch (e) {}
  }

  if (typeof rawText === 'string' && rawText.startsWith('=')) {
    const refKey = coordsToCellRef(ri, ci);
    return evaluateFormula(rawText, refKey);
  }

  if (rawText !== '' && rawText !== null && rawText !== undefined && !isNaN(Number(rawText))) {
    return Number(rawText);
  }
  return rawText;
}

function splitFormulaArgs(str) {
  if (!str || !str.trim()) return [];
  const args = [];
  let cur = '';
  let depth = 0;
  let inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (!inQuotes && (ch === '(' || ch === '[')) {
      depth++;
      cur += ch;
    } else if (!inQuotes && (ch === ')' || ch === ']')) {
      depth--;
      cur += ch;
    } else if (!inQuotes && depth === 0 && (ch === ',' || ch === ';')) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  args.push(cur.trim());
  return args;
}

function expandRangeValues(rangeStr) {
  const parts = rangeStr.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('#ERROR!');
  }
  if (!/^[A-Za-z]+\d+$/.test(parts[0]) || !/^[A-Za-z]+\d+$/.test(parts[1])) {
    throw new Error('#ERROR!');
  }
  const start = cellRefToCoords(parts[0]);
  const end = cellRefToCoords(parts[1]);
  const values = [];
  const minR = Math.min(start.ri, end.ri);
  const maxR = Math.max(start.ri, end.ri);
  const minC = Math.min(start.ci, end.ci);
  const maxC = Math.max(start.ci, end.ci);

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const ref = coordsToCellRef(r, c);
      const val = getCellValue(ref);
      if (typeof val === 'string' && (val === '#REF!' || val === '#DIV/0!' || val === '#ERROR!' || val.startsWith('#'))) {
        throw new Error(val);
      }
      values.push(val);
    }
  }
  return values;
}

function evaluateFunctionCall(funcName, rawArgsStr) {
  const name = funcName.toUpperCase();
  const rawArgStrings = splitFormulaArgs(rawArgsStr);

  // IF(condition, valueIfTrue, [valueIfFalse])
  if (name === 'IF') {
    if (rawArgStrings.length < 2) throw new Error('#ERROR!');
    const condRaw = rawArgStrings[0].trim();
    let isTrue = false;
    try {
      // Parse comparison operators outside quotes: <=, >=, <>, !=, ==, =, <, >
      let comp = null;
      let inQuotes = false;
      let quoteChar = '';
      const ops = ['<=', '>=', '<>', '!=', '==', '=', '<', '>'];
      for (let i = 0; i < condRaw.length; i++) {
        const ch = condRaw[i];
        if ((ch === '"' || ch === "'") && (i === 0 || condRaw[i - 1] !== '\\')) {
          if (!inQuotes) {
            inQuotes = true;
            quoteChar = ch;
          } else if (ch === quoteChar) {
            inQuotes = false;
            quoteChar = '';
          }
        } else if (!inQuotes) {
          for (const op of ops) {
            if (condRaw.startsWith(op, i)) {
              comp = {
                left: condRaw.slice(0, i).trim(),
                op,
                right: condRaw.slice(i + op.length).trim()
              };
              break;
            }
          }
          if (comp) break;
        }
      }

      const evalOperand = (opStr) => {
        const t = opStr.trim();
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
          return t.slice(1, -1);
        }
        if (/^[A-Za-z]+\d+$/i.test(t)) {
          const val = getCellValue(t);
          if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
          return val;
        }
        return evaluateSubExpression(t);
      };

      if (comp) {
        const leftVal = evalOperand(comp.left);
        const rightVal = evalOperand(comp.right);

        const isLeftNum = typeof leftVal === 'number' || (leftVal !== '' && leftVal !== null && !isNaN(Number(leftVal)));
        const isRightNum = typeof rightVal === 'number' || (rightVal !== '' && rightVal !== null && !isNaN(Number(rightVal)));

        if (comp.op === '=' || comp.op === '==') {
          isTrue = (isLeftNum && isRightNum) ? Number(leftVal) === Number(rightVal) : String(leftVal) === String(rightVal);
        } else if (comp.op === '<>' || comp.op === '!=') {
          isTrue = (isLeftNum && isRightNum) ? Number(leftVal) !== Number(rightVal) : String(leftVal) !== String(rightVal);
        } else if (comp.op === '<') {
          isTrue = Number(leftVal) < Number(rightVal);
        } else if (comp.op === '>') {
          isTrue = Number(leftVal) > Number(rightVal);
        } else if (comp.op === '<=') {
          isTrue = Number(leftVal) <= Number(rightVal);
        } else if (comp.op === '>=') {
          isTrue = Number(leftVal) >= Number(rightVal);
        }
      } else {
        const condVal = evalOperand(condRaw);
        if (typeof condVal === 'string' && condVal.startsWith('#')) throw new Error(condVal);
        isTrue = Boolean(condVal && condVal !== 'FALSE' && condVal !== '0' && condVal !== 0);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) throw e;
      throw new Error('#ERROR!');
    }

    const evalBranch = (branchStr) => {
      const t = branchStr.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      if (/^[A-Za-z]+\d+$/i.test(t)) {
        const val = getCellValue(t);
        if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
        return val;
      }
      return evaluateSubExpression(t);
    };

    if (isTrue) {
      return evalBranch(rawArgStrings[1]);
    } else {
      return rawArgStrings.length > 2 ? evalBranch(rawArgStrings[2]) : '';
    }
  }

  // Expand arguments for standard aggregate/utility functions
  const resolvedValues = [];
  for (const arg of rawArgStrings) {
    if (!arg) throw new Error('#ERROR!');
    if (arg.includes(':')) {
      if (!/^[A-Za-z]+\d+:[A-Za-z]+\d+$/i.test(arg)) {
        throw new Error('#ERROR!');
      }
      resolvedValues.push(...expandRangeValues(arg));
    } else if (/^[A-Za-z]+\d+$/i.test(arg)) {
      const val = getCellValue(arg);
      if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
      resolvedValues.push(val);
    } else if (/^".*"$/.test(arg) || /^'.*'$/.test(arg)) {
      resolvedValues.push(arg.slice(1, -1));
    } else {
      const evaluated = evaluateSubExpression(arg);
      if (typeof evaluated === 'string' && evaluated.startsWith('#')) throw new Error(evaluated);
      resolvedValues.push(evaluated);
    }
  }

  // COUNT: counts numeric cells only; ignores empty cells and text
  if (name === 'COUNT') {
    return resolvedValues.filter(v => typeof v === 'number' && !isNaN(v)).length;
  }

  // COUNTA: counts non-empty cells
  if (name === 'COUNTA') {
    return resolvedValues.filter(v => v !== '' && v !== null && v !== undefined).length;
  }

  // CONCAT / CONCATENATE
  if (name === 'CONCAT' || name === 'CONCATENATE') {
    return resolvedValues.join('');
  }

  // ROUND(num, [decimals])
  if (name === 'ROUND') {
    if (resolvedValues.length === 0) throw new Error('#ERROR!');
    const n = Number(resolvedValues[0]);
    if (isNaN(n)) throw new Error('#ERROR!');
    const d = resolvedValues[1] !== undefined ? Number(resolvedValues[1]) : 0;
    const factor = 10 ** d;
    return Math.round(n * factor) / factor;
  }

  // ABS(num)
  if (name === 'ABS') {
    if (resolvedValues.length === 0) throw new Error('#ERROR!');
    const n = Number(resolvedValues[0]);
    if (isNaN(n)) throw new Error('#ERROR!');
    return Math.abs(n);
  }

  // SQRT(num)
  if (name === 'SQRT') {
    if (resolvedValues.length === 0) throw new Error('#ERROR!');
    const n = Number(resolvedValues[0]);
    if (isNaN(n) || n < 0) throw new Error('#ERROR!');
    return Math.sqrt(n);
  }

  // POWER(base, exp)
  if (name === 'POWER') {
    if (resolvedValues.length < 2) throw new Error('#ERROR!');
    const base = Number(resolvedValues[0]);
    const exp = Number(resolvedValues[1]);
    if (isNaN(base) || isNaN(exp)) throw new Error('#ERROR!');
    return Math.pow(base, exp);
  }

  // Numeric aggregates: SUM, AVERAGE, AVG, MAX, MIN, PRODUCT
  const numbers = resolvedValues
    .map(v => (typeof v === 'number' ? v : (v === '' || v === null || v === undefined ? null : Number(v))))
    .filter(v => v !== null && !isNaN(v));

  if (name === 'SUM') {
    return numbers.reduce((a, b) => a + b, 0);
  } else if (name === 'AVERAGE' || name === 'AVG') {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  } else if (name === 'MAX') {
    if (numbers.length === 0) return 0;
    return Math.max(...numbers);
  } else if (name === 'MIN') {
    if (numbers.length === 0) return 0;
    return Math.min(...numbers);
  } else if (name === 'PRODUCT') {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a * b, 1);
  }

  throw new Error('#ERROR!');
}

function evaluateSubExpression(subExpr) {
  let expr = String(subExpr).trim();
  if (!expr) return 0;

  // Validate parenthesis and quote balance
  let parenDepth = 0;
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ((ch === '"' || ch === "'") && (i === 0 || expr[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      }
    } else if (!inQuotes) {
      if (ch === '(') parenDepth++;
      else if (ch === ')') {
        parenDepth--;
        if (parenDepth < 0) throw new Error('#ERROR!');
      }
    }
  }
  if (inQuotes || parenDepth !== 0) throw new Error('#ERROR!');

  // Forbid comment sequences
  if (expr.includes('//') || expr.includes('/*') || expr.includes('*/')) {
    throw new Error('#ERROR!');
  }

  // Quoted string literal: "hello" or 'hello'
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  // Single cell reference
  if (/^[A-Za-z]+\d+$/i.test(expr)) {
    const val = getCellValue(expr);
    if (typeof val === 'string' && (val.startsWith('#') || val.includes('REF') || val.includes('ERROR') || val.includes('DIV'))) {
      throw new Error(val);
    }
    return val !== null && val !== undefined ? val : 0;
  }

  // Boolean literals
  if (expr.toUpperCase() === 'TRUE') return 1;
  if (expr.toUpperCase() === 'FALSE') return 0;

  // Evaluate innermost function calls until none remain: FUNC(args)
  const funcRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)/;
  let match = funcRegex.exec(expr);
  let guard = 0;
  while (match && guard++ < 50) {
    const fullCall = match[0];
    const funcName = match[1];
    const argsStr = match[2];
    const res = evaluateFunctionCall(funcName, argsStr);
    if (typeof res === 'string' && res.startsWith('#')) throw new Error(res);

    if (match.index === 0 && fullCall.length === expr.length) {
      return res;
    }

    const resReplacement = typeof res === 'string' ? JSON.stringify(res) : String(res);
    expr = expr.slice(0, match.index) + resReplacement + expr.slice(match.index + fullCall.length);
    match = funcRegex.exec(expr);
  }

  // If after function evaluation, it is a quoted string:
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  // Colons are not valid outside of function range arguments
  if (expr.includes(':')) {
    throw new Error('#ERROR!');
  }

  // Replace remaining cell references with their numeric values
  expr = expr.replace(/\b([A-Za-z]+\d+)\b/g, (m) => {
    const val = getCellValue(m);
    if (typeof val === 'string' && (val.startsWith('#') || val.includes('REF') || val.includes('ERROR') || val.includes('DIV'))) {
      throw new Error(val);
    }
    if (val === '' || val === null || val === undefined) return 0;
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  });

  // Support ^ for power
  expr = expr.replace(/\^/g, '**');

  // Check division by zero: e.g. / 0 or / (0)
  if (/\/ *0(?!\d|\.)/.test(expr)) {
    throw new Error('#DIV/0!');
  }

  // If plain number
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    return Number(expr);
  }

  // Ensure safe characters for arithmetic & comparison
  if (!/^[0-9+\-*/().\s*><=!&|]+$/.test(expr)) {
    throw new Error('#ERROR!');
  }

  let result;
  try {
    result = Function(`"use strict"; return (${expr})`)();
  } catch (_) {
    throw new Error('#ERROR!');
  }

  if (typeof result === 'number' && !isFinite(result)) {
    throw new Error('#DIV/0!');
  }
  if (typeof result === 'number') {
    return Math.abs(result - Math.round(result)) < 1e-12 ? Math.round(result) : parseFloat(result.toPrecision(12));
  }
  return result;
}

export function evaluateFormula(formulaStr, callingCellRef = null) {
  if (typeof formulaStr !== 'string' || !formulaStr.startsWith('=')) {
    return formulaStr;
  }

  const rawExpr = formulaStr.slice(1).trim();
  if (!rawExpr) return '';

  // Circular dependency guard
  if (callingCellRef) {
    if (visitingCycleRefs.has(callingCellRef)) {
      return '#REF!';
    }
    visitingCycleRefs.add(callingCellRef);
  }

  try {
    // Single cell reference fast-path, preserving text/types
    if (/^[A-Za-z]+\d+$/i.test(rawExpr)) {
      const val = getCellValue(rawExpr);
      if (typeof val === 'string' && (val.startsWith('#') || val.includes('REF') || val.includes('ERROR') || val.includes('DIV'))) {
        throw new Error(val);
      }
      return val !== null && val !== undefined ? val : '';
    }

    return evaluateSubExpression(rawExpr);
  } catch (err) {
    if (err.message && (err.message.startsWith('#') || err.message === '#REF!' || err.message === '#DIV/0!' || err.message === '#ERROR!')) {
      return err.message;
    }
    return '#ERROR!';
  } finally {
    if (callingCellRef) {
      visitingCycleRefs.delete(callingCellRef);
    }
  }
}

export function saveDocument(title) {
  if (title) {
    if (typeof document !== 'undefined') {
      const titleInput = document.getElementById('excel-doc-title');
      if (titleInput) titleInput.value = title;
    }
    saveDocToIndex(title);
  }
  saveSpreadsheetData(false);
}

function hasUserContent() {
  if (excelInstance && typeof excelInstance.getData === 'function') {
    try {
      const liveData = excelInstance.getData();
      if (liveData && liveData[0]) populateCellStoreFromData(liveData);
    } catch (_) {}
  }
  const keys = Object.keys(cellStore);
  return keys.some(k => {
    const val = cellStore[k];
    return val !== undefined && val !== null && String(val).trim() !== '';
  });
}

function bindExcelEvents() {
  if (typeof document === 'undefined') return;

  // Helper: restore x-spreadsheet focus after toolbar button actions
  // x-data-spreadsheet sets this.focusing = false when clicks land outside the canvas overlayer,
  // which causes all keyboard input to be silently ignored
  function restoreSheetFocus() {
    if (excelInstance && excelInstance.sheet) {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (!activeEl || (activeEl.tagName !== 'INPUT' && activeEl.tagName !== 'TEXTAREA')) {
        excelInstance.sheet.focusing = true;
      }
    }
  }

  // Prevent all toolbar ribbon buttons from stealing focus from x-spreadsheet
  // Exclude buttons that activate search/inputs (e.g. #btn-excel-search)
  const ribbonBtns = document.querySelectorAll(
    '#excel-tab-home-content button:not(#btn-excel-search), #excel-tab-formulas-content button, #excel-tab-file-content button'
  );
  ribbonBtns.forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      // Prevent DOM focus transfer away from spreadsheet
      e.preventDefault();
    });
    btn.addEventListener('click', () => {
      // Restore x-spreadsheet focusing flag after click handler runs
      setTimeout(restoreSheetFocus, 0);
    });
  });

  // Global capture shield: when any input or textarea has focus, protect it from x-spreadsheet key interception
  if (!globalInputShield) {
    globalInputShield = (e) => {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        if (!target.classList.contains('x-spreadsheet-textarea') && !target.closest('.x-spreadsheet-editor')) {
          if (excelInstance && excelInstance.sheet) {
            excelInstance.sheet.focusing = false;
          }
          e.stopPropagation();
        }
      }
    };
    window.addEventListener('keydown', globalInputShield, true);
  }

  // Make fx button/label, cell position badge, and edit icon clickable & touch-responsive → focus formula bar
  const fxLabel = document.getElementById('excel-formula-fx-btn') || document.querySelector('#excel-formula-bar .text-green-600');
  const cellPosLabel = document.getElementById('excel-cell-position');
  const editCellBtn = document.getElementById('excel-edit-cell-btn');
  const formulaApplyBtn = document.getElementById('excel-formula-apply-btn');
  const formulaInputForFx = document.getElementById('excel-formula-input');

  if (fxLabel) {
    fxLabel.style.cursor = 'pointer';
    const onFxActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusFormulaInput('=', false);
    };
    fxLabel.addEventListener('click', onFxActivate);
    fxLabel.addEventListener('touchend', onFxActivate);
  }

  if (cellPosLabel) {
    cellPosLabel.style.cursor = 'pointer';
    const onPosActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusFormulaInput(null, true);
    };
    cellPosLabel.addEventListener('click', onPosActivate);
    cellPosLabel.addEventListener('touchend', onPosActivate);
  }

  if (editCellBtn) {
    editCellBtn.style.cursor = 'pointer';
    const onEditActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusFormulaInput(null, false);
    };
    editCellBtn.addEventListener('click', onEditActivate);
    editCellBtn.addEventListener('touchend', onEditActivate);
  }

  if (formulaApplyBtn && formulaInputForFx) {
    const onApplyActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyFormulaFromInput(formulaInputForFx.value);
      formulaInputForFx.blur();
      restoreSheetFocus();
    };
    formulaApplyBtn.addEventListener('click', onApplyActivate);
    formulaApplyBtn.addEventListener('touchend', onApplyActivate);
  }

  const closeBtn = document.getElementById('close-excel-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeExcelEditor);

  const titleInput = document.getElementById('excel-doc-title');
  if (titleInput) {
    titleInput.addEventListener('focus', () => {
      if (excelInstance && excelInstance.sheet) {
        excelInstance.sheet.focusing = false;
      }
    });
    titleInput.addEventListener('blur', () => {
      setTimeout(restoreSheetFocus, 50);
    });
    titleInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        titleInput.blur();
      }
    });
    titleInput.addEventListener('keyup', (e) => e.stopPropagation());
    titleInput.addEventListener('keypress', (e) => e.stopPropagation());
    titleInput.addEventListener('change', (e) => {
      saveDocToIndex(e.target.value);
      saveSpreadsheetData(false);
    });
  }

  const topExportBtn = document.getElementById('excel-file-btn-top');
  if (topExportBtn) {
    topExportBtn.addEventListener('click', exportToCSV);
  }

  const formulaInput = document.getElementById('excel-formula-input');
  if (formulaInput) {
    formulaInput.addEventListener('focus', () => {
      if (excelInstance && excelInstance.sheet) {
        excelInstance.sheet.focusing = false;
      }
    });

    formulaInput.addEventListener('blur', () => {
      applyFormulaFromInput(formulaInput.value);
      setTimeout(restoreSheetFocus, 50);
    });

    // Live update on input, but commit and save on change or Enter
    formulaInput.addEventListener('input', (e) => {
      const { ri, ci } = activeCell;
      cellStore[`${ri}:${ci}`] = e.target.value;
      if (excelInstance && typeof excelInstance.cellText === 'function') {
        excelInstance.cellText(ri, ci, e.target.value);
        if (excelInstance.reRender) excelInstance.reRender();
      }
    });

    formulaInput.addEventListener('change', (e) => {
      applyFormulaFromInput(e.target.value);
    });

    formulaInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        applyFormulaFromInput(formulaInput.value);
        formulaInput.blur();
        restoreSheetFocus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const cur = cellStore[`${activeCell.ri}:${activeCell.ci}`] || '';
        formulaInput.value = cur;
        applyFormulaFromInput(cur);
        formulaInput.blur();
        restoreSheetFocus();
      }
    });

    formulaInput.addEventListener('keyup', (e) => e.stopPropagation());
    formulaInput.addEventListener('keypress', (e) => e.stopPropagation());
  }

  document.querySelectorAll('.excel-tab-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', () => {
      document.querySelectorAll('.excel-tab-btn').forEach(b => {
        b.classList.remove('active', 'text-green-600');
        b.classList.add('text-gray-500');
      });
      btn.classList.add('active', 'text-green-600');
      btn.classList.remove('text-gray-500');

      ['excel-tab-home-content', 'excel-tab-formulas-content', 'excel-tab-file-content'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.classList.add('hidden');
          el.classList.remove('flex');
        }
      });
      const targetEl = document.getElementById(btn.dataset.target);
      if (targetEl) {
        targetEl.classList.remove('hidden');
        targetEl.classList.add('flex');
      }
      setTimeout(restoreSheetFocus, 0);
    });
  });

  const undoBtn = document.getElementById('btn-excel-undo');
  if (undoBtn) {
    undoBtn.addEventListener('click', performUndo);
  }

  const redoBtn = document.getElementById('btn-excel-redo');
  if (redoBtn) {
    redoBtn.addEventListener('click', performRedo);
  }

  const addRowBtn = document.getElementById('btn-excel-add-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        excelInstance.sheet.data.insert('row');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const delRowBtn = document.getElementById('btn-excel-del-row');
  if (delRowBtn) {
    delRowBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        excelInstance.sheet.data.delete('row');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const addColBtn = document.getElementById('btn-excel-add-col');
  if (addColBtn) {
    addColBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        excelInstance.sheet.data.insert('column');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const delColBtn = document.getElementById('btn-excel-del-col');
  if (delColBtn) {
    delColBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        excelInstance.sheet.data.delete('column');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const boldBtn = document.getElementById('btn-excel-bold');
  if (boldBtn) {
    boldBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        const data = excelInstance.sheet.data;
        const { ri, ci } = activeCell;
        const cell = (data.getCell ? data.getCell(ri, ci) : null) || {};
        const isBold = cell.style !== undefined && data.styles && data.styles[cell.style] && data.styles[cell.style].font && data.styles[cell.style].font.bold;
        if (data.setSelectedCellAttr) data.setSelectedCellAttr('font-bold', !isBold);
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const italicBtn = document.getElementById('btn-excel-italic');
  if (italicBtn) {
    italicBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data) {
        const data = excelInstance.sheet.data;
        const { ri, ci } = activeCell;
        const cell = (data.getCell ? data.getCell(ri, ci) : null) || {};
        const isItalic = cell.style !== undefined && data.styles && data.styles[cell.style] && data.styles[cell.style].font && data.styles[cell.style].font.italic;
        if (data.setSelectedCellAttr) data.setSelectedCellAttr('font-italic', !isItalic);
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const textColorInput = document.getElementById('btn-excel-color');
  if (textColorInput) {
    textColorInput.addEventListener('input', (e) => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.setSelectedCellAttr) {
        excelInstance.sheet.data.setSelectedCellAttr('color', e.target.value);
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const bgColorInput = document.getElementById('btn-excel-bg-color');
  if (bgColorInput) {
    bgColorInput.addEventListener('input', (e) => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.setSelectedCellAttr) {
        excelInstance.sheet.data.setSelectedCellAttr('bgcolor', e.target.value);
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const alignLeftBtn = document.getElementById('btn-excel-align-left');
  if (alignLeftBtn) {
    alignLeftBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.setSelectedCellAttr) {
        excelInstance.sheet.data.setSelectedCellAttr('align', 'left');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const alignCenterBtn = document.getElementById('btn-excel-align-center');
  if (alignCenterBtn) {
    alignCenterBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.setSelectedCellAttr) {
        excelInstance.sheet.data.setSelectedCellAttr('align', 'center');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const alignRightBtn = document.getElementById('btn-excel-align-right');
  if (alignRightBtn) {
    alignRightBtn.addEventListener('click', () => {
      if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.setSelectedCellAttr) {
        excelInstance.sheet.data.setSelectedCellAttr('align', 'right');
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      }
    });
  }

  const sumBtn = document.getElementById('btn-excel-sum');
  if (sumBtn) sumBtn.addEventListener('click', () => insertFormulaShortcut('SUM'));

  const avgBtn = document.getElementById('btn-excel-avg');
  if (avgBtn) avgBtn.addEventListener('click', () => insertFormulaShortcut('AVERAGE'));

  const maxBtn = document.getElementById('btn-excel-max');
  if (maxBtn) maxBtn.addEventListener('click', () => insertFormulaShortcut('MAX'));

  const minBtn = document.getElementById('btn-excel-min');
  if (minBtn) minBtn.addEventListener('click', () => insertFormulaShortcut('MIN'));

  const countBtn = document.getElementById('btn-excel-count');
  if (countBtn) countBtn.addEventListener('click', () => insertFormulaShortcut('COUNT'));

  const countaBtn = document.getElementById('btn-excel-counta');
  if (countaBtn) countaBtn.addEventListener('click', () => insertFormulaShortcut('COUNTA'));

  const csvBtn = document.getElementById('btn-excel-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', exportToCSV);

  const xlsxBtn = document.getElementById('btn-excel-export-xlsx');
  if (xlsxBtn) xlsxBtn.addEventListener('click', exportToExcel);

  const filePicker = document.getElementById('excel-file-picker');
  const importBtnTop = document.getElementById('excel-file-btn-import');
  const importBtnTab = document.getElementById('btn-excel-tab-import');

  if (importBtnTop && filePicker) {
    importBtnTop.addEventListener('click', () => filePicker.click());
  }
  if (importBtnTab && filePicker) {
    importBtnTab.addEventListener('click', () => filePicker.click());
  }
  if (filePicker) {
    filePicker.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        await importFromFile(file);
        filePicker.value = '';
      }
    });
  }

  const tplSalesBtn = document.getElementById('btn-excel-tpl-sales');
  if (tplSalesBtn) tplSalesBtn.addEventListener('click', () => applyStarterTemplate('sales'));

  const tplInventoryBtn = document.getElementById('btn-excel-tpl-inventory');
  if (tplInventoryBtn) tplInventoryBtn.addEventListener('click', () => applyStarterTemplate('inventory'));

  const tplBudgetBtn = document.getElementById('btn-excel-tpl-budget');
  if (tplBudgetBtn) tplBudgetBtn.addEventListener('click', () => applyStarterTemplate('budget'));

  // ── Merge Cells ──
  const mergeBtn = document.getElementById('btn-excel-merge');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', () => {
      if (!excelInstance || !excelInstance.sheet || !excelInstance.sheet.data) return;
      const data = excelInstance.sheet.data;
      try {
        if (typeof data.merge === 'function') {
          data.merge();
        } else if (excelInstance.sheet && typeof excelInstance.sheet.merge === 'function') {
          excelInstance.sheet.merge();
        }
        if (excelInstance.reRender) excelInstance.reRender();
        saveSpreadsheetData(false);
      } catch (e) {
        try {
          if (typeof data.unmerge === 'function') {
            data.unmerge();
          } else if (excelInstance.sheet && typeof excelInstance.sheet.unmerge === 'function') {
            excelInstance.sheet.unmerge();
          }
          if (excelInstance.reRender) excelInstance.reRender();
          saveSpreadsheetData(false);
        } catch (_) {}
      }
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(getT('cells_merged', 'Cells merged/unmerged'), false);
      }
    });
  }

  // ── Freeze Top Row ──
  const freezeBtn = document.getElementById('btn-excel-freeze');
  if (freezeBtn) {
    let isFrozen = false;
    freezeBtn.addEventListener('click', () => {
      if (!excelInstance || !excelInstance.sheet || !excelInstance.sheet.data) return;
      const data = excelInstance.sheet.data;
      isFrozen = !isFrozen;
      try {
        if (typeof data.setFreeze === 'function') {
          data.setFreeze(isFrozen ? 1 : 0, 0);
        } else if (data.freeze) {
          data.freeze = isFrozen ? [1, 0] : [0, 0];
        }
        if (excelInstance.reRender) excelInstance.reRender();
        if (excelInstance.sheet && typeof excelInstance.sheet.reload === 'function') {
          excelInstance.sheet.reload();
        }
        saveSpreadsheetData(false);
      } catch (e) {
        console.warn('Freeze not supported:', e);
      }
      freezeBtn.classList.toggle('ring-2', isFrozen);
      freezeBtn.classList.toggle('ring-cyan-400', isFrozen);
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(isFrozen ? getT('row_frozen', 'Top row frozen') : getT('row_unfrozen', 'Rows unfrozen'), false);
      }
    });
  }

  // ── Search & Navigation ──
  const searchBtn = document.getElementById('btn-excel-search');
  const searchBar = document.getElementById('excel-search-bar');
  const searchInput = document.getElementById('excel-search-input');
  const searchCount = document.getElementById('excel-search-count');
  const searchCloseBtn = document.getElementById('excel-search-close');
  const searchPrevBtn = document.getElementById('excel-search-prev');
  const searchNextBtn = document.getElementById('excel-search-next');

  let searchResults = [];
  let searchIdx = -1;

  function performSearch(query) {
    if (excelInstance && typeof excelInstance.getData === 'function') {
      try {
        const liveData = excelInstance.getData();
        if (liveData && liveData[0]) populateCellStoreFromData(liveData);
      } catch (_) {}
    }

    searchResults = [];
    searchIdx = -1;
    if (!query) {
      if (searchCount) searchCount.textContent = '';
      return;
    }

    const trimmed = query.trim();
    // Direct coordinate navigation, e.g. "B5" or "AA12"
    if (/^[A-Za-z]+\d+$/.test(trimmed)) {
      const coords = cellRefToCoords(trimmed);
      searchResults.push({ ri: coords.ri, ci: coords.ci, key: `${coords.ri}:${coords.ci}` });
      if (searchCount) searchCount.textContent = '1/1';
      navigateSearch(0);
      return;
    }

    const q = trimmed.toLowerCase();
    Object.keys(cellStore).forEach(key => {
      const val = String(cellStore[key]).toLowerCase();
      if (val.includes(q)) {
        const [rStr, cStr] = key.split(':');
        searchResults.push({ ri: parseInt(rStr, 10), ci: parseInt(cStr, 10), key });
      }
    });

    searchResults.sort((a, b) => a.ri === b.ri ? a.ci - b.ci : a.ri - b.ri);
    if (searchCount) searchCount.textContent = searchResults.length > 0 ? `1/${searchResults.length}` : '0/0';
    if (searchResults.length > 0) navigateSearch(0);
  }

  function navigateSearch(idx) {
    if (searchResults.length === 0) return;
    searchIdx = ((idx % searchResults.length) + searchResults.length) % searchResults.length;
    const result = searchResults[searchIdx];
    if (searchCount) searchCount.textContent = `${searchIdx + 1}/${searchResults.length}`;

    activeCell = { ri: result.ri, ci: result.ci };
    updateFormulaBar(result.ri, result.ci, cellStore[result.key] || '');

    // Safely update x-spreadsheet selector using component methods and scrollbars without corrupting state
    if (excelInstance && excelInstance.sheet) {
      try {
        if (excelInstance.sheet.selector && typeof excelInstance.sheet.selector.set === 'function') {
          excelInstance.sheet.selector.set(result.ri, result.ci, true);
        }
        if (excelInstance.sheet.data && typeof excelInstance.sheet.data.getSelectedRect === 'function') {
          const { l, t, left, top, width, height } = excelInstance.sheet.data.getSelectedRect();
          const tableOffset = typeof excelInstance.sheet.getTableOffset === 'function' ? excelInstance.sheet.getTableOffset() : null;
          if (tableOffset) {
            if (excelInstance.sheet.horizontalScrollbar && typeof excelInstance.sheet.horizontalScrollbar.move === 'function') {
              if (Math.abs(left) + width > tableOffset.width) {
                excelInstance.sheet.horizontalScrollbar.move({ left: l + width - tableOffset.width });
              } else {
                const fsw = excelInstance.sheet.data.freezeTotalWidth ? excelInstance.sheet.data.freezeTotalWidth() : 0;
                if (left < fsw) excelInstance.sheet.horizontalScrollbar.move({ left: l - 1 - fsw });
              }
            }
            if (excelInstance.sheet.verticalScrollbar && typeof excelInstance.sheet.verticalScrollbar.move === 'function') {
              if (Math.abs(top) + height > tableOffset.height) {
                excelInstance.sheet.verticalScrollbar.move({ top: t + height - tableOffset.height - 1 });
              } else {
                const fsh = excelInstance.sheet.data.freezeTotalHeight ? excelInstance.sheet.data.freezeTotalHeight() : 0;
                if (top < fsh) excelInstance.sheet.verticalScrollbar.move({ top: t - 1 - fsh });
              }
            }
          }
        }
        if (excelInstance.sheet.table && typeof excelInstance.sheet.table.render === 'function') {
          excelInstance.sheet.table.render();
        } else if (typeof excelInstance.reRender === 'function') {
          excelInstance.reRender();
        }
      } catch (e) {
        console.warn('Search selection warning:', e);
      }
    }
  }

  if (searchBtn && searchBar) {
    const handleSearchToggle = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const isOpening = searchBar.classList.contains('hidden');
      searchBar.classList.toggle('hidden');
      searchBar.classList.toggle('flex');
      if (isOpening && searchInput) {
        if (excelInstance && excelInstance.sheet) {
          excelInstance.sheet.focusing = false;
        }
        setTimeout(() => {
          searchInput.focus();
          try { searchInput.select(); } catch (_) {}
        }, 10);
        if (searchInput.value) performSearch(searchInput.value);
      } else {
        restoreSheetFocus();
      }
    };
    searchBtn.addEventListener('click', handleSearchToggle);
    searchBtn.addEventListener('touchend', handleSearchToggle);
  }

  if (searchCloseBtn && searchBar) {
    searchCloseBtn.addEventListener('click', () => {
      searchBar.classList.add('hidden');
      searchBar.classList.remove('flex');
      searchResults = [];
      searchIdx = -1;
      if (searchInput) searchInput.value = '';
      if (searchCount) searchCount.textContent = '';
      restoreSheetFocus();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      if (excelInstance && excelInstance.sheet) {
        excelInstance.sheet.focusing = false;
      }
    });
    searchInput.addEventListener('input', (e) => performSearch(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateSearch(e.shiftKey ? searchIdx - 1 : searchIdx + 1);
      } else if (e.key === 'Escape') {
        if (searchCloseBtn) searchCloseBtn.click();
      }
    });
    searchInput.addEventListener('keyup', (e) => e.stopPropagation());
    searchInput.addEventListener('keypress', (e) => e.stopPropagation());
  }

  if (searchPrevBtn) searchPrevBtn.addEventListener('click', () => navigateSearch(searchIdx - 1));
  if (searchNextBtn) searchNextBtn.addEventListener('click', () => navigateSearch(searchIdx + 1));

  // ── Modal Keyboard Shortcuts ──
  const modal = document.getElementById('excel-editor-modal');
  if (modal) {
    modal.addEventListener('keydown', (e) => {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (!target.classList.contains('x-spreadsheet-textarea') && !target.closest('.x-spreadsheet-editor')) {
          if (excelInstance && excelInstance.sheet) {
            excelInstance.sheet.focusing = false;
          }
          e.stopPropagation();
          return;
        }
      }
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      if (isCtrlOrCmd) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            performRedo();
          } else {
            performUndo();
          }
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          e.stopPropagation();
          performRedo();
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          e.stopPropagation();
          if (searchBar) {
            searchBar.classList.remove('hidden');
            searchBar.classList.add('flex');
            if (searchInput) {
              if (excelInstance && excelInstance.sheet) {
                excelInstance.sheet.focusing = false;
              }
              searchInput.focus();
              try { searchInput.select(); } catch (_) {}
            }
          }
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          e.stopPropagation();
          saveSpreadsheetData(false);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast(getT('saved_local', 'Saved locally'), false);
          }
        }
      } else if (e.key === 'Escape') {
        if (excelInstance && excelInstance.sheet && excelInstance.sheet.contextMenu) {
          excelInstance.sheet.contextMenu.hide();
        }
      }
    });
  }

  // ── Share ──
  const shareBtn = document.getElementById('btn-excel-share');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      try {
        const titleVal = document.getElementById('excel-doc-title')?.value || getT('untitled', 'Spreadsheet');
        let maxRow = -1, maxCol = -1;
        Object.keys(cellStore).forEach(key => {
          const [r, c] = key.split(':').map(Number);
          if (!isNaN(r) && r > maxRow) maxRow = r;
          if (!isNaN(c) && c > maxCol) maxCol = c;
        });
        if (maxRow === -1) { maxRow = 0; maxCol = 0; }

        const lines = [];
        for (let r = 0; r <= maxRow; r++) {
          const row = [];
          for (let c = 0; c <= maxCol; c++) {
            let val = getCellValue(coordsToCellRef(r, c));
            if (val === null || val === undefined) val = '';
            val = String(val).replace(/"/g, '""');
            if (val.includes(',') || val.includes('\n') || val.includes('"')) val = `"${val}"`;
            row.push(val);
          }
          lines.push(row.join(','));
        }
        const csvText = lines.join('\n');
        const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
        const file = new File([blob], (titleVal || 'Spreadsheet') + '.csv', { type: 'text/csv' });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: titleVal, files: [file] });
        } else if (navigator.share) {
          await navigator.share({ title: titleVal, text: csvText });
        } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(csvText);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast(getT('copied_clipboard', 'Copied table to clipboard'), false);
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('Share failed:', e);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast(getT('share_failed', 'Share failed'), true);
          }
        }
      }
    });
  }
}

async function getXlsxModule() {
  if (typeof window !== 'undefined' && window.XLSX) return window.XLSX;
  if (typeof globalThis !== 'undefined' && globalThis.XLSX) return globalThis.XLSX;
  try {
    const mod = await import('xlsx');
    return mod.default || mod;
  } catch (e) {
    if (typeof window !== 'undefined' && window.XLSX) return window.XLSX;
    throw e;
  }
}

export async function importFromFile(file) {
  if (!file) return;
  try {
    const isCsv = file.name.endsWith('.csv') || file.name.endsWith('.tsv') || file.name.endsWith('.txt');
    let rowsData = [];
    let importedMerges = [];

    if (isCsv) {
      const text = await file.text();
      const delimiter = text.includes('\t') ? '\t' : (text.includes(';') ? ';' : ',');
      rowsData = [];
      let currentRow = [];
      let currentVal = '';
      let insideQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const nextCh = text[i + 1];
        if (ch === '"') {
          if (insideQuotes && nextCh === '"') {
            currentVal += '"';
            i++;
          } else {
            insideQuotes = !insideQuotes;
          }
        } else if (ch === delimiter && !insideQuotes) {
          currentRow.push(currentVal.trim());
          currentVal = '';
        } else if ((ch === '\r' || ch === '\n') && !insideQuotes) {
          if (ch === '\r' && nextCh === '\n') i++;
          currentRow.push(currentVal.trim());
          if (currentRow.some(c => c !== '')) rowsData.push(currentRow);
          currentRow = [];
          currentVal = '';
        } else {
          currentVal += ch;
        }
      }
      if (currentVal || currentRow.length > 0) {
        currentRow.push(currentVal.trim());
        if (currentRow.some(c => c !== '')) rowsData.push(currentRow);
      }
    } else {
      const xlsx = await getXlsxModule();
      const buffer = await file.arrayBuffer();
      const wb = xlsx.read(buffer, { type: 'array' });
      const firstSheetName = wb.SheetNames[0];
      const ws = wb.Sheets[firstSheetName];

      if (ws && ws['!ref']) {
        const range = xlsx.utils.decode_range(ws['!ref']);
        rowsData = [];
        for (let R = range.s.r; R <= range.e.r; ++R) {
          const row = [];
          for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellAddress = xlsx.utils.encode_cell({ r: R, c: C });
            const cell = ws[cellAddress];
            if (!cell) {
              row.push('');
            } else if (cell.f) {
              // Preserve imported formulas
              row.push('=' + cell.f);
            } else if (cell.v !== undefined && cell.v !== null) {
              row.push(String(cell.v));
            } else if (cell.w !== undefined) {
              row.push(cell.w);
            } else {
              row.push('');
            }
          }
          rowsData.push(row);
        }
        if (Array.isArray(ws['!merges'])) {
          ws['!merges'].forEach(m => {
            if (m && m.s && m.e) {
              const sRef = coordsToCellRef(m.s.r, m.s.c);
              const eRef = coordsToCellRef(m.e.r, m.e.c);
              importedMerges.push(`${sRef}:${eRef}`);
            }
          });
        }
      } else {
        rowsData = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false });
      }
    }

    pushUndoSnapshot();
    cellStore = {};
    const rowsObj = {};
    rowsData.forEach((row, ri) => {
      if (!rowsObj[ri]) rowsObj[ri] = { cells: {} };
      row.forEach((val, ci) => {
        const textVal = val !== null && val !== undefined ? String(val) : '';
        cellStore[`${ri}:${ci}`] = textVal;
        rowsObj[ri].cells[ci] = { text: textVal };
        if (excelInstance && typeof excelInstance.cellText === 'function') {
          excelInstance.cellText(ri, ci, textVal);
        }
      });
    });

    const sheetPayload = [{
      name: 'Sheet1',
      freeze: 'A1',
      styles: [],
      merges: importedMerges,
      rows: rowsObj,
      cols: { len: Math.max(26, ...rowsData.map(r => r.length + 5)) }
    }];

    if (excelInstance && typeof excelInstance.loadData === 'function') {
      excelInstance.loadData(sheetPayload);
    }

    const cleanTitle = file.name.replace(/\.[^/.]+$/, '') || getT('untitled', 'Imported Spreadsheet');
    if (typeof document !== 'undefined') {
      const titleInput = document.getElementById('excel-doc-title');
      if (titleInput) titleInput.value = cleanTitle;
    }

    activeCell = { ri: 0, ci: 0 };
    updateFormulaBar(0, 0, cellStore['0:0'] || '');
    saveDocToIndex(cleanTitle);
    saveSpreadsheetData(false);

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('import_success', `Imported ${file.name} successfully!`).replace('{filename}', file.name), false);
    }
  } catch (err) {
    console.error('Failed to import file:', err);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('import_fail', 'Failed to parse file. Ensure it is a valid CSV or XLSX.'), true);
    }
  }
}

export function applyStarterTemplate(type) {
  // Guard against accidental overwrite of user work
  if (hasUserContent()) {
    const confirmMsg = getT('confirm_template', 'Applying a template will overwrite your current spreadsheet. Are you sure you want to continue?');
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(confirmMsg)) {
      return;
    }
  }

  pushUndoSnapshot();

  let templateTitle = getT('untitled', 'Spreadsheet');
  const newStore = {};

  if (type === 'sales') {
    templateTitle = getT('tpl_sales', 'Daily Sales Tracker');
    const grid = [
      ['Date', 'Item Description', 'Qty', 'Unit Price', 'Total'],
      ['2026-08-14', 'Mineral Water (Pack)', '5', '1200', '=C2*D2'],
      ['2026-08-14', 'Mobile Airtime Card', '10', '500', '=C3*D3'],
      ['2026-08-14', 'Rice 5kg Bag', '3', '7500', '=C4*D4'],
      ['2026-08-14', 'Cooking Oil 1L', '4', '3200', '=C5*D5'],
      ['Total Revenue', '', '', '', '=SUM(E2:E5)']
    ];
    grid.forEach((row, ri) => {
      row.forEach((val, ci) => {
        newStore[`${ri}:${ci}`] = val;
      });
    });
  } else if (type === 'inventory') {
    templateTitle = getT('tpl_inventory', 'Inventory Stock Sheet');
    const grid = [
      ['SKU / Code', 'Product Name', 'In Stock', 'Unit Cost', 'Total Value'],
      ['SKU-001', 'Sugar 1kg', '50', '1500', '=C2*D2'],
      ['SKU-002', 'Wheat Flour 2kg', '30', '2800', '=C3*D3'],
      ['SKU-003', 'Soap Bar (Box)', '15', '4500', '=C4*D4'],
      ['SKU-004', 'Tea Leaves 250g', '40', '900', '=C5*D5'],
      ['Total Stock Value', '', '', '', '=SUM(E2:E5)']
    ];
    grid.forEach((row, ri) => {
      row.forEach((val, ci) => {
        newStore[`${ri}:${ci}`] = val;
      });
    });
  } else if (type === 'budget') {
    templateTitle = getT('tpl_budget', 'Budget & Expenses');
    const grid = [
      ['Expense Category', 'Planned Budget', 'Actual Spent', 'Balance Remaining'],
      ['Shop Rent', '50000', '50000', '=B2-C2'],
      ['Electricity & Water', '15000', '12500', '=B3-C3'],
      ['Transport / Fuel', '20000', '21500', '=B4-C4'],
      ['Supplier Goods', '120000', '115000', '=B5-C5'],
      ['Total Spent', '=SUM(B2:B5)', '=SUM(C2:C5)', '=SUM(D2:D5)']
    ];
    grid.forEach((row, ri) => {
      row.forEach((val, ci) => {
        newStore[`${ri}:${ci}`] = val;
      });
    });
  }

  cellStore = newStore;
  if (excelInstance && typeof excelInstance.cellText === 'function') {
    Object.keys(cellStore).forEach(key => {
      const [rStr, cStr] = key.split(':');
      excelInstance.cellText(parseInt(rStr, 10), parseInt(cStr, 10), String(cellStore[key]));
    });
  }
  const rowsObj = {};
  Object.keys(cellStore).forEach(key => {
    const [rStr, cStr] = key.split(':');
    const r = parseInt(rStr, 10);
    const c = parseInt(cStr, 10);
    if (!rowsObj[r]) rowsObj[r] = { cells: {} };
    rowsObj[r].cells[c] = { text: cellStore[key] };
  });

  const sheetPayload = [{
    name: 'Sheet1',
    freeze: 'A1',
    styles: [{ font: { bold: true } }],
    merges: [],
    rows: rowsObj,
    cols: { len: 26 }
  }];

  if (excelInstance && typeof excelInstance.loadData === 'function') {
    excelInstance.loadData(sheetPayload);
  }

  if (typeof document !== 'undefined') {
    const titleInput = document.getElementById('excel-doc-title');
    if (titleInput) titleInput.value = templateTitle;
  }

  activeCell = { ri: 0, ci: 0 };
  updateFormulaBar(0, 0, cellStore['0:0'] || '');
  saveDocToIndex(templateTitle);
  saveSpreadsheetData(false);

  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(getT('template_loaded', `${templateTitle} template loaded!`).replace('{template}', templateTitle), false);
  }
}

export function exportToCSV() {
  try {
    // Keep cellStore synchronized from live grid if active
    if (excelInstance && typeof excelInstance.getData === 'function') {
      try {
        const liveData = excelInstance.getData();
        if (liveData && liveData[0]) populateCellStoreFromData(liveData);
      } catch (_) {}
    }

    let maxRow = -1;
    let maxCol = -1;

    Object.keys(cellStore).forEach(key => {
      const [rStr, cStr] = key.split(':');
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      if (!isNaN(r) && r > maxRow) maxRow = r;
      if (!isNaN(c) && c > maxCol) maxCol = c;
    });

    if (maxRow === -1) maxRow = 0;
    if (maxCol === -1) maxCol = 0;

    const csvLines = [];
    for (let r = 0; r <= maxRow; r++) {
      const lineValues = [];
      for (let c = 0; c <= maxCol; c++) {
        let val = getCellValue(coordsToCellRef(r, c));
        if (val === null || val === undefined) val = '';
        val = String(val).replace(/"/g, '""');
        if (val.includes(',') || val.includes('\n') || val.includes('"')) {
          val = `"${val}"`;
        }
        lineValues.push(val);
      }
      csvLines.push(lineValues.join(','));
    }

    const titleVal = (typeof document !== 'undefined' && document.getElementById('excel-doc-title'))
      ? document.getElementById('excel-doc-title').value
      : getT('untitled', 'Spreadsheet');
    const filename = (titleVal || 'Spreadsheet') + '.csv';

    if (typeof document !== 'undefined') {
      const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 150);
    }

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('csv_export_success', 'CSV exported successfully!'), false);
    }
  } catch (err) {
    console.error('CSV export failed:', err);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('csv_export_fail', 'Failed to export CSV.'), true);
    }
  }
}

export async function exportToExcel() {
  try {
    const xlsx = await getXlsxModule();

    // Keep cellStore synchronized from live grid
    if (excelInstance && typeof excelInstance.getData === 'function') {
      try {
        const liveData = excelInstance.getData();
        if (liveData && liveData[0]) populateCellStoreFromData(liveData);
      } catch (_) {}
    }

    let maxRow = -1;
    let maxCol = -1;

    Object.keys(cellStore).forEach(key => {
      const [rStr, cStr] = key.split(':');
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      if (!isNaN(r) && r > maxRow) maxRow = r;
      if (!isNaN(c) && c > maxCol) maxCol = c;
    });

    if (maxRow === -1) maxRow = 0;
    if (maxCol === -1) maxCol = 0;

    const ws = {};
    for (let r = 0; r <= maxRow; r++) {
      for (let c = 0; c <= maxCol; c++) {
        const ref = coordsToCellRef(r, c);
        const rawVal = cellStore[`${r}:${c}`];
        if (rawVal === undefined || rawVal === null || rawVal === '') continue;

        const strVal = String(rawVal).trim();
        if (strVal.startsWith('=')) {
          // Export formula cell so Microsoft Excel / Google Sheets retain live formulas
          const formula = strVal.slice(1);
          const evalVal = evaluateFormula(strVal, ref);
          const numVal = Number(evalVal);
          if (!isNaN(numVal) && isFinite(numVal)) {
            ws[ref] = { t: 'n', f: formula, v: numVal };
          } else {
            ws[ref] = { t: 's', f: formula, v: String(evalVal) };
          }
        } else {
          const num = Number(strVal);
          if (!isNaN(num) && strVal !== '') {
            ws[ref] = { t: 'n', v: num };
          } else {
            ws[ref] = { t: 's', v: strVal };
          }
        }
      }
    }

    ws['!ref'] = `A1:${coordsToCellRef(Math.max(0, maxRow), Math.max(0, maxCol))}`;

    // Export merges if defined in x-spreadsheet or stored data
    let rawMerges = [];
    if (excelInstance && excelInstance.sheet && excelInstance.sheet.data && excelInstance.sheet.data.merges) {
      const mObj = excelInstance.sheet.data.merges;
      if (Array.isArray(mObj._)) {
        rawMerges = mObj._;
      } else if (typeof mObj.getData === 'function') {
        rawMerges = mObj.getData();
      } else if (Array.isArray(mObj)) {
        rawMerges = mObj;
      }
    }
    if (rawMerges.length === 0) {
      try {
        const raw = localStorage.getItem(EXCEL_STORAGE_KEY_PREFIX + currentDocId);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed[0] && Array.isArray(parsed[0].merges)) {
            rawMerges = parsed[0].merges;
          }
        }
      } catch (_) {}
    }

    const merges = [];
    rawMerges.forEach(m => {
      if (!m) return;
      if (typeof m === 'string' && m.includes(':')) {
        const [startRef, endRef] = m.split(':');
        const start = cellRefToCoords(startRef);
        const end = cellRefToCoords(endRef);
        merges.push({ s: { r: start.ri, c: start.ci }, e: { r: end.ri, c: end.ci } });
      } else if (typeof m.sri === 'number') {
        merges.push({ s: { r: m.sri, c: m.sci }, e: { r: m.eri, c: m.eci } });
      } else if (m.s && m.e) {
        merges.push(m);
      }
    });
    if (merges.length > 0) ws['!merges'] = merges;

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');

    const titleVal = (typeof document !== 'undefined' && document.getElementById('excel-doc-title'))
      ? document.getElementById('excel-doc-title').value
      : getT('untitled', 'Spreadsheet');
    const filename = (titleVal || 'Spreadsheet') + '.xlsx';

    if (typeof xlsx.writeFile === 'function') {
      xlsx.writeFile(wb, filename);
    } else if (typeof xlsx.write === 'function' && typeof document !== 'undefined') {
      const out = xlsx.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 150);
    }

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('xlsx_export_success', 'Excel exported successfully!'), false);
    }
  } catch (err) {
    console.error('Excel export failed:', err);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(getT('xlsx_export_fail', 'Failed to export Excel.'), true);
    }
  }
}
