// PM2 Ecosystem File — manages both backend and socket server processes
// Location on server: /var/www/vtab/ecosystem.config.js

module.exports = {
  apps: [
    {
      name: "vtab-backend",
      cwd: "/var/www/vtab/backend",
      script: "/var/www/vtab/backend/venv/bin/gunicorn",
      args: "unified_server:app --bind 127.0.0.1:5000 --workers 2 --timeout 120 --access-logfile - --error-logfile -",
      interpreter: "none",
      env: {
        FLASK_ENV: "production",
        PORT: "5000",
        SOCKET_SERVER_URL: "https://officeportal.vtabsquare.com",
        FRONTEND_BASE_URL: "https://officeportal.vtabsquare.com",
        GOOGLE_REDIRECT_URI: "https://officeportal.vtabsquare.com/google/oauth2callback",
      },
      // Secrets (TENANT_ID, CLIENT_ID, etc.) are loaded from /var/www/vtab/backend/id.env by dotenv inside the app
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
    },
    {
      name: "vtab-socket",
      cwd: "/var/www/vtab/socket-server",
      script: "single_server.js",
      interpreter: "node",
      env: {
        PORT: "4001",
        NODE_ENV: "production",
        SOCKET_ORIGINS: "https://officeportal.vtabsquare.com",
        PY_API_BASE: "http://127.0.0.1:5000/chat",
        BACKEND_URL: "http://127.0.0.1:5000",
      },
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
    },
  ],
};
