# SLAV AI Cloud

Облачный русскоязычный AI-чат на Cloudflare Workers + Gemini API.

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
