'use strict';
const { loadEnv } = require('./src/env');
const { createApp } = require('./src/app');

let env;
try {
    env = loadEnv();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

const { app, shutdown } = createApp(env);
const server = app.listen(env.port, () => console.log(`Addon active on port ${env.port}`));

// A stray rejected promise should be logged, not take the addon down
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        shutdown();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    });
}
