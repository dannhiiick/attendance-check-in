# Развёртывание на Render

1. Зайдите на https://render.com и войдите через GitHub.
2. Нажмите New > Web Service.
3. Подключите репозиторий `dannhiiick/attendance-check-in`.
4. Выберите настройки:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment variables:
     - `HOST=0.0.0.0`
     - `PORT=10000`
     - `DATA_DIR=/data`
     - `ADMIN_PIN=4829`
5. В настройках диска добавьте volume с mount path `/data`.
6. Нажмите Deploy.

После деплоя Render выдаст публичный URL вида:
`https://attendance-check-in.onrender.com`

Для панели преподавателя используйте PIN, который указан в переменной окружения `ADMIN_PIN`.
