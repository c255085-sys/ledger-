// Gemini 拆句：只把輸入原句交給 Gemini，其他資料留在瀏覽器。
(() => {
  const GEMINI_MODEL = "gemini-2.5-flash";
  const GEMINI_KEY_NAME = "gemini-api-key";
  const GEMINI_TIMEOUT_MS = 8000;
  const GEMINI_CATEGORIES = ["餐飲", "交通", "購物", "娛樂", "居住", "其他"];

  const CATEGORY_TEXT = GEMINI_CATEGORIES.map((category) => `「${category}」`).join("、");

  function makePrompt(sentence) {
    return [
      "請從使用者提供的記帳原句拆出每一筆支出，只能依原文內容，不要推測或補充。",
      "只回傳 JSON 陣列，不要說明文字、不要 Markdown 圍欄。即使只有一筆也必須回傳陣列。",
      '陣列每個元素只能有 amount、category、note 三個欄位，不可多也不可少。',
      "amount 必須是整數新台幣；category 只能從這些分類選一個：" + CATEGORY_TEXT + "；無法判斷時用「其他」。",
      "note 使用原句中的簡短內容，不要自行編造。",
      "記帳原句：" + sentence
    ].join("\n");
  }

  function failure(message) {
    return { success: false, error: message };
  }

  function parseModelText(text) {
    let cleaned = text.trim();
    const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) cleaned = fence[1];

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.records)) {
      parsed = parsed.records;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const records = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const keys = Object.keys(item).sort();
      if (keys.join(",") !== "amount,category,note") return null;
      if (!Number.isSafeInteger(item.amount) || item.amount <= 0) return null;
      if (typeof item.category !== "string" || !GEMINI_CATEGORIES.includes(item.category)) return null;
      if (typeof item.note !== "string") return null;
      records.push({ amount: item.amount, category: item.category, note: item.note });
    }
    return records;
  }

  function explainError(error, responseStatus) {
    if (responseStatus === 401 || responseStatus === 403) {
      return "Gemini 說這支 key 不能用，去 Google 後台確認一下；這次先用自己填的";
    }
    if (responseStatus === 429) {
      return "Gemini 今天的額度用完了，明天再試；這次先用自己填的";
    }
    if (error && error.name === "AbortError") {
      return "Gemini 8 秒內沒回應，已切換手動輸入";
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "現在沒有網路，先用自己填的";
    }
    return "Gemini 這次沒成功（原因：網路或服務暫時有問題），先用自己填的";
  }

  async function splitSentence(sentence) {
    if (typeof sentence !== "string" || sentence.trim() === "") {
      return failure("請先輸入一句話，這次先用自己填的");
    }

    let apiKey;
    try {
      apiKey = localStorage.getItem(GEMINI_KEY_NAME);
    } catch {
      return failure("讀不到瀏覽器裡的 Gemini key，這次先用自己填的");
    }
    if (!apiKey) return failure("還沒貼 Gemini 的 key，下面可以貼；這次先用自己填的");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let responseStatus = 0;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: makePrompt(sentence) }] }],
          generationConfig: { responseMimeType: "application/json" }
        }),
        signal: controller.signal
      });
      responseStatus = response.status;
      if (!response.ok) return failure(explainError(null, response.status));

      const payload = await response.json();
      const modelText = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
      const records = typeof modelText === "string" ? parseModelText(modelText) : null;
      if (!records) return failure("Gemini 回來的內容看不懂，已切換手動輸入");
      return { success: true, records };
    } catch (error) {
      return failure(explainError(error, responseStatus));
    } finally {
      clearTimeout(timeout);
    }
  }

  window.GeminiSplitter = Object.freeze({ splitSentence });
})();
