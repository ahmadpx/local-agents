module.exports = {
  apps: [
    {
      name: "agents-scheduler",
      script: "agents/scheduler/dist/cli.js",
      args: "start",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      // Logs
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/scheduler-error.log",
      out_file: "./logs/scheduler-out.log",
      merge_logs: true,
      // Auto-restart when agent configs are rebuilt
      watch: ["agents/*/dist/agent.config.js"],
      watch_delay: 2000,
      ignore_watch: ["node_modules", "logs"],
    },
  ],
};
