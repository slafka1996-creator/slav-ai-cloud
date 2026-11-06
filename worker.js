const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const id = () => crypto.randomUUID();

async function ensureDatabase(env) {
  if (!env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)"
  ).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS github_staged_files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      expected_sha TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (env.DB && url.pathname !== "/health") {
      try {
        await ensureDatabase(env);
      } catch (e) {
        return json({ error: "Не удалось подготовить базу данных: " + e.message }, 500);
      }
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        app: "SLAV AI",
        model: env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
        provider: env.OPENROUTER_API_KEY ? "OpenRouter" : "Gemini",
        openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        geminiFallbackModel: "gemini-3.8-flash",
        databaseConfigured: Boolean(env.DB),
        githubConfigured: Boolean(env.GITHUB_TOKEN),
        githubWriteProtectionConfigured: Boolean(env.SLAV_ADMIN_KEY),
        githubRepository: env.GITHUB_REPO || "slafka1996-creator/steadycity-releases"
      });
    }

    // Protected GitHub write workflow: stage -> review -> explicit commit.
    if (url.pathname.startsWith("/api/github/write/")) {
      if (!env.GITHUB_TOKEN) return json({ error: "GitHub не подключён." }, 503);
      if (!env.SLAV_ADMIN_KEY) return json({ error: "Добавь секрет SLAV_ADMIN_KEY в Cloudflare." }, 503);
      const suppliedKey = request.headers.get("x-slav-admin-key") || "";
      if (suppliedKey.length !== env.SLAV_ADMIN_KEY.length || suppliedKey !== env.SLAV_ADMIN_KEY) {
        return json({ error: "Нет доступа." }, 401);
      }
      if (!env.DB) return json({ error: "Для очереди изменений нужна база D1." }, 503);

      const repo = env.GITHUB_REPO || "slafka1996-creator/steadycity-releases";
      const ghHeaders = {
        "authorization": "Bearer " + env.GITHUB_TOKEN,
        "user-agent": "SLAV-AI-Cloud/1.0",
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json"
      };
      const gh = async (path, options = {}) => {
        const response = await fetch("https://api.github.com/repos/" + repo + path, {
          ...options, headers: { ...ghHeaders, ...(options.headers || {}) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("GitHub " + response.status + ": " + (data.message || "API error"));
        return data;
      };
      try {
        if (url.pathname === "/api/github/write/stage" && request.method === "POST") {
          const body = await request.json().catch(() => null);
          if (!body) return json({ error: "Некорректный JSON." }, 400);
          const path = String(body.path || "").replace(/^\\/+/, "");
          const fileContent = body.content;
          if (!path || path.length > 240 || path.split("/").some(part => !part || part === "." || part === "..") ||
              path.startsWith(".github/workflows/") || path.startsWith("pkg/") ||
              !/^(gorodok|src|tools|microcity-deploy)\\//.test(path)) {
            return json({ error: "Путь запрещён. Разрешены только файлы внутри gorodok/, src/, tools/ и microcity-deploy/; pkg/ и workflows защищены." }, 400);
          }
          if (typeof fileContent !== "string" || fileContent.length > 500000) {
            return json({ error: "Содержимое файла должно быть текстом до 500 КБ." }, 400);
          }
          const current = await gh("/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=main");
          if (body.expectedSha && body.expectedSha !== current.sha) {
            return json({ error: "Файл изменился после чтения. Перечитай его перед подготовкой изменений.", currentSha: current.sha }, 409);
          }
          const stagedId = id();
          const now = new Date().toISOString();
          await env.DB.prepare(
            "INSERT INTO github_staged_files (id, path, content, expected_sha, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET id=excluded.id, content=excluded.content, expected_sha=excluded.expected_sha, created_at=excluded.created_at"
          ).bind(stagedId, path, fileContent, current.sha, now).run();
          return json({ staged: true, stagedId, path, previousSha: current.sha, characters: fileContent.length, requiresReviewAndCommit: true });
        }

        if (url.pathname === "/api/github/write/staged" && request.method === "GET") {
          const rows = await env.DB.prepare(
            "SELECT id, path, expected_sha, created_at, length(content) AS characters FROM github_staged_files ORDER BY created_at ASC"
          ).all();
          return json({ staged: rows.results || [] });
        }

        if (url.pathname === "/api/github/write/discard" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.id) await env.DB.prepare("DELETE FROM github_staged_files WHERE id = ?").bind(String(body.id)).run();
          else if (body.path) await env.DB.prepare("DELETE FROM github_staged_files WHERE path = ?").bind(String(body.path)).run();
          else return json({ error: "Укажи id или path." }, 400);
          return json({ discarded: true });
        }

        if (url.pathname === "/api/github/write/commit" && request.method === "POST") {
          const body = await request.json().catch(() => null);
          if (!body || body.confirm !== true) return json({ error: "Для записи передай confirm: true после просмотра списка staged." }, 400);
          const rows = await env.DB.prepare(
            "SELECT id, path, content, expected_sha FROM github_staged_files ORDER BY created_at ASC"
          ).all();
          const files = rows.results || [];
          if (!files.length) return json({ error: "Нет подготовленных изменений." }, 400);

          const ref = await gh("/git/ref/heads/main");
          const head = await gh("/git/commits/" + ref.object.sha);
          const baseTree = head.tree.sha;
          const tree = [];
          for (const file of files) {
            const current = await gh("/contents/" + file.path.split("/").map(encodeURIComponent).join("/") + "?ref=main");
            if (current.sha !== file.expected_sha) {
              return json({ error: "Конфликт: файл " + file.path + " изменился в GitHub. Изменения не опубликованы.", conflictPath: file.path }, 409);
            }
            const blob = await gh("/git/blobs", {
              method: "POST",
              body: JSON.stringify({ content: file.content, encoding: "utf-8" })
            });
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
          }
          const newTree = await gh("/git/trees", {
            method: "POST",
            body: JSON.stringify({ base_tree: baseTree, tree })
          });
          const commit = await gh("/git/commits", {
            method: "POST",
            body: JSON.stringify({
              message: String(body.message || "Update files via SLAV AI").slice(0, 200),
              tree: newTree.sha,
              parents: [ref.object.sha]
            })
          });
          await gh("/git/refs/heads/main", {
            method: "PATCH",
            body: JSON.stringify({ sha: commit.sha, force: false })
          });
          await env.DB.prepare("DELETE FROM github_staged_files").run();
          return json({ committed: true, commit: commit.sha, files: files.map(file => file.path), branch: "main" });
        }
        return json({ error: "Неизвестный endpoint или метод." }, 404);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // Read-only GitHub bridge for the coding agent.
    if (url.pathname.startsWith("/api/github/")) {
      if (!env.GITHUB_TOKEN) {
        return json({ error: "GitHub ещё не подключён. Добавь секрет GITHUB_TOKEN в Cloudflare." }, 503);
      }
      const repo = env.GITHUB_REPO || "slafka1996-creator/steadycity-releases";
      const headers = {
        "authorization": "Bearer " + env.GITHUB_TOKEN,
        "user-agent": "SLAV-AI-Cloud/1.0",
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      };
      try {
        if (url.pathname === "/api/github/status") {
          const response = await fetch("https://api.github.com/repos/" + repo, { headers });
          const raw = await response.text();
          let data = {};
          try { data = JSON.parse(raw); } catch {}
          if (!response.ok) return json({
            connected: false,
            error: data.message || raw.slice(0, 500) || "GitHub API вернул пустой ответ.",
            githubStatus: response.status,
            repositoryChecked: repo,
            requestId: response.headers.get("x-github-request-id"),
            rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
            rateLimitReset: response.headers.get("x-ratelimit-reset"),
            hint: response.status === 401 ? "Токен недействителен или истёк." : response.status === 403 ? "Смотри error и rateLimitRemaining: это может быть запрет токена, лимит API или политика доступа." : response.status === 404 ? "Репозиторий не найден для этого токена. Проверь Repository access и имя репозитория." : "Проверь токен и доступ к репозиторию."
          }, response.status);
          return json({ connected: true, repository: data.full_name, defaultBranch: data.default_branch, private: data.private });
        }
        if (url.pathname === "/api/github/tree") {
          const branch = url.searchParams.get("ref") || "main";
          const path = url.searchParams.get("path") || "";
          const response = await fetch("https://api.github.com/repos/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), { headers });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) return json({ error: data.message || "Не удалось получить список файлов" }, response.status);
          const items = Array.isArray(data) ? data.map(item => ({ name: item.name, path: item.path, type: item.type, size: item.size })) : [{ name: data.name, path: data.path, type: data.type, size: data.size }];
          return json({ repository: repo, branch, path, items });
        }
        if (url.pathname === "/api/github/file") {
          const path = url.searchParams.get("path");
          const branch = url.searchParams.get("ref") || "main";
          if (!path) return json({ error: "Укажи path файла." }, 400);
          const response = await fetch("https://api.github.com/repos/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), { headers });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) return json({ error: data.message || "Не удалось прочитать файл" }, response.status);
          if (data.type !== "file" || !data.content) return json({ error: "Это не текстовый файл или GitHub не вернул его содержимое." }, 400);
          const binary = Uint8Array.from(atob(data.content.replace(/\\s/g, "")), c => c.charCodeAt(0));
          const decoded = new TextDecoder().decode(binary);
          return json({ repository: repo, branch, path: data.path, sha: data.sha, content: decoded });
        }
        return json({ error: "Неизвестный GitHub endpoint." }, 404);
      } catch (e) {
        return json({ error: "GitHub connection error: " + e.message }, 502);
      }
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
        const model = env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
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
        const model = "gemini-3.8-flash";
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