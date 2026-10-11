'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
assert(read('assets/editor.html').includes('usage-tracker.js'));
assert(read('assets/editor.js').includes("RelatumUsage?.setTarget"));
assert(!read('assets/editor.js').includes("fetch('/api/canvas-activity'"));
assert(!read('app.py').includes('CANVAS_ACTIVITY_FILE'));
require('./usage-tracker-regression.js');
