const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const id = () => crypto.randomUUID();

let ciStatusCache = { value: null, expiresAt: 0 };

async function verifyCloudflareAccess(request, env) {
  const required = env.AUTH_REQUIRED === "true";
  const team = String(env.CF_ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
  const audience = String(env.CF_ACCESS_AUD || "");
  if (!team || !audience) return { ok: true, user: "public", configured: false };
  const token = request.headers.get("CF-Access-Jwt-Assertion");
  if (!token) return { ok: true, user: "public", configured: Boolean(team && audience) };
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const decode = part => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    const header = decode(parts[0]), claims = decode(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported signature");
    const issuer = team.startsWith("https://") ? team : "https://" + team;
    if (claims.iss !== issuer) throw new Error("issuer mismatch");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error("audience mismatch");
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now || (claims.nbf && claims.nbf > now + 60)) throw new Error("token time invalid");
    const response = await fetch(issuer + "/cdn-cgi/access/certs");
    if (!response.ok) throw new Error("keys unavailable");
    const certs = await response.json();
    const jwk = (certs.keys || []).find(key => key.kid === header.kid);
    if (!jwk) throw new Error("key not found");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[2].length / 4) * 4, "=")), ch => ch.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!valid) throw new Error("bad signature");
    return { ok: true, user: String(claims.email || claims.sub || "access-user"), configured: true };
  } catch {
    return { ok: false, status: 401, error: "Недействительный токен Cloudflare Access." };
  }
}

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
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_requests (
      id TEXT PRIMARY KEY,
      ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_agent_requests_ip_created ON agent_requests(ip_hash, created_at)").run();
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


async function telegramApi(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || ("Telegram API HTTP " + response.status));
  return data.result;
}

async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Telegram bot is not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Forbidden" }, 403);
  const update = await request.json().catch(() => null);
  if (!update) return json({ error: "Invalid update" }, 400);
  const message = update.message;
  if (!message?.from || !message?.chat || message.chat.type !== "private" || typeof message.text !== "string") return json({ ok: true });
  const chatId = String(message.chat.id), userId = String(message.from.id);
  const text = message.text.trim().slice(0, 12000);
  if (!text) return json({ ok: true });
  const send = async value => {
    const chunks = String(value || "").match(/[\s\S]{1,3900}/g) || ["Пустой ответ."];
    for (const chunk of chunks) await telegramApi(env, "sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  };
  try {
    if (text === "/start" || text.startsWith("/start ")) {
      await send("Привет! Я SLAV AI — твой ИИ-помощник.\\n\\nМогу помогать с программированием, анализом, текстами, идеями и документами. Просто напиши сообщение.\\n\\nКоманды:\\n/new — новый диалог\\n/mode — выбрать режим\\n/help — помощь\\n\\nИстория диалогов хранится отдельно для твоего Telegram-аккаунта.");
      return json({ ok: true });
    }
    if (text === "/help") {
      await send("Напиши вопрос обычным сообщением. Для нового диалога используй /new. Режимы: /mode chat, /mode think, /mode code, /mode research. Пока бот принимает текстовые сообщения; загрузку документов и изображений добавим следующим этапом.");
      return json({ ok: true });
    }
    if (!env.DB) { await send("База данных пока не подключена. Добавь D1 binding DB, чтобы бот мог хранить отдельную историю каждого пользователя."); return json({ ok: true }); }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_sessions (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', updated_at TEXT NOT NULL, PRIMARY KEY(chat_id,user_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_history ON telegram_messages(chat_id,user_id,created_at)").run();
    let session = await env.DB.prepare("SELECT conversation_id,mode FROM telegram_sessions WHERE chat_id=? AND user_id=?").bind(chatId,userId).first();
    if (text === "/new") {
      const next = id(), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO telegram_sessions (chat_id,user_id,conversation_id,mode,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET conversation_id=excluded.conversation_id,updated_at=excluded.updated_at").bind(chatId,userId,next,session?.mode||"chat",now).run();
      await send("Начали новый диалог. Контекст предыдущего диалога сохранён отдельно.");
      return json({ ok: true });
    }
    if (text === "/mode" || text.startsWith("/mode ")) {
      const modes = { chat: "Обычный чат", think: "Глубокий анализ", code: "Программирование", research: "Исследование" };
      const requested = text.split(/\s+/)[1];
      if (!requested) { await send("Выбери режим командой:\\n/mode chat\\n/mode think\\n/mode code\\n/mode research"); return json({ ok: true }); }
      if (!modes[requested]) { await send("Неизвестный режим. Доступно: chat, think, code, research."); return json({ ok: true }); }
      const now = new Date().toISOString(), conv = session?.conversation_id || id();
      await env.DB.prepare("INSERT INTO telegram_sessions (chat_id,user_id,conversation_id,mode,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at").bind(chatId,userId,conv,requested,now).run();
      await send("Режим изменён: " + modes[requested]);
      return json({ ok: true });
    }
    if (text.startsWith("/")) { await send("Неизвестная команда. Напиши /help."); return json({ ok: true }); }
    const now = new Date().toISOString(), conversationId = session?.conversation_id || id(), mode = session?.mode || "chat";
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM telegram_messages WHERE chat_id=? AND user_id=? AND created_at>=?").bind(chatId,userId,new Date(Date.now()-60000).toISOString()).first();
    if ((recent?.n || 0) >= 12) { await send("Слишком много запросов подряд. Подожди минуту и попробуй снова."); return json({ ok: true }); }
    await env.DB.prepare("INSERT INTO telegram_sessions (chat_id,user_id,conversation_id,mode,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET updated_at=excluded.updated_at").bind(chatId,userId,conversationId,mode,now).run();
    const rows = await env.DB.prepare("SELECT role,content FROM telegram_messages WHERE chat_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20").bind(chatId,userId).all();
    const history = (rows.results || []).reverse().map(row => ({ role: row.role, content: row.content }));
    const modePrompt = {
      chat: "Отвечай естественно, понятно и по делу.",
      think: "Внимательно анализируй задачу, проверяй предположения, объясняй выводы и неопределённость.",
      code: "Ты опытный программист. Предлагай рабочие решения и полный код, объясняй запуск и проверку. Не утверждай, что запускал код, если этого не делал.",
      research: "Проводя исследование, отделяй проверенные факты от предположений. Не выдумывай источники и ссылки."
    };
    const system = "Ты SLAV AI — сильный русскоязычный универсальный ИИ-помощник. " + modePrompt[mode] + " Отвечай на русском, если не попросили другой язык. Будь точным, полезным и подробным настолько, насколько требует задача. Не выдумывай доступ к инструментам. Форматируй ответ простым Markdown.";
    await telegramApi(env,"sendChatAction",{chat_id:chatId,action:"typing"});
    let answer = "", providerError = "";
    const model = env.TELEGRAM_MODEL || env.SLAV_CHAT_MODEL || env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
    if (env.OPENROUTER_API_KEY) {
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions",{
        method:"POST",headers:{"authorization":"Bearer "+env.OPENROUTER_API_KEY,"content-type":"application/json","HTTP-Referer":"https://slav-ai-cloud.slafka1996.workers.dev","X-Title":"SLAV AI Telegram"},
        body:JSON.stringify({model,messages:[{role:"system",content:system},...history,{role:"user",content:text}],max_tokens:8192})
      });
      const data = await upstream.json().catch(()=>({}));
      if (upstream.ok) answer = String(data.choices?.[0]?.message?.content || "").trim();
      else providerError = data.error?.message || ("OpenRouter HTTP "+upstream.status);
    }
    if (!answer && env.GEMINI_API_KEY) {
      const geminiModel = env.GEMINI_CHAT_MODEL || "gemini-3.8-flash";
      const geminiHistory = history.map(row=>({role:row.role==="assistant"?"model":"user",parts:[{text:row.content}]}));
      const fallback = await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(geminiModel)+":generateContent?key="+encodeURIComponent(env.GEMINI_API_KEY),{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[...geminiHistory,{role:"user",parts:[{text}]}],generationConfig:{maxOutputTokens:8192}})
      });
      const data = await fallback.json().catch(()=>({}));
      if (fallback.ok) answer = (data.candidates?.[0]?.content?.parts||[]).map(part=>part.text||"").join("").trim();
      else providerError = data.error?.message || ("Gemini HTTP "+fallback.status);
    }
    if (!answer) throw new Error(providerError || "Модель не вернула ответ.");
    const savedAt = new Date().toISOString();
    await env.DB.prepare("INSERT INTO telegram_messages (id,chat_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)").bind(id(),chatId,userId,"user",text,savedAt).run();
    await env.DB.prepare("INSERT INTO telegram_messages (id,chat_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)").bind(id(),chatId,userId,"assistant",answer,savedAt).run();
    await env.DB.prepare("DELETE FROM telegram_messages WHERE chat_id=? AND user_id=? AND id NOT IN (SELECT id FROM telegram_messages WHERE chat_id=? AND user_id=? ORDER BY created_at DESC LIMIT 40)").bind(chatId,userId,chatId,userId).run();
    await send(answer);
  } catch (error) {
    try { await send("Не удалось обработать запрос: " + (error.message || "ошибка сервера")); } catch {}
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === "/telegram/status" && request.method === "GET") {
      return json({ configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET), webhookPath: "/telegram/webhook", databaseRequired: true });
    }


    if (url.pathname.startsWith("/api/")) {
      const access = await verifyCloudflareAccess(request, env);
      if (!access.ok) return json({ error: access.error }, access.status);
    }

    if (env.DB && url.pathname !== "/health" && url.pathname !== "/api/ci/status") {
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
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
        model: env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
        provider: env.OPENROUTER_API_KEY ? "OpenRouter" : "Gemini",
        openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        geminiFallbackModel: "gemini-3.8-flash",
        databaseConfigured: Boolean(env.DB),
        githubConfigured: Boolean(env.GITHUB_TOKEN),
        sandboxConfigured: Boolean(env.SANDBOX_API_URL && env.SANDBOX_API_KEY),
        githubWriteProtectionConfigured: Boolean(env.SLAV_ADMIN_KEY),
        githubRepository: env.GITHUB_REPO || "slafka1996-creator/steadycity-releases",
        accessAuthRequired: env.AUTH_REQUIRED === "true",
        accessAuthConfigured: Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD)
      });
    }


    if (url.pathname === "/api/ci/status" && request.method === "GET") {
      try {
        // Use the server-side GitHub token so every visitor does not consume the shared unauthenticated IP quota.
        // Cache successful results briefly to reduce Actions API calls from frequent page refreshes.
        if (ciStatusCache.value && ciStatusCache.expiresAt > Date.now()) {
          return json({ ...ciStatusCache.value, cached: true });
        }
        const headers = {
          accept: "application/vnd.github+json",
          "user-agent": "SLAV-AI-Cloud/1.0",
          ...(env.GITHUB_TOKEN ? { authorization: "Bearer " + env.GITHUB_TOKEN } : {})
        };
        const base = "https://api.github.com/repos/slafka1996-creator/slav-ai-cloud/actions";
        const rr = await fetch(base + "/runs?per_page=5", { headers });
        const rd = await rr.json().catch(() => ({}));
        if (!rr.ok) {
          if (ciStatusCache.value) return json({ ...ciStatusCache.value, cached: true, stale: true });
          const message = rr.status === 403 && /resource not accessible|permissions/i.test(rd.message || "")
            ? "GitHub-токену SLAV AI требуется разрешение Actions: Read."
            : rd.message || "Не удалось получить CI.";
          return json({ error: message }, rr.status === 403 ? 503 : 502);
        }
        const run = (rd.workflow_runs || []).find(x => x.name === "Browser smoke tests");
        if (!run) return json({ configured: true, found: false, message: "Запуски тестов не найдены." });
        const jr = await fetch(base + "/runs/" + run.id + "/jobs", { headers });
        const jd = await jr.json().catch(() => ({}));
        const jobs = (jd.jobs || []).map(x => ({
          name: x.name, status: x.status, conclusion: x.conclusion,
          failedSteps: (x.steps || []).filter(s => s.conclusion === "failure").map(s => s.name)
        }));
        const payload = { configured: true, found: true, run: {
          id: run.id, number: run.run_number, status: run.status, conclusion: run.conclusion,
          sha: run.head_sha, title: run.display_title, url: run.html_url, updatedAt: run.updated_at
        }, jobs };
        ciStatusCache = { value: payload, expiresAt: Date.now() + 60000 };
        return json(payload);
      } catch (e) { return json({ error: "CI status error: " + e.message }, 502); }
    }


    // Persistent project workspace.
    if (url.pathname === "/api/projects" && request.method === "GET") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const rows = await env.DB.prepare("SELECT id,name,description,instructions,created_at,updated_at FROM projects ORDER BY updated_at DESC LIMIT 100").all();
      return json({ projects: rows.results || [] });
    }
    if (url.pathname === "/api/projects" && request.method === "POST") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0,100);
      if (!name) return json({ error: "Укажи название проекта." }, 400);
      const projectId = id(), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO projects (id,name,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(projectId,name,String(body.description||"").slice(0,1000),String(body.instructions||"").slice(0,8000),now,now).run();
      return json({ project: { id:projectId,name,description:String(body.description||""),instructions:String(body.instructions||""),created_at:now,updated_at:now } }, 201);
    }
    if (url.pathname.startsWith("/api/projects/") && request.method === "PUT") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0,100);
      if (!name) return json({ error: "Название проекта обязательно." }, 400);
      const now = new Date().toISOString();
      const result = await env.DB.prepare("UPDATE projects SET name=?,description=?,instructions=?,updated_at=? WHERE id=?")
        .bind(name,String(body.description||"").slice(0,1000),String(body.instructions||"").slice(0,8000),now,projectId).run();
      if (!result.meta?.changes) return json({ error: "Проект не найден." }, 404);
      return json({ ok:true });
    }
    if (url.pathname.startsWith("/api/projects/") && request.method === "DELETE") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(projectId).run();
      return json({ ok:true });
    }

    // Generate a self-contained HTML artifact with the configured model.
    if (url.pathname === "/api/artifact" && request.method === "POST") {
      if (!env.OPENROUTER_API_KEY && !env.GEMINI_API_KEY) return json({ error:"AI-провайдер не подключён." },503);
      const body = await request.json().catch(() => ({}));
      const prompt = String(body.prompt || "").trim().slice(0,6000);
      if (!prompt) return json({ error:"Опиши, что нужно создать." },400);
      const system = "Ты создаёшь готовые интерактивные веб-артефакты для SLAV AI. Верни ТОЛЬКО полный самодостаточный HTML-документ с CSS и JavaScript внутри. Без Markdown-ограждений, пояснений и внешних зависимостей. Интерфейс адаптивный, аккуратный, доступный. Не используй сетевые запросы, кроме явно необходимых пользователю.";
      let html = "", error = "";
      if (env.OPENROUTER_API_KEY) {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"authorization":"Bearer "+env.OPENROUTER_API_KEY,"content-type":"application/json","HTTP-Referer":"https://slav-ai-cloud.slafka1996.workers.dev","X-Title":"SLAV AI Artifacts"},body:JSON.stringify({model:env.OPENROUTER_MODEL||"nvidia/nemotron-3-ultra-550b-a55b:free",messages:[{role:"system",content:system},{role:"user",content:prompt}],max_tokens:7000})});
        const d=await r.json().catch(()=>({}));
        if(r.ok) html=String(d.choices?.[0]?.message?.content||"").trim(); else error=d.error?.message||("OpenRouter HTTP "+r.status);
      }
      if (!html && env.GEMINI_API_KEY) {
        const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key="+encodeURIComponent(env.GEMINI_API_KEY),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:7000}})});
        const d=await r.json().catch(()=>({}));
        if(r.ok) html=(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").trim(); else error=d.error?.message||("Gemini HTTP "+r.status);
      }
      html=html.replace(/^```(?:html)?\s*/i,"").replace(/\s*```$/,"").trim();
      if (!html || !/<html[\s>]/i.test(html)) return json({error:error||"Модель не вернула корректный HTML-артефакт."},502);
      return json({html,model:env.OPENROUTER_MODEL||"gemini-3.8-flash"});
    }

    // Autonomous coding agent: inspect repository, read files, and stage edits.
    if (url.pathname === "/api/agent" && request.method === "POST") {
      if (!env.OPENROUTER_API_KEY) return json({error:"OpenRouter API key is not configured."},503);
      if (!env.GITHUB_TOKEN) return json({error:"GitHub is not connected."},503);
      if(!env.DB) return json({error:"D1 is required."},503);
      // Anonymous agent access is rate-limited to protect free model quota.
      const ip=request.headers.get("CF-Connecting-IP")||"unknown";
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ip+"|"+(env.SLAV_ADMIN_KEY||"slav-agent-rate-limit")));
      const ipHash=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
      const since=new Date(Date.now()-60*60*1000).toISOString();
      const usage=await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE ip_hash=? AND created_at>?").bind(ipHash,since).first();
      if((usage?.n||0)>=3) return json({error:"Лимит бесплатного агента: 3 запуска в час с одного IP. Попробуй позже."},429);
      await env.DB.prepare("INSERT INTO agent_requests (id,ip_hash,created_at) VALUES (?,?,?)").bind(id(),ipHash,new Date().toISOString()).run();
      const input=await request.json().catch(()=>null);
      const task=String(input?.task||"").trim().slice(0,8000);
      if(!task) return json({error:"Опиши задачу."},400);
      const repo=env.GITHUB_REPO||"slafka1996-creator/steadycity-releases";
      const ghHeaders={"authorization":"Bearer "+env.GITHUB_TOKEN,"user-agent":"SLAV-AI-Cloud/1.0","accept":"application/vnd.github+json","x-github-api-version":"2022-11-28"};
      const gh=async(path)=>{
        const r=await fetch("https://api.github.com/repos/"+repo+path,{headers:ghHeaders});
        const d=await r.json().catch(()=>({}));
        if(!r.ok) throw new Error("GitHub "+r.status+": "+(d.message||"API error"));
        return d;
      };
      const sandboxEnabled=Boolean(env.SANDBOX_API_URL && env.SANDBOX_API_KEY);
      const sandboxBase=String(env.SANDBOX_API_URL||"").replace(/\/$/,"");
      const sandboxHeaders={"authorization":"Bearer "+(env.SANDBOX_API_KEY||""),"content-type":"application/json"};
      let sandboxId=null;
      const sandboxCall=async(path,options={})=>{
        const response=await fetch(sandboxBase+path,{...options,headers:{...sandboxHeaders,...(options.headers||{})}});
        if(!response.ok){const detail=await response.text().catch(()=>"");throw new Error("Sandbox HTTP "+response.status+": "+detail.slice(0,500));}
        return response;
      };
      const runSandbox=async(command,timeout=60000,cwd="/workspace/repo")=>{
        if(!sandboxId) throw new Error("Sandbox не создан.");
        const response=await sandboxCall("/v1/sandbox/"+encodeURIComponent(sandboxId)+"/exec",{method:"POST",body:JSON.stringify({argv:["sh","-lc",command],timeout_ms:Math.min(120000,Math.max(1000,timeout)),cwd})});
        const raw=await response.text();let stdout="",stderr="",exitCode=null,error=null;
        for(const block of raw.split(/\r?\n\r?\n/)){let event="message",data="";for(const line of block.split(/\r?\n/)){if(line.startsWith("event:"))event=line.slice(6).trim();else if(line.startsWith("data:"))data+=line.slice(5).trim();}if(!data)continue;if(event==="stdout"||event==="stderr"){let decoded="";try{decoded=new TextDecoder().decode(Uint8Array.from(atob(data),ch=>ch.charCodeAt(0)));}catch{}if(event==="stdout")stdout+=decoded;else stderr+=decoded;}else if(event==="exit"){try{exitCode=JSON.parse(data).exit_code;}catch{}}else if(event==="error"){try{error=JSON.parse(data).error;}catch{error=data;}}}
        return {stdout:stdout.slice(-14000),stderr:stderr.slice(-6000),exitCode,error};
      };
      if(sandboxEnabled){
        try{
          const created=await sandboxCall("/v1/sandbox",{method:"POST",body:"{}"});
          sandboxId=String((await created.json()).id||"");
          if(!sandboxId) throw new Error("Sandbox API не вернул id.");
          const archiveResponse=await fetch("https://api.github.com/repos/"+repo+"/tarball/main",{headers:ghHeaders});
          if(!archiveResponse.ok) throw new Error("GitHub archive HTTP "+archiveResponse.status);
          const archiveSize=Number(archiveResponse.headers.get("content-length")||0);
          if(archiveSize>32*1024*1024) throw new Error("Архив репозитория превышает лимит Sandbox 32 МБ.");
          const archive=await archiveResponse.arrayBuffer();
          if(archive.byteLength>32*1024*1024) throw new Error("Архив репозитория превышает лимит Sandbox 32 МБ.");
          // GitHub tarball API returns gzip-compressed tar; Sandbox hydrate expects an uncompressed tar stream.
          const tar=await new Response(new Blob([archive]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
          if(tar.byteLength>32*1024*1024) throw new Error("Распакованный архив превышает лимит Sandbox 32 МБ.");
          await sandboxCall("/v1/sandbox/"+encodeURIComponent(sandboxId)+"/hydrate",{method:"POST",headers:{"content-type":"application/x-tar"},body:tar});
          const seed=await runSandbox("set -e; root=$(find /workspace -mindepth 1 -maxdepth 1 -type d | head -n 1); test -n \\"$root\\"; mkdir -p /workspace/repo; cp -a \\"$root\\"/. /workspace/repo/; cd /workspace/repo; git init -q; git add -A; git -c user.name='SLAV AI Sandbox' -c user.email='sandbox@slav-ai.invalid' commit -qm 'Sandbox baseline'; printf 'Sandbox workspace ready: '; pwd; git rev-parse --short HEAD",90000,"/workspace");
          if(seed.exitCode!==0) throw new Error(seed.stderr||seed.error||"Не удалось подготовить файлы репозитория в Sandbox.");
        }catch(e){if(sandboxId) await fetch(sandboxBase+"/v1/sandbox/"+encodeURIComponent(sandboxId),{method:"DELETE",headers:sandboxHeaders}).catch(()=>{});return json({error:"Не удалось подготовить Sandbox: "+e.message},503);}
      }
      const tools=[
        ...(sandboxEnabled?[{type:"function",function:{name:"sandbox_exec",description:"Выполни команду Linux в изолированном Cloudflare Sandbox в /workspace/repo. Репозиторий уже клонирован. Используй для чтения и изменения файлов, установки зависимостей и запуска тестов. Команда максимум 8000 символов; timeout_ms до 120000. Возвращает stdout/stderr/exitCode. Не пытайся читать секреты или данные вне рабочей папки.",parameters:{type:"object",properties:{command:{type:"string"},timeout_ms:{type:"integer"}},required:["command"],additionalProperties:false}}}]:[]),
        {type:"function",function:{name:"list_files",description:"List files and folders in a repository directory. Use path empty for root.",parameters:{type:"object",properties:{path:{type:"string",description:"Directory path, empty for root"}} ,required:["path"],additionalProperties:false}}},
        {type:"function",function:{name:"search_code",description:"Search source code in the connected GitHub repository by exact symbol, phrase or keyword. Use this before guessing where a feature is implemented.",parameters:{type:"object",properties:{query:{type:"string",description:"Search phrase or code symbol"}},required:["query"],additionalProperties:false}}},
        {type:"function",function:{name:"read_file",description:"Read a text file from the repository main branch.",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}},
        {type:"function",function:{name:"get_file_history",description:"Get recent commits that changed a specific repository file.",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}},
        {type:"function",function:{name:"stage_file",description:"Stage a complete replacement for an existing text file. Does not publish or commit it. Only allowed project folders.",parameters:{type:"object",properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"],additionalProperties:false}}}
      ];
      const messages=[
        {role:"system",content:"Ты SLAV AI Developer Agent, работаешь с репозиторием "+repo+". Если доступен sandbox_exec, используй изолированный Linux Sandbox: репозиторий уже клонирован в /workspace/repo. Изучи AGENTS.md и README.md, используй sandbox_exec для поиска, изменения файлов, установки зависимостей и запуска тестов. После изменений выполни тесты и git diff --check. Затем прочитай изменённые файлы и передай полное содержимое каждого изменённого файла через stage_file для GitHub review. Sandbox не имеет GitHub credentials; публикация только через защищённый workflow. Если Sandbox не подключён, используй только GitHub-инструменты чтения и stage_file. Самостоятельно исследуй задачу: сначала изучи AGENTS.md и README.md, затем найди релевантные файлы через search_code и list_files, изучи историю изменений через get_file_history при необходимости, прочитай релевантные файлы и внеси необходимые исправления. Пользуйся инструментами, не выдумывай содержимое файлов. Для stage_file передавай ПОЛНОЕ итоговое содержимое файла. Разрешённые пути только внутри gorodok/, src/, tools/, microcity-deploy/. Не меняй pkg/, .github/workflows/, секреты и конфигурацию деплоя. Не публикуй коммиты. В конце перечисли изученные файлы, подготовленные изменения и то, что ещё не удалось проверить. Если задача неоднозначна — задай уточняющий вопрос, не меняй файлы."},
        {role:"user",content:task}
      ];
      const model=env.OPENROUTER_MODEL||"nvidia/nemotron-3-ultra-550b-a55b:free";
      const staged=[];
      try{
        for(let turn=0;turn<12;turn++){
          const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
            method:"POST",headers:{"authorization":"Bearer "+env.OPENROUTER_API_KEY,"content-type":"application/json","HTTP-Referer":"https://slav-ai-cloud.slafka1996.workers.dev","X-Title":"SLAV AI Studio"},
            body:JSON.stringify({model,messages,tools,tool_choice:"auto",max_tokens:5000})
          });
          const data=await response.json().catch(()=>({}));
          if(!response.ok) throw new Error(data.error?.message||("OpenRouter HTTP "+response.status));
          const msg=data.choices?.[0]?.message;
          if(!msg) throw new Error("Модель не вернула ответ.");
          messages.push(msg);
          const calls=msg.tool_calls||[];
          if(!calls.length) {
            const stagedRows=[];
            for(const item of staged){
              const row=await env.DB.prepare("SELECT path,content FROM github_staged_files WHERE path=?").bind(item.path).first();
              if(row) stagedRows.push({path:row.path,content:row.content});
            }
            const bundle=stagedRows.map(x=>"FILE: "+x.path+"\\n"+x.content).join("\\n\\n").slice(0,18000);
            const review=async(role,instruction)=>{
              if(!bundle) return "Нет подготовленных файлов для проверки.";
              const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{
                method:"POST",headers:{"authorization":"Bearer "+env.OPENROUTER_API_KEY,"content-type":"application/json","HTTP-Referer":"https://slav-ai-cloud.slafka1996.workers.dev","X-Title":"SLAV AI Studio - "+role},
                body:JSON.stringify({model,messages:[{role:"system",content:instruction},{role:"user",content:"Задача пользователя: "+task+"\\n\\nПодготовленные изменения:\\n"+bundle}],max_tokens:1400})
              });
              const d=await r.json().catch(()=>({}));
              if(!r.ok) return "Проверка не выполнена: "+(d.error?.message||r.status);
              return d.choices?.[0]?.message?.content||"Нет ответа.";
            };
            const [designReview,testReview]=await Promise.all([
              review("UI Designer","Ты UI Designer в команде SLAV AI. Проверь подготовленные изменения с точки зрения интерфейса, UX, визуальной целостности, адаптивности и доступности. Не утверждай, что менял код. Дай краткий вердикт и конкретные замечания."),
              review("Browser Tester","Ты QA/Browser Tester команды SLAV AI. Проведи статический анализ подготовленных изменений: логические ошибки, риски регрессии, синтаксические подозрения, граничные случаи. Не заявляй, что реально запускал браузер или тесты. Укажи найденные проблемы и что нужно проверить запуском.")
            ]);
            return json({ok:true,answer:msg.content||"Developer завершил работу.",staged,model,team:{dispatcher:"Распределил задачу",developer:"Подготовил изменения",designer:designReview,tester:testReview}});
          }
          for(const call of calls){
            let args={};try{args=JSON.parse(call.function.arguments||"{}");}catch{}
            let result;
            const path=String(args.path||"").replace(/^\/+/, "");
            if(call.function.name==="sandbox_exec" && sandboxEnabled){
              const command=String(args.command||"").trim();
              if(!command||command.length>8000) throw new Error("Команда должна содержать 1–8000 символов.");
              const resultRun=await runSandbox(command,Number(args.timeout_ms)||60000);
              result={...resultRun,success:resultRun.exitCode===0&&!resultRun.error};
            } else if(call.function.name==="list_files"){
              if(path.split("/").some(x=>x===".."||x===".")) throw new Error("Недопустимый путь.");
              const d=await gh("/contents/"+path.split("/").filter(Boolean).map(encodeURIComponent).join("/")+"?ref=main");
              result=(Array.isArray(d)?d:[d]).map(x=>({name:x.name,path:x.path,type:x.type,size:x.size}));
            } else if(call.function.name==="search_code"){
              const query=String(args.query||"").trim().slice(0,160);
              if(!query) throw new Error("Укажи поисковый запрос.");
              const d=await gh("/search/code?q="+encodeURIComponent(query+" repo:"+repo)+"&per_page=12");
              result={total_count:d.total_count||0,items:(d.items||[]).map(x=>({path:x.path,name:x.name,html_url:x.html_url,repository:x.repository?.full_name}))};
            } else if(call.function.name==="get_file_history"){
              if(!path||path.split("/").some(x=>x===".."||x===".")) throw new Error("Недопустимый путь.");
              const d=await gh("/commits?path="+encodeURIComponent(path)+"&per_page=8");
              result=(Array.isArray(d)?d:[]).map(x=>({sha:x.sha,message:x.commit?.message,date:x.commit?.author?.date,url:x.html_url}));
            } else if(call.function.name==="read_file"){
              if(!path||path.split("/").some(x=>x===".."||x===".")) throw new Error("Недопустимый путь.");
              const d=await gh("/contents/"+path.split("/").map(encodeURIComponent).join("/")+"?ref=main");
              if(d.type!=="file"||!d.content) throw new Error("Это не текстовый файл.");
              result={path:d.path,sha:d.sha,content:new TextDecoder().decode(Uint8Array.from(atob(d.content.replace(/\s/g,"")),c=>c.charCodeAt(0)))};
            } else if(call.function.name==="stage_file"){
              const allowed=/^(gorodok|src|tools|microcity-deploy)\//.test(path);
              if(!allowed||path.split("/").some(x=>!x||x===".."||x===".")||path.startsWith("pkg/")||path.startsWith(".github/")) throw new Error("Запрещённый путь: "+path);
              if(typeof args.content!=="string"||args.content.length>500000) throw new Error("Содержимое должно быть текстом до 500 КБ.");
              const current=await gh("/contents/"+path.split("/").map(encodeURIComponent).join("/")+"?ref=main");
              const stagedId=id(),now=new Date().toISOString();
              await env.DB.prepare("INSERT INTO github_staged_files (id,path,content,expected_sha,created_at) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET id=excluded.id,content=excluded.content,expected_sha=excluded.expected_sha,created_at=excluded.created_at").bind(stagedId,path,args.content,current.sha,now).run();
              staged.push({path,characters:args.content.length});
              result={staged:true,path,characters:args.content.length,commitRequired:false};
            } else {result={error:"Unknown tool"};}
            messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
          }
        }
        return json({ok:true,answer:"Достигнут лимит шагов за один запуск. Черновики сохранены.",staged,model});
      }catch(e){return json({error:e.message,staged},502);}
      finally{if(sandboxId){await fetch(sandboxBase+"/v1/sandbox/"+encodeURIComponent(sandboxId),{method:"DELETE",headers:sandboxHeaders}).catch(()=>{});}}
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
          const path = String(body.path || "").replace(/^\/+/, "");
          const fileContent = body.content;
          if (!path || path.length > 240 || path.split("/").some(part => !part || part === "." || part === "..") ||
              path.startsWith(".github/workflows/") || path.startsWith("pkg/") ||
              !/^(gorodok|src|tools|microcity-deploy)\//.test(path)) {
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
      if (!env.OPENROUTER_API_KEY && !env.GEMINI_API_KEY) return json({ error: "Добавь API-ключ модели в настройках Worker." }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Некорректный JSON-запрос." }, 400); }
      const userText = String(body.message || "").trim().slice(0, 30000);
      const attachmentContext = String(body.attachmentContext || "").slice(0, 100000);
      const message = (userText + (attachmentContext ? "\n\n[Содержимое прикреплённых файлов]\n" + attachmentContext : "")).trim().slice(0, 130000);
      if (!message) return json({ error: "Напиши сообщение." }, 400);
      const conversationId = String(body.conversationId || id());
      const modePrompts = {
        chat: "Отвечай естественно, понятно и по делу.",
        think: "Внимательно анализируй задачу, проверяй предположения и давай обоснованный ответ.",
        code: "Ты опытный программист. Предлагай рабочий код, объясняй куда его вставить и предупреждай о рисках. Не утверждай, что запускал или проверял код, если этого не делал.",
        research: "Проводя анализ, отделяй подтверждённые факты от предположений. Не выдумывай источники и ссылки."
      };
      let projectContext = "";
      if (body.projectId && env.DB) {
        const project = await env.DB.prepare("SELECT name,description,instructions FROM projects WHERE id=?").bind(String(body.projectId)).first();
        if (project) projectContext = "\n\nКонтекст активного проекта: " + project.name + "\nОписание: " + project.description + "\nИнструкции: " + project.instructions;
      }
      const system = "Ты SLAV AI — русскоязычный универсальный AI-помощник. " +
        (modePrompts[body.mode] || modePrompts.chat) +
        " Отвечай на русском, если пользователь не попросил другой язык. " +
        "Используй Markdown: заголовки, списки, таблицы и fenced code blocks там, где это улучшает читаемость. " +
        "Не заявляй о доступе к браузеру, GitHub, файлам или компьютеру, если такого инструмента нет." + projectContext;
      let history = [];
      if (env.DB) {
        try {
          const rows = await env.DB.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 30").bind(conversationId).all();
          history = (rows.results || []).reverse().map(row => ({ role: row.role, content: row.content }));
        } catch (e) { return json({ error: "Ошибка базы данных: " + e.message }, 500); }
      }
      const model = env.SLAV_CHAT_MODEL || env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let answer = "";
          const emit = (event, data) => controller.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
          try {
            let streamed = false, providerError = "";
            if (env.OPENROUTER_API_KEY) {
              const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "authorization": "Bearer " + env.OPENROUTER_API_KEY, "content-type": "application/json", "HTTP-Referer": "https://slav-ai-cloud.slafka1996.workers.dev", "X-Title": "SLAV AI" },
                body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }], max_tokens: 8192, stream: true })
              });
              if (upstream.ok && upstream.body) {
                streamed = true;
                const reader = upstream.body.getReader(), decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n"); buffer = lines.pop() || "";
                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === "[DONE]") continue;
                    try {
                      const packet = JSON.parse(payload);
                      const delta = packet.choices?.[0]?.delta?.content;
                      if (typeof delta === "string" && delta) { answer += delta; emit("delta", { text: delta }); }
                      const reason = packet.choices?.[0]?.finish_reason;
                      if (reason === "error") throw new Error(packet.choices?.[0]?.error?.message || "Ошибка потока модели.");
                    } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
                  }
                }
              } else {
                const errorData = await upstream.json().catch(() => ({}));
                providerError = errorData.error?.message || ("OpenRouter HTTP " + upstream.status);
              }
            }
            if (!streamed && env.GEMINI_API_KEY) {
              const geminiModel = env.GEMINI_CHAT_MODEL || "gemini-3.8-flash";
              const geminiHistory = history.map(row => ({ role: row.role === "assistant" ? "model" : "user", parts: [{ text: row.content }] }));
              const fallback = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(geminiModel) + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [...geminiHistory, { role: "user", parts: [{ text: message }] }], generationConfig: { maxOutputTokens: 8192 } })
              });
              const data = await fallback.json().catch(() => ({}));
              if (fallback.ok) {
                answer = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("").trim();
                if (answer) emit("delta", { text: answer });
              } else providerError = data.error?.message || ("Gemini HTTP " + fallback.status);
            }
            if (!answer.trim()) throw new Error(providerError || "Модель не вернула ответ.");
            if (env.DB) {
              const now = new Date().toISOString();
              await env.DB.prepare("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(conversationId, message.slice(0, 80), now, now).run();
              await env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(id(), conversationId, "user", message, now).run();
              await env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(id(), conversationId, "assistant", answer, now).run();
              await env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId).run();
            }
            emit("done", { conversationId, model: streamed ? model : (env.GEMINI_CHAT_MODEL || "gemini-3.8-flash") });
          } catch (e) { emit("error", { error: e.message || "Ошибка генерации." }); }
          finally { controller.close(); }
        }
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-content-type-options": "nosniff" } });
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      if (!env.DB) return json([]);
      const rows = await env.DB.prepare(
        "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50"
      ).all();
      return json(rows.results || []);
    }

    if (url.pathname === "/api/conversation" && request.method === "GET") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const conversationId = url.searchParams.get("id");
      if (!conversationId) return json({ error: "Не указан id." }, 400);
      const rows = await env.DB.prepare(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
      ).bind(conversationId).all();
      return json(rows.results || []);
    }

    if (url.pathname.startsWith("/api/conversation/") && request.method === "PATCH") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const conversationId = decodeURIComponent(url.pathname.slice("/api/conversation/".length));
      const body = await request.json().catch(() => ({}));
      const title = String(body.title || "").trim().slice(0, 80);
      if (!title) return json({ error: "Название не может быть пустым." }, 400);
      const result = await env.DB.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?")
        .bind(title,new Date().toISOString(),conversationId).run();
      if (!result.meta?.changes) return json({ error: "Чат не найден." }, 404);
      return json({ ok:true, title });
    }

    if (url.pathname.startsWith("/api/conversation/") && request.method === "DELETE") {
      if (!env.DB) return json({ error: "D1 недоступна." }, 503);
      const conversationId = decodeURIComponent(url.pathname.slice("/api/conversation/".length));
      await env.DB.prepare("DELETE FROM messages WHERE conversation_id=?").bind(conversationId).run();
      await env.DB.prepare("DELETE FROM conversations WHERE id=?").bind(conversationId).run();
      return json({ ok:true });
    }

    return env.ASSETS.fetch(request);
  }
};