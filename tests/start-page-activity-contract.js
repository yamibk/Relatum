'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const html=read('assets/index.html'),usage=read('assets/usage-tracker.js'),start=read('assets/start.js');
assert(html.includes('data-usage-settings'));assert(html.includes('usage-tracker.js'));
assert(usage.includes("research: ['研究', 'Research']"));
assert(!start.includes('START_PAGE_ACTIVITY_ENABLED_KEY'));assert(!start.includes('START_PAGE_ACTIVITY_STATS_VISIBLE_KEY'));
assert(read('assets/study-activity.js').includes('payload.usageStats'));
require('./usage-tracker-regression.js');
