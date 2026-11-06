const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const id = () => crypto.randomUUID();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        app: "SLAV AI",
        model: env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra:free",
        provider: env.OPENROUTER_API_KEY ? "OpenRouter" : "Gemini",
        openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        databaseConfigured: Boolean(env.DB)
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!env.OPENROUTER_API_KEY && !env.GEMINI_API_KEY) {
        return json({ error: "Добавь секрет OPENROUTER_API_KEY в настройках Worker." }, 503);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Некорректный JSON-запрос." }, 400); }

      const message = String(body.message || "").trim().slice(0, 12000);
      if (!message) return json({ error: "Напиши сообщение." }, 400);

      const conversationId = String(body.conversationId || id());
      const modePrompts = {
        chat: "Отвечай естественно, понятно и по делу.",
        think: "Внимательно анализируй задачу, проверяй предположения и давай обоснованный ответ.",
        code: "Ты опытный программист. Предлагай рабочий код, объясняй куда его вставить и предупреждай о рисках. Не утверждай, что запускал или проверял код, если этого не делал.",
        research: "Проводя анализ, отделяй подтверждённые факты от предположений. Не выдумывай источники и ссылки."
      };
      const system = "Ты SLAV AI — русскоязычный универсальный AI-помощник. " +
        (modePrompts[body.mode] || modePrompts.chat) +
        " Отвечай на русском, если пользователь не попросил другой язык. " +
        "Не заявляй о доступе к браузеру, GitHub, файлам или компьютеру, если такого инструмента нет.";

      let history = [];
      if (env.DB) {
        try {
          const rows = await env.DB.prepare(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12"
          ).bind(conversationId).all();
          history = (rows.results || []).reverse().map(row => ({
            role: row.role,
            content: row.content
          }));
        } catch (e) {
          return json({ error: "Ошибка базы данных: " + e.message }, 500);
        }
      }

      let answer = "";
      let providerError = "";

      // Основная модель — бесплатная NVIDIA Nemotron через OpenRouter.
      if (env.OPENROUTER_API_KEY) {
        const model = env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra:free";
        try {
          const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "authorization": "Bearer " + env.OPENROUTER_API_KEY,
              "content-type": "application/json",
              "HTTP-Referer": "https://slav-ai-cloud.slafka1996.workers.dev",
              "X-Title": "SLAV AI"
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                ...history,
                { role: "user", content: message }
              ],
              max_tokens: 4096
            })
          });
          const result = await upstream.json().catch(() => ({}));
          if (upstream.ok) {
            answer = String(result.choices?.[0]?.message?.content || "").trim();
          } else {
            providerError = result.error?.message || ("OpenRouter HTTP " + upstream.status);
          }
        } catch (e) {
          providerError = e.message;
        }
      }

      // Резервный маршрут Gemini, если он настроен и бесплатный маршрут временно недоступен.
      if (!answer && env.GEMINI_API_KEY) {
        const model = env.GEMINI_MODEL || "gemini-2.5-flash";
        const geminiHistory = history.map(row => ({
          role: row.role === "assistant" ? "model" : "user",
          parts: [{ text: row.content }]
        }));
        try {
          const upstream = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(model) + ":generateContent?key=" +
              encodeURIComponent(env.GEMINI_API_KEY),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [...geminiHistory, { role: "user", parts: [{ text: message }] }],
                generationConfig: { maxOutputTokens: 4096 }
              })
            }
          );
          const result = await upstream.json().catch(() => ({}));
          if (upstream.ok) {
            answer = (result.candidates?.[0]?.content?.parts || [])
              .map(part => part.text || "").join("").trim();
          } else {
            providerError = result.error?.message || ("Gemini HTTP " + upstream.status);
          }
        } catch (e) {
          providerError = e.message;
        }
      }

      if (!answer) {
        return json({
          error: providerError || "Модель не вернула текстовый ответ. Проверь API-ключ и доступность бесплатной модели."
        }, 502);
      }

      if (env.DB) {
        try {
          const now = new Date().toISOString();
          await env.DB.prepare(
            "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
          ).bind(conversationId, message.slice(0, 80), now, now).run();
          await env.DB.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(id(), conversationId, "user", message, now).run();
          await env.DB.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(id(), conversationId, "assistant", answer, now).run();
          await env.DB.prepare(
            "UPDATE conversations SET updated_at = ? WHERE id = ?"
          ).bind(now, conversationId).run();
        } catch (e) {
          return json({ error: "Ответ получен, но не удалось сохранить историю: " + e.message, answer, conversationId }, 500);
        }
      }

      return json({ answer, conversationId });
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      if (!env.DB) return json([]);
      const rows = await env.DB.prepare(
        "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50"
      ).all();
      return json(rows.results || []);
    }

    if (url.pathname === "/api/conversation" && request.method === "GET") {
      if (!env.DB) return json([]);
      const conversationId = url.searchParams.get("id");
      if (!conversationId) return json({ error: "Не указан id." }, 400);
      const rows = await env.DB.prepare(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
      ).bind(conversationId).all();
      return json(rows.results || []);
    }

    return env.ASSETS.fetch(request);
  }
};