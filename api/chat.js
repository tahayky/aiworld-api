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
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 250)
    }));

    if (trimmedHistory[0]?.role === "assistant") {
      trimmedHistory = trimmedHistory.slice(1);
    }

    if (trimmedHistory.length === 0) {
      return jsonResponse({ reply: "..." });
    }

    // Talimatı ilk kullanıcı mesajına göm (Gemma API 400 hatasını önler)
    const messages = trimmedHistory.map((m, idx) =>
      idx === 0 ? { role: "user", content: `[Talimat: ${systemPrompt}]\n\n${m.content}` } : m
    );

    // 4. Gemma 4 Zinciri (Önce 31B, kota dolunca 26B)
    const models = ["gemma-4-31b-it", "gemma-4-26b-it"];

    for (const model of models) {
      try {
        const result = await callGeminiEndpoint(process.env.GEMINI_KEY, model, messages);
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
        continue;
      }
    }

    // 5. Tüm günlük kotalar dolduysa yedek cevap
    return jsonResponse({
      reply: "Şu an zihnim çok bulanık, biraz sonra tekrar konuşalım.",
      exhausted: true
    });

  } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
}

async function callGeminiEndpoint(apiKey, model, messages) {
  if (!apiKey) return null;

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 220,
      temperature: 0.7
    })
  });

  if (res.status === 422) return { blocked: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const choice = data?.choices?.[0];

  if (choice?.finish_reason === "content_filter") {
    return { blocked: true };
  }

  return choice?.message?.content ? { text: choice.message.content } : null;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
