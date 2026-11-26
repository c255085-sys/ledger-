// 記帳資料的讀寫：只用瀏覽器 localStorage 的 "ledger-data" 這一個名字。
// 原則：出錯時寧可不寫，也不要覆蓋或清空原本的資料。
(() => {
  const LEDGER_KEY = "ledger-data";
  const BACKUP_PREFIX = "ledger-data-backup-";
  const SUPPORTED_VERSION = 1;

  // 空白帳本的樣子
  function emptyLedger() {
    return { version: SUPPORTED_VERSION, records: [] };
  }

  // 檢查一筆紀錄的格式對不對
  function isGoodRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    if (typeof record.id !== "string" || record.id === "") return false;
    if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
    if (!Number.isSafeInteger(record.amount) || record.amount <= 0) return false;
    if (typeof record.category !== "string") return false;
    if (typeof record.note !== "string") return false;
    if (typeof record.rawText !== "string") return false;
    if (typeof record.createdAt !== "string") return false;
    return true;
  }

  // 把壞掉的原始內容另存一份；同樣內容已經備份過就不重複存
  function backupBrokenText(rawText) {
    for (let i = 0; i < localStorage.length; i += 1) {
      const name = localStorage.key(i);
      if (name && name.startsWith(BACKUP_PREFIX) && localStorage.getItem(name) === rawText) {
        return name;
      }
    }
    const name = BACKUP_PREFIX + new Date().toISOString();
    try {
      localStorage.setItem(name, rawText);
      return name;
    } catch {
      return "";
    }
  }

  // 讀出帳本。回傳 { ok: true, data } 或 { ok: false, problem, message }
  function loadLedger() {
    let rawText;
    try {
      rawText = localStorage.getItem(LEDGER_KEY);
    } catch {
      return { ok: false, problem: "unreadable", message: "這個瀏覽器不讓 App 讀取資料（可能是無痕模式或權限被關掉），這次沒辦法記帳。" };
    }

    // 第一次開啟：還沒有資料，當作空白帳本，不算錯誤
    if (rawText === null) return { ok: true, data: emptyLedger() };

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = undefined;
    }

    // 版本比程式新：不要動它
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.version) && parsed.version > SUPPORTED_VERSION) {
      return { ok: false, problem: "too-new", message: "資料版本比這個 App 新，請先更新 App。原本的資料沒有被動過。" };
    }

    const looksRight =
      parsed &&
      typeof parsed === "object" &&
      parsed.version === SUPPORTED_VERSION &&
      Array.isArray(parsed.records) &&
      parsed.records.every(isGoodRecord);

    if (!looksRight) {
      const backupName = backupBrokenText(rawText);
      const backupText = backupName
        ? "原本的內容已另存一份，名稱是「" + backupName + "」。"
        : "原本的內容沒辦法另存備份（可能空間滿了），App 不會去動它。";
      return { ok: false, problem: "broken", message: "記帳資料讀不懂，可能壞掉了。" + backupText + "要不要重新開始由你決定。" };
    }

    return { ok: true, data: parsed };
  }

  // 寫進去之後再讀出來，確認筆數對得上
  function writeAndCheck(ledger) {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    } catch {
      return false;
    }
    const check = loadLedger();
    return check.ok && check.data.records.length === ledger.records.length;
  }

  // 新增一筆。回傳 { ok: true, count } 或 { ok: false, message }
  function addRecord(record) {
    if (!isGoodRecord(record)) {
      return { ok: false, message: "這筆資料格式不對，這次沒存成功。" };
    }
    const loaded = loadLedger();
    if (!loaded.ok) {
      return { ok: false, message: "這次沒存成功：" + loaded.message };
    }
    const ledger = {
      version: SUPPORTED_VERSION,
      records: loaded.data.records.concat([record])
    };
    if (!writeAndCheck(ledger)) {
      return { ok: false, message: "這次沒存成功，可能是手機空間滿了。卡片還在，可以再按一次確認試試看。" };
    }
    return { ok: true, count: ledger.records.length };
  }

  // 目前有幾筆；讀不到時回傳 null
  function countRecords() {
    const loaded = loadLedger();
    return loaded.ok ? loaded.data.records.length : null;
  }

  // 「重新開始」：只有資料壞掉、阿興自己按了確定才會呼叫
  function startOver() {
    const loaded = loadLedger();
    if (loaded.ok) return true; // 資料是好的，就不需要重來
    if (loaded.problem === "too-new") return false; // 新版本的資料絕對不覆蓋
    return writeAndCheck(emptyLedger());
  }

  // 產生不重複的 id
  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // 今天的日期，格式 YYYY-MM-DD（用手機自己的時區）
  function todayText() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return now.getFullYear() + "-" + month + "-" + day;
  }

  window.LedgerStorage = Object.freeze({
    loadLedger,
    addRecord,
    countRecords,
    startOver,
    makeId,
    todayText
  });
})();
