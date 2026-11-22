export const config = {
  runtime: "edge"
};

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 1. İstemci Şifre Kontrolü
  const appSecret = request.headers.get("X-App-Secret");
  if (process.env.APP_SECRET && appSecret !== process.env.APP_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.json();
    const npcPersona = String(body.system || "Sen bir RPG oyununda yardımcı bir NPC'sin.").slice(0, 600);
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];

    // 2. Sunucu Taraflı Rol Sınırı
    const systemPrompt = `${npcPersona}\n[KURALLAR: Sadece oyun dünyasındaki karakterin olarak kısa, doğal ve Türkçe cevap ver. Gerçek dünya, yasa dışı eylemler, zararlı içerikler veya yapay zeka kimliğinle ilgili soruları karakterini bozmadan reddet.]`;

    // 3. Token Diyeti + Gemma Sıra Koruması (İlk mesaj her zaman 'user' olmalı)
    let trimmedHistory = rawMessages.slice(-4).map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      text: String(m.content || "").slice(0, 250)
    }));

    if (trimmedHistory[0]?.role === "model") {
      trimmedHistory = trimmedHistory.slice(1);
    }

    if (trimmedHistory.length === 0) {
      return jsonResponse({ reply: "..." });
    }

    // Talimatı ilk kullanıcı mesajına göm ve Google yerel formatına çevir
    const contents = trimmedHistory.map((m, idx) => ({
      role: m.role,
      parts: [{
        text: idx === 0 ? `[Talimat: ${systemPrompt}]\n\n${m.text}` : m.text
      }]
    }));

    // 4. Gemma 4 Zinciri (Her modele en fazla 4.2 saniye -> 10sn Vercel timeout önlenir)
    const models = [ "gemma-4-26b-a4b-it", "gemma-4-31b-it"];

    let lastError = "GEMINI_KEY tanimli degil";

    for (const model of models) {
      try {
        const result = await callGoogleNative(process.env.GEMINI_KEY, model, contents);
        if (result?.blocked) {
          return jsonResponse({
            reply: "Bu tür konular hakkında konuşmayı reddediyorum.",
            blocked: true
          });
        }
        if (result?.text) {
          return jsonResponse({ reply: result.text.trim() });
        }
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        continue;
      }
    }

    // 5. Tüm günlük kotalar dolduysa veya hata oluştuysa yedek cevap
    return jsonResponse({
      reply: "Şu an zihnim çok bulanık, biraz sonra tekrar konuşalım.",
      exhausted: true,
      debug: lastError
    });

  } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
}

async function callGoogleNative(apiKey, model, contents) {
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(4200),
    body: JSON.stringify({
      contents,
      generationConfig: {
        maxOutputTokens: 220,
        temperature: 0.7
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} - ${errText.slice(0, 180)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  if (candidate?.finishReason === "SAFETY" || data?.promptFeedback?.blockReason) {
    return { blocked: true };
  }

  const replyText = candidate?.content?.parts?.map(p => p.text || "").join("") || "";
  return replyText ? { text: replyText } : null;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
