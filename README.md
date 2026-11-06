# SLAV AI Cloud

Облачная русскоязычная AI-студия на Cloudflare Workers, OpenRouter и Gemini API.

Для GitHub-интеграции используйте fine-grained Personal Access Token с доступом к нужному репозиторию: **Contents: Read and write**, **Metadata: Read-only**, **Actions: Read-only**. Разрешение Actions необходимо для панели CI; без него GitHub может вернуть `Resource not accessible by integration`.

## Развёртывание через Cloudflare

1. Подключите этот GitHub-репозиторий в Workers & Pages.
2. Build command оставьте пустой.
3. Deploy command: `npx wrangler deploy`.
4. В настройках Worker → Variables and Secrets добавьте секрет `GEMINI_API_KEY`.
5. (Необязательно) Создайте D1 database и подключите её к Worker с binding name `DB`, затем выполните `schema.sql`.
6. При необходимости задайте переменную `GEMINI_MODEL`, по умолчанию используется `gemini-2.5-flash`.

## Проверка

Откройте `https://ВАШ-WORKER.workers.dev/health`. Поле `geminiConfigured` должно быть true после добавления ключа.

Секрет Gemini нельзя добавлять в GitHub или клиентский JavaScript.


## Защита API через Cloudflare Access

Worker умеет проверять JWT Cloudflare Access (RS256, подпись по JWKS, issuer, audience, exp/nbf). Чтобы включить обязательную защиту:

1. В Cloudflare Zero Trust создайте Access application типа Self-hosted для домена Worker (например, `slav-ai-cloud.slafka1996.workers.dev`) и задайте политику Allow только для своих email.
2. В Worker → Settings → Variables and Secrets добавьте:
   - `AUTH_REQUIRED` = `true` (обычная переменная).
   - `CF_ACCESS_TEAM_DOMAIN` = домен команды вида `https://<team>.cloudflareaccess.com`.
   - `CF_ACCESS_AUD` = Audience (AUD) Tag созданного Access-приложения.
3. Проверьте вход через браузер и запросы API. Без валидного Access JWT API вернёт 401; если обязательная защита включена, но параметры отсутствуют — 503.

Важно: до включения `AUTH_REQUIRED=true` API остаётся доступным без входа. Cloudflare Access ограничивает доступ к приложению, но само по себе ещё не реализует многопользовательское разделение данных в D1. Не открывайте приложение широкой аудитории и не храните в нём чужие секреты, пока не добавлена изоляция данных по пользователям. `/health` оставлен публичным и не выдаёт секреты.


## Изолированный Developer Sandbox

Developer Agent поддерживает подключение Cloudflare Sandbox Bridge. Когда оба секрета настроены, агент получает временный изолированный Linux-контейнер, загружает туда подключённый GitHub-репозиторий, может выполнять команды, редактировать файлы и запускать тесты. В конце контейнер удаляется. GitHub-токен внутрь контейнера не передаётся; изменения по-прежнему проходят через подготовку файлов и отдельное подтверждение публикации.

### Подключение

Sandbox доступен на Workers Paid plan. Для развёртывания Bridge требуется отдельный Cloudflare Worker, Docker и включённая функция Containers/Sandbox в аккаунте Cloudflare:

1. На машине с Node.js и Docker выполните: `npm create cloudflare@latest -- sandbox-bridge --template=cloudflare/sandbox-sdk/bridge/worker#v0`.
2. Перейдите в каталог `sandbox-bridge`, выполните `npx wrangler login` и разверните Bridge командой `npx wrangler deploy`.
3. Сохраните URL развёрнутого Bridge и сгенерируйте/задайте для него секрет `SANDBOX_API_KEY` согласно документации Cloudflare.
4. В настройках основного Worker SLAV AI добавьте секреты:
   - `SANDBOX_API_URL` — URL Bridge, например `https://<имя-bridge>.<аккаунт>.workers.dev` (без завершающего слеша).
   - `SANDBOX_API_KEY` — тот же ключ, что установлен в Bridge.
5. После публикации проверьте `/health`: поле `sandboxConfigured` должно быть `true`.

Если Sandbox не настроен, Developer Agent продолжает работать в прежнем режиме GitHub-инструментов чтения и подготовки изменений. Не добавляйте ключ Sandbox в GitHub, клиентский JavaScript или пользовательские сообщения. Временный Sandbox создаётся на каждый запуск и удаляется после завершения. Исходники загружаются в него архивом через GitHub API с серверной авторизацией; GitHub-токен остаётся в основном Worker и не передаётся в контейнер. Размер архива ограничен 32 МиБ на стороне Sandbox Bridge.

Документация: https://developers.cloudflare.com/sandbox/ и https://developers.cloudflare.com/sandbox/sdk/bridge/http-api/


## Telegram-бот SLAV AI

В Worker добавлен Telegram webhook с личной историей каждого пользователя.

### Настройка

1. Создайте бота через @BotFather и скопируйте токен.
2. В Cloudflare → Workers & Pages → `slav-ai-cloud` → Settings → Variables and Secrets добавьте секреты:
   - `TELEGRAM_BOT_TOKEN` — токен от BotFather.
   - `TELEGRAM_WEBHOOK_SECRET` — случайная строка 32–64 символа из латинских букв, цифр, `_` и `-`.
3. Убедитесь, что у Worker подключена D1 с binding `DB`, а также настроен хотя бы один AI-ключ: `OPENROUTER_API_KEY` или `GEMINI_API_KEY`.
4. После публикации установите webhook. Подставьте значения локально, не отправляйте токены в чат и не коммитьте их:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://slav-ai-cloud.slafka1996.workers.dev/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\"]"
```

5. Откройте бота в Telegram и отправьте `/start`.

Команды: `/new` — новый диалог, `/mode chat`, `/mode think`, `/mode code`, `/mode research`, `/help`.

Бот пока принимает текстовые сообщения в личном чате. История и режим хранятся раздельно по Telegram chat ID и user ID; групповые чаты и вложения пока не обрабатываются. Ограничение — 12 запросов в минуту на пользователя. Ответы длиннее лимита Telegram автоматически делятся на сообщения.

Webhook проверяет заголовок Telegram `X-Telegram-Bot-Api-Secret-Token`; токен бота и ключи моделей остаются только в Cloudflare Secrets. Само добавление кода в GitHub не разворачивает Worker и не устанавливает webhook автоматически.
