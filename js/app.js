// 畫面邏輯：輸入一句話 → 確認卡 → 確認後入帳。
// Gemini 只是幫忙填卡片；它失敗時一律退回自己填，不讓畫面卡住。
(() => {
  // 分類清單（照 CLAUDE.md 第六節，要跟 js/gemini.js 裡的一樣）
  const CATEGORIES = ["餐飲", "交通", "購物", "娛樂", "居住", "其他"];
  const FALLBACK_CATEGORY = "其他";
  const KEY_NAME = "gemini-api-key";
  const WAIT_LIMIT_MS = 8000; // 最多等 8 秒

  const storage = window.LedgerStorage;
  const gemini = window.GeminiSplitter;

  // 找出畫面上的元件
  const $ = (id) => document.getElementById(id);
  const sayForm = $("say-form");
  const sayInput = $("say-input");
  const sendBtn = $("send-btn");
  const waiting = $("waiting");
  const doneMessage = $("done-message");
  const leftOverAfter = $("left-over-after");
  const card = $("card");
  const cardReason = $("card-reason");
  const cardRaw = $("card-raw");
  const cardDate = $("card-date");
  const cardAmount = $("card-amount");
  const cardCategory = $("card-category");
  const cardNote = $("card-note");
  const leftOver = $("left-over");
  const cardError = $("card-error");
  const confirmBtn = $("confirm-btn");
  const cancelBtn = $("cancel-btn");
  const countLine = $("count-line");
  const keyInput = $("key-input");
  const keySaveBtn = $("key-save-btn");
  const keyClearBtn = $("key-clear-btn");
  const keyStatus = $("key-status");
  const ledgerProblem = $("ledger-problem");
  const ledgerProblemText = $("ledger-problem-text");
  const startOverBtn = $("start-over-btn");

  // 目前卡片上的原句，以及「沒記到」的提醒（按確認後還要留著）
  let currentRawText = "";
  let currentLeftOverText = "";
  let isWaiting = false;

  // ---------- 小工具 ----------

  function show(element, text) {
    if (text !== undefined) element.textContent = text;
    element.hidden = false;
  }

  function hide(element) {
    element.hidden = true;
    element.textContent = "";
  }

  // 把全形數字換成半形，方便中文鍵盤打的數字也能用
  function toHalfWidth(text) {
    return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  // 金額要是正整數；不合格就回傳 null
  function readAmount(text) {
    const cleaned = toHalfWidth(String(text)).trim();
    if (!/^[0-9]+$/.test(cleaned)) return null;
    const amount = Number(cleaned);
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    return amount;
  }

  // 「備註 金額」；備註空白就只寫金額
  function describeItem(item) {
    return item.note ? item.note + " " + item.amount : String(item.amount);
  }

  // ---------- 筆數與資料狀態 ----------

  function refreshCount() {
    const count = storage.countRecords();
    countLine.textContent = count === null
      ? "這個瀏覽器目前的記帳資料讀不到（看上面的說明）"
      : "這個瀏覽器目前記了 " + count + " 筆";
  }

  function checkLedger() {
    const loaded = storage.loadLedger();
    if (loaded.ok) {
      ledgerProblem.hidden = true;
      return;
    }
    show(ledgerProblem);
    ledgerProblemText.textContent = loaded.message;
    // 只有「壞掉」才給重新開始；版本太新的資料絕對不能動
    startOverBtn.hidden = loaded.problem !== "broken";
  }

  startOverBtn.addEventListener("click", () => {
    const sure = window.confirm("重新開始會變成 0 筆。原本讀不懂的內容已另存在瀏覽器裡，但 App 不會自動救回來。確定要重新開始嗎？");
    if (!sure) return;
    if (storage.startOver()) {
      window.alert("已重新開始，現在是 0 筆。");
    } else {
      window.alert("沒辦法重新開始，原本的資料沒有被動過。");
    }
    checkLedger();
    refreshCount();
  });

  // ---------- 確認卡 ----------

  function fillCategoryMenu() {
    for (const name of CATEGORIES) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      cardCategory.appendChild(option);
    }
  }

  // 打開確認卡。first：Gemini 給的第一筆（沒有就 null）；reason：切手動的原因
  function openCard(rawText, first, reason) {
    currentRawText = rawText;
    cardRaw.textContent = rawText;
    cardDate.textContent = storage.todayText();
    cardAmount.value = first ? String(first.amount) : "";
    cardCategory.value = first && CATEGORIES.includes(first.category) ? first.category : FALLBACK_CATEGORY;
    cardNote.value = first ? first.note : "";
    hide(cardError);

    if (reason) show(cardReason, reason);
    else hide(cardReason);

    card.hidden = false;
    cardAmount.focus();
    card.scrollIntoView({ block: "center" });
  }

  function closeCard() {
    card.hidden = true;
    hide(leftOver);
    hide(cardError);
  }

  // 拆出不只一筆時，把沒記到的一筆一筆列出來
  function showLeftOver(records) {
    if (records.length <= 1) {
      hide(leftOver);
      currentLeftOverText = "";
      return;
    }
    const first = records[0];
    const rest = records.slice(1);
    const line1 = "這句認到 " + records.length + " 筆，這次只記了第一筆：" + describeItem(first) + "。";
    const line2 = "另 " + rest.length + " 筆沒有記：" + rest.map(describeItem).join("、") + "。";
    show(leftOver, line1 + "\n" + line2);
    currentLeftOverText = line2;
  }

  confirmBtn.addEventListener("click", () => {
    const amount = readAmount(cardAmount.value);
    if (amount === null) {
      show(cardError, "金額要填整數，例如 120");
      cardAmount.focus();
      return;
    }
    const category = CATEGORIES.includes(cardCategory.value) ? cardCategory.value : FALLBACK_CATEGORY;
    const note = cardNote.value.trim();

    const record = {
      id: storage.makeId(),
      date: storage.todayText(),
      amount: amount,
      category: category,
      note: note,
      rawText: currentRawText,
      createdAt: new Date().toISOString()
    };

    const result = storage.addRecord(record);
    if (!result.ok) {
      // 沒存成功：卡片留著，讓阿興可以重試
      show(cardError, result.message);
      return;
    }

    closeCard();
    sayInput.value = "";
    show(doneMessage, "已記下：" + (note || category) + " " + amount + "（" + category + "）");
    if (currentLeftOverText) {
      show(leftOverAfter, "提醒：" + currentLeftOverText + "要記的話，請再送一次。");
    }
    refreshCount();
  });

  cancelBtn.addEventListener("click", () => {
    // 什麼都不存；輸入框的原句留著
    closeCard();
    currentLeftOverText = "";
    sayInput.focus();
  });

  // ---------- 送出一句話 ----------

  // 等 Gemini，但從按下送出起算，最多等 8 秒
  function askGeminiWithLimit(sentence, startedAt) {
    const remaining = Math.max(0, WAIT_LIMIT_MS - (Date.now() - startedAt));
    const limit = new Promise((resolve) => {
      setTimeout(() => resolve({ success: false, error: "Gemini 8 秒內沒回應，已切換手動輸入" }), remaining);
    });
    const ask = gemini
      ? gemini.splitSentence(sentence).catch(() => ({ success: false, error: "Gemini 這次沒成功（原因：程式出了狀況），先用自己填的" }))
      : Promise.resolve({ success: false, error: "Gemini 功能沒有載入成功，先用自己填的" });
    return Promise.race([ask, limit]);
  }

  function setWaiting(on) {
    isWaiting = on;
    sendBtn.disabled = on;
    waiting.hidden = !on;
  }

  sayForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const startedAt = Date.now(); // 計時從按下送出開始
    if (isWaiting) return;

    const sentence = sayInput.value.trim();
    hide(doneMessage);
    hide(leftOverAfter);
    closeCard();
    currentLeftOverText = "";

    if (sentence === "") {
      show(doneMessage, "先打一句話再按送出，例如「午餐便當一百二」。");
      sayInput.focus();
      return;
    }

    // 沒網路：不送、不等，直接自己填
    if (navigator.onLine === false) {
      openCard(sentence, null, "現在沒有網路，先用自己填的");
      return;
    }

    setWaiting(true);
    let answer;
    try {
      answer = await askGeminiWithLimit(sentence, startedAt);
    } finally {
      setWaiting(false);
    }

    if (answer && answer.success && Array.isArray(answer.records) && answer.records.length > 0) {
      openCard(sentence, answer.records[0], "");
      showLeftOver(answer.records);
    } else {
      // 失敗一律自己填：金額留空、分類「其他」
      const reason = answer && answer.error ? answer.error : "Gemini 這次沒成功（原因：不明），先用自己填的";
      openCard(sentence, null, reason);
    }
  });

  // ---------- 設定：Gemini key ----------

  function hasKey() {
    try {
      return Boolean(localStorage.getItem(KEY_NAME));
    } catch {
      return false;
    }
  }

  function refreshKeyStatus() {
    keyStatus.textContent = hasKey()
      ? "已經貼過 key（為了安全不顯示內容）。"
      : "還沒貼 key。";
  }

  keySaveBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (key === "") {
      keyStatus.textContent = "請先把 key 貼進上面的框再按儲存。";
      return;
    }
    try {
      localStorage.setItem(KEY_NAME, key);
    } catch {
      keyStatus.textContent = "key 沒存成功，可能是瀏覽器不讓存資料。";
      return;
    }
    keyInput.value = "";
    refreshKeyStatus();
  });

  keyClearBtn.addEventListener("click", () => {
    try {
      localStorage.removeItem(KEY_NAME);
    } catch {
      keyStatus.textContent = "key 沒清除成功，可能是瀏覽器不讓改資料。";
      return;
    }
    keyInput.value = "";
    refreshKeyStatus();
    keyStatus.textContent += "（已清除）";
  });

  // ---------- 慢速測試開關：網址有 ?slow=1 才生效 ----------
  // 讓送給 Gemini 的請求故意晚 10 秒才出發，用來在手機上親眼看到「8 秒就切手動」。
  // 請求被中止時，會真的取消，不會在背景偷偷送出。
  function installSlowSwitch() {
    if (new URLSearchParams(window.location.search).get("slow") !== "1") return;
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const signal = options.signal;
      const timer = setTimeout(() => realFetch(url, options).then(resolve, reject), 10000);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("慢速測試：請求已中止", "AbortError"));
        });
      }
    });
    show($("slow-banner"));
  }

  // ---------- 開始 ----------
  fillCategoryMenu();
  installSlowSwitch();
  checkLedger();
  refreshCount();
  refreshKeyStatus();
})();
