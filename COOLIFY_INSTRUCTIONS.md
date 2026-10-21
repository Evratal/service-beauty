# Пошаговая инструкция для Этапа 5 (Coolify)

## 1) Репозиторий
- Репозиторий: https://github.com/Evratal/Service_1.git
- Ветка: main
- Корень проекта с Dockerfile

## 2) Создание Application в Coolify
В Coolify → Resources → New → Application → From Git Repository
- Source: GitHub
- Repository: Evratal/Service_1
- Branch: main
- Build Pack/Dockerfile: использовать Dockerfile из корня

## 3) Переменные окружения (Environment Variables)
Добавь следующие переменные:

| Key | Value |
|---|---|
| NODE_ENV | production |
| PORT | 3000 |
| DB_FILE | /app/data/app.db |
| YANDEX_CLIENT_ID | <client_id> |
| YANDEX_CLIENT_SECRET | <client_secret> |
| YANDEX_REDIRECT_URI | https://nogotochki.portfolio-evratal-1.ru/api/auth/yandex/callback |
| TRUST_PROXY | 1 |

> Три переменные `YANDEX_*` обязательны именно вместе: без `YANDEX_REDIRECT_URI`
> сервис считает вход через «Яндекс» выключенным и прячет кнопку.
> `SESSION_SECRET` и `PUBLIC_BASE_URL` в этом проекте не используются.

## 4) Постоянное хранилище (Persistent Storage)
Resources → Application → [твоя аппликация] → Storages → Add
- Name: nogotochki-data (произвольное)
- Mount Path: /app/data
- Type: Volume

БД будет храниться вне контейнера. При старте контейнер сам выполняет
`migrate → seed → start`: миграции применяются всегда, демо-данные
подсыпаются только если база пустая (повторный запуск seed ничего не ломает).

## 5) Домен и HTTPS
Application → Domains → Add
- Domain: nogotochki.portfolio-evratal-1.ru
- Generate SSL Certificate (Let's Encrypt) — включить
- Force HTTPS — включить

## 6) Деплой
Deploy → Build и запустить контейнер.

## 7) Проверка после деплоя
Проверить по ссылкам:
- https://nogotochki.portfolio-evratal-1.ru/ — страница содержит "Ноготочки"
- https://nogotochki.portfolio-evratal-1.ru/api/salon — {"name":"Ноготочки",...}
- Вход через Яндекс: кнопка ведёт на Яндекс, после согласия возвращает в кабинет
- Создать тестовую запись, сделать Redeploy — запись сохраняется (БД в volume)

## 8) Отчёт Этапа 5
Сформируй отчёт в docs/report-publication.md по шаблону Service_1 (Отчет о публикации сервиса.txt). 
Ключевые пункты: адрес https://nogotochki.portfolio-evratal-1.ru, HTTPS работает, http→https (302), ssl_verify ok, проверка редиректа и работоспособности, Yandex OAuth, данные сохраняются после redeploy.

