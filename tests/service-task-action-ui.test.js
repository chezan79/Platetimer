#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');

const department = fs.readFileSync(require.resolve('../public/department.html'), 'utf8');
const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');

assert.match(department, /OPS_TASK_SERVICE_OVERRIDE_RELEASED/);
assert.match(department, /OPS_TASK_SERVICE_INVALIDATED/);
assert.match(department, /OPS_TASK_SERVICE_EXPIRED/);
assert.match(department, /expiresAt > Date\.now\(\)/);
assert.match(department, /opsTasks\.delete\(data\.task && data\.task\.id\)/);
assert.match(department, /scheduleOpsTasksRefresh\(\)/);
assert.match(department, /idempotencyKey/);
assert.match(server, /serviceTaskActions\.acknowledge\(/);
assert.match(server, /migrateLegacyOpsAcknowledgements\(/);

console.log('Service task action UI/static checks passed');