// Install as a type-59 Task Plugin channel in cqai-relay. The channel key is
// the server-only InferFlow platform key; the channel base URL includes /openapi/v1.
export const meta = {
  apiVersion: 1, key: 'ejianbao', name: 'e剪宝数字人', version: '1.0.0',
  author: {name: 'CQAI Club'}, models: ['ejianbao-digitalhuman'], fetchMode: 'per_task',
  description: {en: 'Account-authorized digital-human generation', zh: '产品账户授权的数字人口播生成'},
  usageSchema: {seconds: {type: 'number', unit: 'second', description: {en: 'Billable seconds, minimum ten', zh: '计费秒数，最低十秒'}}},
  usageExamples: [{label: '10s', facts: {seconds: 10}}],
};
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid identifier');
  return value;
}
function authorized(ctx) {
  const body = ctx.requestBody || {};
  if (typeof body.envelope !== 'string' || body.envelope.length > 40000 || typeof body.signature !== 'string'
    || utils.hmacSHA256(body.envelope, ctx.apiKey) !== body.signature) throw new Error('account authorization required');
  const input = JSON.parse(body.envelope);
  identifier(input.avatar_id); identifier(input.voice_id); identifier(input.request_id);
  if (typeof input.script_text !== 'string' || !input.script_text.trim() || input.script_text.length > 5000
    || !Number.isInteger(input.seconds) || input.seconds < 10 || input.seconds > 1800) throw new Error('invalid signed input');
  return input;
}
export function extractUsage(ctx) {
  const input = authorized(ctx);
  return ctx.usagePurpose === 'billing_ratios' ? null : {seconds: input.seconds};
}
export function buildSubmitRequest(ctx) {
  const input = authorized(ctx);
  return {url: ctx.baseUrl + '/skills/digital_human_standard/runs', method: 'POST',
    headers: {Authorization: 'Bearer ' + ctx.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': input.request_id},
    body: {inputs: {avatar_id: input.avatar_id, voice_id: input.voice_id, script_text: input.script_text, segmentation_mode: 'fast_segments'}}};
}
export function parseSubmitResponse(ctx, response) {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('digital-human service rejected submission');
  return {taskId: identifier((response.body || {}).run_id), taskData: response.body};
}
export function buildQueryRequest(ctx) {
  return {url: ctx.baseUrl + '/runs/' + identifier(ctx.taskId), method: 'GET', headers: {Authorization: 'Bearer ' + ctx.apiKey}};
}
export function parseTaskResult(ctx, body) {
  const status = body.status === 'completed' ? 'SUCCESS' : ['failed', 'cancelled'].includes(body.status) ? 'FAILURE' : 'IN_PROGRESS';
  if (status === 'SUCCESS') extractUsageOnComplete(null, {status}, body);
  return {status, progress: Math.max(0, Math.min(100, Number(body.progress_percent) || 0)) + '%',
    ...(status === 'FAILURE' ? {reason: 'Digital-human generation failed'} : {})};
}
export function extractUsageOnComplete(task, result, body) {
  if (result.status !== 'SUCCESS') return null;
  const output = (body.outputs || []).find(item => item.name === 'video');
  const seconds = Number(output && output.duration_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 1800) throw new Error('invalid output duration');
  return {seconds: Math.max(10, Math.ceil(seconds))};
}
export function listArtifacts(task) {return task.status === 'SUCCESS' ? [{key: 'video', type: 'video', mimeType: 'video/mp4'}] : [];}
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== 'video') throw new Error('unknown artifact');
  return {url: ctx.baseUrl + '/runs/' + identifier(ctx.upstreamTaskId) + '/outputs/video/download', method: 'GET', headers: {Authorization: 'Bearer ' + ctx.apiKey}};
}
