import { t as tr } from './i18n.js';

export function modelSetupReply() {
  return tr('你好！还差一步就能开始对话：请先连接模型并填写可用的 API Key。点击下方“设置 API Key”，保存后回来继续，我会使用你选择的模型回答。');
}

export function isModelSetupError(error) {
  return /HTTP\s*(?:401|402)\b|invalid.*(?:api[\s_-]*key|key)|(?:api[\s_-]*key|key).*invalid|authentication|unauthor|API Key.*(?:无效|未配置|失效)|(?:未配置|无效).*API Key/i.test(String(error?.message || ''));
}
