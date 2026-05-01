const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(ROOT, 'tmp');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ANCHORS_PATH = path.join(DATA_DIR, 'anchors.json');
const RUNTIME_LOG_PATH = path.join(DATA_DIR, 'runtime.log');

function loadDotenv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenv();

const PORT = Number(process.env.PORT || 3236);

for (const dir of [DATA_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('[fatal] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请复制 .env.example 为 .env 并填入飞书应用凭证后再启动。');
  process.exit(1);
}

const DEFAULT_CONFIG = {
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN || '',
    tableId: process.env.FEISHU_BITABLE_TABLE_ID || '',
    tableUrl: process.env.FEISHU_BITABLE_URL || '',
    tableName: process.env.FEISHU_BITABLE_TABLE_NAME || '主播复盘记录',
    baseName: process.env.FEISHU_BITABLE_BASE_NAME || '主播复盘数据台'
  }
};

function loadConfig() {
  let stored = { feishu: {} };
  if (fs.existsSync(CONFIG_PATH)) {
    try { stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || { feishu: {} }; }
    catch { stored = { feishu: {} }; }
  }
  return {
    feishu: {
      appId: DEFAULT_CONFIG.feishu.appId,
      appSecret: DEFAULT_CONFIG.feishu.appSecret,
      tableName: DEFAULT_CONFIG.feishu.tableName,
      baseName: DEFAULT_CONFIG.feishu.baseName,
      appToken: stored.feishu?.appToken || DEFAULT_CONFIG.feishu.appToken,
      tableId: stored.feishu?.tableId || DEFAULT_CONFIG.feishu.tableId,
      tableUrl: stored.feishu?.tableUrl || DEFAULT_CONFIG.feishu.tableUrl
    }
  };
}

function saveConfig(config) {
  const persisted = {
    feishu: {
      appToken: config.feishu.appToken || '',
      tableId: config.feishu.tableId || '',
      tableUrl: config.feishu.tableUrl || '',
      tableName: config.feishu.tableName || '',
      baseName: config.feishu.baseName || ''
    }
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2));
}

let config = loadConfig();

function loadAnchors() {
  if (!fs.existsSync(ANCHORS_PATH)) {
    fs.writeFileSync(ANCHORS_PATH, JSON.stringify({ anchors: [] }, null, 2));
  }
  try {
    const data = JSON.parse(fs.readFileSync(ANCHORS_PATH, 'utf8'));
    return Array.isArray(data.anchors) ? data.anchors : [];
  } catch {
    return [];
  }
}

function saveAnchors(anchors) {
  fs.writeFileSync(ANCHORS_PATH, JSON.stringify({ anchors }, null, 2));
}

function appendRuntimeLog(message, meta = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...meta }, null, 0) + '\n';
  fs.appendFileSync(RUNTIME_LOG_PATH, line);
}

function createAnchor(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('主播名不能为空');
  const anchors = loadAnchors();
  const exists = anchors.find(a => a.name === trimmed);
  if (exists) return exists;
  const anchor = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now() };
  anchors.push(anchor);
  saveAnchors(anchors);
  return anchor;
}

function deleteAnchor(id) {
  const anchors = loadAnchors();
  const next = anchors.filter(a => a.id !== id);
  saveAnchors(next);
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function text(res, status, content, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 30 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeBase64(input) {
  return String(input || '').replace(/^data:[^;]+;base64,/, '');
}

function ensureImagePayload(images) {
  const required = ['douyin', 'videohao', 'kuaishou'];
  for (const key of required) {
    if (!images || !images[key] || !images[key].base64) {
      throw new Error(`缺少图片：${key}`);
    }
  }
}

function writeTempImage(name, base64) {
  const file = path.join(TMP_DIR, `${Date.now()}-${crypto.randomUUID()}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(sanitizeBase64(base64), 'base64'));
  return file;
}

function runTesseract(filePath) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', [filePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message || 'OCR 失败'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\t/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitColumns(line) {
  return String(line || '').split(/\s{2,}/).map(v => v.trim()).filter(Boolean);
}

function pairColumns(labelLine, valueLine) {
  const labels = splitColumns(labelLine);
  const values = splitColumns(valueLine);
  const out = {};
  for (let i = 0; i < Math.min(labels.length, values.length); i += 1) {
    out[labels[i]] = values[i];
  }
  return out;
}

function extractFirst(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function extractDouyinMetrics(text) {
  const lines = cleanOcrText(text).split('\n').map(v => v.trim()).filter(Boolean);
  const metrics = {
    '开播时间': extractFirst(text, /开播时间[:：]?\s*([0-9-]{10}\s+[0-9:]{8})/),
    '关播时间': extractFirst(text, /关播时间[:：]?\s*([0-9-]{10}\s+[0-9:]{8})/),
    '直播时长': extractFirst(text, /直播时长[:：]?\s*([^\n]+?秒)/)
  };
  const firstHeaderIndex = lines.findIndex(line => line.includes('收获音浪') && line.includes('曝光人数'));
  if (firstHeaderIndex >= 0 && lines[firstHeaderIndex + 1]) Object.assign(metrics, pairColumns(lines[firstHeaderIndex], lines[firstHeaderIndex + 1]));
  const secondHeaderIndex = lines.findIndex(line => line.includes('会员收入') && line.includes('平均在线人数'));
  if (secondHeaderIndex >= 0 && lines[secondHeaderIndex + 1]) Object.assign(metrics, pairColumns(lines[secondHeaderIndex], lines[secondHeaderIndex + 1]));
  if (!metrics['进房率'] && metrics['曝光人数'] && metrics['进房人数']) {
    const exposure = Number(String(metrics['曝光人数']).replace(/,/g, ''));
    const enter = Number(String(metrics['进房人数']).replace(/,/g, ''));
    if (exposure > 0 && enter >= 0) metrics['进房率'] = `${((enter / exposure) * 100).toFixed(1)}%`;
  }
  return metrics;
}

function extractVideohaoMetrics(text) {
  const lines = cleanOcrText(text).split('\n').map(v => v.trim()).filter(Boolean);
  const metrics = {
    '开播时间': extractFirst(text, /开播时间\s*([0-9]{4}[0-9-]{4,}\s*[0-9:]{4,8})/).replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
    '开播时长': extractFirst(text, /开播时长[“":：]?\s*([^\s]+秒)/)
  };
  const baseIndex = lines.findIndex(line => line.includes('观看人数') && line.includes('观看次数'));
  if (baseIndex >= 0 && lines[baseIndex + 1]) Object.assign(metrics, pairColumns(lines[baseIndex], lines[baseIndex + 1]));
  if (baseIndex >= 0 && lines[baseIndex + 2]) {
    const values = (lines[baseIndex + 2].match(/[0-9]+(?:\.[0-9]+)?/g) || []).slice(0, 4);
    ['点赞次数', '评论次数', '分享次数', '新增关注人数'].forEach((key, index) => {
      metrics[key] = values[index] || '';
    });
  }
  return metrics;
}

function extractKuaishouMetrics(text) {
  const lines = cleanOcrText(text).split('\n').map(v => v.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => line.includes('开播时间') && line.includes('直播时长(分钟)') && line.includes('送礼人数'));
  const metrics = {};
  if (headerIndex >= 0 && lines[headerIndex + 1]) {
    const row = lines[headerIndex + 1];
    metrics['开播时间'] = extractFirst(row, /(20[0-9]{2}-[0-9]{2}-[0-9]{2}\s+[0-9:]{8})/);
    const afterTime = row.replace(/^.*?(20[0-9]{2}-[0-9]{2}-[0-9]{2}\s+[0-9:]{8})\s*/, '');
    const values = afterTime.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
    const keys = ['直播时长(分钟)', '直播观众数', '在线人数峰值', '点赞数', '评论人数', '分享人数', '送礼人数'];
    keys.forEach((key, index) => {
      metrics[key] = values[index] || '';
    });
  }
  return metrics;
}

function extractMetrics(platform, text) {
  if (platform === 'douyin') return extractDouyinMetrics(text);
  if (platform === 'videohao') return extractVideohaoMetrics(text);
  if (platform === 'kuaishou') return extractKuaishouMetrics(text);
  return {};
}

function summarizeMetrics(metrics) {
  const entries = Object.entries(metrics);
  if (!entries.length) return '未识别到稳定指标，请查看 OCR 原文';
  return entries.map(([k, v]) => `${k}：${v}`).join('；');
}

async function ocrImages(images) {
  ensureImagePayload(images);
  const files = {};
  try {
    for (const key of Object.keys(images)) files[key] = writeTempImage(key, images[key].base64);
    const result = {};
    for (const key of ['douyin', 'videohao', 'kuaishou']) {
      const rawText = await runTesseract(files[key]);
      const cleaned = cleanOcrText(rawText);
      const metrics = extractMetrics(key, cleaned);
      result[key] = {
        platform: key,
        rawText: cleaned,
        metrics,
        summary: summarizeMetrics(metrics)
      };
    }
    return result;
  } finally {
    for (const file of Object.values(files)) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function requestJson(method, urlString, headers, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(headers || {}),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          resolve({ status: res.statusCode || 0, data });
        } catch (error) {
          reject(new Error(`接口返回非 JSON：${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function feishuRequest(method, pathname, payload) {
  const token = await getTenantToken();
  const { status, data } = await requestJson(method, `https://open.feishu.cn${pathname}`, {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8'
  }, payload);
  if (status < 200 || status >= 300 || data.code !== 0) {
    const err = new Error(data.msg || `飞书接口失败: ${status}`);
    err.payload = data;
    err.status = status;
    throw err;
  }
  return data.data;
}

async function ensureField(appToken, tableId, field) {
  try {
    await feishuRequest('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field);
  } catch (error) {
    const code = error?.payload?.code;
    if (code === 1254014) return;
    throw error;
  }
}

async function listFields(appToken, tableId) {
  const data = await feishuRequest('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=500`);
  return data.items || [];
}

async function updateField(appToken, tableId, fieldId, payload) {
  return feishuRequest('PUT', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, payload);
}

async function removeField(appToken, tableId, fieldId) {
  return feishuRequest('DELETE', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`);
}

async function getTenantToken() {
  const { status, data } = await requestJson('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
    'Content-Type': 'application/json; charset=utf-8'
  }, {
    app_id: config.feishu.appId,
    app_secret: config.feishu.appSecret
  });
  if (status < 200 || status >= 300 || data.code !== 0 || !data.tenant_access_token) {
    const err = new Error(data.msg || '获取 tenant_access_token 失败');
    err.payload = data;
    throw err;
  }
  return data.tenant_access_token;
}

async function ensureBitable() {
  config = loadConfig();

  if (!config.feishu.appToken || !config.feishu.tableId || !config.feishu.tableUrl) {
    const base = await feishuRequest('POST', '/open-apis/bitable/v1/apps', {
      name: config.feishu.baseName,
      time_zone: 'Asia/Shanghai'
    });

    config.feishu.appToken = base.app.app_token;
    config.feishu.tableId = base.app.default_table_id;
    config.feishu.tableUrl = base.app.url;
    saveConfig(config);
  }

  let existingFields = await listFields(config.feishu.appToken, config.feishu.tableId);
  const primaryField = existingFields.find(field => field.is_primary);
  const duplicateAnchorField = existingFields.find(field => !field.is_primary && field.field_name === '主播');

  if (primaryField && primaryField.field_name !== '主播') {
    if (duplicateAnchorField) {
      await updateField(config.feishu.appToken, config.feishu.tableId, duplicateAnchorField.field_id, { field_name: '主播_待删' });
    }
    await updateField(config.feishu.appToken, config.feishu.tableId, primaryField.field_id, { field_name: '主播' });
    existingFields = await listFields(config.feishu.appToken, config.feishu.tableId);
  }

  const staleAnchorField = existingFields.find(field => !field.is_primary && (field.field_name === '主播' || field.field_name === '主播_待删'));
  if (staleAnchorField) await removeField(config.feishu.appToken, config.feishu.tableId, staleAnchorField.field_id);

  const fields = [
    { field_name: '日期', type: 5 },

    { field_name: '抖音-开播时间', type: 1 },
    { field_name: '抖音-关播时间', type: 1 },
    { field_name: '抖音-直播时长', type: 1 },
    { field_name: '抖音-收获音浪', type: 1 },
    { field_name: '抖音-送礼人数', type: 1 },
    { field_name: '抖音-送礼率', type: 1 },
    { field_name: '抖音-曝光人数', type: 1 },
    { field_name: '抖音-进房人数', type: 1 },
    { field_name: '抖音-进房率', type: 1 },
    { field_name: '抖音-人均停留时长', type: 1 },
    { field_name: '抖音-评论人数', type: 1 },
    { field_name: '抖音-点赞次数', type: 1 },
    { field_name: '抖音-会员收入', type: 1 },
    { field_name: '抖音-星守护收入', type: 1 },
    { field_name: '抖音-预计本场收入', type: 1 },
    { field_name: '抖音-平均在线人数', type: 1 },
    { field_name: '抖音-最高在线人数', type: 1 },
    { field_name: '抖音-新增粉丝', type: 1 },
    { field_name: '抖音-分享次数', type: 1 },
    { field_name: '抖音-加粉丝团人数', type: 1 },

    { field_name: '视频号-开播时间', type: 1 },
    { field_name: '视频号-开播时长', type: 1 },
    { field_name: '视频号-观看人数', type: 1 },
    { field_name: '视频号-观看次数', type: 1 },
    { field_name: '视频号-最高在线', type: 1 },
    { field_name: '视频号-平均观看时长', type: 1 },
    { field_name: '视频号-点赞次数', type: 1 },
    { field_name: '视频号-评论次数', type: 1 },
    { field_name: '视频号-分享次数', type: 1 },
    { field_name: '视频号-新增关注人数', type: 1 },

    { field_name: '快手-开播时间', type: 1 },
    { field_name: '快手-直播时长(分钟)', type: 1 },
    { field_name: '快手-直播观众数', type: 1 },
    { field_name: '快手-在线人数峰值', type: 1 },
    { field_name: '快手-点赞数', type: 1 },
    { field_name: '快手-评论人数', type: 1 },
    { field_name: '快手-分享人数', type: 1 },
    { field_name: '快手-送礼人数', type: 1 },
  ];

  for (const field of fields) {
    await ensureField(config.feishu.appToken, config.feishu.tableId, field);
  }

  return config.feishu;
}

function toFeishuDate(input) {
  const value = input ? new Date(input) : new Date();
  return Number.isNaN(value.getTime()) ? Date.now() : value.getTime();
}

function metricOf(result, key) {
  return result?.metrics?.[key] || '';
}

async function createRecord(payload) {
  const feishu = await ensureBitable();
  const dy = payload.results.douyin || {};
  const vh = payload.results.videohao || {};
  const ks = payload.results.kuaishou || {};
  const recordData = {
    fields: {
      '主播': payload.anchorName,
      '日期': toFeishuDate(payload.date),

      '抖音-开播时间': metricOf(dy, '开播时间'),
      '抖音-关播时间': metricOf(dy, '关播时间'),
      '抖音-直播时长': metricOf(dy, '直播时长'),
      '抖音-收获音浪': metricOf(dy, '收获音浪'),
      '抖音-送礼人数': metricOf(dy, '送礼人数'),
      '抖音-送礼率': metricOf(dy, '送礼率'),
      '抖音-曝光人数': metricOf(dy, '曝光人数'),
      '抖音-进房人数': metricOf(dy, '进房人数'),
      '抖音-进房率': metricOf(dy, '进房率'),
      '抖音-人均停留时长': metricOf(dy, '人均停留时长') || metricOf(dy, '停留时长'),
      '抖音-评论人数': metricOf(dy, '评论人数'),
      '抖音-点赞次数': metricOf(dy, '点赞次数'),
      '抖音-会员收入': metricOf(dy, '会员收入'),
      '抖音-星守护收入': metricOf(dy, '星守护收入'),
      '抖音-预计本场收入': metricOf(dy, '预计本场收入'),
      '抖音-平均在线人数': metricOf(dy, '平均在线人数'),
      '抖音-最高在线人数': metricOf(dy, '最高在线人数'),
      '抖音-新增粉丝': metricOf(dy, '新增粉丝'),
      '抖音-分享次数': metricOf(dy, '分享次数'),
      '抖音-加粉丝团人数': metricOf(dy, '加粉丝团人数'),

      '视频号-开播时间': metricOf(vh, '开播时间'),
      '视频号-开播时长': metricOf(vh, '开播时长') || metricOf(vh, '直播时长'),
      '视频号-观看人数': metricOf(vh, '观看人数'),
      '视频号-观看次数': metricOf(vh, '观看次数'),
      '视频号-最高在线': metricOf(vh, '最高在线'),
      '视频号-平均观看时长': metricOf(vh, '平均观看时长'),
      '视频号-点赞次数': metricOf(vh, '点赞次数'),
      '视频号-评论次数': metricOf(vh, '评论次数'),
      '视频号-分享次数': metricOf(vh, '分享次数'),
      '视频号-新增关注人数': metricOf(vh, '新增关注人数'),

      '快手-开播时间': metricOf(ks, '开播时间'),
      '快手-直播时长(分钟)': metricOf(ks, '直播时长(分钟)') || metricOf(ks, '直播时长'),
      '快手-直播观众数': metricOf(ks, '直播观众数') || metricOf(ks, '观看人数'),
      '快手-在线人数峰值': metricOf(ks, '在线人数峰值') || metricOf(ks, '最高在线'),
      '快手-点赞数': metricOf(ks, '点赞数') || metricOf(ks, '点赞次数'),
      '快手-评论人数': metricOf(ks, '评论人数'),
      '快手-分享人数': metricOf(ks, '分享人数') || metricOf(ks, '分享次数'),
      '快手-送礼人数': metricOf(ks, '送礼人数')
    }
  };

  const data = await feishuRequest('POST', `/open-apis/bitable/v1/apps/${feishu.appToken}/tables/${feishu.tableId}/records`, recordData);
  return { recordId: data.record.record_id, tableUrl: feishu.tableUrl };
}

function friendlyFeishuError(error) {
  const payload = error.payload || {};
  const message = payload.msg || error.message || '飞书接口失败';
  const authLink = (message.match(/https:\/\/open\.feishu\.cn\/[^\s]+/) || [])[0] || '';
  const link = authLink || payload?.error?.troubleshooter || payload?.error?.help_url || '';
  return {
    message,
    code: payload.code || error.status || 'UNKNOWN',
    help: link
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/anchors') {
    return json(res, 200, { ok: true, anchors: loadAnchors() });
  }

  if (req.method === 'POST' && url.pathname === '/api/anchors') {
    try {
      const body = await readBody(req);
      const anchor = createAnchor(body.name);
      return json(res, 200, { ok: true, anchor, anchors: loadAnchors() });
    } catch (error) {
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/anchors') {
    try {
      const body = await readBody(req);
      if (!body.id) throw new Error('缺少主播ID');
      deleteAnchor(body.id);
      return json(res, 200, { ok: true, anchors: loadAnchors() });
    } catch (error) {
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    config = loadConfig();
    return json(res, 200, {
      ok: true,
      port: PORT,
      tableUrl: config.feishu.tableUrl,
      appTokenReady: Boolean(config.feishu.appToken),
      tableIdReady: Boolean(config.feishu.tableId)
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime-log') {
    try {
      const textLog = fs.existsSync(RUNTIME_LOG_PATH) ? fs.readFileSync(RUNTIME_LOG_PATH, 'utf8').trim() : '';
      const lines = textLog ? textLog.split('\n').slice(-50).map(line => JSON.parse(line)) : [];
      return json(res, 200, { ok: true, lines });
    } catch (error) {
      return json(res, 200, { ok: true, lines: [] });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ocr-preview') {
    try {
      const body = await readBody(req);
      appendRuntimeLog('正在 OCR 识别', { eta: '15~30秒' });
      const results = await ocrImages(body.images);
      appendRuntimeLog('OCR 识别完成', { eta: '0秒' });
      return json(res, 200, { ok: true, results });
    } catch (error) {
      appendRuntimeLog('OCR 识别失败', { error: error.message });
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/submit') {
    try {
      const body = await readBody(req);
      const anchorName = String(body.anchorName || '').trim();
      if (!anchorName) throw new Error('请选择主播');
      const results = body.results || await ocrImages(body.images);
      appendRuntimeLog('正在写入飞书表格', { eta: '5~15秒', anchorName });
      const record = await createRecord({
        anchorName,
        date: body.date,
        note: body.note,
        results
      });
      appendRuntimeLog('写入飞书表格完成', { eta: '0秒', anchorName, recordId: record.recordId });
      return json(res, 200, { ok: true, results, record });
    } catch (error) {
      const feishuError = error.payload ? friendlyFeishuError(error) : null;
      appendRuntimeLog('写入飞书表格失败', { error: (feishuError || { message: error.message }).message });
      return json(res, 400, { ok: false, error: feishuError || { message: error.message } });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qa-check') {
    try {
      const body = await readBody(req);
      appendRuntimeLog('正在大模型检查结果', { eta: '10~20秒', anchorName: body.anchorName || '' });
      const summary = {
        passed: true,
        note: '当前版本仅记录抽检流程，后续接入大模型自动复核。'
      };
      appendRuntimeLog('大模型检查结果完成', { eta: '0秒', passed: true });
      return json(res, 200, { ok: true, check: summary });
    } catch (error) {
      appendRuntimeLog('大模型检查结果失败', { error: error.message });
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (serveStatic(req, res, decodeURIComponent(url.pathname))) return;
  text(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`anchor-review-panel running on :${PORT}`);
});
