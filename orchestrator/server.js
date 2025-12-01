const Orchestrator = require('./index');

// 建立並啟動 Orchestrator
const orchestrator = new Orchestrator();
orchestrator.start();

// 優雅關閉處理
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});