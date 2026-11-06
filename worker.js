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
        model: env.GEMINI_MODEL || "gemini-3.8-flash",
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        databaseConfigured: Boolean(env.DB)
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "Не задан секрет GEMINI_API_KEY в настройках Worker." }, 503);
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
            role: row.role === "assistant" ? "model" : "user",
            parts: [{ text: row.content }]
          }));
        } catch (e) {
          return json({ error: "Ошибка базы данных: " + e.message }, 500);
        }
      }

      const contents = [...history, { role: "user", parts: [{ text: message }] }];
      const model = env.GEMINI_MODEL || "gemini-3.8-flash";

      let upstream;
      try {
        upstream = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" +
            encodeURIComponent(model) + ":generateContent?key=" +
            encodeURIComponent(env.GEMINI_API_KEY),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents,
              generationConfig: { maxOutputTokens: 4096 }
            })
          }
        );
      } catch (e) {
        return json({ error: "Не удалось связаться с Gemini: " + e.message }, 502);
      }

      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        return json({
          error: result.error?.message || "Ошибка Gemini API.",
          upstreamStatus: upstream.status
        }, upstream.status === 429 ? 429 : 502);
      }

      const answer = (result.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "").join("").trim();

      if (!answer) return json({ error: "Gemini не вернула текстовый ответ." }, 502);

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