import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractWorkflowRecord, opaqueWorkflowRecord } from '../usage-extension/workflow/extract.ts';
import { buildWorkflowSnapshot, workflowInsights } from '../usage-extension/workflow/analyze.ts';
import { buildUsageRollup } from '../usage-extension/native.ts';
import { emptyUsageData } from '../usage-extension/data.ts';
const sha = t => createHash('sha256').update(t).digest('hex');
const at = new Date(2026, 0, 2, 12).getTime();
const capture = records => ({version:1,records,omittedRecords:0});
const input = (sessionId,records) => ({sessionId,capture:capture(records)});
const assistant = (id,line,extra={}) => ({id,line,at,kind:'assistant',...extra});

test('standard output footer, optional session suffix and task counter preserve exact delivered bytes',()=>{
  const report='Report ✓\nComplete findings.\n';
  for(const counter of ['', ' (2/3)']) for(const suffix of ['', '\n\nSession file: /private/anon/session.jsonl', '\n\nSession: /private/anon/session.jsonl']) {
    const content=`Background task completed: **fixer**${counter}\n\nfixer:\n${report}\n\nOutput saved to: /private/anon/report.md (2.0 KB, 2 lines). Read this file if needed.${suffix}`;
    const r=extractWorkflowRecord({type:'custom_message',id:'notice',customType:'subagent-notify',content},4);
    assert.equal(r.deliveryHash,sha(report));assert.equal(r.deliveryBytes,Buffer.byteLength(report));
  }
  const truncated=extractWorkflowRecord({type:'custom_message',id:'notice',customType:'subagent-notify',content:`Background task completed: **fixer**\n\nfixer:\n[preview truncated]\n\nOutput saved to: /private/anon/report.md (2.0 KB, 2 lines). Read this file if needed.`},4);
  assert.equal(truncated.deliveryHash,undefined);
});

test('trimmed runtime display retains a literal source slice matching the artifact final newline',()=>{
  const artifact='Report line 1\nReport line 2\n';
  const content=`Background task completed: **fixer**\n\nfixer:\n${artifact.trimEnd()}\n\nOutput saved to: /private/anon/report.md (28 B, 2 lines). Read this file if needed.\n\nRetention-managed async directory: /private/anon/run\n\nSession file: /private/anon/session.jsonl`;
  const notice=extractWorkflowRecord({type:'custom_message',id:'n',customType:'subagent-notify',timestamp:at,content},4);
  const result=extractWorkflowRecord({type:'message',id:'r',timestamp:at,message:{role:'toolResult',toolCallId:'read-id',content:artifact}},6);
  const wf=buildWorkflowSnapshot([input('one',[notice,result])]);
  assert.equal(wf.days[0].metrics.duplicateDeliveries,1);
  assert.equal(wf.days[0].metrics.duplicateBytes,Buffer.byteLength(artifact));
});

test('period citations are newest-first in terminal analysis',()=>{
  const wf=buildWorkflowSnapshot([input('one',[assistant('old',1,{stop:'error'}),assistant('new',2,{at:at+86400000,stop:'error'})])]);
  // Bursts are not needed for this assertion: use an evidence-bearing family.
  wf.days[0].evidence=[{kind:'telemetry',session:'old',line:1}];
  wf.days[1].evidence=[{kind:'telemetry',session:'new',line:2}];
  assert.equal(workflowInsights(wf).find(x=>x.kind==='telemetry').evidence[0].session,'new');
});

test('branch summaries invalidate a pure compaction pair',()=>{
  const summary=extractWorkflowRecord({type:'branch_summary',id:'summary',parentId:'before',timestamp:at,summary:'body not retained'},2);
  assert.equal(summary.kind,'context-edit');
  const usage={input:100,cacheRead:20,cacheWrite:0,output:1};
  const wf=buildWorkflowSnapshot([input('one',[assistant('before',1,{usage}),summary,{id:'compact',parentId:'summary',line:3,at,kind:'compaction'},assistant('after',4,{parentId:'compact',usage})])]);
  assert.equal(wf.days[0].metrics.compactionPairs,0);
});

test('copied opaque IDs dedupe but undated synthetic opaque lines stay independent',()=>{
  const real={id:'opaque-id',line:3,kind:'opaque',at};
  const wf=buildWorkflowSnapshot([input('one',[real,opaqueWorkflowRecord(7)]),input('two',[real,opaqueWorkflowRecord(7)])]);
  assert.equal(wf.coverage.opaqueRecords,3);
});

test('unmeasured startup is explicitly unavailable, not an omitted healthy lens',()=>{
  const wf=buildWorkflowSnapshot([input('ordinary',[{id:'task',kind:'user',line:1,at,textBytes:25},assistant('response',2)])]);
  const card=workflowInsights(wf).find(x=>x.kind==='startup');
  assert.ok(card);
  assert.match(card.detail,/1.*unavailable/i);
});

test('native day horizon includes workflow-only days before accounting',()=>{
  const now=new Date(2026,0,3,12);
  const data=emptyUsageData({todayMs:now.getTime(),weekStartMs:0,lastWeekStartMs:0,last30DaysStartMs:0,nowMs:now.getTime()});
  data.workflow={version:1,days:[{day:'2026-01-01',metrics:{providerErrors:1},evidence:[]}],roles:[],coverage:{filesWithRecords:1,filesWithoutRecords:0,omittedRecords:0,opaqueRecords:0}};
  assert.equal(buildUsageRollup(data,{now}).rollup.days[0],'2026-01-01');
});
