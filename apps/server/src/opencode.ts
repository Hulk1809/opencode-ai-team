import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

export async function connect() {
  const endpoint = await Service.discover();
  if (!endpoint) throw new Error('Không tìm thấy OpenCode V2 service. Mở Desktop hoặc chạy opencode serve --service.');
  const url = new URL(endpoint.url);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Chỉ chấp nhận OpenCode localhost');
  const client = OpenCode.make({baseUrl:endpoint.url,headers:Service.headers(endpoint)});
  const info = await client.server.info();
  if (!info.version.startsWith('2.')) throw new Error(`Cần OpenCode V2, nhận ${info.version}`);
  return {client,info};
}
export function modelRef(model: string) {
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length-1) throw new Error('Model phải có dạng provider/model');
  return {providerID:model.slice(0,slash),id:model.slice(slash+1)};
}
